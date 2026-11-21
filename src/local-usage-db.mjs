import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HOUR_MS } from './leaderboard-stats.mjs';
import { requestTokens } from './usage-summary.mjs';

export const USAGE_RETENTION_MS = 720 * HOUR_MS;
const PANELS = new Set(['current-data', 'usage', 'leaderboard']);

const metrics = [
  ['freshInputTokens', 'input_tokens'], ['outputTokens', 'output_tokens'],
  ['cacheReadTokens', 'cache_read_tokens'], ['cacheCreationTokens', 'cache_write_tokens'],
  ['tokensPerSecond', 'tokens_per_second'], ['durationMs', 'duration_ms'],
  ['firstTokenMs', 'first_token_ms'], ['generationMs', 'generation_ms'], ['cacheHitRate', 'cache_hit_rate']
];
const string = (value, max = 256) => typeof value === 'string' ? value.slice(0, max) : null;

function sanitize(record) {
  if (typeof record?.id !== 'string' || !record.id || !Number.isSafeInteger(Math.trunc(record.completedAt)) ||
      typeof record.provider !== 'string') return null;
  const result = {
    id: record.id, completedAt: Math.trunc(record.completedAt), provider: string(record.provider, 32),
    model: string(record.model, 128), username: string(record.username, 39), workspaceKey: string(record.workspaceKey),
    dataSource: string(record.dataSource, 32), isEstimatedSpeed: record.isEstimatedSpeed === true,
    isSubagent: record.isSubagent === true
  };
  for (const [key] of metrics) result[key] = Number.isFinite(record[key]) && record[key] >= 0 ? record[key] : null;
  result.tokens = requestTokens(result);
  return result;
}

const recordFields = [
  ['id', 'record_id'], ['completedAt', 'completed_at'], ['username', 'username'], ['provider', 'harness'],
  ['model', 'model'], ['tokens', 'tokens'], ['workspaceKey', 'workspace_key'], ['dataSource', 'data_source'],
  ['isEstimatedSpeed', 'estimated'], ['isSubagent', 'subagent'], ...metrics
];
const recordColumns = recordFields.map(([, column]) => column);
const recordSelect = recordFields.map(([key, column]) => `${column} AS ${key}`).join(', ');
const fingerprint = record => JSON.stringify(recordFields.map(([key]) => record[key]));
const encode = value => JSON.stringify(value);
const decode = value => value == null ? undefined : JSON.parse(value);

export function openLocalUsageDb(filename) {
  if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename, { enableExtensionLoading: false });
  try {
    db.exec('PRAGMA busy_timeout=3000; PRAGMA trusted_schema=OFF;');
    const { user_version: version } = db.prepare('PRAGMA user_version').get();
    if (version > 1) throw new Error('unsupported local usage database version');
    db.exec(`
      PRAGMA journal_mode=WAL;
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS usage_records (
        device_guid TEXT NOT NULL, record_id TEXT NOT NULL, completed_at INTEGER NOT NULL, username TEXT,
        harness TEXT NOT NULL, model TEXT, tokens INTEGER NOT NULL, workspace_key TEXT, data_source TEXT,
        estimated INTEGER NOT NULL, subagent INTEGER NOT NULL, input_tokens INTEGER, output_tokens INTEGER,
        cache_read_tokens INTEGER, cache_write_tokens INTEGER, tokens_per_second REAL, duration_ms REAL,
        first_token_ms REAL, generation_ms REAL, cache_hit_rate REAL, log_unit_key TEXT NOT NULL,
        log_stamp TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(device_guid, record_id)
      );
      CREATE INDEX IF NOT EXISTS usage_records_time ON usage_records(completed_at);
      CREATE INDEX IF NOT EXISTS usage_records_source_time ON usage_records(device_guid, completed_at);
      CREATE INDEX IF NOT EXISTS usage_records_log ON usage_records(device_guid, log_unit_key);
      CREATE TABLE IF NOT EXISTS panel_cache (
        panel TEXT PRIMARY KEY, current_scope TEXT NOT NULL, current_snapshot TEXT NOT NULL, current_at INTEGER NOT NULL,
        previous_scope TEXT, previous_snapshot TEXT, previous_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS upload_queue (
        origin TEXT NOT NULL, account_id TEXT NOT NULL, device_guid TEXT NOT NULL, request_id TEXT NOT NULL,
        state TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(origin, account_id, device_guid, request_id)
      );
      CREATE INDEX IF NOT EXISTS upload_queue_scope ON upload_queue(origin, account_id, state, updated_at);
      PRAGMA user_version=1;
      COMMIT;
    `);
  } catch (error) {
    db.close();
    throw error;
  }

  function atomic(write) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = write();
      db.exec('COMMIT');
      return value;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  const selectLog = db.prepare(`SELECT ${recordSelect} FROM usage_records WHERE device_guid=? AND log_unit_key=?`);
  const readLogStamp = db.prepare('SELECT log_unit_key, log_stamp FROM usage_records WHERE device_guid=? GROUP BY log_unit_key');
  const deleteRecord = db.prepare('DELETE FROM usage_records WHERE device_guid=? AND record_id=?');
  const expiredRecords = db.prepare('DELETE FROM usage_records WHERE completed_at<?');
  const listSources = db.prepare('SELECT DISTINCT device_guid AS deviceGuid FROM usage_records');
  const columns = ['device_guid', 'log_unit_key', 'log_stamp', 'updated_at', ...recordColumns];
  const upsertRecord = db.prepare(`INSERT INTO usage_records(${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})
    ON CONFLICT(device_guid, record_id) DO UPDATE SET ${columns.slice(2).map(column => `${column}=excluded.${column}`).join(', ')}`);
  const updateStamp = db.prepare('UPDATE usage_records SET log_stamp=?, updated_at=? WHERE device_guid=? AND log_unit_key=? AND log_stamp<>?');
  const selectPanel = db.prepare('SELECT * FROM panel_cache WHERE panel=?');
  const upsertPanel = db.prepare(`INSERT INTO panel_cache(panel, current_scope, current_snapshot, current_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(panel) DO UPDATE SET previous_scope=current_scope, previous_snapshot=current_snapshot, previous_at=current_at,
    current_scope=excluded.current_scope, current_snapshot=excluded.current_snapshot, current_at=excluded.current_at
    WHERE excluded.current_at>=current_at AND (excluded.current_scope<>current_scope OR excluded.current_snapshot<>current_snapshot)`);
  const getState = db.prepare('SELECT value FROM upload_queue WHERE origin=? AND account_id=? AND device_guid=? AND request_id=?');
  const putState = db.prepare(`INSERT INTO upload_queue VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(origin, account_id, device_guid, request_id) DO UPDATE SET
    state=excluded.state, value=excluded.value, updated_at=excluded.updated_at`);
  const removeState = db.prepare('DELETE FROM upload_queue WHERE origin=? AND account_id=? AND device_guid=? AND request_id=?');
  const nextPacket = db.prepare(`SELECT device_guid AS deviceGuid, request_id AS requestId, value FROM upload_queue
    WHERE origin=? AND account_id=? AND state=? ORDER BY updated_at, request_id LIMIT 1`);
  const pruneQueue = db.prepare('DELETE FROM upload_queue WHERE updated_at<?');

  function shape(row) {
    return { ...row, isEstimatedSpeed: row.isEstimatedSpeed !== 0, isSubagent: row.isSubagent !== 0 };
  }

  function replaceLog({ deviceGuid, logUnitKey, logStamp, records, complete, now }) {
    if (!complete) return [];
    return atomic(() => {
      const old = new Map(selectLog.all(deviceGuid, logUnitKey).map(raw => {
        const row = shape(raw);
        return [row.id, row];
      }));
      const incoming = new Map();
      for (const row of records) {
        const record = sanitize(row);
        if (record && record.completedAt >= now - USAGE_RETENTION_MS && record.completedAt <= now) incoming.set(record.id, record);
      }
      const affected = new Set();
      for (const [id, previous] of old) {
        if (incoming.has(id)) continue;
        deleteRecord.run(deviceGuid, id);
        affected.add(previous.completedAt);
      }
      for (const [id, record] of incoming) {
        const previous = old.get(id);
        if (previous?.username) record.username = previous.username;
        if (previous && fingerprint(previous) === fingerprint(record)) continue;
        upsertRecord.run(deviceGuid, logUnitKey, logStamp, now,
          ...recordFields.map(([key]) => typeof record[key] === 'boolean' ? Number(record[key]) : record[key]));
        if (previous) affected.add(previous.completedAt);
        affected.add(record.completedAt);
      }
      updateStamp.run(logStamp, now, deviceGuid, logUnitKey, logStamp);
      return [...affected].sort((a, b) => a - b);
    });
  }

  function readRecords({ from = 0, to = Number.MAX_SAFE_INTEGER, deviceGuid } = {}) {
    return db.prepare(`SELECT device_guid AS deviceGuid, log_unit_key AS logUnitKey, ${recordSelect}
      FROM usage_records WHERE completed_at>=? AND completed_at<?${deviceGuid ? ' AND device_guid=?' : ''}
      ORDER BY completed_at, record_id`).all(from, to, ...(deviceGuid ? [deviceGuid] : [])).map(shape);
  }

  function readPanel(panel, scope, { previous = false } = {}) {
    const row = selectPanel.get(panel);
    if (!row) return null;
    if (!previous && row.current_scope === scope) return { value: decode(row.current_snapshot), at: row.current_at };
    if (row.previous_scope === scope) return { value: decode(row.previous_snapshot), at: row.previous_at };
    return null;
  }

  function publishPanel(panel, scope, value, at = Date.now()) {
    if (!PANELS.has(panel)) throw new Error('unknown panel');
    upsertPanel.run(panel, scope, encode(value), at);
  }

  const scopeParams = ({ origin, accountId, deviceGuid = '' }, key) => [origin, String(accountId), deviceGuid, key];
  const queue = {
    read(scope, key) { return decode(getState.get(...scopeParams(scope, key))?.value); },
    write(scope, key, value, { state = 'state', now = Date.now() } = {}) {
      putState.run(...scopeParams(scope, key), state, encode(value), now);
    },
    remove(scope, key) { removeState.run(...scopeParams(scope, key)); },
    next({ origin, accountId }, state = 'pending') {
      const row = nextPacket.get(origin, String(accountId), state);
      return row && { ...row, value: decode(row.value) };
    },
    atomic,
    prune: cutoff => pruneQueue.run(cutoff)
  };

  return {
    replaceLog, readRecords, readSources: () => listSources.all().map(row => row.deviceGuid),
    readLogVersions: deviceGuid => new Map(readLogStamp.all(deviceGuid).map(row => [row.log_unit_key, row.log_stamp])),
    prune(now) {
      const cutoff = now - USAGE_RETENTION_MS;
      queue.prune(cutoff);
      return Number(expiredRecords.run(cutoff).changes);
    },
    readPanel, publishPanel, queue, close: () => db.close()
  };
}

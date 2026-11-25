import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HOUR_MS } from './leaderboard_stats.mjs';
import { validInstallationId } from './leaderboard_stats.mjs';
import { requestTokens } from './leaderboard_stats.mjs';
import { HISTORY_DAYS, localHourStart, usageCutoffMs } from './personal_stats.mjs';
import { withTransaction } from './sqlite.mjs';

export const USAGE_RETENTION_MS = 720 * HOUR_MS;
export function personalRecordsCutoff(now) {
  return Math.min(usageCutoffMs(now), localHourStart(now) - HISTORY_DAYS * 24 * HOUR_MS);
}
const PANELS = new Set(['current-data', 'usage', 'usage-cc-switch', 'leaderboard']);
const COLLECTION_KEY = 'usage-collection';
const LOG_PREFIX = 'usage-log:';
const SCHEMA_VERSION = 2;

const metrics = [
  ['freshInputTokens', 'input_tokens'], ['outputTokens', 'output_tokens'],
  ['cacheReadTokens', 'cache_read_tokens'], ['cacheCreationTokens', 'cache_write_tokens'],
  ['tokensPerSecond', 'tokens_per_second']
];
const string = (value, max = 256) => typeof value === 'string' ? value.slice(0, max) : null;

function sanitize(record) {
  if (typeof record?.id !== 'string' || !record.id || !Number.isSafeInteger(Math.trunc(record.completedAt)) ||
      typeof record.provider !== 'string') return null;
  const result = {
    id: record.id, completedAt: Math.trunc(record.completedAt), provider: string(record.provider, 32),
    model: string(record.model, 128), isEstimatedSpeed: record.isEstimatedSpeed === true
  };
  for (const [key] of metrics) result[key] = Number.isFinite(record[key]) && record[key] >= 0 ? record[key] : null;
  return result;
}

const recordFields = [
  ['id', 'record_id'], ['completedAt', 'completed_at'], ['provider', 'harness'],
  ['model', 'model'], ['isEstimatedSpeed', 'estimated'], ...metrics
];
const columns = ['device_guid', 'log_unit_key', 'updated_at', ...recordFields.map(([, column]) => column)];
const recordSelect = recordFields.map(([key, column]) => `${column} AS ${key}`).join(', ');
const fingerprint = record => JSON.stringify(recordFields.map(([key]) => record[key]));
const recordValues = record => recordFields.map(([key]) => typeof record[key] === 'boolean' ? Number(record[key]) : record[key]);
const encode = value => JSON.stringify(value);
const decode = value => value == null ? undefined : JSON.parse(value);

export function openLocalUsageDb(filename) {
  if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename, { enableExtensionLoading: false });
  try {
    db.exec('PRAGMA busy_timeout=3000; PRAGMA trusted_schema=OFF; PRAGMA journal_mode=WAL; BEGIN IMMEDIATE;');
    const { user_version: version } = db.prepare('PRAGMA user_version').get();
    if (version > SCHEMA_VERSION) throw new Error('unsupported local usage database version');
    if (version === 1) db.exec('ALTER TABLE usage_records RENAME TO usage_records_v1');
    db.exec(`
      CREATE TABLE IF NOT EXISTS usage_records (
        device_guid TEXT NOT NULL, record_id TEXT NOT NULL, completed_at INTEGER NOT NULL,
        harness TEXT NOT NULL, model TEXT, estimated INTEGER NOT NULL, input_tokens INTEGER, output_tokens INTEGER,
        cache_read_tokens INTEGER, cache_write_tokens INTEGER, tokens_per_second REAL, log_unit_key TEXT NOT NULL,
        updated_at INTEGER NOT NULL, PRIMARY KEY(device_guid, record_id)
      );
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
    `);
    if (version === 1) db.exec(`
      INSERT INTO usage_records (${columns.join(', ')}) SELECT ${columns.join(', ')} FROM usage_records_v1;
      INSERT INTO panel_cache (panel, current_scope, current_snapshot, current_at)
      SELECT '${LOG_PREFIX}' || device_guid || '/' || log_unit_key, device_guid, json_quote(log_stamp), updated_at
      FROM (
        SELECT device_guid, log_unit_key, log_stamp, updated_at, ROW_NUMBER() OVER (
          PARTITION BY device_guid, log_unit_key ORDER BY updated_at DESC, rowid DESC
        ) AS rank FROM usage_records_v1
      ) WHERE rank = 1;
      DROP TABLE usage_records_v1;
      UPDATE panel_cache SET previous_scope=NULL, previous_snapshot=NULL, previous_at=NULL WHERE panel='${COLLECTION_KEY}';
      DELETE FROM upload_queue WHERE state='confirmed';
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS usage_records_time ON usage_records(completed_at);
      CREATE INDEX IF NOT EXISTS usage_records_source_time ON usage_records(device_guid, completed_at);
      CREATE INDEX IF NOT EXISTS usage_records_log ON usage_records(device_guid, log_unit_key);
      ${version === 0 ? "INSERT OR IGNORE INTO panel_cache(panel, current_scope, current_snapshot, current_at) VALUES ('usage-collection', 'desktop', 'null', 0);" : ''}
      PRAGMA user_version=${SCHEMA_VERSION};
      COMMIT;
    `);
    if (version === 1) {
      try { db.exec('VACUUM; PRAGMA wal_checkpoint(TRUNCATE);'); }
      catch (error) {
        // Pending readers or limited disk space can leave reusable pages in the migrated file.
        if (![5, 6, 13].includes(error.errcode & 0xff)) throw error;
      }
    }
  } catch (error) {
    db.close();
    throw error;
  }

  const selectLog = db.prepare(`SELECT ${recordSelect} FROM usage_records WHERE device_guid=? AND log_unit_key=?`);
  const readLogStamps = db.prepare(`SELECT substr(panel, length(?) + 1) AS log_key, current_snapshot
    FROM panel_cache WHERE panel GLOB ? AND current_scope=?`);
  const pruneLogStamps = db.prepare(`DELETE FROM panel_cache WHERE panel GLOB '${LOG_PREFIX}*'
    AND NOT EXISTS (SELECT 1 FROM usage_records WHERE device_guid=current_scope
      AND log_unit_key=substr(panel, length('${LOG_PREFIX}' || current_scope || '/') + 1))`);
  const deleteRecord = db.prepare('DELETE FROM usage_records WHERE device_guid=? AND record_id=?');
  const expiredRecords = db.prepare('DELETE FROM usage_records WHERE completed_at<?');
  const listSources = db.prepare('SELECT DISTINCT device_guid AS deviceGuid FROM usage_records WHERE completed_at>=?');
  const upsertRecord = db.prepare(`INSERT INTO usage_records(${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})
    ON CONFLICT(device_guid, record_id) DO UPDATE SET ${columns.slice(2).map(column => `${column}=excluded.${column}`).join(', ')}`);
  const insertRecord = db.prepare(`INSERT INTO usage_records(${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})
    ON CONFLICT(device_guid, record_id) DO NOTHING`);
  const touchLog = db.prepare('UPDATE usage_records SET updated_at=? WHERE device_guid=? AND log_unit_key=?');
  const selectPanel = db.prepare('SELECT * FROM panel_cache WHERE panel=?');
  const upsertState = db.prepare(`INSERT INTO panel_cache(panel, current_scope, current_snapshot, current_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(panel) DO UPDATE SET current_snapshot=excluded.current_snapshot, current_at=excluded.current_at WHERE
    excluded.current_snapshot<>current_snapshot`);
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
    row.isEstimatedSpeed = row.isEstimatedSpeed !== 0;
    row.tokens = requestTokens(row);
    return row;
  }

  function replaceLog({ deviceGuid, logUnitKey, logStamp, records, complete, now }) {
    if (!complete) return [];
    const cutoff = personalRecordsCutoff(now);
    return withTransaction(db, () => {
      const logKey = `${LOG_PREFIX}${deviceGuid}/${logUnitKey}`;
      const old = new Map(selectLog.all(deviceGuid, logUnitKey).map(row => [row.id, shape(row)]));
      const incoming = new Map();
      for (const row of records) {
        const record = sanitize(row);
        if (record && record.completedAt >= cutoff && record.completedAt <= now) incoming.set(record.id, record);
      }
      const affected = new Set();
      for (const [id, previous] of old) {
        if (incoming.has(id)) continue;
        deleteRecord.run(deviceGuid, id);
        affected.add(previous.completedAt);
      }
      for (const [id, record] of incoming) {
        const previous = old.get(id);
        if (previous && fingerprint(previous) === fingerprint(record)) continue;
        upsertRecord.run(deviceGuid, logUnitKey, now, ...recordValues(record));
        if (previous) affected.add(previous.completedAt);
        affected.add(record.completedAt);
      }
      if (incoming.size && decode(selectPanel.get(logKey)?.current_snapshot) !== logStamp) {
        touchLog.run(now, deviceGuid, logUnitKey);
        upsertState.run(logKey, deviceGuid, encode(logStamp), now);
      }
      pruneLogStamps.run();
      return [...affected].sort((a, b) => a - b);
    });
  }

  function appendRecords({ deviceGuid, records, now, from = 0, logUnitKey = 'live', logStamp = 'live', insertedRecords }) {
    const cutoff = Math.max(from, personalRecordsCutoff(now));
    const incoming = [];
    for (const row of records) {
      const record = sanitize(row);
      if (record && record.completedAt >= cutoff && record.completedAt <= now) incoming.push(record);
    }
    if (!incoming.length) return 0;
    return withTransaction(db, () => {
      let inserted = 0;
      for (const record of incoming) {
        if (!insertRecord.run(deviceGuid, logUnitKey, now, ...recordValues(record)).changes) continue;
        inserted++;
        insertedRecords?.push(record);
      }
      if (inserted) upsertState.run(`${LOG_PREFIX}${deviceGuid}/${logUnitKey}`, deviceGuid, encode(logStamp), now);
      return inserted;
    });
  }

  function readRecords({ from = 0, to = Number.MAX_SAFE_INTEGER, deviceGuid } = {}) {
    return db.prepare(`SELECT device_guid AS deviceGuid, log_unit_key AS logUnitKey, updated_at AS indexedAt, ${recordSelect}
      FROM usage_records WHERE completed_at>=? AND completed_at<?${deviceGuid ? ' AND device_guid=?' : ''}
      ORDER BY completed_at, record_id`).all(from, to, ...(deviceGuid ? [deviceGuid] : [])).map(shape);
  }

  function* iterateRecords({ from, to, exclude }) {
    const args = [from, to];
    let filter = '';
    if (exclude?.providers.length) {
      filter = ` AND (device_guid<>? OR harness NOT IN (${exclude.providers.map(() => '?').join(', ')}))`;
      args.push(exclude.deviceGuid, ...exclude.providers);
    }
    const select = db.prepare(`SELECT ${recordSelect} FROM usage_records WHERE completed_at>=? AND completed_at<?${filter}`);
    for (const row of select.iterate(...args)) yield shape(row);
  }

  function readCollection(now) {
    const row = selectPanel.get(COLLECTION_KEY);
    // A missing row identifies a database that already contains the previous collector's history.
    return decode(row?.current_snapshot) ?? { startedAt: now, importedAt: row ? null : now };
  }

  function loadCollection(now, deviceGuid) {
    return withTransaction(db, () => {
      const state = readCollection(now);
      if (validInstallationId(deviceGuid) && !validInstallationId(state.deviceGuid)) state.deviceGuid = deviceGuid;
      upsertState.run(COLLECTION_KEY, 'desktop', encode(state), now);
      return state;
    });
  }

  function saveCollection(state, now) {
    withTransaction(db, () => {
      upsertState.run(COLLECTION_KEY, 'desktop', encode({ ...readCollection(now), ...state }), now);
    });
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
    atomic: operation => withTransaction(db, operation),
    prune: cutoff => pruneQueue.run(cutoff)
  };

  return {
    replaceLog, appendRecords, readRecords, iterateRecords, loadCollection, saveCollection,
    readSources: (from = 0) => listSources.all(from).map(row => row.deviceGuid),
    readLogVersions(deviceGuid) {
      const prefix = `${LOG_PREFIX}${deviceGuid}/`;
      return new Map(readLogStamps.all(prefix, `${prefix}*`, deviceGuid)
        .map(row => [row.log_key, decode(row.current_snapshot)]));
    },
    prune(now) {
      return withTransaction(db, () => {
        queue.prune(now - USAGE_RETENTION_MS);
        const removed = Number(expiredRecords.run(personalRecordsCutoff(now)).changes);
        if (removed) pruneLogStamps.run();
        return removed;
      });
    },
    readPanel, publishPanel, queue, close: () => db.close()
  };
}

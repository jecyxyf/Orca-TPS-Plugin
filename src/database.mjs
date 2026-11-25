import { randomBytes, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HOUR_MS, usageCount, validInstallationId } from './leaderboard_stats.mjs';
import { normalizeComparePath } from './harness_parser.mjs';
import { calendarFor, COUNTERS, RETENTION_DAYS } from './personal_stats.mjs';

export const DETAIL_DAYS = 32;
const DATABASE_VERSION = 4;
const LEGACY_DATABASE_VERSION = 3;
const MERGED_DAILY_GENERATION = 'mergedDailyGeneration';
const MAIN_DATABASE = 'tpslugin.db';
const DAILY_DATABASE = 'daily.db';
const DAY_MS = 24 * HOUR_MS;
const EMPTY_COUNTERS = () => Array(COUNTERS).fill(0);
const validTime = value => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
const channelAliases = new Map([['agy', 'antigravity'], ['opencode2', 'opencode']]);
export const channelProvider = provider => channelAliases.get(provider) ?? provider;
const sessionKey = ({ provider, sessionId }) => provider && sessionId ? JSON.stringify([channelProvider(provider), sessionId]) : null;

function openDatabase(filename) {
  const db = new DatabaseSync(filename, { enableExtensionLoading: false });
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF;');
  return db;
}

function checkpointDatabase(db, name) {
  db.exec('PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF;');
  const { busy } = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  if (busy || db.prepare('PRAGMA journal_mode=DELETE').get().journal_mode !== 'delete') {
    throw new Error(`Database is busy: ${name}`);
  }
}

function migrateDatabases(root, directory) {
  const moves = [];
  for (const name of [MAIN_DATABASE, DAILY_DATABASE]) {
    const source = path.join(root, name);
    const original = lstatSync(source, { throwIfNoEntry: false });
    if (!original) continue;
    const target = path.join(directory, name);
    if (!original.isFile() || lstatSync(target, { throwIfNoEntry: false })) {
      throw new Error(`Cannot migrate ${name}: invalid source or target already exists`);
    }
    moves.push({ source, target, name });
  }

  // Close the WAL and put committed changes in the main file before it moves.
  for (const { source, name } of moves) {
    const db = new DatabaseSync(source, { enableExtensionLoading: false });
    try { checkpointDatabase(db, name); }
    finally { db.close(); }
  }

  // Each rename is atomic. A restart can continue if one file already moved.
  for (const { source, target } of moves) renameSync(source, target);
}

function transaction(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function readDeviceGuid(root, fallback) {
  const file = path.join(root, 'device-guid');
  try {
    writeFileSync(file, validInstallationId(fallback) ? fallback : randomUUID(), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const guid = readFileSync(file, 'utf8').trim();
  if (!validInstallationId(guid)) throw new Error('Invalid Tokens manager device GUID');
  return guid;
}

function prepare(store, sql) {
  return Object.fromEntries(Object.entries(sql).map(([name, query]) => [name, store.prepare(query)]));
}

function recordCounters(record) {
  const speed = usageCount(record.tokensPerSecond);
  return [1, usageCount(record.freshInputTokens), usageCount(record.outputTokens), usageCount(record.cacheReadTokens),
    usageCount(record.cacheCreationTokens), Number(speed > 0), speed, Number(speed > 0 && !!record.isEstimatedSpeed)];
}

function addBucket(buckets, calendar, record, direction) {
  const day = calendar.day(record.completedAt);
  const counters = recordCounters(record);
  for (const [kind, at] of [[0, 0], [1, calendar.hour(record.completedAt)]]) {
    const dimensions = [kind, day, at, record.cwd ?? record.project ?? '', record.provider, record.model ?? ''];
    const key = JSON.stringify(dimensions);
    const values = buckets.get(key) ?? EMPTY_COUNTERS();
    for (let i = 0; i < counters.length; i++) values[i] += direction * counters[i];
    buckets.set(key, values);
  }
}

export function openTokensManagerDb(root, { deviceGuid, timeZone, now = Date.now } = {}) {
  const directory = path.join(root, 'database');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  migrateDatabases(root, directory);
  const guid = readDeviceGuid(root, deviceGuid);
  const main = openDatabase(path.join(directory, MAIN_DATABASE));
  try {
    return initializeDatabase(main, path.join(directory, DAILY_DATABASE), guid, timeZone, now);
  } catch (error) {
    main.close();
    throw error;
  }
}

function initializeDatabase(main, legacyDaily, guid, timeZone, now) {
  main.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS scan_progress (source TEXT PRIMARY KEY, stamp TEXT NOT NULL, scanned_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, day TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS seen_day ON seen(day);
    CREATE TABLE IF NOT EXISTS details (id TEXT PRIMARY KEY, day TEXT NOT NULL, at INTEGER NOT NULL, record TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS details_at ON details(at);
    CREATE INDEX IF NOT EXISTS details_day ON details(day);
    CREATE TABLE IF NOT EXISTS detail_channels (id TEXT PRIMARY KEY, cwd TEXT, session TEXT, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS detail_channels_cwd ON detail_channels(cwd, at DESC, id);
    CREATE INDEX IF NOT EXISTS detail_channels_session ON detail_channels(session, at DESC, id);
    CREATE TRIGGER IF NOT EXISTS detail_channels_delete AFTER DELETE ON details BEGIN
      DELETE FROM detail_channels WHERE id = OLD.id;
    END;
    CREATE TRIGGER IF NOT EXISTS detail_channels_insert AFTER INSERT ON details BEGIN
      DELETE FROM detail_channels WHERE id = NEW.id;
    END;
    CREATE TABLE IF NOT EXISTS buckets (
      kind INTEGER NOT NULL, day TEXT NOT NULL, at INTEGER NOT NULL, project TEXT NOT NULL,
      provider TEXT NOT NULL, model TEXT NOT NULL, counters TEXT NOT NULL,
      PRIMARY KEY (kind, day, at, project, provider, model)
    ) WITHOUT ROWID;
  `);
  const m = prepare(main, {
    setting: 'SELECT value FROM settings WHERE key = ?',
    save: 'INSERT OR REPLACE INTO settings VALUES (?, ?)',
    deleteSetting: 'DELETE FROM settings WHERE key = ?',
    source: 'SELECT stamp FROM scan_progress WHERE source = ?',
    cursor: 'INSERT OR REPLACE INTO scan_progress VALUES (?, ?, ?)',
    seen: 'SELECT id FROM seen WHERE id = ?',
    remember: 'INSERT OR REPLACE INTO seen VALUES (?, ?)',
    detail: 'SELECT record FROM details WHERE id = ?',
    addDetail: 'INSERT OR REPLACE INTO details VALUES (?, ?, ?, ?)',
    channelDetail: 'INSERT INTO detail_channels VALUES (?, ?, ?, ?)',
    channelBackfill: `SELECT d.id, d.at, d.record FROM details AS d
      WHERE NOT EXISTS (SELECT 1 FROM detail_channels AS c WHERE c.id = d.id)`,
    channelByCwd: `SELECT c.id, c.at, d.record FROM detail_channels AS c JOIN details AS d USING (id)
      WHERE c.cwd = ? ORDER BY c.at DESC, c.id LIMIT 100`,
    channelBySession: `SELECT c.id, c.at, d.record FROM detail_channels AS c JOIN details AS d USING (id)
      WHERE c.session = ? ORDER BY c.at DESC, c.id LIMIT 100`,
    details: 'SELECT record FROM details WHERE at >= ? ORDER BY at DESC, id',
    pruneDetails: 'DELETE FROM details WHERE day < ?',
    pruneSeen: 'DELETE FROM seen WHERE day < ?',
    pruneProgress: 'DELETE FROM scan_progress WHERE scanned_at < ?',
    bucket: 'SELECT counters FROM buckets WHERE kind=? AND day=? AND at=? AND project=? AND provider=? AND model=?',
    saveBucket: 'INSERT OR REPLACE INTO buckets VALUES (?, ?, ?, ?, ?, ?, ?)',
    deleteBucket: 'DELETE FROM buckets WHERE kind=? AND day=? AND at=? AND project=? AND provider=? AND model=?',
    buckets: 'SELECT * FROM buckets WHERE kind=? AND day>=? ORDER BY day, at, project, provider, model',
    pruneBuckets: 'DELETE FROM buckets WHERE day < ?'
  });
  const setting = (key, fallback) => {
    const row = m.setting.get(key);
    return row ? JSON.parse(row.value) : fallback;
  };
  const saveSetting = (key, value) => m.save.run(key, JSON.stringify(value));
  let calendar = calendarFor(setting('timeZone', timeZone));

  function indexDetail(id, at, record) {
    m.channelDetail.run(id, normalizeComparePath(record.cwd), sessionKey(record), at);
  }

  function reset(next) {
    transaction(main, () => {
      main.exec('DELETE FROM scan_progress; DELETE FROM seen; DELETE FROM details; DELETE FROM buckets;');
      saveSetting('timeZone', next.timeZone);
      saveSetting('generation', randomUUID());
      saveSetting('version', DATABASE_VERSION);
      saveSetting('lastScanAt', 0);
    });
    calendar = next;
  }

  function writeBuckets(changes) {
    for (const [key, delta] of changes) {
      const dimensions = JSON.parse(key);
      const row = m.bucket.get(...dimensions);
      const current = row ? JSON.parse(row.counters) : EMPTY_COUNTERS();
      const counters = current.map((value, index) => value + delta[index]);
      if (counters[0] > 0) m.saveBucket.run(...dimensions, JSON.stringify(counters));
      else m.deleteBucket.run(...dimensions);
    }
  }

  function mergeDaily(generation) {
    if (!lstatSync(legacyDaily, { throwIfNoEntry: false })?.isFile()) {
      throw new Error('Missing legacy daily database');
    }
    const daily = new DatabaseSync(legacyDaily, { readOnly: true, enableExtensionLoading: false });
    try {
      daily.exec('PRAGMA trusted_schema=OFF; BEGIN;');
      const readSetting = daily.prepare('SELECT value FROM settings WHERE key = ?');
      const applied = Number(readSetting.get('applied')?.value);
      if (readSetting.get('generation')?.value !== generation || !Number.isSafeInteger(applied) || applied < 0) {
        throw new Error('Invalid legacy daily database state');
      }
      const rows = daily.prepare('SELECT kind, day, at, project, provider, model, counters FROM buckets');
      const pending = main.prepare('SELECT buckets FROM pending WHERE id > ? ORDER BY id');
      transaction(main, () => {
        for (const { kind, day, at, project, provider, model, counters } of rows.iterate()) {
          m.saveBucket.run(kind, day, at, project, provider, model, counters);
        }
        // A batch can already be in the daily database even if the main database still lists it.
        for (const row of pending.iterate(applied)) writeBuckets(JSON.parse(row.buckets));
        main.exec('DROP TABLE pending');
        saveSetting(MERGED_DAILY_GENERATION, generation);
        saveSetting('version', DATABASE_VERSION);
      });
    } finally { daily.close(); }
  }

  function removeMergedDaily() {
    const generation = setting(MERGED_DAILY_GENERATION);
    if (!generation) return;
    const file = lstatSync(legacyDaily, { throwIfNoEntry: false });
    if (file) {
      if (!file.isFile()) throw new Error('Invalid legacy daily database path');
      const daily = new DatabaseSync(legacyDaily, { enableExtensionLoading: false });
      try {
        const previous = daily.prepare("SELECT value FROM settings WHERE key = 'generation'").get()?.value;
        if (previous !== generation) throw new Error('Legacy daily database was replaced after merging');
        checkpointDatabase(daily, DAILY_DATABASE);
      } finally { daily.close(); }
      unlinkSync(legacyDaily);
    }
    m.deleteSetting.run(MERGED_DAILY_GENERATION);
  }

  const generation = setting('generation');
  const version = setting('version');
  if (version === LEGACY_DATABASE_VERSION && generation) mergeDaily(generation);
  else if (version === undefined && !generation && !lstatSync(legacyDaily, { throwIfNoEntry: false })) {
    reset(calendar);
  } else if (version !== DATABASE_VERSION || !generation) throw new Error('Invalid Tokens manager database version');

  // The merged database is ready even if a reader is still holding the old file open.
  // Keep the marker to retry cleanup on the next startup.
  try { removeMergedDaily(); } catch {}
  saveSetting('deviceGuid', guid);
  transaction(main, () => {
    for (const { id, at, record } of m.channelBackfill.iterate()) indexDetail(id, at, JSON.parse(record));
  });

  function setTimeZone(timeZone) {
    const next = calendarFor(timeZone);
    if (next.timeZone === calendar.timeZone) return false;
    reset(next);
    return true;
  }

  function commitSource(source, stamp, records, at = now()) {
    const firstDay = calendar.dayAgo(at, RETENTION_DAYS - 1);
    const detailDay = calendar.dayAgo(at, DETAIL_DAYS - 1);
    transaction(main, () => {
      const buckets = new Map();
      for (const sourceRecord of records) {
        let record = sourceRecord;
        if (!record || !validTime(record.completedAt) || typeof record.id !== 'string' || !record.id ||
            typeof record.provider !== 'string' || !record.provider) continue;
        const day = calendar.day(record.completedAt);
        if (day < firstDay || day > calendar.day(at)) continue;
        let id = JSON.stringify([record.provider, ...(record.provider === 'antigravity' ? [record.sessionId ?? ''] : []), record.id]);
        let previous = m.detail.get(id);
        if (typeof record.alternateId === 'string' && record.alternateId && record.alternateId !== record.id) {
          const { alternateId, ...details } = record;
          const alternateKey = JSON.stringify([record.provider, ...(record.provider === 'antigravity' ? [record.sessionId ?? ''] : []), alternateId]);
          const priorAlternate = m.detail.get(alternateKey);
          let other = alternateKey;
          record = details;
          // Remember both source IDs in the same transaction as the usage.
          if (!previous && (priorAlternate || (!m.seen.get(id) && m.seen.get(alternateKey)))) {
            other = id;
            id = alternateKey;
            previous = priorAlternate;
            record.id = alternateId;
          }
          if (!m.seen.get(other)) m.remember.run(other, day);
        }
        const body = day >= detailDay ? JSON.stringify(record) : null;
        if (previous?.record === body || (!previous && m.seen.get(id))) continue;
        const priorRecord = previous ? JSON.parse(previous.record) : null;
        if (record.dataSource === 'claude_desktop_ledger' && priorRecord?.dataSource === 'claude_desktop_audit') continue;
        if (priorRecord) addBucket(buckets, calendar, priorRecord, -1);
        m.remember.run(id, day);
        if (body) {
          m.addDetail.run(id, day, record.completedAt, body);
          indexDetail(id, record.completedAt, record);
        }
        addBucket(buckets, calendar, record, 1);
      }
      writeBuckets(buckets);
      if (stamp !== null) m.cursor.run(source, stamp, at);
    });
  }

  function finishScan(at = now()) {
    const firstDay = calendar.dayAgo(at, RETENTION_DAYS - 1);
    transaction(main, () => {
      m.pruneBuckets.run(firstDay);
      m.pruneSeen.run(firstDay);
      m.pruneDetails.run(calendar.dayAgo(at, DETAIL_DAYS - 1));
      m.pruneProgress.run(Date.parse(firstDay + 'T00:00:00Z') - DAY_MS);
      saveSetting('lastScanAt', at);
      saveSetting('lastScanError', null);
    });
  }

  function channelDetails(cwd, sessions) {
    const rows = new Map();
    if (cwd) for (const row of m.channelByCwd.all(cwd)) rows.set(row.id, row);
    const keys = new Set(sessions.map(sessionKey).filter(Boolean));
    for (const key of keys) for (const row of m.channelBySession.all(key)) rows.set(row.id, row);
    return [...rows.values()].sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1)).slice(0, 100)
      .map(row => JSON.parse(row.record));
  }

  return {
    deviceGuid: guid, get calendar() { return calendar; }, setting, saveSetting, setTimeZone,
    sourceStamp: source => m.source.get(source)?.stamp,
    commitSource, finishScan, channelDetails,
    details: (from = 0) => m.details.all(from).map(row => JSON.parse(row.record)),
    buckets: (kind, from = '') => m.buckets.all(kind, from).map(({ kind, counters, ...dimensions }) => ({
      ...dimensions, counters: JSON.parse(counters)
    })),
    close() { main.close(); }
  };
}

const json = async file => JSON.parse(await readFile(file, 'utf8'));
const remoteDeviceDirectory = root => path.join(root, 'remote_device');
const cacheFilename = (root, deviceGuid, name) => path.join(remoteDeviceDirectory(root), deviceGuid, name + '.json');

async function savePacket(filename, packet) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const next = filename + '.' + randomBytes(6).toString('hex') + '.next';
  try {
    await writeFile(next, JSON.stringify(packet), { flag: 'wx', mode: 0o600 });
    await rename(next, filename);
  } finally {
    await unlink(next).catch(() => {});
  }
}

export const validPersonal = packet => packet && validInstallationId(packet.deviceGuid) &&
  typeof packet.timeZone === 'string' && Number.isSafeInteger(packet.publishedAt) && packet.publishedAt >= 0 &&
  [packet.days, packet.hours, packet.maxima].every(Array.isArray) &&
  [packet.days, packet.hours].every(rows => rows.every(row => Array.isArray(row?.counters))) &&
  packet.maxima.every(row => row && typeof row === 'object') &&
  (packet.ranking === undefined || (packet.ranking?.deviceGuid === packet.deviceGuid &&
    packet.ranking.publishedAt === packet.publishedAt && packet.ranking.timeZone === packet.timeZone &&
    [packet.ranking.hours, packet.ranking.daily, packet.ranking.samples].every(Array.isArray) &&
    (packet.ranking.accountId === undefined || Number.isSafeInteger(packet.ranking.accountId) && packet.ranking.accountId > 0)));
const validRelay = packet => packet && validInstallationId(packet.deviceGuid) &&
  Number.isSafeInteger(packet.accountId) && packet.accountId > 0 &&
  Number.isSafeInteger(packet.publishedAt) && packet.publishedAt >= 0;

export function keepLatest(packets, key, packet) {
  if ((packets.get(key)?.publishedAt ?? -1) >= packet.publishedAt) return false;
  packets.set(key, packet);
  return true;
}

function rememberRelay(relays, packet) {
  let accounts = relays.get(packet.deviceGuid);
  if (!accounts) relays.set(packet.deviceGuid, accounts = new Map());
  return keepLatest(accounts, packet.accountId, packet);
}

export async function readRemoteDeviceCache(root) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const personal = new Map(), relays = new Map();
  const devices = await readdir(remoteDeviceDirectory(root), { withFileTypes: true }).catch(() => []);
  for (const device of devices) {
    if (!device.isDirectory() || !validInstallationId(device.name)) continue;
    const [statistics, leaderboard] = await Promise.all([
      json(cacheFilename(root, device.name, 'personal')).catch(() => null),
      json(cacheFilename(root, device.name, 'leaderboard')).catch(() => null)
    ]);
    if (validPersonal(statistics) && statistics.deviceGuid === device.name) {
      keepLatest(personal, device.name, statistics);
    }
    for (const [account, packet] of Object.entries(leaderboard ?? {})) {
      if (validRelay(packet) && packet.deviceGuid === device.name && String(packet.accountId) === account) {
        rememberRelay(relays, packet);
      }
    }
  }

  for (const file of await readdir(root, { withFileTypes: true })) {
    const legacy = /^(?:personal|leaderboard-(\d+))-([a-f0-9-]+)\.json$/.exec(file.name);
    if (!file.isFile() || !legacy || !validInstallationId(legacy[2])) continue;
    const [, account, deviceGuid] = legacy;
    const filename = path.join(root, file.name);
    const packet = await json(filename).catch(() => null);
    if (packet?.deviceGuid !== deviceGuid) continue;
    let name, data;
    if (account === undefined && validPersonal(packet)) {
      keepLatest(personal, deviceGuid, packet);
      name = 'personal';
      data = personal.get(deviceGuid);
    } else if (validRelay(packet) && account === String(packet.accountId)) {
      rememberRelay(relays, packet);
      name = 'leaderboard';
      data = Object.fromEntries(relays.get(deviceGuid));
    } else continue;

    try {
      await savePacket(cacheFilename(root, deviceGuid, name), data);
      await unlink(filename);
    } catch { /* A failed migration leaves the old cache available for the next startup. */ }
  }
  return { personal, relays };
}

export async function openRemoteDeviceCache(root) {
  const { personal, relays } = await readRemoteDeviceCache(root);
  const writes = new Map();

  function persist(deviceGuid, name, packet) {
    const filename = cacheFilename(root, deviceGuid, name);
    const pending = (writes.get(filename) ?? Promise.resolve())
      .then(() => savePacket(filename, packet))
      .catch(() => {})
      .finally(() => { if (writes.get(filename) === pending) writes.delete(filename); });
    writes.set(filename, pending);
  }

  return {
    personal, relays,
    acceptPersonal(packet, ownDevice) {
      if (!validPersonal(packet) || packet.deviceGuid === ownDevice ||
          !keepLatest(personal, packet.deviceGuid, packet)) return false;
      persist(packet.deviceGuid, 'personal', packet);
      return true;
    },
    acceptLeaderboard(packet, ownDevice) {
      if (!validRelay(packet) || packet.deviceGuid === ownDevice ||
          !rememberRelay(relays, packet)) return false;
      persist(packet.deviceGuid, 'leaderboard', Object.fromEntries(relays.get(packet.deviceGuid)));
      return true;
    },
    flush: () => Promise.all(writes.values())
  };
}

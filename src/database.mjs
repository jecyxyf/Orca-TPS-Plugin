import { randomBytes, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HOUR_MS, USAGE_COUNTER, countUsageRecord, emptyUsageCounters, validInstallationId } from './leaderboard_stats.mjs';
import { normalizeComparePath } from './harness_parser.mjs';
import { calendarFor, RETENTION_DAYS } from './personal_stats.mjs';
import { harnessFamily as channelProvider } from './harnesses.mjs';
import { openReadonlyDatabase, withTransaction } from './sqlite.mjs';
export { channelProvider };

export const DETAIL_DAYS = 32;
const DATABASE_VERSION = 4, LEGACY_VERSION = 3, MERGED_GEN = 'mergedDailyGeneration';
const MAIN_DB = 'tpslugin.db', DAILY_DB = 'daily.db', DAY_MS = 24 * HOUR_MS;
const validTime = v => Number.isSafeInteger(v) && v >= 0 && v <= 8_640_000_000_000_000;
const sessionKey = ({ provider, sessionId }) => provider && sessionId ? JSON.stringify([channelProvider(provider), sessionId]) : null;

function openDatabase(filename) {
  const db = new DatabaseSync(filename, { enableExtensionLoading: false });
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF;');
  return db;
}

function checkpointDatabase(db, name) {
  db.exec('PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF;');
  if (db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy || db.prepare('PRAGMA journal_mode=DELETE').get().journal_mode !== 'delete') {
    throw new Error(`Database is busy: ${name}`);
  }
}

function migrateDatabases(root, directory) {
  const moves = [];
  for (const name of [MAIN_DB, DAILY_DB]) {
    const source = path.join(root, name), original = lstatSync(source, { throwIfNoEntry: false });
    if (!original) continue;
    const target = path.join(directory, name);
    if (!original.isFile() || lstatSync(target, { throwIfNoEntry: false })) throw new Error(`Cannot migrate ${name}: invalid source or target already exists`);
    moves.push({ source, target, name });
  }
  for (const { source, name } of moves) {
    const db = new DatabaseSync(source, { enableExtensionLoading: false });
    try { checkpointDatabase(db, name); } finally { db.close(); }
  }
  for (const { source, target } of moves) renameSync(source, target);
}

function readDeviceGuid(root, fallback) {
  const file = path.join(root, 'device-guid');
  try { writeFileSync(file, validInstallationId(fallback) ? fallback : randomUUID(), { flag: 'wx', mode: 0o600 }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
  const guid = readFileSync(file, 'utf8').trim();
  if (!validInstallationId(guid)) throw new Error('Invalid Tokens manager device GUID');
  return guid;
}

function addBucket(buckets, calendar, record, direction) {
  const day = calendar.day(record.completedAt), counters = countUsageRecord(emptyUsageCounters(), record);
  for (const [kind, at] of [[0, 0], [1, calendar.hour(record.completedAt)]]) {
    const dimensions = [kind, day, at, record.cwd ?? record.project ?? '', record.provider, record.model ?? ''];
    const key = JSON.stringify(dimensions);
    const bucket = buckets.get(key) ?? buckets.set(key, { dimensions, counters: emptyUsageCounters() }).get(key);
    for (let i = 0; i < counters.length; i++) bucket.counters[i] += direction * counters[i];
  }
}

function writeBucket(q, dimensions, delta) {
  const row = q.bucket.get(...dimensions);
  const counters = (row ? JSON.parse(row.counters) : emptyUsageCounters()).map((v, i) => v + delta[i]);
  if (counters[USAGE_COUNTER.requests] > 0) q.saveBucket.run(...dimensions, JSON.stringify(counters));
  else q.deleteBucket.run(...dimensions);
}

const usageQueries = {
  setting: 'SELECT value FROM settings WHERE key = ?', save: 'INSERT OR REPLACE INTO settings VALUES (?, ?)',
  deleteSetting: 'DELETE FROM settings WHERE key = ?', source: 'SELECT stamp FROM scan_progress WHERE source = ?',
  cursor: 'INSERT OR REPLACE INTO scan_progress VALUES (?, ?, ?)', seen: 'SELECT id FROM seen WHERE id = ?',
  remember: 'INSERT OR REPLACE INTO seen VALUES (?, ?)', detail: 'SELECT record FROM details WHERE id = ?',
  addDetail: 'INSERT OR REPLACE INTO details VALUES (?, ?, ?, ?)', channelDetail: 'INSERT INTO detail_channels VALUES (?, ?, ?, ?)',
  channelBackfill: 'SELECT d.id, d.at, d.record FROM details AS d WHERE NOT EXISTS (SELECT 1 FROM detail_channels AS c WHERE c.id = d.id)',
  channelByCwd: 'SELECT c.id, c.at, d.record FROM detail_channels AS c JOIN details AS d USING (id) WHERE c.cwd = ? ORDER BY c.at DESC, c.id LIMIT 100',
  channelBySession: 'SELECT c.id, c.at, d.record FROM detail_channels AS c JOIN details AS d USING (id) WHERE c.session = ? ORDER BY c.at DESC, c.id LIMIT 100',
  details: 'SELECT record FROM details WHERE at >= ? ORDER BY at DESC, id',
  pruneDetails: 'DELETE FROM details WHERE day < ?', pruneSeen: 'DELETE FROM seen WHERE day < ?',
  pruneProgress: 'DELETE FROM scan_progress WHERE scanned_at < ?',
  bucket: 'SELECT counters FROM buckets WHERE kind=? AND day=? AND at=? AND project=? AND provider=? AND model=?',
  saveBucket: 'INSERT OR REPLACE INTO buckets VALUES (?, ?, ?, ?, ?, ?, ?)',
  deleteBucket: 'DELETE FROM buckets WHERE kind=? AND day=? AND at=? AND project=? AND provider=? AND model=?',
  buckets: 'SELECT * FROM buckets WHERE kind=? AND day>=? ORDER BY day, at, project, provider, model',
  pruneBuckets: 'DELETE FROM buckets WHERE day < ?'
};

function mergeDaily(main, legacyDaily, m, saveSetting, generation) {
  if (!lstatSync(legacyDaily, { throwIfNoEntry: false })?.isFile()) throw new Error('Missing legacy daily database');
  const daily = openReadonlyDatabase(legacyDaily, 0);
  try {
    daily.exec('BEGIN');
    const readS = daily.prepare('SELECT value FROM settings WHERE key = ?'), applied = Number(readS.get('applied')?.value);
    if (readS.get('generation')?.value !== generation || !Number.isSafeInteger(applied) || applied < 0) throw new Error('Invalid legacy daily database state');
    const rows = daily.prepare('SELECT kind, day, at, project, provider, model, counters FROM buckets');
    const pending = main.prepare('SELECT buckets FROM pending WHERE id > ? ORDER BY id');
    withTransaction(main, () => {
      for (const r of rows.iterate()) m.saveBucket.run(r.kind, r.day, r.at, r.project, r.provider, r.model, r.counters);
      for (const row of pending.iterate(applied)) for (const [k, d] of JSON.parse(row.buckets)) writeBucket(m, JSON.parse(k), d);
      main.exec('DROP TABLE pending');
      saveSetting(MERGED_GEN, generation);
      saveSetting('version', DATABASE_VERSION);
    });
  } finally { daily.close(); }
}

export function openTokensManagerDb(root, { deviceGuid, timeZone, now = Date.now } = {}) {
  const directory = path.join(root, 'database');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  migrateDatabases(root, directory);
  const guid = readDeviceGuid(root, deviceGuid), main = openDatabase(path.join(directory, MAIN_DB));
  try {
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
      CREATE TRIGGER IF NOT EXISTS detail_channels_delete AFTER DELETE ON details BEGIN DELETE FROM detail_channels WHERE id = OLD.id; END;
      CREATE TRIGGER IF NOT EXISTS detail_channels_insert AFTER INSERT ON details BEGIN DELETE FROM detail_channels WHERE id = NEW.id; END;
      CREATE TABLE IF NOT EXISTS buckets (kind INTEGER NOT NULL, day TEXT NOT NULL, at INTEGER NOT NULL, project TEXT NOT NULL,
        provider TEXT NOT NULL, model TEXT NOT NULL, counters TEXT NOT NULL, PRIMARY KEY (kind, day, at, project, provider, model)) WITHOUT ROWID;
    `);
    const m = Object.fromEntries(Object.entries(usageQueries).map(([k, sql]) => [k, main.prepare(sql)]));
    const setting = (key, fallback) => { const r = m.setting.get(key); return r ? JSON.parse(r.value) : fallback; };
    const saveSetting = (key, value) => m.save.run(key, JSON.stringify(value));
    let calendar = calendarFor(setting('timeZone', timeZone));
    const indexDetail = (id, at, record) => m.channelDetail.run(id, normalizeComparePath(record.cwd), sessionKey(record), at);
    const reset = next => {
      withTransaction(main, () => {
        main.exec('DELETE FROM scan_progress; DELETE FROM seen; DELETE FROM details; DELETE FROM buckets;');
        saveSetting('timeZone', next.timeZone); saveSetting('generation', randomUUID());
        saveSetting('version', DATABASE_VERSION); saveSetting('lastScanAt', 0);
      });
      calendar = next;
    };
    const legacyDaily = path.join(directory, DAILY_DB), generation = setting('generation'), version = setting('version');
    if (version === LEGACY_VERSION && generation) mergeDaily(main, legacyDaily, m, saveSetting, generation);
    else if (version === undefined && !generation && !lstatSync(legacyDaily, { throwIfNoEntry: false })) reset(calendar);
    else if (version !== DATABASE_VERSION || !generation) throw new Error('Invalid Tokens manager database version');

    try {
      const mergedGen = setting(MERGED_GEN);
      if (mergedGen) {
        const file = lstatSync(legacyDaily, { throwIfNoEntry: false });
        if (file) {
          if (!file.isFile()) throw new Error('Invalid legacy daily database path');
          const d = new DatabaseSync(legacyDaily, { enableExtensionLoading: false });
          try { if (d.prepare("SELECT value FROM settings WHERE key = 'generation'").get()?.value !== mergedGen) throw new Error('replaced'); checkpointDatabase(d, DAILY_DB); }
          finally { d.close(); }
          unlinkSync(legacyDaily);
        }
        m.deleteSetting.run(MERGED_GEN);
      }
    } catch {}
    saveSetting('deviceGuid', guid);
    withTransaction(main, () => { for (const { id, at, record } of m.channelBackfill.iterate()) indexDetail(id, at, JSON.parse(record)); });

    return {
      deviceGuid: guid, get calendar() { return calendar; }, setting, saveSetting,
      setTimeZone(zone) { const next = calendarFor(zone); if (next.timeZone === calendar.timeZone) return false; reset(next); return true; },
      sourceStamp: source => m.source.get(source)?.stamp,
      commitSource(source, stamp, records, at = now()) {
        const firstDay = calendar.dayAgo(at, RETENTION_DAYS - 1), detailDay = calendar.dayAgo(at, DETAIL_DAYS - 1), today = calendar.day(at);
        withTransaction(main, () => {
          const buckets = new Map();
          for (const sourceRecord of records) {
            let record = sourceRecord;
            if (!record || !validTime(record.completedAt) || typeof record.id !== 'string' || !record.id || typeof record.provider !== 'string' || !record.provider) continue;
            const day = calendar.day(record.completedAt);
            if (day < firstDay || day > today) continue;
            const keyFor = recId => JSON.stringify([record.provider, ...(record.provider === 'antigravity' ? [record.sessionId ?? ''] : []), recId]);
            let id = keyFor(record.id), previous = m.detail.get(id);
            if (typeof record.alternateId === 'string' && record.alternateId && record.alternateId !== record.id) {
              const { alternateId, ...details } = record, altKey = keyFor(alternateId), priorAlt = m.detail.get(altKey);
              let other = altKey; record = details;
              if (!previous && (priorAlt || (!m.seen.get(id) && m.seen.get(altKey)))) { other = id; id = altKey; previous = priorAlt; record.id = alternateId; }
              if (!m.seen.get(other)) m.remember.run(other, day);
            }
            const body = day >= detailDay ? JSON.stringify(record) : null;
            if (previous?.record === body || (!previous && m.seen.get(id))) continue;
            const priorRecord = previous ? JSON.parse(previous.record) : null;
            if (record.dataSource === 'claude_desktop_ledger' && priorRecord?.dataSource === 'claude_desktop_audit') continue;
            if (priorRecord) addBucket(buckets, calendar, priorRecord, -1);
            m.remember.run(id, day);
            if (body) { m.addDetail.run(id, day, record.completedAt, body); indexDetail(id, record.completedAt, record); }
            addBucket(buckets, calendar, record, 1);
          }
          for (const { dimensions, counters } of buckets.values()) writeBucket(m, dimensions, counters);
          if (stamp !== null) m.cursor.run(source, stamp, at);
        });
      },
      finishScan(at = now()) {
        const firstDay = calendar.dayAgo(at, RETENTION_DAYS - 1);
        withTransaction(main, () => {
          m.pruneBuckets.run(firstDay); m.pruneSeen.run(firstDay);
          m.pruneDetails.run(calendar.dayAgo(at, DETAIL_DAYS - 1));
          m.pruneProgress.run(Date.parse(firstDay + 'T00:00:00Z') - DAY_MS);
          saveSetting('lastScanAt', at); saveSetting('lastScanError', null);
        });
        main.exec('PRAGMA shrink_memory;');
      },
      channelDetails(cwd, sessions) {
        const rows = new Map();
        if (cwd) for (const r of m.channelByCwd.all(cwd)) rows.set(r.id, r);
        for (const key of new Set(sessions.map(sessionKey).filter(Boolean))) for (const r of m.channelBySession.all(key)) rows.set(r.id, r);
        return [...rows.values()].sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1)).slice(0, 100).map(r => JSON.parse(r.record));
      },
      details: (from = 0) => m.details.all(from).map(r => JSON.parse(r.record)),
      *iterateDetails(from = 0) { for (const r of m.details.iterate(from)) yield JSON.parse(r.record); },
      buckets: (kind, from = '') => m.buckets.all(kind, from).map(({ kind: _, counters, ...dim }) => ({ ...dim, counters: JSON.parse(counters) })),
      close: () => main.close()
    };
  } catch (error) { main.close(); throw error; }
}

const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const cacheFile = (root, guid, name) => path.join(root, 'remote_device', guid, name + '.json');

async function savePacket(filename, packet) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const next = `${filename}.${randomBytes(6).toString('hex')}.next`;
  try { await writeFile(next, JSON.stringify(packet), { flag: 'wx', mode: 0o600 }); await rename(next, filename); }
  finally { await unlink(next).catch(() => {}); }
}

export const validPersonal = p => p && validInstallationId(p.deviceGuid) && typeof p.timeZone === 'string' &&
  Number.isSafeInteger(p.publishedAt) && p.publishedAt >= 0 && [p.days, p.hours, p.maxima].every(Array.isArray) &&
  [p.days, p.hours].every(rows => rows.every(r => Array.isArray(r?.counters))) && p.maxima.every(r => r && typeof r === 'object') &&
  (p.ranking === undefined || (p.ranking?.deviceGuid === p.deviceGuid && p.ranking.publishedAt === p.publishedAt && p.ranking.timeZone === p.timeZone &&
    [p.ranking.hours, p.ranking.daily, p.ranking.samples].every(Array.isArray) &&
    (p.ranking.accountId === undefined || (Number.isSafeInteger(p.ranking.accountId) && p.ranking.accountId > 0))));
const validRelay = p => p && validInstallationId(p.deviceGuid) && Number.isSafeInteger(p.accountId) && p.accountId > 0 && Number.isSafeInteger(p.publishedAt) && p.publishedAt >= 0;

export function keepLatest(packets, key, packet) {
  if ((packets.get(key)?.publishedAt ?? -1) >= packet.publishedAt) return false;
  packets.set(key, packet);
  return true;
}
const rememberRelay = (relays, p) => keepLatest(relays.get(p.deviceGuid) ?? relays.set(p.deviceGuid, new Map()).get(p.deviceGuid), p.accountId, p);

export async function readRemoteDeviceCache(root) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const personal = new Map(), relays = new Map();
  for (const device of await readdir(path.join(root, 'remote_device'), { withFileTypes: true }).catch(() => [])) {
    if (!device.isDirectory() || !validInstallationId(device.name)) continue;
    const [stats, board] = await Promise.all([readJson(cacheFile(root, device.name, 'personal')).catch(() => null), readJson(cacheFile(root, device.name, 'leaderboard')).catch(() => null)]);
    if (validPersonal(stats) && stats.deviceGuid === device.name) keepLatest(personal, device.name, stats);
    for (const [acc, pkt] of Object.entries(board ?? {})) if (validRelay(pkt) && pkt.deviceGuid === device.name && String(pkt.accountId) === acc) rememberRelay(relays, pkt);
  }
  for (const file of await readdir(root, { withFileTypes: true })) {
    const legacy = /^(?:personal|leaderboard-(\d+))-([a-f0-9-]+)\.json$/.exec(file.name);
    if (!file.isFile() || !legacy || !validInstallationId(legacy[2])) continue;
    const [, account, guid] = legacy, filename = path.join(root, file.name), packet = await readJson(filename).catch(() => null);
    if (packet?.deviceGuid !== guid) continue;
    let name, data;
    if (account === undefined && validPersonal(packet)) { keepLatest(personal, guid, packet); name = 'personal'; data = personal.get(guid); }
    else if (validRelay(packet) && account === String(packet.accountId)) { rememberRelay(relays, packet); name = 'leaderboard'; data = Object.fromEntries(relays.get(guid)); }
    else continue;
    try { await savePacket(cacheFile(root, guid, name), data); await unlink(filename); } catch {}
  }
  return { personal, relays };
}

export async function openRemoteDeviceCache(root) {
  const { personal, relays } = await readRemoteDeviceCache(root), writes = new Map();
  const persist = (guid, name, packet) => {
    const file = cacheFile(root, guid, name);
    const pending = (writes.get(file) ?? Promise.resolve()).then(() => savePacket(file, packet)).catch(() => {})
      .finally(() => { if (writes.get(file) === pending) writes.delete(file); });
    writes.set(file, pending);
  };
  return {
    personal, relays,
    acceptPersonal(p, own) { if (!validPersonal(p) || p.deviceGuid === own || !keepLatest(personal, p.deviceGuid, p)) return false; persist(p.deviceGuid, 'personal', p); return true; },
    acceptLeaderboard(p, own) { if (!validRelay(p) || p.deviceGuid === own || !rememberRelay(relays, p)) return false; persist(p.deviceGuid, 'leaderboard', Object.fromEntries(relays.get(p.deviceGuid))); return true; },
    flush: () => Promise.all(writes.values())
  };
}

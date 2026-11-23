import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { validInstallationId } from './leaderboard-installation.mjs';
import { HOUR_MS } from './leaderboard-stats.mjs';

export const DETAIL_DAYS = 32;
export const RETENTION_DAYS = 370;
const DATABASE_VERSION = 3;
const DAY_MS = 24 * HOUR_MS;
const EMPTY_COUNTERS = () => [0, 0, 0, 0, 0, 0, 0, 0];
const validTime = value => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
const count = value => Number.isFinite(value) && value > 0 ? value : 0;

export function calendarFor(timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', minute: '2-digit', second: '2-digit'
  });
  return {
    timeZone: formatter.resolvedOptions().timeZone,
    day(at) {
      const { year, month, day } = Object.fromEntries(formatter.formatToParts(at).map(({ type, value }) => [type, value]));
      return `${year}-${month}-${day}`;
    },
    dayAgo(at, days) {
      return new Date(Date.parse(this.day(at) + 'T00:00:00Z') - days * DAY_MS).toISOString().slice(0, 10);
    },
    hour(at) {
      const { minute, second } = Object.fromEntries(formatter.formatToParts(at).map(({ type, value }) => [type, value]));
      return at - Number(minute) * 60_000 - Number(second) * 1000 - at % 1000;
    }
  };
}

function openDatabase(filename) {
  const db = new DatabaseSync(filename, { enableExtensionLoading: false });
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF;');
  return db;
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
  const speed = count(record.tokensPerSecond);
  return [1, count(record.freshInputTokens), count(record.outputTokens), count(record.cacheReadTokens),
    count(record.cacheCreationTokens), Number(speed > 0), speed, Number(speed > 0 && !!record.isEstimatedSpeed)];
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
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const guid = readDeviceGuid(root, deviceGuid);
  const main = openDatabase(path.join(root, 'tpslugin.db'));
  const daily = openDatabase(path.join(root, 'daily.db'));
  main.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS scan_progress (source TEXT PRIMARY KEY, stamp TEXT NOT NULL, scanned_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, day TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS seen_day ON seen(day);
    CREATE TABLE IF NOT EXISTS details (id TEXT PRIMARY KEY, day TEXT NOT NULL, at INTEGER NOT NULL, record TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS details_at ON details(at);
    CREATE INDEX IF NOT EXISTS details_day ON details(day);
    CREATE TABLE IF NOT EXISTS pending (id INTEGER PRIMARY KEY AUTOINCREMENT, buckets TEXT NOT NULL);
  `);
  daily.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS buckets (
      kind INTEGER NOT NULL, day TEXT NOT NULL, at INTEGER NOT NULL, project TEXT NOT NULL,
      provider TEXT NOT NULL, model TEXT NOT NULL, counters TEXT NOT NULL,
      PRIMARY KEY (kind, day, at, project, provider, model)
    ) WITHOUT ROWID;
  `);
  const m = prepare(main, {
    setting: 'SELECT value FROM settings WHERE key = ?',
    save: 'INSERT OR REPLACE INTO settings VALUES (?, ?)',
    source: 'SELECT stamp FROM scan_progress WHERE source = ?',
    cursor: 'INSERT OR REPLACE INTO scan_progress VALUES (?, ?, ?)',
    seen: 'SELECT id FROM seen WHERE id = ?',
    remember: 'INSERT OR REPLACE INTO seen VALUES (?, ?)',
    detail: 'SELECT record FROM details WHERE id = ?',
    addDetail: 'INSERT OR REPLACE INTO details VALUES (?, ?, ?, ?)',
    details: 'SELECT record FROM details WHERE at >= ? ORDER BY at DESC, id',
    enqueue: 'INSERT INTO pending(buckets) VALUES (?)',
    pending: 'SELECT id, buckets FROM pending ORDER BY id',
    ack: 'DELETE FROM pending WHERE id <= ?',
    pruneDetails: 'DELETE FROM details WHERE day < ?',
    pruneSeen: 'DELETE FROM seen WHERE day < ?',
    pruneProgress: 'DELETE FROM scan_progress WHERE scanned_at < ?'
  });
  const d = prepare(daily, {
    setting: 'SELECT value FROM settings WHERE key = ?',
    save: 'INSERT OR REPLACE INTO settings VALUES (?, ?)',
    bucket: 'SELECT counters FROM buckets WHERE kind=? AND day=? AND at=? AND project=? AND provider=? AND model=?',
    update: 'INSERT OR REPLACE INTO buckets VALUES (?, ?, ?, ?, ?, ?, ?)',
    remove: 'DELETE FROM buckets WHERE kind=? AND day=? AND at=? AND project=? AND provider=? AND model=?',
    all: 'SELECT * FROM buckets WHERE kind=? AND day>=? ORDER BY day, at, project, provider, model',
    prune: 'DELETE FROM buckets WHERE day < ?'
  });
  const setting = (key, fallback) => {
    const row = m.setting.get(key);
    return row ? JSON.parse(row.value) : fallback;
  };
  const saveSetting = (key, value) => m.save.run(key, JSON.stringify(value));
  let calendar = calendarFor(setting('timeZone', timeZone));

  function reset(next) {
    const generation = randomUUID();
    transaction(main, () => {
      main.exec('DELETE FROM scan_progress; DELETE FROM seen; DELETE FROM details; DELETE FROM pending;');
      saveSetting('timeZone', next.timeZone);
      saveSetting('generation', generation);
      saveSetting('lastScanAt', 0);
    });
    calendar = next;
    transaction(daily, () => {
      daily.exec('DELETE FROM buckets; DELETE FROM settings;');
      d.save.run('generation', generation);
      d.save.run('applied', '0');
    });
  }

  const generation = setting('generation');
  if (!generation || d.setting.get('generation')?.value !== generation || setting('version') !== DATABASE_VERSION) {
    reset(calendar);
    saveSetting('version', DATABASE_VERSION);
  }
  saveSetting('deviceGuid', guid);

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
      for (const record of records) {
        if (!record || !validTime(record.completedAt) || typeof record.id !== 'string' || !record.id ||
            typeof record.provider !== 'string' || !record.provider) continue;
        const day = calendar.day(record.completedAt);
        if (day < firstDay || day > calendar.day(at)) continue;
        const id = JSON.stringify([record.provider, ...(record.provider === 'antigravity' ? [record.sessionId ?? ''] : []), record.id]);
        const previous = m.detail.get(id);
        const body = day >= detailDay ? JSON.stringify(record) : null;
        if (previous?.record === body || (!previous && m.seen.get(id))) continue;
        if (previous) addBucket(buckets, calendar, JSON.parse(previous.record), -1);
        m.remember.run(id, day);
        if (body) m.addDetail.run(id, day, record.completedAt, body);
        addBucket(buckets, calendar, record, 1);
      }
      if (buckets.size) m.enqueue.run(JSON.stringify([...buckets]));
      if (stamp !== null) m.cursor.run(source, stamp, at);
    });
  }

  function applyPending(onApplied) {
    const pending = m.pending.all();
    let applied = Number(d.setting.get('applied').value);
    for (const batch of pending) {
      if (batch.id <= applied) continue;
      transaction(daily, () => {
        for (const [key, delta] of JSON.parse(batch.buckets)) {
          const dimensions = JSON.parse(key);
          const row = d.bucket.get(...dimensions);
          const current = row ? JSON.parse(row.counters) : EMPTY_COUNTERS();
          const counters = current.map((value, index) => value + delta[index]);
          if (counters[0] > 0) d.update.run(...dimensions, JSON.stringify(counters));
          else d.remove.run(...dimensions);
        }
        d.save.run('applied', String(batch.id));
      });
      applied = batch.id;
      onApplied?.(batch.id);
    }
    m.ack.run(applied);
  }

  function finishScan(at = now()) {
    applyPending();
    const firstDay = calendar.dayAgo(at, RETENTION_DAYS - 1);
    d.prune.run(firstDay);
    transaction(main, () => {
      m.pruneSeen.run(firstDay);
      m.pruneDetails.run(calendar.dayAgo(at, DETAIL_DAYS - 1));
      m.pruneProgress.run(Date.parse(firstDay + 'T00:00:00Z') - DAY_MS);
      saveSetting('lastScanAt', at);
      saveSetting('lastScanError', null);
    });
  }

  return {
    deviceGuid: guid, get calendar() { return calendar; }, setting, saveSetting, setTimeZone,
    sourceStamp: source => m.source.get(source)?.stamp,
    commitSource, applyPending, finishScan,
    details: (from = 0) => m.details.all(from).map(row => JSON.parse(row.record)),
    buckets: (kind, from = '') => d.all.all(kind, from).map(({ kind, counters, ...dimensions }) => ({
      ...dimensions, counters: JSON.parse(counters)
    })),
    close() { daily.close(); main.close(); }
  };
}

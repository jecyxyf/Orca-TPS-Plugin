import { sourceMessage } from './locales.mjs';
import { createHash } from 'node:crypto';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { reportDiscoveryError } from './data-paths.mjs';
import { buildHermesRecord, recentRecords } from './parsers.mjs';

const LOG_NAME = /^agent\.log(?:\.[1-9]\d*)?$/;
const CALL = /^(?<date>\d{4}-\d{2}-\d{2}) (?<time>\d{2}:\d{2}:\d{2}),(?<ms>\d{3}) INFO \[(?<session>[^\s\]]+)\] agent\.conversation_loop: API call #(?<number>\d+): model=(?<model>\S+) provider=(?<provider>\S+) in=(?<input>\d+) out=(?<output>\d+) total=\d+ latency=(?<seconds>\d+(?:\.\d+)?)s(?<details>\s.*)?$/;
const MAX_LOG_BYTES = 64 * 1024 * 1024;
const LOG_CHUNK_BYTES = 256 * 1024;
const ANCHOR_BYTES = 256;
const MAX_PARTIAL_BYTES = 64 * 1024;
const MAX_CATALOGUE_ROWS = 2_000;
const logCache = new Map(), pendingLogs = new Map(), catalogues = new Map();
const empty = Buffer.alloc(0);
const originalTZ = process.env.TZ;
// The SSH usage reader sets TZ to the desktop zone for day buckets. Hermes log
// timestamps still refer to the source host's wall clock.
const logTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const offsetFormat = new Intl.DateTimeFormat('en', { timeZone: logTimeZone, timeZoneName: 'longOffset' });

async function info(file) {
  try { return await stat(file); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

const identity = meta => [meta.dev, meta.ino, meta.birthtimeMs].join(':');
const stamp = meta => [identity(meta), meta.size, meta.mtimeMs, meta.ctimeMs].join(':');

function remember(cache, key, value, limit = 64) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) cache.delete(cache.keys().next().value);
}

function rememberLog(key, entry) {
  remember(logCache, key, entry);
  let bytes = 0;
  for (const [olderKey, older] of [...logCache].reverse()) {
    bytes += older.offset;
    if (bytes > MAX_LOG_BYTES) logCache.delete(olderKey);
  }
}

function zoneOffset(at) {
  const formatted = offsetFormat.formatToParts(at).find(part => part.type === 'timeZoneName')?.value;
  const match = /^GMT([+-])(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(formatted ?? '');
  if (!match) return 0;
  const [, sign, hours, minutes, seconds = 0] = match;
  return (sign === '-' ? -1 : 1) * (Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000;
}

function parseCall(line) {
  const call = CALL.exec(line)?.groups;
  if (!call || call.session.length > 256) return null;
  const wallTime = `${call.date}T${call.time}.${call.ms}`;
  let completedAt = Date.parse(wallTime);
  if (!Number.isFinite(completedAt)) return null;
  if (process.env.TZ !== originalTZ) {
    const utc = Date.parse(wallTime + 'Z');
    completedAt = utc - zoneOffset(utc - zoneOffset(utc));
  }
  const inputTokens = Number(call.input), outputTokens = Number(call.output);
  if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens)) return null;
  const cache = /(?:^|\s)cache=(\d+)\/(\d+)/.exec(call.details ?? '');
  const write = /(?:^|\s)write=(\d+)(?=\s|$)/.exec(call.details ?? '');
  const readTokens = Number(cache?.[1] ?? 0), writeTokens = Number(write?.[1] ?? 0);
  const cacheValid = Number.isSafeInteger(readTokens) && Number.isSafeInteger(writeTokens) && readTokens + writeTokens <= inputTokens;
  const responseId = /(?:^|\s)id=(\S{1,256})(?=\s|$)/.exec(call.details ?? '')?.[1];
  // Include the timestamp when there is no response ID, because a resumed
  // process can restart its call counter for the same session.
  const key = [call.session, call.provider, responseId || `${wallTime}:${call.number}:${call.model}`];
  const id = createHash('sha256').update(JSON.stringify(key)).digest('hex').slice(0, 24);
  return {
    ...buildHermesRecord({
      id: 'hermes:' + id, completedAt, model: call.model, inputTokens, outputTokens,
      durationMs: Math.round(Number(call.seconds) * 1000),
      cacheReadTokens: cacheValid ? readTokens : 0, cacheCreationTokens: cacheValid ? writeTokens : 0,
      cacheReported: cacheValid && Boolean(cache)
    }),
    sessionId: call.session
  };
}

async function readAnchor(file, offset) {
  const buffer = Buffer.alloc(Math.min(ANCHOR_BYTES, offset));
  const { bytesRead } = await file.read(buffer, 0, buffer.length, offset - buffer.length);
  return buffer.subarray(0, bytesRead);
}

async function indexLog(filename, pace) {
  const file = await open(filename, 'r');
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > MAX_LOG_BYTES) throw new Error(sourceMessage('notice.hermes-log-size'));
    const key = identity(metadata), version = stamp(metadata), original = logCache.get(key);
    if (original?.version === version) {
      rememberLog(key, original);
      return original.records;
    }
    const old = original && metadata.size > original.offset &&
      (await readAnchor(file, original.offset)).equals(original.anchor) ? original : null;
    let offset = old?.offset ?? 0, tail = old?.tail ?? empty;
    const records = [], chunk = Buffer.alloc(LOG_CHUNK_BYTES);
    while (offset < metadata.size) {
      const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, metadata.size - offset), offset);
      if (!bytesRead) throw new Error(sourceMessage('notice.hermes-log-changed'));
      const bytes = Buffer.concat([tail, chunk.subarray(0, bytesRead)]);
      const last = bytes.lastIndexOf(10);
      if (last >= 0) {
        for (const line of bytes.subarray(0, last).toString('utf8').split(/\r?\n/)) {
          const record = parseCall(line.replace(/\r$/, ''));
          if (record) records.push(record);
        }
      }
      const partial = bytes.subarray(last + 1);
      tail = partial.length <= MAX_PARTIAL_BYTES ? Buffer.from(partial) : empty;
      offset += bytesRead;
      if (pace) await pace(bytesRead);
    }
    const entry = { version, offset, tail, anchor: await readAnchor(file, offset), records: old ? old.records.concat(records) : records };
    rememberLog(key, entry);
    return entry.records;
  } finally { await file.close(); }
}

function readLog(file, pace) {
  if (pendingLogs.has(file)) return pendingLogs.get(file);
  const task = indexLog(file, pace).finally(() => pendingLogs.delete(file));
  pendingLogs.set(file, task);
  return task;
}

async function entries(dir) {
  try { return await readdir(dir, { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw error;
  }
}

async function readSources(root, cutoffMs) {
  const dir = path.join(root, 'logs');
  const files = [];
  for (const entry of await entries(dir)) {
    if (!entry.isFile() || !LOG_NAME.test(entry.name)) continue;
    const file = path.join(dir, entry.name), metadata = await info(file);
    if (metadata?.isFile() && metadata.mtimeMs >= cutoffMs) files.push({ file, metadata });
  }
  if (!files.length) return null;
  files.sort((a, b) => a.file.localeCompare(b.file));
  return {
    root, files: files.map(entry => entry.file),
    bytes: files.reduce((sum, entry) => sum + entry.metadata.size, 0),
    mtimeMs: Math.max(...files.map(entry => entry.metadata.mtimeMs)),
    stamp: files.map(entry => `${path.basename(entry.file)}:${stamp(entry.metadata)}`).join('|')
  };
}

export async function hermesSources(roots, cutoffMs = 0, warnings, onUnavailable) {
  const profiles = new Set();
  const warn = () => {
    warnings?.add(sourceMessage('notice.hermes-folder-unavailable'));
    onUnavailable?.();
  };
  for (const root of roots.slice(0, 100)) {
    const home = await realpath(root).catch(error => { reportDiscoveryError(error, warn); return null; });
    if (!home) continue;
    profiles.add(home);
    const directory = path.join(home, 'profiles');
    const children = await entries(directory).catch(() => { warn(); return []; });
    for (const profile of children.filter(entry => entry.isDirectory()).slice(0, 100)) profiles.add(path.join(directory, profile.name));
  }
  const sources = [];
  for (const root of profiles) {
    const source = await readSources(root, cutoffMs).catch(() => { warn(); return null; });
    if (source) sources.push(source);
  }
  return sources;
}

export async function readHermesRecords(source, { pace, includeCwd = false } = {}) {
  if (source.bytes > MAX_LOG_BYTES) throw new Error(sourceMessage('notice.hermes-log-size'));
  const records = new Map();
  for (const file of source.files) {
    for (const record of await readLog(file, pace)) records.set(record.id, record);
  }
  if (!includeCwd) return [...records.values()];
  const metadata = new Map((await sessionCatalogue(source.root)).map(row => [row.id, row.cwd]));
  return [...records.values()].map(record => ({ ...record, cwd: metadata.get(record.sessionId) }));
}

async function sessionCatalogue(root) {
  const file = path.join(root, 'state.db');
  const metadata = await info(file);
  if (!metadata?.isFile()) return [];
  const wal = await info(file + '-wal');
  const version = stamp(metadata) + ':' + (wal ? stamp(wal) : '');
  const cached = catalogues.get(file);
  if (cached?.version === version) return cached.rows;
  let db;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(file, { readOnly: true, enableExtensionLoading: false });
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=100;');
    const columns = new Set(db.prepare('PRAGMA table_info(sessions)').all().map(row => row.name));
    if (!columns.has('id')) return [];
    const cwd = columns.has('cwd') ? 'cwd' : 'NULL AS cwd';
    const source = columns.has('source') ? 'source' : 'NULL AS source';
    const order = columns.has('started_at') ? 'ORDER BY started_at DESC' : '';
    const rows = db.prepare(`SELECT id, ${cwd}, ${source} FROM sessions ${order} LIMIT ?`).all(MAX_CATALOGUE_ROWS);
    remember(catalogues, file, { version, rows });
    return rows;
  } catch { return cached?.rows ?? []; }
  finally { db?.close(); }
}

export async function readHermesSessions(roots, { sessionIds = [], worktree, comparePath, warnings }) {
  const byId = new Map();
  for (const source of await hermesSources(roots, 0, warnings)) {
    try {
      const metadata = new Map((await sessionCatalogue(source.root)).map(row => [row.id, row]));
      const selected = new Set(sessionIds);
      if (worktree) for (const row of metadata.values()) {
        if (comparePath(row.cwd) === worktree) selected.add(row.id);
      }
      if (!selected.size) continue;
      for (const { sessionId, ...record } of await readHermesRecords(source)) {
        if (!selected.has(sessionId)) continue;
        const records = byId.get(sessionId) ?? [];
        if (metadata.get(sessionId)?.source === 'subagent') record.isSubagent = true;
        records.push(record);
        byId.set(sessionId, records);
      }
    } catch {
      warnings.add(sourceMessage('notice.hermes-log-unavailable'));
    }
  }
  return [...byId].map(([sessionId, records]) => {
    const latest = recentRecords(records);
    return { id: 'hermes:' + sessionId, title: 'Hermes Agent', provider: 'hermes', updatedAt: latest[0].completedAt, records: latest };
  });
}

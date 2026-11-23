import { sourceMessage } from './locales.mjs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { createReadStream, watch } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setImmediate as yieldToRequests, setTimeout as delay } from 'node:timers/promises';
import { configuredRoots, defaultRoots, reportDiscoveryError } from './data-paths.mjs';
import {
  SESSION_PROXY_DEDUP_WINDOW_SECONDS,
  antigravityNativeTimings,
  createCodexParser,
  createJsonlCursor,
  antigravitySessionIdFromPath,
  antigravityStepStart,
  antigravityWorkspacePaths,
  mergeChannelProxyRecords,
  mergeProxyRecords,
  parseOpenCodeRows,
  readJsonlMetadata,
  recentRecords
} from './parsers.mjs';
import { BACKFILL_BYTES, HISTORY_DAYS, accumulateRecords, dayKeyAgo, leaderboardDayStart, leaderboardUsageTimesFrom, trimRecentRequests } from './usage-summary.mjs';
import { RECENT_STATS_MS } from './leaderboard-stats.mjs';
import { hermesSources, readHermesRecords, readHermesSessions } from './hermes.mjs';

const MAX_FILES = 1500, MAX_DIRECTORIES = 500, MAX_DEPTH = 8, MAX_SUBAGENT_FILES = 200;
const MAX_FILE_BYTES = 16 * 1024 * 1024, MAX_SCAN_BYTES = 64 * 1024 * 1024, MAX_HEADER_BYTES = 262_144;
const CURSOR_ANCHOR_BYTES = 256;
const parseCache = new Map(), headerCache = new Map(), discoveryCache = new Map(), databaseCache = new Map(), locationCache = new Map(), ccSwitchCache = new Map();
const pendingJsonl = new Map();
const databaseRows = new Map();
const antigravityWorkspaces = new Map();
const skippedDirectories = new Set(['node_modules', '.git', 'subagents', 'cache', 'plugins', 'skills', 'auth', 'credentials']);
const shortError = error => typeof error?.code === 'string' ? error.code : sourceMessage('notice.read-failed');
const identity = value => createHash('sha256').update(value).digest('hex').slice(0, 24);
const safeTitle = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200) : '';
const safeSegment = value => typeof value === 'string' && value.length > 0 && value.length <= 256 &&
  value !== '.' && value !== '..' && !/[\\/\u0000]/.test(value);

function trimCache(cache, limit = 200) {
  while (cache.size > limit) cache.delete(cache.keys().next().value);
}

export function normalizeComparePath(rawPath, platform = process.platform) {
  if (typeof rawPath !== 'string') return null;
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.length > 4096 || /[\u0000\r\n]/.test(trimmed)) return null;
  const isWin = platform === 'win32' || /^[A-Za-z]:[\\/]/.test(trimmed);
  if (isWin) {
    const leadingUnc = /^[/\\]{2}/.test(trimmed) ? '\\\\' : '';
    let body = trimmed.replace(/^[/\\]+/, '').replace(/[/\\]+/g, '\\').replace(/\\+$/, '');
    const full = (leadingUnc + body).toLowerCase();
    return /^[a-z]:$/.test(full) ? `${full}\\` : full;
  }
  let norm = trimmed.replace(/\/+/g, '/');
  if (norm.length > 1) norm = norm.replace(/\/+$/, '');
  return norm;
}

function replayWarnings(warnings, cached) {
  for (const warning of cached?.warnings ?? []) warnings.add(warning);
}

async function info(file, onUnavailable) {
  try { return await stat(file); }
  catch (error) { reportDiscoveryError(error, onUnavailable); return null; }
}

/**
 * Antigravity keeps brain/<conversation-id>/.system_generated/logs/ with the live transcript plus rotated
 * copies. Only the transcript is read; a recursive walk over the whole brain tree would hit directory limits.
 */
async function discoverAntigravityTranscripts(root, sourceWarnings) {
  const files = [];
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { sourceWarnings.add(sourceMessage('notice.antigravity-partial-scan', shortError(error))); return files; }
  for (const entry of entries) {
    if (files.length >= MAX_FILES) { sourceWarnings.add(sourceMessage('notice.antigravity-scan-limit')); break; }
    if (!entry.isDirectory() || !safeSegment(entry.name)) continue;
    const file = path.join(root, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
    if ((await info(file))?.isFile()) files.push(file);
  }
  return files;
}

async function discover(provider, root, warnings, { maxAgeMs = 20_000 } = {}) {
  const key = `${provider}:${root}`, cached = discoveryCache.get(key);
  if (maxAgeMs > 0 && cached && Date.now() - cached.at < maxAgeMs) {
    replayWarnings(warnings, cached);
    return cached.files;
  }
  if (root === path.parse(root).root || root === homedir()) {
    warnings.add(sourceMessage('notice.invalid-session-folder', provider));
    return [];
  }
  const rootStat = await info(root);
  if (!rootStat) return [];
  if (provider === 'antigravity' && rootStat.isDirectory()) {
    const sourceWarnings = new Set();
    const files = await discoverAntigravityTranscripts(root, sourceWarnings);
    const result = { at: Date.now(), files, warnings: [...sourceWarnings] };
    replayWarnings(warnings, result);
    discoveryCache.set(key, result); trimCache(discoveryCache);
    return files;
  }
  const files = [], queue = [{ directory: root, depth: 0 }], sourceWarnings = new Set();
  let visited = 0, limited = false;
  const matches = file => provider === 'opencode' ? /\.(?:db|sqlite|sqlite3)$/i.test(file) : /\.jsonl$/i.test(file);
  if (rootStat.isFile()) return matches(root) ? [root] : [];
  const seen = new Set();
  while (queue.length && files.length < MAX_FILES && visited < MAX_DIRECTORIES) {
    const { directory, depth } = queue.pop();
    visited++;
    let entries;
    try {
      const canonical = await realpath(directory);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) { sourceWarnings.add(sourceMessage('notice.partial-session-scan', provider, shortError(error))); continue; }
    entries.sort((a, b) => b.name.localeCompare(a.name));
    const children = [];
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isFile() && matches(entry.name)) {
        files.push(file);
        if (files.length >= MAX_FILES) { limited = true; break; }
      } else if (entry.isDirectory() && !skippedDirectories.has(entry.name.toLowerCase())) {
        if (depth < MAX_DEPTH) children.push({ directory: file, depth: depth + 1 });
        else limited = true;
      }
    }
    // The stack visits recent date-named folders before older history.
    queue.push(...children.reverse());
  }
  limited ||= queue.length > 0;
  if (limited) sourceWarnings.add(sourceMessage('notice.session-scan-limit', provider));
  const result = { at: Date.now(), files, warnings: [...sourceWarnings] };
  replayWarnings(warnings, result);
  discoveryCache.set(key, result); trimCache(discoveryCache);
  return files;
}

/** conversations/<conversation-id>.db sits beside brain/ in the same Antigravity root. */
function antigravityNativeDbPath(transcriptPath) {
  const sessionId = antigravitySessionIdFromPath(transcriptPath);
  if (!sessionId || !safeSegment(sessionId)) return null;
  const brainDir = path.dirname(path.dirname(path.dirname(path.dirname(transcriptPath))));
  if (path.basename(brainDir) !== 'brain') return null;
  return path.join(path.dirname(brainDir), 'conversations', `${sessionId}.db`);
}

async function antigravityNativeStamp(transcriptPath) {
  const dbPath = antigravityNativeDbPath(transcriptPath);
  const database = dbPath ? await info(dbPath) : null;
  if (!database?.isFile()) return 'native:none';
  const wal = await info(`${dbPath}-wal`);
  return 'native:' + fileStamp(database) + ':' + (wal ? fileStamp(wal) : '');
}

async function antigravityWorkspace(transcriptPath, platform) {
  const dbPath = antigravityNativeDbPath(transcriptPath);
  if (!dbPath) return null;
  const stamp = await antigravityNativeStamp(transcriptPath);
  if (stamp === 'native:none') return null;
  const key = dbPath + ':' + platform, cached = antigravityWorkspaces.get(key);
  if (cached?.stamp === stamp) return cached.workspace;
  let db;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(dbPath, { readOnly: true, enableExtensionLoading: false });
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=100; PRAGMA trusted_schema=OFF;');
    const row = tables(db).has('trajectory_metadata_blob')
      ? db.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main' AND length(data) <= 262144").get()
      : null;
    const win = platform === 'win32', pathApi = win ? path.win32 : path.posix;
    const candidates = antigravityWorkspacePaths(row?.data);
    let workspace = null;
    for (const candidate of candidates) {
      let directory;
      try { directory = candidate.startsWith('file:') ? fileURLToPath(candidate, { windows: win }) : candidate; }
      catch { continue; }
      if (pathApi.isAbsolute(directory)) {
        workspace = normalizeComparePath(directory, platform);
        if (workspace) break;
      }
    }
    antigravityWorkspaces.set(key, { stamp, workspace });
    trimCache(antigravityWorkspaces, 2000);
    return workspace;
  } finally { db?.close(); }
}

/** Read-only: model-response step metadata and generation metadata only; step payloads are never opened. */
async function readAntigravityTimings(transcriptPath, note) {
  const dbPath = antigravityNativeDbPath(transcriptPath);
  const database = dbPath ? await info(dbPath) : null;
  if (!database?.isFile()) return new Map();
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); }
  catch { note(sourceMessage('notice.antigravity-no-sqlite')); return new Map(); }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, enableExtensionLoading: false });
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=500; PRAGMA trusted_schema=OFF;');
    const steps = db.prepare('SELECT idx, metadata FROM steps WHERE step_type = 15').all();
    const generationQuery = db.prepare('SELECT data FROM gen_metadata WHERE idx = ?');
    const generations = new Map();
    for (const step of steps) {
      const index = antigravityStepStart(step.metadata)?.generationIndex;
      if (index === null || index === undefined || generations.has(index)) continue;
      const row = generationQuery.get(index);
      if (row?.data) generations.set(index, row.data);
    }
    return antigravityNativeTimings(steps, generations);
  } catch (error) {
    note(sourceMessage('notice.antigravity-database-unavailable', shortError(error)));
    return new Map();
  } finally { db?.close(); }
}

const fileIdentity = meta => [meta.dev, meta.ino, meta.birthtimeMs].join(':');
const fileStamp = meta => [fileIdentity(meta), meta.size, meta.mtimeMs, meta.ctimeMs].join(':');

async function readAt(file, start, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await file.read(buffer, 0, length, start);
  return buffer.subarray(0, bytesRead);
}

async function anchorAt(file, start, length) {
  const bytes = await readAt(file, start, length);
  return bytes.length === length ? createHash('sha256').update(bytes).digest('hex') : null;
}

async function writeAnchors(file, offset) {
  const length = Math.min(CURSOR_ANCHOR_BYTES, offset);
  if (!length) return [];
  const positions = [...new Set([0, offset - length])];
  return Promise.all(positions.map(async start => ({ start, length, hash: await anchorAt(file, start, length) })));
}

async function matchAnchors(file, anchors, budget) {
  if (!anchors?.length) return false;
  for (const { start, length, hash } of anchors) {
    if (!hash || budget.remaining < length) return false;
    budget.remaining -= length;
    if (await anchorAt(file, start, length) !== hash) return false;
  }
  return true;
}

function readJsonl(candidate, budget, warnings, expectedSessionId, { isSubagent = false } = {}) {
  const key = `${candidate.provider}:${candidate.path}:${isSubagent ? 'sub' : 'main'}`;
  // Different projects can discover the same log. Only one read may advance its parser.
  const pending = pendingJsonl.get(key);
  const result = (async () => {
    if (pending) {
      await pending.catch(() => {});
      const current = await info(candidate.path);
      if (!current?.isFile()) return null;
      candidate = { ...candidate, info: current };
    }
    return advanceJsonl(key, candidate, budget, warnings, expectedSessionId, isSubagent);
  })();
  pendingJsonl.set(key, result);
  return result.finally(() => { if (pendingJsonl.get(key) === result) pendingJsonl.delete(key); });
}

async function advanceJsonl(key, candidate, budget, warnings, expectedSessionId, isSubagent) {
  const sourceStamp = fileStamp(candidate.info);
  const nativeStamp = candidate.provider === 'antigravity' ? await antigravityNativeStamp(candidate.path) : '';
  const stamp = sourceStamp + ':' + nativeStamp;
  const cached = parseCache.get(key);
  const matches = result => {
    if (expectedSessionId === undefined) return true;
    if (isSubagent && !result?.sourceSessionId) return true;
    return result?.sourceSessionId === expectedSessionId;
  };
  if (cached?.stamp === stamp) { replayWarnings(warnings, cached); return matches(cached) ? cached.session : null; }
  const retained = () => {
    warnings.add(sourceMessage('notice.read-size-limit'));
    replayWarnings(warnings, cached);
    return matches(cached) ? cached?.session ?? null : null;
  };
  let file;
  try {
    const sourceWarnings = [];
    let cursor = cached?.cursor, nextOffset = cached?.nextOffset ?? 0, anchors = cached?.anchors;
    let startOffset = cached?.startOffset ?? 0;
    if (cached?.sourceStamp !== sourceStamp) {
      file = await open(candidate.path, 'r');
      const opened = await file.stat();
      if (fileIdentity(opened) !== fileIdentity(candidate.info) || opened.size < candidate.info.size) {
        throw Object.assign(new Error('Log changed while opening'), { code: 'EAGAIN' });
      }
      const size = candidate.info.size;
      const append = cursor && nextOffset > startOffset && (cursor.sessionId || isSubagent) &&
        cached.identity === fileIdentity(candidate.info) &&
        size > cached.size && size - nextOffset <= MAX_FILE_BYTES && size - startOffset <= MAX_SCAN_BYTES &&
        await matchAnchors(file, anchors, budget);
      const offset = append ? nextOffset : Math.max(0, size - MAX_FILE_BYTES);
      const bytes = size - offset;
      if (bytes > budget.remaining) return retained();
      budget.remaining -= bytes;
      const buffer = await readAt(file, offset, bytes);
      if (buffer.length !== bytes) throw Object.assign(new Error('Log truncated while reading'), { code: 'EAGAIN' });
      const end = buffer.lastIndexOf(10) + 1;
      let begin = 0, header = '';
      if (!append && offset > 0) {
        const firstLine = buffer.indexOf(10);
        begin = firstLine < 0 ? end : firstLine + 1;
        header = (await readAt(file, 0, Math.min(MAX_HEADER_BYTES, size))).toString('utf8');
      }
      const complete = buffer.subarray(begin, end).toString('utf8');
      nextOffset = offset + end;
      anchors = await writeAnchors(file, nextOffset);
      if (append) cursor.feed(complete);
      else {
        startOffset = offset;
        cursor = createJsonlCursor(complete, candidate.provider, header, {
          truncated: offset > 0, isSubagent,
          sessionId: candidate.provider === 'antigravity' ? antigravitySessionIdFromPath(candidate.path) : undefined
        });
      }
    }
    if (startOffset > 0) {
      sourceWarnings.push(sourceMessage('notice.large-session', candidate.provider));
    }
    const native = candidate.provider === 'antigravity'
      ? await readAntigravityTimings(candidate.path, message => sourceWarnings.push(message))
      : undefined;
    const sessionId = cursor.sessionId || path.basename(candidate.path, '.jsonl');
    const session = { id: `${candidate.provider}:${sessionId || identity(candidate.path)}`,
      title: `${candidate.provider} · ${sessionId.slice(-20)}`, provider: candidate.provider,
      path: candidate.path, updatedAt: candidate.info.mtimeMs, records: cursor.finish(native),
      ...(cursor.cwd ? { cwd: cursor.cwd } : {}) };
    const result = { stamp, sourceStamp, identity: fileIdentity(candidate.info), size: candidate.info.size,
      cursor, nextOffset, anchors, startOffset, session, sourceSessionId: cursor.sessionId, warnings: sourceWarnings };
    replayWarnings(warnings, result);
    parseCache.set(key, result); trimCache(parseCache);
    return matches(result) ? session : null;
  } catch (error) {
    // A mutable cursor may have advanced before a source read failed.
    parseCache.delete(key);
    throw error;
  } finally { await file?.close(); }
}

/** Collect Claude subagent JSONL files at fixed depths matching CC Switch's collect_jsonl_files. */
async function collectClaudeSubagentCandidates(mainPath, sessionId, onUnavailable) {
  if (!safeSegment(sessionId)) return [];
  const subagentsDir = path.join(path.dirname(mainPath), sessionId, 'subagents');
  const dirStat = await info(subagentsDir, onUnavailable);
  if (!dirStat?.isDirectory()) return [];

  const paths = [];
  try {
    const entries = await readdir(subagentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && /\.jsonl$/i.test(entry.name)) {
        paths.push(path.join(subagentsDir, entry.name));
      } else if (entry.isDirectory() && entry.name === 'workflows') {
        const workflowsDir = path.join(subagentsDir, 'workflows');
        let wfDirs = [];
        try { wfDirs = await readdir(workflowsDir, { withFileTypes: true }); }
        catch (error) { reportDiscoveryError(error, onUnavailable); }
        for (const wfEntry of wfDirs.slice(0, 50)) {
          if (!wfEntry.isDirectory()) continue;
          const wfPath = path.join(workflowsDir, wfEntry.name);
          let wfFiles = [];
          try { wfFiles = await readdir(wfPath, { withFileTypes: true }); }
          catch (error) { reportDiscoveryError(error, onUnavailable); }
          for (const f of wfFiles) {
            if (f.isFile() && /\.jsonl$/i.test(f.name)) paths.push(path.join(wfPath, f.name));
          }
        }
      }
    }
  } catch (error) { reportDiscoveryError(error, onUnavailable); return []; }

  const candidates = [];
  const seen = new Set();
  for (const file of paths) {
    const candidate = await candidateFor('claude', file, onUnavailable);
    if (!candidate || seen.has(candidate.path)) continue;
    seen.add(candidate.path);
    candidates.push(candidate);
  }
  candidates.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
  return candidates.slice(0, MAX_SUBAGENT_FILES);
}

async function attachClaudeSubagents(session, rawSessionId, budget, warnings) {
  if (!session || session.provider !== 'claude' || !rawSessionId) return session;
  const subCandidates = await collectClaudeSubagentCandidates(session.path, rawSessionId);
  if (!subCandidates.length) return session;
  const allRecords = [...session.records];
  let maxUpdated = session.updatedAt;
  for (const sub of subCandidates) {
    try {
      const subSession = await readJsonl(sub, budget, warnings, rawSessionId, { isSubagent: true });
      if (subSession?.records?.length) {
        allRecords.push(...subSession.records);
        if (sub.info.mtimeMs > maxUpdated) maxUpdated = sub.info.mtimeMs;
      }
    } catch (error) {
      warnings.add(sourceMessage('notice.claude-subagent-unavailable', shortError(error)));
    }
  }
  return { ...session, updatedAt: maxUpdated, records: recentRecords(allRecords) };
}

const columns = (db, table) => new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map(row => row.name));
const tables = db => new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));

function projectedData() {
  return `CASE WHEN json_valid(data) THEN json_object(
    'role',json_extract(data,'$.role'), 'tokens',json_extract(data,'$.tokens'),
    'time',json_extract(data,'$.time'), 'model',json_extract(data,'$.model'),
    'modelID',json_extract(data,'$.modelID'), 'modelId',json_extract(data,'$.modelId'),
    'finish',json_extract(data,'$.finish'), 'status',json_extract(data,'$.status')) ELSE '{}' END AS data`;
}

function readOpenCodeRecords(db, database, provider, table, v2, columns, sessionId) {
  const orderColumn = v2 ? 'seq' : 'rowid';
  const type = v2 ? 'type' : 'NULL AS type';
  const fields = `id,${type},time_created,${projectedData()}`;
  const scope = `FROM ${table} WHERE session_id=?`;
  const window = `ORDER BY ${orderColumn} DESC LIMIT 10001`;
  const rows = () => db.prepare(`SELECT ${fields} ${scope} ${window}`).all(sessionId);
  if (!columns.has('time_updated')) {
    const batch = rows();
    const truncated = batch.length > 10_000;
    return { truncated, records: parseOpenCodeRows(batch.slice(0, 10_000).reverse(), v2) };
  }

  const key = JSON.stringify([database.path, fileIdentity(database.info), provider, sessionId]);
  const previous = databaseRows.get(key);
  const marks = db.prepare(`SELECT id,${type},time_created,time_updated,${orderColumn} AS position ${scope} ${window}`).all(sessionId);
  const truncated = marks.length > 10_000;
  if (truncated) marks.pop();
  const signatures = marks.map(row => JSON.stringify([row.type, row.time_created, row.time_updated, row.position]));
  const changed = previous ? marks.filter((row, index) => index < 8 || row.time_updated == null ||
    previous.get(row.id)?.signature !== signatures[index]) : marks;
  let fresh;
  if (previous && changed.length <= 64 && changed.length < marks.length) {
    const row = db.prepare(`SELECT ${fields} ${scope} AND id=?`);
    fresh = new Map(changed.map(item => [item.id, row.get(sessionId, item.id)]));
  } else {
    fresh = new Map(rows().slice(0, 10_000).map(row => [row.id, row]));
  }
  const next = new Map();
  for (let index = 0; index < marks.length; index++) {
    const { id } = marks[index];
    const row = fresh.get(id) ?? previous?.get(id)?.row;
    if (row) next.set(id, { signature: signatures[index], row });
  }
  databaseRows.delete(key);
  databaseRows.set(key, next);
  trimCache(databaseRows, 16);
  return { truncated, records: parseOpenCodeRows([...next.values()].reverse().map(item => item.row), v2) };
}

async function readDatabase(candidate, maxSessions, warnings, target) {
  const wal = await info(`${candidate.path}-wal`);
  const stamp = [fileStamp(candidate.info), wal ? fileStamp(wal) : '', maxSessions].join(':');
  const cacheKey = target?.cwdFilter
    ? JSON.stringify([candidate.path, 'cwd', target.cwdFilter, target.platform || ''])
    : target ? JSON.stringify([candidate.path, target.provider, target.sessionId]) : candidate.path;
  const cached = databaseCache.get(cacheKey);
  if (cached?.stamp === stamp) { replayWarnings(warnings, cached); return cached.sessions; }
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); }
  catch { warnings.add(sourceMessage('notice.opencode-no-sqlite')); return []; }
  let db;
  try {
    db = new DatabaseSync(candidate.path, { readOnly: true, enableExtensionLoading: false });
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; PRAGMA trusted_schema=OFF; BEGIN;');
    const available = tables(db), sessions = [], seen = new Set(), sourceWarnings = new Set();
    for (const v2 of [true, false]) {
      if (target && !target.cwdFilter && (target.provider === 'opencode2') !== v2) continue;
      const table = v2 ? 'session_v2' : 'session', messageTable = v2 ? 'session_message' : 'message';
      if (!available.has(table) || !available.has(messageTable)) continue;
      const sessionColumns = columns(db, table), messageColumns = columns(db, messageTable);
      if (!['id'].every(key => sessionColumns.has(key)) || !['id', 'session_id', 'data', 'time_created'].every(key => messageColumns.has(key))) continue;
      if (v2 && !['seq', 'type'].every(key => messageColumns.has(key))) continue;
      if (target?.cwdFilter && !sessionColumns.has('directory')) continue;
      const select = column => sessionColumns.has(column) ? `"${column}"` : `NULL AS "${column}"`;
      const order = sessionColumns.has('time_updated') ? 'time_updated DESC' : 'id DESC';
      const parentFilter = sessionColumns.has('parent_id') ? "WHERE parent_id IS NULL OR parent_id = ''" : '';
      const selection = `SELECT id,${select('title')},${select('directory')},${select('time_updated')} FROM ${table}`;
      let metadata;
      if (target?.cwdFilter) {
        metadata = [];
        // Limit matching sessions, not unrelated projects; iteration bounds retained metadata.
        for (const meta of db.prepare(`${selection} ${parentFilter} ORDER BY ${order}`).iterate()) {
          if (typeof meta.directory !== 'string' || normalizeComparePath(meta.directory, target.platform) !== target.cwdFilter) continue;
          metadata.push(meta);
          if (metadata.length >= maxSessions) break;
        }
      } else if (target) {
        metadata = db.prepare(`${selection} WHERE id=?`).all(target.sessionId);
      } else {
        metadata = db.prepare(`${selection} ${parentFilter} ORDER BY ${order} LIMIT ?`).all(maxSessions);
      }
      for (const meta of metadata) {
        if (seen.has(meta.id)) continue;
        seen.add(meta.id);
        const provider = v2 ? 'opencode2' : 'opencode';
        const { records, truncated } = readOpenCodeRecords(db, candidate, provider, messageTable, v2, messageColumns, meta.id);
        if (truncated) sourceWarnings.add(sourceMessage('notice.opencode-message-limit'));
        sessions.push({ id: `${provider}:${meta.id}`, title: safeTitle(meta.title) || `${provider} · ${String(meta.id).slice(-20)}`,
          provider, path: candidate.path, updatedAt: Number.isFinite(meta.time_updated) ? meta.time_updated : candidate.info.mtimeMs,
          ...(typeof meta.directory === 'string' ? { cwd: meta.directory } : {}), records });
      }
    }
    if (!sessions.length && !available.has('session') && !available.has('session_v2')) sourceWarnings.add(sourceMessage('notice.opencode-schema-unavailable'));
    const result = { stamp, sessions, warnings: [...sourceWarnings] };
    replayWarnings(warnings, result);
    databaseCache.set(cacheKey, result); trimCache(databaseCache);
    return sessions;
  } finally { db?.close(); }
}

/** Read 2xx local-proxy rows from ~/.cc-switch/cc-switch.db when present, strictly read-only. */
async function readCcSwitchProxyRows(dbPath, provider, sessionId, records) {
  if (typeof dbPath !== 'string' || !dbPath || dbPath.includes('\0')) return [];
  let canonical;
  try { canonical = await realpath(dbPath); } catch { return []; }
  const dbInfo = await info(canonical);
  if (!dbInfo?.isFile()) return [];
  const wal = await info(`${canonical}-wal`);
  const minSec = records.length ? Math.min(...records.map(r => r.createdAtSec)) - SESSION_PROXY_DEDUP_WINDOW_SECONDS : null;
  const maxSec = records.length ? Math.max(...records.map(r => r.createdAtSec)) + SESSION_PROXY_DEDUP_WINDOW_SECONDS : null;
  const stamp = fileStamp(dbInfo) + ':' + (wal ? fileStamp(wal) : '');
  const cacheKey = JSON.stringify([canonical, provider, sessionId, minSec, maxSec]);
  const cached = ccSwitchCache.get(cacheKey);
  if (cached?.stamp === stamp) return cached.rows;

  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { return []; }
  let db;
  try {
    db = new DatabaseSync(canonical, { readOnly: true, enableExtensionLoading: false });
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=500; PRAGMA trusted_schema=OFF;');
    const available = tables(db);
    if (!available.has('proxy_request_logs')) {
      ccSwitchCache.set(cacheKey, { stamp, rows: [] }); trimCache(ccSwitchCache);
      return [];
    }
    const cols = columns(db, 'proxy_request_logs');
    const required = ['request_id', 'app_type', 'model', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'latency_ms', 'first_token_ms', 'status_code', 'created_at'];
    if (!required.every(col => cols.has(col))) return [];

    const optCol = (col, fallback = 'NULL') => cols.has(col) ? `"${col}"` : `${fallback} AS "${col}"`;
    const sourceFilter = cols.has('data_source') ? "COALESCE(data_source, 'proxy') = 'proxy'" : '1 = 1';
    const appFamily = provider === 'opencode2' ? 'opencode' : provider;
    const appClause = appFamily === 'claude' ? "app_type IN ('claude', 'claude-desktop')" : 'app_type = ?';
    const params = appFamily === 'claude' ? [] : [appFamily];

    const scopeParts = [];
    if (cols.has('session_id') && sessionId) {
      scopeParts.push('session_id = ?');
      params.push(sessionId);
    }
    if (minSec !== null && maxSec !== null) {
      scopeParts.push('(created_at >= ? AND created_at <= ?)');
      params.push(minSec, maxSec);
    }
    if (!scopeParts.length) return [];

    const sql = `SELECT request_id, ${optCol('session_id')}, app_type, model, ${optCol('request_model')},
      ${optCol('pricing_model')}, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
      ${optCol('input_token_semantics', '0')}, latency_ms, first_token_ms, created_at
      FROM proxy_request_logs
      WHERE ${sourceFilter} AND status_code >= 200 AND status_code < 300
        AND (${appClause}) AND (${scopeParts.join(' OR ')})
      ORDER BY created_at DESC LIMIT 500`;
    const rows = db.prepare(sql).all(...params);
    ccSwitchCache.set(cacheKey, { stamp, rows }); trimCache(ccSwitchCache);
    return rows;
  } catch { return []; }
  finally { db?.close(); }
}

async function candidateFor(provider, file, onUnavailable) {
  if (typeof file !== 'string' || !file || file.includes('\0')) return null;
  let canonical;
  try { canonical = await realpath(file); }
  catch (error) { reportDiscoveryError(error, onUnavailable); return null; }
  const metadata = await info(canonical, onUnavailable);
  return metadata?.isFile() ? { provider, path: canonical, info: metadata } : null;
}

function bestSession(sessions) {
  return sessions.sort((a, b) => (b.records[0]?.completedAt ?? 0) - (a.records[0]?.completedAt ?? 0)
    || b.records.length - a.records.length || b.updatedAt - a.updatedAt)[0] ?? null;
}

async function headerMeta(candidate, budget) {
  const cacheKey = `${candidate.provider}:${candidate.path}`;
  const stamp = fileStamp(candidate.info), identity = fileIdentity(candidate.info), size = candidate.info.size;
  const mainCached = parseCache.get(`${cacheKey}:main`);
  if (mainCached?.sourceStamp === stamp) {
    return { stamp, sessionId: mainCached.sourceSessionId ?? null, cwd: mainCached.session?.cwd ?? null };
  }
  const cached = headerCache.get(cacheKey);
  if (cached?.stamp === stamp) return cached;
  const maxBytes = Math.min(candidate.info.size, MAX_HEADER_BYTES);
  const firstBytes = Math.min(candidate.info.size, 32_768);
  if (firstBytes > budget.remaining) return null;
  const file = await open(candidate.path, 'r');
  try {
    const reusable = cached?.identity === identity && cached.size < size && cached.sessionId && cached.cwd ? cached : null;
    if (reusable && await matchAnchors(file, reusable.anchors, budget)) {
      const meta = { ...reusable, stamp, size };
      headerCache.set(cacheKey, meta);
      return meta;
    }
    if (firstBytes > budget.remaining) return null;
    let length = firstBytes;
    let parsed = { sessionId: null, cwd: null };
    let anchor;
    while (true) {
      budget.remaining -= length === firstBytes ? firstBytes : (length - firstBytes);
      const buffer = Buffer.alloc(length), result = await file.read(buffer, 0, length, 0);
      const text = buffer.subarray(0, result.bytesRead).toString('utf8');
      const nl = text.lastIndexOf('\n');
      if (nl >= 0) parsed = readJsonlMetadata(text.slice(0, nl + 1), candidate.provider);
      if (length > 0 && !anchor) {
        const head = buffer.subarray(0, Math.min(result.bytesRead, CURSOR_ANCHOR_BYTES));
        if (head.length) anchor = { start: 0, length: head.length, hash: createHash('sha256').update(head).digest('hex') };
      }
      if ((nl >= 0 && parsed.sessionId && parsed.cwd) || length >= maxBytes) break;
      // Budget exhaustion is temporary: do not cache an incomplete header as missing metadata.
      if ((maxBytes - length) > budget.remaining) return null;
      length = maxBytes;
    }
    const meta = { stamp, identity, size, anchors: anchor ? [anchor] : [],
      sessionId: parsed.sessionId ?? null, cwd: parsed.cwd ?? null };
    headerCache.set(cacheKey, meta); trimCache(headerCache, 2000);
    return meta;
  } finally { await file.close(); }
}

async function headerSessionId(candidate, budget) {
  return (await headerMeta(candidate, budget))?.sessionId ?? null;
}

function preferBetterSession(map, session) {
  if (!session) return;
  const previous = map.get(session.id);
  const completed = session.records[0]?.completedAt ?? 0, oldCompleted = previous?.records[0]?.completedAt ?? 0;
  if (!previous || completed > oldCompleted || (completed === oldCompleted && session.records.length > previous.records.length)) {
    map.set(session.id, session);
  }
}

async function readSingleTargetSession(target, options = {}) {
  const warnings = new Set(), budget = { remaining: MAX_SCAN_BYTES };
  if (!target || !['codex', 'claude', 'opencode', 'opencode2', 'pi', 'antigravity', 'hermes'].includes(target.provider)
      || typeof target.sessionId !== 'string' || !target.sessionId || target.sessionId.length > 256) {
    return { session: null, warnings: [sourceMessage('notice.session-unidentified')] };
  }
  const isDatabase = target.provider === 'opencode' || target.provider === 'opencode2';
  const rootProvider = isDatabase ? 'opencode' : target.provider;
  const explicitPath = isDatabase ? target.dbPath : target.transcriptPath;
  const ccSwitchDb = options.skipProxyMerge
    ? null
    : options.ccSwitchDb !== undefined
      ? options.ccSwitchDb
      : (options.includeDefaults !== false ? defaultRoots().ccSwitchDb : null);

  const read = async candidate => {
    try {
      if (isDatabase) return bestSession(await readDatabase(candidate, 100, warnings, target));
      const main = await readJsonl(candidate, budget, warnings, target.sessionId);
      return main && target.provider === 'claude'
        ? await attachClaudeSubagents(main, target.sessionId, budget, warnings)
        : main;
    } catch (error) {
      warnings.add(sourceMessage('notice.session-read-failed', target.provider, shortError(error)));
      return null;
    }
  };
  const finish = async session => {
    if (!session) {
      warnings.add(sourceMessage('notice.local-session-not-found'));
      return { session: null, warnings: [...warnings] };
    }
    let records = session.records;
    if (ccSwitchDb) {
      const proxyRows = await readCcSwitchProxyRows(ccSwitchDb, target.provider, target.sessionId, records);
      if (proxyRows.length) records = mergeProxyRecords(records, proxyRows, target.provider, target.sessionId);
    }
    records = records.map(rec => rec ? { ...rec, provider: session.provider } : rec).filter(Boolean);
    const enriched = {
      ...session,
      records,
      ...(safeTitle(target.title) ? { title: safeTitle(target.title) } : {})
    };
    return { session: enriched, warnings: [...warnings], ...(options.includeUsageRecords ? {
      usageRecords: session.records.map(record => ({ ...record, provider: session.provider }))
    } : {}) };
  };
  if (target.provider === 'hermes') {
    const roots = await configuredRoots(options.roots, options.includeDefaults !== false);
    const sessions = await readHermesSessions(roots.hermes, { sessionIds: [target.sessionId], warnings });
    return finish(bestSession(sessions));
  }
  if (explicitPath !== undefined && explicitPath !== null) {
    const candidate = await candidateFor(target.provider, explicitPath);
    return finish(candidate ? await read(candidate) : null);
  }

  const roots = await configuredRoots(options.roots, options.includeDefaults !== false);
  const providerRoots = (roots[rootProvider] ?? []).slice(0, 100);
  const lookupKey = JSON.stringify([target.provider, target.sessionId, providerRoots]);
  const savedLocation = locationCache.get(lookupKey);
  if (!options.fresh && savedLocation && Date.now() - savedLocation.at < 20_000) {
    const sessions = [];
    for (const file of savedLocation.paths) {
      const candidate = await candidateFor(target.provider, file);
      const session = candidate ? await read(candidate) : null;
      if (session) sessions.push(session);
    }
    if (sessions.length) return finish(bestSession(sessions));
    locationCache.delete(lookupKey);
  }

  const files = new Set();
  const maxAgeMs = options.fresh ? 0 : 20_000;
  for (const root of providerRoots) for (const file of await discover(rootProvider, root, warnings, { maxAgeMs })) files.add(file);
  const filenameMatches = file => {
    // Antigravity's file is always transcript.jsonl; the conversation id is its directory name.
    if (target.provider === 'antigravity') return antigravitySessionIdFromPath(file) === target.sessionId;
    const name = path.basename(file, path.extname(file));
    return name === target.sessionId || name.endsWith(`-${target.sessionId}`) || name.endsWith(`_${target.sessionId}`);
  };
  const named = [...files].filter(filenameMatches), sessions = [], matchedPaths = [];
  const visit = async (file, checkHeader) => {
    try {
      const candidate = await candidateFor(target.provider, file);
      if (!candidate || (checkHeader && await headerSessionId(candidate, budget) !== target.sessionId)) return;
      const session = await read(candidate);
      if (session) { sessions.push(session); matchedPaths.push(candidate.path); }
    } catch (error) { warnings.add(sourceMessage('notice.session-read-failed', target.provider, shortError(error))); }
  };
  // Normal provider filenames carry the ID. Metadata lookup also supports renamed/mirrored logs.
  if (isDatabase) for (const file of files) await visit(file, false);
  else {
    for (const file of named) await visit(file, false);
    // Header lookup only helps formats with a session header; Antigravity IDs come from the path alone.
    if (!sessions.length && target.provider !== 'antigravity') for (const file of files) if (!filenameMatches(file)) await visit(file, true);
  }
  if (matchedPaths.length) {
    locationCache.set(lookupKey, { at: Date.now(), paths: [...new Set(matchedPaths)] });
    trimCache(locationCache);
  }
  return finish(bestSession(sessions));
}

/**
 * Aggregate all sessions belonging to the active project channel (worktree):
 * combines Orca-registered terminal pane sessions with local sessions whose CWD matches worktreePath.
 */
async function readChannelSessions(target, options = {}) {
  const platform = options.platform || process.platform;
  const wantedCwd = target.worktreePath ? normalizeComparePath(target.worktreePath, platform) : null;
  const explicitSessions = Array.isArray(target.sessions) ? target.sessions : [];
  if (!wantedCwd && !explicitSessions.length) {
    return { session: null, warnings: [sourceMessage('notice.channel-unidentified')] };
  }

  const warnings = new Set();
  const bySessionId = new Map();

  const hermesIds = [];
  for (const entry of explicitSessions) {
    if (entry?.provider === 'hermes') {
      if (safeSegment(entry.sessionId)) hermesIds.push(entry.sessionId);
      continue;
    }
    const res = await readSingleTargetSession(entry, {
      ...options,
      skipProxyMerge: true
    });
    for (const w of res.warnings) warnings.add(w);
    if (res.session) preferBetterSession(bySessionId, res.session);
  }

  const roots = wantedCwd || hermesIds.length
    ? await configuredRoots(options.roots, options.includeDefaults !== false) : null;
  if (roots) {
    const sessions = await readHermesSessions(roots.hermes, {
      sessionIds: hermesIds, worktree: wantedCwd, comparePath: value => normalizeComparePath(value, platform), warnings
    });
    for (const session of sessions) preferBetterSession(bySessionId, session);
  }

  if (wantedCwd) {
    const budget = { remaining: MAX_SCAN_BYTES };
    const maxAgeMs = options.fresh ? 0 : 4_000;

    for (const provider of ['codex', 'claude', 'pi']) {
      const seenPaths = new Set(), candidates = [];
      for (const root of (roots[provider] ?? []).slice(0, 100)) {
        for (const file of await discover(provider, root, warnings, { maxAgeMs })) {
          const candidate = await candidateFor(provider, file);
          if (!candidate || seenPaths.has(candidate.path)) continue;
          seenPaths.add(candidate.path);
          candidates.push(candidate);
        }
      }
      candidates.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
      for (const candidate of candidates) {
        try {
          const meta = await headerMeta(candidate, budget);
          if (!meta?.cwd || normalizeComparePath(meta.cwd, platform) !== wantedCwd) continue;
          let session = await readJsonl(candidate, budget, warnings);
          if (session && provider === 'claude') {
            const rawId = session.id.slice('claude:'.length);
            session = await attachClaudeSubagents(session, rawId, budget, warnings);
          }
          if (session) preferBetterSession(bySessionId, session);
        } catch (error) {
          warnings.add(sourceMessage('notice.session-read-failed', provider, shortError(error)));
        }
      }
    }

    const agyFiles = new Set();
    for (const root of (roots.antigravity ?? []).slice(0, 100)) {
      for (const file of await discover('antigravity', root, warnings, { maxAgeMs })) agyFiles.add(file);
    }
    for (const file of agyFiles) {
      try {
        const sessionId = antigravitySessionIdFromPath(file);
        if (!sessionId || bySessionId.has('antigravity:' + sessionId) || await antigravityWorkspace(file, platform) !== wantedCwd) continue;
        const candidate = await candidateFor('antigravity', file);
        if (candidate) preferBetterSession(bySessionId, await readJsonl(candidate, budget, warnings, sessionId));
      } catch {
        warnings.add(sourceMessage('notice.antigravity-location-unavailable'));
      }
    }

    const seenDbPaths = new Set();
    for (const root of (roots.opencode ?? []).slice(0, 10)) {
      for (const file of await discover('opencode', root, warnings, { maxAgeMs })) {
        const candidate = await candidateFor('opencode', file);
        if (!candidate || seenDbPaths.has(candidate.path)) continue;
        seenDbPaths.add(candidate.path);
        try {
          const dbSessions = await readDatabase(candidate, 100, warnings, { cwdFilter: wantedCwd, platform });
          for (const session of dbSessions) preferBetterSession(bySessionId, session);
        } catch (error) {
          warnings.add(sourceMessage('notice.opencode-session-read-failed', shortError(error)));
        }
      }
    }
  }

  const ccSwitchDb = options.ccSwitchDb !== undefined
    ? options.ccSwitchDb
    : (options.includeDefaults !== false ? defaultRoots().ccSwitchDb : null);

  const proxyEntries = [];
  let maxUpdatedAt = 0;
  for (const session of bySessionId.values()) {
    if (session.updatedAt > maxUpdatedAt) maxUpdatedAt = session.updatedAt;
    const rawSessionId = session.id.slice(session.provider.length + 1);
    const proxyRows = ccSwitchDb && rawSessionId
      ? await readCcSwitchProxyRows(ccSwitchDb, session.provider, rawSessionId, session.records)
      : [];
    proxyEntries.push({ provider: session.provider, sessionId: rawSessionId, records: session.records, proxyRows });
  }

  const mergedRecords = mergeChannelProxyRecords(proxyEntries);
  // A failed source can hold the channel's only requests, even if other empty logs were readable.
  // Let the controller retain its last good snapshot; genuinely empty channels still succeed.
  if (!mergedRecords.length && warnings.size) return { session: null, warnings: [...warnings] };

  return {
    session: {
      id: `channel:${target.worktreeId || target.key || 'active'}`,
      title: safeTitle(target.title) || sourceMessage('current-channel'),
      provider: 'channel',
      updatedAt: maxUpdatedAt || Date.now(),
      records: mergedRecords
    },
    warnings: [...warnings],
    ...(options.includeUsageRecords ? { usageRecords: recentRecords(proxyEntries.flatMap(entry =>
      entry.records.map(record => ({ ...record, provider: entry.provider })))) } : {})
  };
}

/** Read either a channel target (worktree aggregation) or a single explicitly selected conversation. */
export async function readTargetSession(target, options = {}) {
  if (target && (target.worktreePath !== undefined || Array.isArray(target.sessions))) {
    return readChannelSessions(target, options);
  }
  return readSingleTargetSession(target, options);
}

/** File signals keep the 250 ms check cheap when every transcript is quiet. */
export function createLiveSessionReader() {
  const watchers = new Map(), snapshots = new Map();
  let version = 0, watchFailed = false, checkedRootsAt = -Infinity, rootsKey, configuring, closed = false;

  function observe(directory, recursive) {
    const existing = watchers.get(directory);
    if (existing?.recursive || (existing && !recursive)) return;
    if (recursive && (directory === path.parse(directory).root || directory === homedir())) return;
    if (watchers.size >= 64 && !existing) { watchFailed = true; return; }
    try {
      existing?.watcher.close();
      watchers.delete(directory);
      const watcher = watch(directory, { recursive, persistent: false }, (kind, filename) => {
        if (filename && /-shm$/i.test(filename)) return;
        if (!filename || kind === 'rename') {
          discoveryCache.clear();
          version++;
        } else if (/\.(?:jsonl|db|sqlite|sqlite3)(?:-wal)?$/i.test(filename) || /(?:^|[\\/])agent\.log(?:\.\d+)?$/i.test(filename)) {
          version++;
        }
      });
      watcher.on('error', () => {
        watcher.close();
        if (watchers.get(directory)?.watcher === watcher) watchers.delete(directory);
        watchFailed = true;
        version++;
      });
      watchers.set(directory, { watcher, recursive });
    } catch { watchFailed = true; }
  }

  async function refreshWatches(roots) {
    const key = JSON.stringify(roots ?? {});
    if (configuring) await configuring;
    if (closed || (rootsKey === key && Date.now() - checkedRootsAt < 30_000)) return;
    rootsKey = key;
    checkedRootsAt = Date.now();
    configuring = (async () => {
      const directories = await configuredRoots(roots);
      if (closed) return;
      watchFailed = false;
      for (const source of new Set(Object.values(directories).flat())) {
        const meta = await info(source);
        if (closed) return;
        if (meta?.isDirectory()) observe(source, true);
        else if (meta?.isFile()) observe(path.dirname(source), false);
      }
      const proxy = defaultRoots().ccSwitchDb;
      if (!closed && (await info(path.dirname(proxy)))?.isDirectory()) observe(path.dirname(proxy), false);
    })().finally(() => { configuring = null; });
    await configuring;
  }

  async function read(target, options = {}) {
    await refreshWatches(options.roots);
    if (closed) return { session: null, warnings: [] };
    for (const session of target.sessions ?? []) {
      const explicit = session.transcriptPath ?? session.dbPath;
      if (!explicit) continue;
      const directory = path.dirname(explicit);
      if (!watchers.has(directory) && (await info(directory))?.isDirectory() && !closed) observe(directory, false);
    }
    const key = JSON.stringify([target.key, target.worktreePath, target.sessions, rootsKey, options.includeUsageRecords === true]);
    const saved = snapshots.get(key);
    const at = Date.now();
    if (!options.fresh && saved?.version === version && at - saved.at < (watchFailed ? 250 : 4000)) return saved.result;
    const observedVersion = version;
    const result = await readTargetSession(target, options);
    snapshots.delete(key);
    snapshots.set(key, { version: observedVersion, at, result });
    trimCache(snapshots, 64);
    return result;
  }

  function close() {
    closed = true;
    for (const { watcher } of watchers.values()) watcher.close();
    watchers.clear();
    snapshots.clear();
  }

  return { read, close };
}

// ---- Usage totals: every session written in the last 30 days, read whole, once per change. ----

const USAGE_MAX_FILE_BYTES = 256 * 1024 * 1024, USAGE_MAX_UNITS = 20_000, USAGE_MAX_DIRECTORIES = 5_000;

/** Every JSONL session file under a root that was written at or after cutoffMs; subagent folders are skipped. */
async function walkRecentJsonl(root, cutoffMs, onUnavailable) {
  const rootStat = await info(root, onUnavailable);
  if (!rootStat?.isDirectory()) return [];
  const found = [], queue = [root], seen = new Set();
  while (queue.length && seen.size < USAGE_MAX_DIRECTORIES) {
    const directory = queue.pop();
    let canonical, entries;
    try {
      canonical = await realpath(directory);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) { reportDiscoveryError(error, onUnavailable); continue; }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!skippedDirectories.has(entry.name.toLowerCase())) queue.push(file);
      } else if (entry.isFile() && /\.jsonl$/i.test(entry.name)) {
        const metadata = await info(file, onUnavailable);
        if (metadata?.isFile() && metadata.mtimeMs >= cutoffMs) found.push({ path: file, size: metadata.size, mtimeMs: metadata.mtimeMs });
      }
    }
  }
  return found;
}

const USAGE_STREAM_BATCH_ROWS = 2_000;
const USAGE_CHUNK_BYTES = 1024 * 1024;
const usageObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const usageText = value => typeof value === 'string' && value.trim() && value.length <= 256 ? value.trim() : null;

function readPacer() {
  let spent = 0;
  return async bytes => {
    spent += bytes;
    if (spent >= BACKFILL_BYTES) { spent %= BACKFILL_BYTES; await delay(250); }
    else await yieldToRequests();
  };
}

/** Only complete lines contribute. Keep in-progress parser state across paced reads. */
async function streamCompleteText(file, onChunk, pace) {
  const decoder = new StringDecoder('utf8');
  let carry = '', read = 0;
  const metadata = await stat(file);
  if (!metadata.size) return true;
  for await (const chunk of createReadStream(file, { highWaterMark: USAGE_CHUNK_BYTES, end: metadata.size - 1 })) {
    const text = carry + decoder.write(chunk), end = text.lastIndexOf('\n') + 1;
    if (end) await onChunk(text.slice(0, end));
    carry = text.slice(end);
    read += chunk.length;
    await pace(chunk.length);
  }
  if (read !== metadata.size) throw new Error('TPS usage file changed while reading');
  if (carry.trim()) {
    if (!parsedRow(carry)) return false;
    await onChunk(carry + '\n');
  }
  return true;
}

async function streamJsonRows(file, onBatch, pace) {
  return streamCompleteText(file, async text => {
    let batch = [];
    for (const line of text.split('\n')) {
      const row = parsedRow(line);
      if (row) batch.push(row);
      if (batch.length >= USAGE_STREAM_BATCH_ROWS) {
        onBatch(batch);
        batch = [];
        await yieldToRequests();
      }
    }
    if (batch.length) onBatch(batch);
  }, pace);
}

function parsedRow(line) {
  try { return usageObject(JSON.parse(line)); } catch { return null; }
}

/** Codex keeps its session id in the first session_meta row, as parseJsonl reads it. */
async function codexSessionId(file) {
  const handle = await open(file, 'r');
  try {
    const size = Math.min(MAX_HEADER_BYTES, (await handle.stat()).size);
    const buffer = Buffer.alloc(size), { bytesRead } = await handle.read(buffer, 0, size, 0);
    for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n').slice(0, 30)) {
      const row = parsedRow(line);
      if (row?.type === 'session_meta') return usageText(usageObject(row.payload)?.id);
    }
    return null;
  } finally { await handle.close(); }
}

/** Codex rollouts can be over a gigabyte, so they stream through the incremental parser rather than being read whole. */
export async function readCodexUsageFile(file, minDay) {
  const days = {};
  await addCodexStreamRecords(days, file, minDay);
  return days;
}

function rankedUsage(window) {
  if (!window) return undefined;
  const result = { ...window, totals: {} };
  if (window.includeRecent) Object.assign(result, { recent: [], recentFrom: Date.now() - RECENT_STATS_MS });
  if (window.includeUsageTimes) Object.assign(result, { usageByTime: {}, usageTimesFrom: leaderboardUsageTimesFrom(window.from) });
  if (window.includeRecords) Object.assign(result, { records: [], recordFrom: window.recordFrom, complete: true });
  return result;
}

function usageResult(days, rank) {
  if (!rank) return days;
  const result = { days, leaderboardDays: rank.totals, leaderboardFrom: rank.from };
  if (rank.recent) result.recent = trimRecentRequests(rank.recent);
  if (rank.usageByTime) Object.assign(result, { leaderboardUsageByTime: rank.usageByTime, usageTimesFrom: rank.usageTimesFrom });
  if (rank.records) Object.assign(result, { records: rank.records, complete: rank.complete });
  return result;
}

async function addCodexStreamRecords(days, file, minDay, leaderboardDays, pace = readPacer()) {
  const sessionId = await codexSessionId(file);
  const parser = createCodexParser(sessionId, { limit: Infinity });
  const complete = await streamJsonRows(file, batch => parser.feed(batch), pace);
  if (leaderboardDays?.records && !complete) leaderboardDays.complete = false;
  const metadata = leaderboardDays?.records ? await headerMeta(await candidateFor('codex', file), { remaining: 256 * 1024 }).catch(() => null) : null;
  const records = parser.finish();
  accumulateRecords(days, 'codex', leaderboardDays?.records
    ? records.map(record => ({ ...record, sessionId, cwd: metadata?.cwd })) : records, { minDay, leaderboardDays });
}

async function addFileRecords(days, provider, file, minDay, isSubagent, leaderboardDays, pace) {
  const metadata = await stat(file);
  if (!metadata.isFile()) throw new Error(sourceMessage('notice.read-failed'));
  if (metadata.size > USAGE_MAX_FILE_BYTES) throw Object.assign(new Error(sourceMessage('notice.session-file-too-large')), { code: 'too_large' });
  const cursor = createJsonlCursor('', provider, '', { isSubagent, limit: Infinity });
  const complete = await streamCompleteText(file, text => cursor.feed(text), pace);
  if (leaderboardDays?.records && !complete) leaderboardDays.complete = false;
  const records = cursor.finish();
  accumulateRecords(days, provider, leaderboardDays?.records
    ? records.map(record => ({ ...record, sessionId: cursor.sessionId, cwd: cursor.cwd })) : records, { minDay, leaderboardDays });
}

async function fileUsageUnit(provider, file, rankWindow, onUnavailable) {
  // Claude keeps subagent calls in <session>/subagents; they belong to the parent session's unit.
  let incomplete = false;
  const subagents = provider === 'claude'
    ? (await collectClaudeSubagentCandidates(file.path, path.basename(file.path, '.jsonl'), () => { incomplete = true; }))
      .map(candidate => ({ path: candidate.path, size: candidate.info.size, mtimeMs: candidate.info.mtimeMs }))
    : [];
  if (incomplete) {
    onUnavailable?.();
    return null;
  }
  const stamp = [identity(file.path), file.size, file.mtimeMs, ...subagents.map(item => `${item.size}:${item.mtimeMs}`)].join(':');
  return {
    // A switch between mirrored files replaces the same logical unit, including its retained counts.
    key: identity(`${provider}|${path.basename(file.path)}`),
    stamp,
    bytes: file.size + subagents.reduce((sum, item) => sum + item.size, 0),
    mtimeMs: file.mtimeMs,
    read: async () => {
      const minDay = dayKeyAgo(Date.now(), HISTORY_DAYS - 1), days = {}, rank = rankedUsage(rankWindow);
      const pace = readPacer();
      if (provider === 'codex') await addCodexStreamRecords(days, file.path, minDay, rank, pace);
      else await addFileRecords(days, provider, file.path, minDay, false, rank, pace);
      for (const item of subagents) await addFileRecords(days, 'claude', item.path, minDay, true, rank, pace);
      if (rank?.records) {
        for (const item of [file, ...subagents]) {
          const current = await stat(item.path);
          if (current.size !== item.size || current.mtimeMs !== item.mtimeMs) rank.complete = false;
        }
      }
      return usageResult(days, rank);
    }
  };
}

async function readOpenCodeSession(dbPath, v2, sessionId, rankWindow, cwd) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true, enableExtensionLoading: false });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=100; PRAGMA trusted_schema=OFF;');
    const messageTable = v2 ? 'session_message' : 'message', orderColumn = v2 ? 'seq' : 'rowid';
    const rows = db.prepare(`SELECT id,${v2 ? 'type' : 'NULL AS type'},time_created,${projectedData()}
      FROM ${messageTable} WHERE session_id=? ORDER BY ${orderColumn} ASC`).iterate(sessionId);
    const days = {}, rank = rankedUsage(rankWindow);
    const records = new Map(), pace = readPacer();
    let batch = [];
    function collect() {
      for (const record of parseOpenCodeRows(batch, v2, { limit: Infinity })) records.set(record.id, record);
      batch = [];
    }
    for (const row of rows) {
      batch.push(row);
      if (batch.length < 512) continue;
      collect();
      await pace(512 * 1024);
    }
    collect();
    const entries = rank?.records ? [...records.values()].map(record => ({ ...record, sessionId, cwd })) : records.values();
    accumulateRecords(days, v2 ? 'opencode2' : 'opencode', entries,
      { minDay: dayKeyAgo(Date.now(), HISTORY_DAYS - 1), leaderboardDays: rank });
    return usageResult(days, rank);
  } finally { db.close(); }
}

/** One unit per OpenCode session updated since cutoffMs; the unit's stamp includes its message count. */
async function openCodeUsageUnits(dbPath, cutoffMs, rankWindow, onUnavailable) {
  const database = await info(dbPath, onUnavailable);
  if (!database?.isFile()) return [];
  const { DatabaseSync } = await import('node:sqlite');
  const units = [];
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, enableExtensionLoading: false });
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=100; PRAGMA trusted_schema=OFF;');
    const available = tables(db);
    for (const v2 of [false, true]) {
      const table = v2 ? 'session_v2' : 'session', messageTable = v2 ? 'session_message' : 'message';
      if (!available.has(table) || !available.has(messageTable)) continue;
      const sessionColumns = columns(db, table);
      if (!sessionColumns.has('id') || !sessionColumns.has('time_updated')) continue;
      const provider = v2 ? 'opencode2' : 'opencode';
      const directory = sessionColumns.has('directory') ? 'directory' : 'NULL AS directory';
      const rows = db.prepare(`SELECT id, time_updated, ${directory} FROM ${table} WHERE time_updated >= ?`).iterate(cutoffMs);
      const messageCount = db.prepare(`SELECT COUNT(*) AS n FROM ${messageTable} WHERE session_id=?`);
      for (const row of rows) {
        const count = Number(messageCount.get(row.id)?.n ?? 0);
        units.push({
          key: identity(`${provider}|${dbPath}|${row.id}`),
          stamp: `${row.time_updated}:${count}`,
          bytes: count * 1024,
          mtimeMs: Number(row.time_updated) || 0,
          read: () => readOpenCodeSession(dbPath, v2, row.id, rankWindow, row.directory)
        });
        if (units.length % 64 === 0) await yieldToRequests();
      }
    }
  } finally { db?.close(); }
  return units;
}

/** Antigravity: one unit per conversation whose transcript was written since cutoffMs; timing comes from its native store. */
async function antigravityUsageUnits(brainRoot, cutoffMs, rankWindow, onUnavailable) {
  if (!(await info(brainRoot, onUnavailable))?.isDirectory()) return [];
  let entries;
  try { entries = await readdir(brainRoot, { withFileTypes: true }); }
  catch (error) { reportDiscoveryError(error, onUnavailable); return []; }
  const units = [];
  for (const entry of entries.slice(0, USAGE_MAX_UNITS)) {
    if (!entry.isDirectory() || !safeSegment(entry.name)) continue;
    const transcript = path.join(brainRoot, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
    const metadata = await info(transcript, onUnavailable);
    if (!metadata?.isFile() || metadata.mtimeMs < cutoffMs) continue;
    units.push({
      key: identity(`antigravity|${transcript}`),
      stamp: `${metadata.size}:${metadata.mtimeMs}:${await antigravityNativeStamp(transcript)}`,
      bytes: metadata.size,
      mtimeMs: metadata.mtimeMs,
      read: () => readAntigravityUsage(transcript, entry.name, rankWindow)
    });
  }
  return units;
}

async function readAntigravityUsage(transcript, conversationId, rankWindow) {
  const days = {}, notes = [], rank = rankedUsage(rankWindow);
  const native = await readAntigravityTimings(transcript, message => notes.push(message));
  const cursor = createJsonlCursor('', 'antigravity', '', { sessionId: conversationId, limit: Infinity });
  const complete = await streamCompleteText(transcript, text => cursor.feed(text), readPacer());
  if (rank?.records && !complete) rank.complete = false;
  const records = cursor.finish(native);
  const cwd = rank?.records ? await antigravityWorkspace(transcript, process.platform).catch(() => null) : null;
  accumulateRecords(days, 'antigravity', rank?.records ? records.map(record => ({ ...record, sessionId: conversationId, cwd })) : records,
    { minDay: dayKeyAgo(Date.now(), HISTORY_DAYS - 1), leaderboardDays: rank });
  return usageResult(days, rank);
}

/** Descriptors for the usage index: Codex, Claude and Pi session files, OpenCode sessions, and Antigravity conversations. */
export async function discoverUsageUnits(cutoffMs, options = {}) {
  const { rankDay, rankFrom = rankDay, includeRecent = false, includeUsageTimes = false, includeRecords = false, onUnavailable } = options;
  const roots = await configuredRoots(options.roots, options.includeDefaults !== false, onUnavailable);
  const rankWindow = rankDay ? { from: rankFrom, start: leaderboardDayStart(rankFrom),
    end: leaderboardDayStart(rankDay) + 86_400_000, includeRecent, includeUsageTimes, includeRecords, recordFrom: cutoffMs } :
    includeRecords ? { includeRecords, recordFrom: cutoffMs } : undefined;
  // Mirrors are append-only transcripts. Keep the largest copy; use its modification time to break ties.
  // A sync can give a stale copy a newer mtime, so root order and mtime alone cannot identify the fullest log.
  const units = [];
  for (const provider of ['codex', 'claude', 'pi']) {
    const selected = new Map();
    for (const root of (roots[provider] ?? []).slice(0, 100)) {
      for (const file of await walkRecentJsonl(root, cutoffMs, onUnavailable)) {
        const filename = path.basename(file.path), previous = selected.get(filename);
        if (!previous && units.length + selected.size >= USAGE_MAX_UNITS) continue;
        if (!previous || file.size > previous.size || (file.size === previous.size && file.mtimeMs > previous.mtimeMs)) {
          selected.set(filename, file);
        }
      }
    }
    for (const file of selected.values()) {
      const unit = await fileUsageUnit(provider, file, rankWindow, onUnavailable);
      if (unit) units.push(unit);
    }
  }
  for (const root of (roots.opencode ?? []).slice(0, 10)) {
    try { units.push(...await openCodeUsageUnits(root, cutoffMs, rankWindow, onUnavailable)); }
    catch { onUnavailable?.(); }
  }
  for (const root of (roots.antigravity ?? []).slice(0, 10)) {
    units.push(...await antigravityUsageUnits(root, cutoffMs, rankWindow, onUnavailable));
  }
  for (const source of await hermesSources(roots.hermes, cutoffMs, undefined, onUnavailable)) {
    units.push({
      key: identity(`hermes|${source.root}`),
      stamp: source.stamp,
      bytes: source.bytes,
      mtimeMs: source.mtimeMs,
      async read() {
        const days = {}, rank = rankedUsage(rankWindow);
        const records = await readHermesRecords(source, { pace: readPacer(), includeCwd: includeRecords });
        accumulateRecords(days, 'hermes', records, { minDay: dayKeyAgo(Date.now(), HISTORY_DAYS - 1), leaderboardDays: rank });
        return usageResult(days, rank);
      }
    });
  }
  return units;
}

export const USAGE_RECORD_PAGE_SIZE = 512;

export function usageRecordPage(result, offset) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Array.isArray(result?.records) || offset > result.records.length) {
    throw new Error('invalid usage records page');
  }
  const records = result.records.slice(offset, offset + USAGE_RECORD_PAGE_SIZE);
  const next = offset + records.length;
  return { records, nextOffset: next < result.records.length ? next : null, complete: result.complete === true };
}

/** Discover only configured provider roots. Optional includeDefaults:false isolates tests/custom scans. */
export async function scanSessions(options = {}) {
  const maxSessions = Math.max(1, Math.min(100, Number.isInteger(options.maxSessions) ? options.maxSessions : 100));
  const warnings = new Set(), roots = await configuredRoots(options.roots, options.includeDefaults !== false);
  const candidates = [], knownFiles = new Set();
  for (const [provider, values] of Object.entries(roots)) for (const root of values.slice(0, 100)) {
    for (const file of await discover(provider, root, warnings)) {
      let canonical;
      try { canonical = await realpath(file); } catch { continue; }
      const key = `${provider}:${canonical}`;
      if (knownFiles.has(key)) continue;
      knownFiles.add(key);
      const metadata = await info(canonical);
      if (metadata?.isFile()) candidates.push({ provider, path: canonical, info: metadata });
    }
  }
  candidates.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
  const selected = [...candidates.filter(candidate => candidate.provider === 'opencode').slice(0, 10),
    ...candidates.filter(candidate => candidate.provider !== 'opencode').slice(0, maxSessions)];
  if (candidates.length > selected.length) warnings.add(sourceMessage('notice.scan-files-limit', maxSessions));
  const budget = { remaining: MAX_SCAN_BYTES }, sessions = [];
  for (const candidate of selected) {
    try {
      if (candidate.provider === 'opencode') sessions.push(...await readDatabase(candidate, maxSessions, warnings));
      else {
        let session = await readJsonl(candidate, budget, warnings);
        if (session && candidate.provider === 'claude') {
          const rawId = session.id.slice('claude:'.length);
          session = await attachClaudeSubagents(session, rawId, budget, warnings);
        }
        if (session) sessions.push(session);
      }
    } catch (error) { warnings.add(sourceMessage('notice.session-read-failed', candidate.provider, shortError(error))); }
  }
  const unique = new Map();
  for (const session of sessions) {
    const previous = unique.get(session.id);
    const completed = session.records[0]?.completedAt ?? 0, oldCompleted = previous?.records[0]?.completedAt ?? 0;
    if (!previous || completed > oldCompleted || (completed === oldCompleted && session.records.length > previous.records.length)) unique.set(session.id, session);
  }
  return { sessions: [...unique.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, maxSessions), warnings: [...warnings] };
}

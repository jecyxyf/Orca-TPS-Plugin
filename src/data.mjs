import { open, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { configuredRoots, defaultRoots } from './data-paths.mjs';
import {
  SESSION_PROXY_DEDUP_WINDOW_SECONDS,
  antigravityNativeTimings,
  createCodexParser,
  antigravitySessionIdFromPath,
  antigravityStepStart,
  mergeChannelProxyRecords,
  mergeProxyRecords,
  parseJsonl,
  parseOpenCodeRows,
  recentRecords
} from './parsers.mjs';
import { HISTORY_DAYS, accumulateRecords, dayKeyAgo } from './usage-summary.mjs';
import { readHermesSessions, hermesUsageUnits } from './hermes.mjs';

const MAX_FILES = 1500, MAX_DIRECTORIES = 500, MAX_DEPTH = 8, MAX_SUBAGENT_FILES = 200;
const MAX_FILE_BYTES = 16 * 1024 * 1024, MAX_SCAN_BYTES = 64 * 1024 * 1024, MAX_HEADER_BYTES = 262_144;
const parseCache = new Map(), headerCache = new Map(), discoveryCache = new Map(), databaseCache = new Map(), locationCache = new Map(), ccSwitchCache = new Map();
const skippedDirectories = new Set(['node_modules', '.git', 'subagents', 'cache', 'plugins', 'skills', 'auth', 'credentials']);
const shortError = error => typeof error?.code === 'string' ? error.code : '读取失败';
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

async function info(file) {
  try { return await stat(file); } catch { return null; }
}

/**
 * Antigravity keeps brain/<conversation-id>/.system_generated/logs/ with the live transcript plus rotated
 * copies. Only the transcript is read; a recursive walk over the whole brain tree would hit directory limits.
 */
async function discoverAntigravityTranscripts(root, sourceWarnings) {
  const files = [];
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { sourceWarnings.add(`antigravity：部分会话目录无法读取（${shortError(error)}）。`); return files; }
  for (const entry of entries) {
    if (files.length >= MAX_FILES) { sourceWarnings.add('antigravity：文件发现达到上限，仅扫描部分会话目录。'); break; }
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
    warnings.add(`${provider}：请选择会话目录，不能扫描整个磁盘或用户主目录。`);
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
    } catch (error) { sourceWarnings.add(`${provider}：部分会话目录无法读取（${shortError(error)}）。`); continue; }
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
  if (limited) sourceWarnings.add(`${provider}：文件发现达到上限，仅扫描部分会话目录。`);
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
  return `native:${database.size}:${database.mtimeMs}:${wal?.size ?? 0}:${wal?.mtimeMs ?? 0}`;
}

/** Read-only: model-response step metadata and generation metadata only; step payloads are never opened. */
async function readAntigravityTimings(transcriptPath, note) {
  const dbPath = antigravityNativeDbPath(transcriptPath);
  const database = dbPath ? await info(dbPath) : null;
  if (!database?.isFile()) return new Map();
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); }
  catch { note('antigravity：当前运行时不支持 SQLite，耗时与模型暂不显示。'); return new Map(); }
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
    note(`antigravity：原生会话库无法读取（${shortError(error)}），耗时与模型暂不显示。`);
    return new Map();
  } finally { db?.close(); }
}

async function readJsonl(candidate, budget, warnings, expectedSessionId, { isSubagent = false } = {}) {
  const key = `${candidate.provider}:${candidate.path}:${isSubagent ? 'sub' : 'main'}`;
  const stamp = `${candidate.info.size}:${candidate.info.mtimeMs}` +
    (candidate.provider === 'antigravity' ? `:${await antigravityNativeStamp(candidate.path)}` : '');
  const cached = parseCache.get(key);
  const matches = result => {
    if (expectedSessionId === undefined) return true;
    if (isSubagent && !result?.sourceSessionId) return true;
    return result?.sourceSessionId === expectedSessionId;
  };
  if (cached?.stamp === stamp) { replayWarnings(warnings, cached); return matches(cached) ? cached.session : null; }
  const bytes = Math.min(candidate.info.size, MAX_FILE_BYTES);
  if (bytes > budget.remaining) {
    warnings.add('本次读取达到 64 MiB 上限，较旧会话稍后读取；已有缓存仍可使用。');
    replayWarnings(warnings, cached);
    return matches(cached) ? cached?.session ?? null : null;
  }
  budget.remaining -= bytes;
  const file = await open(candidate.path, 'r');
  try {
    const sourceWarnings = [];
    const offset = candidate.info.size - bytes, buffer = Buffer.alloc(bytes);
    const read = await file.read(buffer, 0, bytes, offset);
    let text = buffer.subarray(0, read.bytesRead).toString('utf8'), header = '';
    if (offset > 0) {
      const firstLine = text.indexOf('\n');
      text = firstLine < 0 ? '' : text.slice(firstLine + 1);
      const start = Buffer.alloc(Math.min(MAX_HEADER_BYTES, candidate.info.size));
      const head = await file.read(start, 0, start.length, 0);
      header = start.subarray(0, head.bytesRead).toString('utf8');
      sourceWarnings.push(`${candidate.provider}：较大会话只读取末尾 16 MiB，缺少开头的轮次不计入。`);
    }
    // Writers append JSONL a line at a time; an unfinished final line is not evidence.
    text = text.slice(0, text.lastIndexOf('\n') + 1);
    const pathSessionId = candidate.provider === 'antigravity' ? antigravitySessionIdFromPath(candidate.path) : null;
    const native = candidate.provider === 'antigravity'
      ? await readAntigravityTimings(candidate.path, message => sourceWarnings.push(message))
      : undefined;
    const parsed = parseJsonl(text, candidate.provider, header, { truncated: offset > 0, isSubagent, sessionId: pathSessionId, native });
    const sessionId = parsed.sessionId || path.basename(candidate.path, '.jsonl');
    const session = { id: `${candidate.provider}:${sessionId || identity(candidate.path)}`,
      title: `${candidate.provider} · ${sessionId.slice(-20)}`, provider: candidate.provider,
      path: candidate.path, updatedAt: candidate.info.mtimeMs, records: parsed.records,
      ...(parsed.cwd ? { cwd: parsed.cwd } : {}) };
    const result = { stamp, session, sourceSessionId: parsed.sessionId, warnings: sourceWarnings };
    replayWarnings(warnings, result);
    parseCache.set(key, result); trimCache(parseCache);
    return matches(result) ? session : null;
  } finally { await file.close(); }
}

/** Collect Claude subagent JSONL files at fixed depths matching CC Switch's collect_jsonl_files. */
async function collectClaudeSubagentCandidates(mainPath, sessionId) {
  if (!safeSegment(sessionId)) return [];
  const subagentsDir = path.join(path.dirname(mainPath), sessionId, 'subagents');
  const dirStat = await info(subagentsDir);
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
        try { wfDirs = await readdir(workflowsDir, { withFileTypes: true }); } catch { wfDirs = []; }
        for (const wfEntry of wfDirs.slice(0, 50)) {
          if (!wfEntry.isDirectory()) continue;
          const wfPath = path.join(workflowsDir, wfEntry.name);
          let wfFiles = [];
          try { wfFiles = await readdir(wfPath, { withFileTypes: true }); } catch { wfFiles = []; }
          for (const f of wfFiles) {
            if (f.isFile() && /\.jsonl$/i.test(f.name)) paths.push(path.join(wfPath, f.name));
          }
        }
      }
    }
  } catch { return []; }

  const candidates = [];
  const seen = new Set();
  for (const file of paths) {
    const candidate = await candidateFor('claude', file);
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
      warnings.add(`claude：子代理记录读取失败（${shortError(error)}）。`);
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

async function readDatabase(candidate, maxSessions, warnings, target) {
  const wal = await info(`${candidate.path}-wal`);
  const stamp = `${candidate.info.size}:${candidate.info.mtimeMs}:${wal?.size ?? 0}:${wal?.mtimeMs ?? 0}:${maxSessions}`;
  const cacheKey = target?.cwdFilter
    ? JSON.stringify([candidate.path, 'cwd', target.cwdFilter, target.platform || ''])
    : target ? JSON.stringify([candidate.path, target.provider, target.sessionId]) : candidate.path;
  const cached = databaseCache.get(cacheKey);
  if (cached?.stamp === stamp) { replayWarnings(warnings, cached); return cached.sessions; }
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); }
  catch { warnings.add('SQLite 不可用：当前 Orca 的 Node 运行时不能读取 OpenCode 数据库。'); return []; }
  let db;
  try {
    db = new DatabaseSync(candidate.path, { readOnly: true, enableExtensionLoading: false });
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; PRAGMA trusted_schema=OFF;');
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
        const orderColumn = v2 ? 'seq' : 'rowid';
        const messageRows = db.prepare(`SELECT id,${v2 ? 'type' : 'NULL AS type'},time_created,${projectedData()}
          FROM ${messageTable} WHERE session_id=? ORDER BY ${orderColumn} DESC LIMIT 10001`).all(meta.id);
        if (messageRows.length > 10_000) { messageRows.pop(); sourceWarnings.add('OpenCode：较大会话仅读取最近 10000 条消息。'); }
        const provider = v2 ? 'opencode2' : 'opencode', records = parseOpenCodeRows(messageRows.reverse(), v2);
        sessions.push({ id: `${provider}:${meta.id}`, title: safeTitle(meta.title) || `${provider} · ${String(meta.id).slice(-20)}`,
          provider, path: candidate.path, updatedAt: Number.isFinite(meta.time_updated) ? meta.time_updated : candidate.info.mtimeMs,
          ...(typeof meta.directory === 'string' ? { cwd: meta.directory } : {}), records });
      }
    }
    if (!sessions.length && !available.has('session') && !available.has('session_v2')) sourceWarnings.add('OpenCode：数据库没有受支持的会话表。');
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
  const stamp = `${dbInfo.size}:${dbInfo.mtimeMs}:${wal?.size ?? 0}:${wal?.mtimeMs ?? 0}`;
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

async function candidateFor(provider, file) {
  if (typeof file !== 'string' || !file || file.includes('\0')) return null;
  let canonical;
  try { canonical = await realpath(file); } catch { return null; }
  const metadata = await info(canonical);
  return metadata?.isFile() ? { provider, path: canonical, info: metadata } : null;
}

function bestSession(sessions) {
  return sessions.sort((a, b) => (b.records[0]?.completedAt ?? 0) - (a.records[0]?.completedAt ?? 0)
    || b.records.length - a.records.length || b.updatedAt - a.updatedAt)[0] ?? null;
}

async function headerMeta(candidate, budget) {
  const cacheKey = `${candidate.provider}:${candidate.path}`;
  const stamp = `${candidate.info.size}:${candidate.info.mtimeMs}`;
  const mainCached = parseCache.get(`${cacheKey}:main`);
  if (mainCached?.stamp === stamp) {
    return { stamp, sessionId: mainCached.sourceSessionId ?? null, cwd: mainCached.session?.cwd ?? null };
  }
  const cached = headerCache.get(cacheKey);
  if (cached?.stamp === stamp) return cached;
  const maxBytes = Math.min(candidate.info.size, MAX_HEADER_BYTES);
  const firstBytes = Math.min(candidate.info.size, 32_768);
  if (firstBytes > budget.remaining) return null;
  const file = await open(candidate.path, 'r');
  try {
    let length = firstBytes;
    let parsed = { sessionId: null, cwd: null };
    while (true) {
      budget.remaining -= length === firstBytes ? firstBytes : (length - firstBytes);
      const buffer = Buffer.alloc(length), result = await file.read(buffer, 0, length, 0);
      const text = buffer.subarray(0, result.bytesRead).toString('utf8');
      const nl = text.lastIndexOf('\n');
      if (nl >= 0) parsed = parseJsonl(text.slice(0, nl + 1), candidate.provider);
      if ((nl >= 0 && parsed.sessionId && parsed.cwd) || length >= maxBytes) break;
      // Budget exhaustion is temporary: do not cache an incomplete header as missing metadata.
      if ((maxBytes - length) > budget.remaining) return null;
      length = maxBytes;
    }
    const meta = { stamp, sessionId: parsed.sessionId ?? null, cwd: parsed.cwd ?? null };
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
    return { session: null, warnings: ['当前会话尚未识别，等待会话记录。'] };
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
      warnings.add(`${target.provider}：会话读取失败（${shortError(error)}），未生成估算数据。`);
      return null;
    }
  };
  const finish = async session => {
    if (!session) {
      warnings.add('当前会话的本机记录暂未找到，未显示其他会话的数据。');
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
    return { session: enriched, warnings: [...warnings] };
  };
  if (target.provider === 'hermes') {
    try {
      const sessions = await readHermesSessions({
        sessionIds: [target.sessionId],
        platform: options.platform || process.platform,
        comparePath: normalizeComparePath,
        includeDefaults: options.includeDefaults,
        customRoots: options.roots?.hermes ?? [],
        ...(options.fresh ? { maxAgeMs: 0 } : {})
      });
      return finish(bestSession(sessions));
    } catch (error) {
      warnings.add(`hermes: could not read the request log (${shortError(error)}).`);
      return finish(null);
    }
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
    } catch (error) { warnings.add(`${target.provider}：会话读取失败（${shortError(error)}），未生成估算数据。`); }
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
    return { session: null, warnings: ['当前频道尚未识别，等待会话记录。'] };
  }

  const warnings = new Set();
  const bySessionId = new Map();

  // Hermes panes live in one place (its home), so they are read per channel instead of per pane.
  const hermesIds = [];
  const fileSessions = [];
  for (const entry of explicitSessions) {
    if (entry?.provider === 'hermes') { if (typeof entry.sessionId === 'string' && entry.sessionId) hermesIds.push(entry.sessionId); }
    else fileSessions.push(entry);
  }

  for (const entry of fileSessions) {
    const res = await readSingleTargetSession(entry, {
      ...options,
      skipProxyMerge: true
    });
    for (const w of res.warnings) warnings.add(w);
    if (res.session) preferBetterSession(bySessionId, res.session);
  }

  if (hermesIds.length || wantedCwd) {
    try {
      const hermesSessions = await readHermesSessions({
        sessionIds: [...new Set(hermesIds)],
        cwd: wantedCwd ? target.worktreePath : null,
        platform,
        comparePath: normalizeComparePath,
        includeDefaults: options.includeDefaults,
        customRoots: options.roots?.hermes ?? [],
        ...(options.fresh ? { maxAgeMs: 0 } : {})
      });
      for (const session of hermesSessions) preferBetterSession(bySessionId, session);
    } catch (error) {
      warnings.add(`hermes: could not read the request log (${shortError(error)}).`);
    }
  }

  if (wantedCwd) {
    const roots = await configuredRoots(options.roots, options.includeDefaults !== false);
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
          warnings.add(`${provider}：会话读取失败（${shortError(error)}），未生成估算数据。`);
        }
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
          warnings.add(`opencode：会话读取失败（${shortError(error)}），未生成估算数据。`);
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
      title: safeTitle(target.title) || '当前频道',
      provider: 'channel',
      updatedAt: maxUpdatedAt || Date.now(),
      records: mergedRecords
    },
    warnings: [...warnings]
  };
}

/** Read either a channel target (worktree aggregation) or a single explicitly selected conversation. */
export async function readTargetSession(target, options = {}) {
  if (target && (target.worktreePath !== undefined || Array.isArray(target.sessions))) {
    return readChannelSessions(target, options);
  }
  return readSingleTargetSession(target, options);
}

// ---- Usage totals: every session written in the last 30 days, read whole, once per change. ----

const USAGE_MAX_FILE_BYTES = 256 * 1024 * 1024, USAGE_MAX_UNITS = 20_000, USAGE_MAX_DIRECTORIES = 5_000;

/** Every JSONL session file under a root that was written at or after cutoffMs; subagent folders are skipped. */
async function walkRecentJsonl(root, cutoffMs) {
  const rootStat = await info(root);
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
    } catch { continue; }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!skippedDirectories.has(entry.name.toLowerCase())) queue.push(file);
      } else if (entry.isFile() && /\.jsonl$/i.test(entry.name)) {
        const metadata = await info(file);
        if (metadata?.isFile() && metadata.mtimeMs >= cutoffMs) found.push({ path: file, size: metadata.size, mtimeMs: metadata.mtimeMs });
      }
    }
  }
  return found;
}

const USAGE_STREAM_BATCH_ROWS = 2_000;
const usageObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const usageText = value => typeof value === 'string' && value.trim() && value.length <= 256 ? value.trim() : null;

/** Feeds parsed rows to onBatch in order, one 4 MB read at a time; a trailing unfinished line is not evidence yet. */
async function streamJsonRows(file, onBatch) {
  const decoder = new StringDecoder('utf8');
  let carry = '', batch = [];
  for await (const chunk of createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) {
    const pieces = (carry + decoder.write(chunk)).split('\n');
    carry = pieces.pop();
    for (const line of pieces) {
      const row = parsedRow(line);
      if (row) batch.push(row);
      if (batch.length >= USAGE_STREAM_BATCH_ROWS) { await onBatch(batch); batch = []; }
    }
  }
  if (batch.length) await onBatch(batch);
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

async function addCodexStreamRecords(days, file, minDay) {
  const parser = createCodexParser(await codexSessionId(file), { limit: Infinity });
  await streamJsonRows(file, batch => parser.feed(batch));
  accumulateRecords(days, 'codex', parser.finish(), { minDay });
}

async function addFileRecords(days, provider, file, minDay, isSubagent) {
  const metadata = await info(file);
  if (!metadata?.isFile()) return;
  if (metadata.size > USAGE_MAX_FILE_BYTES) throw Object.assign(new Error('会话文件过大'), { code: 'too_large' });
  const text = await readFile(file, 'utf8');
  const complete = text.slice(0, text.lastIndexOf('\n') + 1);
  const parsed = parseJsonl(complete, provider, '', { isSubagent, limit: Infinity });
  accumulateRecords(days, provider, parsed.records, { minDay });
}

async function fileUsageUnit(provider, file) {
  // Claude keeps subagent calls in <session>/subagents; they belong to the parent session's unit.
  const subagents = provider === 'claude'
    ? (await collectClaudeSubagentCandidates(file.path, path.basename(file.path, '.jsonl'))).map(candidate => ({ path: candidate.path, size: candidate.info.size, mtimeMs: candidate.info.mtimeMs }))
    : [];
  const stamp = [identity(file.path), file.size, file.mtimeMs, ...subagents.map(item => `${item.size}:${item.mtimeMs}`)].join(':');
  return {
    // A switch between mirrored files replaces the same logical unit, including its retained counts.
    key: identity(`${provider}|${path.basename(file.path)}`),
    stamp,
    bytes: file.size + subagents.reduce((sum, item) => sum + item.size, 0),
    mtimeMs: file.mtimeMs,
    read: async () => {
      const minDay = dayKeyAgo(Date.now(), HISTORY_DAYS - 1), days = {};
      if (provider === 'codex') await addCodexStreamRecords(days, file.path, minDay);
      else await addFileRecords(days, provider, file.path, minDay, false);
      for (const item of subagents) await addFileRecords(days, 'claude', item.path, minDay, true);
      return days;
    }
  };
}

async function readOpenCodeSession(dbPath, v2, sessionId) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true, enableExtensionLoading: false });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; PRAGMA trusted_schema=OFF;');
    const messageTable = v2 ? 'session_message' : 'message', orderColumn = v2 ? 'seq' : 'rowid';
    const rows = db.prepare(`SELECT id,${v2 ? 'type' : 'NULL AS type'},time_created,${projectedData()}
      FROM ${messageTable} WHERE session_id=? ORDER BY ${orderColumn} ASC`).all(sessionId);
    const days = {};
    accumulateRecords(days, v2 ? 'opencode2' : 'opencode', parseOpenCodeRows(rows, v2, { limit: Infinity }),
      { minDay: dayKeyAgo(Date.now(), HISTORY_DAYS - 1) });
    return days;
  } finally { db.close(); }
}

/** One unit per OpenCode session updated since cutoffMs; the unit's stamp includes its message count. */
async function openCodeUsageUnits(dbPath, cutoffMs) {
  const database = await info(dbPath);
  if (!database?.isFile()) return [];
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); }
  catch { return []; }
  const units = [];
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, enableExtensionLoading: false });
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; PRAGMA trusted_schema=OFF;');
    const available = tables(db);
    for (const v2 of [false, true]) {
      const table = v2 ? 'session_v2' : 'session', messageTable = v2 ? 'session_message' : 'message';
      if (!available.has(table) || !available.has(messageTable)) continue;
      const sessionColumns = columns(db, table);
      if (!sessionColumns.has('id') || !sessionColumns.has('time_updated')) continue;
      const provider = v2 ? 'opencode2' : 'opencode';
      for (const row of db.prepare(`SELECT id, time_updated FROM ${table} WHERE time_updated >= ?`).all(cutoffMs)) {
        const count = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${messageTable} WHERE session_id=?`).get(row.id)?.n ?? 0);
        units.push({
          key: identity(`${provider}|${dbPath}|${row.id}`),
          stamp: `${row.time_updated}:${count}`,
          bytes: count * 1024,
          mtimeMs: Number(row.time_updated) || 0,
          read: () => readOpenCodeSession(dbPath, v2, row.id)
        });
      }
    }
  } catch { /* An unreadable database contributes no OpenCode units this pass. */ }
  finally { db?.close(); }
  return units;
}

/** Antigravity: one unit per conversation whose transcript was written since cutoffMs; timing comes from its native store. */
async function antigravityUsageUnits(brainRoot, cutoffMs) {
  if (!(await info(brainRoot))?.isDirectory()) return [];
  let entries;
  try { entries = await readdir(brainRoot, { withFileTypes: true }); }
  catch { return []; }
  const units = [];
  for (const entry of entries.slice(0, USAGE_MAX_UNITS)) {
    if (!entry.isDirectory() || !safeSegment(entry.name)) continue;
    const transcript = path.join(brainRoot, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
    const metadata = await info(transcript);
    if (!metadata?.isFile() || metadata.mtimeMs < cutoffMs) continue;
    units.push({
      key: identity(`antigravity|${transcript}`),
      stamp: `${metadata.size}:${metadata.mtimeMs}:${await antigravityNativeStamp(transcript)}`,
      bytes: metadata.size,
      mtimeMs: metadata.mtimeMs,
      read: () => readAntigravityUsage(transcript, entry.name)
    });
  }
  return units;
}

async function readAntigravityUsage(transcript, conversationId) {
  const days = {}, notes = [];
  const text = await readFile(transcript, 'utf8');
  const complete = text.slice(0, text.lastIndexOf('\n') + 1);
  const native = await readAntigravityTimings(transcript, message => notes.push(message));
  const parsed = parseJsonl(complete, 'antigravity', '', { sessionId: conversationId, native, limit: Infinity });
  accumulateRecords(days, 'antigravity', parsed.records, { minDay: dayKeyAgo(Date.now(), HISTORY_DAYS - 1) });
  return days;
}

/** Descriptors for the usage index: Codex, Claude and Pi session files, OpenCode sessions, and Antigravity conversations. */
export async function discoverUsageUnits(cutoffMs, options = {}) {
  const roots = await configuredRoots(options.roots, options.includeDefaults !== false);
  // Mirrors are append-only transcripts. Keep the largest copy; use its modification time to break ties.
  // A sync can give a stale copy a newer mtime, so root order and mtime alone cannot identify the fullest log.
  const units = [];
  for (const provider of ['codex', 'claude', 'pi']) {
    const selected = new Map();
    for (const root of (roots[provider] ?? []).slice(0, 100)) {
      for (const file of await walkRecentJsonl(root, cutoffMs)) {
        const filename = path.basename(file.path), previous = selected.get(filename);
        if (!previous && units.length + selected.size >= USAGE_MAX_UNITS) continue;
        if (!previous || file.size > previous.size || (file.size === previous.size && file.mtimeMs > previous.mtimeMs)) {
          selected.set(filename, file);
        }
      }
    }
    for (const file of selected.values()) units.push(await fileUsageUnit(provider, file));
  }
  for (const root of (roots.opencode ?? []).slice(0, 10)) {
    units.push(...await openCodeUsageUnits(root, cutoffMs));
  }
  for (const root of (roots.antigravity ?? []).slice(0, 10)) {
    units.push(...await antigravityUsageUnits(root, cutoffMs));
  }
  units.push(...await hermesUsageUnits(cutoffMs, options));
  return units;
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
  if (candidates.length > selected.length) warnings.add(`仅读取最近 ${maxSessions} 个文件会话及最多 10 个数据库。`);
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
    } catch (error) { warnings.add(`${candidate.provider}：会话读取失败（${shortError(error)}），未生成估算数据。`); }
  }
  const unique = new Map();
  for (const session of sessions) {
    const previous = unique.get(session.id);
    const completed = session.records[0]?.completedAt ?? 0, oldCompleted = previous?.records[0]?.completedAt ?? 0;
    if (!previous || completed > oldCompleted || (completed === oldCompleted && session.records.length > previous.records.length)) unique.set(session.id, session);
  }
  return { sessions: [...unique.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, maxSessions), warnings: [...warnings] };
}

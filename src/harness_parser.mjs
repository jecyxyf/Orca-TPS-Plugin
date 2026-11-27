import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { setImmediate as yieldToRequests, setTimeout as delay } from 'node:timers/promises';
import { harnessFamily, isSessionHarness, openCodeHarness, OPENCODE_V2, SESSION_HARNESSES } from './harnesses.mjs';
import { openReadonlyDatabase } from './sqlite.mjs';
import {
  SESSION_PROXY_DEDUP_WINDOW_SECONDS, antigravitySessionIdFromPath, antigravityWorkspacePaths, antigravityStepStart,
  antigravityNativeTimings, createCodexParser, createJsonlCursor, json, mergeChannelProxyRecords, mergeProxyRecords,
  object, parseOpenCodeRows, readJsonlMetadata, recentRecords, sha, shortText, string
} from './harness_formats.mjs';
import {
  desktopUsageUnit, fileUnit, hermesSources, list, logFiles, readCopilot, readDeepSeek, readGemini, readGrok,
  readHarnessDatabase, readHermesRecords, readHermesSessions, readKimi, readMiniMax, readOmp, readOpenClaw,
  readOpenClawDb, readWorkBuddy, walkLogTree, workBuddyParent
} from './harness_collectors.mjs';

export {
  SPEED_MIN_OUTPUT_TOKENS, SPEED_MIN_GENERATION_MS, SPEED_ESTIMATE_MIN_OUTPUT_TOKENS, SPEED_ESTIMATE_MIN_DURATION_MS,
  MIN_PLAUSIBLE_LATENCY_MS, MAX_PLAUSIBLE_LATENCY_MS, SESSION_PROXY_DEDUP_WINDOW_SECONDS,
  estimatedLatencyMs, estimatedFirstTokenMs, isSessionLogSource, computeSpeedMetrics, normalizeCodexModel,
  buildHermesRecord, recentRecords, createCodexParser, createClaudeParser, antigravitySessionIdFromPath,
  antigravityWorkspacePaths, antigravityStepStart, antigravityGeneration, antigravityModelId, antigravityNativeTimings,
  readJsonlMetadata, createJsonlCursor, parseJsonl, parseOpenCodeRows, buildProxyRecord, mergeProxyRecords, mergeChannelProxyRecords
} from './harness_formats.mjs';
export { hermesSources, readHermesRecords, readHermesSessions } from './harness_collectors.mjs';

const BACKFILL_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 1500, MAX_DIRECTORIES = 500, MAX_DEPTH = 8, MAX_SUBAGENT_FILES = 200;
const MAX_FILE_BYTES = 16 * 1024 * 1024, MAX_SCAN_BYTES = 64 * 1024 * 1024, MAX_HEADER_BYTES = 262_144;
const USAGE_MAX_FILE_BYTES = 256 * 1024 * 1024, USAGE_MAX_UNITS = 20_000, USAGE_MAX_DIRECTORIES = 5_000;
const USAGE_STREAM_BATCH = 2_000, USAGE_CHUNK_BYTES = 1024 * 1024, ANCHOR_BYTES = 256;

const parseCache = new Map(), headerCache = new Map(), discoveryCache = new Map(), databaseCache = new Map();
const locationCache = new Map(), ccSwitchCache = new Map(), pendingJsonl = new Map(), antigravityWorkspaces = new Map();
const skippedDirectories = new Set(['node_modules', '.git', 'subagents', 'cache', 'plugins', 'skills', 'auth', 'credentials']);
const shortError = error => typeof error?.code === 'string' ? error.code : ['notice.read-failed'];
const identity = value => sha(value).slice(0, 24);
const safeTitle = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200) : '';
const safeSegment = value => typeof value === 'string' && value.length > 0 && value.length <= 256 &&
  value !== '.' && value !== '..' && !/[\\/\u0000]/.test(value);
const fileIdentity = meta => `${meta.dev}:${meta.ino}:${meta.birthtimeMs}`;
const fileStamp = meta => `${fileIdentity(meta)}:${meta.size}:${meta.mtimeMs}:${meta.ctimeMs}`;
const trimCache = (cache, limit) => { while (cache.size > limit) cache.delete(cache.keys().next().value); };
const columns = (db, table) => new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map(row => row.name));
const tables = db => new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));

export function normalizeComparePath(rawPath, platform = process.platform) {
  if (typeof rawPath !== 'string') return null;
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.length > 4096 || /[\u0000\r\n]/.test(trimmed)) return null;
  if (platform === 'win32' || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    const unc = /^[/\\]{2}/.test(trimmed) ? '\\\\' : '';
    const full = (unc + trimmed.replace(/^[/\\]+/, '').replace(/[/\\]+/g, '\\').replace(/\\+$/, '')).toLowerCase();
    return /^[a-z]:$/.test(full) ? `${full}\\` : full;
  }
  const norm = trimmed.replace(/\/+/g, '/');
  return norm.length > 1 ? norm.replace(/\/+$/, '') : norm;
}

export function defaultRoots({ home = homedir(), env = process.env, platform = process.platform } = {}) {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const userData = env.ORCA_USER_DATA_PATH || (platform === 'win32'
    ? join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'orca')
    : platform === 'darwin' ? join(home, 'Library', 'Application Support', 'orca')
      : join(env.XDG_CONFIG_HOME || join(home, '.config'), 'orca'));
  const data = env.XDG_DATA_HOME || join(home, '.local', 'share');
  const ccSwitchDb = env.CC_SWITCH_DB_PATH || join(home, '.cc-switch', 'cc-switch.db');
  return {
    roots: {
      codex: [env.CODEX_HOME || join(home, '.codex'), join(home, '.codex'),
        join(userData, 'codex-runtime-home', 'home')].flatMap(base => [join(base, 'sessions'), join(base, 'archived_sessions')]),
      claude: [join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects'), join(home, '.claude', 'projects')],
      opencode: [env.OPENCODE_DB && env.OPENCODE_DB !== ':memory:' ? path.isAbsolute(env.OPENCODE_DB) ? env.OPENCODE_DB : join(data, 'opencode', env.OPENCODE_DB) : join(data, 'opencode', 'opencode.db')],
      pi: [join(env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent'), 'sessions')],
      antigravity: [join(home, '.gemini', 'antigravity-cli', 'brain')],
      hermes: [env.HERMES_HOME, ...(platform === 'win32' ? [join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'hermes')] : []),
        join(home, '.hermes')].filter(Boolean)
    }, userData, ccSwitchDb
  };
}

export function reportDiscoveryError(error, onUnavailable) {
  if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') onUnavailable?.();
}

export async function configuredRoots(custom = {}, includeDefaults = true, onUnavailable) {
  const defaults = defaultRoots(), roots = {};
  for (const provider of SESSION_HARNESSES) {
    const values = Array.isArray(custom[provider]) ? custom[provider] : [];
    roots[provider] = [...new Set([...(includeDefaults ? defaults.roots[provider] : []), ...values]
      .filter(v => typeof v === 'string' && v.trim()).map(v => path.resolve(v.replace(/^~(?=$|[\\/])/, homedir()))))];
  }
  if (includeDefaults) for (const provider of ['codex', 'claude']) {
    const accountsRoot = path.join(defaults.userData, provider === 'codex' ? 'codex-accounts' : 'claude-profiles');
    try {
      for (const entry of (await readdir(accountsRoot, { withFileTypes: true })).slice(0, 100)) {
        if (entry.isDirectory()) roots[provider].push(path.join(accountsRoot, entry.name, 'home', provider === 'codex' ? 'sessions' : 'projects'));
      }
    } catch (error) { reportDiscoveryError(error, onUnavailable); }
  }
  return roots;
}

class ReadWarnings {
  #entries = new Map();
  add(code, ...args) { const w = [code, ...args]; this.#entries.set(JSON.stringify(w), w); }
  get size() { return this.#entries.size; }
  [Symbol.iterator]() { return this.#entries.values(); }
}
const replayWarnings = (warnings, cached) => { for (const [code, ...args] of cached?.warnings ?? []) warnings.add(code, ...args); };
const info = (file, onUnavailable) => stat(file).catch(error => { reportDiscoveryError(error, onUnavailable); return null; });

async function discover(provider, root, warnings, { maxAgeMs = 20_000 } = {}) {
  const key = `${provider}:${root}`, cached = discoveryCache.get(key);
  if (maxAgeMs > 0 && cached && Date.now() - cached.at < maxAgeMs) { replayWarnings(warnings, cached); return cached.files; }
  if (root === path.parse(root).root || root === homedir()) { warnings.add('notice.invalid-session-folder', provider); return []; }
  const rootStat = await info(root);
  if (!rootStat) return [];
  const files = [], sourceWarnings = new ReadWarnings();
  if (provider === 'antigravity' && rootStat.isDirectory()) {
    try {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (files.length >= MAX_FILES) { sourceWarnings.add('notice.antigravity-scan-limit'); break; }
        if (!entry.isDirectory() || !safeSegment(entry.name)) continue;
        const file = path.join(root, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
        if ((await info(file))?.isFile()) files.push(file);
      }
    } catch (error) { sourceWarnings.add('notice.antigravity-partial-scan', shortError(error)); }
  } else {
    const matches = f => provider === 'opencode' ? /\.(?:db|sqlite|sqlite3)$/i.test(f) : /\.jsonl$/i.test(f);
    if (rootStat.isFile()) return matches(root) ? [root] : [];
    let limited = false;
    for await (const file of walkLogTree(root, {
      maxDepth: MAX_DEPTH, maxDirectories: MAX_DIRECTORIES, deduplicate: true, newestFirst: true, matches,
      skip: name => skippedDirectories.has(name.toLowerCase()), onLimit: () => { limited = true; },
      onError: error => sourceWarnings.add('notice.partial-session-scan', provider, shortError(error))
    })) {
      files.push(file);
      if (files.length >= MAX_FILES) { limited = true; break; }
    }
    if (limited) sourceWarnings.add('notice.session-scan-limit', provider);
  }
  const result = { at: Date.now(), files, warnings: [...sourceWarnings] };
  replayWarnings(warnings, result);
  discoveryCache.set(key, result); trimCache(discoveryCache, 32);
  return files;
}

function antigravityNativeDbPath(transcriptPath) {
  const sessionId = antigravitySessionIdFromPath(transcriptPath);
  if (!sessionId || !safeSegment(sessionId)) return null;
  const brainDir = path.dirname(path.dirname(path.dirname(path.dirname(transcriptPath))));
  return path.basename(brainDir) === 'brain' ? path.join(path.dirname(brainDir), 'conversations', `${sessionId}.db`) : null;
}

async function antigravityNativeStamp(transcriptPath) {
  const dbPath = antigravityNativeDbPath(transcriptPath), database = dbPath ? await info(dbPath) : null;
  if (!database?.isFile()) return 'native:none';
  const wal = await info(`${dbPath}-wal`);
  return `native:${fileStamp(database)}:${wal ? fileStamp(wal) : ''}`;
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
    db = openReadonlyDatabase(dbPath);
    const row = tables(db).has('trajectory_metadata_blob')
      ? db.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main' AND length(data) <= 262144").get() : null;
    const win = platform === 'win32', pathApi = win ? path.win32 : path.posix;
    let workspace = null;
    for (const candidate of antigravityWorkspacePaths(row?.data)) {
      let directory;
      try { directory = candidate.startsWith('file:') ? fileURLToPath(candidate, { windows: win }) : candidate; } catch { continue; }
      if (pathApi.isAbsolute(directory) && (workspace = normalizeComparePath(directory, platform))) break;
    }
    antigravityWorkspaces.set(key, { stamp, workspace }); trimCache(antigravityWorkspaces, 256);
    return workspace;
  } finally { db?.close(); }
}

async function readAntigravityTimings(transcriptPath, note) {
  const dbPath = antigravityNativeDbPath(transcriptPath), database = dbPath ? await info(dbPath) : null;
  if (!database?.isFile()) return new Map();
  let db;
  try {
    db = openReadonlyDatabase(dbPath, 500);
    const steps = db.prepare('SELECT idx, metadata FROM steps WHERE step_type = 15').all();
    const genQuery = db.prepare('SELECT data FROM gen_metadata WHERE idx = ?'), generations = new Map();
    for (const step of steps) {
      const idx = antigravityStepStart(step.metadata)?.generationIndex;
      if (idx == null || generations.has(idx)) continue;
      const row = genQuery.get(idx);
      if (row?.data) generations.set(idx, row.data);
    }
    return antigravityNativeTimings(steps, generations);
  } catch (error) { note?.('notice.antigravity-database-unavailable', shortError(error)); return new Map(); }
  finally { db?.close(); }
}

async function readAt(file, start, length) {
  const buffer = Buffer.alloc(length), { bytesRead } = await file.read(buffer, 0, length, start);
  return buffer.subarray(0, bytesRead);
}
const anchorAt = async (file, start, length) => {
  const bytes = await readAt(file, start, length);
  return bytes.length === length ? createHash('sha256').update(bytes).digest('hex') : null;
};
const writeAnchors = async (file, offset) => {
  const length = Math.min(ANCHOR_BYTES, offset);
  return length ? Promise.all([...new Set([0, offset - length])].map(async start => ({ start, length, hash: await anchorAt(file, start, length) }))) : [];
};
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
  const key = `${candidate.provider}:${candidate.path}:${isSubagent ? 'sub' : 'main'}`, pending = pendingJsonl.get(key);
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
  const stamp = sourceStamp + ':' + (candidate.provider === 'antigravity' ? await antigravityNativeStamp(candidate.path) : '');
  const cached = parseCache.get(key);
  const matches = r => expectedSessionId === undefined || (isSubagent && !r?.sourceSessionId) || r?.sourceSessionId === expectedSessionId;
  if (cached?.stamp === stamp) { replayWarnings(warnings, cached); return matches(cached) ? cached.session : null; }
  let file;
  try {
    const sourceWarnings = [];
    let cursor = cached?.cursor, nextOffset = cached?.nextOffset ?? 0, anchors = cached?.anchors, startOffset = cached?.startOffset ?? 0;
    if (cached?.sourceStamp !== sourceStamp) {
      file = await open(candidate.path, 'r');
      const opened = await file.stat();
      if (fileIdentity(opened) !== fileIdentity(candidate.info) || opened.size < candidate.info.size) {
        throw Object.assign(new Error('Log changed while opening'), { code: 'EAGAIN' });
      }
      const size = candidate.info.size;
      const append = cursor && nextOffset > startOffset && (cursor.sessionId || isSubagent) &&
        cached.identity === fileIdentity(candidate.info) && size > cached.size &&
        size - nextOffset <= MAX_FILE_BYTES && size - startOffset <= MAX_SCAN_BYTES && await matchAnchors(file, anchors, budget);
      const offset = append ? nextOffset : Math.max(0, size - MAX_FILE_BYTES), bytes = size - offset;
      if (bytes > budget.remaining) { warnings.add('notice.read-size-limit'); replayWarnings(warnings, cached); return matches(cached) ? cached?.session ?? null : null; }
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
    if (startOffset > 0) sourceWarnings.push(['notice.large-session', candidate.provider]);
    const native = candidate.provider === 'antigravity'
      ? await readAntigravityTimings(candidate.path, (...w) => sourceWarnings.push(w)) : undefined;
    const sessionId = cursor.sessionId || path.basename(candidate.path, '.jsonl');
    const session = {
      id: `${candidate.provider}:${sessionId || identity(candidate.path)}`, title: `${candidate.provider} · ${sessionId.slice(-20)}`,
      provider: candidate.provider, path: candidate.path, updatedAt: candidate.info.mtimeMs,
      records: cursor.finish(native), ...(cursor.cwd ? { cwd: cursor.cwd } : {})
    };
    const result = {
      stamp, sourceStamp, identity: fileIdentity(candidate.info), size: candidate.info.size, cursor,
      nextOffset, anchors, startOffset, session, sourceSessionId: cursor.sessionId, warnings: sourceWarnings
    };
    replayWarnings(warnings, result);
    parseCache.set(key, result); trimCache(parseCache, 24);
    return matches(result) ? session : null;
  } catch (error) { parseCache.delete(key); throw error; }
  finally { await file?.close(); }
}

async function collectClaudeSubagents(mainPath, sessionId, onUnavailable) {
  if (!safeSegment(sessionId)) return [];
  const subDir = path.join(path.dirname(mainPath), sessionId, 'subagents');
  if (!(await info(subDir, onUnavailable))?.isDirectory()) return [];
  const paths = [];
  try {
    for (const entry of await readdir(subDir, { withFileTypes: true })) {
      if (entry.isFile() && /\.jsonl$/i.test(entry.name)) paths.push(path.join(subDir, entry.name));
      else if (entry.isDirectory() && entry.name === 'workflows') {
        const wfRoot = path.join(subDir, 'workflows');
        for (const wf of (await readdir(wfRoot, { withFileTypes: true }).catch(e => { reportDiscoveryError(e, onUnavailable); return []; })).slice(0, 50)) {
          if (!wf.isDirectory()) continue;
          const wfPath = path.join(wfRoot, wf.name);
          for (const f of await readdir(wfPath, { withFileTypes: true }).catch(e => { reportDiscoveryError(e, onUnavailable); return []; })) {
            if (f.isFile() && /\.jsonl$/i.test(f.name)) paths.push(path.join(wfPath, f.name));
          }
        }
      }
    }
  } catch (error) { reportDiscoveryError(error, onUnavailable); return []; }
  const candidates = [], seen = new Set();
  for (const file of paths) {
    const c = await candidateFor('claude', file, onUnavailable);
    if (c && !seen.has(c.path)) { seen.add(c.path); candidates.push(c); }
  }
  return candidates.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs).slice(0, MAX_SUBAGENT_FILES);
}

async function attachClaudeSubagents(session, rawSessionId, budget, warnings) {
  if (!session || session.provider !== 'claude' || !rawSessionId) return session;
  const subs = await collectClaudeSubagents(session.path, rawSessionId);
  if (!subs.length) return session;
  const all = [...session.records];
  let maxUpdated = session.updatedAt;
  for (const sub of subs) {
    try {
      const subSession = await readJsonl(sub, budget, warnings, rawSessionId, { isSubagent: true });
      if (subSession?.records?.length) { all.push(...subSession.records); maxUpdated = Math.max(maxUpdated, sub.info.mtimeMs); }
    } catch (error) { warnings.add('notice.claude-subagent-unavailable', shortError(error)); }
  }
  return { ...session, updatedAt: maxUpdated, records: recentRecords(all) };
}

const projectedData = () => `CASE WHEN json_valid(data) THEN json_object(
  'role',json_extract(data,'$.role'), 'tokens',json_extract(data,'$.tokens'), 'time',json_extract(data,'$.time'),
  'model',json_extract(data,'$.model'), 'modelID',json_extract(data,'$.modelID'), 'modelId',json_extract(data,'$.modelId'),
  'finish',json_extract(data,'$.finish'), 'status',json_extract(data,'$.status')) ELSE '{}' END AS data`;

async function readDatabase(candidate, maxSessions, warnings, target) {
  const wal = await info(`${candidate.path}-wal`);
  const stamp = `${fileStamp(candidate.info)}:${wal ? fileStamp(wal) : ''}:${maxSessions}`;
  const cacheKey = target?.cwdFilter ? JSON.stringify([candidate.path, 'cwd', target.cwdFilter, target.platform || ''])
    : target ? JSON.stringify([candidate.path, target.provider, target.sessionId]) : candidate.path;
  const cached = databaseCache.get(cacheKey);
  if (cached?.stamp === stamp) { replayWarnings(warnings, cached); return cached.sessions; }
  let db;
  try {
    db = openReadonlyDatabase(candidate.path, 1000);
    db.exec('BEGIN');
    const available = tables(db), sessions = [], seen = new Set(), sourceWarnings = new ReadWarnings();
    for (const v2 of [true, false]) {
      if (target && !target.cwdFilter && (target.provider === OPENCODE_V2) !== v2) continue;
      const table = v2 ? 'session_v2' : 'session', msgTable = v2 ? 'session_message' : 'message';
      if (!available.has(table) || !available.has(msgTable)) continue;
      const sCols = columns(db, table), mCols = columns(db, msgTable);
      if (!sCols.has('id') || !['id', 'session_id', 'data', 'time_created'].every(k => mCols.has(k))) continue;
      if (v2 && (!mCols.has('seq') || !mCols.has('type'))) continue;
      if (target?.cwdFilter && !sCols.has('directory')) continue;
      const sel = col => sCols.has(col) ? `"${col}"` : `NULL AS "${col}"`;
      const order = sCols.has('time_updated') ? 'time_updated DESC' : 'id DESC';
      const parentFilter = sCols.has('parent_id') ? "WHERE parent_id IS NULL OR parent_id = ''" : '';
      const selection = `SELECT id,${sel('title')},${sel('directory')},${sel('time_updated')} FROM ${table}`;
      let metadata;
      if (target?.cwdFilter) {
        metadata = [];
        for (const meta of db.prepare(`${selection} ${parentFilter} ORDER BY ${order}`).iterate()) {
          if (typeof meta.directory !== 'string' || normalizeComparePath(meta.directory, target.platform) !== target.cwdFilter) continue;
          if ((metadata.push(meta)) >= maxSessions) break;
        }
      } else metadata = target ? db.prepare(`${selection} WHERE id=?`).all(target.sessionId)
        : db.prepare(`${selection} ${parentFilter} ORDER BY ${order} LIMIT ?`).all(maxSessions);
      const orderCol = v2 ? 'seq' : 'rowid';
      const msgQuery = db.prepare(`SELECT id,${v2 ? 'type' : 'NULL AS type'},time_created,${projectedData()}
        FROM ${msgTable} WHERE session_id=? ORDER BY ${orderCol} DESC LIMIT 10001`);
      for (const meta of metadata) {
        if (seen.has(meta.id)) continue;
        seen.add(meta.id);
        const provider = openCodeHarness(v2), batch = msgQuery.all(meta.id);
        if (batch.length > 10_000) sourceWarnings.add('notice.opencode-message-limit');
        sessions.push({
          id: `${provider}:${meta.id}`, title: safeTitle(meta.title) || `${provider} · ${String(meta.id).slice(-20)}`,
          provider, path: candidate.path, updatedAt: Number.isFinite(meta.time_updated) ? meta.time_updated : candidate.info.mtimeMs,
          ...(typeof meta.directory === 'string' ? { cwd: meta.directory } : {}),
          records: parseOpenCodeRows(batch.slice(0, 10_000).reverse(), v2)
        });
      }
    }
    if (!sessions.length && !available.has('session') && !available.has('session_v2')) sourceWarnings.add('notice.opencode-schema-unavailable');
    const result = { stamp, sessions, warnings: [...sourceWarnings] };
    replayWarnings(warnings, result);
    databaseCache.set(cacheKey, result); trimCache(databaseCache, 24);
    return sessions;
  } finally { db?.close(); }
}

async function readCcSwitchProxyRows(dbPath, provider, sessionId, records) {
  if (typeof dbPath !== 'string' || !dbPath || dbPath.includes('\0')) return [];
  let canonical;
  try { canonical = await realpath(dbPath); } catch { return []; }
  const dbInfo = await info(canonical);
  if (!dbInfo?.isFile()) return [];
  const wal = await info(`${canonical}-wal`);
  const times = records.map(r => r.createdAtSec).filter(Number.isFinite);
  const minSec = times.length ? Math.min(...times) - SESSION_PROXY_DEDUP_WINDOW_SECONDS : null;
  const maxSec = times.length ? Math.max(...times) + SESSION_PROXY_DEDUP_WINDOW_SECONDS : null;
  const stamp = `${fileStamp(dbInfo)}:${wal ? fileStamp(wal) : ''}`;
  const cacheKey = JSON.stringify([canonical, provider, sessionId, minSec, maxSec]);
  const cached = ccSwitchCache.get(cacheKey);
  if (cached?.stamp === stamp) return cached.rows;
  let db;
  try {
    db = openReadonlyDatabase(canonical, 500);
    if (!tables(db).has('proxy_request_logs')) { ccSwitchCache.set(cacheKey, { stamp, rows: [] }); trimCache(ccSwitchCache, 32); return []; }
    const cols = columns(db, 'proxy_request_logs');
    const req = ['request_id', 'app_type', 'model', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'latency_ms', 'first_token_ms', 'status_code', 'created_at'];
    if (!req.every(col => cols.has(col))) return [];
    const opt = (col, fb = 'NULL') => cols.has(col) ? `"${col}"` : `${fb} AS "${col}"`;
    const family = harnessFamily(provider), params = family === 'claude' ? [] : [family], scope = [];
    if (cols.has('session_id') && sessionId) { scope.push('session_id = ?'); params.push(sessionId); }
    if (minSec !== null && maxSec !== null) { scope.push('(created_at >= ? AND created_at <= ?)'); params.push(minSec, maxSec); }
    if (!scope.length) return [];
    const rows = db.prepare(`SELECT request_id, ${opt('session_id')}, app_type, model, ${opt('request_model')},
      ${opt('pricing_model')}, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
      ${opt('input_token_semantics', '0')}, latency_ms, first_token_ms, created_at FROM proxy_request_logs
      WHERE ${cols.has('data_source') ? "COALESCE(data_source, 'proxy') = 'proxy'" : '1 = 1'}
        AND status_code >= 200 AND status_code < 300 AND (${family === 'claude' ? "app_type IN ('claude', 'claude-desktop')" : 'app_type = ?'})
        AND (${scope.join(' OR ')}) ORDER BY created_at DESC LIMIT 500`).all(...params);
    ccSwitchCache.set(cacheKey, { stamp, rows }); trimCache(ccSwitchCache, 32);
    return rows;
  } catch { return []; }
  finally { db?.close(); }
}

async function candidateFor(provider, file, onUnavailable) {
  if (typeof file !== 'string' || !file || file.includes('\0')) return null;
  let canonical;
  try { canonical = await realpath(file); } catch (error) { reportDiscoveryError(error, onUnavailable); return null; }
  const metadata = await info(canonical, onUnavailable);
  return metadata?.isFile() ? { provider, path: canonical, info: metadata } : null;
}

const bestSession = sessions => sessions.sort((a, b) => (b.records[0]?.completedAt ?? 0) - (a.records[0]?.completedAt ?? 0) ||
  b.records.length - a.records.length || b.updatedAt - a.updatedAt)[0] ?? null;

async function headerMeta(candidate, budget) {
  const cacheKey = `${candidate.provider}:${candidate.path}`, stamp = fileStamp(candidate.info);
  const id = fileIdentity(candidate.info), size = candidate.info.size;
  const mainCached = parseCache.get(`${cacheKey}:main`);
  if (mainCached?.sourceStamp === stamp) return { stamp, sessionId: mainCached.sourceSessionId ?? null, cwd: mainCached.session?.cwd ?? null };
  const cached = headerCache.get(cacheKey);
  if (cached?.stamp === stamp) return cached;
  const maxBytes = Math.min(size, MAX_HEADER_BYTES), firstBytes = Math.min(size, 32_768);
  if (firstBytes > budget.remaining) return null;
  const file = await open(candidate.path, 'r');
  try {
    const reusable = cached?.identity === id && cached.size < size && cached.sessionId && cached.cwd ? cached : null;
    if (reusable && await matchAnchors(file, reusable.anchors, budget)) {
      const meta = { ...reusable, stamp, size }; headerCache.set(cacheKey, meta); return meta;
    }
    if (firstBytes > budget.remaining) return null;
    let length = firstBytes, parsed = { sessionId: null, cwd: null }, anchor;
    for (;;) {
      budget.remaining -= length === firstBytes ? firstBytes : length - firstBytes;
      const buf = Buffer.alloc(length), res = await file.read(buf, 0, length, 0);
      const text = buf.subarray(0, res.bytesRead).toString('utf8'), nl = text.lastIndexOf('\n');
      if (nl >= 0) parsed = readJsonlMetadata(text.slice(0, nl + 1), candidate.provider);
      if (length > 0 && !anchor) {
        const head = buf.subarray(0, Math.min(res.bytesRead, ANCHOR_BYTES));
        if (head.length) anchor = { start: 0, length: head.length, hash: createHash('sha256').update(head).digest('hex') };
      }
      if ((nl >= 0 && parsed.sessionId && parsed.cwd) || length >= maxBytes) break;
      if (maxBytes - length > budget.remaining) return null;
      length = maxBytes;
    }
    const meta = { stamp, identity: id, size, anchors: anchor ? [anchor] : [], sessionId: parsed.sessionId ?? null, cwd: parsed.cwd ?? null };
    headerCache.set(cacheKey, meta); trimCache(headerCache, 256);
    return meta;
  } finally { await file.close(); }
}

function preferBetterSession(map, session) {
  if (!session) return;
  const prev = map.get(session.id), cur = session.records[0]?.completedAt ?? 0, old = prev?.records[0]?.completedAt ?? 0;
  if (!prev || cur > old || (cur === old && session.records.length > prev.records.length)) map.set(session.id, session);
}

async function readSingleTargetSession(target, options = {}) {
  const warnings = new ReadWarnings(), budget = { remaining: MAX_SCAN_BYTES };
  if (!target || !isSessionHarness(target.provider) || typeof target.sessionId !== 'string' || !target.sessionId || target.sessionId.length > 256) {
    return { session: null, warnings: [['notice.session-unidentified']] };
  }
  const isDb = harnessFamily(target.provider) === 'opencode', rootProvider = isDb ? 'opencode' : target.provider;
  const explicitPath = isDb ? target.dbPath : target.transcriptPath;
  const ccSwitchDb = options.skipProxyMerge ? null : options.ccSwitchDb !== undefined ? options.ccSwitchDb : (options.includeDefaults !== false ? defaultRoots().ccSwitchDb : null);

  const read = async candidate => {
    try {
      if (isDb) return bestSession(await readDatabase(candidate, 100, warnings, target));
      const main = await readJsonl(candidate, budget, warnings, target.sessionId);
      return main && target.provider === 'claude' ? attachClaudeSubagents(main, target.sessionId, budget, warnings) : main;
    } catch (error) { warnings.add('notice.session-read-failed', target.provider, shortError(error)); return null; }
  };
  const finish = async session => {
    if (!session) { warnings.add('notice.local-session-not-found'); return { session: null, warnings: [...warnings] }; }
    let records = session.records;
    if (ccSwitchDb) {
      const proxyRows = await readCcSwitchProxyRows(ccSwitchDb, target.provider, target.sessionId, records);
      if (proxyRows.length) records = mergeProxyRecords(records, proxyRows, target.provider, target.sessionId);
    }
    records = records.map(rec => rec ? { ...rec, provider: session.provider } : rec).filter(Boolean);
    return {
      session: { ...session, records, ...(safeTitle(target.title) ? { title: safeTitle(target.title) } : {}) },
      warnings: [...warnings],
      ...(options.includeUsageRecords ? { usageRecords: session.records.map(r => ({ ...r, provider: session.provider, sessionId: target.sessionId })) } : {})
    };
  };
  if (target.provider === 'hermes') {
    const roots = await configuredRoots(options.roots, options.includeDefaults !== false);
    return finish(bestSession(await readHermesSessions(roots.hermes, { sessionIds: [target.sessionId], warn: c => warnings.add(c) })));
  }
  if (explicitPath != null) {
    const candidate = await candidateFor(target.provider, explicitPath);
    return finish(candidate ? await read(candidate) : null);
  }
  const roots = await configuredRoots(options.roots, options.includeDefaults !== false);
  const providerRoots = (roots[rootProvider] ?? []).slice(0, 100);
  const lookupKey = JSON.stringify([target.provider, target.sessionId, providerRoots]);
  const saved = locationCache.get(lookupKey);
  if (!options.fresh && saved && Date.now() - saved.at < 20_000) {
    const sessions = [];
    for (const file of saved.paths) {
      const c = await candidateFor(target.provider, file), s = c ? await read(c) : null;
      if (s) sessions.push(s);
    }
    if (sessions.length) return finish(bestSession(sessions));
    locationCache.delete(lookupKey);
  }
  const files = new Set(), maxAgeMs = options.fresh ? 0 : 20_000;
  for (const root of providerRoots) for (const file of await discover(rootProvider, root, warnings, { maxAgeMs })) files.add(file);
  const nameMatches = file => target.provider === 'antigravity' ? antigravitySessionIdFromPath(file) === target.sessionId : (() => {
    const name = path.basename(file, path.extname(file));
    return name === target.sessionId || name.endsWith(`-${target.sessionId}`) || name.endsWith(`_${target.sessionId}`);
  })();
  const sessions = [], matchedPaths = [];
  const visit = async (file, checkHeader) => {
    try {
      const c = await candidateFor(target.provider, file);
      if (!c || (checkHeader && (await headerMeta(c, budget))?.sessionId !== target.sessionId)) return;
      const s = await read(c);
      if (s) { sessions.push(s); matchedPaths.push(c.path); }
    } catch (error) { warnings.add('notice.session-read-failed', target.provider, shortError(error)); }
  };
  if (isDb) for (const file of files) await visit(file, false);
  else {
    for (const file of files) if (nameMatches(file)) await visit(file, false);
    if (!sessions.length && target.provider !== 'antigravity') for (const file of files) if (!nameMatches(file)) await visit(file, true);
  }
  if (matchedPaths.length) { locationCache.set(lookupKey, { at: Date.now(), paths: [...new Set(matchedPaths)] }); trimCache(locationCache, 32); }
  return finish(bestSession(sessions));
}

async function readChannelSessions(target, options = {}) {
  const platform = options.platform || process.platform;
  const wantedCwd = target.worktreePath ? normalizeComparePath(target.worktreePath, platform) : null;
  const explicit = Array.isArray(target.sessions) ? target.sessions : [];
  if (!wantedCwd && !explicit.length) return { session: null, warnings: [['notice.channel-unidentified']] };
  const warnings = new ReadWarnings(), byId = new Map(), hermesIds = [];
  for (const entry of explicit) {
    if (entry?.provider === 'hermes') { if (safeSegment(entry.sessionId)) hermesIds.push(entry.sessionId); continue; }
    const res = await readSingleTargetSession(entry, { ...options, skipProxyMerge: true });
    replayWarnings(warnings, res);
    if (res.session) preferBetterSession(byId, res.session);
  }
  const roots = wantedCwd || hermesIds.length ? await configuredRoots(options.roots, options.includeDefaults !== false) : null;
  if (roots) {
    for (const s of await readHermesSessions(roots.hermes, {
      sessionIds: hermesIds, worktree: wantedCwd, comparePath: v => normalizeComparePath(v, platform), warn: c => warnings.add(c)
    })) preferBetterSession(byId, s);
  }
  if (wantedCwd) {
    const budget = { remaining: MAX_SCAN_BYTES }, maxAgeMs = options.fresh ? 0 : 4_000;
    for (const provider of ['codex', 'claude', 'pi']) {
      const seenPaths = new Set(), candidates = [];
      for (const root of (roots[provider] ?? []).slice(0, 100)) {
        for (const file of await discover(provider, root, warnings, { maxAgeMs })) {
          const c = await candidateFor(provider, file);
          if (c && !seenPaths.has(c.path)) { seenPaths.add(c.path); candidates.push(c); }
        }
      }
      candidates.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
      for (const c of candidates) {
        try {
          const meta = await headerMeta(c, budget);
          if (!meta?.cwd || normalizeComparePath(meta.cwd, platform) !== wantedCwd) continue;
          let s = await readJsonl(c, budget, warnings);
          if (s && provider === 'claude') s = await attachClaudeSubagents(s, s.id.slice('claude:'.length), budget, warnings);
          if (s) preferBetterSession(byId, s);
        } catch (error) { warnings.add('notice.session-read-failed', provider, shortError(error)); }
      }
    }
    const agyFiles = new Set();
    for (const root of (roots.antigravity ?? []).slice(0, 100)) for (const f of await discover('antigravity', root, warnings, { maxAgeMs })) agyFiles.add(f);
    for (const file of agyFiles) {
      try {
        const sid = antigravitySessionIdFromPath(file);
        if (!sid || byId.has('antigravity:' + sid) || await antigravityWorkspace(file, platform) !== wantedCwd) continue;
        const c = await candidateFor('antigravity', file);
        if (c) preferBetterSession(byId, await readJsonl(c, budget, warnings, sid));
      } catch { warnings.add('notice.antigravity-location-unavailable'); }
    }
    const seenDb = new Set();
    for (const root of (roots.opencode ?? []).slice(0, 10)) for (const file of await discover('opencode', root, warnings, { maxAgeMs })) {
      const c = await candidateFor('opencode', file);
      if (!c || seenDb.has(c.path)) continue;
      seenDb.add(c.path);
      try { for (const s of await readDatabase(c, 100, warnings, { cwdFilter: wantedCwd, platform })) preferBetterSession(byId, s); }
      catch (error) { warnings.add('notice.opencode-session-read-failed', shortError(error)); }
    }
  }
  const ccSwitchDb = options.ccSwitchDb !== undefined ? options.ccSwitchDb : (options.includeDefaults !== false ? defaultRoots().ccSwitchDb : null);
  const proxyEntries = [];
  let maxUpdatedAt = 0;
  for (const session of byId.values()) {
    maxUpdatedAt = Math.max(maxUpdatedAt, session.updatedAt);
    const rawId = session.id.slice(session.provider.length + 1);
    const proxyRows = ccSwitchDb && rawId ? await readCcSwitchProxyRows(ccSwitchDb, session.provider, rawId, session.records) : [];
    proxyEntries.push({ provider: session.provider, sessionId: rawId, records: session.records, proxyRows });
  }
  const mergedRecords = mergeChannelProxyRecords(proxyEntries);
  if (!mergedRecords.length && warnings.size) return { session: null, warnings: [...warnings] };
  return {
    session: { id: `channel:${target.worktreeId || target.key || 'active'}`, title: safeTitle(target.title), provider: 'channel', updatedAt: maxUpdatedAt || Date.now(), records: mergedRecords },
    warnings: [...warnings],
    ...(options.includeUsageRecords ? { usageRecords: recentRecords(proxyEntries.flatMap(e => e.records.map(r => ({ ...r, provider: e.provider, sessionId: e.sessionId })))) } : {})
  };
}

export const readTargetSession = (target, options = {}) =>
  target && (target.worktreePath !== undefined || Array.isArray(target.sessions))
    ? readChannelSessions(target, options) : readSingleTargetSession(target, options);

export async function enrichChannelRecords(records, sessions, ccSwitchDb = defaultRoots().ccSwitchDb) {
  const entries = new Map(), keyOf = ({ provider, sessionId }) => JSON.stringify([provider, sessionId ?? '']);
  for (const { provider, sessionId } of sessions) entries.set(keyOf({ provider, sessionId }), { provider, sessionId, records: [] });
  for (const row of records) (entries.get(keyOf(row)) ?? entries.set(keyOf(row), { provider: row.provider, sessionId: row.sessionId, records: [] }).get(keyOf(row))).records.push(row);
  const sources = [...entries.values()];
  for (const entry of sources) entry.proxyRows = await readCcSwitchProxyRows(ccSwitchDb, entry.provider, entry.sessionId, entry.records);
  return mergeChannelProxyRecords(sources);
}

function readPacer() {
  let spent = 0;
  return async bytes => {
    spent += bytes;
    if (spent >= BACKFILL_BYTES) { spent %= BACKFILL_BYTES; await delay(250); }
    else await yieldToRequests();
  };
}

async function streamCompleteText(file, onChunk, pace) {
  const decoder = new StringDecoder('utf8'), meta = await stat(file);
  if (!meta.size) return true;
  let carry = '', read = 0;
  for await (const chunk of createReadStream(file, { highWaterMark: USAGE_CHUNK_BYTES, end: meta.size - 1 })) {
    const text = carry + decoder.write(chunk), end = text.lastIndexOf('\n') + 1;
    if (end) await onChunk(text.slice(0, end));
    carry = text.slice(end);
    read += chunk.length;
    await pace(chunk.length);
  }
  if (read !== meta.size) throw new Error('TPS usage file changed while reading');
  if (carry.trim()) { if (!json(carry)) return false; await onChunk(carry + '\n'); }
  return true;
}

async function codexSessionId(file) {
  const handle = await open(file, 'r');
  try {
    const size = Math.min(MAX_HEADER_BYTES, (await handle.stat()).size), buf = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buf, 0, size, 0);
    for (const line of buf.subarray(0, bytesRead).toString('utf8').split('\n').slice(0, 30)) {
      const row = json(line);
      if (row?.type === 'session_meta') return shortText(object(row.payload)?.id);
    }
    return null;
  } finally { await handle.close(); }
}

async function readCodexStream(file, cutoff, pace) {
  const sessionId = await codexSessionId(file), parser = createCodexParser(sessionId, { limit: Infinity });
  const complete = await streamCompleteText(file, async text => {
    let batch = [];
    for (const line of text.split('\n')) {
      const row = json(line);
      if (row) batch.push(row);
      if (batch.length >= USAGE_STREAM_BATCH) { parser.feed(batch); batch = []; await yieldToRequests(); }
    }
    if (batch.length) parser.feed(batch);
  }, pace);
  const meta = await headerMeta(await candidateFor('codex', file), { remaining: 256 * 1024 }).catch(() => null);
  const records = [];
  for (const r of parser.finish()) if (r.completedAt >= cutoff) records.push({ ...r, provider: 'codex', sessionId, cwd: meta?.cwd });
  return { records, complete };
}

async function readJsonlUsageFile(provider, file, cutoff, isSubagent, pace, fallback = {}) {
  const meta = await stat(file);
  if (!meta.isFile()) throw new Error('not_a_regular_file');
  if (meta.size > USAGE_MAX_FILE_BYTES) throw Object.assign(new Error('session_file_too_large'), { code: 'too_large' });
  const cursor = createJsonlCursor('', provider, '', { isSubagent, limit: Infinity });
  const complete = await streamCompleteText(file, text => cursor.feed(text), pace);
  const sessionId = cursor.sessionId ?? fallback.sessionId ?? null, cwd = cursor.cwd ?? fallback.cwd ?? null;
  const records = [];
  for (const r of cursor.finish()) if (r.completedAt >= cutoff) records.push({ ...r, provider, sessionId, cwd });
  return { records, complete, sessionId, cwd };
}

async function walkRecentJsonl(root, cutoffMs, onUnavailable) {
  if (!(await info(root, onUnavailable))?.isDirectory()) return [];
  const found = [];
  for await (const file of walkLogTree(root, {
    maxDirectories: USAGE_MAX_DIRECTORIES, deduplicate: true, countCanonical: true,
    matches: name => /\.jsonl$/i.test(name), skip: name => skippedDirectories.has(name.toLowerCase()),
    onError: error => reportDiscoveryError(error, onUnavailable)
  })) {
    const meta = await info(file, onUnavailable);
    if (meta?.isFile() && meta.mtimeMs >= cutoffMs) found.push({ path: file, size: meta.size, mtimeMs: meta.mtimeMs });
  }
  return found;
}

async function fileUsageUnit(provider, file, cutoffMs, onUnavailable, excludeOhMyPi = false) {
  let incomplete = false;
  const subagents = provider === 'claude'
    ? (await collectClaudeSubagents(file.path, path.basename(file.path, '.jsonl'), () => { incomplete = true; }))
      .map(c => ({ path: c.path, size: c.info.size, mtimeMs: c.info.mtimeMs })) : [];
  if (incomplete) { onUnavailable?.(); return null; }
  return {
    key: identity(`${provider}|${path.basename(file.path)}`),
    stamp: [identity(file.path), file.size, file.mtimeMs, ...(provider === 'codex' ? [] : ['meta2']), ...subagents.map(i => `${i.size}:${i.mtimeMs}`)].join(':'),
    bytes: file.size + subagents.reduce((s, i) => s + i.size, 0), mtimeMs: file.mtimeMs,
    async read() {
      if (excludeOhMyPi && provider === 'pi') {
        const h = await open(file.path, 'r');
        let first;
        try { first = (await readAt(h, 0, 4096)).toString('utf8').split('\n', 1)[0]; } finally { await h.close(); }
        if (json(first)?.type === 'title') return { records: [], complete: true };
      }
      const pace = readPacer();
      let records, complete = true;
      if (provider === 'codex') ({ records, complete } = await readCodexStream(file.path, cutoffMs, pace));
      else {
        const parent = await readJsonlUsageFile(provider, file.path, cutoffMs, false, pace,
          provider === 'claude' ? { sessionId: path.basename(file.path, '.jsonl') } : undefined);
        records = parent.records; complete = parent.complete;
        for (const item of subagents) {
          const sub = await readJsonlUsageFile('claude', item.path, cutoffMs, true, pace, parent);
          records.push(...sub.records); complete &&= sub.complete;
        }
      }
      for (const item of [file, ...subagents]) {
        const current = await stat(item.path);
        if (current.size !== item.size || current.mtimeMs !== item.mtimeMs) complete = false;
      }
      return { records, complete };
    }
  };
}

async function readOpenCodeSession(dbPath, v2, sessionId, cutoffMs, cwd) {
  const db = openReadonlyDatabase(dbPath);
  try {
    const msgTable = v2 ? 'session_message' : 'message', orderCol = v2 ? 'seq' : 'rowid', provider = openCodeHarness(v2);
    const rows = db.prepare(`SELECT id,${v2 ? 'type' : 'NULL AS type'},time_created,${projectedData()}
      FROM ${msgTable} WHERE session_id=? ORDER BY ${orderCol} ASC`).iterate(sessionId);
    const byId = new Map(), pace = readPacer();
    let batch = [];
    const flush = () => { for (const r of parseOpenCodeRows(batch, v2, { limit: Infinity })) if (r.completedAt >= cutoffMs) byId.set(r.id, { ...r, provider, sessionId, cwd }); batch = []; };
    for (const row of rows) { batch.push(row); if (batch.length >= 512) { flush(); await pace(512 * 1024); } }
    flush();
    return { records: [...byId.values()], complete: true };
  } finally { db.close(); }
}

async function openCodeUsageUnits(dbPath, cutoffMs, onUnavailable) {
  if (!(await info(dbPath, onUnavailable))?.isFile()) return [];
  const units = [];
  let db;
  try {
    db = openReadonlyDatabase(dbPath);
    const available = tables(db);
    for (const v2 of [false, true]) {
      const table = v2 ? 'session_v2' : 'session', msgTable = v2 ? 'session_message' : 'message';
      if (!available.has(table) || !available.has(msgTable)) continue;
      const sCols = columns(db, table);
      if (!sCols.has('id') || !sCols.has('time_updated')) continue;
      const provider = openCodeHarness(v2), countQ = db.prepare(`SELECT COUNT(*) AS n FROM ${msgTable} WHERE session_id=?`);
      for (const row of db.prepare(`SELECT id, time_updated, ${sCols.has('directory') ? 'directory' : 'NULL AS directory'} FROM ${table} WHERE time_updated >= ?`).iterate(cutoffMs)) {
        const n = Number(countQ.get(row.id)?.n ?? 0);
        units.push({
          key: identity(`${provider}|${dbPath}|${row.id}`), stamp: `${row.time_updated}:${n}`, bytes: n * 1024, mtimeMs: Number(row.time_updated) || 0,
          read: () => readOpenCodeSession(dbPath, v2, row.id, cutoffMs, row.directory)
        });
        if (units.length % 64 === 0) await yieldToRequests();
      }
    }
  } finally { db?.close(); }
  return units;
}

async function antigravityUsageUnits(brainRoot, cutoffMs, onUnavailable) {
  if (!(await info(brainRoot, onUnavailable))?.isDirectory()) return [];
  let entries;
  try { entries = await readdir(brainRoot, { withFileTypes: true }); } catch (e) { reportDiscoveryError(e, onUnavailable); return []; }
  const units = [];
  for (const entry of entries.slice(0, USAGE_MAX_UNITS)) {
    if (!entry.isDirectory() || !safeSegment(entry.name)) continue;
    const transcript = path.join(brainRoot, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
    const meta = await info(transcript, onUnavailable);
    if (!meta?.isFile() || meta.mtimeMs < cutoffMs) continue;
    units.push({
      key: identity(`antigravity|${transcript}`), stamp: `${meta.size}:${meta.mtimeMs}:${await antigravityNativeStamp(transcript)}`,
      bytes: meta.size, mtimeMs: meta.mtimeMs,
      async read() {
        const native = await readAntigravityTimings(transcript);
        const cursor = createJsonlCursor('', 'antigravity', '', { sessionId: entry.name, limit: Infinity });
        const complete = await streamCompleteText(transcript, text => cursor.feed(text), readPacer());
        const cwd = await antigravityWorkspace(transcript, process.platform).catch(() => null);
        return { records: cursor.finish(native).filter(r => r.completedAt >= cutoffMs).map(r => ({ ...r, provider: 'antigravity', sessionId: entry.name, cwd })), complete };
      }
    });
  }
  return units;
}

export async function discoverUsageUnits(cutoffMs, options = {}) {
  const { onUnavailable } = options;
  const roots = await configuredRoots(options.roots, options.includeDefaults !== false, onUnavailable);
  const enabled = provider => !options.providers || options.providers.includes(provider);
  const units = [];
  for (const provider of ['codex', 'claude', 'pi']) {
    if (!enabled(provider)) continue;
    const selected = new Map();
    for (const root of (roots[provider] ?? []).slice(0, 100)) {
      for (const file of await walkRecentJsonl(root, cutoffMs, onUnavailable)) {
        const name = path.basename(file.path), prev = selected.get(name);
        if (!prev && units.length + selected.size >= USAGE_MAX_UNITS) continue;
        if (!prev || file.size > prev.size || (file.size === prev.size && file.mtimeMs > prev.mtimeMs)) selected.set(name, file);
      }
    }
    for (const file of selected.values()) {
      const unit = await fileUsageUnit(provider, file, cutoffMs, onUnavailable, options.excludeOhMyPi);
      if (unit) units.push(unit);
    }
  }
  for (const root of (enabled('opencode') ? roots.opencode : []).slice(0, 10)) {
    try { units.push(...await openCodeUsageUnits(root, cutoffMs, onUnavailable)); } catch { onUnavailable?.(); }
  }
  for (const root of (enabled('antigravity') ? roots.antigravity : []).slice(0, 10)) {
    units.push(...await antigravityUsageUnits(root, cutoffMs, onUnavailable));
  }
  for (const source of enabled('hermes') ? await hermesSources(roots.hermes, cutoffMs, onUnavailable) : []) {
    units.push({
      key: identity(`hermes|${source.root}`), stamp: source.stamp, bytes: source.bytes, mtimeMs: source.mtimeMs,
      async read() {
        const records = (await readHermesRecords(source, { pace: readPacer(), includeCwd: true }))
          .filter(r => r.completedAt >= cutoffMs).map(r => ({ ...r, provider: 'hermes' }));
        return { records, complete: true };
      }
    });
  }
  return units;
}

export class HarnessParser {
  #desktopCache = new Map();

  async *readSince(cutoff, { signal, needsRead = () => true, progress = () => {} } = {}) {
    const sources = await this.#discover(cutoff, signal), total = sources.length;
    let done = 0;
    progress({ done, total });
    for (const source of sources) {
      signal?.throwIfAborted();
      if (needsRead(source)) {
        const result = await source.read().catch(() => null);
        signal?.throwIfAborted();
        if (result?.complete || result?.records?.length) {
          yield { key: source.key, stamp: result.complete ? source.stamp : null, records: result.records.filter(r => r.completedAt >= cutoff) };
        }
      }
      if (++done < total && done % 20 === 0) progress({ done, total });
    }
    signal?.throwIfAborted();
  }

  async #discover(cutoff, signal) {
    const home = homedir(), env = process.env;
    const sharedDir = string(env.PI_CODING_AGENT_SESSION_DIR);
    const piAgent = path.resolve(env.PI_CODING_AGENT_DIR || path.join(home, '.pi', 'agent'));
    const ompCfg = path.join(home, env.PI_CONFIG_DIR || '.omp');
    const profile = string(env.OMP_PROFILE ?? env.PI_PROFILE);
    const named = profile && profile !== 'default' && /^[a-z0-9][a-z0-9._-]*$/i.test(profile) ? profile : null;
    const ompAgent = named ? path.join(ompCfg, 'profiles', named, 'agent') : path.resolve(env.PI_CODING_AGENT_DIR || path.join(ompCfg, 'agent'));
    const local = discoverUsageUnits(cutoff, {
      providers: SESSION_HARNESSES, excludeOhMyPi: true,
      roots: sharedDir && path.isAbsolute(sharedDir) ? { pi: [sharedDir] } : {}
    });
    const files = [], databases = [];
    const addLogs = async (provider, root, matches, depth, reader, companions = () => []) => {
      for (const file of await logFiles(root, matches, depth, signal)) {
        const unit = await fileUnit(provider, file, cutoff, (n, b) => reader(n, b, signal), { companions: companions(file) });
        if (unit) files.push(unit);
      }
    };
    const addDb = async (provider, file, reader) => {
      const unit = await fileUnit(provider, file, cutoff, n => readHarnessDatabase(n, db => reader(db, cutoff), signal), { database: true, companions: [file + '-wal'] });
      if (unit) databases.push(unit);
    };
    const openClaw = path.resolve(env.OPENCLAW_STATE_DIR || path.join(home, '.openclaw')), openClawAgents = path.join(openClaw, 'agents');
    const gemini = path.resolve(env.GEMINI_CLI_HOME || home, '.gemini', 'tmp');
    const grok = path.resolve(env.GROK_HOME || path.join(home, '.grok'));
    const minimax = path.resolve(env.MINIMAX_DATA_DIR || env.MAVIS_DATA_DIR || path.join(home, '.minimax'));
    const kimi = path.resolve(env.KIMI_CODE_HOME || path.join(home, '.kimi-code'));
    const copilot = path.resolve(env.COPILOT_HOME || path.join(home, '.copilot'), 'session-state');
    const workBuddy = path.resolve(env.WORKBUDDY_CONFIG_DIR || path.join(home, '.workbuddy'), 'projects');
    const deepSeek = path.resolve(env.DSH_HOME || path.join(home, '.dsh'), 'sessions');
    const ompRoots = sharedDir && path.isAbsolute(sharedDir) ? [sharedDir] : [path.join(ompAgent, 'sessions')];
    if (!sharedDir && !env.PI_CODING_AGENT_DIR && process.platform !== 'win32' && env.XDG_DATA_HOME) {
      ompRoots.unshift(path.join(env.XDG_DATA_HOME, 'omp', ...(named ? ['profiles', named] : []), 'sessions'));
    }
    await Promise.allSettled([
      desktopUsageUnit(home, env, cutoff, signal, this.#desktopCache).then(u => { if (u) files.push(u); }),
      addLogs('gemini', gemini, (n, f) => /^session-.+\.jsonl?$/.test(n) && path.basename(path.dirname(f)) === 'chats', 2, readGemini),
      ...['sessions', 'archived_sessions'].map(d => addLogs('grokbuild', path.join(grok, d), n => n === 'updates.jsonl', 6, readGrok, f => [path.join(path.dirname(f), 'summary.json')])),
      addDb('mcode', path.join(minimax, 'v2', 'sqlite', 'runtime-state.sqlite'), readMiniMax),
      addLogs('kimi', path.join(kimi, 'sessions'), (n, f) => n === 'wire.jsonl' && path.basename(path.dirname(path.dirname(f))) === 'agents', 4, readKimi),
      ...ompRoots.map(d => addLogs('omp', d, n => n.endsWith('.jsonl'), 8, (f, s, a) => readOmp(f, s, a, path.resolve(d) === path.resolve(sharedDir || path.join(piAgent, 'sessions'))))),
      addLogs('copilot', copilot, (n, f) => n === 'events.jsonl' && path.dirname(path.dirname(f)) === copilot, 1, readCopilot, f => [path.join(path.dirname(f), 'workspace.yaml')]),
      addLogs('workbuddy', workBuddy, (n, f) => { const p = path.relative(workBuddy, f).split(path.sep); return n.endsWith('.jsonl') && (p.length === 2 || (p.length === 4 && p[2] === 'subagents')); }, 3, readWorkBuddy, f => workBuddyParent(f) ? [workBuddyParent(f) + '.jsonl'] : []),
      addLogs('dsh', deepSeek, (n, f) => /^session\.v\d+\.jsonl(?:\.zstd)?$/.test(n) && path.relative(deepSeek, f).split(path.sep).length === 3, 2, readDeepSeek),
      addDb('openclaw', path.join(openClaw, 'state', 'openclaw.sqlite'), readOpenClawDb),
      (async () => {
        for (const a of await list(openClawAgents)) {
          if (!a.isDirectory()) continue;
          const folder = path.join(openClawAgents, a.name);
          await addLogs('openclaw', path.join(folder, 'sessions'), n => n.endsWith('.jsonl'), 0, readOpenClaw);
          await addDb('openclaw', path.join(folder, 'agent', 'openclaw-agent.sqlite'), readOpenClawDb);
        }
      })()
    ]);
    signal?.throwIfAborted();
    return [...await local, ...files.sort((a, b) => a.key.localeCompare(b.key)), ...databases.sort((a, b) => a.key.localeCompare(b.key))];
  }
}

import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { accumulateRecords } from './usage-summary.mjs';
import { buildHermesRecord, recentRecords } from './parsers.mjs';

// Hermes Agent writes one line per model call into <home>/logs/agent.log (rotated agent.log.1..3):
//
//   2026-11-14 15:55:35,098 INFO [local-12ca…] agent.conversation_loop: API call #3: model=deepseek-v4.1-flash:1017
//   provider=ollama-cloud in=40184 out=192 total=40376 latency=1.9s cache=38272/40184 (95%) id=chatcmpl-243
//
// That line is the only per-request source of latency and cache hits: `in` already includes the cached
// prompt, `latency` covers the whole call (first token included), and `cache` is read/prompt. The session
// catalogue (cwd, title, source) lives in <home>/state.db, whose `sessions.id` is exactly the id Orca keeps
// as providerSession.id for a Hermes pane — so panes map to sessions without guesswork.
const LOG_TAIL_BYTES = 8 * 1024 * 1024, MAX_LOG_FILES = 6, MAX_CALLS_PER_SESSION = 500;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 200;
const LINE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}),(\d{3}) INFO \[([^\]\s]+)\] agent\.conversation_loop: API call #(\d+): model=(\S+) provider=\S+ in=(\d+) out=(\d+) total=\d+ latency=([\d.]+)s cache=(\d+)\/(\d+)/;
const WRITE = / write=(\d+)/;
const RESPONSE_ID = / id=(\S+)/;
const logIndexes = new Map(), catalogueCache = new Map(), usageDaysCache = new Map();

const info = async file => { try { return await stat(file); } catch { return null; } };

/** Every Hermes home the plugin can read: HERMES_HOME and ~/.hermes, plus each profile under profiles/. */
export function hermesHomes({ env = process.env, home = homedir() } = {}) {
  const homes = new Set(), add = value => { if (typeof value === 'string' && value.trim()) homes.add(path.resolve(value)); };
  add(env.HERMES_HOME);
  add(path.join(home, '.hermes'));
  return [...homes];
}

async function profileHomes(base) {
  try {
    const entries = await readdir(path.join(base, 'profiles'), { withFileTypes: true });
    return entries.filter(entry => entry.isDirectory()).slice(0, 60).map(entry => path.join(base, 'profiles', entry.name));
  } catch { return []; }
}

async function homeRoots(options = {}) {
  const custom = (Array.isArray(options.customRoots) ? options.customRoots : [])
    .filter(value => typeof value === 'string' && value.trim())
    .map(value => path.resolve(value.replace(/^~(?=$|[\\/])/, homedir())));
  if (custom.length) return [...new Set(custom)];
  if (options.includeDefaults === false) return [];
  const bases = hermesHomes(options), roots = [];
  for (const base of bases) {
    roots.push(base);
    for (const profile of await profileHomes(base)) roots.push(profile);
  }
  return [...new Set(roots)];
}

/** agent.log plus its rotated copies, newest first. */
async function logFiles(root) {
  const files = [], base = path.join(root, 'logs', 'agent.log');
  const current = await info(base);
  if (current?.isFile()) files.push({ path: base, info: current });
  for (let index = 1; index <= MAX_LOG_FILES - 1; index += 1) {
    const file = await info(`${base}.${index}`);
    if (file?.isFile()) files.push({ path: `${base}.${index}`, info: file });
  }
  return files;
}

function parseLine(line) {
  const match = LINE.exec(line);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, ms, sessionId, call, model, input, output, latency, cacheRead, prompt] = match;
  const completedAt = new Date(+year, +month - 1, +day, +hour, +minute, +second, +ms).getTime();
  if (!Number.isFinite(completedAt)) return null;
  const write = WRITE.exec(line), responseId = RESPONSE_ID.exec(line);
  return {
    sessionId,
    callNumber: +call,
    model,
    inputTokens: +prompt,
    outputTokens: +output,
    cacheReadTokens: +cacheRead,
    cacheCreationTokens: write ? +write[1] : 0,
    latencyMs: Math.round(parseFloat(latency) * 1000),
    completedAt,
    ...(responseId ? { responseId: responseId[1] } : {})
  };
}

/**
 * Append-only index per log file: a poll only reads the bytes written since the last one, and a rotation
 * (the file shrinking) resets that file's index. Calls are keyed by session and capped, so a long-lived
 * home cannot grow the worker's memory without bound.
 */
async function indexLogFile(filePath) {
  const metadata = await info(filePath);
  if (!metadata?.isFile()) { logIndexes.delete(filePath); return null; }
  let entry = logIndexes.get(filePath);
  if (!entry || metadata.size < entry.offset) {
    entry = { offset: 0, tail: '', sessions: new Map() };
    logIndexes.set(filePath, entry);
  }
  if (metadata.size === entry.offset) return entry;
  const start = entry.offset > 0 ? entry.offset : Math.max(0, metadata.size - LOG_TAIL_BYTES);
  const file = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(metadata.size - start);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    const text = entry.tail + buffer.subarray(0, bytesRead).toString('utf8');
    const lastBreak = text.lastIndexOf('\n');
    if (lastBreak < 0) {
      entry.tail = text.slice(-64 * 1024);
      entry.offset = start + bytesRead;
      return entry;
    }
    entry.tail = text.slice(lastBreak + 1);
    for (const line of text.slice(0, lastBreak).split('\n')) {
      const call = parseLine(line);
      if (!call) continue;
      const calls = entry.sessions.get(call.sessionId) ?? [];
      calls.push(call);
      if (calls.length > MAX_CALLS_PER_SESSION) calls.splice(0, calls.length - MAX_CALLS_PER_SESSION);
      entry.sessions.set(call.sessionId, calls);
    }
    entry.offset = start + bytesRead;
    return entry;
  } finally { await file.close(); }
}

/** Reads every recent log once (bytes appended since the last poll) and returns the indexed calls. */
async function indexLogs(roots, { maxAgeMs = DEFAULT_MAX_AGE_MS, now = Date.now() } = {}) {
  const cutoff = now - maxAgeMs, calls = new Map();
  for (const root of roots) {
    for (const file of await logFiles(root)) {
      // A cold file older than the window cannot add anything; a warm one is already indexed.
      if (maxAgeMs > 0 && file.info.mtimeMs < cutoff && !logIndexes.has(file.path)) continue;
      const entry = await indexLogFile(file.path).catch(() => null);
      if (!entry) continue;
      for (const [sessionId, list] of entry.sessions) {
        const merged = calls.get(sessionId) ?? [];
        merged.push(...list);
        calls.set(sessionId, merged);
      }
    }
  }
  return calls;
}

/** Session rows (id, title, source, cwd, started_at) from one home's state.db, cached by file stamp. */
async function readCatalogue(root) {
  const file = path.join(root, 'state.db');
  const metadata = await info(file);
  if (!metadata?.isFile()) return [];
  const wal = await info(`${file}-wal`);
  const stamp = `${metadata.size}:${metadata.mtimeMs}:${wal?.size ?? 0}:${wal?.mtimeMs ?? 0}`;
  const cached = catalogueCache.get(file);
  if (cached?.stamp === stamp) return cached.rows;
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { return []; }
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true, enableExtensionLoading: false });
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1000;');
    const hasTable = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'").get());
    if (!hasTable) return [];
    const rows = db.prepare(`SELECT id, COALESCE(title,'') AS title, COALESCE(source,'') AS source,
      COALESCE(cwd,'') AS cwd, started_at, COALESCE(model,'') AS model
      FROM sessions ORDER BY started_at DESC LIMIT 2000`).all();
    const result = rows.map(row => ({ ...row }));
    catalogueCache.set(file, { stamp, rows: result });
    return result;
  } catch { return []; }
  finally { db?.close(); }
}

/** A pane can be started in a subdirectory of the worktree; both belong to the same channel. */
const withinPath = (child, parent, comparePath) => {
  const inner = comparePath(child), outer = comparePath(parent);
  return Boolean(inner && outer && (inner === outer || inner.startsWith(outer.endsWith(path.sep) ? outer : `${outer}${path.sep}`)));
};

function toRecords(calls, sessionId, isSubagent) {
  const records = calls.map(call => buildHermesRecord({
    id: call.responseId ? `hermes:${sessionId}:${call.responseId}` : `hermes:${sessionId}:${call.callNumber}`,
    rawId: call.responseId ?? null,
    completedAt: call.completedAt,
    inputTokens: call.inputTokens,
    cacheReadTokens: call.cacheReadTokens,
    cacheCreationTokens: call.cacheCreationTokens,
    outputTokens: call.outputTokens,
    durationMs: call.latencyMs,
    model: call.model,
    isSubagent
  })).filter(Boolean);
  return recentRecords(records, 100);
}

/**
 * Hermes sessions for the active channel: the ids Orca captured for its panes plus, when a worktree path is
 * known, every session whose cwd sits in that worktree. Records come from the per-call log lines.
 */
export async function readHermesSessions({
  sessionIds = [], cwd = null, platform = process.platform, comparePath,
  maxAgeMs = DEFAULT_MAX_AGE_MS, now = Date.now(), includeDefaults = true, customRoots = []
} = {}) {
  const compare = typeof comparePath === 'function' ? comparePath : value => value;
  const roots = await homeRoots({ includeDefaults, customRoots });
  if (!roots.length) return [];
  const wanted = new Set(sessionIds.filter(id => typeof id === 'string' && id));
  const catalogue = new Map();
  for (const root of roots) for (const row of await readCatalogue(root)) if (!catalogue.has(row.id)) catalogue.set(row.id, row);
  if (cwd) {
    for (const row of catalogue.values()) {
      if (row.cwd && withinPath(row.cwd, cwd, value => compare(value, platform))) wanted.add(row.id);
      if (wanted.size >= MAX_SESSIONS) break;
    }
  }
  if (!wanted.size) return [];
  const callsBySession = await indexLogs(roots, { maxAgeMs, now });
  const sessions = [];
  for (const sessionId of wanted) {
    const meta = catalogue.get(sessionId) ?? null;
    const calls = callsBySession.get(sessionId) ?? [];
    const isSubagent = meta?.source === 'subagent';
    const records = calls.length ? toRecords(calls, sessionId, isSubagent) : [];
    // A session with no readable call line is still listed when Orca reported it, so the panel can say
    // "0 requests" for a real conversation instead of pretending the pane has no agent at all.
    if (!records.length && !sessionIds.includes(sessionId)) continue;
    sessions.push({
      id: `hermes:${sessionId}`,
      title: meta?.title?.trim() || `hermes · ${String(sessionId).slice(-20)}`,
      provider: 'hermes',
      updatedAt: records[0]?.completedAt ?? (meta?.started_at ? meta.started_at * 1000 : 0),
      records
    });
  }
  return sessions;
}

/** Test seam: drops the incremental log indexes and the state.db catalogue cache. */
export function resetHermesCaches() {
  logIndexes.clear();
  catalogueCache.clear();
  usageDaysCache.clear();
}

/**
 * One usage unit per log file for the today / week / month cards and the heatmap. The per-day counts are
 * rebuilt from the same incremental index, cached by that index's offset so a poll that read no new bytes
 * republishes the previous counts instead of recomputing them.
 */
export async function hermesUsageUnits(cutoffMs, { includeDefaults = true, customRoots = [], roots = null } = {}) {
  const resolved = await homeRoots({
    includeDefaults,
    customRoots: (Array.isArray(customRoots) && customRoots.length ? customRoots : null) ?? roots?.hermes ?? []
  });
  const units = [];
  for (const root of resolved) {
    for (const file of await logFiles(root)) {
      if (file.info.mtimeMs < cutoffMs) continue;
      units.push({
        key: `hermes:${createHash('sha256').update(file.path).digest('hex').slice(0, 24)}`,
        stamp: `${file.info.size}:${file.info.mtimeMs}`,
        bytes: file.info.size,
        mtimeMs: file.info.mtimeMs,
        read: async () => {
          const entry = await indexLogFile(file.path);
          const cached = usageDaysCache.get(file.path);
          if (cached && entry && cached.offset === entry.offset) return cached.days;
          const days = {};
          for (const [sessionId, calls] of entry?.sessions ?? []) {
            const records = toRecords(calls, sessionId, false);
            accumulateRecords(days, 'hermes', records);
          }
          usageDaysCache.set(file.path, { offset: entry?.offset ?? 0, days });
          return days;
        }
      });
    }
  }
  return units;
}

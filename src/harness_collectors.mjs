import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as yieldToRequests } from 'node:timers/promises';
import { openReadonlyDatabase } from './sqlite.mjs';
import {
  MAX_FRAME_BYTES, buildHermesRecord, completeFrame, createClaudeParser, decodeZstdFrame,
  estimatedFirstTokenMs, estimatedLatencyMs, json, makeRecord, object, recentRecords, sha, string, timestamp, token
} from './harness_formats.mjs';

const MAX_LINE = 8 * 1024 * 1024;
const DESKTOP_MATCH_MS = 30_000;

export const list = directory => readdir(directory, { withFileTypes: true }).catch(error => {
  if (['ENOENT', 'ENOTDIR'].includes(error.code)) return [];
  throw error;
});

export async function* walkLogTree(root, {
  maxDepth = Infinity, maxDirectories = Infinity, signal, onError, onLimit,
  deduplicate = false, countCanonical = false, newestFirst = false, skip, matches
} = {}) {
  const pending = [[root, 0]], seen = new Set();
  let visited = 0;
  while (pending.length) {
    if ((countCanonical ? seen.size : visited) >= maxDirectories) { onLimit?.(); return; }
    signal?.throwIfAborted();
    const [directory, depth] = pending.pop();
    visited++;
    let entries;
    try {
      if (deduplicate) {
        const canonical = await realpath(directory);
        if (seen.has(canonical)) continue;
        seen.add(canonical);
        entries = await readdir(directory, { withFileTypes: true });
      } else entries = await list(directory);
    } catch (error) {
      if (!onError) throw error;
      onError(error);
      continue;
    }
    if (newestFirst) entries.sort((a, b) => b.name.localeCompare(a.name));
    const children = [];
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isFile() && matches(entry.name, file)) yield file;
      else if (entry.isDirectory() && !skip?.(entry.name)) {
        if (depth < maxDepth) children.push([file, depth + 1]);
        else onLimit?.();
      }
    }
    if (newestFirst) children.reverse();
    for (const child of children) pending.push(child);
  }
}

export async function logFiles(directory, matches, depth, signal) {
  const files = [];
  for await (const file of walkLogTree(directory, { maxDepth: depth, signal, matches })) files.push(file);
  return files.sort();
}

const metadata = file => stat(file, { bigint: true }).catch(error => ['ENOENT', 'ENOTDIR'].includes(error.code) ? null : Promise.reject(error));
const version = value => value?.isFile() ? `${value.mtimeNs}:${value.ctimeNs}:${value.size}:${value.ino}` : '';

export async function fileUnit(provider, file, cutoff, read, { companions = [], database = false } = {}) {
  const snapshot = () => Promise.all([file, ...companions].map(metadata));
  const before = await snapshot();
  if (!before[0]?.isFile() || (!database && Number(before[0].mtimeMs) + 1000 < cutoff)) return null;
  const stamp = before.map(version).join('|');
  return {
    key: `harness:${provider}:${sha(file)}`, stamp,
    async read() {
      const result = await read(file, Number(before[0].size));
      const after = await snapshot();
      return {
        records: result.records.filter(row => row && row.completedAt >= cutoff),
        complete: result.complete !== false && stamp === after.map(version).join('|')
      };
    }
  };
}

export async function readJsonChunks(chunks, consume) {
  let carry = Buffer.alloc(0), skipping = false, byteOffset = 0, lineStart = 0;
  for await (const chunk of chunks) {
    let start = 0;
    for (let end = chunk.indexOf(10); end >= 0; end = chunk.indexOf(10, start)) {
      if (!skipping && carry.length + end - start <= MAX_LINE) {
        const line = chunk.subarray(start, end);
        const row = json((carry.length ? Buffer.concat([carry, line]) : line).toString('utf8'));
        if (row) consume(row, lineStart);
      }
      carry = Buffer.alloc(0); skipping = false; start = end + 1; lineStart = byteOffset + start;
    }
    if (!skipping) {
      const tail = chunk.subarray(start);
      if (carry.length + tail.length > MAX_LINE) { carry = Buffer.alloc(0); skipping = true; }
      else if (tail.length) carry = carry.length ? Buffer.concat([carry, tail]) : tail;
    }
    byteOffset += chunk.length;
  }
  const text = carry.toString('utf8');
  if (!text.trim()) return !skipping;
  const last = json(text);
  if (last) consume(last, lineStart);
  return Boolean(last);
}

const readJsonLines = (file, bytes, consume, signal) => bytes
  ? readJsonChunks(createReadStream(file, { end: bytes - 1, signal }), consume) : Promise.resolve(true);

async function* readZstdFrames(file, bytes, signal, onIncomplete) {
  if (!bytes) return;
  let tail = Buffer.alloc(0);
  for await (const chunk of createReadStream(file, { end: bytes - 1, signal })) {
    const buffer = tail.length ? Buffer.concat([tail, chunk]) : chunk;
    let offset = 0;
    while (offset < buffer.length) {
      const frame = completeFrame(buffer, offset);
      if (!frame) break;
      if (!frame.skip) yield decodeZstdFrame(buffer.subarray(offset, frame.end));
      offset = frame.end;
    }
    tail = buffer.subarray(offset);
    if (tail.length > MAX_FRAME_BYTES) throw new Error('Zstd frame exceeds the read limit');
  }
  if (tail.length) onIncomplete();
}

const canonicalJson = value => Array.isArray(value) ? '[' + value.map(canonicalJson).join(',') + ']'
  : object(value) ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}'
    : JSON.stringify(value);

export async function readGemini(file, bytes, signal) {
  let sessionId = null, cwd = null, complete = true;
  const messages = new Map();
  const upsert = msg => {
    if (string(msg?.id)) messages.set(msg.id, msg.type === 'gemini' && msg.tokens
      ? { id: msg.id, model: msg.model, timestamp: msg.timestamp, tokens: msg.tokens } : null);
  };
  const update = (row, replace = false) => {
    sessionId = string(row.sessionId) ?? sessionId;
    cwd = string(row.cwd ?? row.projectPath ?? row.projectRoot) ?? cwd;
    if (!Array.isArray(row.messages)) return;
    if (replace) messages.clear();
    for (const msg of row.messages) upsert(msg);
  };
  if (file.endsWith('.json')) {
    const doc = json(await readFile(file, { encoding: 'utf8', signal }));
    if (!doc) return { complete: false, records: [] };
    update(doc);
  } else {
    complete = await readJsonLines(file, bytes, row => {
      if (typeof row.$rewindTo === 'string') {
        let discard = !messages.has(row.$rewindTo);
        for (const id of messages.keys()) { if (id === row.$rewindTo) discard = true; if (discard) messages.delete(id); }
      } else if (string(row.id)) upsert(row);
      else if (object(row.$set)) update(row.$set, true);
      else if (string(row.sessionId)) update(row);
    }, signal);
  }
  const records = [];
  for (const msg of messages.values()) {
    if (!msg) continue;
    const { input, output, cached, thoughts } = msg.tokens;
    records.push(makeRecord('gemini', {
      id: `gemini_session:${sessionId ?? 'unknown'}:${msg.id}`, sessionId, cwd, completedAt: timestamp(msg.timestamp),
      model: msg.model, input: Math.max(0, token(input) - token(cached)), output: token(output) + token(thoughts), cacheRead: cached
    }));
  }
  return { records, complete };
}

export async function readGrok(file, bytes, signal) {
  const dir = path.dirname(file), sessionId = path.basename(dir);
  const summary = json(await readFile(path.join(dir, 'summary.json'), { encoding: 'utf8', signal })
    .catch(e => e.code === 'ENOENT' ? '' : Promise.reject(e)));
  const cwd = summary?.info?.cwd, records = [];
  let eventIndex = 0;
  const complete = await readJsonLines(file, bytes, (row, offset) => {
    const update = row.params?.update;
    if (row.method !== '_x.ai/session/update' || !object(update?.usage) ||
        (update.sessionUpdate != null && update.sessionUpdate !== 'turn_completed')) return;
    const completedAt = timestamp(row.timestamp);
    if (completedAt === null) return;
    const prompt = string(update.prompt_id), turn = prompt ?? `idx${eventIndex}`;
    eventIndex++;
    const models = Object.entries(object(update.usage.modelUsage) ?? {});
    if (!models.length) models.push(['unknown', update.usage]);
    for (const [model, c] of models) {
      const cacheRead = token(c?.cachedReadTokens);
      const record = makeRecord('grokbuild', {
        id: `grok_session:${sessionId}:${turn}:${model}`, sessionId, cwd, model, completedAt,
        input: Math.max(0, token(c?.inputTokens) - cacheRead), output: c?.outputTokens, cacheRead, duration: c?.apiDurationMs
      });
      if (record) { if (!prompt) record.alternateId = `grok_session:${sessionId}:off${offset}:${model}`; records.push(record); }
    }
  }, signal);
  return { records, complete };
}

export async function readKimi(file, bytes, signal) {
  const agent = path.basename(path.dirname(file)), main = agent === 'main', sessionId = path.basename(path.resolve(file, '../../..'));
  const requests = new Map(), pending = [];
  let step, cwd;
  const complete = await readJsonLines(file, bytes, row => {
    cwd ??= string(row.cwd ?? row.workingDirectory);
    const event = row.type === 'context.append_loop_event' ? row.event : null;
    if (!row.agentId || row.agentId === agent) {
      if (event?.type === 'step.begin') step = { id: event.uuid, turn: `${event.turnId}.${event.step}` };
      if (row.type === 'llm.request' && step && (!row.turnStep || row.turnStep === step.turn) && (!row.kind || row.kind === 'loop')) {
        step.model = string(row.model); step.startedAt = timestamp(row.time);
      }
      if (event?.type === 'step.end' && string(event.messageId) && (!step || step.id === event.uuid)) {
        const first = token(event.llmFirstTokenLatencyMs), stream = token(event.llmStreamDurationMs);
        requests.set(event.messageId, { ...requests.get(event.messageId), ...step, ...(first && stream ? { first, duration: first + stream } : {}) });
        step = null;
      }
    }
    let meta, usage;
    if (main && ['agent.message.appended', 'human.agent.message.appended'].includes(row.type) && row.message?.message?.role === 'assistant') {
      meta = row.message.meta; usage = meta?.usage;
    } else if (!main && event?.type === 'step.end') {
      meta = { messageId: event.messageId, model: { provider: 'subagent' } }; usage = event.usage;
    }
    if (object(usage)) pending.push({ meta, usage, time: timestamp(row.time), identity: string(meta.messageId) ?? sha(canonicalJson(row)) });
  }, signal);
  const records = pending.map(({ meta, usage, time, identity }) => {
    const req = requests.get(meta.messageId), model = string(meta.model?.model);
    const completedAt = req?.startedAt && req.duration && time !== null ? Math.min(time, req.startedAt + req.duration) : time;
    return makeRecord('kimi', {
      id: `kimi:${string(meta.model?.provider) ?? 'unknown'}:${identity}`, sessionId, cwd, completedAt,
      model: model && model !== 'agent-loop' ? model : req?.model,
      input: usage.inputOther, output: usage.output, cacheRead: usage.inputCacheRead, cacheWrite: usage.inputCacheCreation,
      duration: req?.duration, firstToken: req?.first
    });
  });
  return { records, complete };
}

function workspaceDirectory(text) {
  const value = string(/^cwd:[ \t]*([^\r\n]*)/m.exec(text)?.[1]);
  if (value?.startsWith('"')) { try { return string(JSON.parse(value)); } catch { return null; } }
  return value?.startsWith("'") && value.endsWith("'") ? string(value.slice(1, -1).replaceAll("''", "'")) : value;
}

export async function readCopilot(file, bytes, signal) {
  const dir = path.dirname(file), sessionId = path.basename(dir);
  let cwd = workspaceDirectory(await readFile(path.join(dir, 'workspace.yaml'), { encoding: 'utf8', signal }).catch(() => ''));
  const records = [];
  const complete = await readJsonLines(file, bytes, row => {
    if (row.type === 'session.start' || row.type === 'session.resume') cwd ??= string(row.data?.context?.cwd);
    const usage = row.type === 'session.usage_record' ? object(row.data?.usage) : null;
    if (!usage) return;
    const details = Array.isArray(usage.copilotUsage?.tokenDetails) ? usage.copilotUsage.tokenDetails : [];
    const detail = name => { const v = details.find(item => item?.tokenType === name)?.tokenCount; return Number.isSafeInteger(v) && v >= 0 ? v : null; };
    const cacheRead = detail('cache_read') ?? token(usage.cacheReadTokens), cacheWrite = detail('cache_write') ?? token(usage.cacheWriteTokens);
    const seq = usage.accounting?.sequence, identity = string(row.id) ?? (Number.isSafeInteger(seq) && seq >= 0 ? `seq${seq}` : null);
    if (identity) records.push(makeRecord('copilot', {
      id: `copilot:${sessionId}:${identity}`, sessionId, model: usage.model, completedAt: timestamp(row.timestamp),
      input: detail('input') ?? Math.max(0, token(usage.inputTokens) - cacheRead - cacheWrite),
      output: detail('output') ?? usage.outputTokens, cacheRead, cacheWrite, duration: usage.duration, firstToken: usage.timeToFirstTokenMs
    }));
  }, signal);
  return { records: records.filter(Boolean).map(record => ({ ...record, cwd })), complete };
}

export const workBuddyParent = file => path.basename(path.dirname(file)) === 'subagents' ? path.dirname(path.dirname(file)) : null;

async function workBuddyDirectory(file) {
  const handle = await open(file, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const header = Buffer.alloc(64 * 1024), { bytesRead } = await handle.read(header);
    for (const line of header.subarray(0, bytesRead).toString('utf8').split('\n')) { const cwd = string(json(line)?.cwd); if (cwd) return cwd; }
    return null;
  } finally { await handle.close(); }
}

export async function readWorkBuddy(file, bytes, signal) {
  const parent = workBuddyParent(file), records = [];
  let cwd = parent ? await workBuddyDirectory(parent + '.jsonl') : null;
  const complete = await readJsonLines(file, bytes, row => {
    cwd ??= string(row.cwd);
    const data = row.providerData, identity = string(row.id);
    if (row.role === 'user' || !identity) return;
    const native = object(data?.rawUsage), sdk = row.type === 'message' && row.role === 'assistant' ? object(data?.usage) : null;
    if (!native && !sdk) return;
    let input, output, cacheRead, cacheWrite;
    if (native) {
      cacheRead = Math.max(token(native.prompt_cache_hit_tokens), token(native.cache_read_input_tokens), token(native.cached_tokens), token(native.prompt_tokens_details?.cached_tokens));
      cacheWrite = Math.max(token(native.cache_creation_input_tokens), token(native.prompt_cache_write_tokens));
      input = Math.max(0, token(native.prompt_tokens) - cacheRead - cacheWrite);
      output = native.completion_tokens;
    } else {
      cacheRead = (Array.isArray(sdk.inputTokensDetails) ? sdk.inputTokensDetails : []).reduce((s, d) => s + token(d?.cached_tokens), 0);
      input = Math.max(0, token(sdk.inputTokens) - cacheRead);
      output = sdk.outputTokens;
    }
    const sessionId = parent ? path.basename(parent) : string(row.sessionId) ?? 'unknown';
    records.push(makeRecord('workbuddy', {
      id: `workbuddy:${sessionId}:${identity}`, sessionId, completedAt: timestamp(row.timestamp),
      model: string(data.model ?? data.requestModelId)?.replace(/^custom-[^:]+:(?=.)/, ''), input, output, cacheRead, cacheWrite
    }));
  }, signal);
  return { records: records.filter(Boolean).map(record => ({ ...record, cwd })), complete };
}

export async function readDeepSeek(file, bytes, signal) {
  const steps = new Map(), records = [];
  let sessionId = path.basename(path.dirname(file)), cwd, completeFrames = true;
  const consume = row => {
    if (row.type === 'session' || row.type === 'header') { sessionId = string(row.id) ?? sessionId; cwd = string(row.cwd); }
    const data = object(row.data);
    if (!data) return;
    const key = JSON.stringify([data.turn, data.step]), completedAt = timestamp(row.time);
    if (row.type === 'step/start' && completedAt !== null) steps.set(key, completedAt);
    if (row.type !== 'assistant/message' || !object(data.usage)) return;
    const start = steps.get(key), duration = estimatedLatencyMs(start, completedAt);
    let firstOutput = Infinity;
    for (const chunk of Array.isArray(data.stream) ? data.stream : []) {
      firstOutput = Math.min(firstOutput, timestamp(chunk?.time) ?? Infinity, timestamp(chunk?.time0) ?? Infinity);
    }
    const u = data.usage, record = makeRecord('dsh', {
      id: `dsh:${string(data.message?.id) ?? sha(canonicalJson(row))}`, sessionId, cwd, completedAt,
      model: string(data.message?.source?.model)?.replace(/^[^:]+:(?=.)/, ''),
      input: u.inputTokens, output: u.outputTokens, cacheRead: u.cacheReadTokens, cacheWrite: u.cacheWriteTokens,
      duration, firstToken: estimatedFirstTokenMs(start, firstOutput, duration)
    });
    if (record) { records.push(record); steps.delete(key); }
  };
  const complete = file.endsWith('.zstd')
    ? await readJsonChunks(readZstdFrames(file, bytes, signal, () => { completeFrames = false; }), consume)
    : await readJsonLines(file, bytes, consume, signal);
  return { records, complete: complete && completeFrames };
}

function sizedHash() {
  const hash = createHash('sha256'), size = Buffer.alloc(8);
  return {
    add(value) { const bytes = Buffer.from(value); size.writeBigUInt64BE(BigInt(bytes.length)); hash.update(size).update(bytes); },
    digest: () => hash.digest('hex')
  };
}

function hashJson(hash, value) {
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'boolean' ? 'bool' : typeof value;
  hash.add(type);
  if (type === 'null') return;
  if (type !== 'object' && type !== 'array') return hash.add(String(value));
  const values = type === 'array' ? value : Object.keys(value).sort(), length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(values.length));
  hash.add(length);
  for (const key of values) { if (type === 'object') hash.add(key); hashJson(hash, type === 'object' ? value[key] : key); }
}

function ompId(entry, kind, usage, carrier) {
  const hash = sizedHash();
  if (string(entry.id)) {
    hash.add('omp-session-request-v3'); hash.add(kind); hash.add(entry.id);
    if (entry.timestamp !== undefined) hashJson(hash, entry.timestamp);
    return `omp_session:${hash.digest()}`;
  }
  hash.add('omp-session-semantic-v1'); hash.add(kind);
  const fields = {
    entry_timestamp: entry.timestamp, message_timestamp: carrier?.timestamp, provider: carrier?.provider, model: carrier?.model,
    responseModel: carrier?.responseModel, responseId: carrier?.responseId, api: carrier?.api, toolCallId: carrier?.toolCallId,
    toolName: carrier?.toolName, stopReason: carrier?.stopReason, errorMessage: carrier?.errorMessage,
    ...(carrier ? { content: carrier.content } : { summary: entry.summary }), usage
  };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) { hash.add(k); hashJson(hash, v); }
  return `omp_session_semantic:${hash.digest()}`;
}

export async function readOmp(file, bytes, signal, shared) {
  let header, first = true, eligible = !shared;
  const records = [];
  const complete = await readJsonLines(file, bytes, row => {
    if (first) { eligible ||= row.type === 'title'; first = false; }
    if (!eligible) return;
    if (row.type === 'session') { header ??= row; return; }
    if (!header) return;
    let kind = row.type, carrier;
    if (row.type === 'message') { carrier = row.message; kind = carrier?.role === 'toolResult' ? 'tool_result' : carrier?.role; if (!['assistant', 'tool_result'].includes(kind)) return; }
    else if (row.type === 'model_usage') carrier = row;
    else if (!['compaction', 'branch_summary'].includes(kind)) return;
    const attributed = kind === 'assistant' || kind === 'model_usage', usage = object((carrier ?? row).usage);
    if (!usage || (attributed && ['aborted', 'error'].includes(carrier.stopReason))) return;
    const end = timestamp(row.timestamp), start = timestamp(carrier?.timestamp);
    records.push(makeRecord('omp', {
      id: ompId(row, kind, usage, carrier), sessionId: header.id, cwd: header.cwd,
      completedAt: end ?? start ?? timestamp(header.timestamp), model: attributed ? carrier.responseModel ?? carrier.model : null,
      input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite,
      duration: attributed ? carrier.duration ?? estimatedLatencyMs(start, end) : null
    }));
  }, signal);
  return { records, complete };
}

const openClawRecord = (entry, sessionId, cwd) => {
  const msg = entry?.message, usage = msg?.usage;
  return entry?.type === 'message' && msg?.role === 'assistant' && object(usage) && string(entry.id)
    ? makeRecord('openclaw', {
      id: `openclaw:${sessionId}:${entry.id}`, sessionId, cwd, model: msg.model,
      completedAt: timestamp(entry.timestamp) ?? timestamp(msg.timestamp),
      input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite
    }) : null;
};

export async function readOpenClaw(file, bytes, signal) {
  let sessionId = path.basename(file, '.jsonl'), cwd;
  const records = [];
  const complete = await readJsonLines(file, bytes, row => {
    if (row.type === 'session') { sessionId = string(row.id) ?? sessionId; cwd = string(row.cwd); }
    else records.push(openClawRecord(row, sessionId, cwd));
  }, signal);
  return { records, complete };
}

export async function readHarnessDatabase(file, read, signal) {
  const db = openReadonlyDatabase(file);
  try {
    const records = [];
    let index = 0;
    for (const row of read(db)) {
      if (++index % 512 === 0) { signal?.throwIfAborted(); await yieldToRequests(); }
      if (row) records.push(row);
    }
    return { records };
  } finally { db.close(); }
}

const tableColumns = (db, table) => new Set(db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map(r => r.name));

export function* readMiniMax(db, cutoff) {
  const sessions = tableColumns(db, 'local_runtime_sessions'), messages = tableColumns(db, 'local_runtime_message_rows');
  const workspace = sessions.has('session_id') && sessions.has('workspace_dir')
    ? db.prepare('SELECT workspace_dir FROM local_runtime_sessions WHERE session_id = ? LIMIT 1') : null;
  const timing = ['session_id', 'turn_id', 'role', 'created_at_ms', 'data_json'].every(c => messages.has(c))
    ? db.prepare(`SELECT json_extract(data_json, '$.usage.request_duration_ms') AS duration, json_extract(data_json, '$.usage.decode_duration_ms') AS decode
      FROM local_runtime_message_rows WHERE session_id = ? AND (? IS NULL OR turn_id = ?) AND role = 'assistant' AND created_at_ms >= ?
        AND json_valid(data_json) AND json_extract(data_json, '$.usage.input_tokens') = ? AND json_extract(data_json, '$.usage.output_tokens') = ?
      ORDER BY created_at_ms LIMIT 1`) : null;
  const directories = new Map();
  for (const row of db.prepare('SELECT * FROM local_runtime_token_usage WHERE ts >= ?').iterate(cutoff)) {
    if (!directories.has(row.session_id)) directories.set(row.session_id, workspace?.get(row.session_id)?.workspace_dir);
    const turn = row.turn_id ?? null, times = timing?.get(row.session_id, turn, turn, row.ts, row.input_tokens, row.output_tokens);
    const model = string(row.model);
    yield makeRecord('mcode', {
      id: `mcode:${row.session_id}:${row.id}`, sessionId: row.session_id, cwd: directories.get(row.session_id),
      model: model?.slice(model.indexOf('/') + 1), completedAt: timestamp(row.ts),
      input: row.input_tokens, output: token(row.output_tokens) + token(row.reasoning_tokens),
      cacheRead: row.cache_read_tokens, cacheWrite: row.cache_write_tokens, duration: times?.duration,
      firstToken: times?.decode > 0 ? times.duration - times.decode : null
    });
  }
}

export function* readOpenClawDb(db, cutoff) {
  const cols = tableColumns(db, 'transcript_events');
  if (!cols.has('session_id') || !cols.has('event_json') || !cols.has('created_at')) return;
  const compressed = cols.has('event_zstd') && cols.has('event_utf8_bytes');
  const rows = db.prepare(`SELECT session_id, event_json${compressed ? ', event_zstd, event_utf8_bytes' : ''}
    FROM transcript_events WHERE created_at >= ? AND ${compressed
      ? "(event_json IS NULL OR (json_valid(event_json) AND json_extract(event_json, '$.message.role') = 'assistant'))"
      : "(json_valid(event_json) AND json_extract(event_json, '$.message.role') = 'assistant')"}`).iterate(cutoff);
  for (const row of rows) {
    let value = row.event_json;
    if (value === null && row.event_zstd && row.event_utf8_bytes > 0 && row.event_utf8_bytes <= MAX_LINE) {
      try { value = decodeZstdFrame(Buffer.from(row.event_zstd), row.event_utf8_bytes).toString('utf8'); } catch { continue; }
    }
    yield openClawRecord(json(value), row.session_id);
  }
}

async function desktopRoots(home, env) {
  const roots = [];
  let appData;
  if (process.platform === 'win32') {
    appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const packages = path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Packages');
    for (const entry of await list(packages).catch(() => [])) {
      if (entry.isDirectory() && /(?:^|\.)Claude_/i.test(entry.name)) {
        const roaming = path.join(packages, entry.name, 'LocalCache', 'Roaming');
        roots.push(path.join(roaming, 'Claude'), path.join(roaming, 'Claude-3p'));
      }
    }
  } else appData = process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : env.XDG_CONFIG_HOME || path.join(home, '.config');
  roots.push(path.join(appData, 'Claude'), path.join(appData, 'Claude-3p'));
  return [...new Set(roots.map(root => path.resolve(root, 'local-agent-mode-sessions')))];
}

async function readDesktopAudit(file, bytes, signal) {
  const parser = createClaudeParser({ limit: Infinity });
  let sessionId, cwd;
  const complete = await readJsonLines(file, bytes, row => {
    sessionId ??= string(row.session_id ?? row.sessionId); cwd ??= string(row.cwd); parser.feed([row]);
  }, signal);
  return {
    records: parser.finish().map(r => ({
      ...r, id: `desktop-audit:${r.rawId}`, provider: 'claude-desktop',
      sessionId: sessionId ?? path.basename(path.dirname(file)).replace(/^local_/, ''), cwd, dataSource: 'claude_desktop_audit'
    })), complete
  };
}

const ledgerNum = value => typeof value === 'number' || string(value) ? Number(value) : NaN;
async function readDesktopLedger(file, bytes, signal) {
  const records = [];
  const complete = await readJsonLines(file, bytes, row => {
    if (row.surface !== 'cowork' || !string(row.sessionId) || !object(row.models)) return;
    const completedAt = timestamp(ledgerNum(row.ts));
    if (completedAt === null) return;
    for (const [model, u] of Object.entries(row.models)) {
      if (!object(u)) continue;
      const record = makeRecord('claude-desktop', {
        id: `desktop-ledger:${sha(JSON.stringify([row.sessionId, string(row.requestId) ?? completedAt, model]))}`,
        sessionId: row.sessionId, model, completedAt,
        input: ledgerNum(u.inputTokens), output: ledgerNum(u.outputTokens), cacheRead: ledgerNum(u.cacheReadTokens), cacheWrite: ledgerNum(u.cacheWriteTokens)
      });
      if (record) records.push({ ...record, dataSource: 'claude_desktop_ledger' });
    }
  }, signal);
  return { records, complete };
}

const desktopModel = model => {
  const routed = /^(?:(us|eu|apac|global)\.)?anthropic\.(.+)$/.exec((model ?? '').toLowerCase());
  return routed ? { base: routed[2].replace(/-v\d+:\d+$/, ''), route: routed[1] } : { base: (model ?? '').toLowerCase() };
};
const desktopKey = r => JSON.stringify([desktopModel(r.model).base, r.freshInputTokens, r.outputTokens, r.cacheReadTokens, r.cacheCreationTokens]);

function mergeDesktopRecords(audit, ledger) {
  const groups = new Map(), matched = new Map(), remaining = [];
  for (const r of audit.values()) { const k = desktopKey(r); (groups.get(k) ?? groups.set(k, []).get(k)).push(r); }
  for (const row of ledger.values()) {
    const route = desktopModel(row.model).route;
    const candidates = (groups.get(desktopKey(row)) ?? []).filter(entry => {
      const aRoute = desktopModel(entry.model).route;
      return !matched.has(entry.id) && Math.abs(entry.completedAt - row.completedAt) <= DESKTOP_MATCH_MS && (!route || !aRoute || aRoute === route);
    });
    const same = candidates.filter(e => e.sessionId?.replace(/^local_/, '') === row.sessionId.replace(/^local_/, ''));
    const pair = same.sort((a, b) => Math.abs(a.completedAt - row.completedAt) - Math.abs(b.completedAt - row.completedAt))[0] ??
      (candidates.length === 1 ? candidates[0] : null);
    if (pair) matched.set(pair.id, row.id); else remaining.push(row);
  }
  for (const row of audit.values()) remaining.push(matched.has(row.id) ? { ...row, alternateId: matched.get(row.id) } : row);
  return remaining;
}

export async function desktopUsageUnit(home, env, cutoff, signal, cache) {
  const files = new Set();
  for (const root of await desktopRoots(home, env)) {
    for (const file of await logFiles(root, (name, f) => name === 'audit.jsonl' || (name.endsWith('.ndjson') && path.basename(path.dirname(f)) === 'usage-ledger'), 3, signal).catch(() => [])) files.add(file);
  }
  const units = [];
  for (const file of [...files].sort()) {
    const isAudit = path.basename(file) === 'audit.jsonl';
    const unit = await fileUnit('claude-desktop', file, cutoff, (n, b) => (isAudit ? readDesktopAudit : readDesktopLedger)(n, b, signal)).catch(() => null);
    if (unit) units.push({ ...unit, isAudit });
  }
  const present = new Set(units.map(u => u.key));
  for (const key of cache.keys()) if (!present.has(key)) cache.delete(key);
  if (!units.length) return null;
  return {
    key: 'harness:claude-desktop:local', stamp: sha(JSON.stringify(units.map(({ key, stamp }) => [key, stamp]))),
    async read() {
      const audit = new Map(), ledger = new Map();
      let complete = true;
      for (const unit of units) {
        signal?.throwIfAborted();
        let saved = cache.get(unit.key);
        if (!saved || saved.stamp !== unit.stamp || saved.cutoff !== cutoff) {
          const result = await unit.read().catch(() => null);
          saved = { stamp: unit.stamp, cutoff, result };
          if (result?.complete) cache.set(unit.key, saved);
        }
        complete &&= Boolean(saved.result?.complete);
        const target = unit.isAudit ? audit : ledger;
        for (const record of saved.result?.records ?? []) target.set(record.id, record);
      }
      return { complete, records: mergeDesktopRecords(audit, ledger) };
    }
  };
}

const HERMES_LOG_NAME = /^agent\.log(?:\.[1-9]\d*)?$/;
const HERMES_CALL = /^(?<date>\d{4}-\d{2}-\d{2}) (?<time>\d{2}:\d{2}:\d{2}),(?<ms>\d{3}) INFO \[(?<session>[^\s\]]+)\] agent\.conversation_loop: API call #(?<number>\d+): model=(?<model>\S+) provider=(?<provider>\S+) in=(?<input>\d+) out=(?<output>\d+) total=\d+ latency=(?<seconds>\d+(?:\.\d+)?)s(?<details>\s.*)?$/;
const HERMES_MAX_LOG_BYTES = 32 * 1024 * 1024;
const hermesLogCache = new Map(), pendingHermes = new Map(), hermesCatalogues = new Map();
const emptyTail = Buffer.alloc(0), hermesHostTZ = process.env.TZ;
const hermesOffsetFmt = new Intl.DateTimeFormat('en', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, timeZoneName: 'longOffset' });
const hermesInfo = file => stat(file).catch(e => e.code === 'ENOENT' || e.code === 'ENOTDIR' ? null : Promise.reject(e));
const hermesIdentity = m => `${m.dev}:${m.ino}:${m.birthtimeMs}`;
const hermesStamp = m => `${hermesIdentity(m)}:${m.size}:${m.mtimeMs}:${m.ctimeMs}`;

function rememberHermes(cache, key, value, limit = 16) {
  cache.delete(key); cache.set(key, value);
  while (cache.size > limit) cache.delete(cache.keys().next().value);
}

function hermesZoneOffset(at) {
  const m = /^GMT([+-])(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(hermesOffsetFmt.formatToParts(at).find(p => p.type === 'timeZoneName')?.value ?? '');
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4] ?? 0)) * 1000 : 0;
}

function parseHermesCall(line) {
  const call = HERMES_CALL.exec(line)?.groups;
  if (!call || call.session.length > 256) return null;
  const wall = `${call.date}T${call.time}.${call.ms}`;
  let completedAt = Date.parse(wall);
  if (!Number.isFinite(completedAt)) return null;
  if (process.env.TZ !== hermesHostTZ) { const utc = Date.parse(wall + 'Z'); completedAt = utc - hermesZoneOffset(utc - hermesZoneOffset(utc)); }
  const inputTokens = Number(call.input), outputTokens = Number(call.output);
  if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens)) return null;
  const cache = /(?:^|\s)cache=(\d+)\/(\d+)/.exec(call.details ?? ''), write = /(?:^|\s)write=(\d+)(?=\s|$)/.exec(call.details ?? '');
  const readTok = Number(cache?.[1] ?? 0), writeTok = Number(write?.[1] ?? 0);
  const cacheValid = Number.isSafeInteger(readTok) && Number.isSafeInteger(writeTok) && readTok + writeTok <= inputTokens;
  const responseId = /(?:^|\s)id=(\S{1,256})(?=\s|$)/.exec(call.details ?? '')?.[1];
  const id = sha(JSON.stringify([call.session, call.provider, responseId || `${wall}:${call.number}:${call.model}`])).slice(0, 24);
  return {
    ...buildHermesRecord({
      id: 'hermes:' + id, completedAt, model: call.model, inputTokens, outputTokens, durationMs: Math.round(Number(call.seconds) * 1000),
      cacheReadTokens: cacheValid ? readTok : 0, cacheCreationTokens: cacheValid ? writeTok : 0, cacheReported: cacheValid && Boolean(cache)
    }), sessionId: call.session
  };
}

async function readHermesAnchor(file, offset) {
  const buf = Buffer.alloc(Math.min(256, offset));
  const { bytesRead } = await file.read(buf, 0, buf.length, offset - buf.length);
  return buf.subarray(0, bytesRead);
}

async function indexHermesLog(filename, pace) {
  const file = await open(filename, 'r');
  try {
    const meta = await file.stat();
    if (!meta.isFile() || meta.size > HERMES_MAX_LOG_BYTES) throw new Error('hermes_log_too_large');
    const key = hermesIdentity(meta), ver = hermesStamp(meta), original = hermesLogCache.get(key);
    if (original?.version === ver) { rememberHermes(hermesLogCache, key, original); return original.records; }
    const old = original && meta.size > original.offset && (await readHermesAnchor(file, original.offset)).equals(original.anchor) ? original : null;
    let offset = old?.offset ?? 0, tail = old?.tail ?? emptyTail;
    const records = [], chunk = Buffer.alloc(256 * 1024);
    while (offset < meta.size) {
      const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, meta.size - offset), offset);
      if (!bytesRead) throw new Error('hermes_log_changed');
      const bytes = Buffer.concat([tail, chunk.subarray(0, bytesRead)]), last = bytes.lastIndexOf(10);
      if (last >= 0) for (const line of bytes.subarray(0, last).toString('utf8').split(/\r?\n/)) {
        const record = parseHermesCall(line.replace(/\r$/, ''));
        if (record) records.push(record);
      }
      const partial = bytes.subarray(last + 1);
      tail = partial.length <= 64 * 1024 ? Buffer.from(partial) : emptyTail;
      offset += bytesRead;
      if (pace) await pace(bytesRead);
    }
    const entry = { version: ver, offset, tail, anchor: await readHermesAnchor(file, offset), records: old ? old.records.concat(records) : records };
    rememberHermes(hermesLogCache, key, entry);
    let totalBytes = 0;
    for (const [k, item] of [...hermesLogCache].reverse()) if ((totalBytes += item.offset) > HERMES_MAX_LOG_BYTES) hermesLogCache.delete(k);
    return entry.records;
  } finally { await file.close(); }
}

const readHermesLog = (file, pace) => pendingHermes.get(file) ?? (() => {
  const task = indexHermesLog(file, pace).finally(() => pendingHermes.delete(file));
  pendingHermes.set(file, task); return task;
})();

export async function hermesSources(roots, cutoffMs = 0, onUnavailable) {
  const profiles = new Set();
  for (const root of roots.slice(0, 100)) {
    const home = await realpath(root).catch(error => { if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) onUnavailable?.(); return null; });
    if (!home) continue;
    profiles.add(home);
    const dir = path.join(home, 'profiles');
    for (const p of (await list(dir).catch(() => { onUnavailable?.(); return []; })).filter(e => e.isDirectory()).slice(0, 100)) profiles.add(path.join(dir, p.name));
  }
  const sources = [];
  for (const root of profiles) {
    try {
      const dir = path.join(root, 'logs'), files = [];
      for (const e of await list(dir)) {
        if (!e.isFile() || !HERMES_LOG_NAME.test(e.name)) continue;
        const f = path.join(dir, e.name), m = await hermesInfo(f);
        if (m?.isFile() && m.mtimeMs >= cutoffMs) files.push({ file: f, m });
      }
      if (!files.length) continue;
      files.sort((a, b) => a.file.localeCompare(b.file));
      sources.push({
        root, files: files.map(e => e.file), bytes: files.reduce((s, e) => s + e.m.size, 0),
        mtimeMs: Math.max(...files.map(e => e.m.mtimeMs)),
        stamp: files.map(e => `${path.basename(e.file)}:${hermesStamp(e.m)}`).join('|')
      });
    } catch { onUnavailable?.(); }
  }
  return sources;
}

async function hermesCatalogue(root) {
  const file = path.join(root, 'state.db'), meta = await hermesInfo(file);
  if (!meta?.isFile()) return [];
  const wal = await hermesInfo(file + '-wal'), ver = hermesStamp(meta) + ':' + (wal ? hermesStamp(wal) : '');
  const cached = hermesCatalogues.get(file);
  if (cached?.version === ver) return cached.rows;
  let db;
  try {
    db = openReadonlyDatabase(file);
    const cols = new Set(db.prepare('PRAGMA table_info(sessions)').all().map(r => r.name));
    if (!cols.has('id')) return [];
    const rows = db.prepare(`SELECT id, ${cols.has('cwd') ? 'cwd' : 'NULL AS cwd'}, ${cols.has('source') ? 'source' : 'NULL AS source'}
      FROM sessions ${cols.has('started_at') ? 'ORDER BY started_at DESC' : ''} LIMIT 1000`).all();
    rememberHermes(hermesCatalogues, file, { version: ver, rows });
    return rows;
  } catch { return cached?.rows ?? []; }
  finally { db?.close(); }
}

export async function readHermesRecords(source, { pace, includeCwd = false } = {}) {
  if (source.bytes > HERMES_MAX_LOG_BYTES) throw new Error('hermes_log_too_large');
  const records = new Map();
  for (const file of source.files) for (const r of await readHermesLog(file, pace)) records.set(r.id, r);
  if (!includeCwd) return [...records.values()];
  const meta = new Map((await hermesCatalogue(source.root)).map(r => [r.id, r.cwd]));
  return [...records.values()].map(r => ({ ...r, cwd: meta.get(r.sessionId) }));
}

export async function readHermesSessions(roots, { sessionIds = [], worktree, comparePath, warn }) {
  const byId = new Map();
  for (const source of await hermesSources(roots, 0, () => warn?.('notice.hermes-folder-unavailable'))) {
    try {
      const meta = new Map((await hermesCatalogue(source.root)).map(r => [r.id, r])), selected = new Set(sessionIds);
      if (worktree) for (const row of meta.values()) if (comparePath(row.cwd) === worktree) selected.add(row.id);
      if (!selected.size) continue;
      for (const { sessionId, ...record } of await readHermesRecords(source)) {
        if (!selected.has(sessionId)) continue;
        if (meta.get(sessionId)?.source === 'subagent') record.isSubagent = true;
        (byId.get(sessionId) ?? byId.set(sessionId, []).get(sessionId)).push(record);
      }
    } catch { warn?.('notice.hermes-log-unavailable'); }
  }
  return [...byId].map(([sessionId, records]) => {
    const latest = recentRecords(records);
    return { id: 'hermes:' + sessionId, title: 'Hermes Agent', provider: 'hermes', updatedAt: latest[0].completedAt, records: latest };
  });
}

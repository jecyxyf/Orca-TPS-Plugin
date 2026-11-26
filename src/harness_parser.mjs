import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { setImmediate as yieldToRequests, setTimeout as delay } from 'node:timers/promises';
import * as zlib from 'node:zlib';
import { HISTORY_DAYS, accumulateRecords, dayKeyAgo, trimRecentRequests } from './personal_stats.mjs';
import { RECENT_STATS_MS, leaderboardDayStart, leaderboardUsageTimesFrom } from './leaderboard_stats.mjs';
import { harnessFamily, isSessionHarness, openCodeHarness, OPENCODE_V2, SESSION_HARNESSES } from './harnesses.mjs';
import { openReadonlyDatabase } from './sqlite.mjs';

const BACKFILL_BYTES = 16 * 1024 * 1024;

const MAX_LINE = 8 * 1024 * 1024;
const DESKTOP_MATCH_MS = 30_000;
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const string = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const shortText = value => typeof value === 'string' && value.length <= 256 ? string(value) : null;
const token = value => Number.isSafeInteger(value) && value > 0 ? value : 0;
const sha = text => createHash('sha256').update(text).digest('hex');

function json(text) {
  try { return object(JSON.parse(text)); } catch { return null; }
}

const EPOCH_UNIT_THRESHOLD = 100_000_000_000;

function epochMilliseconds(value, unit, numericStrings = false) {
  if (typeof value === 'string') {
    const text = numericStrings ? value.trim() : value;
    if (!numericStrings || !/^-?\d+(?:\.\d+)?$/.test(text)) return Date.parse(text);
    value = Number(text);
  }
  if (!Number.isFinite(value)) return NaN;
  return unit === 'milliseconds' ? value
    : Math.round(Math.abs(value) < EPOCH_UNIT_THRESHOLD ? value * 1000 : value);
}

function timestamp(value) {
  if (typeof value === 'number' && value <= 0) return null;
  const parsed = epochMilliseconds(value, 'auto');
  return Number.isFinite(parsed) ? parsed : null;
}

function makeRecord(provider, { id, sessionId, cwd, completedAt, model, input, output, cacheRead, cacheWrite,
  duration, firstToken }) {
  const freshInputTokens = token(input), outputTokens = token(output);
  const cacheReadTokens = token(cacheRead), cacheCreationTokens = token(cacheWrite);
  if (!id || !Number.isFinite(completedAt) || !(freshInputTokens || outputTokens || cacheReadTokens || cacheCreationTokens)) return null;
  const durationMs = estimatedLatencyMs(0, Math.round(duration)) ?? null;
  const firstTokenMs = durationMs > 0 && firstToken > 0 && firstToken < durationMs ? Math.round(firstToken) : null;
  const dataSource = `${provider}_session`;
  const { tokensPerSecond, isEstimatedSpeed } = computeSpeedMetrics({
    outputTokens, durationMs, firstTokenMs, dataSource: firstTokenMs === null ? dataSource : 'proxy'
  });
  return { id, provider, sessionId: string(sessionId), cwd: string(cwd), completedAt, model: string(model) ?? 'unknown',
    freshInputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
    durationMs, firstTokenMs, tokensPerSecond, isEstimatedSpeed, dataSource };
}

async function list(directory) {
  return readdir(directory, { withFileTypes: true }).catch(error => {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return [];
    throw error;
  });
}

async function* walkLogTree(root, {
  maxDepth = Infinity, maxDirectories = Infinity, signal, onError, onLimit,
  deduplicate = false, countCanonical = false, newestFirst = false, skip, matches
} = {}) {
  const pending = [[root, 0]], seen = new Set();
  let visited = 0;
  while (pending.length) {
    if ((countCanonical ? seen.size : visited) >= maxDirectories) {
      onLimit?.();
      return;
    }
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

async function logFiles(directory, matches, depth, signal) {
  const files = [];
  for await (const file of walkLogTree(directory, { maxDepth: depth, signal, matches })) files.push(file);
  return files.sort();
}

async function metadata(file) {
  return stat(file, { bigint: true }).catch(error => {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
    throw error;
  });
}

const version = value => value?.isFile() ? `${value.mtimeNs}:${value.ctimeNs}:${value.size}:${value.ino}` : '';

async function fileUnit(provider, file, cutoff, read, { companions = [], database = false } = {}) {
  const snapshot = async () => Promise.all([file, ...companions].map(metadata));
  const before = await snapshot();
  if (!before[0]?.isFile() || (!database && Number(before[0].mtimeMs) + 1000 < cutoff)) return null;
  const stamp = before.map(version).join('|');
  return {
    key: `harness:${provider}:${sha(file)}`,
    stamp,
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

async function readJsonLines(file, bytes, consume, signal) {
  if (!bytes) return true;
  return readJsonChunks(createReadStream(file, { end: bytes - 1, signal }), consume);
}

async function readJsonChunks(chunks, consume) {
  let carry = Buffer.alloc(0), skipping = false, byteOffset = 0, lineStart = 0;
  for await (const chunk of chunks) {
    let start = 0;
    for (let end = chunk.indexOf(10); end >= 0; end = chunk.indexOf(10, start)) {
      if (!skipping && carry.length + end - start <= MAX_LINE) {
        const line = chunk.subarray(start, end);
        const row = json((carry.length ? Buffer.concat([carry, line]) : line).toString('utf8'));
        if (row) consume(row, lineStart);
      }
      carry = Buffer.alloc(0);
      skipping = false;
      start = end + 1;
      lineStart = byteOffset + start;
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

async function readGemini(file, bytes, signal) {
  let sessionId = null, cwd = null;
  const messages = new Map();
  const upsert = msg => {
    if (!string(msg?.id)) return;
    messages.set(msg.id, msg.type === 'gemini' && msg.tokens
      ? { id: msg.id, model: msg.model, timestamp: msg.timestamp, tokens: msg.tokens } : null);
  };
  function update(row, replace = false) {
    sessionId = string(row.sessionId) ?? sessionId;
    cwd = string(row.cwd ?? row.projectPath ?? row.projectRoot) ?? cwd;
    if (!Array.isArray(row.messages)) return;
    if (replace) messages.clear();
    for (const msg of row.messages) upsert(msg);
  }
  let complete = true;
  if (file.endsWith('.json')) {
    const doc = json(await readFile(file, { encoding: 'utf8', signal }));
    if (!doc) return { complete: false, records: [] };
    update(doc);
  } else {
    complete = await readJsonLines(file, bytes, row => {
      if (typeof row.$rewindTo === 'string') {
        let discard = !messages.has(row.$rewindTo);
        for (const id of messages.keys()) {
          if (id === row.$rewindTo) discard = true;
          if (discard) messages.delete(id);
        }
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

async function readGrok(file, bytes, signal) {
  const directory = path.dirname(file);
  const sessionId = path.basename(directory);
  const summary = json(await readFile(path.join(directory, 'summary.json'), { encoding: 'utf8', signal }).catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  }));
  const cwd = summary?.info?.cwd, records = [];
  let eventIndex = 0;
  const complete = await readJsonLines(file, bytes, (row, offset) => {
    const update = row.params?.update;
    if (row.method !== '_x.ai/session/update' || !object(update?.usage) ||
        (update.sessionUpdate != null && update.sessionUpdate !== 'turn_completed')) return;
    const completedAt = timestamp(row.timestamp);
    if (completedAt === null) return;
    const prompt = string(update.prompt_id);
    const turn = prompt ?? `idx${eventIndex}`;
    eventIndex++;
    const models = Object.entries(object(update.usage.modelUsage) ?? {});
    if (!models.length) models.push(['unknown', update.usage]);
    for (const [model, counters] of models) {
      const cacheRead = token(counters?.cachedReadTokens);
      const record = makeRecord('grokbuild', {
        id: `grok_session:${sessionId}:${turn}:${model}`, sessionId, cwd, model, completedAt,
        input: Math.max(0, token(counters?.inputTokens) - cacheRead), output: counters?.outputTokens,
        cacheRead, duration: counters?.apiDurationMs
      });
      if (!record) continue;
      if (!prompt) record.alternateId = `grok_session:${sessionId}:off${offset}:${model}`;
      records.push(record);
    }
  }, signal);
  return { records, complete };
}

const canonicalJson = value => {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  return JSON.stringify(value);
};

async function readKimi(file, bytes, signal) {
  const agent = path.basename(path.dirname(file)), main = agent === 'main';
  const sessionId = path.basename(path.resolve(file, '../../..'));
  const requests = new Map(), pending = [];
  let step, cwd;
  const complete = await readJsonLines(file, bytes, row => {
    cwd ??= string(row.cwd ?? row.workingDirectory);
    const event = row.type === 'context.append_loop_event' ? row.event : null;
    if (!row.agentId || row.agentId === agent) {
      if (event?.type === 'step.begin') step = { id: event.uuid, turn: `${event.turnId}.${event.step}` };
      if (row.type === 'llm.request' && step && (!row.turnStep || row.turnStep === step.turn) && (!row.kind || row.kind === 'loop')) {
        step.model = string(row.model);
        step.startedAt = timestamp(row.time);
      }
      if (event?.type === 'step.end' && string(event.messageId) && (!step || step.id === event.uuid)) {
        const first = token(event.llmFirstTokenLatencyMs), stream = token(event.llmStreamDurationMs);
        requests.set(event.messageId, { ...requests.get(event.messageId), ...step, ...(first && stream ? { first, duration: first + stream } : {}) });
        step = null;
      }
    }
    let meta, usage;
    if (main && ['agent.message.appended', 'human.agent.message.appended'].includes(row.type) &&
        row.message?.message?.role === 'assistant') {
      meta = row.message.meta;
      usage = meta?.usage;
    } else if (!main && event?.type === 'step.end') {
      meta = { messageId: event.messageId, model: { provider: 'subagent' } };
      usage = event.usage;
    }
    if (object(usage)) pending.push({ meta, usage, time: timestamp(row.time), identity: string(meta.messageId) ?? sha(canonicalJson(row)) });
  }, signal);
  const records = pending.map(({ meta, usage, time, identity }) => {
    const request = requests.get(meta.messageId);
    const model = string(meta.model?.model);
    const completedAt = request?.startedAt && request.duration && time !== null
      ? Math.min(time, request.startedAt + request.duration) : time;
    return makeRecord('kimi', {
      id: `kimi:${string(meta.model?.provider) ?? 'unknown'}:${identity}`, sessionId, cwd, completedAt,
      model: model && model !== 'agent-loop' ? model : request?.model,
      input: usage.inputOther, output: usage.output, cacheRead: usage.inputCacheRead, cacheWrite: usage.inputCacheCreation,
      duration: request?.duration, firstToken: request?.first
    });
  });
  return { records, complete };
}

function workspaceDirectory(text) {
  const value = string(/^cwd:[ \t]*([^\r\n]*)/m.exec(text)?.[1]);
  if (value?.startsWith('"')) {
    try { return string(JSON.parse(value)); } catch { return null; }
  }
  if (value?.startsWith("'") && value.endsWith("'")) return string(value.slice(1, -1).replaceAll("''", "'"));
  return value;
}

async function readCopilot(file, bytes, signal) {
  const directory = path.dirname(file), sessionId = path.basename(directory);
  const workspace = await readFile(path.join(directory, 'workspace.yaml'), { encoding: 'utf8', signal }).catch(() => '');
  let cwd = workspaceDirectory(workspace);
  const records = [];
  const complete = await readJsonLines(file, bytes, row => {
    if (row.type === 'session.start' || row.type === 'session.resume') cwd ??= string(row.data?.context?.cwd);
    const usage = row.data?.usage;
    if (row.type !== 'session.usage_record' || !object(usage)) return;
    const details = Array.isArray(usage.copilotUsage?.tokenDetails) ? usage.copilotUsage.tokenDetails : [];
    const detail = name => {
      const value = details.find(item => item?.tokenType === name)?.tokenCount;
      return Number.isSafeInteger(value) && value >= 0 ? value : null;
    };
    const cacheRead = detail('cache_read') ?? token(usage.cacheReadTokens);
    const cacheWrite = detail('cache_write') ?? token(usage.cacheWriteTokens);
    const sequence = usage.accounting?.sequence;
    const identity = string(row.id) ?? (Number.isSafeInteger(sequence) && sequence >= 0 ? `seq${sequence}` : null);
    if (!identity) return;
    records.push(makeRecord('copilot', {
      id: `copilot:${sessionId}:${identity}`, sessionId, model: usage.model, completedAt: timestamp(row.timestamp),
      input: detail('input') ?? Math.max(0, token(usage.inputTokens) - cacheRead - cacheWrite),
      output: detail('output') ?? usage.outputTokens, cacheRead, cacheWrite,
      duration: usage.duration, firstToken: usage.timeToFirstTokenMs
    }));
  }, signal);
  return { records: records.filter(Boolean).map(record => ({ ...record, cwd })), complete };
}

function workBuddyParent(file) {
  return path.basename(path.dirname(file)) === 'subagents' ? path.dirname(path.dirname(file)) : null;
}

async function workBuddyDirectory(file) {
  const handle = await open(file, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const header = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(header);
    for (const line of header.subarray(0, bytesRead).toString('utf8').split('\n')) {
      const cwd = string(json(line)?.cwd);
      if (cwd) return cwd;
    }
    return null;
  } finally { await handle.close(); }
}

async function readWorkBuddy(file, bytes, signal) {
  const parent = workBuddyParent(file), records = [];
  let cwd = parent ? await workBuddyDirectory(parent + '.jsonl') : null;
  const complete = await readJsonLines(file, bytes, row => {
    cwd ??= string(row.cwd);
    const data = row.providerData;
    const identity = string(row.id);
    if (row.role === 'user' || !identity) return;
    const native = object(data?.rawUsage), sdk = row.type === 'message' && row.role === 'assistant' ? object(data?.usage) : null;
    if (!native && !sdk) return;
    let input, output, cacheRead, cacheWrite;
    if (native) {
      cacheRead = Math.max(token(native.prompt_cache_hit_tokens), token(native.cache_read_input_tokens),
        token(native.cached_tokens), token(native.prompt_tokens_details?.cached_tokens));
      cacheWrite = Math.max(token(native.cache_creation_input_tokens), token(native.prompt_cache_write_tokens));
      input = Math.max(0, token(native.prompt_tokens) - cacheRead - cacheWrite);
      output = native.completion_tokens;
    } else {
      const details = Array.isArray(sdk.inputTokensDetails) ? sdk.inputTokensDetails : [];
      cacheRead = details.reduce((sum, detail) => sum + token(detail?.cached_tokens), 0);
      input = Math.max(0, token(sdk.inputTokens) - cacheRead);
      output = sdk.outputTokens;
    }
    const sessionId = parent ? path.basename(parent) : string(row.sessionId) ?? 'unknown';
    const model = string(data.model ?? data.requestModelId)?.replace(/^custom-[^:]+:(?=.)/, '');
    records.push(makeRecord('workbuddy', { id: `workbuddy:${sessionId}:${identity}`, sessionId,
      model, completedAt: timestamp(row.timestamp), input, output, cacheRead, cacheWrite }));
  }, signal);
  return { records: records.filter(Boolean).map(record => ({ ...record, cwd })), complete };
}

async function readDeepSeek(file, bytes, signal) {
  const steps = new Map(), records = [];
  let sessionId = path.basename(path.dirname(file)), cwd, completeFrames = true;
  const consume = row => {
    if (row.type === 'session' || row.type === 'header') {
      sessionId = string(row.id) ?? sessionId;
      cwd = string(row.cwd);
    }
    const data = row.data;
    if (!object(data)) return;
    const key = JSON.stringify([data.turn, data.step]);
    const completedAt = timestamp(row.time);
    if (row.type === 'step/start' && completedAt !== null) steps.set(key, completedAt);
    if (row.type !== 'assistant/message' || !object(data.usage)) return;
    const start = steps.get(key);
    const duration = estimatedLatencyMs(start, completedAt);
    let firstOutput = Infinity;
    for (const chunk of Array.isArray(data.stream) ? data.stream : []) {
      firstOutput = Math.min(firstOutput, timestamp(chunk?.time) ?? Infinity, timestamp(chunk?.time0) ?? Infinity);
    }
    const model = string(data.message?.source?.model)?.replace(/^[^:]+:(?=.)/, '');
    const identity = string(data.message?.id) ?? sha(canonicalJson(row));
    const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = data.usage;
    const record = makeRecord('dsh', { id: `dsh:${identity}`, sessionId, cwd, model, completedAt,
      input: inputTokens, output: outputTokens, cacheRead: cacheReadTokens, cacheWrite: cacheWriteTokens, duration,
      firstToken: estimatedFirstTokenMs(start, firstOutput, duration) });
    if (record) {
      records.push(record);
      steps.delete(key);
    }
  };
  const complete = file.endsWith('.zstd')
    ? await readJsonChunks(readZstdFrames(file, bytes, signal, () => { completeFrames = false; }), consume)
    : await readJsonLines(file, bytes, consume, signal);
  return { records, complete: complete && completeFrames };
}

// Match CC Switch's persisted Oh My Pi request IDs so an existing manager can keep its totals.
function sizedHash() {
  const hash = createHash('sha256');
  return {
    add(value) {
      const bytes = Buffer.from(value), size = Buffer.alloc(8);
      size.writeBigUInt64BE(BigInt(bytes.length));
      hash.update(size).update(bytes);
    },
    digest: () => hash.digest('hex')
  };
}

function hashJson(hash, value) {
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'boolean' ? 'bool' : typeof value;
  hash.add(type);
  if (type === 'null') return;
  if (type !== 'object' && type !== 'array') return hash.add(String(value));
  const values = type === 'array' ? value : Object.keys(value).sort();
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(values.length));
  hash.add(length);
  for (const key of values) {
    if (type === 'object') hash.add(key);
    hashJson(hash, type === 'object' ? value[key] : key);
  }
}

function ompId(entry, kind, usage, carrier) {
  const hash = sizedHash();
  const fields = Object.entries({
    entry_timestamp: entry.timestamp, message_timestamp: carrier?.timestamp, provider: carrier?.provider, model: carrier?.model,
    responseModel: carrier?.responseModel, responseId: carrier?.responseId, api: carrier?.api, toolCallId: carrier?.toolCallId,
    toolName: carrier?.toolName, stopReason: carrier?.stopReason, errorMessage: carrier?.errorMessage,
    ...(carrier ? { content: carrier.content } : { summary: entry.summary }), usage
  });
  if (string(entry.id)) {
    hash.add('omp-session-request-v3');
    hash.add(kind);
    hash.add(entry.id);
    if (entry.timestamp !== undefined) hashJson(hash, entry.timestamp);
    return `omp_session:${hash.digest()}`;
  }
  hash.add('omp-session-semantic-v1');
  hash.add(kind);
  for (const [key, value] of fields) if (value !== undefined) { hash.add(key); hashJson(hash, value); }
  return `omp_session_semantic:${hash.digest()}`;
}

async function readOmp(file, bytes, signal, shared) {
  let header, first = true, eligible = !shared;
  const records = [];
  const complete = await readJsonLines(file, bytes, row => {
    if (first) { eligible ||= row.type === 'title'; first = false; }
    if (!eligible) return;
    if (row.type === 'session') { header ??= row; return; }
    if (!header) return;
    let kind = row.type, carrier;
    if (row.type === 'message') {
      carrier = row.message;
      kind = carrier?.role === 'toolResult' ? 'tool_result' : carrier?.role;
      if (!['assistant', 'tool_result'].includes(kind)) return;
    } else if (row.type === 'model_usage') carrier = row;
    else if (!['compaction', 'branch_summary'].includes(kind)) return;
    const attributed = kind === 'assistant' || kind === 'model_usage';
    const usage = object((carrier ?? row).usage);
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

function openClawRecord(entry, sessionId, cwd) {
  const message = entry?.message;
  const usage = message?.usage;
  if (entry?.type !== 'message' || message?.role !== 'assistant' || !object(usage) || !string(entry.id)) return null;
  return makeRecord('openclaw', { id: `openclaw:${sessionId}:${entry.id}`, sessionId, cwd,
    completedAt: timestamp(entry.timestamp) ?? timestamp(message.timestamp), model: message.model,
    input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite });
}

async function readOpenClaw(file, bytes, signal) {
  let sessionId = path.basename(file, '.jsonl'), cwd;
  const records = [];
  const complete = await readJsonLines(file, bytes, row => {
    if (row.type === 'session') { sessionId = string(row.id) ?? sessionId; cwd = string(row.cwd); }
    else records.push(openClawRecord(row, sessionId, cwd));
  }, signal);
  return { records, complete };
}

async function readHarnessDatabase(file, read, signal) {
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

function tableColumns(db, table) {
  return new Set(db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map(row => row.name));
}

function* readMiniMax(db, cutoff) {
  const sessions = tableColumns(db, 'local_runtime_sessions');
  const workspace = sessions.has('session_id') && sessions.has('workspace_dir')
    ? db.prepare('SELECT workspace_dir FROM local_runtime_sessions WHERE session_id = ? LIMIT 1') : null;
  const messages = tableColumns(db, 'local_runtime_message_rows');
  const timing = ['session_id', 'turn_id', 'role', 'created_at_ms', 'data_json'].every(column => messages.has(column))
    ? db.prepare(`SELECT json_extract(data_json, '$.usage.request_duration_ms') AS duration,
        json_extract(data_json, '$.usage.decode_duration_ms') AS decode
      FROM local_runtime_message_rows
      WHERE session_id = ? AND (? IS NULL OR turn_id = ?) AND role = 'assistant' AND created_at_ms >= ?
        AND json_valid(data_json) AND json_extract(data_json, '$.usage.input_tokens') = ?
        AND json_extract(data_json, '$.usage.output_tokens') = ?
      ORDER BY created_at_ms LIMIT 1`) : null;
  const rows = db.prepare('SELECT * FROM local_runtime_token_usage WHERE ts >= ?').iterate(cutoff);
  const directories = new Map();
  for (const row of rows) {
    if (!directories.has(row.session_id)) directories.set(row.session_id, workspace?.get(row.session_id)?.workspace_dir);
    const turn = row.turn_id ?? null;
    const times = timing?.get(row.session_id, turn, turn, row.ts, row.input_tokens, row.output_tokens);
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

async function desktopRoots(home, env) {
  let appData;
  const roots = [];
  if (process.platform === 'win32') {
    appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const packages = path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Packages');
    for (const entry of await list(packages).catch(() => [])) {
      if (entry.isDirectory() && /(?:^|\.)Claude_/i.test(entry.name)) {
        const roaming = path.join(packages, entry.name, 'LocalCache', 'Roaming');
        roots.push(path.join(roaming, 'Claude'), path.join(roaming, 'Claude-3p'));
      }
    }
  } else {
    appData = process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support') : env.XDG_CONFIG_HOME || path.join(home, '.config');
  }
  roots.push(path.join(appData, 'Claude'), path.join(appData, 'Claude-3p'));
  return [...new Set(roots.map(root => path.resolve(root, 'local-agent-mode-sessions')))];
}

async function readDesktopAudit(file, bytes, signal) {
  const parser = createClaudeParser({ limit: Infinity });
  let sessionId, cwd;
  const complete = await readJsonLines(file, bytes, row => {
    sessionId ??= string(row.session_id ?? row.sessionId);
    cwd ??= string(row.cwd);
    parser.feed([row]);
  }, signal);
  const records = parser.finish().map(record => ({
    ...record, id: `desktop-audit:${record.rawId}`, provider: 'claude-desktop',
    sessionId: sessionId ?? path.basename(path.dirname(file)).replace(/^local_/, ''), cwd, dataSource: 'claude_desktop_audit'
  }));
  return { records, complete };
}

const ledgerNumber = value => typeof value === 'number' || string(value) ? Number(value) : NaN;

async function readDesktopLedger(file, bytes, signal) {
  const records = [];
  const complete = await readJsonLines(file, bytes, row => {
    // Code-tab transcripts already enter through the Claude Code collector.
    if (row.surface !== 'cowork' || !string(row.sessionId) || !object(row.models)) return;
    const completedAt = timestamp(ledgerNumber(row.ts));
    if (completedAt === null) return;
    for (const [model, usage] of Object.entries(row.models)) {
      if (!object(usage)) continue;
      const identity = JSON.stringify([row.sessionId, string(row.requestId) ?? completedAt, model]);
      const record = makeRecord('claude-desktop', {
        id: `desktop-ledger:${sha(identity)}`, sessionId: row.sessionId, model, completedAt,
        input: ledgerNumber(usage.inputTokens), output: ledgerNumber(usage.outputTokens), cacheRead: ledgerNumber(usage.cacheReadTokens),
        cacheWrite: ledgerNumber(usage.cacheWriteTokens)
      });
      if (record) records.push({ ...record, dataSource: 'claude_desktop_ledger' });
    }
  }, signal);
  return { records, complete };
}

function desktopModel(model) {
  const raw = (model ?? '').toLowerCase();
  const routed = /^(?:(us|eu|apac|global)\.)?anthropic\.(.+)$/.exec(raw);
  return routed ? { base: routed[2].replace(/-v\d+:\d+$/, ''), route: routed[1] } : { base: raw };
}

function desktopUsageKey(row) {
  return JSON.stringify([desktopModel(row.model).base, row.freshInputTokens, row.outputTokens, row.cacheReadTokens, row.cacheCreationTokens]);
}

function mergeDesktopRecords(audit, ledger) {
  const groups = new Map();
  for (const record of audit.values()) {
    const key = desktopUsageKey(record);
    let group = groups.get(key);
    if (!group) groups.set(key, group = []);
    group.push(record);
  }
  const matched = new Map(), remaining = [];
  for (const row of ledger.values()) {
    const route = desktopModel(row.model).route;
    const candidates = (groups.get(desktopUsageKey(row)) ?? []).filter(entry => {
      const auditRoute = desktopModel(entry.model).route;
      return !matched.has(entry.id) && Math.abs(entry.completedAt - row.completedAt) <= DESKTOP_MATCH_MS &&
        (!route || !auditRoute || auditRoute === route);
    });
    const sameSession = candidates.filter(entry => entry.sessionId?.replace(/^local_/, '') === row.sessionId.replace(/^local_/, ''));
    const pair = sameSession.sort((a, b) => Math.abs(a.completedAt - row.completedAt) - Math.abs(b.completedAt - row.completedAt))[0] ??
      (candidates.length === 1 ? candidates[0] : null);
    if (pair) matched.set(pair.id, row.id);
    else remaining.push(row);
  }
  for (const row of audit.values()) {
    const alternate = matched.get(row.id);
    remaining.push(alternate ? { ...row, alternateId: alternate } : row);
  }
  return remaining;
}

async function desktopUsageUnit(home, env, cutoff, signal, cache) {
  const roots = await desktopRoots(home, env);
  const files = new Set();
  for (const root of roots) {
    const discovered = await logFiles(root, (name, file) => name === 'audit.jsonl' ||
      (name.endsWith('.ndjson') && path.basename(path.dirname(file)) === 'usage-ledger'), 3, signal).catch(() => []);
    for (const file of discovered) files.add(file);
  }
  const units = [];
  for (const file of [...files].sort()) {
    const isAudit = path.basename(file) === 'audit.jsonl';
    const reader = isAudit ? readDesktopAudit : readDesktopLedger;
    const unit = await fileUnit('claude-desktop', file, cutoff, (name, bytes) => reader(name, bytes, signal)).catch(() => null);
    if (unit) units.push({ ...unit, isAudit });
  }
  const present = new Set(units.map(unit => unit.key));
  for (const key of cache.keys()) if (!present.has(key)) cache.delete(key);
  if (!units.length) return null;
  return {
    key: 'harness:claude-desktop:local',
    stamp: sha(JSON.stringify(units.map(({ key, stamp }) => [key, stamp]))),
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
        const result = saved.result;
        complete &&= Boolean(result?.complete);
        const records = unit.isAudit ? audit : ledger;
        for (const record of result?.records ?? []) records.set(record.id, record);
      }
      return { complete, records: mergeDesktopRecords(audit, ledger) };
    }
  };
}

function* readOpenClawDb(db, cutoff) {
  const columns = tableColumns(db, 'transcript_events');
  if (!columns.has('session_id') || !columns.has('event_json') || !columns.has('created_at')) return;
  const compressed = columns.has('event_zstd') && columns.has('event_utf8_bytes');
  const rows = db.prepare(`SELECT session_id, event_json${compressed ? ', event_zstd, event_utf8_bytes' : ''}
    FROM transcript_events WHERE created_at >= ?
    AND ${compressed ? "(event_json IS NULL OR (json_valid(event_json) AND json_extract(event_json, '$.message.role') = 'assistant'))"
      : "(json_valid(event_json) AND json_extract(event_json, '$.message.role') = 'assistant')"}`).iterate(cutoff);
  for (const row of rows) {
    let value = row.event_json;
    if (value === null && row.event_zstd && row.event_utf8_bytes > 0 && row.event_utf8_bytes <= MAX_LINE) {
      try { value = decodeZstdFrame(Buffer.from(row.event_zstd), row.event_utf8_bytes).toString('utf8'); }
      catch { continue; }
    }
    yield openClawRecord(json(value), row.session_id);
  }
}

const HERMES_LOG_NAME = /^agent\.log(?:\.[1-9]\d*)?$/;
const HERMES_CALL = /^(?<date>\d{4}-\d{2}-\d{2}) (?<time>\d{2}:\d{2}:\d{2}),(?<ms>\d{3}) INFO \[(?<session>[^\s\]]+)\] agent\.conversation_loop: API call #(?<number>\d+): model=(?<model>\S+) provider=(?<provider>\S+) in=(?<input>\d+) out=(?<output>\d+) total=\d+ latency=(?<seconds>\d+(?:\.\d+)?)s(?<details>\s.*)?$/;
const HERMES_MAX_LOG_BYTES = 64 * 1024 * 1024;
const HERMES_LOG_CHUNK_BYTES = 256 * 1024;
const HERMES_ANCHOR_BYTES = 256;
const HERMES_MAX_PARTIAL_BYTES = 64 * 1024;
const HERMES_MAX_CATALOGUE_ROWS = 2_000;
const hermesLogCache = new Map(), pendingHermesLogs = new Map(), hermesCatalogues = new Map();
const emptyHermesTail = Buffer.alloc(0);
const hermesHostTZ = process.env.TZ;
// The SSH usage reader sets TZ to the desktop zone for day buckets. Hermes log
// timestamps still refer to the source host's wall clock.
const hermesLogTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const hermesOffsetFormat = new Intl.DateTimeFormat('en', { timeZone: hermesLogTimeZone, timeZoneName: 'longOffset' });

async function hermesFileInfo(file) {
  try { return await stat(file); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

const hermesFileIdentity = meta => [meta.dev, meta.ino, meta.birthtimeMs].join(':');
const hermesFileStamp = meta => [hermesFileIdentity(meta), meta.size, meta.mtimeMs, meta.ctimeMs].join(':');

function rememberHermesEntry(cache, key, value, limit = 64) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) cache.delete(cache.keys().next().value);
}

function rememberHermesLog(key, entry) {
  rememberHermesEntry(hermesLogCache, key, entry);
  let bytes = 0;
  for (const [olderKey, older] of [...hermesLogCache].reverse()) {
    bytes += older.offset;
    if (bytes > HERMES_MAX_LOG_BYTES) hermesLogCache.delete(olderKey);
  }
}

function hermesZoneOffset(at) {
  const formatted = hermesOffsetFormat.formatToParts(at).find(part => part.type === 'timeZoneName')?.value;
  const match = /^GMT([+-])(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(formatted ?? '');
  if (!match) return 0;
  const [, sign, hours, minutes, seconds = 0] = match;
  return (sign === '-' ? -1 : 1) * (Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000;
}

function parseHermesCall(line) {
  const call = HERMES_CALL.exec(line)?.groups;
  if (!call || call.session.length > 256) return null;
  const wallTime = `${call.date}T${call.time}.${call.ms}`;
  let completedAt = Date.parse(wallTime);
  if (!Number.isFinite(completedAt)) return null;
  if (process.env.TZ !== hermesHostTZ) {
    const utc = Date.parse(wallTime + 'Z');
    completedAt = utc - hermesZoneOffset(utc - hermesZoneOffset(utc));
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

async function readHermesAnchor(file, offset) {
  const buffer = Buffer.alloc(Math.min(HERMES_ANCHOR_BYTES, offset));
  const { bytesRead } = await file.read(buffer, 0, buffer.length, offset - buffer.length);
  return buffer.subarray(0, bytesRead);
}

async function indexHermesLog(filename, pace) {
  const file = await open(filename, 'r');
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > HERMES_MAX_LOG_BYTES) throw new Error('hermes_log_too_large');
    const key = hermesFileIdentity(metadata), version = hermesFileStamp(metadata), original = hermesLogCache.get(key);
    if (original?.version === version) {
      rememberHermesLog(key, original);
      return original.records;
    }
    const old = original && metadata.size > original.offset &&
      (await readHermesAnchor(file, original.offset)).equals(original.anchor) ? original : null;
    let offset = old?.offset ?? 0, tail = old?.tail ?? emptyHermesTail;
    const records = [], chunk = Buffer.alloc(HERMES_LOG_CHUNK_BYTES);
    while (offset < metadata.size) {
      const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, metadata.size - offset), offset);
      if (!bytesRead) throw new Error('hermes_log_changed');
      const bytes = Buffer.concat([tail, chunk.subarray(0, bytesRead)]);
      const last = bytes.lastIndexOf(10);
      if (last >= 0) {
        for (const line of bytes.subarray(0, last).toString('utf8').split(/\r?\n/)) {
          const record = parseHermesCall(line.replace(/\r$/, ''));
          if (record) records.push(record);
        }
      }
      const partial = bytes.subarray(last + 1);
      tail = partial.length <= HERMES_MAX_PARTIAL_BYTES ? Buffer.from(partial) : emptyHermesTail;
      offset += bytesRead;
      if (pace) await pace(bytesRead);
    }
    const entry = { version, offset, tail, anchor: await readHermesAnchor(file, offset), records: old ? old.records.concat(records) : records };
    rememberHermesLog(key, entry);
    return entry.records;
  } finally { await file.close(); }
}

function readHermesLog(file, pace) {
  if (pendingHermesLogs.has(file)) return pendingHermesLogs.get(file);
  const task = indexHermesLog(file, pace).finally(() => pendingHermesLogs.delete(file));
  pendingHermesLogs.set(file, task);
  return task;
}

async function readHermesSource(root, cutoffMs) {
  const dir = path.join(root, 'logs');
  const files = [];
  for (const entry of await list(dir)) {
    if (!entry.isFile() || !HERMES_LOG_NAME.test(entry.name)) continue;
    const file = path.join(dir, entry.name), metadata = await hermesFileInfo(file);
    if (metadata?.isFile() && metadata.mtimeMs >= cutoffMs) files.push({ file, metadata });
  }
  if (!files.length) return null;
  files.sort((a, b) => a.file.localeCompare(b.file));
  return {
    root, files: files.map(entry => entry.file),
    bytes: files.reduce((sum, entry) => sum + entry.metadata.size, 0),
    mtimeMs: Math.max(...files.map(entry => entry.metadata.mtimeMs)),
    stamp: files.map(entry => `${path.basename(entry.file)}:${hermesFileStamp(entry.metadata)}`).join('|')
  };
}

export async function hermesSources(roots, cutoffMs = 0, onUnavailable) {
  const profiles = new Set();
  for (const root of roots.slice(0, 100)) {
    const home = await realpath(root).catch(error => { reportDiscoveryError(error, onUnavailable); return null; });
    if (!home) continue;
    profiles.add(home);
    const directory = path.join(home, 'profiles');
    const children = await list(directory).catch(() => { onUnavailable?.(); return []; });
    for (const profile of children.filter(entry => entry.isDirectory()).slice(0, 100)) profiles.add(path.join(directory, profile.name));
  }
  const sources = [];
  for (const root of profiles) {
    const source = await readHermesSource(root, cutoffMs).catch(() => { onUnavailable?.(); return null; });
    if (source) sources.push(source);
  }
  return sources;
}

export async function readHermesRecords(source, { pace, includeCwd = false } = {}) {
  if (source.bytes > HERMES_MAX_LOG_BYTES) throw new Error('hermes_log_too_large');
  const records = new Map();
  for (const file of source.files) {
    for (const record of await readHermesLog(file, pace)) records.set(record.id, record);
  }
  if (!includeCwd) return [...records.values()];
  const metadata = new Map((await hermesSessionCatalogue(source.root)).map(row => [row.id, row.cwd]));
  return [...records.values()].map(record => ({ ...record, cwd: metadata.get(record.sessionId) }));
}

async function hermesSessionCatalogue(root) {
  const file = path.join(root, 'state.db');
  const metadata = await hermesFileInfo(file);
  if (!metadata?.isFile()) return [];
  const wal = await hermesFileInfo(file + '-wal');
  const version = hermesFileStamp(metadata) + ':' + (wal ? hermesFileStamp(wal) : '');
  const cached = hermesCatalogues.get(file);
  if (cached?.version === version) return cached.rows;
  let db;
  try {
    db = openReadonlyDatabase(file);
    const columns = new Set(db.prepare('PRAGMA table_info(sessions)').all().map(row => row.name));
    if (!columns.has('id')) return [];
    const cwd = columns.has('cwd') ? 'cwd' : 'NULL AS cwd';
    const source = columns.has('source') ? 'source' : 'NULL AS source';
    const order = columns.has('started_at') ? 'ORDER BY started_at DESC' : '';
    const rows = db.prepare(`SELECT id, ${cwd}, ${source} FROM sessions ${order} LIMIT ?`).all(HERMES_MAX_CATALOGUE_ROWS);
    rememberHermesEntry(hermesCatalogues, file, { version, rows });
    return rows;
  } catch { return cached?.rows ?? []; }
  finally { db?.close(); }
}

export async function readHermesSessions(roots, { sessionIds = [], worktree, comparePath, warn }) {
  const byId = new Map();
  for (const source of await hermesSources(roots, 0, () => warn?.('notice.hermes-folder-unavailable'))) {
    try {
      const metadata = new Map((await hermesSessionCatalogue(source.root)).map(row => [row.id, row]));
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
      warn?.('notice.hermes-log-unavailable');
    }
  }
  return [...byId].map(([sessionId, records]) => {
    const latest = recentRecords(records);
    return { id: 'hermes:' + sessionId, title: 'Hermes Agent', provider: 'hermes', updatedAt: latest[0].completedAt, records: latest };
  });
}

export class HarnessParser {
  #desktopCache = new Map();

  async *readSince(cutoff, { signal, needsRead = () => true, progress = () => {} } = {}) {
    const sources = await this.#discover(cutoff, signal);
    const total = sources.length;
    let done = 0;
    progress({ done, total });
    for (const source of sources) {
      signal?.throwIfAborted();
      if (needsRead(source)) {
        const result = await source.read().catch(() => null);
        signal?.throwIfAborted();
        if (result?.complete || result?.records?.length) {
          const records = result.records.filter(record => record.completedAt >= cutoff);
          yield { key: source.key, stamp: result.complete ? source.stamp : null, records };
        }
      }
      done++;
      if (done < total && done % 20 === 0) progress({ done, total });
    }
    signal?.throwIfAborted();
  }

  async #discover(cutoff, signal) {
    const home = homedir(), env = process.env;
    const sharedSessionDir = string(env.PI_CODING_AGENT_SESSION_DIR);
    const piAgent = path.resolve(env.PI_CODING_AGENT_DIR || path.join(home, '.pi', 'agent'));
    const ompConfig = path.join(home, env.PI_CONFIG_DIR || '.omp');
    const profile = string(env.OMP_PROFILE ?? env.PI_PROFILE);
    const namedProfile = profile && profile !== 'default' && /^[a-z0-9][a-z0-9._-]*$/i.test(profile) ? profile : null;
    const ompAgent = namedProfile
      ? path.join(ompConfig, 'profiles', namedProfile, 'agent') : path.resolve(env.PI_CODING_AGENT_DIR || path.join(ompConfig, 'agent'));
    const local = discoverUsageUnits(cutoff, {
      providers: SESSION_HARNESSES, includeRecords: true, excludeOhMyPi: true,
      roots: sharedSessionDir && path.isAbsolute(sharedSessionDir) ? { pi: [sharedSessionDir] } : {}
    });
    const files = [], databases = [];
    const addLogs = async (provider, root, matches, depth, reader, companions = () => []) => {
      for (const file of await logFiles(root, matches, depth, signal)) {
        const unit = await fileUnit(provider, file, cutoff, (name, bytes) => reader(name, bytes, signal), { companions: companions(file) });
        if (unit) files.push(unit);
      }
    };
    const addDb = async (provider, file, reader) => {
      const unit = await fileUnit(provider, file, cutoff, name => readHarnessDatabase(name, db => reader(db, cutoff), signal),
        { database: true, companions: [file + '-wal'] });
      if (unit) databases.push(unit);
    };
    const openClaw = path.resolve(env.OPENCLAW_STATE_DIR || path.join(home, '.openclaw'));
    const openClawAgents = path.join(openClaw, 'agents');
    const gemini = path.resolve(env.GEMINI_CLI_HOME || home, '.gemini', 'tmp');
    const grok = path.resolve(env.GROK_HOME || path.join(home, '.grok'));
    const minimax = path.resolve(env.MINIMAX_DATA_DIR || env.MAVIS_DATA_DIR || path.join(home, '.minimax'));
    const kimi = path.resolve(env.KIMI_CODE_HOME || path.join(home, '.kimi-code'));
    const copilot = path.resolve(env.COPILOT_HOME || path.join(home, '.copilot'), 'session-state');
    const workBuddy = path.resolve(env.WORKBUDDY_CONFIG_DIR || path.join(home, '.workbuddy'), 'projects');
    const deepSeek = path.resolve(env.DSH_HOME || path.join(home, '.dsh'), 'sessions');
    const ompRoots = sharedSessionDir && path.isAbsolute(sharedSessionDir) ? [sharedSessionDir] : [path.join(ompAgent, 'sessions')];
    if (!sharedSessionDir && !env.PI_CODING_AGENT_DIR && process.platform !== 'win32' && env.XDG_DATA_HOME) {
      ompRoots.unshift(path.join(env.XDG_DATA_HOME, 'omp', ...(namedProfile ? ['profiles', namedProfile] : []), 'sessions'));
    }
    const jobs = [
      desktopUsageUnit(home, env, cutoff, signal, this.#desktopCache).then(unit => {
        if (unit) files.push(unit);
      }),
      addLogs('gemini', gemini, (name, file) => /^session-.+\.jsonl?$/.test(name) && path.basename(path.dirname(file)) === 'chats', 2, readGemini),
      ...['sessions', 'archived_sessions'].map(directory => addLogs('grokbuild', path.join(grok, directory),
        name => name === 'updates.jsonl', 6, readGrok, file => [path.join(path.dirname(file), 'summary.json')])),
      addDb('mcode', path.join(minimax, 'v2', 'sqlite', 'runtime-state.sqlite'), readMiniMax),
      addLogs('kimi', path.join(kimi, 'sessions'), (name, file) => name === 'wire.jsonl' &&
        path.basename(path.dirname(path.dirname(file))) === 'agents', 4, readKimi),
      ...ompRoots.map(directory => addLogs('omp', directory, name => name.endsWith('.jsonl'), 8,
        (file, size, abort) => readOmp(file, size, abort, path.resolve(directory) === path.resolve(sharedSessionDir || path.join(piAgent, 'sessions'))))),
      addLogs('copilot', copilot, (name, file) => name === 'events.jsonl' && path.dirname(path.dirname(file)) === copilot,
        1, readCopilot, file => [path.join(path.dirname(file), 'workspace.yaml')]),
      addLogs('workbuddy', workBuddy, (name, file) => {
        const parts = path.relative(workBuddy, file).split(path.sep);
        return name.endsWith('.jsonl') && (parts.length === 2 || (parts.length === 4 && parts[2] === 'subagents'));
      }, 3, readWorkBuddy, file => workBuddyParent(file) ? [workBuddyParent(file) + '.jsonl'] : []),
      addLogs('dsh', deepSeek, (name, file) => /^session\.v\d+\.jsonl(?:\.zstd)?$/.test(name) &&
        path.relative(deepSeek, file).split(path.sep).length === 3, 2, readDeepSeek),
      addDb('openclaw', path.join(openClaw, 'state', 'openclaw.sqlite'), readOpenClawDb),
      (async () => {
        for (const agent of await list(openClawAgents)) {
          if (!agent.isDirectory()) continue;
          const folder = path.join(openClawAgents, agent.name);
          await addLogs('openclaw', path.join(folder, 'sessions'), name => name.endsWith('.jsonl'), 0, readOpenClaw);
          await addDb('openclaw', path.join(folder, 'agent', 'openclaw-agent.sqlite'), readOpenClawDb);
        }
      })()
    ];
    // One inaccessible tool's storage must not stall the other collectors.
    await Promise.allSettled(jobs);
    signal?.throwIfAborted();
    return [...await local, ...files.sort((a, b) => a.key.localeCompare(b.key)),
      ...databases.sort((a, b) => a.key.localeCompare(b.key))];
  }
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
    },
    userData,
    ccSwitchDb
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
      .filter(value => typeof value === 'string' && value.trim())
      .map(value => path.resolve(value.replace(/^~(?=$|[\\/])/, homedir()))))];
  }
  if (includeDefaults) for (const provider of ['codex', 'claude']) {
    const accountsRoot = path.join(defaults.userData, provider === 'codex' ? 'codex-accounts' : 'claude-profiles');
    try {
      const accounts = await readdir(accountsRoot, { withFileTypes: true });
      for (const entry of accounts.slice(0, 100)) if (entry.isDirectory()) {
        roots[provider].push(path.join(accountsRoot, entry.name, 'home', provider === 'codex' ? 'sessions' : 'projects'));
      }
    } catch (error) { reportDiscoveryError(error, onUnavailable); }
  }
  return roots;
}

const MAX_FILES = 1500, MAX_DIRECTORIES = 500, MAX_DEPTH = 8, MAX_SUBAGENT_FILES = 200;
const MAX_FILE_BYTES = 16 * 1024 * 1024, MAX_SCAN_BYTES = 64 * 1024 * 1024, MAX_HEADER_BYTES = 262_144;
const CURSOR_ANCHOR_BYTES = 256;
const parseCache = new Map(), headerCache = new Map(), discoveryCache = new Map(), databaseCache = new Map(), locationCache = new Map(), ccSwitchCache = new Map();
const pendingJsonl = new Map();
const databaseRows = new Map();
const antigravityWorkspaces = new Map();
const skippedDirectories = new Set(['node_modules', '.git', 'subagents', 'cache', 'plugins', 'skills', 'auth', 'credentials']);
const shortError = error => typeof error?.code === 'string' ? error.code : ['notice.read-failed'];
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

class ReadWarnings {
  #entries = new Map();

  add(code, ...args) {
    const warning = [code, ...args];
    this.#entries.set(JSON.stringify(warning), warning);
  }

  get size() { return this.#entries.size; }
  [Symbol.iterator]() { return this.#entries.values(); }
}

function replayWarnings(warnings, cached) {
  for (const [code, ...args] of cached?.warnings ?? []) warnings.add(code, ...args);
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
  catch (error) { sourceWarnings.add('notice.antigravity-partial-scan', shortError(error)); return files; }
  for (const entry of entries) {
    if (files.length >= MAX_FILES) { sourceWarnings.add('notice.antigravity-scan-limit'); break; }
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
    warnings.add('notice.invalid-session-folder', provider);
    return [];
  }
  const rootStat = await info(root);
  if (!rootStat) return [];
  if (provider === 'antigravity' && rootStat.isDirectory()) {
    const sourceWarnings = new ReadWarnings();
    const files = await discoverAntigravityTranscripts(root, sourceWarnings);
    const result = { at: Date.now(), files, warnings: [...sourceWarnings] };
    replayWarnings(warnings, result);
    discoveryCache.set(key, result); trimCache(discoveryCache);
    return files;
  }
  const files = [], sourceWarnings = new ReadWarnings();
  let limited = false;
  const matches = file => provider === 'opencode' ? /\.(?:db|sqlite|sqlite3)$/i.test(file) : /\.jsonl$/i.test(file);
  if (rootStat.isFile()) return matches(root) ? [root] : [];
  const entries = walkLogTree(root, {
    maxDepth: MAX_DEPTH, maxDirectories: MAX_DIRECTORIES, deduplicate: true, newestFirst: true, matches,
    skip: name => skippedDirectories.has(name.toLowerCase()),
    onLimit: () => { limited = true; },
    onError: error => sourceWarnings.add('notice.partial-session-scan', provider, shortError(error))
  });
  for await (const file of entries) {
    files.push(file);
    if (files.length >= MAX_FILES) { limited = true; break; }
  }
  if (limited) sourceWarnings.add('notice.session-scan-limit', provider);
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
    db = openReadonlyDatabase(dbPath);
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
  let db;
  try {
    db = openReadonlyDatabase(dbPath, 500);
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
    note?.('notice.antigravity-database-unavailable', shortError(error));
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
    warnings.add('notice.read-size-limit');
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
      sourceWarnings.push(['notice.large-session', candidate.provider]);
    }
    const native = candidate.provider === 'antigravity'
      ? await readAntigravityTimings(candidate.path, (...warning) => sourceWarnings.push(warning))
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
      warnings.add('notice.claude-subagent-unavailable', shortError(error));
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
  let db;
  try {
    db = openReadonlyDatabase(candidate.path, 1000);
    db.exec('BEGIN');
    const available = tables(db), sessions = [], seen = new Set(), sourceWarnings = new ReadWarnings();
    for (const v2 of [true, false]) {
      if (target && !target.cwdFilter && (target.provider === OPENCODE_V2) !== v2) continue;
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
        const provider = openCodeHarness(v2);
        const { records, truncated } = readOpenCodeRecords(db, candidate, provider, messageTable, v2, messageColumns, meta.id);
        if (truncated) sourceWarnings.add('notice.opencode-message-limit');
        sessions.push({ id: `${provider}:${meta.id}`, title: safeTitle(meta.title) || `${provider} · ${String(meta.id).slice(-20)}`,
          provider, path: candidate.path, updatedAt: Number.isFinite(meta.time_updated) ? meta.time_updated : candidate.info.mtimeMs,
          ...(typeof meta.directory === 'string' ? { cwd: meta.directory } : {}), records });
      }
    }
    if (!sessions.length && !available.has('session') && !available.has('session_v2')) sourceWarnings.add('notice.opencode-schema-unavailable');
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
  const times = records.map(record => record.createdAtSec).filter(Number.isFinite);
  const minSec = times.length ? Math.min(...times) - SESSION_PROXY_DEDUP_WINDOW_SECONDS : null;
  const maxSec = times.length ? Math.max(...times) + SESSION_PROXY_DEDUP_WINDOW_SECONDS : null;
  const stamp = fileStamp(dbInfo) + ':' + (wal ? fileStamp(wal) : '');
  const cacheKey = JSON.stringify([canonical, provider, sessionId, minSec, maxSec]);
  const cached = ccSwitchCache.get(cacheKey);
  if (cached?.stamp === stamp) return cached.rows;

  let db;
  try {
    db = openReadonlyDatabase(canonical, 500);
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
    const appFamily = harnessFamily(provider);
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
  const warnings = new ReadWarnings(), budget = { remaining: MAX_SCAN_BYTES };
  if (!target || !isSessionHarness(target.provider)
      || typeof target.sessionId !== 'string' || !target.sessionId || target.sessionId.length > 256) {
    return { session: null, warnings: [['notice.session-unidentified']] };
  }
  const isDatabase = harnessFamily(target.provider) === 'opencode';
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
      warnings.add('notice.session-read-failed', target.provider, shortError(error));
      return null;
    }
  };
  const finish = async session => {
    if (!session) {
      warnings.add('notice.local-session-not-found');
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
      usageRecords: session.records.map(record => ({ ...record, provider: session.provider, sessionId: target.sessionId }))
    } : {}) };
  };
  if (target.provider === 'hermes') {
    const roots = await configuredRoots(options.roots, options.includeDefaults !== false);
    const sessions = await readHermesSessions(roots.hermes, {
      sessionIds: [target.sessionId], warn: code => warnings.add(code)
    });
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
    } catch (error) { warnings.add('notice.session-read-failed', target.provider, shortError(error)); }
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
    return { session: null, warnings: [['notice.channel-unidentified']] };
  }

  const warnings = new ReadWarnings();
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
    replayWarnings(warnings, res);
    if (res.session) preferBetterSession(bySessionId, res.session);
  }

  const roots = wantedCwd || hermesIds.length
    ? await configuredRoots(options.roots, options.includeDefaults !== false) : null;
  if (roots) {
    const sessions = await readHermesSessions(roots.hermes, {
      sessionIds: hermesIds, worktree: wantedCwd, comparePath: value => normalizeComparePath(value, platform),
      warn: code => warnings.add(code)
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
          warnings.add('notice.session-read-failed', provider, shortError(error));
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
        warnings.add('notice.antigravity-location-unavailable');
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
          warnings.add('notice.opencode-session-read-failed', shortError(error));
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
      title: safeTitle(target.title),
      provider: 'channel',
      updatedAt: maxUpdatedAt || Date.now(),
      records: mergedRecords
    },
    warnings: [...warnings],
    ...(options.includeUsageRecords ? { usageRecords: recentRecords(proxyEntries.flatMap(entry =>
      entry.records.map(record => ({ ...record, provider: entry.provider, sessionId: entry.sessionId })))) } : {})
  };
}

/** Read either a channel target (worktree aggregation) or a single explicitly selected conversation. */
export async function readTargetSession(target, options = {}) {
  if (target && (target.worktreePath !== undefined || Array.isArray(target.sessions))) {
    return readChannelSessions(target, options);
  }
  return readSingleTargetSession(target, options);
}

export async function enrichChannelRecords(records, sessions, ccSwitchDb = defaultRoots().ccSwitchDb) {
  const entries = new Map();
  const keyOf = ({ provider, sessionId }) => JSON.stringify([provider, sessionId ?? '']);
  for (const { provider, sessionId } of sessions) entries.set(keyOf({ provider, sessionId }), { provider, sessionId, records: [] });
  for (const row of records) {
    const key = keyOf(row);
    if (!entries.has(key)) entries.set(key, { provider: row.provider, sessionId: row.sessionId, records: [] });
    entries.get(key).records.push(row);
  }
  const sources = [...entries.values()];
  for (const entry of sources) entry.proxyRows = await readCcSwitchProxyRows(ccSwitchDb, entry.provider, entry.sessionId, entry.records);
  return mergeChannelProxyRecords(sources);
}

// ---- Usage totals: every session written in the last 30 days, read whole, once per change. ----

const USAGE_MAX_FILE_BYTES = 256 * 1024 * 1024, USAGE_MAX_UNITS = 20_000, USAGE_MAX_DIRECTORIES = 5_000;

/** Every JSONL session file under a root that was written at or after cutoffMs; subagent folders are skipped. */
async function walkRecentJsonl(root, cutoffMs, onUnavailable) {
  const rootStat = await info(root, onUnavailable);
  if (!rootStat?.isDirectory()) return [];
  const found = [];
  const entries = walkLogTree(root, {
    maxDirectories: USAGE_MAX_DIRECTORIES, deduplicate: true, countCanonical: true,
    matches: name => /\.jsonl$/i.test(name),
    skip: name => skippedDirectories.has(name.toLowerCase()),
    onError: error => reportDiscoveryError(error, onUnavailable)
  });
  for await (const file of entries) {
    const metadata = await info(file, onUnavailable);
    if (metadata?.isFile() && metadata.mtimeMs >= cutoffMs) found.push({ path: file, size: metadata.size, mtimeMs: metadata.mtimeMs });
  }
  return found;
}

const USAGE_STREAM_BATCH_ROWS = 2_000;
const USAGE_CHUNK_BYTES = 1024 * 1024;

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
  try { return object(JSON.parse(line)); } catch { return null; }
}

/** Codex keeps its session id in the first session_meta row, as parseJsonl reads it. */
async function codexSessionId(file) {
  const handle = await open(file, 'r');
  try {
    const size = Math.min(MAX_HEADER_BYTES, (await handle.stat()).size);
    const buffer = Buffer.alloc(size), { bytesRead } = await handle.read(buffer, 0, size, 0);
    for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n').slice(0, 30)) {
      const row = parsedRow(line);
      if (row?.type === 'session_meta') return shortText(object(row.payload)?.id);
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

async function addFileRecords(days, provider, file, minDay, isSubagent, leaderboardDays, pace, fallback = {}) {
  const metadata = await stat(file);
  if (!metadata.isFile()) throw new Error('not_a_regular_file');
  if (metadata.size > USAGE_MAX_FILE_BYTES) throw Object.assign(new Error('session_file_too_large'), { code: 'too_large' });
  const cursor = createJsonlCursor('', provider, '', { isSubagent, limit: Infinity });
  const complete = await streamCompleteText(file, text => cursor.feed(text), pace);
  if (leaderboardDays?.records && !complete) leaderboardDays.complete = false;
  const sessionId = cursor.sessionId ?? fallback.sessionId ?? null;
  const cwd = cursor.cwd ?? fallback.cwd ?? null;
  const records = cursor.finish();
  accumulateRecords(days, provider, leaderboardDays?.records
    ? records.map(record => ({ ...record, sessionId, cwd })) : records, { minDay, leaderboardDays });
  return { sessionId, cwd };
}

async function fileUsageUnit(provider, file, rankWindow, onUnavailable, excludeOhMyPi = false) {
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
  const stamp = [
    identity(file.path), file.size, file.mtimeMs,
    ...(provider === 'codex' ? [] : ['meta2']),
    ...subagents.map(item => `${item.size}:${item.mtimeMs}`)
  ].join(':');
  return {
    // A switch between mirrored files replaces the same logical unit, including its retained counts.
    key: identity(`${provider}|${path.basename(file.path)}`),
    stamp,
    bytes: file.size + subagents.reduce((sum, item) => sum + item.size, 0),
    mtimeMs: file.mtimeMs,
    read: async () => {
      const minDay = dayKeyAgo(Date.now(), HISTORY_DAYS - 1), days = {}, rank = rankedUsage(rankWindow);
      if (excludeOhMyPi && provider === 'pi') {
        // Pi and Oh My Pi can share a session directory. Only Oh My Pi writes a title slot before the header.
        const handle = await open(file.path, 'r');
        let first;
        try { first = (await readAt(handle, 0, 4096)).toString('utf8').split('\n', 1)[0]; }
        finally { await handle.close(); }
        if (parsedRow(first)?.type === 'title') return usageResult(days, rank);
      }
      const pace = readPacer();
      if (provider === 'codex') await addCodexStreamRecords(days, file.path, minDay, rank, pace);
      else {
        const parent = await addFileRecords(days, provider, file.path, minDay, false, rank, pace,
          provider === 'claude' ? { sessionId: path.basename(file.path, '.jsonl') } : undefined);
        for (const item of subagents) await addFileRecords(days, 'claude', item.path, minDay, true, rank, pace, parent);
      }
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
  const db = openReadonlyDatabase(dbPath);
  try {
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
    accumulateRecords(days, openCodeHarness(v2), entries,
      { minDay: dayKeyAgo(Date.now(), HISTORY_DAYS - 1), leaderboardDays: rank });
    return usageResult(days, rank);
  } finally { db.close(); }
}

/** One unit per OpenCode session updated since cutoffMs; the unit's stamp includes its message count. */
async function openCodeUsageUnits(dbPath, cutoffMs, rankWindow, onUnavailable) {
  const database = await info(dbPath, onUnavailable);
  if (!database?.isFile()) return [];
  const units = [];
  let db;
  try {
    db = openReadonlyDatabase(dbPath);
    const available = tables(db);
    for (const v2 of [false, true]) {
      const table = v2 ? 'session_v2' : 'session', messageTable = v2 ? 'session_message' : 'message';
      if (!available.has(table) || !available.has(messageTable)) continue;
      const sessionColumns = columns(db, table);
      if (!sessionColumns.has('id') || !sessionColumns.has('time_updated')) continue;
      const provider = openCodeHarness(v2);
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
  const days = {}, rank = rankedUsage(rankWindow);
  const native = await readAntigravityTimings(transcript);
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
  const enabled = provider => !options.providers || options.providers.includes(provider);
  const rankWindow = rankDay ? { from: rankFrom, start: leaderboardDayStart(rankFrom),
    end: leaderboardDayStart(rankDay) + 86_400_000, includeRecent, includeUsageTimes, includeRecords, recordFrom: cutoffMs } :
    includeRecords ? { includeRecords, recordFrom: cutoffMs } : undefined;
  // Mirrors are append-only transcripts. Keep the largest copy; use its modification time to break ties.
  // A sync can give a stale copy a newer mtime, so root order and mtime alone cannot identify the fullest log.
  const units = [];
  for (const provider of ['codex', 'claude', 'pi']) {
    if (!enabled(provider)) continue;
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
      const unit = await fileUsageUnit(provider, file, rankWindow, onUnavailable, options.excludeOhMyPi);
      if (unit) units.push(unit);
    }
  }
  for (const root of (enabled('opencode') ? roots.opencode : []).slice(0, 10)) {
    try { units.push(...await openCodeUsageUnits(root, cutoffMs, rankWindow, onUnavailable)); }
    catch { onUnavailable?.(); }
  }
  for (const root of (enabled('antigravity') ? roots.antigravity : []).slice(0, 10)) {
    units.push(...await antigravityUsageUnits(root, cutoffMs, rankWindow, onUnavailable));
  }
  for (const source of enabled('hermes') ? await hermesSources(roots.hermes, cutoffMs, onUnavailable) : []) {
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

/** Discover only configured provider roots. Optional includeDefaults:false isolates tests/custom scans. */
export async function scanSessions(options = {}) {
  const maxSessions = Math.max(1, Math.min(100, Number.isInteger(options.maxSessions) ? options.maxSessions : 100));
  const warnings = new ReadWarnings(), roots = await configuredRoots(options.roots, options.includeDefaults !== false);
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
  if (candidates.length > selected.length) warnings.add('notice.scan-files-limit', maxSessions);
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
    } catch (error) { warnings.add('notice.session-read-failed', candidate.provider, shortError(error)); }
  }
  const unique = new Map();
  for (const session of sessions) {
    const previous = unique.get(session.id);
    const completed = session.records[0]?.completedAt ?? 0, oldCompleted = previous?.records[0]?.completedAt ?? 0;
    if (!previous || completed > oldCompleted || (completed === oldCompleted && session.records.length > previous.records.length)) unique.set(session.id, session);
  }
  return { sessions: [...unique.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, maxSessions), warnings: [...warnings] };
}

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const millisecondTimestamp = value => epochMilliseconds(value, 'milliseconds');

export const SPEED_MIN_OUTPUT_TOKENS = 100;
export const SPEED_MIN_GENERATION_MS = 100;
export const SPEED_ESTIMATE_MIN_OUTPUT_TOKENS = 200;
export const SPEED_ESTIMATE_MIN_DURATION_MS = 1000;
const HERMES_MIN_OUTPUT_TOKENS = 20;
const HERMES_MIN_DURATION_MS = 300;
export const MIN_PLAUSIBLE_LATENCY_MS = 100;
export const MAX_PLAUSIBLE_LATENCY_MS = 60 * 60 * 1000;
export const SESSION_PROXY_DEDUP_WINDOW_SECONDS = 600;

const MAX_CHAIN_HOPS = 32;
const SAME_FLUSH_SLACK_MS = 100;
const CODEX_USAGE_KEYS = [
  'input_tokens', 'cached_input_tokens', 'cache_read_input_tokens',
  'output_tokens', 'reasoning_output_tokens', 'total_tokens'
];

export function estimatedLatencyMs(startMs, endMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  const latency = Math.round(endMs - startMs);
  return latency >= MIN_PLAUSIBLE_LATENCY_MS && latency <= MAX_PLAUSIBLE_LATENCY_MS ? latency : null;
}

export function estimatedFirstTokenMs(startMs, firstOutputMs, latencyMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(firstOutputMs) || !Number.isFinite(latencyMs) || latencyMs <= 0) return null;
  const firstToken = Math.round(firstOutputMs - startMs);
  return firstToken > 0 && firstToken <= latencyMs ? firstToken : null;
}

export function isSessionLogSource(dataSource) {
  return typeof dataSource === 'string' && dataSource.length > 0 && dataSource !== 'proxy';
}

export function computeSpeedMetrics({ outputTokens, durationMs, firstTokenMs = null, dataSource = 'session_log' }) {
  const output = count(outputTokens);
  const latency = count(durationMs);
  const firstToken = count(firstTokenMs);
  if (!isSessionLogSource(dataSource)) {
    const generationMs = latency !== null && firstToken !== null && latency > firstToken ? latency - firstToken : null;
    if (output !== null && output >= SPEED_MIN_OUTPUT_TOKENS && generationMs !== null && generationMs >= SPEED_MIN_GENERATION_MS) {
      const tps = output / (generationMs / 1000);
      if (Number.isFinite(tps) && tps > 0) {
        return { tokensPerSecond: tps, isEstimatedSpeed: false, generationMs };
      }
    }
    return { tokensPerSecond: null, isEstimatedSpeed: false, generationMs };
  }
  const minimumOutput = dataSource === 'hermes_log' ? HERMES_MIN_OUTPUT_TOKENS : SPEED_ESTIMATE_MIN_OUTPUT_TOKENS;
  const minimumDuration = dataSource === 'hermes_log' ? HERMES_MIN_DURATION_MS : SPEED_ESTIMATE_MIN_DURATION_MS;
  if (output !== null && output >= minimumOutput && latency !== null && latency >= minimumDuration) {
    const tps = output / (latency / 1000);
    if (Number.isFinite(tps) && tps > 0) {
      return { tokensPerSecond: tps, isEstimatedSpeed: true, generationMs: null };
    }
  }
  return { tokensPerSecond: null, isEstimatedSpeed: false, generationMs: null };
}

export function normalizeCodexModel(value) {
  const raw = shortText(value);
  if (!raw) return null;
  const afterSlash = raw.slice(raw.lastIndexOf('/') + 1).trim().toLowerCase();
  if (!afterSlash) return null;
  return afterSlash.replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-\d{8}$/, '') || null;
}

function computeCacheHitRate(inputTokens, cacheReadTokens, cacheCreationTokens, cacheInclusive = false) {
  const input = count(inputTokens), read = count(cacheReadTokens), write = count(cacheCreationTokens);
  if (input === null || read === null || write === null) return null;
  const fresh = cacheInclusive ? Math.max(0, input - read - write) : input;
  const cacheable = fresh + write + read;
  return cacheable > 0 && read <= cacheable ? read / cacheable : null;
}

function buildRecord({
  id, rawId = null, completedAt, createdAtSec = null, dataSource,
  inputTokens = 0, cacheReadTokens = 0, cacheCreationTokens = 0, cacheInclusive = false,
  outputTokens, durationMs, firstTokenMs = null, model = null, isSubagent = false
}) {
  if (!Number.isFinite(completedAt)) return null;
  const inTok = count(inputTokens) ?? 0;
  const readTok = count(cacheReadTokens) ?? 0;
  const writeTok = count(cacheCreationTokens) ?? 0;
  const freshInputTokens = cacheInclusive ? Math.max(0, inTok - readTok - writeTok) : inTok;
  const outTok = count(outputTokens);
  const latency = count(durationMs);
  const validDuration = latency !== null && latency > 0 ? latency : null;
  const validFirstToken = validDuration !== null && count(firstTokenMs) !== null && firstTokenMs > 0 && firstTokenMs <= validDuration
    ? count(firstTokenMs) : null;
  const speed = computeSpeedMetrics({ outputTokens: outTok, durationMs: validDuration, firstTokenMs: validFirstToken, dataSource });
  const cacheHitRate = computeCacheHitRate(inTok, readTok, writeTok, cacheInclusive);
  const sec = Number.isFinite(createdAtSec) ? Math.floor(createdAtSec) : Math.floor(completedAt / 1000);
  const cleanModel = shortText(model);
  return {
    id,
    ...(rawId ? { rawId } : {}),
    completedAt,
    createdAtSec: sec,
    dataSource,
    freshInputTokens,
    outputTokens: outTok,
    cacheReadTokens: readTok,
    cacheCreationTokens: writeTok,
    durationMs: validDuration,
    firstTokenMs: validFirstToken,
    generationMs: speed.generationMs,
    tokensPerSecond: speed.tokensPerSecond,
    isEstimatedSpeed: speed.isEstimatedSpeed,
    ...(cacheHitRate !== null ? { cacheHitRate } : {}),
    ...(cleanModel && cleanModel !== 'unknown' ? { model: cleanModel } : {}),
    ...(isSubagent ? { isSubagent: true } : {})
  };
}

export function buildHermesRecord({ cacheReported, ...request }) {
  const result = buildRecord({ ...request, dataSource: 'hermes_log', cacheInclusive: true });
  if (result && !cacheReported) delete result.cacheHitRate;
  return result;
}

/** Newest first, de-duplicated by id. Session views keep 100; usage totals pass Infinity. */
export function recentRecords(records, limit = 100) {
  return [...new Map(records.filter(Boolean).map(value => [value.id, value])).values()]
    .sort((a, b) => b.completedAt - a.completedAt).slice(0, limit);
}

const maxOpt = (a, b) => a === null ? b : b === null ? a : Math.max(a, b);

function parseCodexTokens(value) {
  const obj = object(value);
  if (!obj || !CODEX_USAGE_KEYS.some(key => count(obj[key]) !== null)) return null;
  return {
    input: count(obj.input_tokens) ?? 0,
    cachedInput: count(obj.cached_input_tokens) ?? count(obj.cache_read_input_tokens) ?? 0,
    cacheWriteInput: count(obj.cache_write_input_tokens) ?? 0,
    output: count(obj.output_tokens) ?? 0,
    reasoningOutput: count(obj.reasoning_output_tokens),
    total: count(obj.total_tokens)
  };
}

function codexTokenSignature(info) {
  const total = object(info?.total_token_usage), last = object(info?.last_token_usage);
  if (!parseCodexTokens(total) && !parseCodexTokens(last)) return null;
  const pick = src => src ? [
    count(src.input_tokens),
    count(src.cached_input_tokens) ?? count(src.cache_read_input_tokens),
    count(src.output_tokens),
    count(src.reasoning_output_tokens),
    count(src.total_tokens)
  ] : null;
  return JSON.stringify([pick(total), pick(last)]);
}

/** Incremental Codex parser: feed row batches in order, then finish. Same results as one call with all rows.
 *  `sessionId` may be a getter: the cursor can learn the id from a session_meta row that arrives after this parser is built. */
export function createCodexParser(sessionId, { truncated = false, limit = 100 } = {}) {
  const sessionIdOf = typeof sessionId === 'function' ? sessionId : () => sessionId;
  const idPrefix = current => `codex_session:${current || 'session'}:`;
  let results = [];
  const lastSignatureBySource = new Map();
  let previousTokenSignature = null;
  let totalHighWater = null;
  let currentModel = null;
  let eventIndex = 0;

  let lastBoundaryMs = null;
  let requestStartMs = null;
  let lastModelOutputMs = null;
  let toolOutputAfterModelOutputMs = null;
  let firstOutputMs = null;
  let usageRecord = null;
  let pendingUsageRecord = null;
  let lastTokenCountMs = null;

  const resetInFlight = boundaryMs => {
    requestStartMs = null;
    lastModelOutputMs = null;
    toolOutputAfterModelOutputMs = null;
    firstOutputMs = null;
    usageRecord = null;
    if (boundaryMs !== null) lastBoundaryMs = maxOpt(lastBoundaryMs, boundaryMs);
  };

  const finishRequest = (tokenCountMs, last) => {
    const startMs = requestStartMs ?? lastBoundaryMs;
    const saved = usageRecord;
    const recordEndMs = saved && (last === null || (
      saved.usage.input === last.input &&
      saved.usage.cachedInput === last.cachedInput &&
      saved.usage.output === last.output
    )) ? saved.timestampMs : null;
    const waitedForTools = toolOutputAfterModelOutputMs !== null &&
      (tokenCountMs === null || (tokenCountMs - toolOutputAfterModelOutputMs) <= SAME_FLUSH_SLACK_MS);
    const endMs = recordEndMs ?? (waitedForTools ? lastModelOutputMs : tokenCountMs);
    const latencyMs = startMs !== null && endMs !== null ? estimatedLatencyMs(startMs, endMs) : null;
    const ttftMs = startMs !== null && firstOutputMs !== null && latencyMs !== null
      ? estimatedFirstTokenMs(startMs, firstOutputMs, latencyMs) : null;
    resetInFlight(tokenCountMs);
    if (tokenCountMs !== null) lastTokenCountMs = tokenCountMs;
    return { latencyMs, firstTokenMs: ttftMs, endMs: endMs ?? tokenCountMs };
  };

  let rowIndex = 0;
  const feed = batch => {
  for (const row of batch) {
    const i = rowIndex++;
    const atRaw = millisecondTimestamp(row.timestamp), at = Number.isFinite(atRaw) ? atRaw : null;
    const payload = object(row.payload);

    if (row.type === 'turn_context') {
      const m = normalizeCodexModel(payload?.model ?? object(payload?.info)?.model);
      if (m) currentModel = m;
      if (at !== null) lastBoundaryMs = maxOpt(lastBoundaryMs, at);
      continue;
    }

    if (row.type === 'response_item' && payload) {
      const pType = typeof payload.type === 'string' ? payload.type : '';
      if (pType === 'message' && payload.role !== 'assistant') {
        if (at !== null) lastBoundaryMs = maxOpt(lastBoundaryMs, at);
      } else if (pType.endsWith('_output')) {
        if (at !== null) {
          lastBoundaryMs = maxOpt(lastBoundaryMs, at);
          if (lastModelOutputMs !== null) toolOutputAfterModelOutputMs = at;
        }
      } else if ((pType === 'message' && payload.role === 'assistant') || pType === 'reasoning' || pType.endsWith('_call')) {
        if (at !== null) {
          const trailingFlush = requestStartMs === null && lastTokenCountMs !== null && (at - lastTokenCountMs) <= SAME_FLUSH_SLACK_MS;
          if (!trailingFlush) {
            if (requestStartMs === null) requestStartMs = lastBoundaryMs;
            lastModelOutputMs = at;
            toolOutputAfterModelOutputMs = null;
          }
        }
      }
      continue;
    }

    if (row.type === 'token_usage_record' && payload) {
      const parsedUsage = parseCodexTokens(payload.usage);
      if (parsedUsage) {
        usageRecord = { timestampMs: at, usage: parsedUsage };
        pendingUsageRecord = {
          timestampMs: at,
          usage: parsedUsage,
          key: shortText(payload.response_id) ?? `line-${i}`,
          model: currentModel
        };
      }
      continue;
    }

    if (row.type !== 'event_msg' || !payload) continue;

    if (payload.type === 'thread_settings_applied') {
      const m = normalizeCodexModel(object(payload.thread_settings)?.model);
      if (m) currentModel = m;
      continue;
    }

    if (payload.type === 'item_completed') {
      const itemType = object(payload.item)?.type;
      if (itemType === 'Reasoning' || itemType === 'AgentMessage') {
        const startedAt = count(payload.started_at_ms);
        if (startedAt !== null && startedAt > 0) {
          firstOutputMs = firstOutputMs === null ? startedAt : Math.min(firstOutputMs, startedAt);
        }
      }
      continue;
    }

    if (payload.type === 'task_started' || payload.type === 'turn_started' || payload.type === 'turn_aborted') {
      resetInFlight(at);
      continue;
    }

    if (payload.type !== 'token_count') continue;
    const info = object(payload.info);
    if (!info) continue;
    const explicitModel = normalizeCodexModel(info.model ?? info.model_name ?? payload.model);
    if (explicitModel) currentModel = explicitModel;

    const signature = codexTokenSignature(info);
    if (!signature) continue;
    const total = parseCodexTokens(info.total_token_usage);
    const last = parseCodexTokens(info.last_token_usage);
    const limitId = shortText(object(payload.rate_limits)?.limit_id) ?? '';
    const isDuplicate = total !== null && (
      lastSignatureBySource.get(limitId) === signature || previousTokenSignature === signature
    );
    if (total !== null) lastSignatureBySource.set(limitId, signature);
    previousTokenSignature = signature;

    if (pendingUsageRecord) {
      const pending = pendingUsageRecord;
      pendingUsageRecord = null;
      const lastIsZero = last !== null && last.input === 0 && last.cachedInput === 0 && last.cacheWriteInput === 0 && last.output === 0;
      const matchesPending = last !== null &&
        last.input === pending.usage.input &&
        last.cachedInput === pending.usage.cachedInput &&
        last.cacheWriteInput === pending.usage.cacheWriteInput &&
        last.output === pending.usage.output;
      if (lastIsZero && !matchesPending && (pending.usage.input > 0 || pending.usage.cachedInput > 0 || pending.usage.output > 0)) {
        const u = pending.usage;
        const clampedRead = Math.min(u.cachedInput, u.input);
        const clampedWrite = Math.min(u.cacheWriteInput, u.input - clampedRead);
        if (pending.timestampMs !== null) {
          results.push(buildRecord({
            id: `${idPrefix(sessionIdOf())}usage:${pending.key}`,
            completedAt: pending.timestampMs,
            dataSource: 'codex_session',
            inputTokens: u.input,
            cacheReadTokens: clampedRead,
            cacheCreationTokens: clampedWrite,
            cacheInclusive: true,
            outputTokens: u.output,
            durationMs: null,
            model: pending.model
          }));
        }
      }
    }

    if (isDuplicate) continue;

    let delta = null;
    if (last !== null) {
      delta = { ...last };
      if (total !== null) {
        if (!totalHighWater || (total.output < totalHighWater.output && total.output === last.output && total.input === last.input)) {
          totalHighWater = { ...total };
        } else {
          totalHighWater = {
            input: Math.max(totalHighWater.input, total.input),
            cachedInput: Math.max(totalHighWater.cachedInput, total.cachedInput),
            cacheWriteInput: Math.max(totalHighWater.cacheWriteInput, total.cacheWriteInput),
            output: Math.max(totalHighWater.output, total.output)
          };
        }
      }
    } else if (total !== null) {
      if (truncated && !totalHighWater) {
        totalHighWater = { ...total };
        resetInFlight(at);
        if (at !== null) lastTokenCountMs = at;
        continue;
      }
      const base = totalHighWater ?? { input: 0, cachedInput: 0, cacheWriteInput: 0, output: 0 };
      delta = {
        input: Math.max(0, total.input - base.input),
        cachedInput: Math.max(0, total.cachedInput - base.cachedInput),
        cacheWriteInput: Math.max(0, total.cacheWriteInput - base.cacheWriteInput),
        output: Math.max(0, total.output - base.output)
      };
      totalHighWater = {
        input: Math.max(base.input, total.input),
        cachedInput: Math.max(base.cachedInput, total.cachedInput),
        cacheWriteInput: Math.max(base.cacheWriteInput, total.cacheWriteInput),
        output: Math.max(base.output, total.output)
      };
    }
    if (!delta) continue;

    const cachedInput = Math.min(delta.cachedInput, delta.input);
    const cacheWriteInput = Math.min(delta.cacheWriteInput, delta.input - cachedInput);
    if (delta.input === 0 && cachedInput === 0 && delta.output === 0) continue;

    const timing = finishRequest(at, last);
    const completedAt = timing.endMs ?? at;
    if (completedAt === null) continue;
    eventIndex += 1;
    results.push(buildRecord({
      id: `${idPrefix(sessionIdOf())}${eventIndex}`,
      completedAt,
      dataSource: 'codex_session',
      inputTokens: delta.input,
      cacheReadTokens: cachedInput,
      cacheCreationTokens: cacheWriteInput,
      cacheInclusive: true,
      outputTokens: delta.output,
      durationMs: timing.latencyMs,
      firstTokenMs: timing.firstTokenMs,
      model: currentModel
    }));
  }
  if (results.length > limit * 2) results = recentRecords(results, limit);
  };
  return {
    feed,
    finish() {
      // IDs are minted per batch, so a session_meta row that arrived later applies to every record minted without it.
      const current = sessionIdOf();
      if (current) {
        for (const record of results) {
          if (record?.id.startsWith(idPrefix(null))) record.id = idPrefix(current) + record.id.slice(idPrefix(null).length);
        }
      }
      return recentRecords(results, limit);
    }
  };
}

export function createClaudeParser({ isSubagent = false, limit = 100 } = {}) {
  const chain = new Map();
  const messages = new Map();
  const timings = new Map();

  function addRow(row) {
    const uuid = shortText(row.uuid);
    const atRaw = millisecondTimestamp(row.timestamp), at = Number.isFinite(atRaw) ? atRaw : null;
    if (uuid) {
      chain.set(uuid, {
        parent: shortText(row.parentUuid),
        timestampMs: at,
        isAttachment: row.type === 'attachment'
      });
    }
    if (row.type !== 'assistant') return;
    const message = object(row.message);
    if (!message) return;
    const msgId = shortText(message.id) ?? uuid;
    if (!msgId) return;

    const usage = object(message.usage);
    const inputTokens = count(usage?.input_tokens) ?? 0;
    const outputTokens = count(usage?.output_tokens) ?? 0;
    const cacheReadTokens = count(usage?.cache_read_input_tokens) ?? 0;
    const cacheCreationTokens = count(usage?.cache_creation_input_tokens) ?? 0;
    const stopReason = shortText(message.stop_reason);
    const model = shortText(message.model);
    const sidechain = Boolean(isSubagent || row.isSidechain === true);

    let timing = timings.get(msgId);
    if (!timing) {
      const blockIndex = row.apiBlockIndex;
      const startsAtFirstBlock = blockIndex === undefined || blockIndex === null || blockIndex === 0;
      const thinkingDuration = count(row.thinkingDurationMs);
      const firstBlock = Array.isArray(message.content) ? object(message.content[0]) : null;
      const firstOutputMs = startsAtFirstBlock && at !== null && thinkingDuration !== null && thinkingDuration > 0 && firstBlock?.type === 'thinking'
        ? at - thinkingDuration : null;
      timing = {
        firstParent: shortText(row.parentUuid),
        startsAtFirstBlock,
        endMs: at ?? -Infinity,
        firstOutputMs
      };
      timings.set(msgId, timing);
    } else if (at !== null && at > timing.endMs) {
      timing.endMs = at;
    }

    const existing = messages.get(msgId);
    const hasStop = stopReason !== null, existingHasStop = existing ? existing.stopReason !== null : false;
    const shouldReplace = !existing || (hasStop && !existingHasStop) ||
      (hasStop === existingHasStop && outputTokens > existing.outputTokens);
    if (shouldReplace) {
      messages.set(msgId, {
        msgId,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        stopReason,
        model: model ?? existing?.model ?? null,
        timestampMs: at ?? existing?.timestampMs ?? null,
        isSubagent: sidechain || Boolean(existing?.isSubagent)
      });
    } else if (existing) {
      if (!existing.model && model) existing.model = model;
      if (sidechain) existing.isSubagent = true;
    }
  }

  const resolveRequestStartMs = firstParent => {
    let cursor = firstParent;
    for (let hop = 0; hop < MAX_CHAIN_HOPS && cursor; hop++) {
      const node = chain.get(cursor);
      if (!node) return null;
      if (!node.isAttachment) return node.timestampMs;
      cursor = node.parent;
    }
    return null;
  };

  function buildMessage(msgId, msg) {
    if (msg.inputTokens === 0 && msg.outputTokens === 0 && msg.cacheReadTokens === 0 && msg.cacheCreationTokens === 0) return null;
    const timing = timings.get(msgId);
    const endMs = timing && Number.isFinite(timing.endMs) ? timing.endMs : msg.timestampMs;
    if (!Number.isFinite(endMs)) return null;
    let latencyMs = null, firstTokenMs = null;
    if (msg.stopReason !== null && timing?.startsAtFirstBlock && Number.isFinite(timing.endMs)) {
      const startMs = resolveRequestStartMs(timing.firstParent);
      if (startMs !== null) {
        latencyMs = estimatedLatencyMs(startMs, timing.endMs);
        if (latencyMs !== null && timing.firstOutputMs !== null) {
          firstTokenMs = estimatedFirstTokenMs(startMs, timing.firstOutputMs, latencyMs);
        }
      }
    }
    return buildRecord({
      id: `session:${msgId}`,
      rawId: msgId,
      completedAt: endMs,
      createdAtSec: Number.isFinite(msg.timestampMs) ? Math.floor(msg.timestampMs / 1000) : Math.floor(endMs / 1000),
      dataSource: 'session_log',
      inputTokens: msg.inputTokens,
      cacheReadTokens: msg.cacheReadTokens,
      cacheCreationTokens: msg.cacheCreationTokens,
      cacheInclusive: false,
      outputTokens: msg.outputTokens,
      durationMs: latencyMs,
      firstTokenMs,
      model: msg.model,
      isSubagent: msg.isSubagent
    });
  }
  return {
    feed(rows) { for (const row of rows) addRow(row); },
    finish() { return recentRecords(Array.from(messages, ([id, message]) => buildMessage(id, message)), limit); }
  };
}

function piTimestampMs(value) {
  return epochMilliseconds(value, 'auto', true);
}

function extractPiTokens(usageObj) {
  const u = object(usageObj);
  if (!u) return null;
  const input = count(u.input) ?? 0;
  const output = count(u.output) ?? 0;
  const cacheRead = count(u.cacheRead) ?? 0;
  const cacheWrite = count(u.cacheWrite) ?? 0;
  return (input > 0 || output > 0 || cacheRead > 0 || cacheWrite > 0)
    ? { input, output, cacheRead, cacheWrite } : null;
}

function createPiParser({ limit = 100 } = {}) {
  let results = [];
  let currentModel = null;
  let rowIndex = 0;

  function addRow(row) {
    const i = rowIndex++;
    if (row.type === 'model_change') {
      currentModel = shortText(row.modelId) ?? shortText(row.model) ?? currentModel;
      return;
    }
    const entryId = shortText(row.id) ?? `line-${i}`;
    const entryAt = piTimestampMs(row.timestamp);

    if (row.type === 'compaction' || row.type === 'branch_summary' || row.type === 'model_usage') {
      const tokens = extractPiTokens(row.usage);
      if (!tokens || !Number.isFinite(entryAt)) return;
      const latencyMs = row.type === 'model_usage' && typeof row.duration === 'number' && Number.isFinite(row.duration) && row.duration > 0
        ? estimatedLatencyMs(0, Math.round(row.duration)) : null;
      results.push(buildRecord({
        id: `pi_session:${entryId}`,
        rawId: entryId,
        completedAt: entryAt,
        dataSource: 'pi_session',
        inputTokens: tokens.input,
        cacheReadTokens: tokens.cacheRead,
        cacheCreationTokens: tokens.cacheWrite,
        cacheInclusive: false,
        outputTokens: tokens.output,
        durationMs: latencyMs,
        model: shortText(row.model) ?? shortText(row.modelId) ?? currentModel
      }));
      return;
    }

    if (row.type !== 'message') return;
    const message = object(row.message);
    if (!message) return;

    if (message.role === 'toolResult' && message.toolName === 'subagent' && !object(message.usage)) {
      const details = object(message.details ?? row.details);
      if (details && ['single', 'parallel', 'chain'].includes(details.mode) && !details.sessionFile && Array.isArray(details.results)) {
        details.results.forEach((subResult, subIdx) => {
          const sr = object(subResult);
          if (!sr) return;
          let emittedChild = false;
          if (Array.isArray(sr.messages)) {
            sr.messages.forEach((child, childIdx) => {
              const cm = object(child);
              if (cm?.role !== 'assistant') return;
              const tokens = extractPiTokens(cm.usage);
              if (!tokens) return;
              const childAt = piTimestampMs(cm.timestamp);
              const at = Number.isFinite(childAt) ? childAt : entryAt;
              if (!Number.isFinite(at)) return;
              emittedChild = true;
              results.push(buildRecord({
                id: `pi_session:${entryId}:sub:${subIdx}:${childIdx}`,
                completedAt: at,
                dataSource: 'pi_session',
                inputTokens: tokens.input,
                cacheReadTokens: tokens.cacheRead,
                cacheCreationTokens: tokens.cacheWrite,
                cacheInclusive: false,
                outputTokens: tokens.output,
                durationMs: null,
                model: shortText(cm.model) ?? currentModel,
                isSubagent: true
              }));
            });
          }
          if (!emittedChild && Number.isFinite(entryAt)) {
            const tokens = extractPiTokens(sr.usage);
            if (tokens) {
              results.push(buildRecord({
                id: `pi_session:${entryId}:sub:${subIdx}`,
                completedAt: entryAt,
                dataSource: 'pi_session',
                inputTokens: tokens.input,
                cacheReadTokens: tokens.cacheRead,
                cacheCreationTokens: tokens.cacheWrite,
                cacheInclusive: false,
                outputTokens: tokens.output,
                durationMs: null,
                model: shortText(sr.model) ?? currentModel,
                isSubagent: true
              }));
            }
          }
        });
        return;
      }
    }

    if (message.role !== 'assistant' && message.role !== 'toolResult') return;
    const tokens = extractPiTokens(message.usage);
    if (!tokens) return;
    const msgAt = piTimestampMs(message.timestamp);
    const completedAt = Number.isFinite(entryAt) ? entryAt : msgAt;
    if (!Number.isFinite(completedAt)) return;

    let latencyMs = null;
    if (message.role === 'assistant') {
      if (typeof message.duration === 'number' && Number.isFinite(message.duration) && message.duration > 0) {
        latencyMs = estimatedLatencyMs(0, Math.round(message.duration));
      } else if (Number.isFinite(msgAt) && Number.isFinite(entryAt)) {
        latencyMs = estimatedLatencyMs(msgAt, entryAt);
      }
    }
    results.push(buildRecord({
      id: `pi_session:${entryId}`,
      rawId: entryId,
      completedAt,
      dataSource: 'pi_session',
      inputTokens: tokens.input,
      cacheReadTokens: tokens.cacheRead,
      cacheCreationTokens: tokens.cacheWrite,
      cacheInclusive: false,
      outputTokens: tokens.output,
      durationMs: latencyMs,
      model: shortText(message.model) ?? currentModel
    }));
  }
  return {
    feed(rows) {
      for (const row of rows) addRow(row);
      if (results.length > limit * 2) results = recentRecords(results, limit);
    },
    finish: () => recentRecords(results, limit)
  };
}

const ANTIGRAVITY_TRANSCRIPT_TAIL = ['.system_generated', 'logs', 'transcript.jsonl'];

/** brain/<conversation-id>/.system_generated/logs/transcript.jsonl -> conversation id, otherwise null. */
export function antigravitySessionIdFromPath(file) {
  if (typeof file !== 'string') return null;
  const parts = file.split(/[\\/]+/).filter(Boolean);
  if (parts.length < 4 || parts.slice(-3).join('/') !== ANTIGRAVITY_TRANSCRIPT_TAIL.join('/')) return null;
  return shortText(parts[parts.length - 4]);
}

// Antigravity's native store is protobuf. This wire reader keeps only the fields used here: no schema, no dependencies.
function protoFields(bytes, depth = 0) {
  if (!(bytes instanceof Uint8Array) || depth > 4) return null;
  const fields = new Map();
  let at = 0;
  const varint = () => {
    let value = 0, scale = 1;
    for (let n = 0; n < 10; n++) {
      if (at >= bytes.length) return null;
      const byte = bytes[at++];
      value += (byte & 0x7f) * scale;
      scale *= 128;
      if (!(byte & 0x80)) return value;
    }
    return null;
  };
  while (at < bytes.length) {
    const key = varint();
    if (key === null) return null;
    const field = Math.floor(key / 8), wire = key % 8;
    let value = null;
    if (wire === 0) value = varint();
    else if (wire === 2) {
      const length = varint();
      if (length === null || at + length > bytes.length) return null;
      value = bytes.subarray(at, at + length); at += length;
    } else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4;
      if (at + size > bytes.length) return null;
      value = bytes.subarray(at, at + size); at += size;
    } else return null;
    if (value === null) return null;
    if (!fields.has(field)) fields.set(field, []);
    fields.get(field).push({ wire, value });
  }
  return fields;
}
const protoLast = (fields, number, wire) => fields?.get(number)?.filter(item => item.wire === wire).at(-1)?.value ?? null;
const protoVarint = (fields, number) => {
  const value = protoLast(fields, number, 0);
  return typeof value === 'number' ? value : null;
};
const protoBytes = (fields, number) => protoLast(fields, number, 2);
const protoText = (fields, number) => {
  const bytes = protoBytes(fields, number);
  return bytes ? new TextDecoder().decode(bytes) : null;
};

/** Workspace root and initial working directory from the native trajectory metadata. */
export function antigravityWorkspacePaths(metadata) {
  const fields = protoFields(metadata);
  return [protoText(protoFields(protoBytes(fields, 1)), 1), protoText(fields, 7)].filter(Boolean);
}

// google.protobuf.Timestamp and Duration share the seconds + nanos layout. proto3 omits zero values,
// so a present message with no seconds field means zero seconds (a sub-second duration).
function protoSecondsMs(bytes) {
  const fields = protoFields(bytes);
  if (!fields) return null;
  const seconds = protoVarint(fields, 1) ?? 0, nanos = protoVarint(fields, 2) ?? 0;
  return seconds * 1000 + Math.floor(nanos / 1_000_000);
}

/** Model-response step metadata: request start (field 1) and the generation it used (field 20.3). */
export function antigravityStepStart(metadata) {
  const fields = protoFields(metadata);
  if (!fields) return null;
  return {
    createdMs: protoSecondsMs(protoBytes(fields, 1)),
    generationIndex: protoVarint(protoFields(protoBytes(fields, 20)), 3)
  };
}

/** Generation metadata: model display name (1.21), model family (1.19), first-token wait (1.11), stream time (1.12). */
export function antigravityGeneration(data) {
  const response = protoFields(protoBytes(protoFields(data), 1));
  if (!response) return null;
  return {
    model: antigravityModelId(protoText(response, 21)),
    baseModel: antigravityModelId(protoText(response, 19)),
    firstTokenMs: protoSecondsMs(protoBytes(response, 11)),
    streamMs: protoSecondsMs(protoBytes(response, 12))
  };
}

/**
 * "Gemini 3.8 Flash (High)" -> "gemini-3.8-flash-high", the ID agy's model list uses. Anything that is not a
 * plausible single label, or is "unknown", yields null.
 */
export function antigravityModelId(label) {
  const value = typeof label === 'string' ? label.trim() : '';
  if (!value || value.length > 128 || value.toLowerCase() === 'unknown' || /[\u0000-\u001f\u007f]/.test(value)) return null;
  if (!value.includes(' ')) return value;
  return value.toLowerCase().replace(' (', '-').replace(/[()]/g, '').split(/\s+/).filter(Boolean).join('-') || null;
}

/**
 * agy writes its model switches into the conversation text: changed setting `Model Selection` from X to Y.
 * Only the new model label is kept; the rest of the message is never stored.
 */
function modelSelectionFrom(content) {
  const start = content.indexOf('Model Selection');
  if (start < 0) return null;
  const rest = content.slice(start);
  const to = rest.indexOf(' to ');
  if (to < 0) return null;
  const tail = rest.slice(to + 4);
  let end = tail.length;
  for (const marker of ['. ', '\n', '`']) {
    const at = tail.indexOf(marker);
    if (at >= 0 && at < end) end = at;
  }
  const id = antigravityModelId(tail.slice(0, end).replace(/\.$/, ''));
  return id && id.toLowerCase() !== 'none' ? id : null;
}

/**
 * Per model-response step, from Antigravity's native store: the request's own start, its model ID, and exact
 * timing. Latency is the first-token wait plus the stream time, both written by agy itself to the millisecond.
 * `steps` are { idx, metadata } rows; `generations` maps a generation index to its metadata bytes.
 */
export function antigravityNativeTimings(steps, generations) {
  const timings = new Map();
  for (const step of steps) {
    const start = antigravityStepStart(step.metadata);
    if (!start || start.createdMs === null) continue;
    const generation = start.generationIndex === null ? null : antigravityGeneration(generations.get(start.generationIndex));
    const firstTokenMs = generation?.firstTokenMs ?? null, streamMs = generation?.streamMs ?? null;
    const latencyMs = firstTokenMs !== null && streamMs !== null && firstTokenMs + streamMs > 0 ? firstTokenMs + streamMs : null;
    const model = generation?.model ?? null, baseModel = generation?.baseModel ?? null;
    if (latencyMs === null && !model && !baseModel) continue;
    timings.set(Number(step.idx), { createdMs: start.createdMs, latencyMs, firstTokenMs, model, baseModel });
  }
  return timings;
}

/**
 * Antigravity CLI writes one JSON object per model step. Its created_at is the request start, not its end, so
 * duration only comes from the native store. Without that store a row keeps its token and cache counters only.
 * Message bodies (content, thinking, tool arguments) are never read.
 */
function createAntigravityParser({ limit = 100 } = {}) {
  const steps = [];
  let selectedModel = null;

  function addRow(row) {
    if (typeof row.content === 'string' && row.content.includes('Model Selection')) {
      selectedModel = modelSelectionFrom(row.content) ?? selectedModel;
    }
    const stepIndex = count(row.step_index);
    const inputTokens = count(row.input_tokens), outputTokens = count(row.output_tokens), cacheReadTokens = count(row.cache_read_tokens);
    if (stepIndex === null || (inputTokens === null && outputTokens === null && cacheReadTokens === null)) return;
    steps.push([stepIndex, { inputTokens, outputTokens, cacheReadTokens, selectedModel, createdAt: millisecondTimestamp(row.created_at) }]);
  }

  function buildStep(stepIndex, step, native) {
    const timing = native.get(stepIndex) ?? null;
    // Model priority: the generation's own display name, then the latest selection, then the bare family name.
    const model = timing?.model ?? step.selectedModel ?? timing?.baseModel ?? null;
    const hasLatency = timing?.latencyMs != null;
    return buildRecord({
      id: `antigravity_session:${stepIndex}`,
      rawId: String(stepIndex),
      completedAt: hasLatency ? timing.createdMs + timing.latencyMs : step.createdAt,
      ...(timing ? { createdAtSec: Math.floor(timing.createdMs / 1000) } : {}),
      dataSource: 'antigravity_session',
      inputTokens: step.inputTokens ?? 0,
      cacheReadTokens: step.cacheReadTokens ?? 0,
      cacheCreationTokens: 0,
      cacheInclusive: false,
      outputTokens: step.outputTokens ?? 0,
      durationMs: hasLatency ? timing.latencyMs : null,
      firstTokenMs: timing?.firstTokenMs ?? null,
      model
    });
  }
  return {
    feed(rows) { for (const row of rows) addRow(row); },
    finish(native = new Map()) {
      return recentRecords(steps.map(([id, step]) => buildStep(id, step, native)), limit);
    }
  };
}

const jsonlRows = text => text.split('\n').map(json).filter(Boolean);

function updateJsonlMetadata(metadata, rows, provider, options = {}) {
  // Antigravity transcripts have no header; the conversation id comes from the directory path.
  if (provider === 'antigravity') {
    metadata.sessionId ??= shortText(options.sessionId);
    return metadata;
  }
  if (metadata.sessionId && metadata.cwd) return metadata;
  for (const row of rows) {
    if (provider === 'codex' && row.type === 'session_meta') {
      metadata.sessionId ??= shortText(row.payload?.id);
      metadata.cwd ??= shortText(row.payload?.cwd);
    } else if (provider === 'pi' && row.type === 'session') {
      metadata.sessionId ??= shortText(row.id);
      metadata.cwd ??= shortText(row.cwd);
    } else if (provider === 'claude') {
      // Claude stamps both fields on most rows; only parse the ones still missing.
      if (!metadata.sessionId) metadata.sessionId = shortText(row.sessionId);
      if (!metadata.cwd) metadata.cwd = shortText(row.cwd);
    }
    if (metadata.sessionId && metadata.cwd) break;
  }
  return metadata;
}

export function readJsonlMetadata(text, provider) {
  return updateJsonlMetadata({ sessionId: null, cwd: null }, jsonlRows(text), provider);
}

/** Keep parser context between complete batches without retaining their message bodies. */
export function createJsonlCursor(text, provider, headerText = '', options = {}) {
  const rows = jsonlRows(text);
  const metadata = { sessionId: null, cwd: null };
  updateJsonlMetadata(metadata, headerText ? jsonlRows(headerText) : rows, provider, options);
  if (headerText && (!metadata.sessionId || !metadata.cwd)) updateJsonlMetadata(metadata, rows, provider, options);
  const parsers = {
    codex: () => createCodexParser(() => metadata.sessionId, options),
    claude: () => createClaudeParser(options),
    pi: () => createPiParser(options),
    antigravity: () => createAntigravityParser(options)
  };
  const parser = Object.hasOwn(parsers, provider) ? parsers[provider]() : null;
  parser?.feed(rows);
  return {
    get sessionId() { return metadata.sessionId; },
    get cwd() { return metadata.cwd; },
    feed(chunkText) {
      const fed = jsonlRows(chunkText);
      updateJsonlMetadata(metadata, fed, provider, options);
      parser?.feed(fed);
    },
    finish: native => parser?.finish(native) ?? []
  };
}

/** Returns metadata and counters only. Chat content never leaves this parser. */
export function parseJsonl(text, provider, headerText = '', options = {}) {
  const cursor = createJsonlCursor(text, provider, headerText, options);
  return { sessionId: cursor.sessionId, cwd: cursor.cwd, records: cursor.finish(options.native) };
}

/** Rows are provider message records in storage order, already limited to one session. */
export function parseOpenCodeRows(rows, v2 = false, { limit = 100 } = {}) {
  const byId = new Map();
  for (const row of rows) {
    const data = object(row.data) ?? json(row.data);
    if (!data) continue;
    const rowId = shortText(String(row.id ?? ''));
    if (!rowId) continue;
    const type = row.type ?? data.role;
    const timeObj = object(data.time);
    const completedMs = millisecondTimestamp(timeObj?.completed);
    if (v2) {
      if (type === 'assistant') {
        if (!Number.isFinite(completedMs) || completedMs <= 0) continue;
      } else if (type === 'compaction') {
        if (data.status !== 'completed' && data.status !== 'failed') continue;
      } else continue;
    } else {
      if (type !== 'assistant' || !Number.isFinite(completedMs) || completedMs <= 0) continue;
    }

    const tokens = object(data.tokens);
    if (!tokens) continue;
    const input = count(tokens.input) ?? 0;
    const output = count(tokens.output) ?? 0;
    const reasoning = count(tokens.reasoning) ?? 0;
    const cache = object(tokens.cache);
    const cacheRead = count(cache?.read) ?? 0;
    const cacheWrite = count(cache?.write) ?? 0;
    if (input === 0 && output === 0 && reasoning === 0 && cacheRead === 0 && cacheWrite === 0) continue;

    const totalOutput = count(output + reasoning);
    if (totalOutput === null) continue;

    const createdRaw = millisecondTimestamp(timeObj?.created);
    const createdMs = Number.isFinite(createdRaw) && createdRaw > 0 ? createdRaw : millisecondTimestamp(row.time_created);
    const streamedMs = millisecondTimestamp(timeObj?.streamed);
    const endMs = Number.isFinite(streamedMs) && Number.isFinite(createdMs) && streamedMs > createdMs
      ? streamedMs : completedMs;
    const durationMs = Number.isFinite(createdMs) && createdMs > 0 && Number.isFinite(endMs) && endMs > createdMs
      ? Math.round(endMs - createdMs) : null;

    const modelObject = object(data.model);
    const model = shortText(data.modelID) ?? shortText(data.modelId) ?? shortText(data.model) ?? shortText(modelObject?.id) ?? shortText(modelObject?.modelID);
    const completedAt = Number.isFinite(completedMs) && completedMs > 0 ? completedMs
      : Number.isFinite(endMs) && endMs > 0 ? endMs : millisecondTimestamp(row.time_created);
    if (!Number.isFinite(completedAt)) continue;

    const entry = buildRecord({
      id: `opencode_session:${rowId}`,
      rawId: rowId,
      completedAt,
      createdAtSec: Number.isFinite(createdMs) && createdMs > 0 ? Math.floor(createdMs / 1000) : Math.floor(completedAt / 1000),
      dataSource: 'opencode_session',
      inputTokens: input,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: cacheWrite,
      cacheInclusive: false,
      outputTokens: totalOutput,
      durationMs,
      model
    });
    if (entry) byId.set(entry.id, entry);
  }
  return recentRecords([...byId.values()], limit);
}

export function buildProxyRecord(row) {
  const r = object(row);
  if (!r) return null;
  const requestId = shortText(r.request_id);
  const createdAtSec = typeof r.created_at === 'number' && Number.isFinite(r.created_at) ? Math.floor(r.created_at) : null;
  if (!requestId || createdAtSec === null) return null;
  const cacheInclusive = r.input_token_semantics === 1 || r.app_type === 'grokbuild';
  const effectiveModel = shortText(r.pricing_model) ?? shortText(r.model) ?? shortText(r.request_model);
  const entry = buildRecord({
    id: `proxy:${requestId}`,
    rawId: requestId,
    completedAt: createdAtSec * 1000,
    createdAtSec,
    dataSource: 'proxy',
    inputTokens: count(r.input_tokens) ?? 0,
    cacheReadTokens: count(r.cache_read_tokens) ?? 0,
    cacheCreationTokens: count(r.cache_creation_tokens) ?? 0,
    cacheInclusive,
    outputTokens: count(r.output_tokens) ?? 0,
    durationMs: count(r.latency_ms),
    firstTokenMs: count(r.first_token_ms),
    model: effectiveModel
  });
  if (!entry) return null;
  return {
    ...entry,
    sessionId: shortText(r.session_id),
    proxyModel: shortText(r.model),
    proxyRequestModel: shortText(r.request_model)
  };
}

function modelsMatchForDedup(proxyEntry, sessionEntry, provider) {
  const pModel = (proxyEntry.model ?? proxyEntry.proxyModel ?? '').toLowerCase();
  const sModel = (sessionEntry.model ?? '').toLowerCase();
  if (!pModel || !sModel || pModel === 'unknown' || sModel === 'unknown') return true;
  if (pModel === sModel) return true;
  if (provider === 'codex') {
    const reqModel = (proxyEntry.proxyRequestModel ?? '').toLowerCase();
    if (reqModel && reqModel !== 'unknown' && (reqModel === sModel || normalizeCodexModel(reqModel) === normalizeCodexModel(sModel))) return true;
    if (normalizeCodexModel(pModel) === normalizeCodexModel(sModel)) return true;
  }
  return false;
}

function stripProxyInternalFields(entry) {
  const { sessionId: _s, proxyModel: _pm, proxyRequestModel: _prm, ...clean } = entry;
  return clean;
}

function proxyMatchesUsage(proxy, session, provider) {
  return Math.abs(proxy.createdAtSec - session.createdAtSec) <= SESSION_PROXY_DEDUP_WINDOW_SECONDS &&
    proxy.freshInputTokens === session.freshInputTokens &&
    proxy.outputTokens === session.outputTokens &&
    proxy.cacheReadTokens === session.cacheReadTokens &&
    proxy.cacheCreationTokens === session.cacheCreationTokens &&
    modelsMatchForDedup(proxy, session, provider);
}

function upgradeFromProxy(session, proxy) {
  const completedAt = Math.abs(proxy.completedAt - session.completedAt) < 2000 ? session.completedAt : proxy.completedAt;
  return stripProxyInternalFields({ ...proxy, completedAt, ...(session.isSubagent ? { isSubagent: true } : {}) });
}

/** Deduplicate session-log records against 2xx CC Switch local-proxy logs (exact ID or ±600s semantic match). */
export function mergeProxyRecords(sessionRecords, proxyRows, provider, targetSessionId) {
  if (!Array.isArray(proxyRows) || !proxyRows.length) return recentRecords(sessionRecords);
  const parsedProxy = proxyRows.map(buildProxyRecord).filter(Boolean);
  if (!parsedProxy.length) return recentRecords(sessionRecords);

  const usedProxyIds = new Set();
  const merged = [];

  for (const sRec of sessionRecords) {
    if (!sRec) continue;
    let matched = parsedProxy.find(p => !usedProxyIds.has(p.id) && sRec.rawId && p.rawId === sRec.rawId);
    if (!matched) {
      matched = parsedProxy.find(p =>
        !usedProxyIds.has(p.id) &&
        (!p.sessionId || !targetSessionId || p.sessionId === targetSessionId) &&
        proxyMatchesUsage(p, sRec, provider)
      );
    }
    if (matched) {
      usedProxyIds.add(matched.id);
      merged.push(upgradeFromProxy(sRec, matched));
    } else {
      merged.push(sRec);
    }
  }

  for (const p of parsedProxy) {
    if (!usedProxyIds.has(p.id) && targetSessionId && p.sessionId === targetSessionId) {
      merged.push(stripProxyInternalFields(p));
    }
  }

  return recentRecords(merged);
}

/** Match proxy requests once across a channel, preserving logs that have no unique proxy match. */
export function mergeChannelProxyRecords(entries) {
  const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const sessions = entries.map(entry => ({
    ...entry,
    key: JSON.stringify([entry.provider, entry.sessionId]),
    proxies: new Map((entry.proxyRows ?? []).map(buildProxyRecord).filter(Boolean).map(proxy => [proxy.id, proxy]))
  })).sort((a, b) => compare(a.key, b.key));
  const sources = new Map();
  for (const entry of sessions) for (const log of entry.records ?? []) {
    if (!log) continue;
    const key = JSON.stringify([entry.provider, entry.sessionId, log.id]);
    sources.set(key, { key, entry, log });
  }

  const used = new Set(), matches = new Map();
  function assign(predicate) {
    const candidates = [];
    for (const source of sources.values()) {
      if (matches.has(source.key)) continue;
      for (const proxy of source.entry.proxies.values()) {
        if (used.has(proxy.id) || !predicate(source, proxy)) continue;
        candidates.push({ source, proxy, distance: Math.abs(proxy.createdAtSec - source.log.createdAtSec) });
      }
    }
    candidates.sort((a, b) => a.distance - b.distance || compare(a.source.key, b.source.key) || compare(a.proxy.id, b.proxy.id));
    for (const { source, proxy } of candidates) {
      if (matches.has(source.key) || used.has(proxy.id)) continue;
      matches.set(source.key, proxy);
      used.add(proxy.id);
    }
  }

  // Reserve exact identities globally before a nearby, similar request can consume their proxy row.
  assign(({ log }, proxy) => Boolean(log.rawId) && log.rawId === proxy.rawId);
  // Copied/forked histories may contain the same real request in multiple sessions. Only alias
  // sources with their own exact proxy evidence in the same provider family, never token-only matches.
  const exactKey = source => JSON.stringify([
    harnessFamily(source.entry.provider), source.log.rawId
  ]);
  const exactMatches = new Map();
  for (const source of sources.values()) {
    const proxy = matches.get(source.key);
    if (proxy) exactMatches.set(exactKey(source), proxy.id);
  }
  for (const source of sources.values()) {
    if (matches.has(source.key)) continue;
    const proxy = source.entry.proxies.get(exactMatches.get(exactKey(source)));
    if (proxy && source.log.rawId === proxy.rawId) matches.set(source.key, proxy);
  }
  assign(({ log, entry }, proxy) => Boolean(proxy.sessionId) && proxy.sessionId === entry.sessionId &&
    proxyMatchesUsage(proxy, log, entry.provider));
  assign(({ log, entry }, proxy) => !proxy.sessionId && proxyMatchesUsage(proxy, log, entry.provider));

  const merged = new Map();
  for (const source of sources.values()) {
    const proxy = matches.get(source.key);
    const value = proxy ? upgradeFromProxy(source.log, proxy) : source.log;
    const key = value.dataSource === 'proxy' ? value.id : source.key;
    merged.set(key, { ...value, provider: source.entry.provider });
  }
  for (const entry of sessions) for (const proxy of entry.proxies.values()) {
    if (!used.has(proxy.id) && entry.sessionId && proxy.sessionId === entry.sessionId) {
      used.add(proxy.id);
      merged.set(proxy.id, { ...stripProxyInternalFields(proxy), provider: entry.provider });
    }
  }
  return [...merged.entries()]
    .sort(([keyA, a], [keyB, b]) => b.completedAt - a.completedAt || compare(keyA, keyB))
    .slice(0, 100).map(([, value]) => value);
}

const FRAME_MAGIC = 0xfd2fb528;
const SKIP_MAGIC = 0x184d2a50;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const DICTIONARY_BYTES = [0, 1, 2, 4];

function frameHeader(buffer, start) {
  if (buffer.length - start < 5) return null;
  const magic = buffer.readUInt32LE(start);
  if ((magic & 0xfffffff0) === SKIP_MAGIC) {
    if (buffer.length - start < 8) return null;
    return { skip: true, end: start + 8 + buffer.readUInt32LE(start + 4) };
  }
  if (magic !== FRAME_MAGIC || (buffer[start + 4] & 8) !== 0) throw new Error('Invalid Zstd frame header');
  const descriptor = buffer[start + 4];
  const single = (descriptor & 32) !== 0;
  const flag = descriptor >>> 6;
  const sizeBytes = flag ? 2 ** flag : Number(single);
  const sizeStart = start + 5 + Number(!single) + DICTIONARY_BYTES[descriptor & 3];
  const end = sizeStart + sizeBytes;
  if (end > buffer.length) return null;
  const size = sizeBytes === 8 ? Number(buffer.readBigUInt64LE(sizeStart))
    : sizeBytes ? buffer.readUIntLE(sizeStart, sizeBytes) + (sizeBytes === 2 ? 256 : 0) : null;
  const windowByte = buffer[start + 5];
  const window = single ? size : 2 ** ((windowByte >>> 3) + 10) * (1 + (windowByte & 7) / 8);
  if (window > MAX_FRAME_BYTES || size > MAX_FRAME_BYTES) throw new Error('Zstd frame exceeds the decode limit');
  return { end, checksum: (descriptor & 4) !== 0 };
}

function completeFrame(buffer, start) {
  const header = frameHeader(buffer, start);
  if (!header) return null;
  if (header.skip) return header.end <= buffer.length ? header : null;
  let offset = header.end;
  while (offset + 3 <= buffer.length) {
    const block = buffer.readUIntLE(offset, 3);
    const blockType = (block >>> 1) & 3;
    if (blockType === 3) throw new Error('Invalid Zstd block');
    offset += 3 + (blockType === 1 ? 1 : block >>> 3);
    if (block & 1) {
      const end = offset + (header.checksum ? 4 : 0);
      return end <= buffer.length ? { end } : null;
    }
  }
  return null;
}

function decodeZstdFrame(frame, limit = MAX_FRAME_BYTES) {
  const header = frameHeader(frame, 0);
  if (!header || header.skip) throw new Error('Invalid Zstd data frame');
  if (zlib.zstdDecompressSync) return zlib.zstdDecompressSync(frame, { maxOutputLength: limit });

  const chunks = [];
  let size = 0;
  // Older supported Node versions lack the built-in decoder.
  const decoder = new FallbackZstdDecoder(chunk => {
    size += chunk.length;
    if (size > limit) throw new Error('Zstd output exceeds the decode limit');
    chunks.push(chunk);
  });
  decoder.push(frame, true);
  return Buffer.concat(chunks, size);
}

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

/* fzstd 0.1.1, from https://github.com/101arrowz/fzstd

MIT License

Copyright (c) 2020 Arjun Barrett

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
const FallbackZstdDecoder = zlib.zstdDecompressSync ? null : (() => {
  // Some numerical data is initialized as -1 even when it doesn't need initialization to help the JIT infer types
  // aliases for shorter compressed code (most minifers don't do this)
  var ab = ArrayBuffer, u8 = Uint8Array, u16 = Uint16Array, i16 = Int16Array, u32 = Uint32Array, i32 = Int32Array;
  var slc = function (v, s, e) {
      if (u8.prototype.slice)
          return u8.prototype.slice.call(v, s, e);
      if (s == null || s < 0)
          s = 0;
      if (e == null || e > v.length)
          e = v.length;
      var n = new u8(e - s);
      n.set(v.subarray(s, e));
      return n;
  };
  var fill = function (v, n, s, e) {
      if (u8.prototype.fill)
          return u8.prototype.fill.call(v, n, s, e);
      if (s == null || s < 0)
          s = 0;
      if (e == null || e > v.length)
          e = v.length;
      for (; s < e; ++s)
          v[s] = n;
      return v;
  };
  var cpw = function (v, t, s, e) {
      if (u8.prototype.copyWithin)
          return u8.prototype.copyWithin.call(v, t, s, e);
      if (s == null || s < 0)
          s = 0;
      if (e == null || e > v.length)
          e = v.length;
      while (s < e) {
          v[t++] = v[s++];
      }
  };
  /**
   * Codes for errors generated within this library
   */
  var ZstdErrorCode = {
      InvalidData: 0,
      WindowSizeTooLarge: 1,
      InvalidBlockType: 2,
      FSEAccuracyTooHigh: 3,
      DistanceTooFarBack: 4,
      UnexpectedEOF: 5
  };
  // error codes
  var ec = [
      'invalid zstd data',
      'window size too large (>2046MB)',
      'invalid block type',
      'FSE accuracy too high',
      'match distance too far back',
      'unexpected EOF'
  ];
  var err = function (ind, msg, nt) {
      var e = new Error(msg || ec[ind]);
      e.code = ind;
      if (Error.captureStackTrace)
          Error.captureStackTrace(e, err);
      if (!nt)
          throw e;
      return e;
  };
  var rb = function (d, b, n) {
      var i = 0, o = 0;
      for (; i < n; ++i)
          o |= d[b++] << (i << 3);
      return o;
  };
  var b4 = function (d, b) { return (d[b] | (d[b + 1] << 8) | (d[b + 2] << 16) | (d[b + 3] << 24)) >>> 0; };
  // read Zstandard frame header
  var rzfh = function (dat, w) {
      var n3 = dat[0] | (dat[1] << 8) | (dat[2] << 16);
      if (n3 == 0x2FB528 && dat[3] == 253) {
          // Zstandard
          var flg = dat[4];
          //    single segment       checksum             dict flag     frame content flag
          var ss = (flg >> 5) & 1, cc = (flg >> 2) & 1, df = flg & 3, fcf = flg >> 6;
          if (flg & 8)
              err(0);
          // byte
          var bt = 6 - ss;
          // dict bytes
          var db = df == 3 ? 4 : df;
          // dictionary id
          var di = rb(dat, bt, db);
          bt += db;
          // frame size bytes
          var fsb = fcf ? (1 << fcf) : ss;
          // frame source size
          var fss = rb(dat, bt, fsb) + ((fcf == 1) && 256);
          // window size
          var ws = fss;
          if (!ss) {
              // window descriptor
              var wb = 1 << (10 + (dat[5] >> 3));
              ws = wb + (wb >> 3) * (dat[5] & 7);
          }
          if (ws > 2145386496)
              err(1);
          var buf = new u8((w == 1 ? (fss || ws) : w ? 0 : ws) + 12);
          buf[0] = 1, buf[4] = 4, buf[8] = 8;
          return {
              b: bt + fsb,
              y: 0,
              l: 0,
              d: di,
              w: (w && w != 1) ? w : buf.subarray(12),
              e: ws,
              o: new i32(buf.buffer, 0, 3),
              u: fss,
              c: cc,
              m: Math.min(131072, ws)
          };
      }
      else if (((n3 >> 4) | (dat[3] << 20)) == 0x184D2A5) {
          // skippable
          return b4(dat, 4) + 8;
      }
      err(0);
  };
  // most significant bit for nonzero
  var msb = function (val) {
      var bits = 0;
      for (; (1 << bits) <= val; ++bits)
          ;
      return bits - 1;
  };
  // read finite state entropy
  var rfse = function (dat, bt, mal) {
      // table pos
      var tpos = (bt << 3) + 4;
      // accuracy log
      var al = (dat[bt] & 15) + 5;
      if (al > mal)
          err(3);
      // size
      var sz = 1 << al;
      // probabilities symbols  repeat   index   high threshold
      var probs = sz, sym = -1, re = -1, i = -1, ht = sz;
      // optimization: single allocation is much faster
      var buf = new ab(512 + (sz << 2));
      var freq = new i16(buf, 0, 256);
      // same view as freq
      var dstate = new u16(buf, 0, 256);
      var nstate = new u16(buf, 512, sz);
      var bb1 = 512 + (sz << 1);
      var syms = new u8(buf, bb1, sz);
      var nbits = new u8(buf, bb1 + sz);
      while (sym < 255 && probs > 0) {
          var bits = msb(probs + 1);
          var cbt = tpos >> 3;
          // mask
          var msk = (1 << (bits + 1)) - 1;
          var val = ((dat[cbt] | (dat[cbt + 1] << 8) | (dat[cbt + 2] << 16)) >> (tpos & 7)) & msk;
          // mask (1 fewer bit)
          var msk1fb = (1 << bits) - 1;
          // max small value
          var msv = msk - probs - 1;
          // small value
          var sval = val & msk1fb;
          if (sval < msv)
              tpos += bits, val = sval;
          else {
              tpos += bits + 1;
              if (val > msk1fb)
                  val -= msv;
          }
          freq[++sym] = --val;
          if (val == -1) {
              probs += val;
              syms[--ht] = sym;
          }
          else
              probs -= val;
          if (!val) {
              do {
                  // repeat byte
                  var rbt = tpos >> 3;
                  re = ((dat[rbt] | (dat[rbt + 1] << 8)) >> (tpos & 7)) & 3;
                  tpos += 2;
                  sym += re;
              } while (re == 3);
          }
      }
      if (sym > 255 || probs)
          err(0);
      var sympos = 0;
      // sym step (coprime with sz - formula from zstd source)
      var sstep = (sz >> 1) + (sz >> 3) + 3;
      // sym mask
      var smask = sz - 1;
      for (var s = 0; s <= sym; ++s) {
          var sf = freq[s];
          if (sf < 1) {
              dstate[s] = -sf;
              continue;
          }
          // This is split into two loops in zstd to avoid branching, but as JS is higher-level that is unnecessary
          for (i = 0; i < sf; ++i) {
              syms[sympos] = s;
              do {
                  sympos = (sympos + sstep) & smask;
              } while (sympos >= ht);
          }
      }
      // After spreading symbols, should be zero again
      if (sympos)
          err(0);
      for (i = 0; i < sz; ++i) {
          // next state
          var ns = dstate[syms[i]]++;
          // num bits
          var nb = nbits[i] = al - msb(ns);
          nstate[i] = (ns << nb) - sz;
      }
      return [(tpos + 7) >> 3, {
              b: al,
              s: syms,
              n: nbits,
              t: nstate
          }];
  };
  // read huffman
  var rhu = function (dat, bt) {
      //  index  weight count
      var i = 0, wc = -1;
      //    buffer             header byte
      var buf = new u8(292), hb = dat[bt];
      // huffman weights
      var hw = buf.subarray(0, 256);
      // rank count
      var rc = buf.subarray(256, 268);
      // rank index
      var ri = new u16(buf.buffer, 268);
      // NOTE: at this point bt is 1 less than expected
      if (hb < 128) {
          // end byte, fse decode table
          var _a = rfse(dat, bt + 1, 6), ebt = _a[0], fdt = _a[1];
          bt += hb;
          var epos = ebt << 3;
          // last byte
          var lb = dat[bt];
          if (!lb)
              err(0);
          //  state1   state2   state1 bits   state2 bits
          var st1 = 0, st2 = 0, btr1 = fdt.b, btr2 = btr1;
          // fse pos
          // pre-increment to account for original deficit of 1
          var fpos = (++bt << 3) - 8 + msb(lb);
          for (;;) {
              fpos -= btr1;
              if (fpos < epos)
                  break;
              var cbt = fpos >> 3;
              st1 += ((dat[cbt] | (dat[cbt + 1] << 8)) >> (fpos & 7)) & ((1 << btr1) - 1);
              hw[++wc] = fdt.s[st1];
              fpos -= btr2;
              if (fpos < epos)
                  break;
              cbt = fpos >> 3;
              st2 += ((dat[cbt] | (dat[cbt + 1] << 8)) >> (fpos & 7)) & ((1 << btr2) - 1);
              hw[++wc] = fdt.s[st2];
              btr1 = fdt.n[st1];
              st1 = fdt.t[st1];
              btr2 = fdt.n[st2];
              st2 = fdt.t[st2];
          }
          if (++wc > 255)
              err(0);
      }
      else {
          wc = hb - 127;
          for (; i < wc; i += 2) {
              var byte = dat[++bt];
              hw[i] = byte >> 4;
              hw[i + 1] = byte & 15;
          }
          ++bt;
      }
      // weight exponential sum
      var wes = 0;
      for (i = 0; i < wc; ++i) {
          var wt = hw[i];
          // bits must be at most 11, same as weight
          if (wt > 11)
              err(0);
          wes += wt && (1 << (wt - 1));
      }
      // max bits
      var mb = msb(wes) + 1;
      // table size
      var ts = 1 << mb;
      // remaining sum
      var rem = ts - wes;
      // must be power of 2
      if (rem & (rem - 1))
          err(0);
      hw[wc++] = msb(rem) + 1;
      for (i = 0; i < wc; ++i) {
          var wt = hw[i];
          ++rc[hw[i] = wt && (mb + 1 - wt)];
      }
      // huf buf
      var hbuf = new u8(ts << 1);
      //    symbols                      num bits
      var syms = hbuf.subarray(0, ts), nb = hbuf.subarray(ts);
      ri[mb] = 0;
      for (i = mb; i > 0; --i) {
          var pv = ri[i];
          fill(nb, i, pv, ri[i - 1] = pv + rc[i] * (1 << (mb - i)));
      }
      if (ri[0] != ts)
          err(0);
      for (i = 0; i < wc; ++i) {
          var bits = hw[i];
          if (bits) {
              var code = ri[bits];
              fill(syms, i, code, ri[bits] = code + (1 << (mb - bits)));
          }
      }
      return [bt, {
              n: nb,
              b: mb,
              s: syms
          }];
  };
  // Tables generated using this:
  // https://gist.github.com/101arrowz/a979452d4355992cbf8f257cbffc9edd
  // default literal length table
  var dllt = /*#__PURE__*/ rfse(/*#__PURE__*/ new u8([
      81, 16, 99, 140, 49, 198, 24, 99, 12, 33, 196, 24, 99, 102, 102, 134, 70, 146, 4
  ]), 0, 6)[1];
  // default match length table
  var dmlt = /*#__PURE__*/ rfse(/*#__PURE__*/ new u8([
      33, 20, 196, 24, 99, 140, 33, 132, 16, 66, 8, 33, 132, 16, 66, 8, 33, 68, 68, 68, 68, 68, 68, 68, 68, 36, 9
  ]), 0, 6)[1];
  // default offset code table
  var doct = /*#__PURE__ */ rfse(/*#__PURE__*/ new u8([
      32, 132, 16, 66, 102, 70, 68, 68, 68, 68, 36, 73, 2
  ]), 0, 5)[1];
  // bits to baseline
  var b2bl = function (b, s) {
      var len = b.length, bl = new i32(len);
      for (var i = 0; i < len; ++i) {
          bl[i] = s;
          s += 1 << b[i];
      }
      return bl;
  };
  // literal length bits
  var llb = /*#__PURE__ */ new u8(( /*#__PURE__ */new i32([
      0, 0, 0, 0, 16843009, 50528770, 134678020, 202050057, 269422093
  ])).buffer, 0, 36);
  // literal length baseline
  var llbl = /*#__PURE__ */ b2bl(llb, 0);
  // match length bits
  var mlb = /*#__PURE__ */ new u8(( /*#__PURE__ */new i32([
      0, 0, 0, 0, 0, 0, 0, 0, 16843009, 50528770, 117769220, 185207048, 252579084, 16
  ])).buffer, 0, 53);
  // match length baseline
  var mlbl = /*#__PURE__ */ b2bl(mlb, 3);
  // decode huffman stream
  var dhu = function (dat, out, hu) {
      var len = dat.length, ss = out.length, lb = dat[len - 1], msk = (1 << hu.b) - 1, eb = -hu.b;
      if (!lb)
          err(0);
      var st = 0, btr = hu.b, pos = (len << 3) - 8 + msb(lb) - btr, i = -1;
      for (; pos > eb && i < ss;) {
          var cbt = pos >> 3;
          var val = (dat[cbt] | (dat[cbt + 1] << 8) | (dat[cbt + 2] << 16)) >> (pos & 7);
          st = ((st << btr) | val) & msk;
          out[++i] = hu.s[st];
          pos -= (btr = hu.n[st]);
      }
      if (pos != eb || i + 1 != ss)
          err(0);
  };
  // decode huffman stream 4x
  // TODO: use workers to parallelize
  var dhu4 = function (dat, out, hu) {
      var bt = 6;
      var ss = out.length, sz1 = (ss + 3) >> 2, sz2 = sz1 << 1, sz3 = sz1 + sz2;
      dhu(dat.subarray(bt, bt += dat[0] | (dat[1] << 8)), out.subarray(0, sz1), hu);
      dhu(dat.subarray(bt, bt += dat[2] | (dat[3] << 8)), out.subarray(sz1, sz2), hu);
      dhu(dat.subarray(bt, bt += dat[4] | (dat[5] << 8)), out.subarray(sz2, sz3), hu);
      dhu(dat.subarray(bt), out.subarray(sz3), hu);
  };
  // read Zstandard block
  var rzb = function (dat, st, out) {
      var _a;
      var bt = st.b;
      //    byte 0        block type
      var b0 = dat[bt], btype = (b0 >> 1) & 3;
      st.l = b0 & 1;
      var sz = (b0 >> 3) | (dat[bt + 1] << 5) | (dat[bt + 2] << 13);
      // end byte for block
      var ebt = (bt += 3) + sz;
      if (btype == 1) {
          if (bt >= dat.length)
              return;
          st.b = bt + 1;
          if (out) {
              fill(out, dat[bt], st.y, st.y += sz);
              return out;
          }
          return fill(new u8(sz), dat[bt]);
      }
      if (ebt > dat.length)
          return;
      if (btype == 0) {
          st.b = ebt;
          if (out) {
              out.set(dat.subarray(bt, ebt), st.y);
              st.y += sz;
              return out;
          }
          return slc(dat, bt, ebt);
      }
      if (btype == 2) {
          //    byte 3        lit btype     size format
          var b3 = dat[bt], lbt = b3 & 3, sf = (b3 >> 2) & 3;
          // lit src size  lit cmp sz 4 streams
          var lss = b3 >> 4, lcs = 0, s4 = 0;
          if (lbt < 2) {
              if (sf & 1)
                  lss |= (dat[++bt] << 4) | ((sf & 2) && (dat[++bt] << 12));
              else
                  lss = b3 >> 3;
          }
          else {
              s4 = sf;
              if (sf < 2)
                  lss |= ((dat[++bt] & 63) << 4), lcs = (dat[bt] >> 6) | (dat[++bt] << 2);
              else if (sf == 2)
                  lss |= (dat[++bt] << 4) | ((dat[++bt] & 3) << 12), lcs = (dat[bt] >> 2) | (dat[++bt] << 6);
              else
                  lss |= (dat[++bt] << 4) | ((dat[++bt] & 63) << 12), lcs = (dat[bt] >> 6) | (dat[++bt] << 2) | (dat[++bt] << 10);
          }
          ++bt;
          // add literals to end - can never overlap with backreferences because unused literals always appended
          var buf = out ? out.subarray(st.y, st.y + st.m) : new u8(st.m);
          // starting point for literals
          var spl = buf.length - lss;
          if (lbt == 0)
              buf.set(dat.subarray(bt, bt += lss), spl);
          else if (lbt == 1)
              fill(buf, dat[bt++], spl);
          else {
              // huffman table
              var hu = st.h;
              if (lbt == 2) {
                  var hud = rhu(dat, bt);
                  // subtract description length
                  lcs += bt - (bt = hud[0]);
                  st.h = hu = hud[1];
              }
              else if (!hu)
                  err(0);
              (s4 ? dhu4 : dhu)(dat.subarray(bt, bt += lcs), buf.subarray(spl), hu);
          }
          // num sequences
          var ns = dat[bt++];
          if (ns) {
              if (ns == 255)
                  ns = (dat[bt++] | (dat[bt++] << 8)) + 0x7F00;
              else if (ns > 127)
                  ns = ((ns - 128) << 8) | dat[bt++];
              // symbol compression modes
              var scm = dat[bt++];
              if (scm & 3)
                  err(0);
              var dts = [dmlt, doct, dllt];
              for (var i = 2; i > -1; --i) {
                  var md = (scm >> ((i << 1) + 2)) & 3;
                  if (md == 1) {
                      // rle buf
                      var rbuf = new u8([0, 0, dat[bt++]]);
                      dts[i] = {
                          s: rbuf.subarray(2, 3),
                          n: rbuf.subarray(0, 1),
                          t: new u16(rbuf.buffer, 0, 1),
                          b: 0
                      };
                  }
                  else if (md == 2) {
                      // accuracy log 8 for offsets, 9 for others
                      _a = rfse(dat, bt, 9 - (i & 1)), bt = _a[0], dts[i] = _a[1];
                  }
                  else if (md == 3) {
                      if (!st.t)
                          err(0);
                      dts[i] = st.t[i];
                  }
              }
              var _b = st.t = dts, mlt = _b[0], oct = _b[1], llt = _b[2];
              var lb = dat[ebt - 1];
              if (!lb)
                  err(0);
              var spos = (ebt << 3) - 8 + msb(lb) - llt.b, cbt = spos >> 3, oubt = 0;
              var lst = ((dat[cbt] | (dat[cbt + 1] << 8)) >> (spos & 7)) & ((1 << llt.b) - 1);
              cbt = (spos -= oct.b) >> 3;
              var ost = ((dat[cbt] | (dat[cbt + 1] << 8)) >> (spos & 7)) & ((1 << oct.b) - 1);
              cbt = (spos -= mlt.b) >> 3;
              var mst = ((dat[cbt] | (dat[cbt + 1] << 8)) >> (spos & 7)) & ((1 << mlt.b) - 1);
              for (++ns; --ns;) {
                  var llc = llt.s[lst];
                  var lbtr = llt.n[lst];
                  var mlc = mlt.s[mst];
                  var mbtr = mlt.n[mst];
                  var ofc = oct.s[ost];
                  var obtr = oct.n[ost];
                  cbt = (spos -= ofc) >> 3;
                  var ofp = 1 << ofc;
                  var off = ofp + (((dat[cbt] | (dat[cbt + 1] << 8) | (dat[cbt + 2] << 16) | (dat[cbt + 3] << 24)) >>> (spos & 7)) & (ofp - 1));
                  cbt = (spos -= mlb[mlc]) >> 3;
                  var ml = mlbl[mlc] + (((dat[cbt] | (dat[cbt + 1] << 8) | (dat[cbt + 2] << 16)) >> (spos & 7)) & ((1 << mlb[mlc]) - 1));
                  cbt = (spos -= llb[llc]) >> 3;
                  var ll = llbl[llc] + (((dat[cbt] | (dat[cbt + 1] << 8) | (dat[cbt + 2] << 16)) >> (spos & 7)) & ((1 << llb[llc]) - 1));
                  cbt = (spos -= lbtr) >> 3;
                  lst = llt.t[lst] + (((dat[cbt] | (dat[cbt + 1] << 8)) >> (spos & 7)) & ((1 << lbtr) - 1));
                  cbt = (spos -= mbtr) >> 3;
                  mst = mlt.t[mst] + (((dat[cbt] | (dat[cbt + 1] << 8)) >> (spos & 7)) & ((1 << mbtr) - 1));
                  cbt = (spos -= obtr) >> 3;
                  ost = oct.t[ost] + (((dat[cbt] | (dat[cbt + 1] << 8)) >> (spos & 7)) & ((1 << obtr) - 1));
                  if (off > 3) {
                      st.o[2] = st.o[1];
                      st.o[1] = st.o[0];
                      st.o[0] = off -= 3;
                  }
                  else {
                      var idx = off - (ll != 0);
                      if (idx) {
                          off = idx == 3 ? st.o[0] - 1 : st.o[idx];
                          if (idx > 1)
                              st.o[2] = st.o[1];
                          st.o[1] = st.o[0];
                          st.o[0] = off;
                      }
                      else
                          off = st.o[0];
                  }
                  for (var i = 0; i < ll; ++i) {
                      buf[oubt + i] = buf[spl + i];
                  }
                  oubt += ll, spl += ll;
                  var stin = oubt - off;
                  if (stin < 0) {
                      var len = -stin;
                      var bs = st.e + stin;
                      if (len > ml)
                          len = ml;
                      for (var i = 0; i < len; ++i) {
                          buf[oubt + i] = st.w[bs + i];
                      }
                      oubt += len, ml -= len, stin = 0;
                  }
                  for (var i = 0; i < ml; ++i) {
                      buf[oubt + i] = buf[stin + i];
                  }
                  oubt += ml;
              }
              if (oubt != spl) {
                  while (spl < buf.length) {
                      buf[oubt++] = buf[spl++];
                  }
              }
              else
                  oubt = buf.length;
              if (out)
                  st.y += oubt;
              else
                  buf = slc(buf, 0, oubt);
          }
          else if (out) {
              st.y += lss;
              if (spl) {
                  for (var i = 0; i < lss; ++i) {
                      buf[i] = buf[spl + i];
                  }
              }
          }
          else if (spl)
              buf = slc(buf, spl);
          st.b = ebt;
          return buf;
      }
      err(2);
  };
  // concat
  var cct = function (bufs, ol) {
      if (bufs.length == 1)
          return bufs[0];
      var buf = new u8(ol);
      for (var i = 0, b = 0; i < bufs.length; ++i) {
          var chk = bufs[i];
          buf.set(chk, b);
          b += chk.length;
      }
      return buf;
  };
  /**
   * Decompressor for Zstandard streamed data
   */
  var Decompress = /*#__PURE__*/ (function () {
      /**
       * Creates a Zstandard decompressor
       * @param ondata The handler for stream data
       */
      function Decompress(ondata) {
          this.ondata = ondata;
          this.c = [];
          this.l = 0;
          this.z = 0;
      }
      /**
       * Pushes data to be decompressed
       * @param chunk The chunk of data to push
       * @param final Whether or not this is the last chunk in the stream
       */
      Decompress.prototype.push = function (chunk, final) {
          if (typeof this.s == 'number') {
              var sub = Math.min(chunk.length, this.s);
              chunk = chunk.subarray(sub);
              this.s -= sub;
          }
          var sl = chunk.length;
          var ncs = sl + this.l;
          if (!this.s) {
              if (final) {
                  if (!ncs) {
                      this.ondata(new u8(0), true);
                      return;
                  }
                  // min for frame + one block
                  if (ncs < 5)
                      err(5);
              }
              else if (ncs < 18) {
                  this.c.push(chunk);
                  this.l = ncs;
                  return;
              }
              if (this.l) {
                  this.c.push(chunk);
                  chunk = cct(this.c, ncs);
                  this.c = [];
                  this.l = 0;
              }
              if (typeof (this.s = rzfh(chunk)) == 'number')
                  return this.push(chunk, final);
          }
          if (typeof this.s != 'number') {
              if (ncs < (this.z || 3)) {
                  if (final)
                      err(5);
                  this.c.push(chunk);
                  this.l = ncs;
                  return;
              }
              if (this.l) {
                  this.c.push(chunk);
                  chunk = cct(this.c, ncs);
                  this.c = [];
                  this.l = 0;
              }
              if (!this.z && ncs < (this.z = (chunk[this.s.b] & 2) ? 4 : 3 + ((chunk[this.s.b] >> 3) | (chunk[this.s.b + 1] << 5) | (chunk[this.s.b + 2] << 13)))) {
                  if (final)
                      err(5);
                  this.c.push(chunk);
                  this.l = ncs;
                  return;
              }
              else
                  this.z = 0;
              for (;;) {
                  var blk = rzb(chunk, this.s);
                  if (!blk) {
                      if (final)
                          err(5);
                      var adc = chunk.subarray(this.s.b);
                      this.s.b = 0;
                      this.c.push(adc), this.l += adc.length;
                      return;
                  }
                  else {
                      this.ondata(blk, false);
                      cpw(this.s.w, 0, blk.length);
                      this.s.w.set(blk, this.s.w.length - blk.length);
                  }
                  if (this.s.l) {
                      var rest = chunk.subarray(this.s.b);
                      this.s = this.s.c * 4;
                      this.push(rest, final);
                      return;
                  }
              }
          }
          else if (final)
              err(5);
      };
      return Decompress;
  }());
  return Decompress;
})();

import { createHash } from 'node:crypto';
import * as zlib from 'node:zlib';
import { harnessFamily } from './harnesses.mjs';

export const SPEED_MIN_OUTPUT_TOKENS = 100;
export const SPEED_MIN_GENERATION_MS = 100;
export const SPEED_ESTIMATE_MIN_OUTPUT_TOKENS = 200;
export const SPEED_ESTIMATE_MIN_DURATION_MS = 1000;
export const MIN_PLAUSIBLE_LATENCY_MS = 100;
export const MAX_PLAUSIBLE_LATENCY_MS = 60 * 60 * 1000;
export const SESSION_PROXY_DEDUP_WINDOW_SECONDS = 600;

const HERMES_MIN_OUTPUT_TOKENS = 20;
const HERMES_MIN_DURATION_MS = 300;
const MAX_CHAIN_HOPS = 32;
const SAME_FLUSH_SLACK_MS = 100;
const EPOCH_UNIT_THRESHOLD = 100_000_000_000;
const CODEX_USAGE_KEYS = ['input_tokens', 'cached_input_tokens', 'cache_read_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
const ANTIGRAVITY_TAIL = '.system_generated/logs/transcript.jsonl';

export const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
export const string = value => typeof value === 'string' && value.trim() ? value.trim() : null;
export const shortText = value => typeof value === 'string' && value.length <= 256 ? string(value) : null;
export const token = value => Number.isSafeInteger(value) && value > 0 ? value : 0;
export const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
export const sha = text => createHash('sha256').update(text).digest('hex');
export const json = text => { try { return object(JSON.parse(text)); } catch { return null; } };

export function epochMilliseconds(value, unit, numericStrings = false) {
  if (typeof value === 'string') {
    const text = numericStrings ? value.trim() : value;
    if (!numericStrings || !/^-?\d+(?:\.\d+)?$/.test(text)) return Date.parse(text);
    value = Number(text);
  }
  if (!Number.isFinite(value)) return NaN;
  return unit === 'milliseconds' ? value : Math.round(Math.abs(value) < EPOCH_UNIT_THRESHOLD ? value * 1000 : value);
}

export const timestamp = value => {
  if (typeof value === 'number' && value <= 0) return null;
  const parsed = epochMilliseconds(value, 'auto');
  return Number.isFinite(parsed) ? parsed : null;
};
const msTime = value => epochMilliseconds(value, 'milliseconds');
const piTime = value => epochMilliseconds(value, 'auto', true);

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

export const isSessionLogSource = dataSource => typeof dataSource === 'string' && dataSource.length > 0 && dataSource !== 'proxy';

export function computeSpeedMetrics({ outputTokens, durationMs, firstTokenMs = null, dataSource = 'session_log' }) {
  const output = count(outputTokens), latency = count(durationMs), firstToken = count(firstTokenMs);
  if (!isSessionLogSource(dataSource)) {
    const generationMs = latency !== null && firstToken !== null && latency > firstToken ? latency - firstToken : null;
    if (output !== null && output >= SPEED_MIN_OUTPUT_TOKENS && generationMs !== null && generationMs >= SPEED_MIN_GENERATION_MS) {
      const tps = output / (generationMs / 1000);
      if (Number.isFinite(tps) && tps > 0) return { tokensPerSecond: tps, isEstimatedSpeed: false, generationMs };
    }
    return { tokensPerSecond: null, isEstimatedSpeed: false, generationMs };
  }
  const minOut = dataSource === 'hermes_log' ? HERMES_MIN_OUTPUT_TOKENS : SPEED_ESTIMATE_MIN_OUTPUT_TOKENS;
  const minDur = dataSource === 'hermes_log' ? HERMES_MIN_DURATION_MS : SPEED_ESTIMATE_MIN_DURATION_MS;
  if (output !== null && output >= minOut && latency !== null && latency >= minDur) {
    const tps = output / (latency / 1000);
    if (Number.isFinite(tps) && tps > 0) return { tokensPerSecond: tps, isEstimatedSpeed: true, generationMs: null };
  }
  return { tokensPerSecond: null, isEstimatedSpeed: false, generationMs: null };
}

export function normalizeCodexModel(value) {
  const raw = shortText(value);
  if (!raw) return null;
  const afterSlash = raw.slice(raw.lastIndexOf('/') + 1).trim().toLowerCase();
  return afterSlash ? afterSlash.replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-\d{8}$/, '') || null : null;
}

export function buildRecord({
  id, rawId = null, completedAt, createdAtSec = null, dataSource,
  inputTokens = 0, cacheReadTokens = 0, cacheCreationTokens = 0, cacheInclusive = false,
  outputTokens, durationMs, firstTokenMs = null, model = null, isSubagent = false
}) {
  if (!Number.isFinite(completedAt)) return null;
  const inTok = count(inputTokens) ?? 0, readTok = count(cacheReadTokens) ?? 0, writeTok = count(cacheCreationTokens) ?? 0;
  const freshInputTokens = cacheInclusive ? Math.max(0, inTok - readTok - writeTok) : inTok;
  const outTok = count(outputTokens), latency = count(durationMs);
  const validDuration = latency !== null && latency > 0 ? latency : null;
  const validFirst = validDuration !== null && count(firstTokenMs) !== null && firstTokenMs > 0 && firstTokenMs <= validDuration
    ? count(firstTokenMs) : null;
  const speed = computeSpeedMetrics({ outputTokens: outTok, durationMs: validDuration, firstTokenMs: validFirst, dataSource });
  const cacheable = freshInputTokens + writeTok + readTok;
  const cacheHitRate = cacheable > 0 && readTok <= cacheable ? readTok / cacheable : null;
  const cleanModel = shortText(model);
  return {
    id, ...(rawId ? { rawId } : {}), completedAt,
    createdAtSec: Number.isFinite(createdAtSec) ? Math.floor(createdAtSec) : Math.floor(completedAt / 1000),
    dataSource, freshInputTokens, outputTokens: outTok, cacheReadTokens: readTok, cacheCreationTokens: writeTok,
    durationMs: validDuration, firstTokenMs: validFirst, generationMs: speed.generationMs,
    tokensPerSecond: speed.tokensPerSecond, isEstimatedSpeed: speed.isEstimatedSpeed,
    ...(cacheHitRate !== null ? { cacheHitRate } : {}),
    ...(cleanModel && cleanModel !== 'unknown' ? { model: cleanModel } : {}),
    ...(isSubagent ? { isSubagent: true } : {})
  };
}

export function makeRecord(provider, { id, sessionId, cwd, completedAt, model, input, output, cacheRead, cacheWrite, duration, firstToken }) {
  const freshInputTokens = token(input), outputTokens = token(output);
  const cacheReadTokens = token(cacheRead), cacheCreationTokens = token(cacheWrite);
  if (!id || !Number.isFinite(completedAt) || !(freshInputTokens || outputTokens || cacheReadTokens || cacheCreationTokens)) return null;
  const durationMs = estimatedLatencyMs(0, Math.round(duration)) ?? null;
  const firstTokenMs = durationMs > 0 && firstToken > 0 && firstToken < durationMs ? Math.round(firstToken) : null;
  const dataSource = `${provider}_session`;
  const { tokensPerSecond, isEstimatedSpeed } = computeSpeedMetrics({
    outputTokens, durationMs, firstTokenMs, dataSource: firstTokenMs === null ? dataSource : 'proxy'
  });
  return {
    id, provider, sessionId: string(sessionId), cwd: string(cwd), completedAt, model: string(model) ?? 'unknown',
    freshInputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
    durationMs, firstTokenMs, tokensPerSecond, isEstimatedSpeed, dataSource
  };
}

export function buildHermesRecord({ cacheReported, ...request }) {
  const result = buildRecord({ ...request, dataSource: 'hermes_log', cacheInclusive: true });
  if (result && !cacheReported) delete result.cacheHitRate;
  return result;
}

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
    count(src.input_tokens), count(src.cached_input_tokens) ?? count(src.cache_read_input_tokens),
    count(src.output_tokens), count(src.reasoning_output_tokens), count(src.total_tokens)
  ] : null;
  return JSON.stringify([pick(total), pick(last)]);
}

export function createCodexParser(sessionId, { truncated = false, limit = 100 } = {}) {
  const sessionIdOf = typeof sessionId === 'function' ? sessionId : () => sessionId;
  const idPrefix = current => `codex_session:${current || 'session'}:`;
  let results = [], previousSig = null, totalHighWater = null, currentModel = null, eventIndex = 0, rowIndex = 0;
  let lastBoundaryMs = null, requestStartMs = null, lastModelOutputMs = null, toolAfterOutputMs = null;
  let firstOutputMs = null, usageRecord = null, pendingUsageRecord = null, lastTokenCountMs = null;
  const lastSigBySource = new Map();

  const resetInFlight = boundaryMs => {
    requestStartMs = lastModelOutputMs = toolAfterOutputMs = firstOutputMs = usageRecord = null;
    if (boundaryMs !== null) lastBoundaryMs = maxOpt(lastBoundaryMs, boundaryMs);
  };

  const finishRequest = (tokenCountMs, last) => {
    const startMs = requestStartMs ?? lastBoundaryMs, saved = usageRecord;
    const recordEndMs = saved && (last === null || (
      saved.usage.input === last.input && saved.usage.cachedInput === last.cachedInput && saved.usage.output === last.output
    )) ? saved.timestampMs : null;
    const waitedForTools = toolAfterOutputMs !== null && (tokenCountMs === null || tokenCountMs - toolAfterOutputMs <= SAME_FLUSH_SLACK_MS);
    const endMs = recordEndMs ?? (waitedForTools ? lastModelOutputMs : tokenCountMs);
    const latencyMs = startMs !== null && endMs !== null ? estimatedLatencyMs(startMs, endMs) : null;
    const ttftMs = startMs !== null && firstOutputMs !== null && latencyMs !== null ? estimatedFirstTokenMs(startMs, firstOutputMs, latencyMs) : null;
    resetInFlight(tokenCountMs);
    if (tokenCountMs !== null) lastTokenCountMs = tokenCountMs;
    return { latencyMs, firstTokenMs: ttftMs, endMs: endMs ?? tokenCountMs };
  };

  const feed = batch => {
    for (const row of batch) {
      const i = rowIndex++, atRaw = msTime(row.timestamp), at = Number.isFinite(atRaw) ? atRaw : null, payload = object(row.payload);
      if (row.type === 'turn_context') {
        currentModel = normalizeCodexModel(payload?.model ?? object(payload?.info)?.model) ?? currentModel;
        if (at !== null) lastBoundaryMs = maxOpt(lastBoundaryMs, at);
        continue;
      }
      if (row.type === 'response_item' && payload) {
        const pType = typeof payload.type === 'string' ? payload.type : '';
        if (pType === 'message' && payload.role !== 'assistant') {
          if (at !== null) lastBoundaryMs = maxOpt(lastBoundaryMs, at);
        } else if (pType.endsWith('_output')) {
          if (at !== null) { lastBoundaryMs = maxOpt(lastBoundaryMs, at); if (lastModelOutputMs !== null) toolAfterOutputMs = at; }
        } else if ((pType === 'message' && payload.role === 'assistant') || pType === 'reasoning' || pType.endsWith('_call')) {
          if (at !== null && !(requestStartMs === null && lastTokenCountMs !== null && at - lastTokenCountMs <= SAME_FLUSH_SLACK_MS)) {
            if (requestStartMs === null) requestStartMs = lastBoundaryMs;
            lastModelOutputMs = at;
            toolAfterOutputMs = null;
          }
        }
        continue;
      }
      if (row.type === 'token_usage_record' && payload) {
        const parsedUsage = parseCodexTokens(payload.usage);
        if (parsedUsage) {
          usageRecord = { timestampMs: at, usage: parsedUsage };
          pendingUsageRecord = { timestampMs: at, usage: parsedUsage, key: shortText(payload.response_id) ?? `line-${i}`, model: currentModel };
        }
        continue;
      }
      if (row.type !== 'event_msg' || !payload) continue;
      if (payload.type === 'thread_settings_applied') {
        currentModel = normalizeCodexModel(object(payload.thread_settings)?.model) ?? currentModel;
        continue;
      }
      if (payload.type === 'item_completed') {
        const itemType = object(payload.item)?.type, startedAt = count(payload.started_at_ms);
        if ((itemType === 'Reasoning' || itemType === 'AgentMessage') && startedAt > 0) {
          firstOutputMs = firstOutputMs === null ? startedAt : Math.min(firstOutputMs, startedAt);
        }
        continue;
      }
      if (['task_started', 'turn_started', 'turn_aborted'].includes(payload.type)) { resetInFlight(at); continue; }
      if (payload.type !== 'token_count') continue;
      const info = object(payload.info);
      if (!info) continue;
      currentModel = normalizeCodexModel(info.model ?? info.model_name ?? payload.model) ?? currentModel;
      const signature = codexTokenSignature(info);
      if (!signature) continue;
      const total = parseCodexTokens(info.total_token_usage), last = parseCodexTokens(info.last_token_usage);
      const limitId = shortText(object(payload.rate_limits)?.limit_id) ?? '';
      const isDuplicate = total !== null && (lastSigBySource.get(limitId) === signature || previousSig === signature);
      if (total !== null) lastSigBySource.set(limitId, signature);
      previousSig = signature;

      if (pendingUsageRecord) {
        const pending = pendingUsageRecord;
        pendingUsageRecord = null;
        const u = pending.usage;
        const lastZero = last !== null && !last.input && !last.cachedInput && !last.cacheWriteInput && !last.output;
        const matches = last !== null && last.input === u.input && last.cachedInput === u.cachedInput &&
          last.cacheWriteInput === u.cacheWriteInput && last.output === u.output;
        if (lastZero && !matches && (u.input > 0 || u.cachedInput > 0 || u.output > 0) && pending.timestampMs !== null) {
          const read = Math.min(u.cachedInput, u.input), write = Math.min(u.cacheWriteInput, u.input - read);
          results.push(buildRecord({
            id: `${idPrefix(sessionIdOf())}usage:${pending.key}`, completedAt: pending.timestampMs, dataSource: 'codex_session',
            inputTokens: u.input, cacheReadTokens: read, cacheCreationTokens: write, cacheInclusive: true,
            outputTokens: u.output, durationMs: null, model: pending.model
          }));
        }
      }
      if (isDuplicate) continue;

      let delta = null;
      if (last !== null) {
        delta = { ...last };
        if (total !== null) {
          totalHighWater = !totalHighWater || (total.output < totalHighWater.output && total.output === last.output && total.input === last.input)
            ? { ...total } : {
              input: Math.max(totalHighWater.input, total.input), cachedInput: Math.max(totalHighWater.cachedInput, total.cachedInput),
              cacheWriteInput: Math.max(totalHighWater.cacheWriteInput, total.cacheWriteInput), output: Math.max(totalHighWater.output, total.output)
            };
        }
      } else if (total !== null) {
        if (truncated && !totalHighWater) {
          totalHighWater = { ...total }; resetInFlight(at); if (at !== null) lastTokenCountMs = at; continue;
        }
        const base = totalHighWater ?? { input: 0, cachedInput: 0, cacheWriteInput: 0, output: 0 };
        delta = {
          input: Math.max(0, total.input - base.input), cachedInput: Math.max(0, total.cachedInput - base.cachedInput),
          cacheWriteInput: Math.max(0, total.cacheWriteInput - base.cacheWriteInput), output: Math.max(0, total.output - base.output)
        };
        totalHighWater = {
          input: Math.max(base.input, total.input), cachedInput: Math.max(base.cachedInput, total.cachedInput),
          cacheWriteInput: Math.max(base.cacheWriteInput, total.cacheWriteInput), output: Math.max(base.output, total.output)
        };
      }
      if (!delta) continue;
      const cachedInput = Math.min(delta.cachedInput, delta.input);
      const cacheWriteInput = Math.min(delta.cacheWriteInput, delta.input - cachedInput);
      if (!delta.input && !cachedInput && !delta.output) continue;
      const timing = finishRequest(at, last), completedAt = timing.endMs ?? at;
      if (completedAt === null) continue;
      results.push(buildRecord({
        id: `${idPrefix(sessionIdOf())}${++eventIndex}`, completedAt, dataSource: 'codex_session',
        inputTokens: delta.input, cacheReadTokens: cachedInput, cacheCreationTokens: cacheWriteInput, cacheInclusive: true,
        outputTokens: delta.output, durationMs: timing.latencyMs, firstTokenMs: timing.firstTokenMs, model: currentModel
      }));
    }
    if (results.length > limit * 2) results = recentRecords(results, limit);
  };
  return {
    feed,
    finish() {
      const current = sessionIdOf(), fallback = idPrefix(null);
      if (current) {
        for (const record of results) {
          if (record?.id.startsWith(fallback)) record.id = idPrefix(current) + record.id.slice(fallback.length);
        }
      }
      return recentRecords(results, limit);
    }
  };
}

export function createClaudeParser({ isSubagent = false, limit = 100 } = {}) {
  const chain = new Map(), messages = new Map(), timings = new Map();
  function addRow(row) {
    const uuid = shortText(row.uuid), atRaw = msTime(row.timestamp), at = Number.isFinite(atRaw) ? atRaw : null;
    if (uuid) chain.set(uuid, { parent: shortText(row.parentUuid), timestampMs: at, isAttachment: row.type === 'attachment' });
    if (row.type !== 'assistant') return;
    const message = object(row.message), msgId = shortText(message?.id) ?? uuid;
    if (!message || !msgId) return;
    const usage = object(message.usage), inputTokens = count(usage?.input_tokens) ?? 0, outputTokens = count(usage?.output_tokens) ?? 0;
    const cacheReadTokens = count(usage?.cache_read_input_tokens) ?? 0, cacheCreationTokens = count(usage?.cache_creation_input_tokens) ?? 0;
    const stopReason = shortText(message.stop_reason), model = shortText(message.model);
    const sidechain = Boolean(isSubagent || row.isSidechain === true);

    let timing = timings.get(msgId);
    if (!timing) {
      const startsAtFirstBlock = row.apiBlockIndex == null || row.apiBlockIndex === 0;
      const thinkingDuration = count(row.thinkingDurationMs);
      const firstBlock = Array.isArray(message.content) ? object(message.content[0]) : null;
      const firstOutputMs = startsAtFirstBlock && at !== null && thinkingDuration > 0 && firstBlock?.type === 'thinking'
        ? at - thinkingDuration : null;
      timings.set(msgId, { firstParent: shortText(row.parentUuid), startsAtFirstBlock, endMs: at ?? -Infinity, firstOutputMs });
    } else if (at !== null && at > timing.endMs) timing.endMs = at;

    const existing = messages.get(msgId), hasStop = stopReason !== null, existingHasStop = existing?.stopReason != null;
    if (!existing || (hasStop && !existingHasStop) || (hasStop === existingHasStop && outputTokens > existing.outputTokens)) {
      messages.set(msgId, {
        msgId, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, stopReason,
        model: model ?? existing?.model ?? null, timestampMs: at ?? existing?.timestampMs ?? null,
        isSubagent: sidechain || Boolean(existing?.isSubagent)
      });
    } else {
      if (!existing.model && model) existing.model = model;
      if (sidechain) existing.isSubagent = true;
    }
  }
  const resolveStart = parent => {
    for (let hop = 0, cursor = parent; hop < MAX_CHAIN_HOPS && cursor; hop++) {
      const node = chain.get(cursor);
      if (!node) return null;
      if (!node.isAttachment) return node.timestampMs;
      cursor = node.parent;
    }
    return null;
  };
  return {
    feed(rows) { for (const row of rows) addRow(row); },
    finish() {
      return recentRecords(Array.from(messages, ([msgId, msg]) => {
        if (!msg.inputTokens && !msg.outputTokens && !msg.cacheReadTokens && !msg.cacheCreationTokens) return null;
        const timing = timings.get(msgId), endMs = Number.isFinite(timing?.endMs) ? timing.endMs : msg.timestampMs;
        if (!Number.isFinite(endMs)) return null;
        let durationMs = null, firstTokenMs = null;
        if (msg.stopReason !== null && timing?.startsAtFirstBlock && Number.isFinite(timing.endMs)) {
          const startMs = resolveStart(timing.firstParent);
          if (startMs !== null) {
            durationMs = estimatedLatencyMs(startMs, timing.endMs);
            if (durationMs !== null && timing.firstOutputMs !== null) firstTokenMs = estimatedFirstTokenMs(startMs, timing.firstOutputMs, durationMs);
          }
        }
        return buildRecord({
          id: `session:${msgId}`, rawId: msgId, completedAt: endMs,
          createdAtSec: Math.floor((Number.isFinite(msg.timestampMs) ? msg.timestampMs : endMs) / 1000),
          dataSource: 'session_log', inputTokens: msg.inputTokens, cacheReadTokens: msg.cacheReadTokens,
          cacheCreationTokens: msg.cacheCreationTokens, outputTokens: msg.outputTokens, durationMs, firstTokenMs,
          model: msg.model, isSubagent: msg.isSubagent
        });
      }), limit);
    }
  };
}

function extractPiTokens(usageObj) {
  const u = object(usageObj);
  if (!u) return null;
  const input = count(u.input) ?? 0, output = count(u.output) ?? 0, cacheRead = count(u.cacheRead) ?? 0, cacheWrite = count(u.cacheWrite) ?? 0;
  return input || output || cacheRead || cacheWrite ? { input, output, cacheRead, cacheWrite } : null;
}

function createPiParser({ limit = 100 } = {}) {
  let results = [], currentModel = null, rowIndex = 0;
  const pushPi = (id, rawId, completedAt, tokens, durationMs, model, isSubagent = false) => results.push(buildRecord({
    id, rawId, completedAt, dataSource: 'pi_session', inputTokens: tokens.input, cacheReadTokens: tokens.cacheRead,
    cacheCreationTokens: tokens.cacheWrite, outputTokens: tokens.output, durationMs, model, isSubagent
  }));

  function addRow(row) {
    const i = rowIndex++;
    if (row.type === 'model_change') { currentModel = shortText(row.modelId) ?? shortText(row.model) ?? currentModel; return; }
    const entryId = shortText(row.id) ?? `line-${i}`, entryAt = piTime(row.timestamp);
    if (['compaction', 'branch_summary', 'model_usage'].includes(row.type)) {
      const tokens = extractPiTokens(row.usage);
      if (!tokens || !Number.isFinite(entryAt)) return;
      const durationMs = row.type === 'model_usage' && Number.isFinite(row.duration) && row.duration > 0 ? estimatedLatencyMs(0, Math.round(row.duration)) : null;
      return pushPi(`pi_session:${entryId}`, entryId, entryAt, tokens, durationMs, shortText(row.model) ?? shortText(row.modelId) ?? currentModel);
    }
    const message = row.type === 'message' ? object(row.message) : null;
    if (!message) return;
    if (message.role === 'toolResult' && message.toolName === 'subagent' && !object(message.usage)) {
      const details = object(message.details ?? row.details);
      if (details && ['single', 'parallel', 'chain'].includes(details.mode) && !details.sessionFile && Array.isArray(details.results)) {
        details.results.forEach((subResult, subIdx) => {
          const sr = object(subResult);
          if (!sr) return;
          let emitted = false;
          if (Array.isArray(sr.messages)) {
            sr.messages.forEach((child, childIdx) => {
              const cm = object(child), tokens = cm?.role === 'assistant' ? extractPiTokens(cm.usage) : null;
              const childAt = tokens ? piTime(cm.timestamp) : NaN, at = Number.isFinite(childAt) ? childAt : entryAt;
              if (!tokens || !Number.isFinite(at)) return;
              emitted = true;
              pushPi(`pi_session:${entryId}:sub:${subIdx}:${childIdx}`, null, at, tokens, null, shortText(cm.model) ?? currentModel, true);
            });
          }
          if (!emitted && Number.isFinite(entryAt)) {
            const tokens = extractPiTokens(sr.usage);
            if (tokens) pushPi(`pi_session:${entryId}:sub:${subIdx}`, null, entryAt, tokens, null, shortText(sr.model) ?? currentModel, true);
          }
        });
        return;
      }
    }
    if (message.role !== 'assistant' && message.role !== 'toolResult') return;
    const tokens = extractPiTokens(message.usage), msgAt = piTime(message.timestamp);
    const completedAt = Number.isFinite(entryAt) ? entryAt : msgAt;
    if (!tokens || !Number.isFinite(completedAt)) return;
    let durationMs = null;
    if (message.role === 'assistant') {
      if (Number.isFinite(message.duration) && message.duration > 0) durationMs = estimatedLatencyMs(0, Math.round(message.duration));
      else if (Number.isFinite(msgAt) && Number.isFinite(entryAt)) durationMs = estimatedLatencyMs(msgAt, entryAt);
    }
    pushPi(`pi_session:${entryId}`, entryId, completedAt, tokens, durationMs, shortText(message.model) ?? currentModel);
  }
  return {
    feed(rows) { for (const row of rows) addRow(row); if (results.length > limit * 2) results = recentRecords(results, limit); },
    finish: () => recentRecords(results, limit)
  };
}

export function antigravitySessionIdFromPath(file) {
  if (typeof file !== 'string') return null;
  const parts = file.split(/[\\/]+/).filter(Boolean);
  return parts.length >= 4 && parts.slice(-3).join('/') === ANTIGRAVITY_TAIL ? shortText(parts[parts.length - 4]) : null;
}

function protoFields(bytes, depth = 0) {
  if (!(bytes instanceof Uint8Array) || depth > 4) return null;
  const fields = new Map();
  let at = 0;
  const varint = () => {
    let value = 0, scale = 1;
    for (let n = 0; n < 10 && at < bytes.length; n++) {
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
    (fields.get(field) ?? fields.set(field, []).get(field)).push({ wire, value });
  }
  return fields;
}
const protoLast = (fields, number, wire) => fields?.get(number)?.filter(item => item.wire === wire).at(-1)?.value ?? null;
const protoVarint = (fields, number) => { const v = protoLast(fields, number, 0); return typeof v === 'number' ? v : null; };
const protoBytes = (fields, number) => protoLast(fields, number, 2);
const protoText = (fields, number) => { const b = protoBytes(fields, number); return b ? new TextDecoder().decode(b) : null; };
const protoSecondsMs = bytes => {
  const f = protoFields(bytes);
  return f ? (protoVarint(f, 1) ?? 0) * 1000 + Math.floor((protoVarint(f, 2) ?? 0) / 1_000_000) : null;
};

export function antigravityWorkspacePaths(metadata) {
  const fields = protoFields(metadata);
  return [protoText(protoFields(protoBytes(fields, 1)), 1), protoText(fields, 7)].filter(Boolean);
}

export function antigravityStepStart(metadata) {
  const fields = protoFields(metadata);
  return fields ? { createdMs: protoSecondsMs(protoBytes(fields, 1)), generationIndex: protoVarint(protoFields(protoBytes(fields, 20)), 3) } : null;
}

export function antigravityGeneration(data) {
  const r = protoFields(protoBytes(protoFields(data), 1));
  return r ? {
    model: antigravityModelId(protoText(r, 21)), baseModel: antigravityModelId(protoText(r, 19)),
    firstTokenMs: protoSecondsMs(protoBytes(r, 11)), streamMs: protoSecondsMs(protoBytes(r, 12))
  } : null;
}

export function antigravityModelId(label) {
  const value = typeof label === 'string' ? label.trim() : '';
  if (!value || value.length > 128 || value.toLowerCase() === 'unknown' || /[\u0000-\u001f\u007f]/.test(value)) return null;
  if (!value.includes(' ')) return value;
  return value.toLowerCase().replace(' (', '-').replace(/[()]/g, '').split(/\s+/).filter(Boolean).join('-') || null;
}

function modelSelectionFrom(content) {
  const start = content.indexOf('Model Selection'), to = start >= 0 ? content.indexOf(' to ', start) : -1;
  if (to < 0) return null;
  const tail = content.slice(to + 4);
  const end = Math.min(...['. ', '\n', '`'].map(m => { const idx = tail.indexOf(m); return idx >= 0 ? idx : tail.length; }));
  const id = antigravityModelId(tail.slice(0, end).replace(/\.$/, ''));
  return id && id.toLowerCase() !== 'none' ? id : null;
}

export function antigravityNativeTimings(steps, generations) {
  const timings = new Map();
  for (const step of steps) {
    const start = antigravityStepStart(step.metadata);
    if (!start || start.createdMs === null) continue;
    const gen = start.generationIndex === null ? null : antigravityGeneration(generations.get(start.generationIndex));
    const firstTokenMs = gen?.firstTokenMs ?? null, streamMs = gen?.streamMs ?? null;
    const latencyMs = firstTokenMs !== null && streamMs !== null && firstTokenMs + streamMs > 0 ? firstTokenMs + streamMs : null;
    const model = gen?.model ?? null, baseModel = gen?.baseModel ?? null;
    if (latencyMs !== null || model || baseModel) timings.set(Number(step.idx), { createdMs: start.createdMs, latencyMs, firstTokenMs, model, baseModel });
  }
  return timings;
}

function createAntigravityParser({ limit = 100 } = {}) {
  const steps = [];
  let selectedModel = null;
  return {
    feed(rows) {
      for (const row of rows) {
        if (typeof row.content === 'string' && row.content.includes('Model Selection')) selectedModel = modelSelectionFrom(row.content) ?? selectedModel;
        const stepIndex = count(row.step_index);
        const inputTokens = count(row.input_tokens), outputTokens = count(row.output_tokens), cacheReadTokens = count(row.cache_read_tokens);
        if (stepIndex !== null && (inputTokens !== null || outputTokens !== null || cacheReadTokens !== null)) {
          steps.push([stepIndex, { inputTokens, outputTokens, cacheReadTokens, selectedModel, createdAt: msTime(row.created_at) }]);
        }
      }
    },
    finish(native = new Map()) {
      return recentRecords(steps.map(([stepIndex, step]) => {
        const timing = native.get(stepIndex) ?? null, hasLatency = timing?.latencyMs != null;
        return buildRecord({
          id: `antigravity_session:${stepIndex}`, rawId: String(stepIndex),
          completedAt: hasLatency ? timing.createdMs + timing.latencyMs : step.createdAt,
          ...(timing ? { createdAtSec: Math.floor(timing.createdMs / 1000) } : {}),
          dataSource: 'antigravity_session', inputTokens: step.inputTokens ?? 0, cacheReadTokens: step.cacheReadTokens ?? 0,
          outputTokens: step.outputTokens ?? 0, durationMs: hasLatency ? timing.latencyMs : null,
          firstTokenMs: timing?.firstTokenMs ?? null, model: timing?.model ?? step.selectedModel ?? timing?.baseModel ?? null
        });
      }), limit);
    }
  };
}

const jsonlRows = text => text.split('\n').map(json).filter(Boolean);

function updateJsonlMetadata(metadata, rows, provider, options = {}) {
  if (provider === 'antigravity') { metadata.sessionId ??= shortText(options.sessionId); return metadata; }
  if (metadata.sessionId && metadata.cwd) return metadata;
  for (const row of rows) {
    if (provider === 'codex' && row.type === 'session_meta') { metadata.sessionId ??= shortText(row.payload?.id); metadata.cwd ??= shortText(row.payload?.cwd); }
    else if (provider === 'pi' && row.type === 'session') { metadata.sessionId ??= shortText(row.id); metadata.cwd ??= shortText(row.cwd); }
    else if (provider === 'claude') { metadata.sessionId ||= shortText(row.sessionId); metadata.cwd ||= shortText(row.cwd); }
    if (metadata.sessionId && metadata.cwd) break;
  }
  return metadata;
}

export const readJsonlMetadata = (text, provider) => updateJsonlMetadata({ sessionId: null, cwd: null }, jsonlRows(text), provider);

export function createJsonlCursor(text, provider, headerText = '', options = {}) {
  const rows = jsonlRows(text), metadata = { sessionId: null, cwd: null };
  updateJsonlMetadata(metadata, headerText ? jsonlRows(headerText) : rows, provider, options);
  if (headerText && (!metadata.sessionId || !metadata.cwd)) updateJsonlMetadata(metadata, rows, provider, options);
  const factories = {
    codex: () => createCodexParser(() => metadata.sessionId, options),
    claude: () => createClaudeParser(options),
    pi: () => createPiParser(options),
    antigravity: () => createAntigravityParser(options)
  };
  const parser = Object.hasOwn(factories, provider) ? factories[provider]() : null;
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

export function parseJsonl(text, provider, headerText = '', options = {}) {
  const cursor = createJsonlCursor(text, provider, headerText, options);
  return { sessionId: cursor.sessionId, cwd: cursor.cwd, records: cursor.finish(options.native) };
}

export function parseOpenCodeRows(rows, v2 = false, { limit = 100 } = {}) {
  const byId = new Map();
  for (const row of rows) {
    const data = object(row.data) ?? json(row.data), rowId = shortText(String(row.id ?? ''));
    if (!data || !rowId) continue;
    const type = row.type ?? data.role, timeObj = object(data.time), completedMs = msTime(timeObj?.completed);
    if (v2) {
      if (type === 'assistant') { if (!Number.isFinite(completedMs) || completedMs <= 0) continue; }
      else if (type !== 'compaction' || (data.status !== 'completed' && data.status !== 'failed')) continue;
    } else if (type !== 'assistant' || !Number.isFinite(completedMs) || completedMs <= 0) continue;

    const tokens = object(data.tokens);
    if (!tokens) continue;
    const input = count(tokens.input) ?? 0, output = count(tokens.output) ?? 0, reasoning = count(tokens.reasoning) ?? 0;
    const cache = object(tokens.cache), cacheRead = count(cache?.read) ?? 0, cacheWrite = count(cache?.write) ?? 0;
    const totalOutput = count(output + reasoning);
    if ((!input && !output && !reasoning && !cacheRead && !cacheWrite) || totalOutput === null) continue;

    const createdRaw = msTime(timeObj?.created), createdMs = createdRaw > 0 ? createdRaw : msTime(row.time_created);
    const streamedMs = msTime(timeObj?.streamed);
    const endMs = streamedMs > createdMs ? streamedMs : completedMs;
    const durationMs = createdMs > 0 && endMs > createdMs ? Math.round(endMs - createdMs) : null;
    const completedAt = completedMs > 0 ? completedMs : endMs > 0 ? endMs : msTime(row.time_created);
    if (!Number.isFinite(completedAt)) continue;
    const modelObj = object(data.model);
    const model = shortText(data.modelID) ?? shortText(data.modelId) ?? shortText(data.model) ?? shortText(modelObj?.id) ?? shortText(modelObj?.modelID);
    const entry = buildRecord({
      id: `opencode_session:${rowId}`, rawId: rowId, completedAt,
      createdAtSec: Math.floor((createdMs > 0 ? createdMs : completedAt) / 1000),
      dataSource: 'opencode_session', inputTokens: input, cacheReadTokens: cacheRead, cacheCreationTokens: cacheWrite,
      outputTokens: totalOutput, durationMs, model
    });
    if (entry) byId.set(entry.id, entry);
  }
  return recentRecords([...byId.values()], limit);
}

export function buildProxyRecord(row) {
  const r = object(row), requestId = shortText(r?.request_id);
  const createdAtSec = typeof r?.created_at === 'number' && Number.isFinite(r.created_at) ? Math.floor(r.created_at) : null;
  if (!requestId || createdAtSec === null) return null;
  const entry = buildRecord({
    id: `proxy:${requestId}`, rawId: requestId, completedAt: createdAtSec * 1000, createdAtSec, dataSource: 'proxy',
    inputTokens: count(r.input_tokens) ?? 0, cacheReadTokens: count(r.cache_read_tokens) ?? 0,
    cacheCreationTokens: count(r.cache_creation_tokens) ?? 0, cacheInclusive: r.input_token_semantics === 1 || r.app_type === 'grokbuild',
    outputTokens: count(r.output_tokens) ?? 0, durationMs: count(r.latency_ms), firstTokenMs: count(r.first_token_ms),
    model: shortText(r.pricing_model) ?? shortText(r.model) ?? shortText(r.request_model)
  });
  return entry ? { ...entry, sessionId: shortText(r.session_id), proxyModel: shortText(r.model), proxyRequestModel: shortText(r.request_model) } : null;
}

function modelsMatchForDedup(proxy, session, provider) {
  const p = (proxy.model ?? proxy.proxyModel ?? '').toLowerCase(), s = (session.model ?? '').toLowerCase();
  if (!p || !s || p === 'unknown' || s === 'unknown' || p === s) return true;
  if (provider !== 'codex') return false;
  const req = (proxy.proxyRequestModel ?? '').toLowerCase();
  return Boolean((req && req !== 'unknown' && (req === s || normalizeCodexModel(req) === normalizeCodexModel(s))) ||
    normalizeCodexModel(p) === normalizeCodexModel(s));
}

const stripProxy = ({ sessionId: _s, proxyModel: _pm, proxyRequestModel: _prm, ...clean }) => clean;
const proxyMatches = (proxy, session, provider) =>
  Math.abs(proxy.createdAtSec - session.createdAtSec) <= SESSION_PROXY_DEDUP_WINDOW_SECONDS &&
  proxy.freshInputTokens === session.freshInputTokens && proxy.outputTokens === session.outputTokens &&
  proxy.cacheReadTokens === session.cacheReadTokens && proxy.cacheCreationTokens === session.cacheCreationTokens &&
  modelsMatchForDedup(proxy, session, provider);
const upgradeProxy = (session, proxy) => stripProxy({
  ...proxy,
  completedAt: Math.abs(proxy.completedAt - session.completedAt) < 2000 ? session.completedAt : proxy.completedAt,
  ...(session.isSubagent ? { isSubagent: true } : {})
});

export function mergeProxyRecords(sessionRecords, proxyRows, provider, targetSessionId) {
  if (!Array.isArray(proxyRows) || !proxyRows.length) return recentRecords(sessionRecords);
  const parsed = proxyRows.map(buildProxyRecord).filter(Boolean);
  if (!parsed.length) return recentRecords(sessionRecords);
  const used = new Set(), merged = [];
  for (const sRec of sessionRecords) {
    if (!sRec) continue;
    const matched = parsed.find(p => !used.has(p.id) && sRec.rawId && p.rawId === sRec.rawId) ??
      parsed.find(p => !used.has(p.id) && (!p.sessionId || !targetSessionId || p.sessionId === targetSessionId) && proxyMatches(p, sRec, provider));
    if (matched) { used.add(matched.id); merged.push(upgradeProxy(sRec, matched)); }
    else merged.push(sRec);
  }
  for (const p of parsed) if (!used.has(p.id) && targetSessionId && p.sessionId === targetSessionId) merged.push(stripProxy(p));
  return recentRecords(merged);
}

export function mergeChannelProxyRecords(entries) {
  const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const sessions = entries.map(entry => ({
    ...entry, key: JSON.stringify([entry.provider, entry.sessionId]),
    proxies: new Map((entry.proxyRows ?? []).map(buildProxyRecord).filter(Boolean).map(p => [p.id, p]))
  })).sort((a, b) => cmp(a.key, b.key));
  const sources = new Map();
  for (const entry of sessions) for (const log of entry.records ?? []) {
    if (log) { const key = JSON.stringify([entry.provider, entry.sessionId, log.id]); sources.set(key, { key, entry, log }); }
  }
  const used = new Set(), matches = new Map();
  const assign = predicate => {
    const candidates = [];
    for (const source of sources.values()) {
      if (matches.has(source.key)) continue;
      for (const proxy of source.entry.proxies.values()) {
        if (!used.has(proxy.id) && predicate(source, proxy)) {
          candidates.push({ source, proxy, distance: Math.abs(proxy.createdAtSec - source.log.createdAtSec) });
        }
      }
    }
    candidates.sort((a, b) => a.distance - b.distance || cmp(a.source.key, b.source.key) || cmp(a.proxy.id, b.proxy.id));
    for (const { source, proxy } of candidates) {
      if (!matches.has(source.key) && !used.has(proxy.id)) { matches.set(source.key, proxy); used.add(proxy.id); }
    }
  };
  assign(({ log }, proxy) => Boolean(log.rawId) && log.rawId === proxy.rawId);
  const exactKey = s => JSON.stringify([harnessFamily(s.entry.provider), s.log.rawId]);
  const exactMatches = new Map();
  for (const s of sources.values()) { const p = matches.get(s.key); if (p) exactMatches.set(exactKey(s), p.id); }
  for (const s of sources.values()) {
    if (matches.has(s.key)) continue;
    const p = s.entry.proxies.get(exactMatches.get(exactKey(s)));
    if (p && s.log.rawId === p.rawId) matches.set(s.key, p);
  }
  assign(({ log, entry }, proxy) => Boolean(proxy.sessionId) && proxy.sessionId === entry.sessionId && proxyMatches(proxy, log, entry.provider));
  assign(({ log, entry }, proxy) => !proxy.sessionId && proxyMatches(proxy, log, entry.provider));

  const merged = new Map();
  for (const s of sources.values()) {
    const proxy = matches.get(s.key), value = proxy ? upgradeProxy(s.log, proxy) : s.log;
    merged.set(value.dataSource === 'proxy' ? value.id : s.key, { ...value, provider: s.entry.provider });
  }
  for (const entry of sessions) for (const proxy of entry.proxies.values()) {
    if (!used.has(proxy.id) && entry.sessionId && proxy.sessionId === entry.sessionId) {
      used.add(proxy.id);
      merged.set(proxy.id, { ...stripProxy(proxy), provider: entry.provider });
    }
  }
  return [...merged.entries()].sort(([ka, a], [kb, b]) => b.completedAt - a.completedAt || cmp(ka, kb)).slice(0, 100).map(([, v]) => v);
}

export const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const FRAME_MAGIC = 0xfd2fb528, SKIP_MAGIC = 0x184d2a50, DICTIONARY_BYTES = [0, 1, 2, 4];

export function frameHeader(buffer, start) {
  if (buffer.length - start < 5) return null;
  const magic = buffer.readUInt32LE(start);
  if ((magic & 0xfffffff0) === SKIP_MAGIC) return buffer.length - start < 8 ? null : { skip: true, end: start + 8 + buffer.readUInt32LE(start + 4) };
  if (magic !== FRAME_MAGIC || (buffer[start + 4] & 8) !== 0) throw new Error('Invalid Zstd frame header');
  const d = buffer[start + 4], single = (d & 32) !== 0, flag = d >>> 6, sizeBytes = flag ? 2 ** flag : Number(single);
  const sizeStart = start + 5 + Number(!single) + DICTIONARY_BYTES[d & 3], end = sizeStart + sizeBytes;
  if (end > buffer.length) return null;
  const size = sizeBytes === 8 ? Number(buffer.readBigUInt64LE(sizeStart)) : sizeBytes ? buffer.readUIntLE(sizeStart, sizeBytes) + (sizeBytes === 2 ? 256 : 0) : null;
  const wb = buffer[start + 5], window = single ? size : 2 ** ((wb >>> 3) + 10) * (1 + (wb & 7) / 8);
  if (window > MAX_FRAME_BYTES || size > MAX_FRAME_BYTES) throw new Error('Zstd frame exceeds the decode limit');
  return { end, checksum: (d & 4) !== 0 };
}

export function completeFrame(buffer, start) {
  const header = frameHeader(buffer, start);
  if (!header || header.skip) return header && header.end <= buffer.length ? header : null;
  for (let offset = header.end; offset + 3 <= buffer.length;) {
    const block = buffer.readUIntLE(offset, 3), blockType = (block >>> 1) & 3;
    if (blockType === 3) throw new Error('Invalid Zstd block');
    offset += 3 + (blockType === 1 ? 1 : block >>> 3);
    if (block & 1) { const end = offset + (header.checksum ? 4 : 0); return end <= buffer.length ? { end } : null; }
  }
  return null;
}

export function decodeZstdFrame(frame, limit = MAX_FRAME_BYTES) {
  const header = frameHeader(frame, 0);
  if (!header || header.skip) throw new Error('Invalid Zstd data frame');
  if (!zlib.zstdDecompressSync) throw new Error('Node.js 22.15+ is required for Zstd logs');
  return zlib.zstdDecompressSync(frame, { maxOutputLength: limit });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSpeedMetrics,
  formatHitRatePercent,
  formatSpeedDisplay,
  formatTokensPerSecond,
  mergeChannelProxyRecords,
  mergeProxyRecords,
  normalizeCodexModel,
  parseJsonl,
  parseOpenCodeRows
} from '../src/parsers.mjs';

const epoch = 1700000000000;
const iso = msOffset => new Date(epoch + msOffset).toISOString();
const row = (seconds, value) => ({ timestamp: iso(seconds * 1000), ...value });
const event = (seconds, payload) => row(seconds, { type: 'event_msg', payload });
const text = rows => rows.map(value => JSON.stringify(value)).join('\n') + '\n';
const usage = (total, last, input = 100, cached = 20) => ({ type: 'token_count', info: {
  total_token_usage: { output_tokens: total, input_tokens: input, cached_input_tokens: cached },
  last_token_usage: { output_tokens: last, input_tokens: input, cached_input_tokens: cached }
} });

test('CC Switch speed thresholds and formatters match exact vs session-log rules', () => {
  const shortSession = computeSpeedMetrics({ outputTokens: 199, durationMs: 2000, dataSource: 'session_log' });
  assert.equal(shortSession.tokensPerSecond, null);
  const fastSession = computeSpeedMetrics({ outputTokens: 300, durationMs: 999, dataSource: 'session_log' });
  assert.equal(fastSession.tokensPerSecond, null);

  const validSession = computeSpeedMetrics({ outputTokens: 250, durationMs: 5000, firstTokenMs: 2000, dataSource: 'session_log' });
  assert.equal(validSession.tokensPerSecond, 50);
  assert.equal(validSession.isEstimatedSpeed, true);
  assert.equal(validSession.generationMs, null);
  assert.equal(formatSpeedDisplay(validSession), '≈50');

  const slowSession = computeSpeedMetrics({ outputTokens: 200, durationMs: 400_000, dataSource: 'session_log' });
  assert.equal(formatSpeedDisplay(slowSession), '≈0.5');

  const exactProxy = computeSpeedMetrics({ outputTokens: 120, durationMs: 3500, firstTokenMs: 1500, dataSource: 'proxy' });
  assert.equal(exactProxy.tokensPerSecond, 60);
  assert.equal(exactProxy.isEstimatedSpeed, false);
  assert.equal(exactProxy.generationMs, 2000);
  assert.equal(formatSpeedDisplay(exactProxy), '60');

  const shortProxy = computeSpeedMetrics({ outputTokens: 99, durationMs: 3500, firstTokenMs: 1500, dataSource: 'proxy' });
  assert.equal(shortProxy.tokensPerSecond, null);
  const nonStreamProxy = computeSpeedMetrics({ outputTokens: 500, durationMs: 3500, firstTokenMs: null, dataSource: 'proxy' });
  assert.equal(nonStreamProxy.tokensPerSecond, null);

  assert.equal(formatTokensPerSecond(85.7), '86');
  assert.equal(formatTokensPerSecond(0.84), '0.8');
  assert.equal(formatHitRatePercent(0.9996), '100%');
  assert.equal(formatHitRatePercent(0.9884), '98.8%');
  assert.equal(formatHitRatePercent(null), '—');
});

test('Codex excludes tool execution via token_usage_record and extracts TTFT plus normalized model', () => {
  const parsed = parseJsonl(text([
    { type: 'session_meta', payload: { id: 'session-one', cwd: '/project' } },
    event(0, { type: 'task_started', turn_id: 'turn-one' }),
    row(1, { type: 'turn_context', payload: { turn_id: 'turn-one', model: 'OpenAI/GPT-6.1-SOL-2026-10-01' } }),
    row(1, { type: 'response_item', payload: { type: 'message', role: 'user' } }),
    event(2.5, { type: 'item_completed', item: { type: 'AgentMessage' }, started_at_ms: epoch + 2200 }),
    row(2.6, { type: 'response_item', payload: { type: 'message', role: 'assistant' } }),
    row(5, { type: 'response_item', payload: { type: 'custom_tool_call' } }),
    row(5, { type: 'token_usage_record', payload: { usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 240 } } }),
    // Simulate a 25-second shell command execution before token_count flushes:
    row(30, { type: 'response_item', payload: { type: 'custom_tool_call_output' } }),
    event(30.05, usage(240, 240, 1000, 800)),
    // Duplicate snapshot replay must be ignored:
    event(30.1, usage(240, 240, 1000, 800))
  ]), 'codex');

  assert.equal(parsed.sessionId, 'session-one');
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].model, 'gpt-6.1-sol');
  assert.equal(parsed.records[0].outputTokens, 240);
  assert.equal(parsed.records[0].durationMs, 4000);
  assert.equal(parsed.records[0].firstTokenMs, 1200);
  assert.equal(parsed.records[0].tokensPerSecond, 60);
  assert.equal(parsed.records[0].isEstimatedSpeed, true);
  assert.equal(parsed.records[0].cacheHitRate, 0.8);
  assert.equal(normalizeCodexModel('anthropic/claude-sonnet-5-5-20261001'), 'claude-sonnet-5-5');
});

test('Codex falls back to cumulative high-water delta and guards truncated tails without last usage', () => {
  const onlyTotal = (total, input = 500, cached = 100) => ({
    type: 'token_count',
    info: { total_token_usage: { output_tokens: total, input_tokens: input, cached_input_tokens: cached } }
  });
  const fromStart = parseJsonl(text([
    event(0, { type: 'task_started', turn_id: 't1' }),
    event(2, onlyTotal(250, 500, 100)),
    event(5, onlyTotal(550, 1000, 400))
  ]), 'codex');
  assert.equal(fromStart.records.length, 2);
  assert.equal(fromStart.records[0].outputTokens, 300);
  assert.equal(fromStart.records[0].tokensPerSecond, 100);
  assert.equal(fromStart.records[1].outputTokens, 250);
  assert.equal(fromStart.records[1].tokensPerSecond, 125);

  const truncated = parseJsonl(text([
    event(10, onlyTotal(50_000, 100_000, 80_000)),
    event(12, onlyTotal(50_300, 101_000, 80_800))
  ]), 'codex', '', { truncated: true });
  assert.equal(truncated.records.length, 1);
  assert.equal(truncated.records[0].outputTokens, 300);
  assert.equal(truncated.records[0].durationMs, 2000);
  assert.equal(truncated.records[0].tokensPerSecond, 150);
});

test('Claude walks parentUuid across attachments, excludes tool time, extracts thinking TTFT, and includes subagents', () => {
  const result = parseJsonl(text([
    row(1, { type: 'user', uuid: 'u1', sessionId: 'claude-session', message: { content: 'private prompt must never escape' } }),
    row(1.05, { type: 'attachment', uuid: 'att1', parentUuid: 'u1' }),
    row(1.08, { type: 'attachment', uuid: 'att2', parentUuid: 'att1' }),
    // Streaming partial without stop_reason, then final blocks with thinkingDurationMs:
    row(4, {
      type: 'assistant', uuid: 'a1-b0', parentUuid: 'att2', apiBlockIndex: 0, thinkingDurationMs: 500,
      message: {
        id: 'msg-1', model: 'claude-opus-5-5', stop_reason: null,
        content: [{ type: 'thinking' }],
        usage: { output_tokens: 50, input_tokens: 20, cache_read_input_tokens: 160, cache_creation_input_tokens: 20 }
      }
    }),
    row(5, {
      type: 'assistant', uuid: 'a1-b1', parentUuid: 'a1-b0', apiBlockIndex: 1,
      message: {
        id: 'msg-1', model: 'claude-opus-5-5', stop_reason: 'tool_use',
        content: [{ type: 'tool_use' }],
        usage: { output_tokens: 240, input_tokens: 20, cache_read_input_tokens: 160, cache_creation_input_tokens: 20 }
      }
    }),
    // 20 seconds of local tool execution between t=5s and t=25s:
    row(25, { type: 'user', uuid: 'tool-res-1', parentUuid: 'a1-b1', message: { content: [{ type: 'tool_result' }] } }),
    // Sidechain subagent message is included and tagged isSubagent:
    row(26, { type: 'user', uuid: 'sub-u', isSidechain: true, message: { content: 'sub' } }),
    row(28, {
      type: 'assistant', uuid: 'sub-a', parentUuid: 'sub-u', isSidechain: true,
      message: {
        id: 'msg-sub', model: 'claude-haiku-5-5', stop_reason: 'end_turn',
        usage: { output_tokens: 300, input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
      }
    }),
    // Second main request from t=25s to t=29s (short 120 tokens -> below 200 threshold -> speed is null):
    row(29, {
      type: 'assistant', uuid: 'a2', parentUuid: 'tool-res-1',
      message: {
        id: 'msg-2', model: 'claude-opus-5-5', stop_reason: 'end_turn',
        usage: { output_tokens: 120, input_tokens: 20, cache_read_input_tokens: 180, cache_creation_input_tokens: 0 }
      }
    })
  ]), 'claude');

  assert.equal(result.records.length, 3);
  assert.ok(!JSON.stringify(result).includes('private prompt'));

  const msg1 = result.records.find(r => r.rawId === 'msg-1');
  assert.equal(msg1.outputTokens, 240);
  assert.equal(msg1.durationMs, 4000);
  assert.equal(msg1.firstTokenMs, 2500);
  assert.equal(msg1.tokensPerSecond, 60);
  assert.equal(msg1.cacheHitRate, 0.8);
  assert.equal(msg1.isSubagent, undefined);

  const sub = result.records.find(r => r.rawId === 'msg-sub');
  assert.equal(sub.isSubagent, true);
  assert.equal(sub.durationMs, 2000);
  assert.equal(sub.tokensPerSecond, 150);

  const msg2 = result.records.find(r => r.rawId === 'msg-2');
  assert.equal(msg2.outputTokens, 120);
  assert.equal(msg2.durationMs, 4000);
  assert.equal(msg2.tokensPerSecond, null, '120 output tokens < 200 session-log estimate threshold');
});

test('OpenCode v2 and v1 prefer time.streamed over time.completed and sum output + reasoning', () => {
  const dbRow = (id, type, at, data) => ({ id, type, time_created: at, data });
  const v2 = parseOpenCodeRows([
    dbRow('u', 'user', 1000, {}),
    dbRow('a1', 'assistant', 2000, {
      model: { id: 'glm-5.3' },
      tokens: { input: 200, output: 150, reasoning: 150, cache: { read: 800, write: 0 } },
      // Streaming ended at 5000ms (3s generation), tool execution completed at 25000ms:
      time: { created: 2000, streamed: 5000, completed: 25000 }
    }),
    dbRow('c1', 'compaction', 26000, {
      status: 'completed',
      tokens: { input: 1000, output: 50, reasoning: 0, cache: { read: 500, write: 0 } }
    })
  ], true);
  assert.equal(v2.length, 2);
  const a1 = v2.find(r => r.rawId === 'a1');
  assert.equal(a1.outputTokens, 300);
  assert.equal(a1.durationMs, 3000);
  assert.equal(a1.tokensPerSecond, 100);
  assert.equal(a1.cacheHitRate, 0.8);

  const v1 = parseOpenCodeRows([
    dbRow('m1', null, 1000, {
      role: 'assistant', modelID: 'sonnet', finish: 'tool-calls',
      tokens: { input: 100, output: 200, reasoning: 50, cache: { read: 100, write: 0 } },
      time: { created: 1000, streamed: 3500, completed: 15000 }
    })
  ], false);
  assert.equal(v1.length, 1);
  assert.equal(v1[0].outputTokens, 250);
  assert.equal(v1[0].durationMs, 2500);
  assert.equal(v1[0].tokensPerSecond, 100);
});

test('Pi parses per-request assistant latency and unpacks official subagent toolResult usage without skewing latency', () => {
  const rows = [
    row(0, { type: 'session', id: 'pi-s', cwd: '/pi' }),
    row(1, { type: 'model_change', modelId: 'claude-sonnet-5-5' }),
    row(6, {
      type: 'message', id: 'm-fast',
      message: {
        role: 'assistant', timestamp: epoch + 2000, stopReason: 'stop',
        usage: { input: 50, output: 240, cacheRead: 150, cacheWrite: 0 }
      }
    }),
    row(20, {
      type: 'message', id: 'sub-tool',
      message: {
        role: 'toolResult', toolName: 'subagent',
        details: {
          mode: 'single',
          results: [{
            messages: [{
              role: 'assistant', timestamp: epoch + 10_000, model: 'claude-haiku-5-5',
              usage: { input: 100, output: 300, cacheRead: 0, cacheWrite: 0 }
            }]
          }]
        }
      }
    })
  ];
  const parsed = parseJsonl(text(rows), 'pi');
  assert.equal(parsed.records.length, 2);
  const main = parsed.records.find(r => r.rawId === 'm-fast');
  assert.equal(main.durationMs, 4000);
  assert.equal(main.tokensPerSecond, 60);
  assert.equal(main.cacheHitRate, 0.75);

  const sub = parsed.records.find(r => r.isSubagent);
  assert.equal(sub.outputTokens, 300);
  assert.equal(sub.durationMs, null, 'subagent child must not inherit parent tool completion latency');
  assert.equal(sub.tokensPerSecond, null);
});

test('mergeProxyRecords upgrades matching session records to exact post-TTFT proxy speed within ±600s', () => {
  const sessionResult = parseJsonl(text([
    row(1, { type: 'user', uuid: 'u1', sessionId: 's1', message: { content: 'hi' } }),
    row(6, {
      type: 'assistant', uuid: 'a1', parentUuid: 'u1',
      message: {
        id: 'req-short-150', model: 'claude-opus-5-5', stop_reason: 'end_turn',
        usage: { input_tokens: 50, output_tokens: 150, cache_read_input_tokens: 450, cache_creation_input_tokens: 0 }
      }
    })
  ]), 'claude');
  // Session log alone has 150 tokens (< 200), so estimated speed is null:
  assert.equal(sessionResult.records[0].tokensPerSecond, null);

  // Matching 2xx proxy record has exact TTFT (3000ms) and total latency (5000ms) -> 2000ms generation -> 75 tok/s!
  const merged = mergeProxyRecords(sessionResult.records, [{
    request_id: 'proxy-uuid-1',
    session_id: 's1',
    app_type: 'claude',
    model: 'claude-opus-5-5',
    input_tokens: 50,
    output_tokens: 150,
    cache_read_tokens: 450,
    cache_creation_tokens: 0,
    input_token_semantics: 0,
    latency_ms: 5000,
    first_token_ms: 3000,
    created_at: Math.floor((epoch + 6000) / 1000) + 2
  }], 'claude', 's1');

  assert.equal(merged.length, 1);
  assert.equal(merged[0].dataSource, 'proxy');
  assert.equal(merged[0].isEstimatedSpeed, false);
  assert.equal(merged[0].generationMs, 2000);
  assert.equal(merged[0].tokensPerSecond, 75);
  assert.equal(formatSpeedDisplay(merged[0]), '75');
});

const channelProxy = (id, seconds, overrides = {}) => ({
  request_id: id, app_type: 'codex', model: 'gpt-6.1-sol',
  input_tokens: 80, output_tokens: 300, cache_read_tokens: 20, cache_creation_tokens: 0,
  latency_ms: 5000, first_token_ms: 1000, created_at: epoch / 1000 + seconds,
  ...overrides
});
function channelEntry(sessionId, seconds, proxyRows, overrides = {}) {
  const records = parseJsonl(text([
    { type: 'session_meta', payload: { id: sessionId } },
    row(seconds - 2, { type: 'turn_context', payload: { model: 'gpt-6.1-sol' } }),
    event(seconds, usage(300, 300))
  ]), 'codex').records.map(record => ({ ...record, ...overrides }));
  return { provider: 'codex', sessionId, records, proxyRows };
}

test('channel proxy matching assigns anonymous rows once and uses the nearest request regardless of input order', () => {
  const proxies = [channelProxy('newer', 12, { latency_ms: 6000 }), channelProxy('older', 2, { latency_ms: 4000 })];
  const entries = [channelEntry('a', 2, proxies, { isSubagent: true }), channelEntry('b', 12, proxies)];
  const merged = mergeChannelProxyRecords(entries);
  assert.deepEqual(merged.map(record => [record.id, record.tokensPerSecond, Boolean(record.isSubagent)]), [
    ['proxy:newer', 60, false], ['proxy:older', 100, true]
  ]);
  assert.ok(merged.every(record => record.provider === 'codex' && !record.isEstimatedSpeed));
  assert.deepEqual(mergeChannelProxyRecords(entries.slice().reverse().map(entry => ({ ...entry, proxyRows: proxies.slice().reverse() }))), merged);
});

test('one anonymous proxy row does not erase the other session request', () => {
  const proxyRows = [channelProxy('only', 12)];
  const merged = mergeChannelProxyRecords([channelEntry('a', 2, proxyRows), channelEntry('b', 12, proxyRows)]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map(record => record.id), ['proxy:only', 'codex_session:a:1']);
  assert.equal(merged[1].isEstimatedSpeed, true);
});

test('channel matching reserves exact request IDs before semantic matches in another session', () => {
  const proxyRows = [channelProxy('exact-request', 2)];
  const entries = [channelEntry('a', 2, proxyRows), channelEntry('b', 12, proxyRows, { rawId: 'exact-request', isSubagent: true })];
  const merged = mergeChannelProxyRecords(entries);
  assert.equal(merged.length, 2);
  assert.ok(merged.some(record => record.id === 'codex_session:a:1'));
  assert.equal(merged.find(record => record.id === 'proxy:exact-request').isSubagent, true);
  assert.deepEqual(mergeChannelProxyRecords(entries.slice().reverse()), merged);
});

test('channel matching counts copied Claude requests once when both sources have the same exact proxy evidence', () => {
  const proxyRows = [channelProxy('same-request', 6, { app_type: 'claude', model: 'claude-sonnet-5-5' })];
  const claudeEntry = sessionId => ({
    provider: 'claude', sessionId, proxyRows,
    records: parseJsonl(text([
      row(1, { type: 'user', uuid: 'user', sessionId }),
      row(6, { type: 'assistant', uuid: 'assistant', parentUuid: 'user', message: {
        id: 'same-request', model: 'claude-sonnet-5-5', stop_reason: 'end_turn',
        usage: { input_tokens: 80, output_tokens: 300, cache_read_input_tokens: 20 }
      } })
    ]), 'claude').records
  });
  const original = claudeEntry('original'), fork = claudeEntry('fork');
  const merged = mergeChannelProxyRecords([original, fork]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, 'proxy:same-request');
  assert.equal(merged[0].provider, 'claude');
  assert.deepEqual(mergeChannelProxyRecords([fork, original]), merged);

  const unrelated = channelEntry('different-provider', 6, [], { rawId: 'same-request' });
  const noEvidence = { ...fork, sessionId: 'no-proxy-evidence', proxyRows: [] };
  const isolated = mergeChannelProxyRecords([original, unrelated, noEvidence]);
  assert.equal(isolated.length, 3, 'rawId alone must not suppress another provider or a source without exact proxy evidence');
  assert.equal(isolated.filter(record => record.dataSource === 'proxy').length, 1);
});

test('channel matching prefers session-scoped proxies and only appends proxies belonging to known sessions', () => {
  const proxyRows = [
    channelProxy('anonymous', 12),
    channelProxy('owned', 2, { session_id: 'b' }),
    channelProxy('extra', 20, { session_id: 'b', output_tokens: 500 }),
    channelProxy('unrelated', 21, { session_id: 'elsewhere', output_tokens: 500 }),
    channelProxy('unclaimed', 22, { output_tokens: 500 })
  ];
  const entries = [channelEntry('a', 2, proxyRows), channelEntry('b', 12, proxyRows, { isSubagent: true })];
  const merged = mergeChannelProxyRecords(entries);
  assert.equal(merged.length, 3);
  assert.deepEqual(new Set(merged.map(record => record.id)), new Set(['proxy:owned', 'proxy:anonymous', 'proxy:extra']));
  assert.equal(merged.find(record => record.id === 'proxy:owned').isSubagent, true);
  assert.equal(merged.find(record => record.id === 'proxy:anonymous').isSubagent, undefined);
  assert.ok(merged.every(record => record.sessionId === undefined && record.proxyModel === undefined));
  assert.deepEqual(mergeChannelProxyRecords(entries.slice().reverse()), merged);
});

test('channel merging preserves equal log IDs from different sessions and providers', () => {
  const a = channelEntry('a', 2, [], { id: 'same-log-id' });
  const b = channelEntry('b', 12, [], { id: 'same-log-id' });
  const otherProvider = { ...a, provider: 'pi' };
  assert.equal(mergeChannelProxyRecords([a, b, otherProvider]).length, 3);
});

test('history is limited to the newest hundred requests', () => {
  const rows = [];
  for (let i = 0; i < 105; i++) {
    rows.push(
      event(i * 3, { type: 'task_started', turn_id: String(i) }),
      event(i * 3 + 2, usage((i + 1) * 200, 200))
    );
  }
  const values = parseJsonl(text(rows), 'codex').records;
  assert.equal(values.length, 100);
  assert.equal(values[0].id, 'codex_session:session:105');
});

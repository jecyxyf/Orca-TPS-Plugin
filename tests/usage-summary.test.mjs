import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  accumulateRecords, dayKeyAgo, localDayKey, mergePersonalPackets, realTokens, summarizeUsage, usageCutoffMs
} from '../src/personal_stats.mjs';
import { discoverUsageUnits } from '../src/harness_parser.mjs';

let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); }
catch (error) { if (error.code !== 'ERR_UNKNOWN_BUILTIN_MODULE') throw error; }
const sqliteTestOptions = { skip: typeof DatabaseSync === 'function' ? false : 'requires node:sqlite' };

const at = (year, month, day, hour = 12) => new Date(year, month - 1, day, hour).getTime();
const jsonl = values => values.map(value => JSON.stringify(value)).join('\n') + '\n';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-tps-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('orca-tps-test-'));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('the local calendar spans include 365 days for the annual window', () => {
  const now = at(2026, 11, 8, 9);
  assert.equal(localDayKey(now), '2026-11-08');
  assert.equal(dayKeyAgo(now, 0), '2026-11-08');
  assert.equal(dayKeyAgo(now, 6), '2026-11-02');
  assert.equal(dayKeyAgo(now, 29), '2026-10-10');
  assert.equal(localDayKey(usageCutoffMs(now)), dayKeyAgo(now, 364), 'the index keeps a year of days');
});

test('window totals separate today, week, month and year and include all token types', () => {
  const now = at(2026, 11, 8, 9), days = {};
  accumulateRecords(days, 'claude', [
    { completedAt: at(2026, 11, 8, 8), model: 'claude-opus-5-5', freshInputTokens: 100, outputTokens: 50, cacheReadTokens: 900, cacheCreationTokens: 5 },
    { completedAt: at(2026, 11, 4, 8), model: 'claude-opus-5-5', freshInputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 },
    { completedAt: at(2026, 10, 20, 8), model: '', freshInputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    { completedAt: at(2026, 9, 1, 8), model: 'claude-opus-5-5', freshInputTokens: 999, outputTokens: 999, cacheReadTokens: 0, cacheCreationTokens: 0 },
    { completedAt: usageCutoffMs(now), outputTokens: 3 },
    { completedAt: usageCutoffMs(now) - 1, outputTokens: 999 }
  ]);
  accumulateRecords(days, 'codex', [
    { completedAt: at(2026, 11, 8, 7), model: 'gpt-6-astra', freshInputTokens: 200, outputTokens: 30, cacheReadTokens: 0, cacheCreationTokens: 0 }
  ]);
  const windows = summarizeUsage([days], now);
  // Real total = new input + output + cache writes + cache reads (CC Switch's definition).
  assert.equal(windows.today.requests, 2);
  assert.equal(windows.today.tokens, 1285);
  assert.equal(windows.today.cacheRead, 900);
  assert.ok(Math.abs(windows.today.cacheHitRate - 900 / 1205) < 1e-9, 'hit rate = cache reads / (fresh + writes + reads)');
  assert.equal(windows.week.requests, 3);
  assert.equal(windows.week.tokens, 1305);
  assert.equal(windows.month.requests, 4);
  assert.equal(windows.month.tokens, 1307);
  assert.equal(windows.year.requests, 6);
  assert.equal(windows.year.tokens, 3308, 'the oldest included day starts at local midnight');
  assert.equal(windows.today.rows[0].provider, 'claude', 'rows are sorted by real total');
  assert.equal(windows.month.rows.find(row => row.model === '').tokens, 2, 'missing model stays a separate empty id');
});

test('calendar year excludes December while both hourly 365-day views reuse the same result', () => {
  const now = Date.UTC(2026, 0, 2, 10);
  const rows = [
    { day: '2025-12-31', at: Date.UTC(2025, 11, 31, 12), counters: [1, 800, 0, 0, 0, 0, 0, 0] },
    { day: '2026-01-01', at: Date.UTC(2026, 0, 1, 12), counters: [1, 100, 0, 0, 0, 0, 0, 0] }
  ].map(row => ({ ...row, provider: 'codex', model: 'sample' }));
  const summary = mergePersonalPackets([{
    deviceGuid: 'local', publishedAt: now, timeZone: 'UTC', days: rows, hours: rows, maxima: []
  }], 'UTC', now);
  assert.equal(summary.windows.year.tokens, 100);
  assert.equal(summary.windows.past365.tokens, 900);
  assert.equal(summary.hourly.windows.year.tokens, 900);
  assert.equal(summary.hourly.windows.past365, summary.hourly.windows.year);
});

test('mirrored rollouts use the most complete copy independently of root order and keep a stable unit key', async t => {
  const root = await fixture(t), now = Date.now();
  const stale = path.join(root, 'stale'), complete = path.join(root, 'complete');
  await mkdir(stale); await mkdir(complete);
  const meta = { type: 'session_meta', payload: { id: 'mirrored-session' } };
  const request = n => ({
    timestamp: new Date(now - 5000 + n * 1000).toISOString(), type: 'event_msg',
    payload: { type: 'token_count', info: {
      total_token_usage: { input_tokens: n * 100, cached_input_tokens: n * 20, output_tokens: n * 200 },
      last_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 200 }
    } }
  });
  const stalePath = path.join(stale, 'rollout-mirrored.jsonl');
  const completePath = path.join(complete, 'rollout-mirrored.jsonl');
  await writeFile(stalePath, jsonl([meta, request(1)]));
  await writeFile(completePath, jsonl([meta, request(1), request(2)]));
  // A freshly copied stale mirror may have the newer filesystem timestamp.
  await utimes(stalePath, new Date(now - 1000), new Date(now - 1000));
  await utimes(completePath, new Date(now - 2000), new Date(now - 2000));
  const discover = roots => discoverUsageUnits(usageCutoffMs(now), { roots: { codex: roots }, includeDefaults: false });
  const first = await discover([stale, complete]);
  const reversed = await discover([complete, stale]);
  assert.equal(first.length, 1);
  assert.equal(reversed.length, 1);
  assert.equal(first[0].key, reversed[0].key);
  for (const units of [first, reversed]) {
    const totals = summarizeUsage([await units[0].read()], now).today;
    assert.equal(totals.requests, 2);
    assert.equal(totals.tokens, 600, 'both requests count once, regardless of root ordering or copy timestamps');
  }

  await writeFile(stalePath, jsonl([meta, request(1), request(2), request(3)]));
  const selected = await discover([stale, complete]);
  assert.equal(selected[0].key, first[0].key, 'switching to a fuller mirror keeps the same logical unit');
  const totals = summarizeUsage([await selected[0].read()], now).today;
  assert.equal(totals.requests, 3);
  assert.equal(totals.tokens, 900, 'the fuller mirror replaces the previous copy');
});

test('discovery counts Claude subagent calls once under the parent session and skips files older than a year', async t => {
  const root = await fixture(t), projects = path.join(root, 'projects', 'proj-a');
  const now = Date.now(), iso = offset => new Date(now - offset).toISOString();
  await mkdir(path.join(projects, 'session-1', 'subagents'), { recursive: true });
  const usage = (id, input, output) => ({ type: 'assistant', uuid: id, timestamp: iso(60_000), sessionId: 'session-1', message: { id, model: 'claude-opus-5-5', usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 }, stop_reason: 'end_turn' } });
  await writeFile(path.join(projects, 'session-1.jsonl'), jsonl([usage('m1', 100, 20)]));
  await writeFile(path.join(projects, 'session-1', 'subagents', 'agent-x.jsonl'), jsonl([usage('m2', 30, 5)]));
  const old = path.join(projects, 'old-session.jsonl');
  await writeFile(old, jsonl([usage('m9', 999, 999)]));
  const longAgo = new Date(now - 400 * 86_400_000);
  await utimes(old, longAgo, longAgo);

  const units = await discoverUsageUnits(usageCutoffMs(now), { roots: { claude: [path.join(root, 'projects')] }, includeDefaults: false });
  assert.equal(units.length, 1, 'subagent files are not separate units and old files are excluded');
  const days = await units[0].read();
  const totals = Object.values(days).flatMap(byProvider => Object.values(byProvider.claude ?? {})).reduce((sum, cell) => sum + cell[1] + cell[2] + cell[3] + cell[4], 0);
  assert.equal(totals, 1155, 'parent and subagent calls both count once, cache reads included (130 + 25 + 1000)');
  assert.equal(Object.values(days).reduce((sum, byProvider) => sum + byProvider.claude['claude-opus-5-5'][0], 0), 2);
});

test('discovery turns OpenCode sessions into per-session units', sqliteTestOptions, async t => {
  const root = await fixture(t), dbPath = path.join(root, 'opencode.db');
  const now = Date.now();
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE INDEX message_session ON message(session_id);`);
  db.prepare('INSERT INTO session VALUES (?, ?)').run('ses-1', now);
  db.prepare('INSERT INTO session VALUES (?, ?)').run('ses-old', now - 400 * 86_400_000);
  const message = (id, session, input, output) => db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(id, session, now, JSON.stringify({
    role: 'assistant', modelID: 'glm-5.3-flash', time: { created: now - 1000, completed: now },
    tokens: { input, output, reasoning: 0, cache: { read: 800, write: 0 } }
  }));
  message('m1', 'ses-1', 200, 40);
  message('m2', 'ses-1', 10, 5);
  message('m3', 'ses-old', 1, 1);
  db.close();

  const units = await discoverUsageUnits(usageCutoffMs(now), { roots: { opencode: [dbPath] }, includeDefaults: false });
  assert.equal(units.length, 1, 'one unit per session updated inside the window');
  const days = await units[0].read();
  const cell = days[localDayKey(now)].opencode['glm-5.3-flash'];
  assert.deepEqual(cell.slice(0, 3), [2, 210, 45], 'requests, new input and output for the session');
  assert.equal(cell[3], 1600, 'cache reads are kept apart from the token total');
});

test('daily series keeps one entry per active day within the year, oldest first', async () => {
  const { dailySeries, HISTORY_DAYS } = await import('../src/personal_stats.mjs');
  const now = at(2026, 11, 8, 9), days = {};
  accumulateRecords(days, 'claude', [
    { completedAt: at(2026, 11, 8, 8), model: 'm', freshInputTokens: 10, outputTokens: 5, cacheReadTokens: 85, cacheCreationTokens: 0 },
    { completedAt: at(2026, 9, 1, 8), model: 'm', freshInputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    { completedAt: at(2025, 1, 1, 8), model: 'm', freshInputTokens: 999, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
  ]);
  const series = dailySeries([days], now);
  assert.equal(HISTORY_DAYS, 365);
  assert.deepEqual(series.map(entry => entry.day), ['2026-09-01', '2026-11-08']);
  assert.equal(series[1].tokens, 100, 'a day total is the real total, cache reads included');
  assert.equal(series[1].requests, 1);
});

test('discovery reads Antigravity conversations with native model and cache counted in the real total', sqliteTestOptions, async t => {
  const root = await fixture(t), conversation = 'c1c2c3d4-0000-4000-8000-00000000abcd';
  const logs = path.join(root, 'brain', conversation, '.system_generated', 'logs');
  await mkdir(logs, { recursive: true });
  await mkdir(path.join(root, 'conversations'));
  const now = Date.now(), createdSec = Math.floor(now / 1000);
  await writeFile(path.join(logs, 'transcript.jsonl'), jsonl([
    { step_index: 0, type: 'USER_INPUT', source: 'USER', created_at: new Date(now).toISOString(), content: 'PRIVATE' },
    { step_index: 7, type: 'PLANNER_RESPONSE', source: 'MODEL', created_at: new Date(now).toISOString(), input_tokens: 1000, cache_read_tokens: 5000, output_tokens: 280 }
  ]));

  // Minimal protobuf encoders for Antigravity's native step and generation metadata.
  const varint = value => { const out = []; let rest = value; while (rest >= 128) { out.push((rest % 128) | 128); rest = Math.floor(rest / 128); } out.push(rest); return Buffer.from(out); };
  const field = (number, bytes) => Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
  const varField = (number, value) => Buffer.concat([varint(number * 8), varint(value)]);
  const seconds = (secs, ms) => Buffer.concat([varField(1, secs), varField(2, ms * 1_000_000)]);
  const stepMetadata = Buffer.concat([field(1, seconds(createdSec, 0)), field(20, varField(3, 3))]);
  const generation = Buffer.concat([field(1, Buffer.concat([field(21, Buffer.from('Gemini 3.8 Flash (High)')), field(11, seconds(2, 800)), field(12, seconds(0, 4))]))]);

  const db = new DatabaseSync(path.join(root, 'conversations', `${conversation}.db`));
  db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB, step_payload BLOB);' +
    'CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);');
  db.prepare('INSERT INTO steps VALUES (?, 15, ?, ?)').run(7, stepMetadata, Buffer.from('PRIVATE-PAYLOAD'));
  db.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(3, generation);
  db.close();

  const units = await discoverUsageUnits(usageCutoffMs(now), { roots: { antigravity: [path.join(root, 'brain')] }, includeDefaults: false });
  assert.equal(units.length, 1);
  const days = await units[0].read();
  const cell = days[localDayKey(now)].antigravity['gemini-3.8-flash-high'];
  assert.deepEqual(cell.slice(0, 5), [1, 1000, 280, 5000, 0]);
  assert.equal(realTokens({ freshInput: cell[1], output: cell[2], cacheWrite: cell[4], cacheRead: cell[3] }), 6280);
  assert.ok(!JSON.stringify(days).includes('PRIVATE'), 'message text and step payloads never reach the index');
});

test('streamed Codex usage equals a whole-file parse, and a file name is counted once across roots', async t => {
  const { readCodexUsageFile, parseJsonl } = await import('../src/harness_parser.mjs');
  const root = await fixture(t), now = Date.now();
  const iso = offset => new Date(now - offset).toISOString();
  // Cumulative totals: each snapshot adds one request of 1000 input (800 cached) and 240 output tokens.
  const cumulative = requests => ({ input_tokens: 1000 * requests, cached_input_tokens: 800 * requests, output_tokens: 240 * requests });
  const lastRequest = { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 240 };
  const rows = [
    { type: 'session_meta', payload: { id: 'codex-stream-1', cwd: '/work' } },
    { timestamp: iso(9000), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: cumulative(1), last_token_usage: lastRequest } } },
    { timestamp: iso(4000), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: cumulative(2), last_token_usage: lastRequest } } }
  ];
  const sessionFile = path.join(root, 'rollout-a.jsonl');
  await writeFile(sessionFile, jsonl(rows) + '{"partial":');
  const streamed = await readCodexUsageFile(sessionFile, dayKeyAgo(now, 364));
  const whole = {};
  accumulateRecords(whole, 'codex', parseJsonl(jsonl(rows), 'codex', '', { limit: Infinity }).records, { minDay: dayKeyAgo(now, 364) });
  assert.deepEqual(streamed, whole, 'the unfinished trailing line is not counted');
  assert.ok(Object.keys(streamed).length >= 1);

  const first = path.join(root, 'a'), second = path.join(root, 'b');
  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });
  await writeFile(path.join(first, 'rollout-dup.jsonl'), jsonl(rows));
  await writeFile(path.join(second, 'rollout-dup.jsonl'), jsonl(rows));
  const units = await discoverUsageUnits(usageCutoffMs(now), { roots: { codex: [first, second] }, includeDefaults: false });
  assert.equal(units.length, 1, 'the same file name in two roots is one unit');
});

test('model speed averages per-request TPS across agents, ranks fastest first, and skips sparse or unnamed models', () => {
  const now = at(2026, 11, 8, 9), days = {};
  const turn = (completedAt, model, tokensPerSecond, isEstimatedSpeed = false) => ({
    completedAt, model, freshInputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0,
    tokensPerSecond, isEstimatedSpeed
  });
  accumulateRecords(days, 'claude', [
    ...Array.from({ length: 6 }, (_, i) => turn(at(2026, 11, 8, 8) + i, 'fast-model', 120)),
    turn(at(2026, 11, 8, 7), 'fast-model', null),
    turn(at(2026, 11, 4, 8), 'fast-model', 240),
    ...Array.from({ length: 4 }, (_, i) => turn(at(2026, 11, 8, 6) + i, 'sparse-model', 300)),
    turn(at(2026, 11, 8, 5), '', 500)
  ]);
  accumulateRecords(days, 'codex', Array.from({ length: 5 }, (_, i) => turn(at(2026, 11, 8, 4) + i, 'mid-model', 60)));
  accumulateRecords(days, 'opencode', Array.from({ length: 5 }, (_, i) => turn(at(2026, 11, 8, 3) + i, 'mid-model', 40, true)));

  const windows = summarizeUsage([days], now);
  const today = windows.today;
  assert.deepEqual(today.speeds.map(entry => entry.model), ['fast-model', 'mid-model'], 'fastest first; sparse and unnamed models are not ranked');
  assert.equal(today.speedSparse, 1, 'a model below the sample minimum is counted, not ranked');
  assert.equal(today.speedHidden, 0);
  assert.deepEqual(today.speeds[0], { model: 'fast-model', tokensPerSecond: 120, samples: 6, estimated: false, providers: ['claude'] });
  assert.equal(today.speeds[1].tokensPerSecond, 50, 'mean of per-request TPS across agents');
  assert.equal(today.speeds[1].samples, 10);
  assert.equal(today.speeds[1].estimated, true, 'mostly log-estimated samples are marked as estimates');
  assert.deepEqual(today.speeds[1].providers, ['codex', 'opencode']);
  assert.equal(today.requests, 22, 'requests still count records without a speed, sparse models and unnamed models');
  assert.equal(windows.week.speeds[0].samples, 7, 'the week window includes the older fast sample');
  assert.ok(Math.abs(windows.week.speeds[0].tokensPerSecond - 960 / 7) < 1e-9);
});

test('model speed lists at most ten models and counts the rest', () => {
  const now = at(2026, 11, 8, 9), days = {};
  for (let model = 0; model < 11; model += 1) {
    accumulateRecords(days, 'pi', Array.from({ length: 5 }, (_, i) => ({
      completedAt: at(2026, 11, 8, 8) + i, model: `m${model}`, outputTokens: 1, tokensPerSecond: model + 1
    })));
  }
  const today = summarizeUsage([days], now).today;
  assert.equal(today.speeds.length, 10);
  assert.equal(today.speeds[0].model, 'm10', 'fastest model first');
  assert.equal(today.speedHidden, 1);
});

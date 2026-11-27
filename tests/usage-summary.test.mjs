import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openTokensManagerDb } from '../src/database.mjs';
import { calendarFor, makePersonalPacket, mergePersonalPackets } from '../src/personal_stats.mjs';
import { requestTokens } from '../src/leaderboard_stats.mjs';
import { discoverUsageUnits, parseJsonl } from '../src/harness_parser.mjs';

let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); }
catch (error) { if (error.code !== 'ERR_UNKNOWN_BUILTIN_MODULE') throw error; }
const sqliteTestOptions = { skip: typeof DatabaseSync === 'function' ? false : 'requires node:sqlite' };

const DAY_MS = 86_400_000;
const at = (year, month, day, hour = 12) => Date.UTC(year, month - 1, day, hour);
const jsonl = values => values.map(value => JSON.stringify(value)).join('\n') + '\n';
const totalTokens = records => records.reduce((sum, record) => sum + requestTokens(record), 0);
let serial = 0;
const request = (provider, completedAt, fields = {}) => ({ id: `request-${++serial}`, provider, completedAt, ...fields });

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-tps-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('orca-tps-test-'));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

// Requests reach the personal summary the way the manager counts them: stored per day and hour, then merged.
async function summarize(t, records, now) {
  const db = openTokensManagerDb(await fixture(t), { timeZone: 'UTC', now: () => now });
  try {
    db.commitSource('test', 'stamp', records, now);
    return mergePersonalPackets([makePersonalPacket(db, now)], 'UTC', now);
  } finally { db.close(); }
}

test('the calendar names local days and hours in the chosen time zone', () => {
  const calendar = calendarFor('Asia/Shanghai'), now = Date.UTC(2026, 10, 7, 20, 30, 15, 500);
  assert.equal(calendar.day(now), '2026-11-08');
  assert.equal(calendar.dayAgo(now, 6), '2026-11-02');
  assert.equal(calendar.dayAgo(now, 364), '2025-11-09', 'the 365-day window starts 364 days back');
  assert.equal(calendar.hour(now), Date.UTC(2026, 10, 7, 20));
});

test('window totals separate today, week, month and year and include all token types', async t => {
  const now = at(2026, 11, 8, 9);
  const usage = (fresh, output, cacheRead, cacheWrite) =>
    ({ freshInputTokens: fresh, outputTokens: output, cacheReadTokens: cacheRead, cacheCreationTokens: cacheWrite });
  const { windows } = await summarize(t, [
    request('claude', at(2026, 11, 8, 8), { model: 'claude-opus-5-5', ...usage(100, 50, 900, 5) }),
    request('claude', at(2026, 11, 4, 8), { model: 'claude-opus-5-5', ...usage(10, 10, 0, 0) }),
    request('claude', at(2026, 10, 20, 8), { model: '', ...usage(1, 1, 0, 0) }),
    request('claude', at(2026, 9, 1, 8), { model: 'claude-opus-5-5', ...usage(999, 999, 0, 0) }),
    request('claude', Date.UTC(2025, 10, 9), { outputTokens: 3 }),
    request('claude', Date.UTC(2025, 10, 9) - 1, { outputTokens: 999 }),
    request('codex', at(2026, 11, 8, 7), { model: 'gpt-6-astra', ...usage(200, 30, 0, 0) })
  ], now);
  // Real total = new input + output + cache writes + cache reads (CC Switch's definition).
  assert.equal(windows.today.requests, 2);
  assert.equal(windows.today.tokens, 1285);
  assert.equal(windows.today.cacheRead, 900);
  assert.ok(Math.abs(windows.today.cacheHitRate - 900 / 1205) < 1e-9, 'hit rate = cache reads / (fresh + writes + reads)');
  assert.equal(windows.week.requests, 3);
  assert.equal(windows.week.tokens, 1305);
  assert.equal(windows.month.requests, 4);
  assert.equal(windows.month.tokens, 1307);
  assert.equal(windows.year.requests, 5, 'the calendar year starts on January 1');
  assert.equal(windows.past365.requests, 6);
  assert.equal(windows.past365.tokens, 3308, 'the oldest included day starts at local midnight');
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
  const discover = roots => discoverUsageUnits(now - 30 * DAY_MS, { roots: { codex: roots }, includeDefaults: false });
  const first = await discover([stale, complete]);
  const reversed = await discover([complete, stale]);
  assert.equal(first.length, 1);
  assert.equal(reversed.length, 1);
  assert.equal(first[0].key, reversed[0].key);
  for (const units of [first, reversed]) {
    const { records } = await units[0].read();
    assert.equal(records.length, 2);
    assert.equal(totalTokens(records), 600, 'both requests count once, regardless of root ordering or copy timestamps');
  }

  await writeFile(stalePath, jsonl([meta, request(1), request(2), request(3)]));
  const selected = await discover([stale, complete]);
  assert.equal(selected[0].key, first[0].key, 'switching to a fuller mirror keeps the same logical unit');
  const { records } = await selected[0].read();
  assert.equal(records.length, 3);
  assert.equal(totalTokens(records), 900, 'the fuller mirror replaces the previous copy');
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
  const longAgo = new Date(now - 400 * DAY_MS);
  await utimes(old, longAgo, longAgo);

  const units = await discoverUsageUnits(now - 365 * DAY_MS, { roots: { claude: [path.join(root, 'projects')] }, includeDefaults: false });
  assert.equal(units.length, 1, 'subagent files are not separate units and old files are excluded');
  const { records, complete } = await units[0].read();
  assert.equal(complete, true);
  assert.deepEqual(records.map(record => [record.rawId, record.isSubagent === true, record.sessionId, record.provider]),
    [['m1', false, 'session-1', 'claude'], ['m2', true, 'session-1', 'claude']]);
  assert.equal(totalTokens(records), 1155, 'parent and subagent calls both count once, cache reads included (130 + 25 + 1000)');
});

test('discovery turns OpenCode sessions into per-session units', sqliteTestOptions, async t => {
  const root = await fixture(t), dbPath = path.join(root, 'opencode.db');
  const now = Date.now();
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE INDEX message_session ON message(session_id);`);
  db.prepare('INSERT INTO session VALUES (?, ?)').run('ses-1', now);
  db.prepare('INSERT INTO session VALUES (?, ?)').run('ses-old', now - 400 * DAY_MS);
  const message = (id, session, input, output) => db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(id, session, now, JSON.stringify({
    role: 'assistant', modelID: 'glm-5.3-flash', time: { created: now - 1000, completed: now },
    tokens: { input, output, reasoning: 0, cache: { read: 800, write: 0 } }
  }));
  message('m1', 'ses-1', 200, 40);
  message('m2', 'ses-1', 10, 5);
  message('m3', 'ses-old', 1, 1);
  db.close();

  const units = await discoverUsageUnits(now - 365 * DAY_MS, { roots: { opencode: [dbPath] }, includeDefaults: false });
  assert.equal(units.length, 1, 'one unit per session updated inside the window');
  const { records } = await units[0].read();
  assert.equal(records.length, 2);
  assert.ok(records.every(record => record.provider === 'opencode' && record.sessionId === 'ses-1' && record.model === 'glm-5.3-flash'));
  const sum = field => records.reduce((total, record) => total + record[field], 0);
  assert.deepEqual([sum('freshInputTokens'), sum('outputTokens')], [210, 45], 'new input and output for the session');
  assert.equal(sum('cacheReadTokens'), 1600, 'cache reads are kept apart from new input');
});

test('daily series keeps one entry per active day within the year, oldest first', async t => {
  const now = at(2026, 11, 8, 9);
  const { daily } = await summarize(t, [
    request('claude', at(2026, 11, 8, 8), { model: 'm', freshInputTokens: 10, outputTokens: 5, cacheReadTokens: 85 }),
    request('claude', at(2026, 9, 1, 8), { model: 'm', freshInputTokens: 1, outputTokens: 1 }),
    request('claude', at(2025, 1, 1, 8), { model: 'm', freshInputTokens: 999 })
  ], now);
  assert.deepEqual(daily, [{ day: '2026-09-01', tokens: 2, requests: 1 }, { day: '2026-11-08', tokens: 100, requests: 1 }],
    'a day total is the real total, cache reads included');
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

  const units = await discoverUsageUnits(now - 365 * DAY_MS, { roots: { antigravity: [path.join(root, 'brain')] }, includeDefaults: false });
  assert.equal(units.length, 1);
  const { records } = await units[0].read();
  assert.deepEqual(records.map(record => [record.provider, record.model, record.freshInputTokens, record.outputTokens,
    record.cacheReadTokens, record.cacheCreationTokens]), [['antigravity', 'gemini-3.8-flash-high', 1000, 280, 5000, 0]]);
  assert.equal(totalTokens(records), 6280);
  assert.ok(!JSON.stringify(records).includes('PRIVATE'), 'message text and step payloads never reach the index');
});

test('streamed Codex usage equals a whole-file parse, and a file name is counted once across roots', async t => {
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
  const [unit] = await discoverUsageUnits(0, { roots: { codex: [root] }, includeDefaults: false });
  const streamed = await unit.read();
  const whole = parseJsonl(jsonl(rows), 'codex', '', { limit: Infinity }).records
    .map(record => ({ ...record, sessionId: 'codex-stream-1', cwd: '/work', provider: 'codex' }));
  assert.deepEqual(streamed.records, whole, 'the unfinished trailing line is not counted');
  assert.equal(streamed.complete, false, 'a partial last line keeps the file open for another read');
  assert.equal(whole.length, 2);

  const first = path.join(root, 'a'), second = path.join(root, 'b');
  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });
  await writeFile(path.join(first, 'rollout-dup.jsonl'), jsonl(rows));
  await writeFile(path.join(second, 'rollout-dup.jsonl'), jsonl(rows));
  const units = await discoverUsageUnits(now - 365 * DAY_MS, { roots: { codex: [first, second] }, includeDefaults: false });
  assert.equal(units.length, 1, 'the same file name in two roots is one unit');
});

test('model speed averages per-request TPS across agents, ranks fastest first, and skips sparse or unnamed models', async t => {
  const now = at(2026, 11, 8, 9);
  const turn = (provider, completedAt, model, tokensPerSecond, isEstimatedSpeed = false) =>
    request(provider, completedAt, { model, freshInputTokens: 1, outputTokens: 1, tokensPerSecond, isEstimatedSpeed });
  const { windows } = await summarize(t, [
    ...Array.from({ length: 6 }, (_, i) => turn('claude', at(2026, 11, 8, 8) + i, 'fast-model', 120)),
    turn('claude', at(2026, 11, 8, 7), 'fast-model', null),
    turn('claude', at(2026, 11, 4, 8), 'fast-model', 240),
    ...Array.from({ length: 4 }, (_, i) => turn('claude', at(2026, 11, 8, 6) + i, 'sparse-model', 300)),
    turn('claude', at(2026, 11, 8, 5), '', 500),
    ...Array.from({ length: 5 }, (_, i) => turn('codex', at(2026, 11, 8, 4) + i, 'mid-model', 60)),
    ...Array.from({ length: 5 }, (_, i) => turn('opencode', at(2026, 11, 8, 3) + i, 'mid-model', 40, true))
  ], now);
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

test('model speed lists at most ten models and counts the rest', async t => {
  const now = at(2026, 11, 8, 9);
  const records = [];
  for (let model = 0; model < 11; model += 1) {
    for (let i = 0; i < 5; i += 1) {
      records.push(request('pi', at(2026, 11, 8, 8) + i, { model: `m${model}`, outputTokens: 1, tokensPerSecond: model + 1 }));
    }
  }
  const { today } = (await summarize(t, records, now)).windows;
  assert.equal(today.speeds.length, 10);
  assert.equal(today.speeds[0].model, 'm10', 'fastest model first');
  assert.equal(today.speedHidden, 1);
});

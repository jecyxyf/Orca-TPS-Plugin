import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { appendFile, mkdtemp, writeFile, mkdir, rm, utimes } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BACKFILL_UNITS, UNIT_KEY_PREFIX, USAGE_SCHEMA, accumulateRecords, createUsageIndex, dayKeyAgo, leaderboardDay,
  localDayKey, realTokens, summarizeUsage, usageCutoffMs
} from '../src/usage-summary.mjs';
import { discoverUsageUnits } from '../src/data.mjs';
import { createComputation } from '../src/computation.mjs';

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

function fakeStorage({ keyLimit = Infinity, valueLimit = Infinity } = {}) {
  const map = new Map(), writes = [], removals = [];
  return {
    map, writes, removals,
    async keys() { return [...map.keys()]; },
    async get(key) { return map.has(key) ? structuredClone(map.get(key)) : null; },
    async set(key, value) {
      if (!map.has(key) && map.size >= keyLimit) throw new Error('storage key limit');
      if (Buffer.byteLength(JSON.stringify(value)) > valueLimit) throw new Error('storage value limit');
      writes.push(key);
      map.set(key, structuredClone(value));
    },
    async delete(key) {
      removals.push(key);
      map.delete(key);
    }
  };
}

test('index re-reads only changed units, respects the byte budget, and replaces rather than adds', async () => {
  const now = at(2026, 11, 8, 9), today = localDayKey(now);
  const storage = fakeStorage(), reads = [];
  let units = [];
  const unit = (key, stamp, tokens, { bytes = 100, mtimeMs = 1, fail = false } = {}) => ({
    key, stamp, bytes, mtimeMs,
    read: async () => {
      reads.push(key);
      if (fail) throw Object.assign(new Error('boom'), { code: 'EBROKEN' });
      return { [today]: { codex: { 'gpt-6-astra': [1, tokens, 0, 0, 0] } } };
    }
  });
  const index = createUsageIndex({ storage, discover: async () => units, now: () => now, budgetBytes: 150 });

  units = [unit('a', 's1', 100, { mtimeMs: 3 }), unit('b', 's1', 50, { mtimeMs: 2 })];
  assert.deepEqual(await index.refresh(), { pending: 1 }, 'budget spent after the newest unit');
  assert.equal(index.summary().windows.today.tokens, 100);
  assert.deepEqual(index.summary().progress, { done: 1, total: 2 });

  assert.deepEqual(await index.refresh(), { pending: 0 });
  assert.equal(index.summary().windows.today.tokens, 150);
  assert.deepEqual(reads, ['a', 'b']);

  storage.writes.length = 0;
  await index.refresh();
  assert.deepEqual(reads, ['a', 'b'], 'unchanged stamps are not read again');
  assert.deepEqual(storage.writes, [], 'unchanged groups are not written again');

  units = [unit('a', 's2', 300, { mtimeMs: 4 }), unit('b', 's1', 50, { mtimeMs: 2 })];
  await index.refresh();
  assert.equal(index.summary().windows.today.tokens, 350, 'changed unit replaces its own totals');
  assert.deepEqual(reads, ['a', 'b', 'a']);
  assert.equal(storage.writes.length, 1, 'only the changed group is written');

  units = [unit('a', 's2', 300, { mtimeMs: 4 })];
  await index.refresh();
  assert.equal(index.summary().windows.today.tokens, 300, 'units that left the window are dropped');
  const restarted = createUsageIndex({ storage, discover: async () => units, now: () => now });
  await restarted.ready();
  assert.equal(restarted.summary().windows.today.tokens, 300, 'removed units stay removed after restart');
});

test('a saturated store migrates all its cached sessions and has space for more than 1024 sessions', async () => {
  const now = at(2026, 11, 8, 9), today = localDayKey(now);
  const storage = fakeStorage({ keyLimit: 1024, valueLimit: 256 * 1024 });
  await storage.set('locale', 'zh-CN');
  const days = { [today]: { codex: { m: [1, 10, 0, 0, 0] } } };
  let reads = 0;
  const units = Array.from({ length: 1500 }, (_, i) => ({
    key: `session-${i}`, stamp: 's1', bytes: 10, mtimeMs: i,
    async read() { reads++; return days; }
  }));
  for (const unit of units.slice(0, 1023)) {
    await storage.set(UNIT_KEY_PREFIX + unit.key, { stamp: unit.stamp, schema: USAGE_SCHEMA, days });
  }
  assert.equal(storage.map.size, 1024);
  const options = { storage, discover: async () => units, now: () => now, maxUnits: BACKFILL_UNITS };
  const index = createUsageIndex(options);
  await index.ready();
  assert.equal(index.summary().windows.today.requests, 1023, 'old totals are available before migration');
  storage.writes.length = 0;
  await index.refresh();
  assert.ok(storage.writes.length + storage.removals.length <= BACKFILL_UNITS, 'the first migration pass limits store mutations');
  for (let pass = 0; index.hasBackfill(); pass++) {
    assert.ok(pass < 1024, 'background migration and new reads complete');
    await index.refresh();
  }
  assert.ok(storage.map.size <= 65);
  assert.equal(reads, 477, 'cached sessions were migrated without scanning their logs again');
  const restarted = createUsageIndex(options);
  await restarted.ready();
  assert.equal(restarted.summary().windows.today.requests, 1500);
  assert.equal(await storage.get('locale'), 'zh-CN');
});

test('a compressed usage group fits the per-value limit even when its JSON is larger', async () => {
  const now = at(2026, 11, 8, 9);
  const storage = fakeStorage({ valueLimit: 256 * 1024 });
  const models = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`claude-model-${i}`, [1, 20, 0, 0, 0]]));
  const days = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [dayKeyAgo(now, i), { claude: models }]));
  const units = ['old-8', 'old-20'].map(key => ({ key, stamp: 's1', bytes: 10, mtimeMs: now, read: async () => days }));
  assert.ok(Buffer.byteLength(JSON.stringify([days, days])) > 256 * 1024);

  const options = { storage, discover: async () => units, now: () => now };
  await createUsageIndex(options).refresh();
  assert.equal(storage.map.size, 1);
  const restarted = createUsageIndex(options);
  await restarted.ready();
  assert.equal(restarted.summary().windows.today.requests, 100);
  assert.equal(restarted.summary().daily.length, 120);
});

test('a full store keeps legacy stats across a failed write and resumes after interrupted cleanup', async () => {
  const now = at(2026, 11, 8, 9), today = localDayKey(now);
  const storage = fakeStorage({ keyLimit: 3 });
  // These two legacy units hash to the same group.
  const keys = ['old-8', 'old-20'];
  const counters = { [today]: { codex: { m: [1, 10, 0, 0, 0] } } };
  for (const key of keys) await storage.set(UNIT_KEY_PREFIX + key, { stamp: 's1', schema: USAGE_SCHEMA, days: counters });
  await storage.set('locale', 'zh-CN');
  let reads = 0;
  const units = keys.map(key => ({
    key, stamp: 's1', bytes: 10, mtimeMs: now,
    async read() { reads++; return counters; }
  }));
  const options = { storage, discover: async () => units, now: () => now };
  const snapshot = structuredClone(storage.map);
  const save = storage.set;
  storage.set = async () => { throw new Error('simulated write failure'); };
  await createUsageIndex(options).refresh();
  assert.deepEqual(storage.map, snapshot, 'a failed group write leaves every old value available');

  storage.set = save;
  const remove = storage.delete;
  storage.delete = async () => { throw new Error('simulated interruption before cleanup'); };
  const second = createUsageIndex(options);
  await second.refresh();
  assert.equal(storage.map.size, 3, 'the group was written into an existing slot');
  assert.equal([...storage.map.values()].filter(value => value?.stamp === 's1').length, 1, 'a redundant legacy copy remains');

  storage.delete = remove;
  storage.writes.length = 0;
  const restarted = createUsageIndex(options);
  await restarted.ready();
  assert.equal(restarted.summary().windows.today.tokens, 20, 'group and legacy copies do not count twice');
  await restarted.refresh();
  assert.equal(storage.map.size, 2, 'cleanup frees a slot for other settings');
  assert.equal(reads, 0, 'migration does not require rereading original logs');
  assert.deepEqual(storage.writes, [], 'resuming cleanup needs no duplicate group write');
  assert.equal(await storage.get('locale'), 'zh-CN');
});

test('index survives restart from storage without immediately retrying failed units', async () => {
  const now = at(2026, 11, 8, 9), today = localDayKey(now);
  const storage = fakeStorage(), reads = [];
  const good = { key: 'good', stamp: 'g1', bytes: 10, mtimeMs: 2, read: async () => ({ [today]: { pi: { '': [2, 40, 10, 0, 0] } } }) };
  const broken = {
    key: 'bad', stamp: 'b1', bytes: 10, mtimeMs: 1,
    read: async () => { reads.push('bad'); throw Object.assign(new Error('x'), { code: 'too_large' }); }
  };
  const first = createUsageIndex({ storage, discover: async () => [good, broken], now: () => now });
  await first.refresh();
  await first.refresh();
  assert.deepEqual(reads, ['bad'], 'failed unit waits for its retry delay');
  assert.equal(first.summary().windows.today.tokens, 50);

  const restarted = createUsageIndex({ storage, discover: async () => [good, broken], now: () => now });
  await restarted.refresh();
  assert.equal(restarted.summary().windows.today.tokens, 50, 'totals come back from storage without re-reading');
  assert.deepEqual(reads, ['bad']);
});

test('backfill keeps today eligible before older history and retains complete totals across a failed scan', async () => {
  const now = at(2026, 11, 8, 9), today = localDayKey(now), rankDay = leaderboardDay(now);
  const yesterday = dayKeyAgo(now, 1), rankYesterday = leaderboardDay(now - 86_400_000);
  const current = { [today]: { pi: { model: [1, 30, 0, 0, 0] } } };
  const older = { [yesterday]: { pi: { model: [1, 10, 0, 0, 0] } } };
  const reads = [], storage = fakeStorage();
  let complete = true;
  const descriptors = Array.from({ length: BACKFILL_UNITS + 1 }, (_, i) => ({
    key: String(i), stamp: '1', bytes: 100, mtimeMs: i === 0 ? now : now - 86_400_000,
    async read() {
      reads.push(i);
      return { days: i === 0 ? current : older, leaderboardFrom: rankYesterday,
        leaderboardDays: i === 0 ? { [rankDay]: 30 } : { [rankYesterday]: 10 } };
    }
  }));
  const index = createUsageIndex({ storage, now: () => now, leaderboard: true, rankDays: 2, maxUnits: BACKFILL_UNITS,
    discover: async () => ({ descriptors: complete ? descriptors : [], coveredRemoteScopes: new Set(), localComplete: complete }) });
  assert.deepEqual(await index.refresh(), { pending: 1 });
  assert.equal(reads.length, BACKFILL_UNITS);
  assert.equal(reads[0], 0);
  assert.equal(index.leaderboardUsage().ready, true);
  assert.equal(index.leaderboardHistory().ready, false);
  await index.refresh();
  const expected = summarizeUsage([current, ...descriptors.slice(1).map(() => older)], now);
  assert.deepEqual(index.summary().windows, expected);
  assert.strictEqual(index.summary(), index.summary(), 'repeated reads reuse the summary');
  assert.deepEqual(index.leaderboardHistory().scores, [
    { day: rankYesterday, tokens: BACKFILL_UNITS * 10 }, { day: rankDay, tokens: 30 }
  ]);
  complete = false;
  await index.refresh();
  assert.deepEqual(index.summary().windows, expected);
  assert.equal(index.leaderboardUsage().ready, false);
});

test('an unreadable log directory or subagent directory retains usage until the next complete scan', async t => {
  const root = await fixture(t);
  const first = path.join(root, 'first'), second = path.join(root, 'second');
  const main = path.join(second, 'session-b.jsonl');
  const subagents = path.join(second, 'session-b', 'subagents');
  await mkdir(first);
  await mkdir(subagents, { recursive: true });
  const now = Date.now(), day = leaderboardDay(now);
  const usage = (id, offset, output) => ({
    type: 'assistant', uuid: id, timestamp: new Date(now - offset).toISOString(),
    message: { id, model: 'claude', usage: { input_tokens: 0, output_tokens: output }, stop_reason: 'end_turn' }
  });
  await writeFile(path.join(first, 'session-a.jsonl'), jsonl([usage('a', 1, 100)]));
  await writeFile(main, jsonl([usage('b', 2, 200)]));
  await writeFile(path.join(subagents, 'agent.jsonl'), jsonl([usage('c', 3, 300)]));
  const readdir = fs.readdir;
  let denied;
  const stub = t.mock.method(fs, 'readdir', async (directory, options) => {
    if (directory === denied) throw Object.assign(new Error('directory temporarily unreadable'), { code: 'EACCES' });
    return readdir(directory, options);
  });
  syncBuiltinESMExports();
  t.after(() => {
    stub.mock.restore();
    syncBuiltinESMExports();
  });

  const index = createUsageIndex({ storage: fakeStorage(), now: () => now, leaderboard: true, includeUsageTimes: true,
    async discover(cutoff, rankDay, rankFrom) {
      let localComplete = true;
      const descriptors = await discoverUsageUnits(cutoff, { roots: { claude: [path.join(root, 'missing'), first, second] },
        includeDefaults: false, rankDay, rankFrom, includeUsageTimes: true, onUnavailable: () => { localComplete = false; } });
      return { descriptors, localComplete };
    }
  });
  await index.refresh();
  assert.equal(index.leaderboardUsage().tokens, 600);
  assert.ok(index.leaderboardUsageTimes().coverage, 'an unused default path does not make a scan partial');

  denied = first;
  await appendFile(main, jsonl([usage('d', 4, 400)]));
  await index.refresh();
  assert.equal(index.leaderboardUsage().tokens, 1_000, 'readable sessions update and the unreadable one keeps its total');
  assert.deepEqual(index.leaderboardUsageTimes().buckets, [[now - 4, 400], [now - 3, 300], [now - 2, 200], [now - 1, 100]]);
  assert.equal(index.leaderboardUsageTimes().coverage, undefined, 'a failed scan cannot authorize zeroing missing usage');

  denied = subagents;
  await appendFile(main, jsonl([usage('e', 5, 500)]));
  await index.refresh();
  assert.equal(index.leaderboardUsage().tokens, 1_000, 'a partly readable Claude session keeps its last complete total');
  assert.equal(index.leaderboardUsageTimes().coverage, undefined);

  denied = undefined;
  await index.refresh();
  assert.deepEqual(index.leaderboardUsage(), { day, tokens: 1_500, updatedAt: now, ready: true });
  assert.ok(index.leaderboardUsageTimes().coverage);
});

test('the computation thread discovers and returns usage counters without sending raw logs', async t => {
  const root = await fixture(t), now = Date.now();
  const file = path.join(root, 'session.jsonl');
  await writeFile(file, jsonl([{ type: 'session_meta', payload: { id: 'worker-session' } }, {
    timestamp: new Date(now), type: 'event_msg', payload: { type: 'token_count',
      info: { last_token_usage: { input_tokens: 600, output_tokens: 400 } } }
  }]) + '{"incomplete":');
  const compute = createComputation();
  t.after(() => compute.close());
  const { descriptors, complete } = await compute.call('discover', usageCutoffMs(now), {
    roots: { codex: [root] }, includeDefaults: false, rankDay: leaderboardDay(now)
  });
  assert.equal(complete, true);
  assert.equal(descriptors.length, 1);
  assert.deepEqual(Object.keys(descriptors[0]).sort(), ['bytes', 'key', 'mtimeMs', 'stamp']);
  const { key, stamp } = descriptors[0];
  const result = await compute.call('usage', key, stamp);
  assert.equal(result.leaderboardDays[leaderboardDay(now)], 1_000);
  await assert.rejects(compute.call('usage', key, 'stale'), /source changed/);
});

test('transient read failures preserve cached totals across restart and retry unchanged files', async () => {
  for (const bytes of [100, 100 * 1024 * 1024]) {
    let clock = at(2026, 11, 8, 9), stamp = 's1', failing = false, reads = 0;
    const today = localDayKey(clock), storage = fakeStorage();
    const discover = async () => [{
      key: 'session', stamp, bytes, mtimeMs: clock,
      read: async () => {
        reads += 1;
        if (failing) throw Object.assign(new Error('temporarily busy'), { code: 'EBUSY' });
        return { [today]: { codex: { model: [1, stamp === 's1' ? 100 : 400, 200, 0, 0] } } };
      }
    }];
    const index = createUsageIndex({ storage, discover, now: () => clock });
    await index.refresh();
    assert.equal(index.summary().windows.today.tokens, 300);

    // Let a large file become eligible before its changed version temporarily fails.
    clock += 11 * 60_000;
    stamp = 's2';
    failing = true;
    assert.deepEqual(await index.refresh(), { pending: 1 });
    assert.equal(index.summary().windows.today.tokens, 300, 'a read failure must retain the last successful counts');
    assert.deepEqual(index.summary().progress, { done: 0, total: 1 }, 'a failed read is not reported as complete');

    const restarted = createUsageIndex({ storage, discover, now: () => clock });
    await restarted.ready();
    assert.equal(restarted.summary().windows.today.tokens, 300, 'retained counts survive a worker restart');
    failing = false;
    await restarted.refresh();
    assert.equal(reads, 2, 'the retry delay prevents a tight loop');
    clock += 15_000;
    assert.deepEqual(await restarted.refresh(), { pending: 0 });
    assert.equal(reads, 3, 'an unchanged file is retried after the delay, including large files');
    assert.equal(restarted.summary().windows.today.tokens, 600, 'recovery replaces the retained totals instead of adding to them');
    assert.deepEqual(restarted.summary().progress, { done: 1, total: 1 });
  }
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

  let selected = first;
  const index = createUsageIndex({ storage: fakeStorage(), discover: async () => selected, now: () => now });
  await index.refresh();
  await writeFile(stalePath, jsonl([meta, request(1), request(2), request(3)]));
  selected = await discover([stale, complete]);
  assert.equal(selected[0].key, first[0].key, 'switching to a fuller mirror keeps the same logical unit');
  await index.refresh();
  assert.equal(index.summary().windows.today.requests, 3);
  assert.equal(index.summary().windows.today.tokens, 900, 'the fuller mirror replaces the previous copy');
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
  const { dailySeries, HISTORY_DAYS } = await import('../src/usage-summary.mjs');
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
  const { readCodexUsageFile } = await import('../src/data.mjs');
  const { parseJsonl } = await import('../src/parsers.mjs');
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

test('large files that are still growing are re-read at most once per interval', async () => {
  const now = at(2026, 11, 8, 9), today = localDayKey(now);
  let clock = now, reads = 0;
  const storage = fakeStorage();
  let stamp = 's1';
  const big = { key: 'big', mtimeMs: now, bytes: 100 * 1024 * 1024, get stamp() { return stamp; }, read: async () => { reads += 1; return { [today]: { codex: { m: [1, 10, 0, 0, 0] } } }; } };
  const index = createUsageIndex({ storage, discover: async () => [big], now: () => clock });
  await index.refresh();
  assert.equal(reads, 1);
  stamp = 's2';
  clock += 60_000;
  await index.refresh();
  assert.equal(reads, 1, 'within the interval the previous read stays in effect');
  assert.equal(index.summary().progress.done, 1, 'a deferred large file counts as up to date');
  clock += 11 * 60_000;
  await index.refresh();
  assert.equal(reads, 2, 'after the interval the file is read again');
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

test('index units stored before speed counters keep their totals, are re-read once, then rank speed', async () => {
  const now = at(2026, 11, 8, 9), today = localDayKey(now);
  const storage = fakeStorage(), reads = [];
  // A unit as the previous schema stored it: five counters per cell and no schema field.
  await storage.set(`${UNIT_KEY_PREFIX}old`, { stamp: 's1', readAt: 1, days: { [today]: { claude: { 'claude-opus-5-5': [2, 100, 50, 0, 0] } } } });
  const unit = {
    key: 'old', stamp: 's1', bytes: 100, mtimeMs: 1,
    read: async () => {
      reads.push('old');
      return { [today]: { claude: { 'claude-opus-5-5': [2, 100, 50, 0, 0, 5, 600, 0] } } };
    }
  };
  const index = createUsageIndex({ storage, discover: async () => [unit], now: () => now });
  await index.ready();
  assert.equal(index.summary().windows.today.tokens, 150, 'totals stay visible before the re-read');
  assert.equal(index.summary().windows.today.speeds.length, 0);

  assert.deepEqual(await index.refresh(), { pending: 0 });
  assert.deepEqual(reads, ['old']);
  assert.equal(index.summary().windows.today.tokens, 150);
  assert.equal(index.summary().windows.today.speeds[0].tokensPerSecond, 120);
  const restarted = createUsageIndex({ storage, discover: async () => [unit], now: () => now });
  await restarted.refresh();
  assert.deepEqual(reads, ['old'], 'a current-schema unit is not read again');
});

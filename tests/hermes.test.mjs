import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { defaultRoots } from '../src/harness_parser.mjs';
import { discoverUsageUnits, readTargetSession } from '../src/harness_parser.mjs';
import { leaderboardDay, leaderboardDayStart } from '../src/leaderboard_stats.mjs';
import { localDayKey } from '../src/personal_stats.mjs';

const options = root => ({ roots: { hermes: [root] }, includeDefaults: false, ccSwitchDb: null });
const localTime = clock => {
  const field = value => String(value).padStart(2, '0');
  return `${localDayKey(clock.getTime())} ${field(clock.getHours())}:${field(clock.getMinutes())}:${field(clock.getSeconds())},000`;
};

const call = (id, { clock = new Date(), session = 'local-hermes', model = 'model-a', cache = '', responseId = 'result-' + id } = {}) =>
  `${localTime(clock)} INFO [${session}] agent.conversation_loop: API call #${id}: model=${model} provider=example in=500 out=56 total=556 latency=3.3s${cache ? ' ' + cache : ''}${responseId ? ' id=' + responseId : ''}\r\n`;

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'tps-hermes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logs = path.join(root, 'logs');
  await mkdir(logs);
  return { root, file: path.join(logs, 'agent.log') };
}

test('Hermes home discovery includes native Windows and configured roots', () => {
  assert.deepEqual(defaultRoots({
    platform: 'win32', home: 'C:\\Users\\a', env: { LOCALAPPDATA: 'D:\\Local', HERMES_HOME: 'D:\\Profile' }
  }).roots.hermes, ['D:\\Profile', 'D:\\Local\\hermes', 'C:\\Users\\a\\.hermes']);
  assert.deepEqual(defaultRoots({ platform: 'linux', home: '/home/a', env: {} }).roots.hermes, ['/home/a/.hermes']);
});

test('Hermes reads project and pane sessions with optional cache fields, keeping session metadata private', async t => {
  const { root, file } = await fixture(t);
  const project = path.join(root, 'project'), unrelated = path.join(root, 'another-project');
  const db = new DatabaseSync(path.join(root, 'state.db'));
  try {
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, source TEXT, started_at INTEGER, title TEXT)');
    const add = db.prepare("INSERT INTO sessions VALUES (?, ?, ?, 0, 'PRIVATE_SESSION_TITLE')");
    add.run('local-hermes', project, 'cli');
    add.run('local-other', unrelated, 'cli');
    add.run('local-subagent', project, 'subagent');
  } finally { db.close(); }
  await writeFile(file, call(1) + call(2, { session: 'local-other' }) +
    call(3, { session: 'local-subagent', cache: 'cache=300/500 (60%) write=50' }) +
    call(4, { session: 'local-pane', cache: 'write=25' }));
  const { session, warnings } = await readTargetSession({
    worktreePath: project, sessions: [{ provider: 'hermes', sessionId: 'local-pane' }]
  }, options(root));
  assert.deepEqual(warnings, []);
  assert.equal(session.records.length, 3);
  const logged = session.records.find(record => record.cacheHitRate === 0.6);
  assert.equal(logged.freshInputTokens, 150);
  assert.equal(logged.cacheCreationTokens, 50);
  assert.equal(logged.isSubagent, true);
  const ordinary = session.records.find(record => record.freshInputTokens === 500);
  assert.equal(ordinary.cacheHitRate, undefined);
  assert.equal(ordinary.firstTokenMs, null);
  assert.equal(ordinary.durationMs, 3300);
  assert.equal(ordinary.isEstimatedSpeed, true);
  assert.ok(Math.abs(ordinary.tokensPerSecond - 56 / 3.3) < 1e-9);
  const writeOnly = session.records.find(record => record.cacheCreationTokens === 25);
  assert.equal(writeOnly.freshInputTokens, 475);
  assert.equal(writeOnly.cacheHitRate, undefined);
  assert.ok(session.records.every(record => record.provider === 'hermes'));
  assert.doesNotMatch(JSON.stringify(session), /PRIVATE_SESSION_TITLE|local-other/);
});

test('Hermes usage preserves all timestamped requests and deduplicates rotations beyond the 100-card limit', async t => {
  const { root, file } = await fixture(t);
  const rankDay = leaderboardDay(Date.now());
  const start = leaderboardDayStart(rankDay);
  const today = new Date(start + 60_000), yesterday = new Date(start - 60_000);
  const rankFrom = leaderboardDay(yesterday.getTime());
  const rows = Array.from({ length: 130 }, (_, index) => call(index + 1, { clock: today }));
  await writeFile(file, rows.join(''));
  await writeFile(file + '.1', call(131, { clock: yesterday }) + rows.slice(0, 10).join(''));
  const units = await discoverUsageUnits(0, { ...options(root), rankDay, rankFrom });
  assert.equal(units.length, 1);
  const result = await units[0].read();
  const requests = Object.values(result.days).reduce((total, day) => total + day.hermes['model-a'][0], 0);
  assert.equal(requests, 131);
  assert.equal(result.leaderboardFrom, rankFrom);
  assert.deepEqual(result.leaderboardDays, { [rankDay]: 130 * 556, [rankFrom]: 556 });
  const live = await readTargetSession({ provider: 'hermes', sessionId: 'local-hermes' }, options(root));
  assert.equal(live.session.records.length, 100);
});

test('Hermes notices equal-size replacements and reads each complete appended request once', async t => {
  const { root, file } = await fixture(t);
  const clock = new Date();
  const entry = (id, model, at = clock) => call(id, { model, clock: at, responseId: '' });
  const read = async () => (await readTargetSession({ provider: 'hermes', sessionId: 'local-hermes' }, options(root))).session.records;
  await writeFile(file, entry(1, 'model-a'));
  assert.deepEqual((await read()).map(row => row.model), ['model-a']);
  await writeFile(file, entry(2, 'model-b'));
  await utimes(file, clock, new Date(clock.getTime() + 1000));
  assert.deepEqual((await read()).map(row => row.model), ['model-b']);
  await rename(file, file + '.1');
  const resumed = entry(2, 'model-b', new Date(clock.getTime() + 2000));
  await writeFile(file, resumed.slice(0, -2));
  assert.equal((await read()).length, 1);
  await appendFile(file, '\r\n');
  assert.equal((await read()).length, 2);
  assert.equal((await read()).length, 2);
});

test('the harness parser reads Hermes timestamps in the source host time zone', async t => {
  const { root, file } = await fixture(t);
  const rankDay = leaderboardDay(Date.now()), start = leaderboardDayStart(rankDay);
  const timestamp = new Date(start + 60_000).toISOString().slice(0, 19).replace('T', ' ') + ',000';
  const row = call(1).replace(/^.{23}/, timestamp);
  await writeFile(file, row);
  const parser = new URL('../src/harness_parser.mjs', import.meta.url).href;
  const script = `
    import { HarnessParser } from ${JSON.stringify(parser)};
    for await (const source of new HarnessParser().readSince(Number(process.argv[1]))) {
      const selected = source.records.filter(record => record.provider === 'hermes');
      if (selected.length) console.log(JSON.stringify(selected[0]));
    }
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, String(start)], {
    env: { ...process.env, HOME: root, USERPROFILE: root, HERMES_HOME: root, TZ: 'UTC' }, timeout: 10_000
  });
  const result = JSON.parse(stdout);
  assert.equal(result.completedAt, start + 60_000);
  assert.equal(result.freshInputTokens + result.outputTokens + result.cacheReadTokens + result.cacheCreationTokens, 556);
});

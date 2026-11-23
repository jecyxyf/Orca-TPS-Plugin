import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import { calendarFor, openTokensManagerDb } from '../src/tokens-manager-db.mjs';
import { makePersonalPacket, mergePersonalPackets, TOKENS_DEFAULT_INTERVALS } from '../src/tokens-manager-stats.mjs';
import { createTokensRankings, validatePacket } from '../server/tokens-manager-rankings.mjs';
import { createTokensManagerJobs } from '../server/tokens-manager-jobs.mjs';
import { createLeaderboardServer } from '../server/app.mjs';
import { runTokensManager } from '../src/tokens-manager.mjs';
import { scannerArchive } from '../src/tokens-manager-scan.mjs';

const at = Date.parse('2026-06-15T12:03:00Z');
const day = 86_400_000, hour = day / 24;
const entry = (id, daysAgo, tokens = 100) => ({
  id, completedAt: at - daysAgo * day, provider: 'codex', model: 'fixture', cwd: '/project',
  freshInputTokens: tokens, outputTokens: 200, tokensPerSecond: 30, isEstimatedSpeed: true
});

test('retains 32 days of detail and 370 days of rollups, including after a crash between database commits', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tps-manager-db-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const open = () => openTokensManagerDb(root, { timeZone: 'UTC', now: () => at });
  let db = open();
  assert.equal(db.setting('lastScanAt'), 0);
  const guid = db.deviceGuid;
  db.commitSource('fixture', 'one', [entry('today', 0), entry('boundary-in', 31), entry('boundary-out', 32),
    entry('oldest', 369), entry('too-old', 370), entry('today', 0)]);
  assert.throws(() => db.applyPending(() => { throw new Error('interrupted after commit'); }), /interrupted/);
  db.close();
  db = open();
  assert.equal(db.deviceGuid, guid);
  assert.equal(db.sourceStamp('fixture'), 'one');
  db.commitSource('mirror', 'one', [entry('today', 0), entry('oldest', 369)]);
  db.finishScan(at);
  assert.deepEqual(db.details().map(x => x.id), ['today', 'boundary-in']);
  assert.equal(db.buckets(0).length, 4);
  assert.ok(db.buckets(0).every(row => row.counters[0] === 1));
  const packet = makePersonalPacket(db, at);
  const second = { ...packet, deviceGuid: randomUUID() };
  const summary = mergePersonalPackets([packet, { ...packet, publishedAt: at - 1, days: [] }, second], 'UTC', at);
  assert.equal(summary.windows.today.tokens, 600);
  assert.equal(summary.windows.today.maxSpeed.tokensPerSecond, 30);
  assert.equal(summary.hourly.windows.month.tokens, 0);
  assert.equal(summary.hourly.windows.past365.tokens, 1200);
  assert.equal(mergePersonalPackets([packet], 'Asia/Seoul', at), null);
  assert.equal(db.setTimeZone('Asia/Seoul'), true);
  assert.equal(db.deviceGuid, guid);
  assert.equal(db.setting('lastScanAt'), 0);
  assert.equal(db.buckets(0).length, 0);
  assert.equal(db.sourceStamp('fixture'), undefined);
  db.close();
  assert.equal(calendarFor('Asia/Seoul').day(Date.parse('2026-06-15T15:01:00Z')), '2026-06-16');
});

function packet(guid, tokens, publishedAt = at) {
  return { deviceGuid: guid, accountId: 11, publishedAt, hours: [[Date.parse('2026-06-15T11:00:00Z'), tokens]],
    daily: [['2026-06-15', tokens]], samples: [] };
}

test('combines three devices, keeps original timestamps on relay, and expires received packets at ten seconds', () => {
  const rankings = createTokensRankings();
  const account = { id: 11, username: 'player' };
  const [a, b, c] = Array.from({ length: 3 }, () => randomUUID());
  const send = (packet, time) => rankings.receive(account, validatePacket(JSON.stringify(packet), account.id, time, 1e6), time);
  send(packet(a, 10), at);
  send(packet(b, 20), at);
  send(packet(c, 30), at);
  send(packet(b, 20), at + 100);
  send(packet(b, 7, at - 1000), at + 100);
  const publish = time => rankings.publish(time, TOKENS_DEFAULT_INTERVALS);
  const first = publish(at + 100);
  assert.equal(first.boards[24].rows[0].tokens, 60);
  assert.equal(first.boards[24].rows.length, 1);
  assert.equal(first.boards[168].rows[0].daily.some(row => row.tokens === 60), true);
  send(packet(b, 20), at + 5000);
  assert.equal(publish(at + 10_000).boards[24].rows[0].tokens, 20);
  assert.deepEqual(publish(at + 15_000).boards[24].rows, []);
  assert.equal(validatePacket(JSON.stringify(packet(a, 10)), 12, at, 1e6), null);
});

test('publishes one shared HTTP snapshot after authenticated uploads through receiving workers', async t => {
  const token = randomBytes(32).toString('base64url');
  const store = { prune() {}, pruneRecent() {}, session() { return { id: 11, username: 'player' }; } };
  const jobs = createTokensManagerJobs({ maxTokens: 1e6, now: () => at, intervals: { publishMs: 1000 }, log() {} });
  const server = createLeaderboardServer({ tokensJobs: jobs, store, baseUrl: 'http://localhost', now: () => at });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await jobs.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/api/tokens-manager`;
  const config = await fetch(base + '/config').then(res => res.json());
  assert.equal(config.intervals.scanMs, 5000);
  assert.equal(config.intervals.publishMs, 1000);
  const upload = body => fetch(base + '/packets', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
  const guid = randomUUID();
  const responses = await Promise.all([upload(packet(guid, 100)), upload(packet(guid, 100)), upload(packet(randomUUID(), 400))]);
  assert.deepEqual(responses.map(res => res.status), [202, 202, 202]);
  let snapshot;
  for (let attempt = 0; attempt < 40; attempt++) {
    snapshot = await fetch(base + '/snapshot').then(res => res.json());
    if (snapshot.boards?.[24]?.rows.length) break;
    await setTimeout(80);
  }
  assert.equal(snapshot.boards[24].rows[0].tokens, 500);
  const second = await fetch(base + '/snapshot').then(res => res.json());
  assert.deepEqual(second, snapshot);
  const anonymous = await fetch(base + '/packets', { method: 'POST', body: JSON.stringify(packet(guid, 100)) });
  assert.equal(anonymous.status, 401);
});

test('uses one process, waits for the first scan and keeps its lease across a short disconnect', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tps-manager-process-'));
  let allowScan;
  const waitForScan = new Promise(resolve => { allowScan = resolve; });
  let allowClosingScan, startedClosingScan;
  const closingScan = new Promise(resolve => { allowClosingScan = resolve; });
  const closingStarted = new Promise(resolve => { startedClosingScan = resolve; });
  let scans = 0;
  let clock = at;
  let stopped = false;
  const processJob = runTokensManager(root, { clock: () => clock,
    fetcher: async () => Response.json({ code: 'accepted' }), async scan(root, db, { progress }) {
    progress({ done: 0, total: 1 });
    if (++scans === 2) {
      startedClosingScan();
      await closingScan;
    }
    await waitForScan;
    db.commitSource('fixture', 'one', [entry('today', 0)], at);
    db.finishScan(at);
  } }).finally(() => { stopped = true; });
  const peers = new Set();
  t.after(async () => {
    for (const peer of peers) peer.stop();
    allowScan();
    allowClosingScan();
    clock += 60_000;
    await processJob;
    await rm(root, { recursive: true, force: true });
  });
  function subscribe() {
    const child = spawn(process.execPath, ['src/tokens-manager.mjs', '--connect'],
      { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, ORCA_TPS_TOKENS_ROOT: root } });
    const events = [];
    const reader = createInterface({ input: child.stdout });
    reader.on('line', line => events.push(JSON.parse(line)));
    const send = input => child.stdin.write(JSON.stringify(input) + '\n');
    const stop = () => child.stdin.end();
    async function event(type) {
      for (let i = 0; i < 200; i++) {
        const value = events.find(item => item.type === type);
        if (value) return value;
        await setTimeout(10);
      }
      throw new Error(`No manager event: ${type}`);
    }
    const exit = new Promise(resolve => child.once('exit', resolve));
    const peer = { events, event, stop, send, exit };
    peers.add(peer);
    send({ type: 'hello', timeZone: 'UTC' });
    return peer;
  }
  const a = subscribe(), b = subscribe();
  const first = await a.event('ready');
  assert.equal((await b.event('ready')).deviceGuid, first.deviceGuid);
  await runTokensManager(root, { scan: () => assert.fail('second process acquired the socket') });
  await a.event('progress');
  assert.equal(a.events.some(event => event.type === 'personal'), false);
  allowScan();
  assert.equal((await a.event('personal')).packet.days[0].counters[0], 1);
  await b.event('personal');
  a.send({ type: 'credential', endpoint: 'http://localhost', accountId: 11, token: randomBytes(32).toString('base64url') });
  assert.equal((await a.event('leaderboard')).packet.accountId, 11);
  assert.equal(b.events.some(event => event.type === 'leaderboard'), false);
  a.send({ type: 'unsubscribe' });
  a.stop();
  b.stop();
  clock += 4000;
  const c = subscribe();
  assert.equal((await c.event('ready')).deviceGuid, first.deviceGuid);
  assert.equal(stopped, false);
  await c.event('personal');
  clock += 12_000;
  c.send({ type: 'heartbeat' });
  await c.event('heartbeat');
  await closingStarted;
  c.send({ type: 'unsubscribe' });
  c.stop();
  await c.exit;
  const duringShutdown = subscribe();
  await duringShutdown.exit;
  assert.equal(duringShutdown.events.some(event => event.type === 'ready'), false);
  allowClosingScan();
  await processJob;
  assert.equal(stopped, true);
});

test('scans real Copilot, WorkBuddy and Hermes fixtures and ignores a broken log entry', async t => {
  try { await access(scannerArchive); } catch { return t.skip('No bundled scanner for this platform'); }
  const root = await mkdtemp(path.join(tmpdir(), 'tps-manager-native-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const copilot = path.join(root, 'copilot'), workbuddy = path.join(root, 'workbuddy'), hermes = path.join(root, 'hermes');
  const session = path.join(copilot, 'session-state', 'session1'), project = path.join(workbuddy, 'projects', 'project1');
  const logs = path.join(hermes, 'logs');
  for (const dir of [session, project, logs]) await mkdir(dir, { recursive: true });
  const at = Date.now() - 3000, time = new Date(at).toISOString();
  const line = object => JSON.stringify(object) + '\n';
  await writeFile(path.join(session, 'events.jsonl'), '{broken}\n' + line({
    type: 'session.usage_record', id: 'fixture-1', timestamp: time,
    data: { usage: { model: 'test-copilot', inputTokens: 110, outputTokens: 85, cacheReadTokens: 10 } }
  }));
  await writeFile(path.join(project, 'session1.jsonl'), line({
    id: 'fixture-user', timestamp: at - 1000, type: 'message', role: 'user', sessionId: 'session1', cwd: project,
    content: [{ type: 'input_text', text: 'fixture' }]
  }) + line({
    id: 'fixture-2', timestamp: at, type: 'message', role: 'assistant', status: 'completed', sessionId: 'session1', cwd: project,
    content: [{ type: 'output_text', text: 'fixture' }],
    providerData: { model: 'test-workbuddy', rawUsage: { prompt_tokens: 108, completion_tokens: 14, total_tokens: 122 } }
  }));
  await writeFile(path.join(logs, 'agent.log'),
    `${time.slice(0, 23).replace('T', ' ').replace('.', ',')} INFO [local-hermes] agent.conversation_loop: API call #1: model=test-hermes provider=example in=50 out=56 total=106 latency=3.3s id=fixture-3\n`);
  const script = `
    import { mkdir } from 'node:fs/promises';
    import { openTokensManagerDb } from './src/tokens-manager-db.mjs';
    import { scanTokens } from './src/tokens-manager-scan.mjs';
    const root = process.env.TPS_FIXTURE_DB;
    await mkdir(root + '/bin', { recursive: true });
    const db = openTokensManagerDb(root, { timeZone: 'UTC' });
    await scanTokens(root, db);
    await scanTokens(root, db);
    const read = () => db.details().map(({provider, cwd}) => [provider, cwd]).sort();
    const original = read();
    db.setTimeZone('Asia/Seoul');
    await scanTokens(root, db);
    console.log(JSON.stringify([original, read()]));
    db.close();
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    timeout: 20_000,
    env: { ...process.env, HOME: root, USERPROFILE: root, ORCA_USER_DATA_PATH: root,
      CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
      XDG_DATA_HOME: path.join(root, 'data'), COPILOT_HOME: copilot, WORKBUDDY_CONFIG_DIR: workbuddy,
      HERMES_HOME: hermes, TZ: 'UTC', TPS_FIXTURE_DB: path.join(root, 'manager') }
  });
  const [rows, rebuilt] = JSON.parse(stdout);
  assert.deepEqual(rebuilt, rows);
  assert.deepEqual(rows.map(([provider]) => provider), ['copilot', 'hermes', 'workbuddy']);
  assert.equal(rows.find(([provider]) => provider === 'workbuddy')[1], project);
});

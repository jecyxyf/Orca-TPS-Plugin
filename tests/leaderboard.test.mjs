import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createLeaderboardServer } from '../server/app.mjs';
import { createTokensRankings } from '../server/tokens-manager-rankings.mjs';
import { createTokensManagerJobs } from '../server/tokens-manager-jobs.mjs';
import { TOKENS_DEFAULT_INTERVALS } from '../src/leaderboard_stats.mjs';
import { openLeaderboardStore } from '../server/store.mjs';
import { openLocalUsageDb } from '../src/local-usage-db.mjs';
import { startLeaderboard } from '../src/leaderboard.mjs';
import { createSubmissionStats } from '../src/submission-stats.mjs';
import { createSqliteUploadStorage, uploadUsageChanges } from '../src/usage-upload.mjs';
import { createHourlySourceUploader } from '../src/hourly-source-upload.mjs';
import { createWindowViews } from '../src/leaderboard-windows.mjs';
import { HOUR_MS, USAGE_UPLOAD_BYTES, hourStart } from '../src/leaderboard_stats.mjs';
import { createAvatarCache } from '../src/leaderboard-avatars.mjs';
import { discoverUsageUnits } from '../src/harness_parser.mjs';
import { createUsageIndex, leaderboardDay, leaderboardDayStart } from '../src/usage-summary.mjs';

const ORIGIN = 'http://127.0.0.1:8787';
const TODAY = '2026-11-18';
const START = leaderboardDayStart(TODAY);
const SESSION_SECRET = 'leaderboard-session';
const savedToken = secrets => JSON.parse(secrets.get(SESSION_SECRET) ?? '{}').token;

async function fixture(t, names = ['alice', 'bob'], { workers = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'tps-board-test-'));
  const store = openLeaderboardStore(path.join(directory, 'leaderboard.bin'));
  const rankings = createTokensRankings();
  let clock = START + 3600_000, count = 0;
  const jobs = workers && createTokensManagerJobs({ maxTokens: 1_000_000, now: () => clock, intervals: { publishMs: 1000 },
    flushMs: 100, log: message => t.diagnostic(message) });
  const devices = new Map();
  const users = { alice: 1, bob: 2, admin: 3, visitor: 4 };
  async function mockGitHub(url, options) {
    const route = new URL(url).pathname;
    let data;
    if (route === '/login/device/code') {
      const device_code = String(++count);
      devices.set(device_code, names.shift());
      data = { device_code, user_code: 'ORCA-' + device_code.padStart(4, '0'), expires_in: 900, interval: 1 };
    } else if (route === '/login/oauth/access_token') {
      const user = options.body.get('code') || devices.get(options.body.get('device_code'));
      data = users[user] ? { access_token: user } : { error: 'authorization_pending' };
    } else if (route === '/user') {
      const name = options.headers.Authorization.slice(7);
      data = { login: name, id: users[name] };
    } else if (route === '/user/emails') {
      data = [{ email: 'staff@example.test', verified: options.headers.Authorization === 'Bearer admin' }];
    } else {
      throw new Error('Unexpected GitHub route: ' + route);
    }
    return Response.json(data);
  }
  const server = createLeaderboardServer({
    store, baseUrl: ORIGIN, clientId: 'example-client', clientSecret: 'example-secret',
    tokensJobs: jobs || { intervals: TOKENS_DEFAULT_INTERVALS, snapshot: () => rankings.publish([], clock, TOKENS_DEFAULT_INTERVALS) },
    adminEmail: 'staff@example.test', maxTokens: 1_000_000, fetcher: mockGitHub, now: () => clock,
    log: message => t.diagnostic(message)
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    if (jobs) await jobs.close();
    await rm(directory, { force: true, recursive: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const endpoint = 'http://127.0.0.1:' + server.address().port;
  const call = (route, options) => fetch(endpoint + route, { redirect: 'manual', ...options });
  const advance = ms => { clock += ms; };
  const bearer = token => ({ Authorization: 'Bearer ' + token });
  const get = (token, route = '/api/tokens-manager/account') => call(route, { headers: bearer(token) });
  const post = (route, body, headers = {}) => call(route, {
    method: 'POST', body: JSON.stringify(body), headers: { ...headers, 'Content-Type': 'application/json' }
  });

  async function login() {
    const challenge = await (await post('/api/auth/device/start', {})).json();
    const poll = () => post('/api/auth/device/poll', { ticket: challenge.ticket });
    assert.equal((await poll()).status, 202);
    advance(1001);
    const response = await poll();
    assert.equal(response.status, 200);
    return (await response.json()).token;
  }
  async function websiteLogin(githubName) {
    const start = await call('/auth/github/start');
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const cookie = start.headers.getSetCookie()[0].split(';')[0];
    const complete = await call('/auth/github/callback?' + new URLSearchParams({ code: githubName, state }), { headers: { cookie } });
    return {
      redirect: complete.headers.get('location'),
      cookie: complete.headers.getSetCookie().find(value => value.startsWith('orca_admin='))?.split(';')[0]
    };
  }
  async function authorizePlugin(link, githubName) {
    const linkUrl = new URL(link);
    assert.equal(linkUrl.origin, endpoint);
    const start = await call(linkUrl.pathname + linkUrl.search);
    assert.equal(start.status, 303);
    const target = new URL(start.headers.get('location'));
    assert.equal(target.origin, 'https://github.com');
    assert.equal(target.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(target.searchParams.get('redirect_uri'), ORIGIN + '/auth/github/callback');
    const cookie = start.headers.getSetCookie()[0].split(';')[0];
    const callback = '/auth/github/callback?' + new URLSearchParams({ code: githubName, state: target.searchParams.get('state') });
    assert.equal((await call(callback)).status, 400);
    const result = await call(callback, { headers: { cookie } });
    assert.equal(result.status, 200);
    assert.match(await result.text(), /GitHub 授权成功/);
    const wrongPoll = await post('/api/auth/plugin/poll', { verifier: 'A'.repeat(43) });
    assert.equal(wrongPoll.status, 202);
    assert.equal((await wrongPoll.json()).token, undefined);
  }
  const form = (route, cookie, fields, origin = ORIGIN) => call(route, {
    method: 'POST', headers: { cookie, origin }, body: new URLSearchParams(fields)
  });
  return { call, advance, login, get, websiteLogin, authorizePlugin, form, endpoint, clock: () => clock };
}

const managerClient = () => ({
  lastUploaded() {}, uploadStatus() {}, setCredential() {}, upload: () => true
});

test('administrator binding, bans and logout use the current accounts and upload routes', async t => {
  const api = await fixture(t, ['alice'], { workers: true });
  const token = await api.login();
  assert.equal((await api.websiteLogin('visitor')).redirect, '/admin?feedback=forbidden');
  const { cookie, redirect } = await api.websiteLogin('admin');
  assert.equal(redirect, '/admin');
  assert.ok(cookie);
  const board = await api.call('/admin?q=ALICE', { headers: { cookie } });
  const page = await board.text();
  assert.match(page, /alice/);
  assert.match(page, /action="\/admin\/ban"/);
  assert.doesNotMatch(page, /action="\/admin\/clear"/);
  const headers = { Authorization: 'Bearer ' + token };
  const route = '/api/tokens-manager';
  const packet = { accountId: 1, deviceGuid: randomUUID(), publishedAt: api.clock(), timeZone: 'Asia/Shanghai',
    hours: [[START, 100]], daily: [[TODAY, 100]], samples: [] };
  assert.equal((await api.call(route + '/packets', { method: 'POST', headers, body: JSON.stringify(packet) })).status, 202);
  async function waitForRows(total) {
    for (let attempts = 0; attempts < 40; attempts++) {
      const response = await api.call(route + '/snapshot');
      if (response.ok && (await response.json()).boards[24].rows.length === total) return;
      await delay(100);
    }
    assert.fail('expected account to appear or disappear from the published results');
  }
  await waitForRows(1);
  assert.equal((await api.form('/admin/ban', cookie, { account: 1, ban: 1, reason: 'test' }, 'https://example.test')).status, 403);
  const ban = await api.form('/admin/ban', cookie, { account: 1, ban: 1, reason: '<reason>' });
  assert.match(ban.headers.get('location'), /feedback=updated/);
  await waitForRows(0);
  assert.deepEqual(await (await api.get(token)).json(), { accountId: 1, username: 'alice', banned: true });
  assert.match(await (await api.call('/admin', { headers: { cookie } })).text(), /&lt;reason&gt;/);
  const rejected = await api.call('/api/tokens-manager/packets', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: '{}' });
  assert.equal(rejected.status, 403);
  assert.equal((await api.call('/api/leaderboard/snapshot')).status, 404);
  assert.match((await api.form('/admin/ban', cookie, { account: 1, ban: 0 })).headers.get('location'), /feedback=updated/);
  assert.equal((await (await api.get(token)).json()).banned, false);
  assert.equal((await api.call(route + '/snapshot?mode=calendar').then(response => response.json())).boards[24].rows.length, 0);
  assert.equal((await api.call(route + '/packets', { method: 'POST', headers, body: JSON.stringify(packet) })).status, 202);
  await waitForRows(1);
  assert.equal((await api.form('/admin/logout', cookie, {})).status, 303);
  assert.match(await (await api.call('/admin', { headers: { cookie } })).text(), /用 GitHub 登录/);
});

test('rate limits use the visitor IP only when the connection comes from a trusted proxy', async t => {
  const store = {};
  const proxyIp = '172.18.0.1';
  const server = createLeaderboardServer({ store, baseUrl: ORIGIN, now: () => START, trustedProxyIps: [proxyIp] });
  const request = (remoteAddress, forwardedIp) => new Promise(resolve => {
    let status;
    server.emit('request', { method: 'GET', url: '/healthz', socket: { remoteAddress },
      headers: { 'x-real-ip': forwardedIp } }, {
      setHeader() {},
      writeHead(code) { status = code; },
      end() { resolve(status); }
    });
  });

  for (let i = 0; i < 240; i++) assert.equal(await request(proxyIp, '2001:db8::1'), 200);
  assert.equal(await request(proxyIp, '2001:0DB8:0:0:0:0:0:1'), 429, 'equivalent spellings share a limit');
  assert.equal(await request(proxyIp, '192.0.2.10'), 200, 'another visitor on the same proxy has a separate limit');
  assert.equal(await request('::ffff:172.18.0.1', '2001:db8::1'), 429, 'a mapped proxy address uses the same visitor limit');
  assert.equal(await request('::ffff:127.0.0.1', '2001:db8::1'), 429, 'loopback proxies still use the visitor limit');

  for (let i = 0; i < 240; i++) assert.equal(await request('172.18.0.2', '192.0.2.11'), 200);
  assert.equal(await request('172.18.0.2', '192.0.2.12'), 429, 'an untrusted visitor cannot reset the limit with a header');

  for (let i = 0; i < 240; i++) assert.equal(await request(proxyIp), 200);
  assert.equal(await request(proxyIp, '192.0.2.11, 192.0.2.12'), 429, 'a list of addresses falls back to the peer limit');
  assert.throws(() => createLeaderboardServer({ store, baseUrl: ORIGIN, trustedProxyIps: ['172.18.0.0/16'] }),
    /LEADERBOARD_TRUSTED_PROXY_IPS/);
});

test('rolling uploader retries the same bounded payload and marks coverage after the last batch', async () => {
  const saved = new Map(), sent = [];
  const now = START + 12 * HOUR_MS;
  const coverage = [now - 720 * HOUR_MS, now];
  const buckets = Array.from({ length: 4300 }, (_, i) => [now - i * 1000, 999_000]);
  const opts = { storage: { get: async key => saved.get(key), set: async (key, value) => saved.set(key, value) },
    identity: 'test-account', installationId: randomUUID(), now, readUsageTimes: async () => ({ buckets, coverage }),
    send: async packet => {
      sent.push(JSON.parse(JSON.stringify(packet)));
      return sent.length === 1 ? { code: 'unavailable' } : { code: 'accepted', version: packet.body.version };
    }, active: () => true };
  assert.equal(await uploadUsageChanges(opts), 'unavailable');
  assert.equal(await uploadUsageChanges(opts), 'accepted');
  assert.deepEqual(sent[0], sent[1]);
  for (let i = 0; i < 5; i++) await uploadUsageChanges(opts);
  assert.equal(sent.slice(1).flatMap(packet => packet.body.buckets).length, buckets.length);
  assert.ok(sent.every(packet => Buffer.byteLength(JSON.stringify(packet.body)) <= USAGE_UPLOAD_BYTES));
  assert.ok(sent.slice(0, -1).every(packet => packet.body.coverage === undefined));
  assert.deepEqual(sent.at(-1).body.coverage, coverage);
});

test('a large legacy rolling receipt resumes after a lost response and an interrupted local save', async () => {
  const now = START + 12 * HOUR_MS, coverage = [now - 720 * HOUR_MS, now];
  const buckets = Array.from({ length: 32_000 }, (_, index) => {
    const hash = createHash('sha256').update(String(index)).digest();
    return [now - 1 - index * 65_000 - hash.readUInt16BE(0) % 1000, hash.readUInt32BE(2) + 1];
  });
  const saved = new Map(), sent = [], limit = 256 * 1024;
  const identity = 'existing-account';
  const key = 'leaderboard:rolling-upload:' + createHash('sha256').update(identity).digest('hex').slice(0, 24);
  const encode = state => gzipSync(JSON.stringify(state)).toString('base64');
  const acknowledged = buckets.slice(0, 10_000);
  const initial = encode({ version: now - 1, acknowledged, coverage: null, pending: null });
  assert.ok(Buffer.byteLength(JSON.stringify(initial)) < limit);
  assert.ok(Buffer.byteLength(JSON.stringify(encode({ acknowledged: buckets }))) > limit);
  saved.set(key, initial);
  let publishError;
  const storage = {
    get: async name => saved.get(name),
    set: async (name, value) => {
      if (Buffer.byteLength(JSON.stringify(value)) > limit) throw new Error('storage value limit');
      if (name === key && publishError === 'before') {
        publishError = undefined;
        throw new Error('interrupted receipt save');
      }
      saved.set(name, value);
      if (name === key && publishError === 'after') {
        publishError = undefined;
        throw new Error('receipt saved without a response');
      }
    },
    delete: async name => saved.delete(name)
  };
  const installationId = randomUUID();
  const sync = () => uploadUsageChanges({ storage, identity, installationId, now, active: () => true,
    readUsageTimes: async () => ({ buckets, coverage }),
    send: async packet => {
      sent.push(packet);
      if (sent.length === 1) return { code: 'unavailable' };
      if (sent.length === 2) publishError = 'before';
      if (sent.length === 3) publishError = 'after';
      return { code: 'accepted', version: packet.body.version };
    } });
  assert.equal(await sync(), 'unavailable');
  const previousHead = saved.get(key);
  const previousKeyCount = saved.size;
  await assert.rejects(sync(), /interrupted receipt save/);
  assert.deepEqual(saved.get(key), previousHead);
  assert.equal(saved.size, previousKeyCount);
  for (let attempts = 0; attempts < 20 && await sync() === 'accepted'; attempts++) { /* Drain all pending batches. */ }
  assert.deepEqual(sent[1], sent[0]);
  assert.deepEqual(sent[2], sent[0]);
  assert.deepEqual(sent.slice(2).flatMap(packet => packet.body.buckets), buckets.slice(acknowledged.length));
  assert.deepEqual(sent.at(-1).body.coverage, coverage);
  assert.equal(await sync(), undefined);
  assert.ok(saved.get(key).chunks > 1);
  assert.equal(saved.size, saved.get(key).chunks + 1);
});

test('the format 4 uploader keeps failed packets and their clock values across a restart', async t => {
  const local = openLocalUsageDb(':memory:');
  t.after(() => local.close());
  const reporter = randomUUID();
  const upload = createHourlySourceUploader(createSqliteUploadStorage(local.queue,
    { origin: ORIGIN, accountId: 1 }, 'pending-hourly'), reporter, () => 'alice');
  const at = START + 10_000, hour = hourStart(at);
  const read = async () => [{ sourceId: reporter, hours: [{ hour, tokens: 700, updatedAt: at, coveredUntil: at }] }];
  let sent;
  const first = await upload({ now: at, active: () => true, read, send: async body => {
    sent = body;
    return { code: 'unavailable' };
  } });
  assert.equal(first.code, 'unavailable');
  const restart = createHourlySourceUploader(createSqliteUploadStorage(local.queue,
    { origin: ORIGIN, accountId: 1 }, 'pending-hourly'), reporter, () => 'alice');
  const replay = await restart({ now: at + 11_000, active: () => true, read, send: async body => {
    assert.deepEqual(body, sent);
    return { code: 'accepted', tokens: body.data.hours[0].tokens };
  } });
  assert.equal(replay.code, 'accepted');
  assert.equal(replay.tokens, 700);
  assert.equal(local.queue.next({ origin: ORIGIN, accountId: 1 }, 'pending-hourly'), undefined);
});

test('viewer receives every rolling window and the speed board in one download and retains it on failure', async t => {
  const { call, advance, clock } = await fixture(t);
  const requests = [];
  const storage = { get: async () => null, set: async () => {} };
  let offline = false;
  const viewer = createWindowViews({ storage, manager: true, origin: ORIGIN, now: clock, request: async route => {
    requests.push(route);
    if (offline) return { code: 'unavailable' };
    return (await call(route)).json();
  } });
  const signal = new AbortController().signal;
  const first = await viewer.fetch(24, false, signal);
  assert.deepEqual(Object.keys(first.boards).map(Number), [0, 24, 168, 720]);
  assert.equal((await viewer.fetch(168, false, signal)).cutoffAt, first.cutoffAt);
  assert.equal((await viewer.fetch(720, false, signal)).cutoffAt, first.cutoffAt);
  advance(TOKENS_DEFAULT_INTERVALS.readMs - 1);
  assert.equal((await viewer.fetch(24, false, signal)).cutoffAt, first.cutoffAt);
  assert.equal(requests.length, 1);
  advance(1);
  offline = true;
  assert.equal((await viewer.fetch(24, false, signal)).code, 'unavailable');
  assert.deepEqual((await viewer.load(24, signal)).boards, first.boards);
  offline = false;
  const second = await viewer.fetch(24, false, signal);
  assert.equal(second.cutoffAt, first.cutoffAt);
  assert.ok(second.updatedAt > first.updatedAt);
  assert.deepEqual(requests, Array(3).fill('/api/tokens-manager/snapshot'));
});

test('calendar viewer requests its own snapshot and keeps the two modes in separate caches', async t => {
  const { call, clock } = await fixture(t);
  const saved = new Map();
  const storage = { get: async key => saved.get(key), set: async (key, value) => saved.set(key, value) };
  const options = { storage, manager: true, origin: ORIGIN, now: clock, request: async route => (await call(route)).json() };
  const signal = new AbortController().signal;
  const hourly = await createWindowViews(options).fetch(24, false, signal);
  const dateOptions = { ...options, mode: 'calendar' };
  const calendar = await createWindowViews(dateOptions).fetch(24, false, signal);
  assert.equal(hourly.boards[24].windowStart, clock() - 24 * HOUR_MS);
  assert.equal(calendar.boards[24].windowStart, START);
  assert.equal(calendar.boards[720].windowStart, START - 29 * 24 * HOUR_MS);
  assert.deepEqual(await createWindowViews(options).load(24, signal), hourly);
  assert.deepEqual(await createWindowViews(dateOptions).load(24, signal), calendar);
  assert.deepEqual(await createWindowViews({ ...dateOptions, request: async () => (await call('/api/tokens-manager/snapshot')).json() })
    .fetch(24, true, signal), { code: 'server_update_required' });
});

test('viewer replaces invalid recent samples with zero in downloaded and cached rankings', async () => {
  const at = START + HOUR_MS;
  const snapshot = createTokensRankings().publish([], at, TOKENS_DEFAULT_INTERVALS);
  const row = { tokens: 5000, complete: true, submittedAt: at, lastUploadAt: at };
  snapshot.boards[24].rows = [
    { ...row, rank: 1, username: 'alice', recent: { topModel: 'model', points: [
      { submittedAt: at - 1000, deltaTokens: -5, avgTps: 12 },
      { submittedAt: at - 3000, deltaTokens: 200, avgTps: 30 },
      { submittedAt: at - 2000, deltaTokens: 50 },
      { submittedAt: at - 4000, avgTps: -5 },
      { deltaTokens: 200, avgTps: 30 }
    ] } },
    { ...row, rank: 2, username: 'bob' }
  ];
  const storage = {
    get: async () => gzipSync(JSON.stringify({ ...snapshot, origin: ORIGIN, updatedAt: at })).toString('base64'),
    set: async () => {}
  };
  const launch = () => createWindowViews({ storage, manager: true, origin: ORIGIN, now: () => at,
    request: async () => snapshot });
  const signal = new AbortController().signal;
  const downloaded = await launch().fetch(24, true, signal);
  const cached = await launch().load(24, signal);
  const expected = [
    { ...row, rank: 1, username: 'alice', recent: { topModel: 'model', topCli: null, points: [
      { submittedAt: at - 4000, deltaTokens: 0, avgTps: 0 },
      { submittedAt: at - 3000, deltaTokens: 200, avgTps: 30 },
      { submittedAt: at - 2000, deltaTokens: 50, avgTps: 0 },
      { submittedAt: at - 1000, deltaTokens: 0, avgTps: 12 }
    ] } },
    { ...row, rank: 2, username: 'bob', recent: { topModel: null, topCli: null, points: [] } }
  ];
  assert.deepEqual(downloaded.rows, expected);
  assert.deepEqual(cached.rows, expected);
});

test('the client freezes its four statistics across restarts and credits only the confirmed batch', async () => {
  const values = new Map(), storage = { get: key => values.get(key), set: (key, value) => values.set(key, structuredClone(value)) };
  let time = START + 60_000;
  const now = () => time;
  let tracker = await createSubmissionStats(storage, now);
  const score = { day: TODAY, tokens: 8000, installationId: randomUUID() };
  const old = ['a'.repeat(24), time - 1, 10000, 90, 'old', 'pi'];
  time += 1000;
  const first = ['b'.repeat(24), time, 100, 20, 'alpha', 'pi'];
  const second = ['c'.repeat(24), time + 1000, 300, 60, 'beta', 'codex'];
  tracker.observe('local', [old, first, first]);
  const batch = await tracker.prepare('session-A', score);
  assert.deepEqual(batch.body.stats, { deltaTokens: 100, avgTps: 20, topModel: 'alpha', topCli: 'pi' });
  await tracker.settle(batch, 'unavailable');
  time += 1000;
  tracker = await createSubmissionStats(storage, now);
  tracker.observe('local', [old, first]);
  tracker.observe('ssh:host', [second]);
  assert.deepEqual(await tracker.prepare('session-A', { ...score, tokens: 8300 }), batch);
  await tracker.settle(batch, 'accepted');
  const next = await tracker.prepare('session-A', { ...score, tokens: 8300 });
  assert.deepEqual(next.body.stats, { deltaTokens: 300, avgTps: 40, topModel: 'beta', topCli: 'codex' });
});

test('the ranking switch blocks public reads while login and uploads stay available', async t => {
  const api = await fixture(t);
  const manager = managerClient();
  const enabledKey = 'leaderboard:ranking-enabled';
  const storage = new Map([[enabledKey, false]]), secrets = new Map(), handlers = new Map();
  const rankingReads = [];
  let nextRead;
  const orca = {
    storage: { get: async key => storage.get(key), set: async (key, value) => storage.set(key, value) },
    host: { has: () => true, call: async (method, { key, value }) => {
      if (method === 'secrets.get') return { value: secrets.get(key) };
      if (method === 'secrets.set') secrets.set(key, value);
    } },
    grantedCapabilities: ['secrets:own'],
    panels: { handle(name, handler) { handlers.set(name, handler); return { dispose() { handlers.delete(name); } }; } }
  };
  const launch = () => startLeaderboard(orca, {
    endpoint: api.endpoint, now: () => new Date(api.clock()), manager,
    readUsage: async () => ({ day: TODAY, tokens: 600, ready: true }),
    fetcher(url, options) {
      if (url.pathname === '/api/tokens-manager/snapshot') {
        rankingReads.push(url.pathname);
        if (nextRead) {
          const { started, reply } = nextRead;
          nextRead = undefined;
          started.resolve(options.signal);
          return reply.promise;
        }
      }
      return fetch(url, options);
    }
  });
  let stop = launch();
  t.after(() => stop());
  const run = (action, fields = {}) => handlers.get('tps.leaderboard')({ action, ...fields });
  const setEnabled = enabled => run('ranking-preference', { enabled });

  assert.deepEqual(await run('ranking-preference'), { enabled: false });
  assert.deepEqual(await run('window-state'), {});
  assert.deepEqual(await run('window-cache'), {});
  assert.deepEqual(rankingReads, []);
  assert.deepEqual(await setEnabled(true), { enabled: true, saved: true });
  const guest = await run('window-state');
  assert.deepEqual(guest.boards[24].rows, []);

  await setEnabled(false);
  const login = await run('login');
  await api.authorizePlugin(login.loginUrl, 'alice');
  const signedIn = await run('poll');
  assert.equal(signedIn.code, 'signed_in');
  assert.equal((await run('sync')).code, 'sync_queued');
  assert.equal(rankingReads.length, 1);

  await setEnabled(true);
  const blocked = { started: Promise.withResolvers(), reply: Promise.withResolvers() };
  nextRead = blocked;
  const old = run('window-state', { days: 7 });
  const signal = await blocked.started.promise;
  const queued = run('window-state', { days: 30 });
  assert.deepEqual(await setEnabled(false), { enabled: false, saved: true });
  assert.equal(signal.aborted, true);
  assert.deepEqual(await run('window-cache'), {});
  await setEnabled(true);
  const fresh = run('window-state', { days: 7, force: true });
  blocked.reply.resolve(await api.call('/api/tokens-manager/snapshot'));
  assert.deepEqual(await old, {});
  assert.deepEqual(await queued, {});
  assert.deepEqual((await fresh).boards[168].rows, []);
  assert.equal(rankingReads.length, 3);

  await setEnabled(false);
  stop();
  stop = launch();
  assert.deepEqual(await run('ranking-preference'), { enabled: false });
  assert.equal((await run('session')).signedIn, true);
  assert.deepEqual(await run('window-state'), {});
  assert.equal(rankingReads.length, 3);
});

test('avatar downloads are bounded and reject non-image or oversized replies', async () => {
  const release = Promise.withResolvers();
  const calls = [];
  let now = START;
  const cache = createAvatarCache({ now: () => now, async fetcher(url, options) {
    assert.equal(options.credentials, 'omit');
    if (url.hostname === 'github.com') {
      assert.equal(options.redirect, 'manual');
      const id = Number(/^\/player(\d+)\.png$/.exec(url.pathname)?.[1]);
      calls.push(id);
      await release.promise;
      return Response.redirect(`https://avatars.githubusercontent.com/u/${id}`, 302);
    }
    assert.equal(url.hostname, 'avatars.githubusercontent.com');
    assert.equal(options.redirect, 'error');
    const id = Number(url.pathname.split('/').at(-1));
    if (id === 4) return new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } });
    if (id === 5) return new Response(new Uint8Array(32 * 1024 + 1), { headers: { 'content-type': 'image/png' } });
    return new Response('avatar', { headers: { 'content-type': 'image/png' } });
  } });
  const requests = [1, 1, 2, 3, 4, 5].map(id => cache.get('player' + id));
  assert.deepEqual(calls, [1, 2, 3]);
  assert.equal(await cache.get('1/../2'), null);
  release.resolve();
  const image = 'data:image/png;base64,YXZhdGFy';
  assert.deepEqual(await Promise.all(requests), [image, image, image, image, null, null]);
  assert.deepEqual(calls, [1, 2, 3, 4, 5]);
  assert.equal(await cache.get('player4'), null);
  assert.deepEqual(calls, [1, 2, 3, 4, 5]);
  now += 9_999;
  assert.equal(await cache.get('player4'), null);
  assert.deepEqual(calls, [1, 2, 3, 4, 5], 'a failed avatar waits one sync interval');
  now += 1;
  assert.equal(await cache.get('player4'), null);
  assert.equal(await cache.get('player1'), image);
  assert.deepEqual(calls, [1, 2, 3, 4, 5, 4], 'a failed avatar is retried after one sync interval');
});

test('avatar lookup by GitHub login accepts only the expected image redirect', async () => {
  const calls = [];
  const cache = createAvatarCache({ async fetcher(url, options) {
    calls.push([url.href, options.redirect]);
    if (url.pathname === '/alice.png') return Response.redirect('https://avatars.githubusercontent.com/u/1?s=64', 302);
    if (url.pathname === '/bob.png') return Response.redirect('https://example.test/u/2', 302);
    return new Response('avatar', { headers: { 'content-type': 'image/png' } });
  } });
  const image = 'data:image/png;base64,YXZhdGFy';
  assert.equal(await cache.get('Alice'), image);
  assert.equal(await cache.get('alice'), image);
  assert.equal(await cache.get('bob'), null);
  assert.equal(await cache.get('alice/..'), null);
  assert.deepEqual(calls, [
    ['https://github.com/alice.png?size=64', 'manual'],
    ['https://avatars.githubusercontent.com/u/1?s=64', 'error'],
    ['https://github.com/bob.png?size=64', 'manual']
  ]);
});

test('logout prevents retrying or recording an earlier automatic submission', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let time = START, handler;
  const storage = new Map();
  const automaticStarted = Promise.withResolvers(), automaticResponse = Promise.withResolvers();
  const requests = [];
  const stop = startLeaderboard({
    grantedCapabilities: ['secrets:own'],
    host: { has: () => true, call: async () => ({ value: 'a'.repeat(43) }) },
    storage: { get: async key => storage.get(key), set: async (key, value) => storage.set(key, value) },
    panels: { handle: (_, fn) => { handler = fn; return { dispose() {} }; } }
  }, {
    endpoint: ORIGIN,
    now: () => new Date(time),
    readUsage: async () => ({ ready: true, day: TODAY, tokens: 1234 }),
    fetcher: async (url, options) => {
      if (url.pathname === '/api/auth/logout') return Response.json({ ok: true });
      requests.push({ path: url.pathname, body: JSON.parse(options.body) });
      if (requests.length === 1) return Response.json({ code: 'unavailable' }, { status: 503 });
      automaticStarted.resolve();
      return automaticResponse.promise;
    }
  });
  t.after(stop);
  const manual = await handler({ action: 'submit' });
  assert.equal(manual.code, 'unavailable');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/api/today/submit');
  assert.equal(requests[0].body.tokens, 1234);
  time += 10_000;
  t.mock.timers.tick(1000);
  await automaticStarted.promise;
  const cancelled = await handler({ action: 'logout' });
  assert.equal(cancelled.signedIn, false);
  assert.equal(cancelled.nextAutomaticAt, null);
  assert.equal(cancelled.uploadingKind, 'automatic');
  assert.equal(requests.length, 2);
  automaticResponse.resolve(Response.json({ code: 'unavailable' }, { status: 503 }));
  for (let tries = 0; tries < 25 && (await handler({ action: 'session' })).uploading; tries++) await delay(10);
  const finished = await handler({ action: 'session' });
  assert.equal(finished.uploadingKind, null);
  assert.equal(finished.lastUpload, null);
  assert.equal(finished.nextAutomaticAt, null);
  time += 60_000;
  t.mock.timers.tick(1000);
  await delay(10);
  assert.equal(requests.length, 2);
});

test('manual sync uses the shared cooldown, coalesces clicks, and keeps the last successful time', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let time = START, handler, uploads = 0, secrets = 'a'.repeat(43);
  const storage = new Map();
  const launch = () => startLeaderboard({
    grantedCapabilities: ['secrets:own'],
    host: { has: () => true, call: async (method, args) => {
      if (method === 'secrets.get') return { value: secrets };
      secrets = args.value;
    } },
    storage: { get: async key => storage.get(key), set: async (key, value) => storage.set(key, value) },
    panels: { handle: (_, fn) => { handler = fn; return { dispose() {} }; } }
  }, {
    endpoint: ORIGIN,
    now: () => new Date(time),
    readUsage: async () => ({ ready: true, day: TODAY, tokens: 1234 }),
    fetcher: async url => {
      if (url.pathname === '/api/auth/logout') return Response.json({ ok: true });
      assert.equal(url.pathname, '/api/today/submit');
      if (++uploads !== 1) return Response.json({ code: 'unavailable' }, { status: 503 });
      return Response.json({ code: 'accepted', day: TODAY, username: 'alice', tokens: 1234, submitted: true,
        submittedAt: time, nextUploadAt: time + 10_000 });
    }
  });
  let stop = launch();
  t.after(() => stop());
  const run = action => handler({ action });
  const immediate = await Promise.all([run('sync'), run('sync')]);
  assert.deepEqual(immediate.map(result => result.code).sort(), ['accepted', 'upload_in_progress']);
  assert.equal(immediate.find(result => result.code === 'accepted').lastSyncAt, START);
  assert.equal(uploads, 1);
  stop();
  stop = launch();
  assert.equal((await run('session')).lastSyncAt, START);

  time = START + 1_000;
  for (const result of await Promise.all([run('sync'), run('sync')])) {
    assert.equal(result.code, 'sync_queued');
    assert.equal(result.manualQueued, true);
    assert.equal(result.lastSyncAt, START);
  }
  time = START + 9_999;
  t.mock.timers.tick(1000);
  await delay(10);
  assert.equal(uploads, 1);
  time += 1;
  t.mock.timers.tick(1000);
  for (let tries = 0; tries < 25 && (await run('session')).lastUpload?.code !== 'unavailable'; tries++) await delay(5);
  const failed = await run('session');
  assert.equal(uploads, 2);
  assert.equal(failed.manualQueued, false);
  assert.deepEqual(failed.lastUpload, { kind: 'manual', code: 'unavailable', at: time });
  assert.equal(failed.lastSyncAt, START);

  assert.equal((await run('sync')).code, 'sync_queued', 'a failed request also starts the shared cooldown');
  assert.equal((await run('logout')).manualQueued, false);
  time += 20_000;
  t.mock.timers.tick(1000);
  await delay(10);
  assert.equal(uploads, 2);
});

test('a partial upload stays visible until the original rolling batch succeeds on its own', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let clock = START, handler;
  const token = 'a'.repeat(43);
  const account = { origin: ORIGIN, username: 'alice', session: createHash('sha256').update(token).digest('hex') };
  const storage = new Map([['leaderboard:account', account],
    ['leaderboard:history', { origin: ORIGIN, session: account.session }]]), requests = [];
  const stop = startLeaderboard({
    grantedCapabilities: ['secrets:own'],
    host: { has: () => true, call: async () => ({ value: JSON.stringify({ origin: ORIGIN, token }) }) },
    storage: { get: async key => storage.get(key), set: async (key, value) => storage.set(key, value) },
    panels: { handle: (_, fn) => { handler = fn; return { dispose() {} }; } }
  }, {
    endpoint: ORIGIN, now: () => new Date(clock),
    readUsage: async () => ({ day: TODAY, tokens: 1_234 }),
    readHistory: async () => ({ day: TODAY, ready: true, scores: [{ day: TODAY, tokens: 1_234 }] }),
    readUsageTimes: async () => ({ buckets: [[START - 1000, 1_234]] }),
    fetcher: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ route: url.pathname, body, requestId: options.headers['Idempotency-Key'] });
      if (url.pathname === '/api/leaderboard/uploads') return Response.json({
        daily: { code: 'accepted', day: TODAY, tokens: 1_234, username: 'alice', nextUploadAt: clock + 10_000 },
        rolling: { code: 'unavailable' }
      });
      assert.equal(url.pathname, '/api/leaderboard/rolling-data');
      return Response.json({ code: 'accepted', version: body.version });
    }
  });
  t.after(stop);

  const partial = await handler({ action: 'sync' });
  assert.equal(partial.code, 'rolling_upload_failed');
  assert.equal(partial.board.tokens, 1_234);
  assert.equal(partial.rollingProblem, 'unavailable');
  assert.equal(partial.lastSyncAt, null, 'the successful time only advances once both uploads finish');

  clock += 10_000;
  t.mock.timers.tick(1000);
  for (let tries = 0; tries < 25 && (await handler({ action: 'session' })).lastSyncAt !== clock; tries++) await delay(5);
  const repaired = await handler({ action: 'session' });
  assert.equal(repaired.rollingProblem, null);
  assert.equal(repaired.lastSyncAt, clock);
  assert.equal(repaired.initializing, true, 'the rolling retry takes priority over history initialization');
  assert.deepEqual(requests.map(item => item.route), ['/api/leaderboard/uploads', '/api/leaderboard/rolling-data']);
  assert.deepEqual(requests[1].body, requests[0].body.rolling.body);
  assert.equal(requests[1].requestId, requests[0].body.rolling.requestId);
});

test('the plugin shows the ranking while local usage is still loading', { timeout: 3000 }, async t => {
  let handle, finishUsage;
  const usage = new Promise(resolve => { finishUsage = resolve; });
  const stop = startLeaderboard({
    storage: { get: async () => undefined, set: async () => {} },
    panels: { handle: (_, callback) => { handle = callback; return { dispose() {} }; } }
  }, {
    now: () => new Date(START),
    readUsage: () => usage,
    fetcher: async () => Response.json({ day: TODAY, authenticated: false, rows: [] })
  });
  t.after(() => { finishUsage(); stop(); });
  const personal = handle({ action: 'usage' });
  assert.deepEqual((await handle({ action: 'state' })).board.rows, []);
  const local = { day: TODAY, ready: true, tokens: 123 };
  finishUsage(local);
  assert.deepEqual(await personal, { local });
});

test('manager transfer changes publish the upload state immediately', async t => {
  const api = await fixture(t);
  let handle, uploadListener, uploadStatus;
  const sessions = [];
  const stop = startLeaderboard({
    storage: { get: async () => undefined, set: async () => {} },
    panels: {
      handle: (_, callback) => { handle = callback; return { dispose() {} }; },
      post(name, state) { if (name === 'tps.leaderboard.session') sessions.push(state); }
    }
  }, {
    endpoint: api.endpoint,
    now: () => new Date(api.clock()),
    readUsage: async () => undefined,
    manager: {
      ...managerClient(),
      uploadStatus: () => uploadStatus,
      onUploadState(listener) {
        uploadListener = listener;
        return () => { uploadListener = undefined; };
      }
    }
  });
  t.after(stop);
  const login = await handle({ action: 'login' });
  await api.authorizePlugin(login.loginUrl, 'alice');
  assert.equal((await handle({ action: 'poll' })).code, 'signed_in');

  uploadStatus = { pending: true };
  uploadListener();
  assert.equal(sessions.at(-1).uploading, true);
  uploadStatus = { pending: false, code: 'unavailable', at: api.clock() };
  uploadListener();
  assert.equal(sessions.at(-1).uploading, false);
  assert.equal(sessions.at(-1).lastUpload.code, 'unavailable');
  await stop();
  assert.equal(uploadListener, undefined);
});

test('login retries a lost authorization response and logout does not wait for the network', { timeout: 8000 }, async t => {
  const api = await fixture(t);
  let handle, verifier, receivedToken, releaseRanking, releaseLogout, rankingStarted, ackReceived;
  let rankCalls = 0, dropped = false;
  const heldRanking = new Promise(resolve => { releaseRanking = resolve; });
  const heldLogout = new Promise(resolve => { releaseLogout = resolve; });
  const started = new Promise(resolve => { rankingStarted = resolve; });
  const acknowledged = new Promise(resolve => { ackReceived = resolve; });
  const stop = startLeaderboard({
    storage: { get: async () => undefined, set: async () => {} },
    panels: { handle: (_, callback) => { handle = callback; return { dispose() {} }; } }
  }, {
    endpoint: api.endpoint, now: () => new Date(api.clock()), readUsage: async () => undefined, manager: managerClient(),
    async fetcher(url, options) {
      if (url.pathname === '/api/tokens-manager/snapshot') {
        rankCalls++;
        const board = await fetch(url, options);
        rankingStarted();
        await heldRanking;
        return board;
      }
      if (url.pathname === '/api/auth/logout') await heldLogout;
      const result = await fetch(url, options);
      if (url.pathname === '/api/auth/plugin/poll') {
        const input = JSON.parse(options.body);
        if (input.received) ackReceived();
        else if (result.ok && result.status === 200 && !dropped) {
          dropped = true;
          verifier = input.verifier;
          receivedToken = (await result.json()).token;
          throw new Error('The authorization response was lost');
        }
      }
      return result;
    }
  });
  t.after(() => { releaseRanking(); releaseLogout(); stop(); });
  const run = action => handle({ action });
  const firstLogin = await run('login');
  await api.authorizePlugin(firstLogin.loginUrl, 'alice');
  assert.equal((await run('poll')).code, 'unavailable');
  const signedIn = await run('poll');
  assert.equal(signedIn.code, 'signed_in');
  assert.equal(signedIn.signedIn, true);
  assert.equal(signedIn.board.username, 'alice');
  assert.equal(rankCalls, 0);
  await acknowledged;
  assert.equal((await api.get(receivedToken, '/api/tokens-manager/account')).status, 200);
  const ackedPoll = await api.call('/api/auth/plugin/poll', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ verifier })
  });
  assert.equal(ackedPoll.status, 410);

  const oldRanking = run('window-state');
  await started;
  const signedOut = await run('logout');
  assert.equal(signedOut.code, 'signed_out');
  assert.equal(signedOut.signedIn, false);
  assert.equal((await api.get(receivedToken, '/api/tokens-manager/account')).status, 200);
  releaseRanking();
  assert.equal((await oldRanking).boards, undefined);
  releaseLogout();
  for (let attempt = 0; attempt < 25 && (await api.get(receivedToken, '/api/tokens-manager/account')).status !== 401; attempt++) await delay(20);
  assert.equal((await api.get(receivedToken, '/api/tokens-manager/account')).status, 401);
  assert.notEqual((await run('login')).loginUrl, firstLogin.loginUrl);
  assert.equal(rankCalls, 1);
});

test('an offline logout survives a restart and revokes only the old session', { timeout: 8000 }, async t => {
  const api = await fixture(t);
  const oldToken = await api.login();
  const storage = new Map(), secrets = new Map([[SESSION_SECRET, oldToken]]);
  let handle, offline = true, attempts = 0;
  const orca = {
    storage: { get: async key => storage.get(key), set: async (key, value) => storage.set(key, value) },
    host: { has: () => true, call: async (method, { key, value }) => {
      if (method === 'secrets.get') return { value: secrets.get(key) };
      if (method === 'secrets.set') return secrets.set(key, value);
      if (method === 'secrets.delete') return secrets.delete(key);
    } },
    grantedCapabilities: ['secrets:own'],
    panels: { handle: (_, callback) => { handle = callback; return { dispose() {} }; } }
  };
  const launch = () => startLeaderboard(orca, {
    endpoint: api.endpoint, now: () => new Date(api.clock()),
    readUsage: async () => undefined, manager: managerClient(),
    async fetcher(url, options) {
      if (url.pathname === '/api/auth/logout') {
        attempts++;
        if (offline) throw new Error('Offline');
        assert.equal(options.headers.Authorization, 'Bearer ' + oldToken);
      }
      return fetch(url, options);
    }
  });

  let stop = launch();
  t.after(() => stop());
  const run = action => handle({ action });
  assert.equal((await run('session')).signedIn, true);
  const signedOut = await run('logout');
  assert.equal(signedOut.signedIn, false);
  assert.equal(signedOut.logoutPending, true);
  assert.ok(!savedToken(secrets));
  assert.ok([...secrets.values()].some(value => value.includes(oldToken)), 'pending token is kept in encrypted storage');
  assert.ok(!JSON.stringify([...storage]).includes(oldToken), 'plain storage never holds the token');
  stop();

  stop = launch();
  const restored = await run('session');
  assert.equal(restored.signedIn, false);
  assert.equal(restored.logoutPending, true);
  assert.equal((await api.get(oldToken, '/api/tokens-manager/account')).status, 200);

  await api.authorizePlugin((await run('login')).loginUrl, 'bob');
  assert.equal((await run('poll')).board.username, 'bob');
  const newToken = savedToken(secrets);
  assert.ok(newToken && newToken !== oldToken);
  offline = false;
  api.advance(16_000);
  for (let tries = 0; tries < 60 && (await run('session')).logoutPending; tries++) await delay(30);
  assert.ok(attempts >= 2);
  assert.equal((await run('session')).logoutPending, false);
  assert.equal((await api.get(oldToken, '/api/tokens-manager/account')).status, 401);
  assert.equal((await api.get(newToken, '/api/tokens-manager/account')).status, 200);
  assert.equal(savedToken(secrets), newToken);
  assert.ok(!secrets.get(SESSION_SECRET).includes(oldToken));
});

test('the plugin restores public rankings without the network and expires them at Beijing midnight', async t => {
  const stored = new Map();
  const row = { rank: 1, username: 'alice', tokens: 5, submittedAt: START };
  const endpoint = 'http://127.0.0.1:6789';
  let clock = START, offline = false, fetches = 0, rankingWrites = 0, avatarRequests = 0, handle;
  const orca = {
    storage: {
      get: async key => stored.get(key),
      set: async (key, value) => {
        if (key.startsWith('leaderboard:ranking')) rankingWrites++;
        stored.set(key, value);
      }
    },
    panels: { handle: (_, callback) => { handle = callback; return { dispose() {} }; } }
  };
  const launch = address => startLeaderboard(orca, {
    endpoint: address, now: () => new Date(clock), readUsage: async () => undefined,
    avatarFetcher: async url => {
      avatarRequests += 1;
      return url.hostname === 'github.com' ? Response.redirect('https://avatars.githubusercontent.com/u/1', 302)
        : new Response('avatar', { headers: { 'content-type': 'image/png' } });
    },
    fetcher: async url => {
      fetches++;
      if (offline) throw new Error('offline');
      const days = Number(url.searchParams.get('days') ?? 1);
      return Response.json({ day: TODAY, days, authenticated: true, banned: true, rank: 1,
        rows: [{ ...row, tokens: row.tokens * days, mine: true }] });
    }
  });
  let stop = launch(endpoint);
  t.after(() => stop());
  const run = (action, days) => handle({ action, days });
  assert.deepEqual(await run('cache'), { ranking: null });
  assert.equal(fetches, 0);
  assert.equal((await run('state')).board.rows[0].mine, false);
  assert.equal((await run('state')).board.authenticated, false);
  assert.deepEqual(await handle({ action: 'avatar', username: 'ALICE' }), { image: 'data:image/png;base64,YXZhdGFy' });
  assert.deepEqual(await handle({ action: 'avatar', username: 'bob' }), { image: null });
  assert.equal(avatarRequests, 2);
  assert.equal(rankingWrites, 1);
  assert.deepEqual(stored.get('leaderboard:ranking'), { origin: endpoint, day: TODAY, rows: [row], updatedAt: START });
  assert.deepEqual(await run('cache', 7), { ranking: null });
  assert.equal((await run('state', 7)).board.rows[0].tokens, 35);
  assert.equal((await run('state', 30)).board.rows[0].tokens, 150);
  stop();

  offline = true;
  stop = launch(endpoint);
  assert.deepEqual(await run('cache'), { ranking: { day: TODAY, rows: [row], updatedAt: START } });
  assert.equal((await run('cache', 7)).ranking.rows[0].tokens, 35);
  assert.equal((await run('cache', 30)).ranking.rows[0].tokens, 150);
  assert.equal(fetches, 4);
  assert.deepEqual((await run('state')).board, { code: 'unavailable', authenticated: false });
  assert.equal((await run('cache')).ranking.rows.length, 1);
  clock = START + 86_400_000;
  assert.deepEqual(await run('cache'), { ranking: null });
  assert.deepEqual(await run('cache', 7), { ranking: null });
  assert.deepEqual(await run('cache', 30), { ranking: null });
  clock = START;
  stop();

  stop = launch('http://127.0.0.1:6790');
  assert.deepEqual(await run('cache'), { ranking: null });
});

test('usage discovery separates requests on either side of Beijing midnight from one source file', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tps-rank-usage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const day = leaderboardDay(Date.now()), start = leaderboardDayStart(day);
  const cutoff = start + 13 * HOUR_MS, oldest = cutoff - 720 * HOUR_MS;
  const message = (at, output) => ({
    type: 'message', timestamp: new Date(at).toISOString(),
    message: { role: 'assistant', provider: 'test', model: 'test', timestamp: at - 1000,
      usage: { input: 5, output, cacheRead: 2, cacheWrite: 3 } }
  });
  await writeFile(path.join(dir, 'current.jsonl'), [
    { type: 'session', id: 'current', cwd: dir },
    message(oldest - 1, 16), message(oldest, 23), message(start - 1, 5), message(start, 40)
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const values = new Map();
  const index = createUsageIndex({
    leaderboard: true, now: () => cutoff, rankDays: 30, includeUsageTimes: true,
    storage: { keys: async () => [...values.keys()], get: async key => values.get(key),
      set: async (key, value) => values.set(key, value), delete: async key => values.delete(key) },
    discover: (scanCutoff, rankDay, rankFrom) => discoverUsageUnits(scanCutoff, {
      roots: { pi: [dir] }, includeDefaults: false, rankDay, rankFrom, includeUsageTimes: true
    })
  });
  assert.equal(index.leaderboardUsage().ready, false);
  await index.refresh();
  const current = index.leaderboardUsage();
  assert.equal(current.ready, true);
  assert.equal(current.tokens, 50);
  const history = index.leaderboardHistory();
  assert.equal(history.ready, true);
  assert.deepEqual(history.scores, [{ day: leaderboardDay(start - 1), tokens: 15 }, { day, tokens: 50 }]);
  assert.deepEqual(index.leaderboardUsageTimes(), {
    buckets: [[oldest, 33], [start - 1, 15], [start, 50]], coverage: [oldest, cutoff]
  });
});

test('usage discovery passes only completed recent requests from the same local and remote parser path', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tps-recent-usage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const now = Date.now(), day = leaderboardDay(now);
  const row = (id, at, output) => ({ id, type: 'message', timestamp: new Date(at).toISOString(),
    message: { role: 'assistant', model: 'sample', timestamp: at - 2000, usage: { input: 50, output, cacheRead: 10, cacheWrite: 5 } } });
  await writeFile(path.join(dir, 'sample.jsonl'), [
    { type: 'session', id: 'sample', cwd: dir }, row('old', now - 310_000, 500), row('new', now - 1000, 400)
  ].map(message => JSON.stringify(message)).join('\n') + '\n');
  const [unit] = await discoverUsageUnits(now - 600_000, {
    roots: { pi: [dir] }, includeDefaults: false, rankDay: day, includeRecent: true
  });
  const { recent } = await unit.read();
  assert.equal(recent.length, 1);
  assert.match(recent[0][0], /^[a-f0-9]{24}$/);
  assert.deepEqual(recent[0].slice(1), [now - 1000, 465, 200, 'sample', 'pi']);
});

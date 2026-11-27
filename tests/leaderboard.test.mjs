import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createLeaderboardServer } from '../server/app.mjs';
import { createTokensRankings, leaderboardSnapshotForMode } from '../server/tokens-manager-rankings.mjs';
import { createTokensManagerJobs } from '../server/tokens-manager-jobs.mjs';
import { openLeaderboardStore } from '../server/store.mjs';
import { openLocalUsageDb } from '../src/local-usage-db.mjs';
import { startLeaderboard } from '../src/leaderboard.mjs';
import { createWindowViews } from '../src/leaderboard-windows.mjs';
import { HOUR_MS, TOKENS_DEFAULT_INTERVALS, hourStart, leaderboardDay, leaderboardDayStart } from '../src/leaderboard_stats.mjs';
import { createAvatarCache } from '../src/leaderboard-avatars.mjs';

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

test('normal clients sharing one exit keep their upload and download allowances', async () => {
  const tokensJobs = { intervals: { uploadMs: 3000 }, snapshot: () => new Uint8Array([123, 125]), receive: async () => true };
  const store = { session: digest => accounts.get(digest) };
  const clients = Array.from({ length: 10 }, (_, id) => ({ id: id + 1, token: String(id).repeat(43) }));
  const accounts = new Map(clients.map(({ id, token }) => [createHash('sha256').update(token).digest('hex'), { id }]));
  const server = createLeaderboardServer({ store, baseUrl: ORIGIN, now: () => START, tokensJobs });
  function request(path, token) {
    return new Promise(resolve => {
      const req = Readable.from([Buffer.from('{}')]);
      Object.assign(req, { method: token ? 'POST' : 'GET', url: '/api/tokens-manager/' + path,
        socket: { remoteAddress: '192.0.2.10' }, headers: token ? { authorization: 'Bearer ' + token } : {} });
      let code;
      server.emit('request', req, { setHeader() {}, writeHead(value) { code = value; }, end() { resolve(code); } });
    });
  }
  for (let i = 0; i < clients.length; i++) assert.equal(await request('config'), 200);
  for (let round = 0; round < 20; round++) for (const { token } of clients) {
    assert.equal(await request('snapshot'), 200);
    assert.equal(await request('packets', token), 202);
  }
  for (let packet = 20; packet < 336; packet++) assert.equal(await request('packets', clients[0].token), 202);
  assert.equal(await request('packets', clients[0].token), 202);
  assert.equal(await request('packets', clients[1].token), 202);
  assert.equal(await request('snapshot'), 200);
});

test('viewer receives every rolling window and the speed board in one download and retains it on failure', async t => {
  const { call, advance, clock } = await fixture(t);
  const requests = [];
  let offline = false;
  const viewer = createWindowViews({ origin: ORIGIN, now: clock, request: async route => {
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
  const panels = openLocalUsageDb(':memory:');
  t.after(() => panels.close());
  const options = { panels, origin: ORIGIN, now: clock, request: async route => (await call(route)).json() };
  const signal = new AbortController().signal;
  const hourly = await createWindowViews(options).fetch(24, false, signal);
  const dateOptions = { ...options, mode: 'calendar' };
  const calendar = await createWindowViews(dateOptions).fetch(24, false, signal);
  assert.equal(hourly.boards[24].windowStart, clock() - 24 * HOUR_MS);
  assert.equal(hourly.boards[0].windowStart, clock() - 24 * HOUR_MS);
  assert.equal(calendar.boards[24].windowStart, START);
  assert.equal(calendar.boards[0].windowStart, START);
  assert.equal(calendar.boards[720].windowStart, START - 29 * 24 * HOUR_MS);
  assert.deepEqual(await createWindowViews(options).load(24, signal), hourly);
  assert.deepEqual(await createWindowViews(dateOptions).load(24, signal), calendar);
  assert.deepEqual(await createWindowViews({ ...dateOptions, request: async () => (await call('/api/tokens-manager/snapshot')).json() })
    .fetch(24, true, signal), { code: 'server_update_required' });
});

test('the 7-day and 30-day curves survive an offline restart', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tps-ranking-cache-'));
  const filename = path.join(directory, 'cache.sqlite');
  let localDb = openLocalUsageDb(filename);
  let stop;
  t.after(async () => {
    await stop?.();
    localDb?.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('tps-ranking-cache-'));
    await rm(directory, { force: true, recursive: true });
  });
  const at = START + HOUR_MS;
  const ranking = createTokensRankings().publish([{
    account: { id: 1, username: 'alice' }, receivedAt: at,
    packet: { deviceGuid: randomUUID(), publishedAt: at, hours: [[START, 800]], samples: [] }
  }], at, TOKENS_DEFAULT_INTERVALS);
  const snapshot = leaderboardSnapshotForMode(ranking, 'calendar');
  let handle;
  const launch = fetcher => startLeaderboard({
    storage: { get: async () => undefined, set: async () => {} },
    panels: { handle(_, callback) { handle = callback; return { dispose() {} }; } }
  }, { endpoint: ORIGIN, now: () => new Date(at), manager: managerClient(), localDb, fetcher });

  stop = launch(async () => Response.json(snapshot));
  const online = await handle({ action: 'window-state', days: 7, mode: 'calendar' });
  await stop();
  stop = undefined;
  localDb.close();
  localDb = undefined;
  localDb = openLocalUsageDb(filename);
  let downloads = 0;
  stop = launch(async () => { downloads++; throw new Error('Offline'); });
  for (const days of [7, 30]) {
    const { ranking: cached } = await handle({ action: 'window-cache', days, mode: 'calendar' });
    const hours = days * 24;
    assert.equal(cached.boards[hours].rows[0].daily.length, days);
    assert.deepEqual(cached.boards[hours].rows[0].daily, online.boards[hours].rows[0].daily);
  }
  assert.equal(downloads, 0);
});

test('viewer replaces invalid recent samples with zero in downloaded and cached rankings', async t => {
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
  const panels = openLocalUsageDb(':memory:');
  t.after(() => panels.close());
  panels.publishPanel('leaderboard', ORIGIN, { ...snapshot, origin: ORIGIN, updatedAt: at }, at);
  const launch = () => createWindowViews({ panels, origin: ORIGIN, now: () => at,
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
  const calls = [], signals = [];
  const cache = createAvatarCache({ async fetcher(url, options) {
    calls.push([url.href, options.redirect]);
    signals.push(options.signal);
    if (url.pathname === '/alice.png') return Response.redirect('https://avatars.githubusercontent.com/u/1?s=64', 302);
    if (url.pathname === '/bob.png') return Response.redirect('https://example.test/u/2', 302);
    return new Response('avatar', { headers: { 'content-type': 'image/png' } });
  } });
  const image = 'data:image/png;base64,YXZhdGFy';
  assert.equal(await cache.get('Alice'), image);
  assert.equal(await cache.get('alice'), image);
  assert.equal(signals[0], signals[1], 'avatar lookup and download share one deadline');
  assert.equal(await cache.get('bob'), null);
  assert.equal(await cache.get('alice/..'), null);
  assert.deepEqual(calls, [
    ['https://github.com/alice.png?size=64', 'manual'],
    ['https://avatars.githubusercontent.com/u/1?s=64', 'error'],
    ['https://github.com/bob.png?size=64', 'manual']
  ]);
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

test('a non-JSON 401 clears the saved session and stops account retries', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const token = 't'.repeat(43);
  let handler;
  let clock = START;
  let checks = 0;
  let deleted = false;
  const stop = startLeaderboard({
    storage: { get: async () => undefined, set: async () => {} },
    grantedCapabilities: ['secrets:own'],
    host: { has: () => true, call: async method => {
      if (method === 'secrets.get') return { value: token };
      if (method === 'secrets.delete') deleted = true;
    } },
    panels: { handle(_, fn) { handler = fn; return { dispose() {} }; } }
  }, {
    endpoint: ORIGIN, now: () => new Date(clock), manager: managerClient(),
    async fetcher(url) {
      assert.equal(url.pathname, '/api/tokens-manager/account');
      checks++;
      return new Response('<html>Unauthorized</html>', { status: 401 });
    }
  });
  t.after(stop);
  await delay(0);
  const session = await handler({ action: 'session' });
  assert.equal(session.signedIn, false);
  assert.equal(session.sessionProblem, 'session_expired');
  assert.equal(deleted, true);
  clock += 6000;
  t.mock.timers.tick(1000);
  await delay(0);
  assert.equal(checks, 1);
});

test('manager resumes a lifted ban and reports an expired session to the panel', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const token = 'm'.repeat(43);
  let clock = START, banned = true, expired = false, handler, statusListener, status, checks = 0;
  const credentials = [];
  const stop = startLeaderboard({
    storage: { get: async () => undefined, set: async () => {} },
    grantedCapabilities: ['secrets:own'],
    host: { has: () => true, call: async () => ({ value: token }) },
    panels: { handle(_, fn) { handler = fn; return { dispose() {} }; } }
  }, {
    endpoint: ORIGIN, now: () => new Date(clock),
    manager: { ...managerClient(), setCredential: value => credentials.push(value), uploadStatus: () => status,
      onUploadState(listener) { statusListener = listener; } },
    async fetcher(url) {
      assert.equal(url.pathname, '/api/tokens-manager/account');
      checks++;
      return expired ? Response.json({ code: 'login_required' }, { status: 401 })
        : Response.json({ accountId: 13, username: 'alice', banned });
    }
  });
  t.after(stop);
  const settle = () => delay(0);
  await settle();
  assert.equal((await handler({ action: 'session' })).board.banned, true);
  assert.deepEqual(credentials, []);
  clock += 59_000;
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(checks, 1);
  banned = false;
  clock += 1000;
  t.mock.timers.tick(1000);
  await settle();
  assert.deepEqual(credentials, [{ token, accountId: 13 }]);
  assert.equal((await handler({ action: 'session' })).board.banned, false);
  expired = true;
  status = { code: 'login_required', at: clock };
  statusListener();
  await settle();
  const next = await handler({ action: 'session' });
  assert.equal(next.signedIn, false);
  assert.equal(next.sessionProblem, 'session_expired');
  assert.deepEqual(credentials.at(-1), { token: null, accountId: 13 });
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
    endpoint: api.endpoint, now: () => new Date(api.clock()), manager: managerClient(),
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
    manager: managerClient(),
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


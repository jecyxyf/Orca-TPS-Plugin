import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createLeaderboardServer } from '../server/app.mjs';
import { openLeaderboardStore } from '../server/store.mjs';
import { startLeaderboard } from '../src/leaderboard.mjs';
import { createSubmissionStats } from '../src/submission-stats.mjs';
import { uploadHourChanges } from '../src/hourly-upload.mjs';
import { createWindowViews } from '../src/leaderboard-windows.mjs';
import { HOUR_MS, SPEED_WINDOW_MS, hourStart } from '../src/leaderboard-stats.mjs';
import { createAvatarCache } from '../src/leaderboard-avatars.mjs';
import { discoverUsageUnits } from '../src/data.mjs';
import { createUsageIndex, leaderboardDay, leaderboardDayStart } from '../src/usage-summary.mjs';

const ORIGIN = 'http://127.0.0.1:8787';
const TODAY = '2026-11-18';
const START = leaderboardDayStart(TODAY);
const SESSION_SECRET = 'leaderboard-session';
const savedToken = secrets => JSON.parse(secrets.get(SESSION_SECRET) ?? '{}').token;

async function fixture(t, names = ['alice', 'bob']) {
  const store = openLeaderboardStore(':memory:');
  let clock = START + 3600_000, count = 0;
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
    adminEmail: 'staff@example.test', maxTokens: 1_000_000, fetcher: mockGitHub, now: () => clock,
    log: message => t.diagnostic(message)
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const endpoint = 'http://127.0.0.1:' + server.address().port;
  const call = (route, options) => fetch(endpoint + route, { redirect: 'manual', ...options });
  const advance = ms => { clock += ms; };
  const bearer = token => ({ Authorization: 'Bearer ' + token });
  const get = (token, route = '/api/today') => call(route, { headers: bearer(token) });
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
  const submit = (token, tokens, requestId = randomUUID(), day = leaderboardDay(clock), installationId, stats) => post(
    '/api/today/submit', { day, tokens, installationId, stats }, { ...bearer(token), 'Idempotency-Key': requestId }
  );

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
  return { call, advance, login, get, submit, websiteLogin, authorizePlugin, form, endpoint, store, clock: () => clock };
}

test('speed ranks use accepted uploads over 500 tokens, cap at 100, and refresh at expiry', async t => {
  const { call, advance, clock, store } = await fixture(t);
  const first = clock();
  for (let i = 1; i <= 108; i++) {
    store.upsertAccount({ id: i, login: `user${i}` });
    const upload = { day: TODAY, tokens: 1000, requestId: randomUUID(), fingerprint: `body-${i}`,
      stats: { deltaTokens: i === 104 ? 500 : i === 106 ? 499 : 501,
        avgTps: i === 107 ? null : i === 108 ? 0 : i, topModel: 'gpt-test', topCli: 'codex' } };
    assert.equal(store.submit(i, upload, first, 1_000_000), 'accepted');
    if (i === 103) assert.equal(store.submit(i, upload, first, 1_000_000), 'accepted');
  }
  const path = '/api/leaderboard/speeds';
  const result = await call(path);
  const { rows } = await result.json();
  assert.equal(rows.length, 100);
  assert.deepEqual(rows.slice(0, 2).map(row => [row.username, row.avgTps, row.topCli]),
    [['user105', 105, 'codex'], ['user103', 103, 'codex']]);
  assert.equal(rows.filter(row => row.username === 'user103').length, 1);
  assert.equal((await call(path, { headers: { 'If-None-Match': result.headers.get('etag') } })).status, 304);
  advance(5 * 60_000);
  assert.equal((await (await call(path)).json()).rows.length, 100);
  assert.equal((await (await call('/api/today?stats=1')).json()).rows.every(row => row.recent.points.length === 0), true);
  assert.equal(store.setBan(1, 105, true, clock(), 'test'), true);
  assert.equal((await (await call(path)).json()).rows[0].username, 'user103');
  advance(SPEED_WINDOW_MS - 5 * 60_000);
  assert.deepEqual((await (await call(path)).json()).rows, []);
});

test('hourly windows freeze all periods at the same cutoff and merge device updates at the next cutoff', async t => {
  const { call, advance, clock, login, store } = await fixture(t);
  const firstToken = await login(), secondToken = await login();
  const cutoff = hourStart(clock());
  const firstDevice = randomUUID(), secondDevice = randomUUID(), otherDevice = randomUUID();
  const patch = (token, body, requestId = randomUUID()) => call('/api/leaderboard/window-data', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': requestId, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const getBoard = async hours => (await call(`/api/leaderboard/usage?hours=${hours}`)).json();
  const olderHour = cutoff - 719 * HOUR_MS;
  assert.deepEqual((await getBoard(24)).rows, []);
  const first = { installationId: firstDevice, version: 1, buckets: [[cutoff - HOUR_MS, 10], [cutoff, 20], [olderHour, 70]],
    coverage: [cutoff - 720 * HOUR_MS, cutoff] };
  const requestId = randomUUID();
  assert.equal((await patch('anonymous', first)).status, 401);
  assert.equal((await patch(firstToken, first, requestId)).status, 201);
  assert.equal((await patch(firstToken, first, requestId)).status, 201);
  assert.equal((await patch(firstToken, { ...first, buckets: [[cutoff, 200]] })).status, 409);
  assert.equal((await patch(firstToken, { installationId: secondDevice, version: 1, buckets: [[cutoff, 30]] })).status, 201);
  assert.equal((await patch(secondToken, { installationId: otherDevice, version: 1, buckets: [[cutoff - HOUR_MS, 30]] })).status, 201);
  const old = await getBoard(24);
  assert.deepEqual(old.rows, []);
  assert.deepEqual((await getBoard(720)).rows, []);
  advance(HOUR_MS);
  const board = await getBoard(24);
  assert.equal(board.cutoffAt, cutoff + HOUR_MS);
  assert.equal(board.windowStart, cutoff - 23 * HOUR_MS);
  assert.deepEqual(board.rows.map(row => [row.username, row.tokens]), [['alice', 60], ['bob', 30]]);
  assert.equal((await getBoard(168)).rows[0].daily.length, 7);
  const month = await getBoard(720);
  assert.equal(month.snapshotId, board.snapshotId);
  assert.equal(month.rows[0].tokens, 130);
  assert.equal(month.rows[0].daily[0].tokens, 70);
  const recent = snapshotId => call(`/api/leaderboard/recent?hours=24&snapshotId=${snapshotId}`);
  assert.equal((await recent(old.snapshotId)).status, 409);
  assert.equal((await (await recent(board.snapshotId)).json()).rows.length, 2);
  assert.equal((await patch(firstToken, { installationId: firstDevice, version: 2, buckets: [[cutoff, 25]] })).status, 201);
  assert.equal((await getBoard(24)).rows[0].tokens, 60);
  store.removeScores(2, { day: TODAY, account: 2 }, clock());
  assert.equal((await recent(board.snapshotId)).status, 409);
  assert.deepEqual((await getBoard(24)).rows.map(row => row.tokens), [60]);
  advance(HOUR_MS);
  assert.equal((await getBoard(24)).rows[0].tokens, 65);
  assert.equal((await getBoard(720)).rows[0].tokens, 65);
});

test('hour uploader retries the same bounded payload and marks coverage after the last batch', async () => {
  const saved = new Map(), sent = [];
  const now = START + 12 * HOUR_MS;
  const coverage = [now - 720 * HOUR_MS, now];
  const buckets = Array.from({ length: 330 }, (_, i) => [now - i * HOUR_MS, 999_000]);
  const opts = { storage: { get: async key => saved.get(key), set: async (key, value) => saved.set(key, value) },
    identity: 'test-account', installationId: randomUUID(), now, readHours: async () => ({ buckets, coverage }),
    send: async packet => {
      sent.push(JSON.parse(JSON.stringify(packet)));
      return sent.length === 1 ? { code: 'unavailable' } : { code: 'accepted', version: packet.body.version };
    }, active: () => true };
  assert.equal(await uploadHourChanges(opts), 'unavailable');
  assert.equal(await uploadHourChanges(opts), 'accepted');
  assert.deepEqual(sent[0], sent[1]);
  for (let i = 0; i < 5; i++) await uploadHourChanges(opts);
  assert.equal(sent.slice(1).flatMap(packet => packet.body.buckets).length, buckets.length);
  assert.ok(sent.every(packet => Buffer.byteLength(JSON.stringify(packet.body)) <= 4096));
  assert.ok(sent.slice(0, -1).every(packet => packet.body.coverage === undefined));
  assert.deepEqual(sent.at(-1).body.coverage, coverage);
});

test('viewer refreshes live stats between hourly snapshots and requests the next snapshot when required', async t => {
  const { call, advance, clock } = await fixture(t);
  const requests = [];
  const storage = { get: async () => null, set: async () => {} };
  const viewer = createWindowViews({ storage, origin: ORIGIN, now: clock, request: async (route, opts) => {
    requests.push(route);
    const response = await call(route, { headers: opts.etag ? { 'If-None-Match': opts.etag } : {} });
    const serverTime = Date.parse(response.headers.get('date'));
    return response.status === 304 ? { notModified: true, serverTime } :
      { ...await response.json(), serverTime, etag: response.headers.get('etag') };
  } });
  const signal = new AbortController().signal;
  const first = await viewer.fetch(24, false, signal);
  advance(10_000);
  assert.equal((await viewer.fetch(24, false, signal)).snapshotId, first.snapshotId);
  assert.equal(requests.filter(route => route.includes('/usage?')).length, 1);
  advance(HOUR_MS);
  const second = await viewer.fetch(24, false, signal);
  assert.notEqual(second.snapshotId, first.snapshotId);
  assert.equal(requests.filter(route => route.includes('/usage?')).length, 2);
});

test('five-minute points are recorded once per accepted score and expire from cached rankings', async t => {
  const api = await fixture(t);
  const alice = await api.login(), bob = await api.login();
  const stats = { deltaTokens: 123, avgTps: 42.6, topModel: 'gpt-test', topCli: 'codex' };
  const requestId = randomUUID(), firstDevice = randomUUID(), secondDevice = randomUUID();
  assert.equal((await api.submit(alice, 7000, requestId, TODAY, firstDevice, stats)).status, 201);
  assert.equal((await api.submit(alice, 7000, requestId, TODAY, firstDevice, stats)).status, 201);
  const submittedAt = api.clock();
  const route = '/api/today?days=1&stats=1';
  const first = await api.call(route);
  const initialTag = first.headers.get('etag');
  const [initial] = (await first.json()).rows;
  assert.deepEqual(initial.recent, { points: [{ submittedAt, deltaTokens: 123, avgTps: 42.6 }], topModel: 'gpt-test', topCli: 'codex' });
  assert.equal((await api.call(route, { headers: { 'If-None-Match': initialTag } })).status, 304);
  assert.equal((await (await api.call('/api/today')).json()).rows[0].recent, undefined);
  assert.equal((await api.submit(bob, 100, undefined, TODAY, undefined, { ...stats, deltaTokens: -1 })).status, 400);
  assert.equal((await api.submit(alice, 10, undefined, TODAY, secondDevice, stats)).status, 429);
  api.advance(10_000);
  assert.equal((await api.submit(alice, 10, undefined, TODAY, secondDevice,
    { deltaTokens: 0, avgTps: null, topModel: null, topCli: null })).status, 201);
  const next = await api.call(route, { headers: { 'If-None-Match': initialTag } });
  assert.equal(next.status, 200);
  const nextTag = next.headers.get('etag');
  const [combined] = (await next.json()).rows;
  assert.equal(combined.tokens, 7010);
  assert.deepEqual(combined.recent.points.map(point => point.deltaTokens), [123, 0]);
  assert.equal(combined.recent.topModel, null);
  api.advance(290_000);
  const aged = await api.call(route, { headers: { 'If-None-Match': nextTag } });
  assert.equal(aged.status, 200);
  assert.deepEqual((await aged.json()).rows[0].recent.points, [{ submittedAt: submittedAt + 10_000, deltaTokens: 0, avgTps: null }]);
  api.advance(10_000);
  assert.deepEqual((await (await api.call(route)).json()).rows[0].recent.points, []);
});

test('all ranking periods return current five-minute statistics for exactly their top 100', async t => {
  const api = await fixture(t);
  const stats = { deltaTokens: 1, avgTps: null, topModel: null, topCli: 'pi' };
  const submit = (id, tokens) => {
    const requestId = randomUUID();
    return api.store.submit(id, { day: TODAY, requestId, fingerprint: requestId, tokens, stats }, api.clock(), 1_000_000);
  };
  for (let id = 1; id <= 101; id++) {
    api.store.upsertAccount({ id, login: 'sample-' + id });
    assert.equal(submit(id, 102 - id), 'accepted');
  }
  for (const days of [1, 7, 30]) {
    const rows = (await (await api.call(`/api/today?days=${days}&stats=1`)).json()).rows;
    assert.equal(rows.length, 100);
    assert.equal(rows.at(-1).username, 'sample-100');
    assert.ok(rows.every(row => row.recent.points.length === 1));
  }
  api.advance(10_000);
  assert.equal(submit(101, 200), 'accepted');
  const updated = (await (await api.call('/api/today?days=7&stats=1')).json()).rows;
  assert.equal(updated[0].username, 'sample-101');
  assert.equal(updated[0].recent.points.length, 2);
  assert.ok(!updated.some(row => row.username === 'sample-100'));
});

test('daily ranking charts cover the selected Beijing dates and use the saved account total for each date', async t => {
  const api = await fixture(t);
  api.store.upsertAccount({ id: 1, login: 'alice' });
  api.store.upsertAccount({ id: 99, login: 'admin' });
  const stats = { deltaTokens: 1, avgTps: 9.5, topModel: 'sample', topCli: 'pi' };
  const dayAgo = days => leaderboardDay(api.clock() - days * 86_400_000);
  const submit = (offset, tokens, installationId) => {
    const requestId = randomUUID();
    const time = api.clock() - offset * 86_400_000;
    return api.store.submit(1, { day: leaderboardDay(time), tokens, installationId, stats, requestId, fingerprint: requestId }, time, 1000);
  };
  for (const [ago, tokens] of [[30, 2], [29, 3], [7, 4], [6, 5], [2, 7]]) assert.equal(submit(ago, tokens), 'accepted');
  assert.equal(submit(0, 11, randomUUID()), 'accepted');
  api.advance(10_000);
  assert.equal(submit(0, 13, randomUUID()), 'accepted');

  const legacy = (await (await api.call('/api/today?days=7&stats=1')).json()).rows[0];
  assert.equal(legacy.daily, undefined);
  assert.equal(legacy.recent.points.length, 2);
  const today = (await (await api.call('/api/today?stats=1&daily=1')).json()).rows[0];
  assert.equal(today.daily, undefined);
  assert.equal(today.recent.points.length, 2);

  const weekRoute = '/api/today?days=7&stats=1&daily=1';
  const week = await api.call(weekRoute);
  const weekTag = week.headers.get('etag');
  const [weekly] = (await week.json()).rows;
  assert.deepEqual(weekly.daily, [{ day: dayAgo(6), tokens: 5 }, { day: dayAgo(2), tokens: 7 }, { day: TODAY, tokens: 24 }]);
  assert.equal(weekly.daily.reduce((total, point) => total + point.tokens, 0), weekly.tokens);
  assert.equal(weekly.recent.points.length, 1);
  assert.equal(weekly.recent.topModel, 'sample');
  assert.equal((await api.call(weekRoute, { headers: { 'If-None-Match': weekTag } })).status, 304);

  const month = (await (await api.call('/api/today?days=30&stats=1&daily=1')).json()).rows[0];
  assert.deepEqual(month.daily.slice(0, 2), [{ day: dayAgo(29), tokens: 3 }, { day: dayAgo(7), tokens: 4 }]);
  assert.equal(month.daily.reduce((total, point) => total + point.tokens, 0), month.tokens);
  api.store.removeScores(99, { day: dayAgo(2), account: 1 }, api.clock());
  const changed = await api.call(weekRoute, { headers: { 'If-None-Match': weekTag } });
  assert.equal(changed.status, 200);
  assert.deepEqual((await changed.json()).rows[0].daily.map(point => point.day), [dayAgo(6), TODAY]);

  api.advance(START + 86_400_000 - api.clock());
  const rolled = (await (await api.call(weekRoute)).json()).rows[0];
  assert.deepEqual(rolled.daily, [{ day: TODAY, tokens: 24 }]);
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

test('a submission packs only four statistics and two viewers read the same current snapshot after a disconnect', async t => {
  const api = await fixture(t);
  const token = await api.login();
  const connect = async (credential = null) => {
    const values = new Map(), handlers = new Map(), traffic = [];
    let online = true;
    const orca = {
      storage: { get: async key => values.get(key), set: async (key, value) => values.set(key, structuredClone(value)) },
      host: { has: () => true, call: async () => ({ value: credential }) },
      grantedCapabilities: credential ? ['secrets:own'] : [],
      panels: { handle: (name, run) => { handlers.set(name, run); return { dispose() {} }; } }
    };
    const stats = await createSubmissionStats(orca.storage, api.clock);
    const stop = startLeaderboard(orca, {
      endpoint: api.endpoint, stats, now: () => new Date(api.clock()), readUsage: async () => ({ day: TODAY, tokens: 2500 }),
      fetcher(url, options) {
        traffic.push({ url, ...options });
        if (!online) throw new Error('offline');
        return fetch(url, options);
      }
    });
    t.after(stop);
    return { stats, traffic, online: value => { online = value; },
      run: (action, fields = {}) => handlers.get('tps.leaderboard')({ action, ...fields }) };
  };
  const sender = await connect(token), first = await connect(), second = await connect();
  api.advance(1000);
  sender.stats.observe('local', [['d'.repeat(24), api.clock(), 150, 30, 'model-A', 'pi']]);
  assert.equal((await sender.run('submit')).code, 'accepted');
  const upload = sender.traffic.filter(entry => entry.url.pathname === '/api/today/submit');
  assert.equal(upload.length, 1);
  assert.deepEqual(JSON.parse(upload[0].body).stats, { deltaTokens: 150, avgTps: 30, topModel: 'model-A', topCli: 'pi' });
  const opening = await first.run('state', { days: 7, force: true });
  assert.equal(opening.board.rows[0].recent.points[0].deltaTokens, 150);
  assert.deepEqual(opening.board.rows[0].daily, [{ day: TODAY, tokens: 2500 }]);
  assert.deepEqual((await second.run('state', { days: 7 })).board.rows, opening.board.rows);
  assert.deepEqual((await first.run('state', { days: 7 })).board.rows, opening.board.rows);
  assert.ok(first.traffic.at(-1).headers['If-None-Match']);
  first.online(false);
  assert.equal((await first.run('state', { days: 7 })).board.code, 'unavailable');
  api.advance(300_000);
  first.online(true);
  const resumed = await first.run('state', { days: 7 });
  assert.equal(first.traffic.at(-1).headers['If-None-Match'], undefined);
  assert.deepEqual(resumed.board.rows[0].recent.points, []);
});

test('the ranking switch blocks public reads while login and uploads stay available', async t => {
  const api = await fixture(t);
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
    endpoint: api.endpoint, now: () => new Date(api.clock()),
    readUsage: async () => ({ day: TODAY, tokens: 600, ready: true }),
    fetcher(url, options) {
      if (url.pathname === '/api/today') {
        rankingReads.push(Number(url.searchParams.get('days') ?? 1));
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
  assert.equal((await run('state')).board.rows, undefined);
  assert.deepEqual(await run('cache'), { ranking: null });
  assert.deepEqual(rankingReads, []);
  assert.deepEqual(await setEnabled(true), { enabled: true, saved: true });
  const guest = await run('state');
  assert.equal(guest.signedIn, false);
  assert.deepEqual(guest.board.rows, []);

  await setEnabled(false);
  const login = await run('login');
  await api.authorizePlugin(login.loginUrl, 'alice');
  const signedIn = await run('poll');
  assert.equal(signedIn.code, 'signed_in');
  assert.equal(signedIn.nextAutomaticAt, api.clock() + 10_000);
  assert.equal((await run('sync')).code, 'accepted');
  assert.deepEqual(rankingReads, [1]);

  await setEnabled(true);
  const blocked = { started: Promise.withResolvers(), reply: Promise.withResolvers() };
  nextRead = blocked;
  const old = run('state', { days: 7 });
  const signal = await blocked.started.promise;
  const queued = run('state', { days: 30 });
  assert.deepEqual(await setEnabled(false), { enabled: false, saved: true });
  assert.equal(signal.aborted, true);
  assert.deepEqual(await run('cache'), { ranking: null });
  await setEnabled(true);
  const fresh = run('state', { days: 7, force: true });
  blocked.reply.resolve(Response.json({ days: 7, day: TODAY,
    rows: [{ username: 'stale', rank: 1, tokens: 1, submittedAt: api.clock() }] }));
  assert.equal((await old).board.rows, undefined);
  assert.equal((await queued).board.rows, undefined);
  assert.deepEqual((await fresh).board.rows.map(row => row.username), ['alice']);
  assert.deepEqual(rankingReads, [1, 7, 7]);

  await setEnabled(false);
  stop();
  stop = launch();
  assert.deepEqual(await run('ranking-preference'), { enabled: false });
  assert.equal((await run('session')).signedIn, true);
  assert.equal((await run('state')).board.rows, undefined);
  assert.deepEqual(rankingReads, [1, 7, 7]);
});

test('everyone can view today’s ranking, while submissions require login and exclude banned accounts', async t => {
  const api = await fixture(t, ['alice', 'alice', 'bob']);
  const guest = await api.call('/api/today');
  assert.equal(guest.status, 200);
  assert.equal((await guest.json()).authenticated, false);
  assert.equal((await api.submit('', 300)).status, 401);
  const alice = await api.login(), aliceOtherDevice = await api.login(), bob = await api.login();
  const outcomes = await Promise.all([api.submit(alice, 300), api.submit(aliceOtherDevice, 300)]);
  assert.deepEqual(outcomes.map(result => result.status).sort(), [201, 429]);
  assert.equal((await api.submit(bob, 500)).status, 201);
  const board = await (await api.get(alice)).json();
  assert.deepEqual(board.rows.map(row => [row.username, row.tokens, row.rank]), [['bob', 500, 1], ['alice', 300, 2]]);
  assert.equal(board.rank, 2);
  assert.equal(board.rows[1].mine, true);
  const publicBoard = await (await api.call('/api/today')).json();
  assert.equal(publicBoard.authenticated, false);
  assert.equal(publicBoard.submittedAt, undefined);
  assert.deepEqual(publicBoard.rows.map(row => row.username), ['bob', 'alice']);
  api.advance(10_000);
  assert.equal((await api.submit(aliceOtherDevice, 700)).status, 201);
  const updated = await (await api.get(alice)).json();
  assert.deepEqual(updated.rows.map(row => [row.username, row.tokens]), [['alice', 700], ['bob', 500]]);
  assert.equal(updated.submittedAt, api.clock());

  assert.equal((await api.websiteLogin('visitor')).redirect, '/admin?feedback=forbidden');
  const admin = await api.websiteLogin('admin');
  assert.equal(admin.redirect, '/admin');
  const dashboard = await api.call('/admin', { headers: { cookie: admin.cookie } });
  assert.match(await dashboard.text(), /alice/);
  assert.equal((await api.form('/admin/ban', admin.cookie, { account: '1', ban: '1' }, 'https://other.example')).status, 403);
  const noReason = await api.form('/admin/ban', admin.cookie, { account: '1', ban: '1' });
  assert.match(noReason.headers.get('location'), /feedback=rejected/);
  assert.equal((await api.form('/admin/ban', admin.cookie, { account: '1', ban: '1', reason: '异常上传 <需复核>' })).status, 303);
  const notes = await api.call('/admin', { headers: { cookie: admin.cookie } });
  assert.match(await notes.text(), /异常上传 &lt;需复核&gt;/);
  const bannedView = await api.get(alice);
  assert.equal(bannedView.status, 200);
  assert.equal((await bannedView.json()).banned, true);
  assert.equal((await api.get(alice, '/api/today/status')).status, 403);
  assert.equal((await api.submit(alice, 450)).status, 403);
  assert.equal((await api.form('/admin/ban', admin.cookie, { account: '1', ban: '0' })).status, 303);
  assert.equal((await api.get(alice)).status, 200);
  assert.equal((await api.form('/admin/delete', admin.cookie, { account: '1', day: TODAY })).status, 303);
  const afterDelete = await (await api.get(alice)).json();
  assert.deepEqual(afterDelete.rows.map(row => row.username), ['bob']);
  assert.equal(afterDelete.submitted, true);
  assert.equal((await api.submit(alice, 901)).status, 409);

  await api.form('/admin/clear', admin.cookie, { day: TODAY, scope: 'all', confirm: 'no' });
  assert.equal((await (await api.get(bob)).json()).rows.length, 1);
  await api.form('/admin/clear', admin.cookie, { day: TODAY, scope: 'all', confirm: '清空' });
  assert.equal((await (await api.get(bob)).json()).rows.length, 0);
  assert.equal((await api.submit(bob, 700)).status, 409);
});

test('weekly and monthly rankings total the latest score per Beijing day', async t => {
  const api = await fixture(t, ['alice', 'bob', 'alice']);
  const day = 86_400_000;
  api.advance(-30 * day);
  let alice = await api.login();
  assert.equal((await api.submit(alice, 1000)).status, 201);
  api.advance(day);
  assert.equal((await api.submit(alice, 100)).status, 201);
  api.advance(22 * day);
  const removedDay = leaderboardDay(api.clock());
  assert.equal((await api.submit(alice, 75)).status, 201);
  api.advance(day);
  const bob = await api.login();
  assert.equal((await api.submit(alice, 200)).status, 201);
  assert.equal((await api.submit(bob, 400)).status, 201);
  api.advance(10_000);
  assert.equal((await api.submit(alice, 250)).status, 201);

  api.advance(6 * day);
  alice = await api.login();
  assert.equal((await api.submit(bob, 150)).status, 201);
  api.advance(1000);
  assert.equal((await api.submit(alice, 300)).status, 201);
  const weekly = await (await api.get(alice, '/api/today?days=7')).json();
  assert.equal(weekly.days, 7);
  assert.equal(weekly.startDay, leaderboardDay(START - 6 * day));
  assert.equal(weekly.day, TODAY);
  assert.equal(weekly.tokens, 300);
  assert.equal(weekly.rank, 2);
  assert.deepEqual(weekly.rows.map(row => [row.username, row.tokens, row.mine]), [['bob', 550, false], ['alice', 550, true]]);
  assert.equal(weekly.rows[1].submittedAt, api.clock());

  const monthly = await (await api.call('/api/today?days=30')).json();
  assert.equal(monthly.days, 30);
  assert.equal(monthly.startDay, leaderboardDay(START - 29 * day));
  assert.equal(monthly.authenticated, false);
  assert.deepEqual(monthly.rows.map(row => [row.username, row.tokens]), [['alice', 725], ['bob', 550]]);
  assert.equal((await api.call('/api/today?days=14')).status, 400);
  const admin = await api.websiteLogin('admin');
  await api.form('/admin/delete', admin.cookie, { account: '1', day: removedDay });
  const updated = await (await api.call('/api/today?days=30')).json();
  assert.equal(updated.rows[0].tokens, 650);
  assert.equal((await (await api.get(alice)).json()).tokens, 300);
});

test('same-day installations contribute separately and legacy totals are never counted twice', async t => {
  const api = await fixture(t, ['alice', 'alice']);
  api.advance(-86_400_000);
  const alice = await api.login();
  assert.equal((await api.submit(alice, 25)).status, 201);
  api.advance(86_400_000);
  const other = await api.login();
  assert.equal((await api.submit(alice, 90)).status, 201);
  api.advance(10_000);

  const a = randomUUID(), b = randomUUID(), first = randomUUID();
  assert.equal((await api.submit(alice, 100, first, TODAY, a)).status, 201);
  assert.equal((await (await api.get(other)).json()).tokens, 100);
  const simultaneous = await api.submit(other, 60, undefined, TODAY, b);
  assert.equal((await simultaneous.json()).code, 'too_soon');
  api.advance(10_000);
  assert.equal((await api.submit(other, 60, undefined, TODAY, b)).status, 201);
  assert.equal((await (await api.get(alice)).json()).tokens, 160);
  assert.equal((await api.submit(alice, 100, first, TODAY, a)).status, 201);
  api.advance(10_000);
  assert.equal((await api.submit(alice, 120, undefined, TODAY, a)).status, 201);
  api.advance(10_000);
  assert.equal((await (await api.submit(other, 90)).json()).code, 'upgrade_required');
  const daily = await (await api.get(alice)).json();
  assert.equal(daily.tokens, 180);
  assert.deepEqual(daily.rows.map(row => [row.username, row.tokens]), [['alice', 180]]);
  for (const days of [7, 30]) {
    const board = await (await api.get(alice, '/api/today?days=' + days)).json();
    assert.deepEqual(board.rows.map(row => [row.username, row.tokens]), [['alice', 205]]);
  }
  const admin = await api.websiteLogin('admin');
  await api.form('/admin/delete', admin.cookie, { account: '1', day: TODAY });
  assert.equal((await (await api.submit(alice, 150, undefined, TODAY, a)).json()).code, 'removed');
  assert.equal((await (await api.get(alice, '/api/today?days=30')).json()).rows[0].tokens, 25);
});

test('history still imports once and the first installation can update its imported daily total', async t => {
  const api = await fixture(t, ['alice', 'alice']);
  const alice = await api.login(), other = await api.login();
  const a = randomUUID(), b = randomUUID();
  const init = (token, installationId, tokens) => api.call('/api/history/init', {
    method: 'POST', body: JSON.stringify({ day: TODAY, installationId, scores: [{ day: TODAY, tokens }] }),
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }
  });
  assert.equal((await init(alice, a, 100)).status, 201);
  assert.equal((await (await init(other, b, 200)).json()).code, 'initialized');
  api.advance(10_000);
  assert.equal((await api.submit(alice, 120, undefined, TODAY, a)).status, 201);
  assert.equal((await (await api.get(alice)).json()).tokens, 120);
  api.advance(10_000);
  assert.equal((await api.submit(other, 60, undefined, TODAY, b)).status, 201);
  assert.equal((await (await api.get(alice)).json()).tokens, 180);
});

test('simultaneous installations share the cooldown without accumulating one another’s rapid attempts', async t => {
  const api = await fixture(t);
  const token = await api.login();
  const installationId = randomUUID();
  assert.equal((await (await api.submit(token, 100, undefined, TODAY, 'wrong-id')).json()).code, 'invalid');
  assert.equal((await api.submit(token, 100, undefined, TODAY, installationId)).status, 201);
  for (let index = 0; index < 5; index++) {
    const reply = await api.submit(token, 50, undefined, TODAY, randomUUID());
    assert.equal((await reply.json()).code, 'too_soon');
  }
  for (let index = 0; index < 3; index++) {
    api.advance(1000);
    assert.equal((await api.submit(token, 100, undefined, TODAY, installationId)).status, 429);
  }
  api.advance(1000);
  assert.equal((await api.submit(token, 100, undefined, TODAY, installationId)).status, 403);
  assert.equal((await (await api.get(token)).json()).banned, true);
});

test('initialization imports missing days once across devices and respects removed scores', async t => {
  const api = await fixture(t, ['alice', 'alice']);
  const dayLength = 86_400_000;
  api.advance(-dayLength);
  const alice = await api.login();
  const yesterday = leaderboardDay(api.clock());
  assert.equal((await api.submit(alice, 70)).status, 201);
  api.advance(dayLength);
  const other = await api.login();
  assert.equal((await api.submit(alice, 100)).status, 201);
  const historyStatus = () => api.get(alice, '/api/history/status');
  const init = (token, scores) => api.call('/api/history/init', {
    method: 'POST', body: JSON.stringify({ day: TODAY, scores }),
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }
  });
  assert.equal((await init('', [])).status, 401);
  assert.equal((await (await historyStatus()).json()).initialized, false);
  const admin = await api.websiteLogin('admin');
  await api.form('/admin/delete', admin.cookie, { account: '1', day: yesterday });
  const oldest = leaderboardDay(START - 29 * dayLength);
  const scores = [{ day: TODAY, tokens: 500 }, { day: yesterday, tokens: 500 }, { day: oldest, tokens: 40 }];
  api.advance(5000);
  assert.equal((await init(alice, scores)).status, 429);
  api.advance(5000);
  assert.equal((await init(alice, [...scores, { day: oldest, tokens: 5 }])).status, 400);
  api.advance(5000);
  assert.equal((await init(alice, [{ day: leaderboardDay(START - 30 * dayLength), tokens: 5 }])).status, 400);
  api.advance(5000);
  const results = await Promise.all([init(alice, scores), init(other, scores)]);
  assert.deepEqual(results.map(reply => reply.status).sort(), [200, 201]);
  assert.equal((await (await historyStatus()).json()).initialized, true);
  assert.equal((await (await api.get(alice)).json()).tokens, 100);
  assert.equal((await (await api.get(alice, '/api/today?days=30')).json()).rows[0].tokens, 140);
  assert.equal((await api.submit(alice, 120)).status, 429);
  api.advance(10_000);
  assert.equal((await api.submit(alice, 120)).status, 201);
  assert.equal((await (await api.get(alice, '/api/today?days=30')).json()).rows[0].tokens, 160);
});

test('the fifth error locks for the entire Beijing day, while retransmissions and errors outside the window do not count', async t => {
  const api = await fixture(t);
  const alice = await api.login();
  assert.equal((await api.submit(alice, -1)).status, 400);
  api.advance(10 * 60 * 1000);
  const first = randomUUID();
  for (let index = 0; index < 8; index++) assert.equal((await api.submit(alice, -1, first)).status, 400);
  for (let index = 0; index < 3; index++) {
    api.advance(5000);
    assert.equal((await api.submit(alice, -1)).status, 400);
  }
  api.advance(5000);
  const locked = await api.submit(alice, -1);
  assert.equal(locked.status, 429);
  assert.equal((await locked.json()).lockedUntil, START + 86_400_000);
  assert.equal((await api.get(alice)).status, 200);
  const admin = await api.websiteLogin('admin');
  const lockPage = await api.call('/admin?day=2026-11-17', { headers: { cookie: admin.cookie } });
  assert.match(await lockPage.text(), /<td>当天禁传<\/td>\s*<td class="ban-reason">10 分钟内提交错误累计 5 次/);
  api.advance(3600_000);
  assert.equal((await api.submit(alice, 25)).status, 429);
  api.advance(START + 86_400_000 - api.clock());
  assert.equal((await api.submit(alice, 25)).status, 201);
});

test('only the fourth consecutive interval under five seconds bans, and records the reason', async t => {
  const api = await fixture(t);
  const alice = await api.login();
  const first = randomUUID();
  assert.equal((await api.submit(alice, 100, first)).status, 201);
  for (let index = 0; index < 5; index++) assert.equal((await api.submit(alice, 100, first)).status, 201);
  for (let index = 0; index < 3; index++) {
    api.advance(1000);
    assert.equal((await api.submit(alice, 100)).status, 429);
  }
  api.advance(5000);
  assert.equal((await api.submit(alice, 100)).status, 429);
  api.advance(1000);
  assert.equal((await api.submit(alice, 100)).status, 429);
  api.advance(1000);
  assert.equal((await api.submit(alice, 200)).status, 201);
  api.advance(1000);
  assert.equal((await api.submit(alice, 300)).status, 429);
  api.advance(1000);
  assert.equal((await api.submit(alice, 300)).status, 403);
  const board = await (await api.get(alice)).json();
  assert.equal(board.banned, true);
  assert.equal(board.tokens, 200);
  const admin = await api.websiteLogin('admin');
  const page = await api.call('/admin', { headers: { cookie: admin.cookie } });
  assert.match(await page.text(), /连续 4 次上传间隔不足 5 秒/);
  await api.form('/admin/ban', admin.cookie, { account: '1', ban: '0' });
  api.advance(8000);
  assert.equal((await api.submit(alice, 300)).status, 201);
});

test('the ten-second upload limit carries across Beijing midnight', async t => {
  const api = await fixture(t);
  const alice = await api.login();
  api.advance(START + 86_400_000 - 1000 - api.clock());
  assert.equal((await api.submit(alice, 100)).status, 201);
  api.advance(1000);
  const limited = await api.submit(alice, 200);
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).code, 'too_soon');
  api.advance(9000);
  assert.equal((await api.submit(alice, 200)).status, 201);
});

test('reopening the database keeps the score and the daily lock', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tps-rank-db-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'leaderboard.sqlite');
  const store = openLeaderboardStore(filename);
  store.upsertAccount({ id: 1, login: 'alice' });
  let time = START;
  const submit = tokens => store.submit(1, { day: TODAY, tokens, requestId: randomUUID(), fingerprint: 'test' }, time, 5);
  assert.equal(submit(5), 'accepted');
  for (let index = 0; index < 5; index++) { time += 5000; submit(-1); }
  store.close();
  const reopened = openLeaderboardStore(filename);
  try {
    assert.equal(reopened.status(1, START).lockedUntil, START + 86_400_000);
    assert.equal(reopened.ranking(1, START).rows[0].tokens, 5);
  } finally { reopened.close(); }
});

test('login starts ten-second sync, restored login resumes it, and logout stops it', async t => {
  const api = await fixture(t);
  const storage = new Map(), secrets = new Map(), handlers = new Map();
  const requests = [];
  let avatarDownloads = 0;
  const installationIds = [];
  storage.set('leaderboard:upload', { enabled: false, interval: 60 });
  const orca = {
    storage: { get: async key => storage.get(key), set: async (key, value) => storage.set(key, value) },
    host: { has: () => true, call: async (method, { key, value }) => {
      if (method === 'secrets.get') return { value: secrets.get(key) };
      if (method === 'secrets.set') return secrets.set(key, value);
      if (method === 'secrets.delete') return secrets.delete(key);
    } },
    grantedCapabilities: ['secrets:own'],
    panels: { handle: (name, run) => { handlers.set(name, run); return { dispose: () => handlers.delete(name) }; } }
  };
  let tokens = 600;
  const launch = () => startLeaderboard(orca, {
    endpoint: api.endpoint, now: () => new Date(api.clock()),
    readUsage: async () => ({ day: TODAY, tokens, ready: true }),
    avatarFetcher: async url => {
      avatarDownloads += 1;
      if (url.href === 'https://github.com/alice.png?size=64') return Response.redirect('https://avatars.githubusercontent.com/u/1', 302);
      assert.equal(url.href, 'https://avatars.githubusercontent.com/u/1?s=64');
      return new Response('avatar', { headers: { 'content-type': 'image/png' } });
    },
    fetcher: (url, options) => {
      requests.push({ path: url.pathname, method: options.method, authenticated: Boolean(options.headers.Authorization) });
      if (url.pathname === '/api/today/submit') installationIds.push(JSON.parse(options.body).installationId);
      return fetch(url, options);
    }
  });
  let stop = launch();
  t.after(() => stop());
  const run = (action, fields = {}) => handlers.get('tps.leaderboard')({ action, ...fields });
  const initial = await run('state');
  const installationId = storage.get('leaderboard:installation-id');
  assert.match(installationId, /^[\da-f-]{36}$/);
  assert.equal(initial.board.authenticated, false);
  assert.equal(initial.nextAutomaticAt, null);
  assert.equal((await run('submit', { day: TODAY, tokens })).code, 'login_required');
  assert.deepEqual(JSON.parse(JSON.stringify(initial)), initial);
  const login = await run('login');
  assert.equal((await run('poll')).code, 'pending');
  await api.authorizePlugin(login.loginUrl, 'alice');
  const signedIn = await run('poll');
  assert.equal(signedIn.code, 'signed_in');
  assert.equal(signedIn.board.username, 'alice');
  assert.equal(signedIn.token, undefined);
  assert.equal(signedIn.nextAutomaticAt, api.clock() + 10_000);
  stop();
  stop = launch();
  const beforeRestore = requests.length;
  const restored = await run('session');
  assert.equal(restored.board.username, 'alice');
  assert.equal(restored.signedIn, true);
  assert.equal(restored.nextAutomaticAt, api.clock() + 10_000);
  assert.equal(requests.length, beforeRestore);
  const image = { image: 'data:image/png;base64,YXZhdGFy' };
  assert.deepEqual(await run('avatar', { username: 'alice' }), image);
  assert.deepEqual(await run('avatar', { username: 'alice' }), image);
  assert.deepEqual(await run('avatar', { username: 'other' }), { image: null });
  assert.equal(avatarDownloads, 2);
  assert.equal((await run('state')).board.username, 'alice');
  assert.deepEqual(requests.at(-1), { path: '/api/today', method: 'GET', authenticated: false });
  tokens = 700;
  assert.equal((await run('submit', { day: TODAY, tokens: 600 })).code, 'usage_changed');
  const beforeUpload = requests.length;
  const submitted = await run('submit');
  assert.equal(submitted.code, 'accepted');
  assert.equal(submitted.board.tokens, 700);
  assert.deepEqual(requests.slice(beforeUpload), [{ path: '/api/today/submit', method: 'POST', authenticated: true }]);
  assert.equal((await run('state')).board.rows[0].mine, true);
  const viewerToken = savedToken(secrets);
  assert.equal((await run('submit', { day: TODAY, tokens: 700 })).code, 'too_soon');
  tokens = 800;
  api.advance(9999);
  await delay(1100);
  assert.deepEqual(installationIds, [installationId]);
  api.advance(1);
  for (let tries = 0; tries < 40 && (await run('session')).lastUpload?.kind !== 'automatic'; tries++) await delay(50);
  const automatic = await run('session');
  assert.equal(automatic.board.tokens, 800);
  assert.deepEqual(automatic.lastUpload, { kind: 'automatic', code: 'accepted', at: api.clock() });
  assert.equal(automatic.nextAutomaticAt, api.clock() + 10_000);
  tokens = 850;
  api.advance(9999);
  assert.equal((await run('state')).board.tokens, 800);
  api.advance(1);
  for (let tries = 0; tries < 40 && (await run('state')).board.tokens !== 850; tries++) await delay(50);
  assert.equal((await run('state')).board.tokens, 850);
  assert.deepEqual(installationIds, [installationId, installationId, installationId]);
  stop();
  stop = launch();
  const out = await run('logout');
  assert.equal(out.board.authenticated, false);
  assert.equal(out.nextAutomaticAt, null);
  api.advance(20_000);
  tokens = 900;
  await delay(1100);
  stop();
  stop = launch();
  assert.equal((await run('session')).nextAutomaticAt, null);
  assert.deepEqual(installationIds, [installationId, installationId, installationId]);
  assert.ok(!savedToken(secrets));
  for (let attempt = 0; attempt < 25 && (await api.get(viewerToken, '/api/today/status')).status !== 401; attempt++) await delay(20);
  assert.equal((await api.get(viewerToken, '/api/today/status')).status, 401);

  await api.authorizePlugin((await run('login')).loginUrl, 'bob');
  const bobLogin = await run('poll');
  assert.equal(bobLogin.board.username, 'bob');
  assert.equal(bobLogin.nextAutomaticAt, api.clock() + 10_000);
  const bob = savedToken(secrets);
  const admin = await api.websiteLogin('admin');
  await api.form('/admin/ban', admin.cookie, { account: '2', ban: '1', reason: 'test' });
  const blocked = await run('submit', { day: TODAY, tokens });
  assert.equal(blocked.code, 'banned');
  assert.equal(blocked.signedIn, true);
  assert.equal(blocked.board.banned, true);
  assert.equal(blocked.nextAutomaticAt, null);
  assert.equal(savedToken(secrets), bob);
  await api.call('/api/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + bob } });
  assert.equal((await run('state')).signedIn, true);
  const expired = await run('submit', { day: TODAY, tokens });
  assert.equal(expired.code, 'login_required');
  assert.equal(expired.sessionProblem, 'session_expired');
  assert.equal(expired.signedIn, false);
  assert.equal(expired.nextAutomaticAt, null);
  assert.equal(secrets.size, 0);
  assert.equal((await run('cache')).ranking.rows.length, 1);
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
    endpoint: api.endpoint, now: () => new Date(api.clock()), readUsage: async () => undefined,
    async fetcher(url, options) {
      if (url.pathname === '/api/today') {
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
  assert.equal((await api.get(receivedToken, '/api/today/status')).status, 200);
  const ackedPoll = await api.call('/api/auth/plugin/poll', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ verifier })
  });
  assert.equal(ackedPoll.status, 410);

  const oldRanking = run('state');
  await started;
  const signedOut = await run('logout');
  assert.equal(signedOut.code, 'signed_out');
  assert.equal(signedOut.signedIn, false);
  assert.equal((await api.get(receivedToken, '/api/today/status')).status, 200);
  releaseRanking();
  assert.equal((await oldRanking).board.authenticated, false);
  releaseLogout();
  for (let attempt = 0; attempt < 25 && (await api.get(receivedToken, '/api/today/status')).status !== 401; attempt++) await delay(20);
  assert.equal((await api.get(receivedToken, '/api/today/status')).status, 401);
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
    readUsage: async () => undefined,
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
  assert.equal((await api.get(oldToken, '/api/today/status')).status, 200);

  await api.authorizePlugin((await run('login')).loginUrl, 'bob');
  assert.equal((await run('poll')).board.username, 'bob');
  const newToken = savedToken(secrets);
  assert.ok(newToken && newToken !== oldToken);
  offline = false;
  api.advance(16_000);
  for (let tries = 0; tries < 60 && (await run('session')).logoutPending; tries++) await delay(30);
  assert.ok(attempts >= 2);
  assert.equal((await run('session')).logoutPending, false);
  assert.equal((await api.get(oldToken, '/api/today/status')).status, 401);
  assert.equal((await api.get(newToken, '/api/today/status')).status, 200);
  assert.equal(savedToken(secrets), newToken);
  assert.ok(!secrets.get(SESSION_SECRET).includes(oldToken));
});

test('login returns before initialization and the same session resumes it after a plugin restart', { timeout: 7000 }, async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const api = await fixture(t);
  const storage = new Map(), secrets = new Map();
  let handle, historyReady = false;
  const yesterday = leaderboardDay(START - 86_400_000);
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
    readUsage: async () => ({ day: TODAY, ready: true, tokens: 100 }),
    readHistory: async () => historyReady ? { day: TODAY, ready: true, scores: [{ day: TODAY, tokens: 100 }, { day: yesterday, tokens: 200 }] } :
      { day: TODAY, ready: false }
  });
  let stop = launch();
  t.after(() => stop());
  await api.authorizePlugin((await handle({ action: 'login' })).loginUrl, 'alice');
  const signedIn = await handle({ action: 'poll' });
  assert.equal(signedIn.code, 'signed_in');
  assert.equal(signedIn.initializing, true);
  assert.equal(signedIn.board.authenticated, true);
  assert.deepEqual((await handle({ action: 'state' })).board.rows, []);
  stop();
  historyReady = true;
  stop = launch();
  assert.equal((await handle({ action: 'session' })).nextAutomaticAt, api.clock() + 10_000);
  api.advance(9999);
  t.mock.timers.tick(1000);
  assert.deepEqual((await handle({ action: 'state' })).board.rows, []);
  api.advance(1);
  t.mock.timers.tick(1000);
  for (let attempt = 0; attempt < 30 && (await handle({ action: 'state' })).initializing; attempt++) await delay(35);
  const board = await handle({ action: 'state', days: 7 });
  assert.equal(board.initializing, false);
  assert.equal(board.board.tokens, 100);
  assert.equal(board.board.rows[0].tokens, 300);
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
    leaderboard: true, now: () => cutoff, rankDays: 30, includeHours: true,
    storage: { keys: async () => [...values.keys()], get: async key => values.get(key),
      set: async (key, value) => values.set(key, value), delete: async key => values.delete(key) },
    discover: (scanCutoff, rankDay, rankFrom) => discoverUsageUnits(scanCutoff, {
      roots: { pi: [dir] }, includeDefaults: false, rankDay, rankFrom, includeHours: true
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
  assert.deepEqual(index.leaderboardHourly(), {
    buckets: [[oldest, 33], [start - HOUR_MS, 15], [start, 50]], coverage: [oldest, cutoff]
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

test("today's usage uploads whatever has been read so far, even before every file is up to date", async t => {
  const api = await fixture(t);
  const storage = new Map(), secrets = new Map(), handlers = new Map();
  const orca = {
    storage: { get: async key => storage.get(key), set: async (key, value) => storage.set(key, value) },
    host: { has: () => true, call: async (method, { key, value }) => {
      if (method === 'secrets.get') return { value: secrets.get(key) };
      if (method === 'secrets.set') return secrets.set(key, value);
      if (method === 'secrets.delete') return secrets.delete(key);
    } },
    grantedCapabilities: ['secrets:own'],
    panels: { handle: (name, run) => { handlers.set(name, run); return { dispose: () => handlers.delete(name) }; } }
  };
  let tokens = 0;
  const stop = startLeaderboard(orca, {
    endpoint: api.endpoint, now: () => new Date(api.clock()),
    readUsage: async () => ({ day: TODAY, tokens, ready: false })
  });
  t.after(() => stop());
  const run = (action, fields = {}) => handlers.get('tps.leaderboard')({ action, ...fields });
  await api.authorizePlugin((await run('login')).loginUrl, 'alice');
  assert.equal((await run('poll')).code, 'signed_in');

  assert.equal((await run('submit')).code, 'usage_unready', 'nothing is uploaded while no usage has been read today');
  tokens = 300;
  const manual = await run('submit');
  assert.equal(manual.code, 'accepted', 'a partial total is uploaded by a manual sync');
  assert.equal(manual.board.tokens, 300);

  tokens = 450;
  api.advance(10_000);
  for (let tries = 0; tries < 40 && (await run('session')).lastUpload?.kind !== 'automatic'; tries++) await delay(50);
  const automatic = await run('session');
  assert.deepEqual(automatic.lastUpload, { kind: 'automatic', code: 'accepted', at: api.clock() }, 'automatic sync uploads the partial total too');
  assert.equal(automatic.board.tokens, 450, 'a later sync replaces the earlier partial total');
});

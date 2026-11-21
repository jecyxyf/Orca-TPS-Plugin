import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { createLeaderboardServer } from '../server/app.mjs';
import { createLeaderboardJobs } from '../server/leaderboard-jobs.mjs';
import { openLeaderboardStore } from '../server/store.mjs';
import { createPublishedSnapshot } from '../server/ranking-snapshot.mjs';
import { openLocalUsageDb } from '../src/local-usage-db.mjs';
import { startLeaderboard } from '../src/leaderboard.mjs';
import { createSubmissionStats } from '../src/submission-stats.mjs';
import { createSourceUploader, createSqliteUploadStorage, uploadUsageChanges } from '../src/usage-upload.mjs';
import { createHourlySourceUploader } from '../src/hourly-source-upload.mjs';
import { createWindowViews } from '../src/leaderboard-windows.mjs';
import { HOUR_MS, RANKING_REFRESH_MS, SPEED_WINDOW_MS, USAGE_UPLOAD_BYTES, hourStart } from '../src/leaderboard-stats.mjs';
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

test('rate limits use the visitor IP only when the connection comes from a trusted proxy', async t => {
  const store = openLeaderboardStore(':memory:');
  t.after(() => store.close());
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

test('speed ranks cap at 20 and fill the gap when a faster upload expires', async t => {
  const { call, advance, clock, store } = await fixture(t);
  const first = clock();
  for (let i = 1; i <= 108; i++) {
    store.upsertAccount({ id: i, login: `user${i}` });
    const deltaTokens = ({ 104: 500, 105: 12_345, 106: 499 })[i] ?? 501;
    const upload = { day: TODAY, tokens: 20_000, requestId: randomUUID(), fingerprint: `body-${i}`,
      stats: { deltaTokens,
        avgTps: i === 107 ? null : i === 108 ? 0 : i, topModel: 'gpt-test', topCli: 'codex' } };
    const submittedAt = i === 105 ? first : first + 1000;
    if (i === 103) assert.equal(store.submit(i, { ...upload, requestId: randomUUID(), fingerprint: 'second-best',
      stats: { ...upload.stats, avgTps: 102.5 } }, first - 9000, 1_000_000), 'accepted');
    assert.equal(store.submit(i, upload, submittedAt, 1_000_000), 'accepted');
    if (i === 103) assert.equal(store.submit(i, upload, submittedAt, 1_000_000), 'accepted');
  }
  advance(1000);
  const path = '/api/leaderboard/speeds';
  const result = await call(path);
  const { rows } = await result.json();
  assert.equal(rows.length, 20);
  assert.deepEqual(rows.slice(0, 2).map(row => [row.username, row.avgTps, row.topCli, row.deltaTokens]),
    [['user105', 105, 'codex', 12_345], ['user103', 103, 'codex', 501]]);
  assert.equal(rows.filter(row => row.username === 'user103').length, 1);
  assert.equal(rows.at(-1).username, 'user85');
  const snapshot = await (await call('/api/leaderboard/snapshot')).json();
  assert.deepEqual(snapshot.boards[0].rows, rows);
  assert.equal((await call(path, { headers: { 'If-None-Match': result.headers.get('etag') } })).status, 304);
  advance(5 * 60_000);
  assert.equal((await (await call(path)).json()).rows.length, 20);
  assert.equal((await (await call('/api/today?stats=1')).json()).rows.every(row => row.recent.points.length === 0), true);
  advance(SPEED_WINDOW_MS - 5 * 60_000 - 1000);
  const shifted = (await (await call(path)).json()).rows;
  assert.equal(shifted.length, 20);
  assert.equal(shifted[0].username, 'user103');
  assert.equal(shifted.at(-1).username, 'user84');
  assert.equal(store.setBan(1, 103, true, clock(), 'test'), true);
  assert.equal((await (await call(path)).json()).rows[0].username, 'user102');
  advance(1000);
  assert.deepEqual((await (await call(path)).json()).rows, []);
});

test('speed ranking takes one best result per GitHub account across devices and falls back when it expires', async t => {
  const { call, advance, clock, store } = await fixture(t);
  const first = clock();
  store.upsertAccount({ id: 1, login: 'alice' });
  store.upsertAccount({ id: 2, login: 'bob' });
  const laptop = randomUUID(), desktop = randomUUID(), bobDevice = randomUUID();
  const submit = (account, installationId, at, avgTps, topModel, topCli, deltaTokens) =>
    store.submit(account, { day: leaderboardDay(at), tokens: 1000, requestId: randomUUID(),
      fingerprint: randomUUID(), installationId, stats: { avgTps, topModel, topCli, deltaTokens } }, at, 1_000_000);
  assert.equal(submit(1, laptop, first, 110, 'fast-model', 'codex', 601), 'accepted');
  assert.equal(submit(2, bobDevice, first + 1, 100, 'other-model', 'claude', 777), 'accepted');
  assert.equal(submit(1, desktop, first + 10_000, 95, 'next-model', 'pi', 720), 'accepted');
  assert.equal(submit(1, desktop, first + 20_000, 200, 'too-small', 'pi', 500), 'accepted');
  advance(20_000);
  const compact = rows => rows.map(({ rank, username, avgTps, topModel, topCli, deltaTokens }) =>
    [rank, username, avgTps, topModel, topCli, deltaTokens]);
  const path = '/api/leaderboard/speeds';
  const initial = await call(path);
  const { rows } = await initial.json();
  assert.deepEqual(compact(rows), [
    [1, 'alice', 110, 'fast-model', 'codex', 601], [2, 'bob', 100, 'other-model', 'claude', 777]
  ]);
  assert.deepEqual((await (await call('/api/leaderboard/snapshot')).json()).boards[0].rows, rows);
  advance(SPEED_WINDOW_MS - 20_000);
  const shifted = await call(path, { headers: { 'If-None-Match': initial.headers.get('etag') } });
  assert.equal(shifted.status, 200);
  assert.deepEqual(compact((await shifted.json()).rows), [
    [1, 'bob', 100, 'other-model', 'claude', 777], [2, 'alice', 95, 'next-model', 'pi', 720]
  ]);
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

test('rolling windows move past 01:10 with exact boundaries for 24 hours, 7 days and 30 days', async t => {
  const { call, advance, clock, login, store } = await fixture(t);
  const token = await login();
  const cutoff = START + HOUR_MS + 10 * 60_000;
  advance(cutoff - clock());
  const day = cutoff - 24 * HOUR_MS, week = cutoff - 168 * HOUR_MS, month = cutoff - 720 * HOUR_MS;
  const installationId = randomUUID();
  const patch = (buckets, version = 1, requestId = randomUUID()) => call('/api/leaderboard/rolling-data', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': requestId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ installationId, version, buckets, coverage: [month, cutoff] })
  });
  const buckets = [[month - 1, 1], [month, 2], [month + 1, 4], [week - 1, 8], [week, 16], [week + 1, 32],
    [day - 1, 64], [day, 128], [day + 1, 256], [cutoff - 1, 512], [cutoff, 1024]];
  const requestId = randomUUID();
  assert.equal((await patch(buckets, 1, requestId)).status, 201);
  assert.equal((await patch(buckets, 1, requestId)).status, 201);
  assert.equal((await patch([[cutoff - 1, 1]], 1)).status, 409);
  const board = async hours => (await call(`/api/leaderboard/rolling?hours=${hours}`)).json();
  for (const [hours, from, tokens] of [[24, day, 896], [168, week, 1008], [720, month, 1022]]) {
    const result = await board(hours);
    assert.deepEqual([result.windowStart, result.cutoffAt, result.nextAt], [from, cutoff, cutoff + RANKING_REFRESH_MS]);
    assert.equal(result.rows[0].tokens, tokens);
    assert.equal(result.rows[0].complete, true);
    if (hours > 24) {
      assert.equal(result.rows[0].daily[0].at, from);
      assert.equal(result.rows[0].daily.length, hours / 24);
      assert.equal(result.rows[0].daily.reduce((sum, point) => sum + point.tokens, 0), tokens);
    }
  }
  advance(1);
  for (const [hours, tokens] of [[24, 1792], [168, 2016], [720, 2044]]) {
    const result = await board(hours);
    assert.equal(result.cutoffAt, cutoff + 1);
    assert.equal(result.rows[0].tokens, tokens);
  }
  store.removeScores(1, { day: TODAY, account: 1 }, clock());
  assert.equal((await patch([[cutoff, 90]], 2)).status, 201);
  assert.equal((await board(24)).rows[0].tokens, 256);
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

test('one upload carries the daily score and rolling data, and retrying it counts neither twice', async t => {
  const { call, login, clock } = await fixture(t);
  const token = await login();
  const installationId = randomUUID(), at = clock() - 25;
  const packet = {
    daily: { requestId: randomUUID(), body: { day: TODAY, installationId, tokens: 1000 } },
    rolling: { requestId: randomUUID(), body: { installationId, version: 1, buckets: [[at, 1000]] } }
  };
  const send = () => call('/api/leaderboard/uploads', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(packet) });
  for (let attempt = 0; attempt < 2; attempt++) {
    const reply = await send();
    assert.equal(reply.status, 200);
    const { daily, rolling } = await reply.json();
    assert.equal(daily.code, 'accepted');
    assert.equal(rolling.code, 'accepted');
  }
  const { boards } = await (await call('/api/leaderboard/snapshot')).json();
  for (const hours of [24, 168, 720]) assert.equal(boards[hours].rows[0].tokens, 1000);
});

test('hourly source batches write each changed hour once, preserve older data and publish four aligned boards', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tps-hourly-source-'));
  const filename = path.join(dir, 'test.sqlite'), store = openLeaderboardStore(filename);
  const probe = new DatabaseSync(filename);
  t.after(async () => { probe.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  probe.exec(`CREATE TABLE write_probe(count INTEGER NOT NULL);
    INSERT INTO write_probe VALUES (0);
    CREATE TRIGGER hour_insert AFTER INSERT ON leaderboard_data WHEN NEW.hour_start>0
      BEGIN UPDATE write_probe SET count=count+1; END;
    CREATE TRIGGER hour_update AFTER UPDATE ON leaderboard_data WHEN NEW.hour_start>0
      BEGIN UPDATE write_probe SET count=count+1; END;`);
  const cutoff = START + 2 * HOUR_MS, hour = cutoff - HOUR_MS;
  const a = randomUUID(), b = randomUUID(), remote = randomUUID();
  store.upsertAccount({ id: 1, login: 'alice' });
  store.addSession('session', 1, 'plugin', cutoff + 2 * HOUR_MS);
  const entry = (receivedAt, reporterId, sourceId, fields) => ({ kind: 'hourly-source', sessionDigest: 'session', receivedAt,
    input: { username: 'alice', reporterId, sourceId, requestId: randomUUID(), fingerprint: 'test', ...fields } });
  const send = (...entries) => store.uploadBatch(entries, 1_000_000);
  const update = (receivedAt, reporter, source, tokens, fields = {}, at = hour) => entry(receivedAt, reporter, source, {
    operation: 'hourly-update', hours: [{ hour: at, tokens, coveredUntil: at + HOUR_MS, updatedAt: receivedAt - 1 }], ...fields
  });
  const sample = (avgTps, at) => ({ id: randomUUID(), at, avgTps, deltaTokens: 700, topModel: 'model', topCli: 'codex' });
  const at = cutoff + 10;
  const first = update(at, a, a, 700, { sample: sample(110, cutoff - 30) });
  const second = update(at + 1, a, a, 900, { sample: sample(95, cutoff - 20) });
  assert.deepEqual(send(first, second).map(row => row.code), ['accepted', 'accepted']);
  assert.equal(probe.prepare('SELECT count FROM write_probe').get().count, 1);
  assert.equal(send(second, first)[0].code, 'accepted');
  assert.equal(probe.prepare('SELECT count FROM write_probe').get().count, 1);
  const earlierHour = cutoff - 3 * HOUR_MS;
  const later = at + 10_100;
  assert.equal(send(update(later, a, a, 50, {}, earlierHour))[0].tokens, 900);
  const lease = time => ({ operation: 'lease', observedAt: time });
  assert.equal(send(entry(at, a, remote, lease(at)))[0].leaseEpoch, 1);
  assert.equal(send(entry(at + 1, b, remote, lease(at + 1)))[0].code, 'standby');
  const remoteAt = later + 10_100;
  assert.equal(send(update(remoteAt, a, remote, 100, { leaseEpoch: 1 }))[0].code, 'accepted');
  const takeover = at + 60_100;
  assert.equal(send(entry(takeover, b, remote, lease(takeover)))[0].leaseEpoch, 2);
  assert.equal(send(update(takeover, a, remote, 800, { leaseEpoch: 1 }))[0].code, 'lease_expired');
  assert.equal(send(update(takeover, b, remote, 60, { leaseEpoch: 2,
    hours: [{ hour, tokens: 60, updatedAt: takeover, coveredUntil: hour + HOUR_MS - 1 }] }))[0].code, 'rescan');
  assert.equal(send(update(takeover + 1, b, remote, 200, { leaseEpoch: 2 }))[0].code, 'accepted');
  const { snapshot, revision } = createPublishedSnapshot(store, cutoff);
  assert.equal(snapshot.nextAt, cutoff + HOUR_MS);
  assert.deepEqual([24, 168, 720].map(window => snapshot.boards[window].rows[0].tokens), [1150, 1150, 1150]);
  assert.equal(snapshot.boards[0].rows[0].avgTps, 110);
  assert.ok(store.publishHourlyResult(cutoff, takeover, JSON.stringify(snapshot), revision));
  const reader = openLeaderboardStore(filename, { readOnly: true });
  try { assert.deepEqual(JSON.parse(reader.leaderboardData.latestResult()), snapshot); }
  finally { reader.close(); }
  store.removeScores(1, { day: TODAY, account: 1 }, takeover + 1);
  assert.equal(store.leaderboardData.latestResult(), undefined);
  assert.equal(store.publishHourlyResult(cutoff, takeover + 2, JSON.stringify(snapshot), revision), false);
});

test('hourly migration imports verified source totals once and leaves mixed uploads on the old path', t => {
  const store = openLeaderboardStore(':memory:');
  t.after(() => store.close());
  const now = START + HOUR_MS + 10_000, source = randomUUID();
  const send = (kind, sessionDigest, receivedAt, input) => store.uploadBatch([{ kind, sessionDigest, receivedAt,
    input: { requestId: randomUUID(), fingerprint: 'test', ...input } }], 1_000_000)[0];
  store.upsertAccount({ id: 1, login: 'alice' });
  store.upsertAccount({ id: 2, login: 'bob' });
  store.addSession('alice', 1, 'plugin', now + HOUR_MS);
  store.addSession('bob', 2, 'plugin', now + HOUR_MS);
  const rolling = { reporterId: source, operations: [{ type: 'update', sourceId: source, sourceKind: 'local', revision: 1,
    coverage: [START, now], daily: [{ day: TODAY, tokens: 150 }], buckets: [[START + 25, 100], [START + 38, 50]] }] };
  assert.equal(send('sources', 'alice', now, rolling).results[0].code, 'accepted');
  assert.equal(store.canUseHourlySources(1, now), true);
  const changedAt = now + 11_000, changedHour = hourStart(changedAt);
  const update = username => ({ username, sourceId: source, reporterId: source, operation: 'hourly-update',
    hours: [{ hour: changedHour, updatedAt: changedAt, coveredUntil: changedAt, tokens: 20 }] });
  assert.equal(send('daily', 'bob', now, { day: TODAY, tokens: 60, installationId: source }).code, 'accepted');
  assert.equal(store.canUseHourlySources(2, now), false);
  assert.equal(send('hourly-source', 'bob', changedAt, update('bob')).code, 'migration_required');
  assert.equal(send('hourly-source', 'alice', changedAt, update('alice')).tokens, 170);
  assert.equal(send('sources', 'alice', changedAt + 11_000, rolling).code, 'upgrade_required');
  assert.equal(createPublishedSnapshot(store, changedHour).snapshot.boards[24].rows[0].tokens, 150);
  assert.equal(store.ranking(2, changedAt).tokens, 60);
});

test('the scheduled hourly publication excludes the next batch until it has pinned its read', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tps-hourly-publication-'));
  const filename = path.join(dir, 'test.sqlite'), store = openLeaderboardStore(filename);
  const cutoff = START + 3 * HOUR_MS, hour = cutoff - 2 * HOUR_MS;
  let clock = cutoff - 30;
  const jobs = createLeaderboardJobs({ filename, maxTokens: 1_000_000,
    now: () => clock, readPublished: store.leaderboardData.latestResult });
  t.after(async () => { await jobs.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  store.upsertAccount({ id: 1, login: 'alice' });
  store.upsertAccount({ id: 2, login: 'bob' });
  store.addSession('alice', 1, 'plugin', cutoff + HOUR_MS);
  store.addSession('bob', 2, 'plugin', cutoff + HOUR_MS);
  const entry = (username, receivedAt, tokens) => {
    const id = randomUUID();
    return { kind: 'hourly-source', sessionDigest: username, receivedAt, input: {
      username, requestId: randomUUID(), fingerprint: 'test', sourceId: id, reporterId: id,
      operation: 'hourly-update', hours: [{ hour, coveredUntil: hour + HOUR_MS, updatedAt: receivedAt, tokens }]
    } };
  };
  const before = jobs.submit([entry('alice', cutoff - 1, 700)]);
  const after = jobs.submit([entry('bob', cutoff, 900)]);
  clock = cutoff;
  assert.equal((await before)[0].code, 'accepted');
  for (let i = 0; i < 160; i++) {
    if (JSON.parse(jobs.snapshot() ?? 'null')?.cutoffAt === cutoff) break;
    await delay(20);
  }
  const published = JSON.parse(jobs.snapshot());
  assert.equal(published.cutoffAt, cutoff);
  assert.deepEqual(published.boards[24].rows.map(row => row.tokens), [700]);
  clock += 2_001;
  assert.equal((await after)[0].code, 'accepted');
  assert.equal(store.status(2, clock).tokens, 900);
  assert.deepEqual(JSON.parse(jobs.snapshot()).boards[24].rows.map(row => row.tokens), [700]);
});

test('the format 4 uploader keeps failed packets and their clock values across a restart', async t => {
  const api = await fixture(t);
  const local = openLocalUsageDb(':memory:');
  t.after(() => local.close());
  const reporter = randomUUID();
  const credential = await api.login();
  const upload = createHourlySourceUploader(createSqliteUploadStorage(local.queue,
    { origin: api.endpoint, accountId: 1 }, 'pending-hourly'), reporter, () => 'alice');
  api.advance(10_000);
  const at = api.clock(), hour = hourStart(at);
  const read = async () => [{ sourceId: reporter, hours: [{ hour, tokens: 700, updatedAt: at, coveredUntil: at }] }];
  const send = async body => (await (await api.call('/api/leaderboard/uploads', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential}` }, body: JSON.stringify(body)
  })).json());
  let sent;
  const first = await upload({ now: at, active: () => true, read, send: async body => {
    sent = body;
    assert.equal((await send(body)).code, 'accepted');
    return { code: 'unavailable' };
  } });
  assert.equal(first.code, 'unavailable');
  const restart = createHourlySourceUploader(createSqliteUploadStorage(local.queue,
    { origin: api.endpoint, accountId: 1 }, 'pending-hourly'), reporter, () => 'alice');
  api.advance(11_000);
  const replay = await restart({ now: api.clock(), active: () => true, read, send: async body => {
    assert.deepEqual(body, sent);
    return send(body);
  } });
  assert.equal(replay.code, 'accepted');
  assert.equal(replay.tokens, 700);
  assert.equal(local.queue.next({ origin: api.endpoint, accountId: 1 }, 'pending-hourly'), undefined);
});

test('the plugin selects hourly uploads when the server and local usage index support them', async t => {
  const api = await fixture(t);
  const db = openLocalUsageDb(':memory:'), storage = new Map(), secrets = new Map(), packets = [];
  const own = randomUUID();
  let handler;
  const stop = startLeaderboard({
    storage: { get: async key => storage.get(key), set: async (key, value) => storage.set(key, value),
      delete: async key => storage.delete(key) },
    host: { has: () => true, call: async (method, { key, value }) => {
      if (method === 'secrets.get') return { value: secrets.get(key) };
      if (method === 'secrets.set') return secrets.set(key, value);
    } },
    grantedCapabilities: ['secrets:own'],
    panels: { handle: (_, fn) => { handler = fn; return { dispose() {} }; } }
  }, {
    localDb: db, reporterGuid: own, endpoint: api.endpoint, now: () => new Date(api.clock()),
    readUsage: async () => ({ day: TODAY, tokens: 700 }),
    readUsageSources: async () => { throw new Error('unexpected compatibility upload'); },
    readUsageHours: async () => [{ sourceId: own, hours: [{ hour: hourStart(api.clock()), tokens: 700,
      updatedAt: api.clock(), coveredUntil: api.clock() }] }],
    fetcher: async (url, options) => {
      if (options.body && url.pathname === '/api/leaderboard/uploads') packets.push(JSON.parse(options.body));
      return fetch(url, options);
    }
  });
  t.after(async () => { await stop(); db.close(); });
  await api.authorizePlugin((await handler({ action: 'login' })).loginUrl, 'alice');
  assert.equal((await handler({ action: 'poll' })).code, 'signed_in');
  api.advance(10_000);
  assert.equal((await handler({ action: 'sync' })).code, 'accepted');
  assert.equal(packets.length, 1);
  assert.equal(packets[0].deviceGuid, own);
  assert.equal(packets[0].data.format, 4);
  assert.equal(api.store.status(1, api.clock()).tokens, 700);
});

test('format 2 counts shared SSH once and a stale writer cannot overwrite a staged replacement', async t => {
  const { call, login, clock, advance } = await fixture(t);
  const token = await login(), other = await login();
  const a = randomUUID(), b = randomUUID(), ssh = randomUUID(), at = clock() - 30, span = 720 * HOUR_MS;
  const packet = (reporterId, operations) => ({ format: 2, reporterId, requestId: randomUUID(), operations });
  const send = async (body, credential = token) => (await call('/api/leaderboard/uploads', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential}` }, body: JSON.stringify(body) })).json();
  const lease = () => ({ type: 'lease', sourceId: ssh, observedAt: clock() });
  const row = (sourceId, sourceKind, tokens, leaseEpoch, revision = 1) => ({
    type: 'update', sourceId, sourceKind, leaseEpoch, revision, daily: [{ day: TODAY, tokens }], buckets: [[at, tokens]]
  });
  const rank = async tokens => {
    const daily = await (await call('/api/today')).json();
    assert.equal(daily.rows[0].tokens, tokens);
    const { boards } = await (await call('/api/leaderboard/snapshot')).json();
    for (const hours of [24, 168, 720]) assert.equal(boards[hours].rows[0].tokens, tokens);
  };
  const first = packet(a, [lease(), row(a, 'local', 30), row(ssh, 'ssh', 100, 1)]);
  const initial = await send(first);
  assert.deepEqual(initial.results.map(item => item.code), ['accepted', 'accepted', 'accepted']);
  assert.deepEqual((await send(first)).results, initial.results);
  assert.equal((await send({ ...first, operations: [lease()] })).code, 'invalid');
  advance(10_000);
  const second = await send(packet(b, [lease(), row(b, 'local', 20)]));
  assert.deepEqual(second.results.map(item => item.code), ['standby', 'accepted']);
  await rank(150);
  const separate = await send(packet(a, [lease(), row(ssh, 'ssh', 70, 1)]), other);
  assert.deepEqual(separate.results.map(item => item.code), ['accepted', 'accepted']);
  await rank(150);
  advance(50_000);
  const swap = await send(packet(b, [lease()]));
  assert.equal(swap.results[0].baseline, true);
  assert.equal(swap.results[0].leaseEpoch, 2);
  const snapshotId = randomUUID(), coverage = [clock() - span, clock()];
  const part = { ...row(ssh, 'ssh', 90, 2), type: 'baseline-part', purpose: 'handover', snapshotId,
    coverage, partIndex: 0, partCount: 2 };
  const commit = { type: 'baseline-commit', sourceId: ssh, snapshotId, coverage, leaseEpoch: 2 };
  assert.equal((await send(packet(b, [part, commit]))).results[1].code, 'baseline_required');
  await rank(150);
  const rest = { ...part, partIndex: 1, daily: [], buckets: [] };
  assert.equal((await send(packet(b, [rest, commit]))).results[1].code, 'accepted');
  await rank(140);
  advance(10_000);
  assert.equal((await send(packet(a, [row(ssh, 'ssh', 800, 1, 100)]))).results[0].code, 'lease_expired');
  assert.equal((await send(packet(a, [row(b, 'local', 100)]))).results[0].code, 'invalid');
  assert.equal((await send(packet(a, [{ ...row(a, 'local', 50), ignored: 'a'.repeat(USAGE_UPLOAD_BYTES) }]))).code, 'invalid');
  await rank(140);
});

test('format 3 accepts one source and resolves replays and GitHub renames by account ID', async t => {
  const { call, login, clock, advance, store } = await fixture(t);
  const token = await login();
  const a = randomUUID(), b = randomUUID(), ssh = randomUUID(), at = clock() - 25;
  const send = async body => (await call('/api/leaderboard/uploads', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body)
  })).json();
  const packet = (deviceGuid, operation, fields, username = 'alice') =>
    ({ username, deviceGuid, data: { format: 3, operation, requestId: randomUUID(), ...fields } });
  const update = (tokens, revision = 1) => ({ revision, daily: [{ day: TODAY, tokens }], buckets: [[at, tokens]] });
  const old = packet(a, 'update', update(30));
  assert.equal((await send(old)).results[0].code, 'accepted');
  assert.equal((await send({ ...old, data: { ...old.data, buckets: [[at, 300]] } })).code, 'invalid');
  assert.equal((await send(packet(a, 'update', { ...update(30), sourceId: ssh }))).code, 'invalid');
  const status = await (await call('/api/today/status', { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.deepEqual([status.uploadFormat, status.accountId], [3, 1]);
  advance(10_000);
  assert.equal((await send(packet(b, 'update', update(20)))).results[0].code, 'accepted');
  advance(10_000);
  const grant = await send(packet(ssh, 'lease', { reporterGuid: a, observedAt: clock() }));
  const leaseEpoch = grant.results[0].leaseEpoch;
  assert.equal((await send(packet(ssh, 'update', { ...update(100), reporterGuid: a, leaseEpoch }))).results[0].code, 'accepted');
  assert.equal((await send(packet(ssh, 'lease', { reporterGuid: b, observedAt: clock() }))).results[0].code, 'standby');
  const { boards } = await (await call('/api/leaderboard/snapshot')).json();
  for (const hours of [24, 168, 720]) assert.equal(boards[hours].rows[0].tokens, 150);
  assert.equal(store.ranking(1, clock()).tokens, 150);
  store.upsertAccount({ id: 1, login: 'alice-new' });
  assert.equal((await send(old)).results[0].code, 'accepted');
  assert.equal((await send(packet(a, 'update', update(50, 2)))).code, 'username_changed');
  advance(10_000);
  assert.equal((await send(packet(ssh, 'update', { ...update(130, 2), reporterGuid: a, leaseEpoch }, 'alice-new'))).results[0].code, 'accepted');
  advance(10_000);
  assert.equal((await send(packet(ssh, 'update', { ...update(900), reporterGuid: a, leaseEpoch }, 'alice-new'))).results[0].code, 'stale_version');
  assert.equal(store.ranking(1, clock()).tokens, 180);
  advance(40_000);
  const next = (await send(packet(ssh, 'lease', { reporterGuid: b, observedAt: clock() }, 'alice-new'))).results[0];
  assert.equal(next.baseline, true);
  assert.ok(next.leaseEpoch > leaseEpoch);
  const snapshotId = randomUUID();
  const coverage = [clock() - 720 * HOUR_MS, clock()];
  const baseline = { reporterGuid: b, leaseEpoch: next.leaseEpoch, snapshotId, coverage };
  const part = { ...baseline, purpose: 'handover', partIndex: 0, partCount: 1, ...update(140) };
  delete part.revision;
  assert.equal((await send(packet(ssh, 'baseline-part', part, 'alice-new'))).results[0].code, 'accepted');
  assert.equal(store.ranking(1, clock()).tokens, 180);
  assert.equal((await send(packet(ssh, 'baseline-commit', baseline, 'alice-new'))).results[0].code, 'accepted');
  advance(10_000);
  assert.equal((await send(packet(ssh, 'update', { ...update(999, 500), reporterGuid: a, leaseEpoch }, 'alice-new'))).results[0].code, 'lease_expired');
  assert.equal(store.ranking(1, clock()).tokens, 190);
});

test('source upload resumes a lost response and waits for both old devices before replacing mixed counts', async t => {
  const { call, login, clock, advance } = await fixture(t);
  const credential = await login();
  const a = randomUUID(), b = randomUUID(), ssh = randomUUID(), at = clock() - 25;
  async function post(route, body, requestId) {
    return (await call(route, { method: 'POST', headers: { 'Content-Type': 'application/json',
      Authorization: `Bearer ${credential}`, ...(requestId ? { 'idempotency-key': requestId } : {}) }, body: JSON.stringify(body) })).json();
  }
  for (const [installationId, tokens] of [[a, 130], [b, 120]]) {
    const reply = await post('/api/leaderboard/uploads', {
      daily: { requestId: randomUUID(), body: { day: TODAY, installationId, tokens } },
      rolling: { requestId: randomUUID(), body: { installationId, version: 1, buckets: [[at, tokens]] } }
    });
    assert.equal(reply.daily.code, 'accepted');
    advance(10_000);
  }
  const score = async () => (await (await call('/api/today')).json()).rows[0].tokens;
  assert.equal(await score(), 250);
  const view = (sourceId, sourceKind, tokens) => ({ sourceId, sourceKind, daily: [{ day: TODAY, tokens }],
    buckets: [[at, tokens]], observedAt: clock(), coverage: [clock() - 720 * HOUR_MS, clock()] });
  const stores = new Map([a, b].map(id => [id, new Map()]));
  const uploader = id => createSourceUploader({
    get: async key => stores.get(id).get(key), set: async (key, value) => stores.get(id).set(key, value),
    delete: async key => stores.get(id).delete(key)
  }, 'fixture/' + id, id);
  let clientA = uploader(a), clientB = uploader(b), lost;
  const read = id => async () => [view(id, 'local', id === a ? 30 : 20), view(ssh, 'ssh', 100)];
  const run = async (client, id, send = body => post('/api/leaderboard/uploads', body)) => {
    const result = await client({ now: clock(), read: read(id), send, active: () => true });
    advance(10_000);
    return result;
  };
  const missed = await run(clientA, a, async body => {
    const response = await post('/api/leaderboard/uploads', body);
    if (body.operations[0].type === 'migration-status') return response;
    lost = body;
    return { code: 'unavailable' };
  });
  assert.equal(missed.code, 'unavailable');
  clientA = uploader(a);
  await run(clientA, a, async body => {
    assert.deepEqual(body, lost);
    return post('/api/leaderboard/uploads', body);
  });
  await run(clientA, a);
  assert.equal(await score(), 250);
  await run(clientA, a);
  assert.equal(await score(), 250);
  for (let index = 0; index < 4 && await score() === 250; index++) await run(clientB, b);
  assert.equal(await score(), 150);
  const { boards } = await (await call('/api/leaderboard/snapshot')).json();
  assert.equal(boards[24].rows[0].tokens, 150);
  assert.equal((await post('/api/today/submit', { day: TODAY, installationId: a, tokens: 130 }, randomUUID())).code, 'upgrade_required');
});

test('source staging survives a server restart and rejects an outdated migration check', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tps-migration-'));
  const db = path.join(dir, 'test.sqlite'), id = randomUUID();
  const now = START + HOUR_MS, at = now - 1000;
  let store = openLeaderboardStore(db);
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  store.upsertAccount({ id: 1, login: 'alice' });
  store.addSession('session', 1, 'plugin', now + HOUR_MS);
  const send = (receivedAt, ...operations) => {
    const requestId = randomUUID();
    const [{ results }] = store.uploadBatch([{ kind: 'sources', sessionDigest: 'session', receivedAt,
      input: { reporterId: id, requestId, fingerprint: requestId, operations } }], 1_000_000);
    return results;
  };
  const old = (tokens, receivedAt) => {
    const requestId = randomUUID();
    return store.submit(1, { day: TODAY, installationId: id, tokens, requestId, fingerprint: requestId }, receivedAt, 1_000_000);
  };
  assert.equal(old(130, now), 'accepted');
  const snapshotId = randomUUID();
  const part = { type: 'baseline-part', purpose: 'migration', snapshotId, sourceId: id, sourceKind: 'local',
    partCount: 2, partIndex: 0, coverage: [now + 10_000 - 720 * HOUR_MS, now + 10_000], daily: [{ day: TODAY, tokens: 130 }],
    buckets: [[at, 130]] };
  const [status] = send(now + 10_000, { type: 'migration-status' }, part);
  store.close();
  store = openLeaderboardStore(db);
  assert.equal(send(now + 20_000, { type: 'migration-status' })[0].staged[0].received, 1);
  assert.equal(send(now + 20_000, { ...part, partIndex: 1, daily: [], buckets: [] })[0].code, 'accepted');
  assert.equal(old(140, now + 30_000), 'accepted');
  const commit = { type: 'migration-commit', legacyVersions: status.legacyVersions, snapshots: [snapshotId] };
  assert.equal(send(now + 40_000, commit)[0].code, 'migration_changed');
  const [updated] = send(now + 40_000, { type: 'migration-status' });
  assert.equal(send(now + 50_000, { ...commit, legacyVersions: updated.legacyVersions })[0].code, 'migration_pending');
  assert.equal(store.ranking(1, now + 50_000).tokens, 140);
  store.removeScores(1, { account: 1, day: TODAY }, now + 51_000);
  assert.equal(send(now + 60_000, { ...commit, legacyVersions: updated.legacyVersions })[0].code, 'migration_changed');
  const [afterRemoval] = send(now + 60_000, { type: 'migration-status' });
  assert.equal(send(now + 70_000, { ...commit, legacyVersions: afterRemoval.legacyVersions })[0].code, 'accepted');
  assert.equal(store.ranking(1, now + 70_000).tokens, null);
  assert.deepEqual(store.hourly.rollingRanking(24, now + 70_000).rows, []);
});

test('the plugin negotiates source uploads and publishes data without sending its mixed total', async t => {
  const api = await fixture(t);
  const storage = new Map(), secrets = new Map(), calls = [];
  let handler;
  const sourceId = randomUUID();
  const stop = startLeaderboard({
    storage: { get: async key => storage.get(key), set: async (key, value) => storage.set(key, value),
      delete: async key => storage.delete(key) },
    host: { has: () => true, call: async (method, { key, value }) => {
      if (method === 'secrets.get') return { value: secrets.get(key) };
      if (method === 'secrets.set') return secrets.set(key, value);
    } },
    grantedCapabilities: ['secrets:own'],
    panels: { handle: (_, fn) => { handler = fn; return { dispose() {} }; } }
  }, {
    endpoint: api.endpoint, now: () => new Date(api.clock()),
    readUsage: async () => ({ day: TODAY, tokens: 230 }),
    readUsageSources: async id => [[id, 'local', 30], [sourceId, 'ssh', 100]].map(([sourceId, sourceKind, tokens]) => ({
      sourceId, sourceKind, observedAt: api.clock(), coverage: [api.clock() - 720 * HOUR_MS, api.clock()],
      daily: [{ day: TODAY, tokens }], buckets: [[START + 1000, tokens]]
    })),
    fetcher: async (url, options) => {
      if (options.body) calls.push([url.pathname, JSON.parse(options.body)]);
      return fetch(url, options);
    }
  });
  t.after(() => stop());
  await api.authorizePlugin((await handler({ action: 'login' })).loginUrl, 'alice');
  assert.equal((await handler({ action: 'poll' })).code, 'signed_in');
  await handler({ action: 'sync' });
  api.advance(10_000);
  await handler({ action: 'sync' });
  assert.equal((await (await api.call('/api/today')).json()).rows[0].tokens, 130);
  assert.ok(calls.some(([route, body]) => route === '/api/leaderboard/uploads' && body.format === 2));
  assert.ok(calls.every(([route]) => route !== '/api/today/submit' && route !== '/api/history/init'));
});

test('the plugin uses format 3 with local SQLite and sends the two source GUIDs in separate requests', async t => {
  const api = await fixture(t);
  const db = openLocalUsageDb(':memory:'), storage = new Map(), secrets = new Map(), calls = [];
  const own = randomUUID(), ssh = randomUUID();
  let handler;
  const stop = startLeaderboard({
    storage: { get: async key => storage.get(key), set: async (key, value) => storage.set(key, value) },
    host: { has: () => true, call: async (method, { key, value }) => {
      if (method === 'secrets.get') return { value: secrets.get(key) };
      if (method === 'secrets.set') return secrets.set(key, value);
    } },
    grantedCapabilities: ['secrets:own'],
    panels: { handle: (_, fn) => { handler = fn; return { dispose() {} }; } }
  }, {
    localDb: db, reporterGuid: own, endpoint: api.endpoint, now: () => new Date(api.clock()),
    readUsage: async () => ({ day: TODAY, tokens: 130 }),
    readUsageSources: async () => [[own, 'local', 30], [ssh, 'ssh', 100]].map(([sourceId, sourceKind, tokens]) => ({
      sourceId, sourceKind, observedAt: api.clock(), coverage: [api.clock() - 720 * HOUR_MS, api.clock()],
      daily: [{ day: TODAY, tokens }], buckets: [[START + 1000, tokens]]
    })),
    fetcher: async (url, options) => {
      if (options.body && url.pathname === '/api/leaderboard/uploads') calls.push(JSON.parse(options.body));
      return fetch(url, options);
    }
  });
  t.after(async () => { await stop(); db.close(); });
  await api.authorizePlugin((await handler({ action: 'login' })).loginUrl, 'alice');
  assert.equal((await handler({ action: 'poll' })).code, 'signed_in');
  for (let index = 0; index < 6 && api.store.ranking(1, api.clock()).tokens !== 130; index++) {
    await handler({ action: 'sync' });
    api.advance(10_000);
  }
  assert.equal(api.store.ranking(1, api.clock()).tokens, 130);
  const packets = calls.filter(body => body.data?.format === 3);
  const updates = packets.filter(body => body.data.operation === 'update');
  assert.deepEqual(new Set(updates.map(body => body.deviceGuid)), new Set([own, ssh]));
  assert.ok(packets.every(body => Object.keys(body).join() === 'username,deviceGuid,data' && body.username === 'alice'));
  assert.equal(updates.find(body => body.deviceGuid === ssh).data.reporterGuid, own);
  assert.equal(db.queue.next({ origin: api.endpoint, accountId: 1 }), undefined);
  assert.ok([...storage.keys()].every(key => !key.startsWith('leaderboard:sources:')));
});

test('viewer receives every rolling window and the speed board in one download and retains it on failure', async t => {
  const { call, advance, clock } = await fixture(t);
  const requests = [];
  const storage = { get: async () => null, set: async () => {} };
  let offline = false;
  const viewer = createWindowViews({ storage, origin: ORIGIN, now: clock, request: async (route, opts) => {
    requests.push(route);
    if (offline) return { code: 'unavailable' };
    const response = await call(route, { headers: opts.etag ? { 'If-None-Match': opts.etag } : {} });
    const serverTime = Date.parse(response.headers.get('date'));
    return response.status === 304 ? { notModified: true, serverTime } :
      { ...await response.json(), serverTime, etag: response.headers.get('etag') };
  } });
  const signal = new AbortController().signal;
  const first = await viewer.fetch(24, false, signal);
  assert.deepEqual(Object.keys(first.boards).map(Number), [0, 24, 168, 720]);
  assert.equal((await viewer.fetch(168, false, signal)).cutoffAt, first.cutoffAt);
  assert.equal((await viewer.fetch(720, false, signal)).cutoffAt, first.cutoffAt);
  advance(RANKING_REFRESH_MS - 1);
  assert.equal((await viewer.fetch(24, false, signal)).cutoffAt, first.cutoffAt);
  assert.equal(requests.length, 1);
  advance(1);
  offline = true;
  assert.equal((await viewer.fetch(24, false, signal)).code, 'unavailable');
  assert.deepEqual((await viewer.load(24, signal)).boards, first.boards);
  offline = false;
  const second = await viewer.fetch(24, false, signal);
  assert.equal(second.cutoffAt, first.cutoffAt + RANKING_REFRESH_MS);
  assert.equal(second.windowStart, first.windowStart + RANKING_REFRESH_MS);
  assert.deepEqual(requests, Array(3).fill('/api/leaderboard/snapshot'));
});

test('a write worker commits simultaneous uploads together and the ranking worker publishes a full snapshot', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tps-ranking-jobs-'));
  const filename = path.join(directory, 'leaderboard.sqlite');
  const store = openLeaderboardStore(filename);
  const now = Date.now(), first = 'session-first', second = 'session-second';
  store.upsertAccount({ id: 1, login: 'alice' });
  store.upsertAccount({ id: 2, login: 'bob' });
  store.addSession(first, 1, 'plugin', now + HOUR_MS);
  store.addSession(second, 2, 'plugin', now + HOUR_MS);
  let writeBatches = 0;
  const jobs = createLeaderboardJobs({ filename, maxTokens: 1_000_000, onWrite: () => writeBatches++, log: message => t.diagnostic(message) });
  t.after(async () => { await jobs.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const entry = (sessionDigest, tokens) => ({ kind: 'rolling', sessionDigest, receivedAt: now, input: {
    installationId: randomUUID(), version: 1, buckets: [[now - 60_000, tokens]], requestId: randomUUID(), fingerprint: 'test'
  } });
  const pending = Promise.all([jobs.submit([entry(first, 30)]), jobs.submit([entry(second, 40)])]);
  assert.deepEqual(store.hourly.rollingRanking(24, now).rows, []);
  assert.deepEqual((await pending).map(([result]) => result.code), ['accepted', 'accepted']);
  assert.equal(writeBatches, 1);
  const end = Date.now() + 12_000;
  let snapshot;
  do {
    await delay(50);
    snapshot = JSON.parse(jobs.snapshot() || 'null');
  } while (!snapshot?.boards[24].rows.length && Date.now() < end);
  assert.ok(snapshot);
  for (const hours of [24, 168, 720]) {
    assert.equal(snapshot.boards[hours].cutoffAt, snapshot.cutoffAt);
    assert.deepEqual(snapshot.boards[hours].rows.map(row => [row.username, row.tokens]), [['bob', 40], ['alice', 30]]);
  }
  assert.deepEqual(snapshot.boards[0].rows, []);
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createLeaderboardServer } from '../server/app.mjs';
import { createPulseStore, createRedisClient } from '../server/redis.mjs';
import { openLeaderboardStore } from '../server/store.mjs';
import { startLeaderboard } from '../src/leaderboard.mjs';
import { createPulseTracker } from '../src/worker.mjs';
import { leaderboardDay, leaderboardDayStart } from '../src/usage-summary.mjs';

const ORIGIN = 'http://127.0.0.1:8787';
const TODAY = '2026-11-18';
const START = leaderboardDayStart(TODAY);

function createMockRedisServer({ now = Date.now, password = '' } = {}) {
  const strings = new Map();
  const expires = new Map();
  const sets = new Map();
  const zsets = new Map();
  const lists = new Map();

  function purge(key) {
    const exp = expires.get(key);
    if (exp !== undefined && now() >= exp) {
      expires.delete(key);
      strings.delete(key);
      sets.delete(key);
      zsets.delete(key);
      lists.delete(key);
    }
  }

  function encode(value) {
    if (value instanceof Error) return Buffer.from(`-${value.message}\r\n`);
    if (value === null || value === undefined) return Buffer.from('$-1\r\n');
    if (typeof value === 'number') return Buffer.from(`:${value}\r\n`);
    if (Array.isArray(value)) {
      return Buffer.concat([Buffer.from(`*${value.length}\r\n`), ...value.map(encode)]);
    }
    if (typeof value === 'object' && value.simple) return Buffer.from(`+${value.simple}\r\n`);
    const buf = Buffer.from(String(value), 'utf8');
    return Buffer.concat([Buffer.from(`$${buf.length}\r\n`), buf, Buffer.from('\r\n')]);
  }

  function parseArgs(buf, offset = 0) {
    if (offset >= buf.length || buf[offset] !== 0x2a) return null;
    const end = buf.indexOf('\r\n', offset);
    if (end === -1) return null;
    const count = Number(buf.subarray(offset + 1, end).toString('utf8'));
    let pos = end + 2;
    const args = [];
    for (let i = 0; i < count; i += 1) {
      if (pos >= buf.length || buf[pos] !== 0x24) return null;
      const lenEnd = buf.indexOf('\r\n', pos);
      if (lenEnd === -1) return null;
      const len = Number(buf.subarray(pos + 1, lenEnd).toString('utf8'));
      const dataStart = lenEnd + 2;
      if (buf.length < dataStart + len + 2) return null;
      args.push(buf.subarray(dataStart, dataStart + len).toString('utf8'));
      pos = dataStart + len + 2;
    }
    return { args, next: pos };
  }

  function exec(args, state) {
    const cmd = args[0].toUpperCase();
    if (cmd === 'AUTH') {
      const supplied = args.length >= 3 ? args[2] : args[1];
      if (!password || supplied === password) {
        state.authed = true;
        return { simple: 'OK' };
      }
      return new Error('WRONGPASS invalid username-password pair');
    }
    if (password && !state.authed) return new Error('NOAUTH Authentication required');
    if (cmd === 'PING') return { simple: 'PONG' };
    if (cmd === 'SELECT') return { simple: 'OK' };
    if (cmd === 'SET') {
      const [, key, val, ...opts] = args;
      purge(key);
      let exSec = null, nx = false;
      for (let i = 0; i < opts.length; i += 1) {
        const opt = opts[i].toUpperCase();
        if (opt === 'EX') exSec = Number(opts[++i]);
        else if (opt === 'NX') nx = true;
      }
      if (nx && strings.has(key)) return null;
      strings.set(key, val);
      if (exSec !== null) expires.set(key, now() + exSec * 1000);
      return { simple: 'OK' };
    }
    if (cmd === 'GET') {
      purge(args[1]);
      return strings.get(args[1]) ?? null;
    }
    if (cmd === 'MGET') {
      return args.slice(1).map(key => { purge(key); return strings.get(key) ?? null; });
    }
    if (cmd === 'DEL') {
      let deleted = 0;
      for (const key of args.slice(1)) {
        purge(key);
        const existed = strings.delete(key) || sets.delete(key) || zsets.delete(key) || lists.delete(key);
        expires.delete(key);
        if (existed) deleted += 1;
      }
      return deleted;
    }
    if (cmd === 'EXPIRE') {
      const key = args[1], sec = Number(args[2]);
      purge(key);
      if (!strings.has(key) && !sets.has(key) && !zsets.has(key) && !lists.has(key)) return 0;
      expires.set(key, now() + sec * 1000);
      return 1;
    }
    if (cmd === 'SADD') {
      const key = args[1];
      purge(key);
      const set = sets.get(key) ?? new Set();
      let added = 0;
      for (const member of args.slice(2)) if (!set.has(member)) { set.add(member); added += 1; }
      sets.set(key, set);
      return added;
    }
    if (cmd === 'SREM') {
      const key = args[1];
      purge(key);
      const set = sets.get(key);
      if (!set) return 0;
      let removed = 0;
      for (const member of args.slice(2)) if (set.delete(member)) removed += 1;
      return removed;
    }
    if (cmd === 'SMEMBERS') {
      purge(args[1]);
      return [...(sets.get(args[1]) ?? [])];
    }
    if (cmd === 'ZADD') {
      const key = args[1], score = Number(args[2]), member = args[3];
      purge(key);
      const map = zsets.get(key) ?? new Map();
      const added = map.has(member) ? 0 : 1;
      map.set(member, score);
      zsets.set(key, map);
      return added;
    }
    if (cmd === 'ZREM') {
      purge(args[1]);
      const map = zsets.get(args[1]);
      if (!map) return 0;
      let removed = 0;
      for (const member of args.slice(2)) if (map.delete(member)) removed += 1;
      return removed;
    }
    if (cmd === 'ZREMRANGEBYSCORE') {
      const key = args[1];
      const min = args[2] === '-inf' ? -Infinity : Number(args[2]);
      const max = args[3] === '+inf' ? Infinity : Number(args[3]);
      purge(key);
      const map = zsets.get(key);
      if (!map) return 0;
      let removed = 0;
      for (const [member, score] of [...map]) {
        if (score >= min && score <= max) { map.delete(member); removed += 1; }
      }
      return removed;
    }
    if (cmd === 'ZREVRANGE') {
      const key = args[1], start = Number(args[2]), stop = Number(args[3]);
      purge(key);
      const map = zsets.get(key);
      if (!map) return [];
      const sorted = [...map.entries()].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0])).map(([m]) => m);
      return sorted.slice(start, stop < 0 ? undefined : stop + 1);
    }
    if (cmd === 'LPUSH') {
      const key = args[1];
      purge(key);
      const list = lists.get(key) ?? [];
      for (const val of args.slice(2)) list.unshift(val);
      lists.set(key, list);
      return list.length;
    }
    if (cmd === 'LTRIM') {
      const key = args[1], start = Number(args[2]), stop = Number(args[3]);
      purge(key);
      const list = lists.get(key);
      if (!list) return { simple: 'OK' };
      lists.set(key, list.slice(start, stop < 0 ? undefined : stop + 1));
      return { simple: 'OK' };
    }
    if (cmd === 'LRANGE') {
      const key = args[1], start = Number(args[2]), stop = Number(args[3]);
      purge(key);
      const list = lists.get(key) ?? [];
      return list.slice(start, stop < 0 ? undefined : stop + 1);
    }
    return new Error(`ERR unknown command '${cmd}'`);
  }

  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buf = Buffer.alloc(0);
    const state = { authed: !password };
    socket.on('data', chunk => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        const parsed = parseArgs(buf, 0);
        if (!parsed) break;
        buf = buf.subarray(parsed.next);
        socket.write(encode(exec(parsed.args, state)));
      }
    });
  });

  return {
    server,
    async listen() {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      return `redis://${password ? `:${password}@` : ''}127.0.0.1:${server.address().port}/0`;
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  };
}

test('Redis pulse store records waves, enforces marquee cooldown, merges devices, and expires idle users', async t => {
  let clock = START + 3600_000;
  const mockRedis = createMockRedisServer({ now: () => clock, password: 'test-secret' });
  const redisUrl = await mockRedis.listen();
  t.after(() => mockRedis.close());

  const client = createRedisClient(redisUrl, { now: () => clock });
  const store = createPulseStore({ client, now: () => clock });
  t.after(() => store.close());

  assert.equal(await client.command('PING'), 'PONG');
  const dev1 = randomUUID(), dev2 = randomUUID();
  assert.deepEqual(await store.recordPulse({ accountId: 1, username: 'alice', installationId: dev1, tps: 88.46, burstTokens: 1200 }), { ok: true, available: true });
  clock += 2000;
  // Second pulse within 5s should append to wave & sum device burst, but not spam marquee.
  await store.recordPulse({ accountId: 1, username: 'alice', installationId: dev2, tps: 112.3, burstTokens: 3000 });
  clock += 4000;
  // After 5s cooldown, next pulse emits a new marquee event.
  await store.recordPulse({ accountId: 2, username: 'bob', installationId: dev1, tps: 64.1, burstTokens: 900 });
  await store.recordPulse({ accountId: 1, username: 'alice', installationId: dev1, tps: 120.0, burstTokens: 800 });

  const snap = await store.readSnapshot();
  assert.equal(snap.available, true);
  assert.equal(snap.activeCount, 2);
  assert.equal(snap.users[0].username, 'alice');
  assert.equal(snap.users[0].tps, 120);
  assert.equal(snap.users[0].burstTokens, 3800);
  assert.equal(snap.users[0].wave.length, 3);
  assert.ok(snap.users[0].wave[0][0] < snap.users[0].wave[2][0]);
  assert.equal(snap.marquee.length, 3);

  // Advance past 30s TTL: both active devices expire and activeCount returns to 0.
  clock += 35_000;
  const idleSnap = await store.readSnapshot();
  assert.equal(idleSnap.available, true);
  assert.equal(idleSnap.activeCount, 0);
  assert.deepEqual(idleSnap.users, []);

  // Online presence pulse (tps=0, burst=0) registers user immediately and respects 60s marquee cooldown.
  await store.recordPulse({ accountId: 3, username: 'carol', installationId: dev1, tps: 0, burstTokens: 0 });
  clock += 12_000;
  await store.recordPulse({ accountId: 3, username: 'carol', installationId: dev1, tps: 0, burstTokens: 0 });
  const onlineSnap = await store.readSnapshot();
  assert.equal(onlineSnap.activeCount, 1);
  assert.equal(onlineSnap.users[0].username, 'carol');
  assert.equal(onlineSnap.users[0].wave.length, 2);
  assert.equal(onlineSnap.users[0].wave[0][3], 1);
  assert.equal(onlineSnap.marquee.filter(m => m.username === 'carol').length, 1);
});

test('server exposes /api/pulse and /api/pulse/stream without affecting SQLite cooldowns and degrades gracefully if Redis drops', async t => {
  let clock = START + 3600_000;
  const mockRedis = createMockRedisServer({ now: () => clock });
  const redisUrl = await mockRedis.listen();
  const pulse = createPulseStore({ url: redisUrl, now: () => clock });
  const db = openLeaderboardStore(':memory:');

  const users = { alice: 1, bob: 2, admin: 3 };
  let devCode = 0;
  const codes = new Map();
  const server = createLeaderboardServer({
    store: db,
    pulse,
    baseUrl: ORIGIN,
    clientId: 'cid',
    clientSecret: 'csec',
    adminEmail: 'staff@example.test',
    maxTokens: 1_000_000,
    now: () => clock,
    fetcher: async (url, opts) => {
      const route = new URL(url).pathname;
      if (route === '/login/device/code') {
        const dc = String(++devCode);
        codes.set(dc, devCode === 1 ? 'alice' : 'admin');
        return Response.json({ device_code: dc, user_code: 'ORCA-000' + dc, expires_in: 900, interval: 1 });
      }
      if (route === '/login/oauth/access_token') {
        return Response.json({ access_token: codes.get(opts.body.get('device_code')) });
      }
      if (route === '/user') {
        const name = opts.headers.Authorization.slice(7);
        return Response.json({ id: users[name], login: name });
      }
      if (route === '/user/emails') {
        return Response.json([{ email: 'staff@example.test', verified: true }]);
      }
      throw new Error('Unexpected fetch ' + route);
    }
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await pulse.close();
    db.close();
    await mockRedis.close();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body, headers = {}) => fetch(base + route, {
    method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers }
  });

  const challenge = await (await post('/api/auth/device/start', {})).json();
  clock += 1500;
  const aliceToken = (await (await post('/api/auth/device/poll', { ticket: challenge.ticket })).json()).token;

  // Open SSE stream before sending pulses.
  const sseAbort = new AbortController();
  const sseRes = await fetch(base + '/api/pulse/stream', { signal: sseAbort.signal });
  assert.equal(sseRes.status, 200);
  assert.match(sseRes.headers.get('content-type'), /text\/event-stream/);
  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  const readEvent = async () => {
    for (;;) {
      const idx = sseBuffer.indexOf('\n\n');
      if (idx !== -1) {
        const chunk = sseBuffer.slice(0, idx);
        sseBuffer = sseBuffer.slice(idx + 2);
        const dataLine = chunk.split('\n').find(line => line.startsWith('data:'));
        if (dataLine) return JSON.parse(dataLine.slice(5).trim());
      }
      const { done, value } = await reader.read();
      if (done) throw new Error('SSE ended early');
      sseBuffer += decoder.decode(value, { stream: true });
    }
  };
  const initialEvent = await readEvent();
  assert.equal(initialEvent.available, true);
  assert.equal(initialEvent.activeCount, 0);

  // Send 6 rapid /api/pulse calls — must NEVER trigger SQLite 5s auto-ban!
  const installationId = crypto.randomUUID();
  for (let i = 0; i < 6; i += 1) {
    const res = await post('/api/pulse', { installationId, tps: 75 + i, burstTokens: 400 }, {
      Authorization: 'Bearer ' + aliceToken
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  }
  // Verify SQLite /api/today/submit is completely unaffected and still accepted.
  const submitRes = await post('/api/today/submit', {
    day: leaderboardDay(clock), installationId, tokens: 500
  }, { Authorization: 'Bearer ' + aliceToken, 'Idempotency-Key': crypto.randomUUID() });
  assert.equal(submitRes.status, 201);

  const liveEvent = await readEvent();
  assert.equal(liveEvent.activeCount, 1);
  assert.equal(liveEvent.users[0].username, 'alice');
  assert.ok(liveEvent.users[0].tps >= 75);
  sseAbort.abort();
  await reader.cancel().catch(() => {});

  // Stop Redis — /api/pulse degrades cleanly while /api/today continues serving SQLite rankings!
  await mockRedis.close();
  clock += 1500;
  const degraded = await (await fetch(base + '/api/pulse')).json();
  assert.equal(degraded.available, false);
  assert.deepEqual(degraded.users, []);
  const board = await (await fetch(base + '/api/today')).json();
  assert.equal(board.rows.length, 1);
  assert.equal(board.rows[0].username, 'alice');
});

test('createPulseTracker avoids double counting and captures background usage deltas', () => {
  let clock = START + 5000_000;
  const tracker = createPulseTracker({ now: () => clock });
  const events = [];
  tracker.subscribe(event => events.push(event));

  // First usage baseline initializes silently without emitting old historical tokens.
  tracker.handleUsage({ day: TODAY, tokens: 10_000, ready: true });
  assert.equal(events.length, 0);

  // Old records (> 30s) must be ignored when switching tabs.
  tracker.handleRecords([{
    provider: 'codex', completedAt: clock - 45_000, outputTokens: 500, freshInputTokens: 500, tokensPerSecond: 95
  }]);
  assert.equal(events.length, 0);

  // Recent record emits live pulse immediately.
  tracker.handleRecords([{
    provider: 'codex', completedAt: clock - 500, outputTokens: 800, freshInputTokens: 200,
    cacheReadTokens: 1000, cacheCreationTokens: 0, tokensPerSecond: 104.2
  }]);
  assert.deepEqual(events, [{ tps: 104.2, burstTokens: 2000 }]);

  // Same tokens picked up by usageIndex later must NOT double count.
  tracker.handleUsage({ day: TODAY, tokens: 12_000, ready: true });
  assert.equal(events.length, 1);

  // Background workspace adds 1500 tokens not seen by controller -> emits extra delta.
  tracker.handleUsage({ day: TODAY, tokens: 13_500, ready: true });
  assert.deepEqual(events[1], { tps: 104.2, burstTokens: 1500 });
  assert.deepEqual(tracker.snapshot(), { tps: 104.2, burstTokens: 0 });
});

test('startLeaderboard throttles pulse uploads to 2s and manages pulse-watch stream + fallback', async t => {
  let clock = START + 3600_000;
  const mockRedis = createMockRedisServer({ now: () => clock });
  const redisUrl = await mockRedis.listen();
  const pulse = createPulseStore({ url: redisUrl, now: () => clock });
  const db = openLeaderboardStore(':memory:');

  const server = createLeaderboardServer({
    store: db, pulse, baseUrl: ORIGIN, clientId: 'cid', clientSecret: 'csec',
    adminEmail: 'staff@example.test', maxTokens: 1_000_000, now: () => clock,
    fetcher: async url => {
      const route = new URL(url).pathname;
      if (route === '/api/pulse/stream') throw new Error('unused');
      if (route === '/login/device/code') return Response.json({ device_code: '1', user_code: 'ORCA-0001', expires_in: 900, interval: 1 });
      if (route === '/login/oauth/access_token') return Response.json({ access_token: 'alice' });
      if (route === '/user') return Response.json({ id: 1, login: 'alice' });
      return Response.json([]);
    }
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await pulse.close();
    db.close();
    await mockRedis.close();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const challenge = await (await fetch(endpoint + '/api/auth/device/start', { method: 'POST', body: '{}' })).json();
  clock += 1500;
  const token = (await (await fetch(endpoint + '/api/auth/device/poll', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket: challenge.ticket })
  })).json()).token;
  assert.ok(token);

  const postedPulses = [];
  const pushedEvents = [];
  let handle, emitSample;
  const secrets = new Map([['leaderboard-session', token]]);
  const storage = new Map();
  const orca = {
    storage: { get: async k => storage.get(k), set: async (k, v) => storage.set(k, v) },
    host: { has: () => true, call: async (m, { key, value }) => m === 'secrets.get' ? { value: secrets.get(key) } : secrets.set(key, value) },
    grantedCapabilities: ['secrets:own'],
    panels: {
      handle: (_, cb) => { handle = cb; return { dispose() {} }; },
      post: (channel, data) => { if (channel === 'tps.leaderboard.pulse') pushedEvents.push(data); }
    }
  };
  const stop = startLeaderboard(orca, {
    endpoint,
    now: () => new Date(clock),
    readUsage: async () => ({ day: TODAY, tokens: 100, ready: true }),
    readPulseSeed: () => ({ tps: 66.5, burstTokens: 0 }),
    subscribePulse: fn => { emitSample = fn; return () => {}; },
    fetcher: async (url, opts) => {
      if (url.pathname === '/api/pulse') postedPulses.push(JSON.parse(opts.body));
      return fetch(url, opts);
    }
  });
  t.after(() => stop());

  await handle({ action: 'session' });
  await handle({ action: 'pulse-watch', active: true });
  for (let i = 0; i < 30 && postedPulses.length === 0; i += 1) await delay(20);
  assert.equal(postedPulses[0].tps, 66.5);
  assert.equal(postedPulses[0].burstTokens, 0);
  clock += 2500;
  emitSample({ tps: 80, burstTokens: 500 });
  for (let i = 0; i < 30 && !postedPulses.some(p => p.burstTokens === 500); i += 1) await delay(20);
  const firstActive = postedPulses.find(p => p.burstTokens === 500);
  assert.equal(firstActive?.tps, 80);
  clock += 2100;
  emitSample({ tps: 95, burstTokens: 700 });
  for (let i = 0; i < 60 && !postedPulses.some(p => p.burstTokens === 700); i += 1) await delay(40);
  const secondActive = postedPulses.find(p => p.burstTokens === 700);
  assert.equal(secondActive?.tps, 95);

  for (let i = 0; i < 60 && !pushedEvents.some(e => e.users?.[0]?.username === 'alice'); i += 1) await delay(25);
  const alicePush = pushedEvents.findLast(e => e.users?.[0]?.username === 'alice');
  assert.ok(alicePush);
  assert.equal(alicePush.available, true);
  assert.equal(alicePush.users[0].username, 'alice');
  await handle({ action: 'pulse-watch', active: false });
});

test('Redis client rejects commands and pipelines promptly on timeout without hanging', async t => {
  const sockets = new Set();
  const blackhole = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise(resolve => blackhole.close(resolve));
  });
  blackhole.listen(0, '127.0.0.1');
  await once(blackhole, 'listening');

  const client = createRedisClient(`redis://127.0.0.1:${blackhole.address().port}/0`, { timeoutMs: 80 });
  const pulse = createPulseStore({ client });
  t.after(() => pulse.close());

  await assert.rejects(() => client.command('PING'), /timeout/i);
  const snap = await pulse.readSnapshot();
  assert.equal(snap.available, false);
});

test('panel.html includes live marquee, heartbeat SVG curve, mood badges, and row pulse slots', async () => {
  const panelPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'panel.html');
  const html = await readFile(panelPath, 'utf8');
  assert.match(html, /id="ladder-live"/);
  assert.match(html, /id="ladder-marquee"/);
  assert.match(html, /id="ladder-heartbeat"/);
  assert.match(html, /id="ladder-hb-svg"/);
  assert.match(html, /id="hb-grad-hot"/);
  assert.match(html, /id="hb-grad-steady"/);
  assert.match(html, /id="hb-grad-idle"/);
  assert.match(html, /ladder-avatar-mood/);
  assert.match(html, /ladder-row-pulse/);
  assert.match(html, /tps\.leaderboard\.pulse/);
});

import net from 'node:net';
import tls from 'node:tls';

const DEFAULT_TIMEOUT_MS = 2000;
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 5000;

function encodeCommand(args) {
  const chunks = [Buffer.from(`*${args.length}\r\n`, 'utf8')];
  for (const arg of args) {
    const buf = Buffer.isBuffer(arg) ? arg : Buffer.from(String(arg), 'utf8');
    chunks.push(Buffer.from(`$${buf.length}\r\n`, 'utf8'), buf, Buffer.from('\r\n', 'utf8'));
  }
  return Buffer.concat(chunks);
}

function findCrlf(buf, offset) {
  let index = offset;
  while (index < buf.length) {
    const cr = buf.indexOf(0x0d, index);
    if (cr === -1 || cr + 1 >= buf.length) return -1;
    if (buf[cr + 1] === 0x0a) return cr;
    index = cr + 1;
  }
  return -1;
}

function readResp(buf, offset = 0) {
  if (offset >= buf.length) return null;
  const lineEnd = findCrlf(buf, offset);
  if (lineEnd === -1) return null;
  const prefix = buf[offset];
  const line = buf.subarray(offset + 1, lineEnd).toString('utf8');
  const bodyStart = lineEnd + 2;

  if (prefix === 0x2b) return { value: line, next: bodyStart }; // '+'
  if (prefix === 0x2d) {
    const error = new Error(line);
    error.redisError = true;
    return { error, next: bodyStart }; // '-'
  }
  if (prefix === 0x3a) return { value: Number(line), next: bodyStart }; // ':'
  if (prefix === 0x24) { // '$'
    const length = Number(line);
    if (!Number.isInteger(length)) throw new Error('Invalid RESP bulk length');
    if (length === -1) return { value: null, next: bodyStart };
    const end = bodyStart + length;
    if (buf.length < end + 2) return null;
    if (buf[end] !== 0x0d || buf[end + 1] !== 0x0a) throw new Error('Invalid RESP bulk terminator');
    return { value: buf.subarray(bodyStart, end).toString('utf8'), next: end + 2 };
  }
  if (prefix === 0x2a) { // '*'
    const count = Number(line);
    if (!Number.isInteger(count)) throw new Error('Invalid RESP array length');
    if (count === -1) return { value: null, next: bodyStart };
    const items = [];
    let cursor = bodyStart;
    for (let i = 0; i < count; i += 1) {
      const parsed = readResp(buf, cursor);
      if (!parsed) return null;
      items.push(parsed.error ? parsed.error : parsed.value);
      cursor = parsed.next;
    }
    return { value: items, next: cursor };
  }
  throw new Error(`Unsupported RESP prefix: ${prefix}`);
}

export function parseRedisUrl(input) {
  const url = new URL(input);
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error('REDIS_URL must use redis:// or rediss://');
  }
  const dbRaw = url.pathname.replace(/^\/+/, '');
  const db = dbRaw ? Number(dbRaw) : 0;
  if (!Number.isInteger(db) || db < 0) throw new Error('Invalid Redis database index');
  return {
    tls: url.protocol === 'rediss:',
    host: url.hostname || '127.0.0.1',
    port: url.port ? Number(url.port) : 6379,
    username: url.username ? decodeURIComponent(url.username) : '',
    password: url.password ? decodeURIComponent(url.password) : '',
    db
  };
}

export function createRedisClient(redisUrl, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now,
  onError = () => {}
} = {}) {
  const target = parseRedisUrl(redisUrl);
  let socket = null;
  let connecting = null;
  let rejectConnecting = null;
  let buffer = Buffer.alloc(0);
  let queue = [];
  let closed = false;
  let retryAt = 0;
  let backoffMs = INITIAL_BACKOFF_MS;
  let ready = false;

  function failQueue(error) {
    const pending = queue;
    queue = [];
    for (const item of pending) {
      clearTimeout(item.timer);
      item.reject(error);
    }
  }

  function resetSocket(error) {
    ready = false;
    connecting = null;
    const rejectConnect = rejectConnecting;
    rejectConnecting = null;
    if (socket) {
      const current = socket;
      socket = null;
      current.removeAllListeners();
      current.destroy();
    }
    buffer = Buffer.alloc(0);
    if (error) {
      retryAt = now() + backoffMs;
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      onError(error);
      rejectConnect?.(error);
      failQueue(error);
    }
  }

  function drainBuffer() {
    while (queue.length > 0) {
      let frame;
      try { frame = readResp(buffer, 0); }
      catch (error) {
        resetSocket(error);
        return;
      }
      if (!frame) break;
      buffer = buffer.subarray(frame.next);
      const item = queue.shift();
      clearTimeout(item.timer);
      if (frame.error) item.reject(frame.error);
      else item.resolve(frame.value);
    }
  }

  function enqueue(args, activeSocket = socket) {
    return new Promise((resolve, reject) => {
      if (!activeSocket || activeSocket.destroyed) {
        reject(new Error('Redis socket unavailable'));
        return;
      }
      const item = { resolve, reject, timer: null };
      item.timer = setTimeout(() => {
        resetSocket(new Error('Redis command timeout'));
      }, timeoutMs);
      item.timer.unref?.();
      queue.push(item);
      try {
        activeSocket.write(encodeCommand(args));
      } catch (error) {
        resetSocket(error);
      }
    });
  }

  async function ensureConnected() {
    if (closed) throw new Error('Redis client closed');
    if (ready && socket && !socket.destroyed) return socket;
    if (connecting) return connecting;
    if (now() < retryAt) throw new Error('Redis reconnect backoff');

    connecting = new Promise((resolve, reject) => {
      const conn = target.tls
        ? tls.connect({ host: target.host, port: target.port, servername: target.host })
        : net.createConnection({ host: target.host, port: target.port });
      let settled = false;
      rejectConnecting = err => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        reject(err);
      };
      const connectTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        rejectConnecting = null;
        conn.destroy();
        const err = new Error('Redis connect timeout');
        retryAt = now() + backoffMs;
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        connecting = null;
        reject(err);
      }, timeoutMs);
      connectTimer.unref?.();

      socket = conn;
      conn.setNoDelay(true);
      conn.on('data', chunk => {
        buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
        drainBuffer();
      });
      conn.on('error', err => {
        if (!settled) {
          settled = true;
          rejectConnecting = null;
          clearTimeout(connectTimer);
          resetSocket(err);
          reject(err);
          return;
        }
        resetSocket(err);
      });
      conn.on('close', () => {
        if (!settled) {
          settled = true;
          rejectConnecting = null;
          clearTimeout(connectTimer);
          const err = new Error('Redis connection closed');
          resetSocket(err);
          reject(err);
          return;
        }
        if (socket === conn) resetSocket(new Error('Redis connection closed'));
      });
      conn.once('connect', async () => {
        clearTimeout(connectTimer);
        try {
          if (target.password) {
            const authArgs = target.username
              ? ['AUTH', target.username, target.password]
              : ['AUTH', target.password];
            await enqueue(authArgs, conn);
          }
          if (target.db > 0) await enqueue(['SELECT', String(target.db)], conn);
          if (closed || socket !== conn) throw new Error('Redis closed during handshake');
          ready = true;
          backoffMs = INITIAL_BACKOFF_MS;
          retryAt = 0;
          settled = true;
          rejectConnecting = null;
          connecting = null;
          resolve(conn);
        } catch (err) {
          settled = true;
          rejectConnecting = null;
          resetSocket(err);
          reject(err);
        }
      });
    });
    return connecting;
  }

  async function command(...args) {
    const conn = await ensureConnected();
    return enqueue(args, conn);
  }

  async function pipeline(commands) {
    if (!commands.length) return [];
    const conn = await ensureConnected();
    return Promise.all(commands.map(args => {
      return new Promise((resolve, reject) => {
        if (!conn || conn.destroyed) {
          reject(new Error('Redis socket unavailable'));
          return;
        }
        const item = {
          resolve: value => resolve({ ok: true, value }),
          reject: error => {
            if (error?.redisError) resolve({ ok: false, error });
            else reject(error);
          },
          timer: null
        };
        item.timer = setTimeout(() => {
          resetSocket(new Error('Redis pipeline timeout'));
        }, timeoutMs);
        item.timer.unref?.();
        queue.push(item);
      });
    }).map((promise, index) => {
      // Write batched commands together after registering all handlers synchronously.
      if (index === commands.length - 1) {
        try {
          conn.write(Buffer.concat(commands.map(encodeCommand)));
        } catch (error) {
          resetSocket(error);
        }
      }
      return promise;
    }));
  }

  async function close() {
    closed = true;
    resetSocket(new Error('Redis client closed'));
  }

  return {
    command,
    pipeline,
    close,
    isReady: () => ready && !closed
  };
}

export function createPulseStore({
  url,
  client,
  now = Date.now,
  prefix = 'orca:pulse:',
  ttlMs = 30_000,
  wavePoints = 20,
  waveRetentionSec = 60,
  marqueeLimit = 30,
  marqueeCooldownSec = 5,
  onlineCooldownSec = 60,
  maxActiveUsers = 50,
  maxEventsAgeMs = 300_000,
  onError = () => {}
} = {}) {
  const redis = client ?? createRedisClient(url, { now, onError });
  const ttlSec = Math.max(5, Math.ceil(ttlMs / 1000));
  const activeKey = prefix + 'active';
  const eventsKey = prefix + 'events';
  const userKey = id => `${prefix}user:${id}`;
  const devsKey = id => `${prefix}devs:${id}`;
  const devKey = (id, installationId) => `${prefix}dev:${id}:${installationId}`;
  const waveKey = id => `${prefix}wave:${id}`;
  const cooldownKey = id => `${prefix}mcooldown:${id}`;
  const onlineCooldownKey = id => `${prefix}ocooldown:${id}`;

  async function recordPulse({ accountId, username, installationId, tps = 0, burstTokens = 0 }) {
    const time = now();
    const safeTps = Number.isFinite(tps) && tps > 0 ? Math.round(tps * 10) / 10 : 0;
    const safeBurst = Number.isSafeInteger(burstTokens) && burstTokens > 0 ? burstTokens : 0;
    const active = safeTps > 0 || safeBurst > 0;
    const id = String(accountId);
    const point = active ? [time, safeTps, safeBurst] : [time, 0, 0, 1];
    const commands = [
      ['SET', devKey(id, installationId), JSON.stringify({ username, tps: safeTps, burstTokens: safeBurst, updatedAt: time }), 'EX', ttlSec],
      ['SADD', devsKey(id), installationId],
      ['EXPIRE', devsKey(id), waveRetentionSec],
      ['SET', userKey(id), JSON.stringify({ username, updatedAt: time }), 'EX', waveRetentionSec],
      ['ZADD', activeKey, String(time), id],
      ['LPUSH', waveKey(id), JSON.stringify(point)],
      ['LTRIM', waveKey(id), '0', String(wavePoints - 1)],
      ['EXPIRE', waveKey(id), waveRetentionSec],
      active
        ? ['SET', cooldownKey(id), '1', 'EX', marqueeCooldownSec, 'NX']
        : ['SET', onlineCooldownKey(id), '1', 'EX', onlineCooldownSec, 'NX']
    ];
    try {
      const results = await redis.pipeline(commands);
      if (results[8]?.ok && results[8]?.value === 'OK') {
        const event = JSON.stringify({ id: `${id}-${time}`, username, tps: safeTps, burstTokens: safeBurst, at: time });
        await redis.pipeline([
          ['LPUSH', eventsKey, event],
          ['LTRIM', eventsKey, '0', String(marqueeLimit - 1)],
          ['EXPIRE', eventsKey, 3600]
        ]);
      }
      return { ok: true, available: true };
    } catch {
      return { ok: false, available: false };
    }
  }

  async function removeAccount(accountId) {
    const id = String(accountId);
    try {
      const devsReply = await redis.command('SMEMBERS', devsKey(id));
      const commands = [
        ['ZREM', activeKey, id],
        ['DEL', userKey(id), devsKey(id), waveKey(id), cooldownKey(id), onlineCooldownKey(id)]
      ];
      if (Array.isArray(devsReply) && devsReply.length > 0) {
        commands.push(['DEL', ...devsReply.map(dev => devKey(id, dev))]);
      }
      await redis.pipeline(commands);
      return true;
    } catch {
      return false;
    }
  }

  async function readSnapshot() {
    const time = now();
    const cutoff = time - ttlMs;
    const waveCutoff = time - waveRetentionSec * 1000;
    try {
      const top = await redis.pipeline([
        ['ZREMRANGEBYSCORE', activeKey, '-inf', String(cutoff)],
        ['ZREVRANGE', activeKey, '0', String(maxActiveUsers - 1)],
        ['LRANGE', eventsKey, '0', String(marqueeLimit - 1)]
      ]);
      const activeIds = Array.isArray(top[1]?.value) ? top[1].value : [];
      const rawEvents = Array.isArray(top[2]?.value) ? top[2].value : [];
      const marquee = [];
      for (const raw of rawEvents) {
        try {
          const item = JSON.parse(raw);
          if (item && typeof item.username === 'string' && Number.isFinite(item.at) && item.at >= time - maxEventsAgeMs) {
            marquee.push({
              id: String(item.id ?? `${item.username}-${item.at}`),
              username: item.username,
              tps: Number.isFinite(item.tps) ? item.tps : 0,
              burstTokens: Number.isSafeInteger(item.burstTokens) ? item.burstTokens : 0,
              at: item.at
            });
          }
        } catch { /* ignore malformed entries */ }
      }

      if (activeIds.length === 0) {
        return { available: true, serverTime: time, activeCount: 0, users: [], marquee };
      }

      const detailCmds = [];
      for (const id of activeIds) {
        detailCmds.push(['GET', userKey(id)], ['SMEMBERS', devsKey(id)], ['LRANGE', waveKey(id), '0', String(wavePoints - 1)]);
      }
      const details = await redis.pipeline(detailCmds);
      const devPairs = [];
      const accounts = [];
      for (let i = 0; i < activeIds.length; i += 1) {
        const id = activeIds[i];
        const metaRaw = details[i * 3]?.value;
        const devList = Array.isArray(details[i * 3 + 1]?.value) ? details[i * 3 + 1].value : [];
        const waveRaw = Array.isArray(details[i * 3 + 2]?.value) ? details[i * 3 + 2].value : [];
        let username = '';
        try { username = JSON.parse(metaRaw ?? '{}').username ?? ''; } catch {}
        const wave = [];
        for (let j = waveRaw.length - 1; j >= 0; j -= 1) {
          try {
            const point = JSON.parse(waveRaw[j]);
            if (Array.isArray(point) && point.length >= 3 && Number.isFinite(point[0]) && point[0] >= waveCutoff) {
              const entry = [point[0], Number.isFinite(point[1]) ? point[1] : 0, Number.isFinite(point[2]) ? point[2] : 0];
              if (point[3] === 1) entry.push(1);
              wave.push(entry);
            }
          } catch {}
        }
        const entry = { id, username, wave, devices: [] };
        accounts.push(entry);
        for (const dev of devList) {
          devPairs.push({ account: entry, dev, key: devKey(id, dev) });
        }
      }

      const cleanupCmds = [];
      if (devPairs.length > 0) {
        const devValues = await redis.command('MGET', ...devPairs.map(pair => pair.key));
        for (let i = 0; i < devPairs.length; i += 1) {
          const pair = devPairs[i];
          const raw = Array.isArray(devValues) ? devValues[i] : null;
          if (!raw) {
            cleanupCmds.push(['SREM', devsKey(pair.account.id), pair.dev]);
            continue;
          }
          try {
            const parsed = JSON.parse(raw);
            if (parsed && Number.isFinite(parsed.updatedAt) && parsed.updatedAt >= cutoff) {
              if (!pair.account.username && typeof parsed.username === 'string') pair.account.username = parsed.username;
              pair.account.devices.push(parsed);
            }
          } catch {}
        }
      }

      const users = [];
      for (const account of accounts) {
        if (!account.devices.length || !account.username) {
          cleanupCmds.push(['ZREM', activeKey, account.id]);
          continue;
        }
        account.devices.sort((a, b) => b.updatedAt - a.updatedAt);
        const latest = account.devices[0];
        const burstTokens = account.devices.reduce((sum, d) => sum + (Number.isSafeInteger(d.burstTokens) ? d.burstTokens : 0), 0);
        users.push({
          username: account.username,
          tps: Number.isFinite(latest.tps) ? latest.tps : 0,
          burstTokens,
          updatedAt: latest.updatedAt,
          wave: account.wave
        });
      }
      if (cleanupCmds.length > 0) {
        void redis.pipeline(cleanupCmds).catch(() => {});
      }
      users.sort((a, b) => b.updatedAt - a.updatedAt || b.tps - a.tps);
      return { available: true, serverTime: time, activeCount: users.length, users, marquee };
    } catch {
      return { available: false, serverTime: time, activeCount: 0, users: [], marquee: [] };
    }
  }

  return {
    recordPulse,
    removeAccount,
    readSnapshot,
    close: () => redis.close(),
    isReady: () => redis.isReady()
  };
}

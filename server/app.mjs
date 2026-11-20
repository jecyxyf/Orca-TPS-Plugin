import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { leaderboardDay, leaderboardDayStart } from '../src/usage-summary.mjs';
import { validInstallationId } from '../src/leaderboard-installation.mjs';
import { adminLogin, adminPage, localTimes, pluginLoginResult } from './admin-page.mjs';

const GITHUB = 'https://github.com';
const GITHUB_API = 'https://api.github.com';
const HOUR = 3_600_000;
const BROWSER_LOGIN_MS = 10 * 60 * 1000;
const newToken = () => randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('hex');
const challengeOf = value => createHash('sha256').update(value).digest('base64url');
const tokenPattern = /^[\w-]{43}$/;
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const statuses = { accepted: 201, initialized: 200, invalid: 400, duplicate: 409, removed: 409, upgrade_required: 409, too_soon: 429, locked: 429, banned: 403 };
const feedback = { updated: '已保存。', rejected: '操作未执行，请检查输入。', forbidden: '该 GitHub 账号没有管理权限。', failed: 'GitHub 登录未完成，请重新登录。' };

function cookieValue(req, name) {
  return req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(name + '='))?.slice(name.length + 1);
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let length = 0;
    const parts = [];
    req.on('data', chunk => {
      length += chunk.length;
      if (length <= limit) parts.push(chunk);
      else {
        parts.length = 0;
        resolve(null);
      }
    });
    req.once('end', () => resolve(length <= limit ? Buffer.concat(parts).toString('utf8') : null));
    req.once('error', reject);
  });
}

function parseJson(value) {
  if (value === null) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function validDay(day) {
  if (!dayPattern.test(day ?? '')) return false;
  const start = leaderboardDayStart(day);
  return Number.isFinite(start) && leaderboardDay(start) === day;
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

function redirect(res, location) {
  res.writeHead(303, { Location: location });
  res.end();
}

export function createLeaderboardServer({
  store, baseUrl, clientId, clientSecret, adminEmail = '', maxTokens = Number.MAX_SAFE_INTEGER,
  pulse = null, fetcher = fetch, now = Date.now, log = () => {}
}) {
  const base = new URL(baseUrl);
  const secure = base.protocol === 'https:';
  if (!secure && (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))) {
    throw new Error('Public leaderboard URLs must use HTTPS');
  }
  if (Boolean(clientId) !== Boolean(clientSecret)) throw new Error('Configure both GitHub application credentials');
  const githubConfigured = Boolean(clientId && clientSecret);
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error('LEADERBOARD_MAX_TOKENS must be a positive safe integer');
  const callback = new URL('/auth/github/callback', base).href;
  const deviceLogins = new Map();
  const browserLogins = new Map();
  const requests = new Map();
  let minute, prunedDay;
  const PULSE_SNAPSHOT_MS = 1000;
  const PULSE_STREAM_MS = 1000;
  const PULSE_PING_MS = 15_000;
  const MAX_PULSE_STREAMS = 500;
  const MAX_PULSE_STREAMS_PER_IP = 10;
  const pulseStreams = new Set();
  const pulseStreamsByIp = new Map();
  let pulseCache = null, pulsePending = null, pulseTimer = null, pulseBroadcastPending = null;
  let pulseLastSignature = '', pulsePingAt = 0;

  async function readPulseSnapshot(force = false) {
    const time = now();
    if (!pulse) return { available: false, serverTime: time, activeCount: 0, users: [], marquee: [] };
    if (!force && pulseCache && time - pulseCache.at < PULSE_SNAPSHOT_MS) return pulseCache.data;
    if (pulsePending) return pulsePending;
    pulsePending = (async () => {
      const data = await pulse.readSnapshot();
      pulseCache = { at: now(), data };
      return data;
    })().finally(() => { pulsePending = null; });
    return pulsePending;
  }

  function removePulseStream(client) {
    if (!pulseStreams.delete(client)) return;
    const count = (pulseStreamsByIp.get(client.ip) ?? 1) - 1;
    if (count > 0) pulseStreamsByIp.set(client.ip, count);
    else pulseStreamsByIp.delete(client.ip);
    if (pulseStreams.size === 0 && pulseTimer) {
      clearInterval(pulseTimer);
      pulseTimer = null;
    }
  }

  function stopPulseStreams() {
    if (pulseTimer) {
      clearInterval(pulseTimer);
      pulseTimer = null;
    }
    if (pulseBroadcastPending) {
      clearTimeout(pulseBroadcastPending);
      pulseBroadcastPending = null;
    }
    for (const client of [...pulseStreams]) {
      removePulseStream(client);
      if (!client.res.writableEnded) client.res.end();
    }
  }

  async function broadcastPulse(force = false) {
    if (pulseStreams.size === 0) return;
    const data = await readPulseSnapshot(force);
    if (pulseStreams.size === 0) return;
    const time = now();
    const signature = JSON.stringify({ available: data.available, users: data.users, marquee: data.marquee });
    if (signature !== pulseLastSignature) {
      pulseLastSignature = signature;
      pulsePingAt = time;
      const frame = `event: pulse\ndata: ${JSON.stringify(data)}\n\n`;
      for (const client of [...pulseStreams]) {
        if (client.res.destroyed || client.res.writableEnded) {
          removePulseStream(client);
          continue;
        }
        client.res.write(frame);
      }
    } else if (time - pulsePingAt >= PULSE_PING_MS) {
      pulsePingAt = time;
      for (const client of [...pulseStreams]) {
        if (client.res.destroyed || client.res.writableEnded) {
          removePulseStream(client);
          continue;
        }
        client.res.write(': ping\n\n');
      }
    }
  }

  function schedulePulseBroadcast() {
    pulseCache = null;
    if (!pulseStreams.size || pulseBroadcastPending) return;
    pulseBroadcastPending = setTimeout(() => {
      pulseBroadcastPending = null;
      void broadcastPulse(true);
    }, 150);
    pulseBroadcastPending.unref?.();
  }
  const adminCookie = secure ? '__Host-orca_admin' : 'orca_admin';
  const stateCookie = secure ? '__Host-orca_state' : 'orca_state';
  const pluginStateCookie = secure ? '__Host-orca_plugin_state' : 'orca_plugin_state';
  const cookie = (name, value, seconds) =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${secure ? '; Secure' : ''}`;

  async function githubForm(path, fields) {
    const reply = await fetcher(GITHUB + path, {
      method: 'POST', body: new URLSearchParams(fields), redirect: 'error',
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000)
    });
    return reply.ok ? reply.json() : {};
  }

  async function githubGet(path, accessToken) {
    const reply = await fetcher(GITHUB_API + path, {
      headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + accessToken, 'User-Agent': 'orca-tps-leaderboard' },
      redirect: 'error', signal: AbortSignal.timeout(8000)
    });
    return reply.ok ? reply.json() : null;
  }

  async function identity(accessToken) {
    if (typeof accessToken !== 'string' || !accessToken || accessToken.length > 512) return null;
    const user = await githubGet('/user', accessToken);
    if (!Number.isSafeInteger(user?.id) || user.id <= 0 || !/^[\w-]{1,39}$/.test(user.login ?? '')) return null;
    return { id: user.id, login: user.login };
  }

  function issueSession(user, kind, time, duration) {
    const token = newToken();
    store.upsertAccount(user);
    store.addSession(digest(token), user.id, kind, time + duration);
    return token;
  }

  async function deviceStart(res, time) {
    if (deviceLogins.size >= 1000) return send(res, 429, { code: 'rate_limited' });
    const result = await githubForm('/login/device/code', { client_id: clientId });
    if (!/^[A-Z\d-]{6,16}$/.test(result.user_code ?? '') || typeof result.device_code !== 'string' || result.device_code.length > 256 ||
      !Number.isInteger(result.expires_in) || result.expires_in < 1 || result.expires_in > 1800 ||
      !Number.isInteger(result.interval) || result.interval < 1 || result.interval > 120) {
      return send(res, 502, { code: 'github_unavailable' });
    }
    const ticket = newToken(), interval = result.interval * 1000, expiresAt = time + result.expires_in * 1000;
    deviceLogins.set(digest(ticket), { deviceCode: result.device_code, interval, nextPoll: time + interval, expiresAt, busy: false });
    send(res, 200, { ticket, code: result.user_code, interval, expiresAt });
  }

  async function devicePoll(req, res, time) {
    const input = parseJson(await readBody(req));
    if (!tokenPattern.test(input?.ticket ?? '')) return send(res, 400, { code: 'invalid' });
    const key = digest(input.ticket), login = deviceLogins.get(key);
    if (!login || login.expiresAt <= time) return send(res, 410, { code: 'login_expired' });
    if (login.busy || login.nextPoll > time) return send(res, 202, { code: 'pending', interval: login.interval });
    login.nextPoll = time + login.interval;
    login.busy = true;
    try {
      const result = await githubForm('/login/oauth/access_token', {
        client_id: clientId, device_code: login.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
      });
      if (result.error === 'authorization_pending') return send(res, 202, { code: 'pending', interval: login.interval });
      if (result.error === 'slow_down') {
        login.interval += 5000;
        login.nextPoll = time + login.interval;
        return send(res, 202, { code: 'pending', interval: login.interval });
      }
      if (result.error) {
        deviceLogins.delete(key);
        return send(res, 410, { code: result.error === 'access_denied' ? 'login_denied' : 'login_expired' });
      }
      const user = await identity(result.access_token);
      if (!user) return send(res, 502, { code: 'github_unavailable' });
      deviceLogins.delete(key);
      const token = issueSession(user, 'plugin', time, 30 * 24 * HOUR);
      send(res, 200, { token });
    } finally { login.busy = false; }
  }

  function browserResult(res, status, message) {
    return send(res, status, pluginLoginResult(message), 'text/html; charset=utf-8');
  }

  function pluginStart(req, res, url, time) {
    if (!githubConfigured) return browserResult(res, 503, 'GitHub 登录暂不可用，请稍后再试。');
    const challenge = url.searchParams.get('challenge');
    if (!tokenPattern.test(challenge ?? '')) return browserResult(res, 400, '请从 Orca 的天梯榜打开登录。');
    let login = browserLogins.get(challenge);
    if (login && login.expiresAt <= time) {
      browserLogins.delete(challenge);
      login = undefined;
    }
    if (login) {
      if (login.status !== 'pending' || cookieValue(req, pluginStateCookie) !== login.state) {
        return browserResult(res, 409, '请回到 Orca，重新点击 GitHub 登录。');
      }
    } else {
      if (browserLogins.size >= 1000) return browserResult(res, 429, '登录请求较多，请稍后再试。');
      login = { state: challenge + '.' + newToken(), githubVerifier: newToken(), expiresAt: time + BROWSER_LOGIN_MS, status: 'pending' };
      browserLogins.set(challenge, login);
    }
    const target = new URL('/login/oauth/authorize', GITHUB);
    target.search = new URLSearchParams({
      client_id: clientId, redirect_uri: callback, state: login.state,
      code_challenge: challengeOf(login.githubVerifier), code_challenge_method: 'S256'
    });
    res.setHeader('Set-Cookie', cookie(pluginStateCookie, login.state, Math.ceil((login.expiresAt - time) / 1000)));
    redirect(res, target.href);
  }

  async function pluginCallback(req, res, url, time) {
    const state = url.searchParams.get('state');
    const login = browserLogins.get(state?.split('.', 1)[0]);
    if (!login || login.state !== state || login.expiresAt <= time || login.status !== 'pending' ||
        cookieValue(req, pluginStateCookie) !== state) {
      return browserResult(res, 400, '登录请求已失效，请回到 Orca 重试。');
    }
    res.setHeader('Set-Cookie', cookie(pluginStateCookie, '', 0));
    login.status = 'exchanging';
    const code = url.searchParams.get('code');
    if (!code || code.length > 256) {
      login.status = url.searchParams.get('error') === 'access_denied' ? 'login_denied' : 'login_expired';
      return browserResult(res, 400, 'GitHub 授权未完成，请回到 Orca。');
    }
    try {
      const result = await githubForm('/login/oauth/access_token', {
        client_id: clientId, client_secret: clientSecret, code, redirect_uri: callback, code_verifier: login.githubVerifier
      });
      const user = await identity(result.access_token);
      if (user && login.expiresAt > now()) {
        login.user = user;
        login.status = 'authorized';
        return browserResult(res, 200, 'GitHub 授权成功，可以关闭这个页面并回到 Orca。');
      }
    } catch { /* Let both the browser and Orca report that the authorization failed. */ }
    login.status = 'github_unavailable';
    return browserResult(res, 502, 'GitHub 授权未完成，请回到 Orca 重试。');
  }

  async function pluginPoll(req, res, time) {
    const input = parseJson(await readBody(req));
    if (!tokenPattern.test(input?.verifier ?? '')) return send(res, 400, { code: 'invalid' });
    const login = browserLogins.get(challengeOf(input.verifier));
    if (!login) return send(res, 202, { code: 'pending' });
    if (login.expiresAt <= time) return send(res, 410, { code: 'login_expired' });
    if (login.status === 'consumed') {
      return input.received === true ? send(res, 200, { ok: true }) : send(res, 410, { code: 'login_expired' });
    }
    if (login.status === 'pending' || login.status === 'exchanging') return send(res, 202, { code: 'pending' });
    if (login.status === 'authorized') {
      if (input.received === true) return send(res, 202, { code: 'pending' });
      login.sessionToken = issueSession(login.user, 'plugin', time, 30 * 24 * HOUR);
      login.status = 'delivered';
      delete login.user;
    }
    if (login.status !== 'delivered') return send(res, 410, { code: login.status });
    const account = store.session(digest(login.sessionToken), 'plugin', time);
    if (input.received === true || !account) {
      login.status = 'consumed';
      delete login.sessionToken;
      return input.received === true ? send(res, 200, { ok: true }) : send(res, 410, { code: 'login_expired' });
    }
    return send(res, 200, { token: login.sessionToken, username: account.username });
  }

  function adminStart(res) {
    const state = newToken(), target = new URL('/login/oauth/authorize', GITHUB);
    target.search = new URLSearchParams({ client_id: clientId, redirect_uri: callback, state });
    if (!store.administrator()) target.searchParams.set('scope', 'user:email');
    res.setHeader('Set-Cookie', cookie(stateCookie, state, 600));
    redirect(res, target.href);
  }

  async function adminCallback(req, res, url, time) {
    const state = url.searchParams.get('state'), code = url.searchParams.get('code');
    res.setHeader('Set-Cookie', cookie(stateCookie, '', 0));
    if (!state || !tokenPattern.test(state) || state !== cookieValue(req, stateCookie) || !code || code.length > 256) {
      return redirect(res, '/admin?feedback=failed');
    }
    const result = await githubForm('/login/oauth/access_token', {
      client_id: clientId, client_secret: clientSecret, code, redirect_uri: callback
    });
    const user = await identity(result.access_token);
    if (!user) return redirect(res, '/admin?feedback=failed');
    const administrator = store.administrator();
    if (!administrator) {
      const emails = adminEmail ? await githubGet('/user/emails', result.access_token) : null;
      if (!Array.isArray(emails) || !emails.some(row => row.verified === true &&
        typeof row.email === 'string' && row.email.toLowerCase() === adminEmail.toLowerCase())) {
        return redirect(res, '/admin?feedback=forbidden');
      }
      store.upsertAccount(user);
      if (!store.bindAdministrator(user.id)) return redirect(res, '/admin?feedback=forbidden');
    } else if (administrator !== user.id) return redirect(res, '/admin?feedback=forbidden');
    const token = issueSession(user, 'admin', time, 12 * HOUR);
    res.setHeader('Set-Cookie', [cookie(stateCookie, '', 0), cookie(adminCookie, token, 12 * 3600)]);
    redirect(res, '/admin');
  }

  async function admin(req, res, url, time) {
    const token = cookieValue(req, adminCookie);
    const account = tokenPattern.test(token ?? '') ? store.session(digest(token), 'admin', time) : null;
    const permitted = account && account.id === store.administrator();
    if (req.method === 'GET' && url.pathname === '/admin') {
      const day = url.searchParams.get('day'), search = (url.searchParams.get('q') ?? '').slice(0, 39);
      const message = feedback[url.searchParams.get('feedback')];
      if (!permitted) return send(res, 200, adminLogin(message, githubConfigured), 'text/html; charset=utf-8');
      const selected = validDay(day) ? day : leaderboardDay(time);
      return send(res, 200, adminPage({
        day: selected, search, username: account.username, feedback: message,
        ...store.adminView(selected, search, leaderboardDay(time))
      }), 'text/html; charset=utf-8');
    }
    if (req.method !== 'POST') return send(res, 404, { code: 'not_found' });
    if (!permitted || req.headers.origin !== base.origin) return send(res, 403, { code: 'forbidden' });
    if (url.pathname === '/admin/logout') {
      store.removeSession(digest(token));
      res.setHeader('Set-Cookie', cookie(adminCookie, '', 0));
      return redirect(res, '/admin');
    }
    const form = new URLSearchParams(await readBody(req) ?? ''), day = form.get('day');
    const target = Number(form.get('account')), safeTarget = Number.isSafeInteger(target) && target !== 0;
    let result = 'rejected';
    if (url.pathname === '/admin/ban' && safeTarget && target > 0 && ['0', '1'].includes(form.get('ban'))) {
      if (store.setBan(account.id, target, form.get('ban') === '1', time, form.get('reason') ?? '')) {
        result = 'updated';
        if (form.get('ban') === '1') {
          void pulse?.removeAccount?.(target).then(() => schedulePulseBroadcast());
        }
      }
    } else if (url.pathname === '/admin/delete' && validDay(day) && safeTarget) {
      store.removeScores(account.id, { day, account: target }, time);
      result = 'updated';
    } else if (url.pathname === '/admin/clear' && form.get('confirm') === '清空') {
      const scope = form.get('scope');
      if (scope === 'all' || (scope === 'day' && validDay(day))) {
        store.removeScores(account.id, { day: scope === 'day' ? day : undefined }, time);
        result = 'updated';
      }
    }
    redirect(res, '/admin?' + new URLSearchParams({ day: day ?? '', q: form.get('q')?.slice(0, 39) ?? '', feedback: result }));
  }

  async function handle(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=604800');
    const time = now(), day = leaderboardDay(time);
    if (day !== prunedDay) {
      store.prune(time);
      prunedDay = day;
    }
    const currentMinute = Math.floor(time / 60000);
    if (currentMinute !== minute) {
      requests.clear();
      for (const [key, login] of deviceLogins) if (login.expiresAt <= time) deviceLogins.delete(key);
      for (const [key, login] of browserLogins) if (login.expiresAt <= time) browserLogins.delete(key);
      minute = currentMinute;
    }
    const url = new URL(req.url, base), route = url.pathname, method = req.method;
    const address = req.socket.remoteAddress;
    const forwarded = address === '127.0.0.1' || address === '::1' ? req.headers['x-real-ip'] : '';
    const ip = typeof forwarded === 'string' && /^[a-f\d.:]{3,45}$/i.test(forwarded) ? forwarded : address;
    const auth = route.startsWith('/auth/') || route.startsWith('/api/auth/');
    const isPulse = route === '/api/pulse' || route === '/api/pulse/stream';
    const requestKey = (auth ? 'auth/' : isPulse ? 'pulse/' : 'other/') + ip;
    const count = (requests.get(requestKey) ?? 0) + 1;
    if (count > (auth ? 120 : isPulse ? 180 : 240)) return send(res, 429, { code: 'rate_limited' });
    requests.set(requestKey, count);

    if (method === 'GET' && route === '/healthz') {
      return send(res, 200, {
        ok: true, githubConfigured,
        ...(pulse ? { redisConfigured: true, redisReady: pulse.isReady() } : {})
      });
    }
    if (method === 'GET' && route === '/') return redirect(res, '/admin');
    if (method === 'GET' && route === '/auth/github/start') return githubConfigured ? adminStart(res) : redirect(res, '/admin');
    if (method === 'GET' && route === '/auth/plugin/start') return pluginStart(req, res, url, time);
    if (method === 'GET' && route === '/auth/github/callback') {
      if (!githubConfigured) return redirect(res, '/admin');
      return url.searchParams.get('state')?.includes('.') ? pluginCallback(req, res, url, time) : adminCallback(req, res, url, time);
    }
    if (method === 'GET' && route === '/admin/local-time.js') return send(res, 200, localTimes, 'text/javascript; charset=utf-8');
    if (route === '/admin' || route.startsWith('/admin/')) return admin(req, res, url, time);
    if (method === 'POST' && route === '/api/auth/device/start') {
      return githubConfigured ? deviceStart(res, time) : send(res, 503, { code: 'github_unavailable' });
    }
    if (method === 'POST' && route === '/api/auth/device/poll') {
      return githubConfigured ? devicePoll(req, res, time) : send(res, 503, { code: 'github_unavailable' });
    }
    if (method === 'POST' && route === '/api/auth/plugin/poll') {
      return githubConfigured ? pluginPoll(req, res, time) : send(res, 503, { code: 'github_unavailable' });
    }
    if (!route.startsWith('/api/')) return send(res, 404, { code: 'not_found' });

    const token = /^Bearer ([\w-]{43})$/.exec(req.headers.authorization ?? '')?.[1];
    const account = token ? store.session(digest(token), 'plugin', time) : null;
    if (method === 'GET' && route === '/api/today') {
      const days = url.searchParams.get('days') ?? '1';
      if (!['1', '7', '30'].includes(days)) return send(res, 400, { code: 'invalid' });
      const ranking = store.ranking(account?.id ?? null, time, Number(days));
      const viewer = account ? { authenticated: true, banned: Boolean(account.banned), username: account.username } : { authenticated: false };
      return send(res, 200, { ...viewer, ...ranking });
    }
    if (method === 'GET' && route === '/api/pulse') {
      return send(res, 200, await readPulseSnapshot());
    }
    if (method === 'GET' && route === '/api/pulse/stream') {
      const ipStreams = pulseStreamsByIp.get(ip) ?? 0;
      if (pulseStreams.size >= MAX_PULSE_STREAMS || ipStreams >= MAX_PULSE_STREAMS_PER_IP) {
        return send(res, 429, { code: 'rate_limited' });
      }
      req.socket.setTimeout(0);
      res.setTimeout?.(0);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      const client = { res, ip };
      pulseStreams.add(client);
      pulseStreamsByIp.set(ip, ipStreams + 1);
      if (!pulseTimer) {
        pulseTimer = setInterval(() => { void broadcastPulse(true); }, PULSE_STREAM_MS);
        pulseTimer.unref?.();
      }
      req.on('close', () => removePulseStream(client));
      res.on('close', () => removePulseStream(client));
      const initial = await readPulseSnapshot();
      if (pulseStreams.has(client) && !res.destroyed && !res.writableEnded) {
        res.write(`event: pulse\ndata: ${JSON.stringify(initial)}\n\n`);
      }
      return;
    }
    if (!account) return send(res, 401, { code: 'login_required' });
    if (method === 'POST' && route === '/api/auth/logout') {
      store.removeSession(digest(token));
      return send(res, 200, { ok: true });
    }
    if (account.banned) return send(res, 403, { code: 'banned', username: account.username });
    if (method === 'POST' && route === '/api/pulse') {
      const raw = await readBody(req, 1024);
      const body = req.headers['content-type']?.split(';')[0] === 'application/json' ? parseJson(raw) : null;
      const installationId = body?.installationId;
      const tps = body?.tps ?? 0;
      const burstTokens = body?.burstTokens ?? 0;
      if (!validInstallationId(installationId) ||
          typeof tps !== 'number' || !Number.isFinite(tps) || tps < 0 || tps > 100_000 ||
          !Number.isSafeInteger(burstTokens) || burstTokens < 0 || burstTokens > maxTokens) {
        return send(res, 400, { code: 'invalid' });
      }
      if (!pulse) return send(res, 200, { ok: false, available: false });
      const outcome = await pulse.recordPulse({
        accountId: account.id,
        username: account.username,
        installationId,
        tps,
        burstTokens
      });
      if (outcome.ok) schedulePulseBroadcast();
      return send(res, 200, outcome);
    }
    if (method === 'GET' && route === '/api/today/status') return send(res, 200, store.status(account.id, time));
    if (method === 'GET' && route === '/api/history/status') {
      return send(res, 200, { initialized: store.historyInitialized(account.id), ...store.status(account.id, time) });
    }
    if (method === 'POST' && (route === '/api/today/submit' || route === '/api/history/init')) {
      const history = route === '/api/history/init';
      const raw = await readBody(req), requestId = req.headers['idempotency-key'];
      const receivedAt = now();
      const validRequestId = typeof requestId === 'string' && /^[\w-]{16,128}$/.test(requestId);
      const body = validRequestId && req.headers['content-type']?.split(';')[0] === 'application/json' ? parseJson(raw) : null;
      const input = {
        day: body?.day, installationId: body?.installationId, tokens: body?.tokens, scores: body?.scores,
        requestId: (history ? 'history:' : '') + (validRequestId ? requestId : randomUUID()),
        fingerprint: digest(raw ?? 'oversized request')
      };
      const code = history ? store.initializeHistory(account.id, input, receivedAt, maxTokens) :
        store.submit(account.id, input, receivedAt, maxTokens);
      if (code === 'banned') void pulse?.removeAccount?.(account.id).then(() => schedulePulseBroadcast());
      return send(res, statuses[code], { code, username: account.username,
        ...(code === 'banned' ? {} : store.status(account.id, receivedAt)) });
    }
    return send(res, 404, { code: 'not_found' });
  }

  const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000, maxHeaderSize: 8192 }, (req, res) => {
    void handle(req, res).catch(() => {
      log('榜单请求处理失败。');
      if (!res.headersSent) send(res, 500, { code: 'unavailable' });
      else res.destroy();
    });
  });
  const originalClose = server.close.bind(server);
  server.close = callback => {
    stopPulseStreams();
    return originalClose(callback);
  };
  return server;
}

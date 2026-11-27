import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { isIP, SocketAddress } from 'node:net';
import { adminLogin, adminPage, localTimes, pluginLoginResult } from './admin-page.mjs';
import { SPEED_SAMPLE_WINDOW_MS, TOKENS_LEADERBOARD } from '../src/leaderboard_stats.mjs';
import { leaderboardSnapshotForMode } from './tokens-manager-rankings.mjs';

const GITHUB = 'https://github.com', GITHUB_API = 'https://api.github.com', HOUR = 3_600_000, BROWSER_LOGIN_MS = 600_000;
const newToken = () => randomBytes(32).toString('base64url');
const digest = v => createHash('sha256').update(v).digest('hex');
const challengeOf = v => createHash('sha256').update(v).digest('base64url');
const tokenPattern = /^[\w-]{43}$/;
const feedback = { updated: '已保存。', rejected: '操作未执行，请检查输入。', forbidden: '该 GitHub 账号没有管理权限。', failed: 'GitHub 登录未完成，请重新登录。' };

function normalizeIp(value) {
  if (typeof value !== 'string' || value.includes('%')) return null;
  const family = isIP(value);
  if (family === 4) return value;
  return family === 6 ? new SocketAddress({ address: value, family: 'ipv6' }).address.replace(/^::ffff:/, '') : null;
}
const cookieValue = (req, name) => req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(name + '='))?.slice(name.length + 1);
const readBody = (req, limit = 4096) => new Promise((resolve, reject) => {
  let length = 0; const parts = [];
  req.on('data', chunk => { if ((length += chunk.length) <= limit) parts.push(chunk); else { parts.length = 0; resolve(null); } });
  req.once('end', () => resolve(length <= limit ? Buffer.concat(parts).toString('utf8') : null));
  req.once('error', reject);
});
const parseJson = value => { if (value === null) return null; try { return JSON.parse(value); } catch { return null; } };
const send = (res, status, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(status, { 'Content-Type': type });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
};
const redirect = (res, location) => { res.writeHead(303, { Location: location }); res.end(); };

export function createLeaderboardServer({
  store, baseUrl, clientId, clientSecret, adminEmail = '', maxTokens = Number.MAX_SAFE_INTEGER,
  fetcher = fetch, now = Date.now, log = () => {}, tokensJobs, trustedProxyIps = []
}) {
  const base = new URL(baseUrl), secure = base.protocol === 'https:';
  if (!secure && (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))) throw new Error('Public leaderboard URLs must use HTTPS');
  if (Boolean(clientId) !== Boolean(clientSecret)) throw new Error('Configure both GitHub application credentials');
  const githubConfigured = Boolean(clientId && clientSecret);
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error('LEADERBOARD_MAX_TOKENS must be a positive safe integer');
  const trustedProxies = new Set(['127.0.0.1', '::1']);
  for (const value of trustedProxyIps) {
    const address = normalizeIp(value);
    if (!address) throw new Error('LEADERBOARD_TRUSTED_PROXY_IPS must contain individual IP addresses');
    trustedProxies.add(address);
  }
  const callback = new URL('/auth/github/callback', base).href;
  const deviceLogins = new Map(), browserLogins = new Map(), requests = new Map();
  let minute;

  const allowRequest = (key, limit) => { const c = requests.get(key) ?? 0; if (c >= limit) return false; requests.set(key, c + 1); return true; };
  const rateLimited = (res, time) => { res.setHeader('Retry-After', String(Math.ceil((60_000 - time % 60_000) / 1000))); return send(res, 429, { code: 'rate_limited' }); };
  const [adminCookie, stateCookie, pluginStateCookie] = ['orca_admin', 'orca_state', 'orca_plugin_state'].map(n => (secure ? '__Host-' : '') + n);
  const cookie = (name, value, sec) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sec}${secure ? '; Secure' : ''}`;

  const githubForm = async (path, fields) => {
    const r = await fetcher(GITHUB + path, { method: 'POST', body: new URLSearchParams(fields), redirect: 'error', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    return r.ok ? r.json() : {};
  };
  const githubGet = async (path, accessToken) => {
    const r = await fetcher(GITHUB_API + path, { headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + accessToken, 'User-Agent': 'orca-tps-leaderboard' }, redirect: 'error', signal: AbortSignal.timeout(8000) });
    return r.ok ? r.json() : null;
  };
  const identity = async accessToken => {
    if (typeof accessToken !== 'string' || !accessToken || accessToken.length > 512) return null;
    const user = await githubGet('/user', accessToken);
    return Number.isSafeInteger(user?.id) && user.id > 0 && /^[\w-]{1,39}$/.test(user.login ?? '') ? { id: user.id, login: user.login } : null;
  };
  const issueSession = (user, kind, time, duration) => {
    const token = newToken();
    return store.issueSession(user, digest(token), kind, time + duration, time) ? token : null;
  };
  const browserResult = (res, status, message) => send(res, status, pluginLoginResult(message), 'text/html; charset=utf-8');

  async function deviceStart(res, time) {
    if (deviceLogins.size >= 1000) return send(res, 429, { code: 'rate_limited' });
    const r = await githubForm('/login/device/code', { client_id: clientId });
    if (!/^[A-Z\d-]{6,16}$/.test(r.user_code ?? '') || typeof r.device_code !== 'string' || r.device_code.length > 256 ||
        !Number.isInteger(r.expires_in) || r.expires_in < 1 || r.expires_in > 1800 || !Number.isInteger(r.interval) || r.interval < 1 || r.interval > 120) {
      return send(res, 502, { code: 'github_unavailable' });
    }
    const ticket = newToken(), interval = r.interval * 1000, expiresAt = time + r.expires_in * 1000;
    deviceLogins.set(digest(ticket), { deviceCode: r.device_code, interval, nextPoll: time + interval, expiresAt, busy: false });
    send(res, 200, { ticket, code: r.user_code, interval, expiresAt });
  }

  async function devicePoll(req, res, time) {
    const input = parseJson(await readBody(req));
    if (!tokenPattern.test(input?.ticket ?? '')) return send(res, 400, { code: 'invalid' });
    const key = digest(input.ticket), login = deviceLogins.get(key);
    if (!login || login.expiresAt <= time) return send(res, 410, { code: 'login_expired' });
    if (login.busy || login.nextPoll > time) return send(res, 202, { code: 'pending', interval: login.interval });
    login.nextPoll = time + login.interval; login.busy = true;
    try {
      const r = await githubForm('/login/oauth/access_token', { client_id: clientId, device_code: login.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
      if (r.error === 'authorization_pending') return send(res, 202, { code: 'pending', interval: login.interval });
      if (r.error === 'slow_down') { login.interval += 5000; login.nextPoll = time + login.interval; return send(res, 202, { code: 'pending', interval: login.interval }); }
      if (r.error) { deviceLogins.delete(key); return send(res, 410, { code: r.error === 'access_denied' ? 'login_denied' : 'login_expired' }); }
      const user = await identity(r.access_token);
      if (!user) return send(res, 502, { code: 'github_unavailable' });
      deviceLogins.delete(key);
      send(res, 200, { token: issueSession(user, 'plugin', time, 30 * 24 * HOUR) });
    } finally { login.busy = false; }
  }

  function pluginStart(req, res, url, time) {
    if (!githubConfigured) return browserResult(res, 503, 'GitHub 登录暂不可用，请稍后再试。');
    const challenge = url.searchParams.get('challenge');
    if (!tokenPattern.test(challenge ?? '')) return browserResult(res, 400, '请从 Orca 的天梯榜打开登录。');
    let login = browserLogins.get(challenge);
    if (login && login.expiresAt <= time) { browserLogins.delete(challenge); login = undefined; }
    if (login) {
      if (login.status !== 'pending' || cookieValue(req, pluginStateCookie) !== login.state) return browserResult(res, 409, '请回到 Orca，重新点击 GitHub 登录。');
    } else {
      if (browserLogins.size >= 1000) return browserResult(res, 429, '登录请求较多，请稍后再试。');
      browserLogins.set(challenge, login = { state: challenge + '.' + newToken(), githubVerifier: newToken(), expiresAt: time + BROWSER_LOGIN_MS, status: 'pending' });
    }
    const target = new URL('/login/oauth/authorize', GITHUB);
    target.search = new URLSearchParams({ client_id: clientId, redirect_uri: callback, state: login.state, code_challenge: challengeOf(login.githubVerifier), code_challenge_method: 'S256' });
    res.setHeader('Set-Cookie', cookie(pluginStateCookie, login.state, Math.ceil((login.expiresAt - time) / 1000)));
    redirect(res, target.href);
  }

  async function pluginCallback(req, res, url, time) {
    const state = url.searchParams.get('state'), login = browserLogins.get(state?.split('.', 1)[0]);
    if (!login || login.state !== state || login.expiresAt <= time || login.status !== 'pending' || cookieValue(req, pluginStateCookie) !== state) {
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
      const r = await githubForm('/login/oauth/access_token', { client_id: clientId, client_secret: clientSecret, code, redirect_uri: callback, code_verifier: login.githubVerifier });
      const user = await identity(r.access_token);
      if (user && login.expiresAt > now()) { login.user = user; login.status = 'authorized'; return browserResult(res, 200, 'GitHub 授权成功，可以关闭这个页面并回到 Orca。'); }
    } catch {}
    login.status = 'github_unavailable';
    return browserResult(res, 502, 'GitHub 授权未完成，请回到 Orca 重试。');
  }

  async function pluginPoll(req, res, time) {
    const input = parseJson(await readBody(req));
    if (!tokenPattern.test(input?.verifier ?? '')) return send(res, 400, { code: 'invalid' });
    const login = browserLogins.get(challengeOf(input.verifier));
    if (!login) return send(res, 202, { code: 'pending' });
    if (login.expiresAt <= time) return send(res, 410, { code: 'login_expired' });
    if (login.status === 'consumed') return input.received === true ? send(res, 200, { ok: true }) : send(res, 410, { code: 'login_expired' });
    if (login.status === 'pending' || login.status === 'exchanging') return send(res, 202, { code: 'pending' });
    if (login.status === 'authorized') {
      if (input.received === true) return send(res, 202, { code: 'pending' });
      login.sessionToken = issueSession(login.user, 'plugin', time, 30 * 24 * HOUR);
      login.status = 'delivered'; delete login.user;
    }
    if (login.status !== 'delivered') return send(res, 410, { code: login.status });
    const account = store.session(digest(login.sessionToken), 'plugin', time);
    if (input.received === true || !account) {
      login.status = 'consumed'; delete login.sessionToken;
      return input.received === true ? send(res, 200, { ok: true }) : send(res, 410, { code: 'login_expired' });
    }
    return send(res, 200, { token: login.sessionToken, username: account.username });
  }

  function adminStart(res) {
    const state = newToken(), target = new URL('/login/oauth/authorize', GITHUB);
    target.search = new URLSearchParams({ client_id: clientId, redirect_uri: callback, state, ...(store.administrator() ? {} : { scope: 'user:email' }) });
    res.setHeader('Set-Cookie', cookie(stateCookie, state, 600));
    redirect(res, target.href);
  }

  async function adminCallback(req, res, url, time) {
    const state = url.searchParams.get('state'), code = url.searchParams.get('code');
    res.setHeader('Set-Cookie', cookie(stateCookie, '', 0));
    if (!state || !tokenPattern.test(state) || state !== cookieValue(req, stateCookie) || !code || code.length > 256) return redirect(res, '/admin?feedback=failed');
    const r = await githubForm('/login/oauth/access_token', { client_id: clientId, client_secret: clientSecret, code, redirect_uri: callback });
    const user = await identity(r.access_token);
    if (!user) return redirect(res, '/admin?feedback=failed');
    const administrator = store.administrator();
    if (!administrator) {
      const emails = adminEmail ? await githubGet('/user/emails', r.access_token) : null;
      if (!Array.isArray(emails) || !emails.some(e => e.verified === true && typeof e.email === 'string' && e.email.toLowerCase() === adminEmail.toLowerCase())) {
        return redirect(res, '/admin?feedback=forbidden');
      }
    } else if (administrator !== user.id) return redirect(res, '/admin?feedback=forbidden');
    const token = issueSession(user, 'admin', time, 12 * HOUR);
    if (!token) return redirect(res, '/admin?feedback=forbidden');
    res.setHeader('Set-Cookie', [cookie(stateCookie, '', 0), cookie(adminCookie, token, 12 * 3600)]);
    redirect(res, '/admin');
  }

  async function admin(req, res, url, time) {
    const token = cookieValue(req, adminCookie);
    const account = tokenPattern.test(token ?? '') ? store.session(digest(token), 'admin', time) : null;
    const permitted = account && account.id === store.administrator();
    if (req.method === 'GET' && url.pathname === '/admin') {
      const search = (url.searchParams.get('q') ?? '').slice(0, 39), message = feedback[url.searchParams.get('feedback')];
      return send(res, 200, permitted ? adminPage({ search, username: account.username, feedback: message, ...store.adminView(search) }) : adminLogin(message, githubConfigured), 'text/html; charset=utf-8');
    }
    if (req.method !== 'POST' || !['/admin/logout', '/admin/ban'].includes(url.pathname)) return send(res, 404, { code: 'not_found' });
    if (!permitted || req.headers.origin !== base.origin) return send(res, 403, { code: 'forbidden' });
    if (url.pathname === '/admin/logout') { store.removeSession(digest(token), time); res.setHeader('Set-Cookie', cookie(adminCookie, '', 0)); return redirect(res, '/admin'); }
    const form = new URLSearchParams(await readBody(req) ?? ''), target = Number(form.get('account')), action = form.get('ban');
    const changed = Number.isSafeInteger(target) && target > 0 && ['0', '1'].includes(action) && store.setBan(account.id, target, action === '1', time, form.get('reason') ?? '');
    if (changed) tokensJobs?.setBan?.(target, action === '1');
    redirect(res, '/admin?' + new URLSearchParams({ q: form.get('q')?.slice(0, 39) ?? '', feedback: changed ? 'updated' : 'rejected' }));
  }

  const pluginSession = (handler, { packet = false } = {}) => context => {
    const { req, res, time, ip } = context, token = /^Bearer ([\w-]{43})$/.exec(req.headers.authorization ?? '')?.[1];
    const sessionDigest = token ? digest(token) : null, account = sessionDigest ? store.session(sessionDigest, 'plugin', time) : null;
    if (!account) return packet && !allowRequest('invalid-packet/' + ip, 240) ? rateLimited(res, time) : send(res, 401, { code: 'login_required' });
    return handler(context, account, sessionDigest);
  };
  const githubLogin = handler => context => githubConfigured ? handler(context) : send(context.res, 503, { code: 'github_unavailable' });
  const authRate = { bucket: 'auth/', limit: 120 }, otherRate = { bucket: 'other/', limit: 240 }, rankingRate = { bucket: 'ranking/', limit: 2400 };
  const routes = new Map([
    ['GET /healthz', { respond: ({ res }) => send(res, 200, { ok: true, githubConfigured }) }],
    ['GET /', { respond: ({ res }) => redirect(res, '/admin') }],
    ['GET /auth/github/start', { respond: ({ res }) => githubConfigured ? adminStart(res) : redirect(res, '/admin') }],
    ['GET /auth/plugin/start', { respond: ({ req, res, url, time }) => pluginStart(req, res, url, time) }],
    ['GET /auth/github/callback', { respond: ({ req, res, url, time }) => !githubConfigured ? redirect(res, '/admin')
      : url.searchParams.get('state')?.includes('.') ? pluginCallback(req, res, url, time) : adminCallback(req, res, url, time) }],
    ['GET /admin/local-time.js', { respond: ({ res }) => send(res, 200, localTimes, 'text/javascript; charset=utf-8') }],
    ['POST /api/auth/device/start', { respond: githubLogin(({ res, time }) => deviceStart(res, time)) }],
    ['POST /api/auth/device/poll', { respond: githubLogin(({ req, res, time }) => devicePoll(req, res, time)) }],
    ['POST /api/auth/plugin/poll', { respond: githubLogin(({ req, res, time }) => pluginPoll(req, res, time)) }],
    ['POST /api/auth/logout', { respond: pluginSession(({ res, time }, _, d) => { store.removeSession(d, time); return send(res, 200, { ok: true }); }) }]
  ]);
  if (tokensJobs) {
    routes.set('GET ' + TOKENS_LEADERBOARD + '/config', { rate: rankingRate, respond: ({ res }) => send(res, 200, { intervals: tokensJobs.intervals, speedSampleWindowMs: SPEED_SAMPLE_WINDOW_MS }) });
    routes.set('GET ' + TOKENS_LEADERBOARD + '/snapshot', { rate: rankingRate, respond: ({ res, url }) => {
      const mode = url.searchParams.get('mode') === 'calendar' ? 'calendar' : 'hourly', snap = tokensJobs.snapshot(mode);
      if (!snap) return send(res, 503, { code: 'unavailable' });
      if (snap instanceof Uint8Array) { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); return res.end(snap); }
      const view = leaderboardSnapshotForMode(snap, mode);
      return view ? send(res, 200, view) : send(res, 404, { code: 'server_update_required' });
    } });
    routes.set('GET ' + TOKENS_LEADERBOARD + '/account', { respond: pluginSession(({ res }, a) => send(res, 200, { accountId: a.id, username: a.username, banned: Boolean(a.banned) })) });
    routes.set('POST ' + TOKENS_LEADERBOARD + '/packets', { rate: false, respond: pluginSession(async ({ req, res }, a) => {
      if (a.banned) return send(res, 403, { code: 'banned', username: a.username });
      const raw = await readBody(req, 1024 * 1024);
      return raw && await tokensJobs.receive(a, raw) ? send(res, 202, { code: 'accepted' }) : send(res, 400, { code: 'invalid' });
    }, { packet: true }) });
  }

  async function handle(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=604800');
    const time = now(), curMin = Math.floor(time / 60000);
    if (curMin !== minute) {
      requests.clear();
      for (const logins of [deviceLogins, browserLogins]) for (const [k, l] of logins) if (l.expiresAt <= time) logins.delete(k);
      minute = curMin;
    }
    const url = new URL(req.url, base), pathname = url.pathname, route = routes.get(`${req.method} ${pathname}`);
    const address = normalizeIp(req.socket.remoteAddress) ?? req.socket.remoteAddress;
    const ip = (trustedProxies.has(address) ? normalizeIp(req.headers['x-real-ip']) : null) ?? address;
    const rate = route?.rate ?? (pathname.startsWith('/auth/') || pathname.startsWith('/api/auth/') ? authRate : otherRate);
    if (rate && !allowRequest(rate.bucket + ip, rate.limit)) return rateLimited(res, time);
    if (route) return route.respond({ req, res, url, time, ip });
    return pathname === '/admin' || pathname.startsWith('/admin/') ? admin(req, res, url, time) : send(res, 404, { code: 'not_found' });
  }

  return createServer({ requestTimeout: 15_000, headersTimeout: 10_000, maxHeaderSize: 8192 }, (req, res) => {
    void handle(req, res).catch(() => { log('榜单请求处理失败。'); res.headersSent ? res.destroy() : send(res, 500, { code: 'unavailable' }); });
  });
}

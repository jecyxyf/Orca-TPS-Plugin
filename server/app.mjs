import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { leaderboardDay, leaderboardDayStart } from '../src/usage-summary.mjs';
import { RECENT_STATS_MS, RANKING_HOURS } from '../src/leaderboard-stats.mjs';
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
  fetcher = fetch, now = Date.now, log = () => {}
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
  const publicRankings = new Map();
  const hourlyRankings = new Map();
  let minute, prunedDay, publicSpeeds;

  function cachedJson(value) {
    const body = JSON.stringify(value);
    return { body, etag: '"' + createHash('sha256').update(body).digest('base64url') + '"' };
  }

  function sendCached(req, res, snapshot) {
    res.setHeader('ETag', snapshot.etag);
    if (req.headers['if-none-match'] === snapshot.etag) {
      res.writeHead(304);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(snapshot.body);
  }

  function sendSpeedRanking(req, res, time) {
    const revision = store.speedRevision();
    if (!publicSpeeds || publicSpeeds.revision !== revision || time >= publicSpeeds.expiresAt) {
      const { rows, expiresAt } = store.speedRanking(time);
      publicSpeeds = { ...cachedJson({ rows }), revision, expiresAt };
    }
    res.setHeader('Date', new Date(time).toUTCString());
    return sendCached(req, res, publicSpeeds);
  }

  function sendHourlyRanking(req, res, url, time, recent) {
    const text = url.searchParams.get('hours');
    const hours = Number(text);
    if (!RANKING_HOURS.includes(hours) || String(hours) !== text) return send(res, 400, { code: 'invalid' });
    res.setHeader('Date', new Date(time).toUTCString());
    const settled = store.hourly.settle(time);
    const snapshotId = `${settled.cutoff}-${settled.revision}`;
    if (recent && url.searchParams.get('snapshotId') !== snapshotId) {
      return send(res, 409, { code: 'snapshot_expired' });
    }
    let snapshot = hourlyRankings.get(hours);
    if (snapshot?.snapshotId !== snapshotId) {
      const ranking = store.hourly.ranking(hours, settled);
      snapshot = { snapshotId, members: ranking.rows.map(({ account, username }) => ({ account, username })),
        response: cachedJson({ ...ranking, rows: ranking.rows.map(({ account, ...row }) => row) }) };
      hourlyRankings.set(hours, snapshot);
    }
    if (!recent) return sendCached(req, res, snapshot.response);
    const revision = store.rankingRevision();
    if (!snapshot.recent || snapshot.recent.revision !== revision || time >= snapshot.recent.expiresAt) {
      const accounts = snapshot.members.map(row => row.account);
      const entries = store.recentRows(accounts, time, hours !== 24), uploads = store.latestUploads(accounts);
      let expiresAt = Infinity;
      const rows = snapshot.members.map(({ account, username }) => {
        const entry = entries.get(account);
        if (entry) expiresAt = Math.min(expiresAt, entry.points[0].submittedAt + RECENT_STATS_MS);
        return { username, submittedAt: uploads.get(account) ?? null, topModel: entry?.topModel ?? null,
          topCli: entry?.topCli ?? null, ...(hours === 24 ? { points: entry?.points ?? [] } : {}) };
      });
      snapshot.recent = { ...cachedJson({ snapshotId, rows }), revision, expiresAt };
    }
    return sendCached(req, res, snapshot.recent);
  }

  function sendPublicRanking(req, res, days, time, day, includeDaily) {
    const revision = store.rankingRevision();
    const key = includeDaily ? `${days}/daily` : days;
    let snapshot = publicRankings.get(key);
    if (!snapshot || snapshot.revision !== revision || snapshot.day !== day || time >= snapshot.expiresAt) {
      const ranking = store.ranking(null, time, days, true, includeDaily);
      let expiresAt = leaderboardDayStart(day) + 86_400_000;
      for (const row of ranking.rows) {
        if (row.recent.points.length) expiresAt = Math.min(expiresAt, row.recent.points[0].submittedAt + RECENT_STATS_MS);
      }
      snapshot = { ...cachedJson({ authenticated: false, ...ranking }), revision, day, expiresAt };
      publicRankings.set(key, snapshot);
    }
    return sendCached(req, res, snapshot);
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
      if (store.setBan(account.id, target, form.get('ban') === '1', time, form.get('reason') ?? '')) result = 'updated';
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
      store.pruneRecent(time);
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
    const requestKey = (auth ? 'auth/' : 'other/') + ip;
    const count = (requests.get(requestKey) ?? 0) + 1;
    if (count > (auth ? 120 : 240)) return send(res, 429, { code: 'rate_limited' });
    requests.set(requestKey, count);

    if (method === 'GET' && route === '/healthz') return send(res, 200, { ok: true, githubConfigured });
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
    if (method === 'GET' && route === '/api/leaderboard/speeds') return sendSpeedRanking(req, res, time);
    if (method === 'GET' && (route === '/api/leaderboard/usage' || route === '/api/leaderboard/recent')) {
      return sendHourlyRanking(req, res, url, time, route.endsWith('/recent'));
    }

    const token = /^Bearer ([\w-]{43})$/.exec(req.headers.authorization ?? '')?.[1];
    const account = token ? store.session(digest(token), 'plugin', time) : null;
    if (method === 'GET' && route === '/api/today') {
      const days = url.searchParams.get('days') ?? '1';
      if (!['1', '7', '30'].includes(days)) return send(res, 400, { code: 'invalid' });
      const includeRecent = url.searchParams.get('stats') === '1';
      const includeDaily = includeRecent && days !== '1' && url.searchParams.get('daily') === '1';
      if (!account && includeRecent) return sendPublicRanking(req, res, Number(days), time, day, includeDaily);
      const ranking = store.ranking(account?.id ?? null, time, Number(days), includeRecent, includeDaily);
      const viewer = account ? { authenticated: true, banned: Boolean(account.banned), username: account.username } : { authenticated: false };
      return send(res, 200, { ...viewer, ...ranking });
    }
    if (!account) return send(res, 401, { code: 'login_required' });
    if (method === 'POST' && route === '/api/auth/logout') {
      store.removeSession(digest(token));
      return send(res, 200, { ok: true });
    }
    if (account.banned) return send(res, 403, { code: 'banned', username: account.username });
    if (method === 'POST' && route === '/api/leaderboard/window-data') {
      const raw = await readBody(req), requestId = req.headers['idempotency-key'];
      if (typeof requestId !== 'string' || !/^[\w-]{16,128}$/.test(requestId) ||
          req.headers['content-type']?.split(';')[0] !== 'application/json') return send(res, 400, { code: 'invalid' });
      const body = parseJson(raw);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { code: 'invalid' });
      const receivedAt = now();
      const current = store.session(digest(token), 'plugin', receivedAt);
      if (!current) return send(res, 401, { code: 'login_required' });
      if (current.banned) return send(res, 403, { code: 'banned' });
      store.hourly.settle(receivedAt);
      const result = store.hourly.submit(current.id, { ...body, requestId, fingerprint: digest(raw) }, receivedAt, maxTokens);
      return send(res, result.code === 'stale_version' ? 409 : statuses[result.code], result);
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
        stats: body?.stats,
        requestId: (history ? 'history:' : '') + (validRequestId ? requestId : randomUUID()),
        fingerprint: digest(raw ?? 'oversized request')
      };
      const code = history ? store.initializeHistory(account.id, input, receivedAt, maxTokens) :
        store.submit(account.id, input, receivedAt, maxTokens);
      return send(res, statuses[code], { code, username: account.username,
        ...(code === 'banned' ? {} : store.status(account.id, receivedAt)) });
    }
    return send(res, 404, { code: 'not_found' });
  }

  return createServer({ requestTimeout: 15_000, headersTimeout: 10_000, maxHeaderSize: 8192 }, (req, res) => {
    void handle(req, res).catch(() => {
      log('榜单请求处理失败。');
      if (!res.headersSent) send(res, 500, { code: 'unavailable' });
      else res.destroy();
    });
  });
}

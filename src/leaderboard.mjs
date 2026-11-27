import { createHash, randomBytes } from 'node:crypto';
import { sourceMessage } from './locales.mjs';
import { createAvatarCache, githubLoginKey } from './leaderboard-avatars.mjs';
import { createWindowViews } from './leaderboard-windows.mjs';
import { HOUR_MS, TOKENS_LEADERBOARD } from './leaderboard_stats.mjs';

const METHOD = 'tps.leaderboard', SECRET = 'leaderboard-session', ACCOUNT_CACHE = 'leaderboard:account';
const RANKING_ENABLED = 'leaderboard:ranking-enabled', DEFAULT_ENDPOINT = 'https://itps8.com';
const LOGIN_TIMEOUT = 600_000, LOGIN_POLL = 2000, SESSION_MAX_AGE = 30 * 24 * HOUR_MS;
const LOGOUT_RETRY = 15_000, MANAGER_ACCOUNT_RETRY = 5000, MANAGER_BAN_RECHECK = 60_000;
const sessionKey = v => v ? createHash('sha256').update(v).digest('hex') : '';
const tokenPattern = /^[\w-]{43}$/;
const validUsername = v => typeof v === 'string' && v.length > 0 && v.length <= 39;

export function startLeaderboard(orca, {
  localDb, manager, onUsername = () => {}, endpoint = process.env.ORCA_TPS_LEADERBOARD_URL || DEFAULT_ENDPOINT,
  fetcher = fetch, avatarFetcher = fetch, now = () => new Date()
}) {
  const base = new URL(endpoint);
  if (base.username || base.password || (base.protocol !== 'https:' && (base.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))) {
    throw new Error(sourceMessage('notice.https-required'));
  }
  const lifetime = new AbortController(), host = orca.host, revocations = new Map();
  const avatars = createAvatarCache({ fetcher: avatarFetcher, now: () => now().getTime(), signal: lifetime.signal });
  const viewOpts = {
    origin: base.origin, request, now: () => now().getTime(), panels: localDb,
    scope: () => `${base.origin}/tokens-manager/${token ? accountId ?? sessionKey(token) : 'guest'}`
  };
  const windows = createWindowViews(viewOpts), calendarWindows = createWindowViews({ ...viewOpts, mode: 'calendar' });
  let token = '', login, username = '', accountId, banned = false, sessionProblem = '';
  let credentialWrite = Promise.resolve(), accountWrite = Promise.resolve(), credentialStorageFailed = false;
  let rankingAccess, rankingPrefWrite = Promise.resolve(), lastUpload = null, lastSyncAt = null, sessionSignature;
  let managerToken, managerPending, managerRetry = 0;

  const rankingPrefReady = Promise.resolve().then(() => orca.storage.get(RANKING_ENABLED)).catch(() => undefined).then(enabled => {
    if (enabled !== false && !lifetime.signal.aborted) rankingAccess = new AbortController();
  });
  const secretAvailable = method => orca.grantedCapabilities?.includes('secrets:own') && host?.has(method);

  const ready = (async () => {
    const [account, saved] = await Promise.allSettled([
      orca.storage.get(ACCOUNT_CACHE),
      secretAvailable('secrets.get') ? host.call('secrets.get', { key: SECRET }) : undefined
    ]);
    restoreCredentials(saved.value?.value);
    const cached = account.value;
    if (token && cached?.origin === base.origin && cached.session === sessionKey(token) && validUsername(cached.username)) {
      username = cached.username;
      if (Number.isSafeInteger(cached.accountId) && cached.accountId > 0) {
        localDb?.saveCollection({ githubUserId: cached.accountId }, now().getTime());
        accountId = cached.accountId;
      }
      onUsername(username);
      if (Number.isSafeInteger(cached.lastSyncAt) && cached.lastSyncAt >= 0 && cached.lastSyncAt <= now().getTime()) lastSyncAt = cached.lastSyncAt;
    }
  })();

  function restoreCredentials(value) {
    if (typeof value !== 'string') return;
    if (tokenPattern.test(value)) { token = value; return; }
    let saved;
    try { saved = JSON.parse(value); } catch { return; }
    if (saved?.origin !== base.origin) return;
    const time = now().getTime();
    for (const e of Array.isArray(saved.pending) ? saved.pending : []) {
      if (typeof e?.token === 'string' && tokenPattern.test(e.token) && Number.isSafeInteger(e.expiresAt) && e.expiresAt > time) {
        revocations.set(e.token, { expiresAt: e.expiresAt, retryAt: 0 });
      }
    }
    if (typeof saved.token === 'string' && tokenPattern.test(saved.token) && !revocations.has(saved.token)) token = saved.token;
    if (Array.isArray(saved.pending) && saved.pending.length !== revocations.size) void persistCredentials();
  }

  function saveAccount() {
    const profile = username ? { origin: base.origin, session: sessionKey(token), username, lastSyncAt, ...(accountId === undefined ? {} : { accountId }) } : null;
    accountWrite = accountWrite.then(() => orca.storage.set(ACCOUNT_CACHE, profile)).catch(() => {});
  }
  function rememberUsername(value) { if (value !== username) { username = value; onUsername(value || null); saveAccount(); } }

  function persistCredentials() {
    const pending = [...revocations].map(([t, { expiresAt }]) => ({ token: t, expiresAt }));
    const op = token || pending.length ? 'secrets.set' : 'secrets.delete';
    const payload = { key: SECRET, ...(op === 'secrets.set' ? { value: JSON.stringify({ origin: base.origin, token, pending }) } : {}) };
    credentialWrite = credentialWrite.then(async () => {
      if (!secretAvailable(op)) { credentialStorageFailed = true; return; }
      try { await host.call(op, payload); credentialStorageFailed = false; } catch { credentialStorageFailed = true; }
    });
    return credentialWrite;
  }

  async function saveToken(value, problem = '') {
    if (token !== value) {
      if (token) manager.setCredential({ token: null, accountId: accountId ?? null });
      token = value; managerToken = undefined; managerRetry = 0; lastSyncAt = null; accountId = undefined;
      rememberUsername(''); sessionProblem = problem; banned = false; lastUpload = null; publishSession();
    }
    await persistCredentials();
  }

  async function request(path, { body, auth = true, credential = auth ? token : '', viewHeaders = false, signal } = {}) {
    try {
      const headers = { Accept: 'application/json', ...(credential ? { Authorization: 'Bearer ' + credential } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) };
      const response = await fetcher(new URL(path, base), {
        method: body === undefined ? 'GET' : 'POST', headers, redirect: 'error',
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000), ...(signal ? [signal] : [])])
      });
      if (response.status === 401) { if (auth && credential && token === credential) await saveToken('', 'session_expired'); return { code: 'login_required' }; }
      const result = await response.json();
      if (!result || typeof result !== 'object' || (!response.ok && typeof result.code !== 'string')) return { code: 'unavailable' };
      return viewHeaders && !Number.isFinite(result.serverTime) ? { ...result, serverTime: Date.parse(response.headers?.get?.('date') ?? '') } : result;
    } catch { return { code: 'unavailable' }; }
  }

  async function rankingPreference(enabled) {
    await rankingPrefReady;
    if (typeof enabled !== 'boolean' || lifetime.signal.aborted) return { enabled: Boolean(rankingAccess) };
    if (enabled !== Boolean(rankingAccess)) {
      if (enabled) rankingAccess = new AbortController();
      else { rankingAccess.abort(); rankingAccess = undefined; windows.clear(); calendarWindows.clear(); }
      try { orca.panels.post?.(METHOD + '.ranking-preference', { enabled }); } catch {}
    }
    const writing = rankingPrefWrite.then(() => orca.storage.set(RANKING_ENABLED, enabled));
    rankingPrefWrite = writing.catch(() => {});
    return { enabled: Boolean(rankingAccess), saved: await writing.then(() => true, () => false) };
  }

  const panelState = days => {
    const signedIn = Boolean(token), status = signedIn ? manager.uploadStatus() : undefined;
    return {
      days, board: signedIn ? { authenticated: true, username, banned } : { authenticated: false },
      updatedAt: null, signedIn, sessionProblem, logoutPending: revocations.size > 0,
      logoutStorageFailed: revocations.size > 0 && credentialStorageFailed,
      nextAutomaticAt: status?.nextAt ?? null, uploading: status?.pending === true, lastUpload, lastSyncAt
    };
  };

  function publishSession() {
    if (lifetime.signal.aborted) return;
    const at = manager.lastUploaded();
    if (at && at > (lastSyncAt ?? 0) && token && accountId) { lastSyncAt = at; lastUpload = { code: 'accepted', kind: 'automatic', at }; saveAccount(); }
    const status = manager.uploadStatus();
    if (token && status?.code && status.code !== 'accepted' && status.at > (lastUpload?.at ?? 0)) {
      lastUpload = { code: status.code, kind: 'automatic', at: status.at };
      if (status.code === 'login_required') { managerToken = undefined; managerRetry = 0; bindManager(); }
      else if (status.code === 'banned') { banned = true; managerRetry = now().getTime() + MANAGER_BAN_RECHECK; }
    }
    if (!orca.panels.post) return;
    const snapshot = panelState(1), sig = JSON.stringify(snapshot);
    if (sig === sessionSignature) return;
    try { orca.panels.post('tps.leaderboard.session', snapshot); sessionSignature = sig; } catch {}
  }

  function revokeSessions() {
    if (lifetime.signal.aborted) return;
    const time = now().getTime();
    let persist = false;
    for (const [credential, pending] of revocations) {
      if (pending.expiresAt <= time) { revocations.delete(credential); persist = true; continue; }
      if (pending.retryAt > time) continue;
      persist ||= credentialStorageFailed; pending.retryAt = Infinity;
      void request('/api/auth/logout', { auth: false, credential, body: {} }).then(r => {
        if (lifetime.signal.aborted || revocations.get(credential) !== pending) return;
        if (r.ok === true || r.code === 'login_required') { revocations.delete(credential); void persistCredentials(); }
        else pending.retryAt = now().getTime() + LOGOUT_RETRY;
      });
    }
    if (persist) void persistCredentials();
  }

  function bindManager() {
    if (!token || (managerToken === token && !banned) || managerPending || now().getTime() < managerRetry) return;
    const current = token;
    managerRetry = now().getTime() + MANAGER_ACCOUNT_RETRY;
    managerPending = request(TOKENS_LEADERBOARD + '/account').then(r => {
      if (token !== current || lifetime.signal.aborted || !(Number.isSafeInteger(r.accountId) && r.accountId > 0)) return;
      accountId = r.accountId; banned = r.banned === true; managerToken = current;
      if (banned) managerRetry = now().getTime() + MANAGER_BAN_RECHECK;
      else manager.setCredential({ token: current, accountId });
      if (validUsername(r.username)) rememberUsername(r.username);
      saveAccount(); publishSession();
    }).finally(() => { managerPending = undefined; });
  }

  const registration = orca.panels.handle(METHOD, async payload => {
    const days = payload?.days === 7 || payload?.days === 30 ? payload.days : 1;
    if (payload?.action === 'ranking-preference') return rankingPreference(payload.enabled);
    if (payload?.action === 'window-state' || payload?.action === 'window-cache') {
      await rankingPrefReady;
      const signal = rankingAccess?.signal;
      if (!signal) return {};
      const hours = payload.days === 0 ? 0 : days * 24, view = payload.mode === 'calendar' ? calendarWindows : windows;
      if (payload.action === 'window-cache') {
        const cached = await view.load(hours, signal);
        return { ranking: cached ? { boards: cached.boards, updatedAt: cached.updatedAt } : null };
      }
      const r = await view.fetch(hours, payload.force === true, signal);
      if (signal.aborted) return {};
      return r.boards ? { boards: r.boards, updatedAt: r.updatedAt, refreshAt: r.refreshAt, ...(r.nextAt - r.cutoffAt === HOUR_MS ? { cutoffAt: r.cutoffAt, nextAt: r.nextAt } : {}) }
        : { updatedAt: null, code: r.code ?? 'unavailable' };
    }
    await ready;
    switch (payload?.action) {
      case 'avatar': {
        const key = githubLoginKey(payload.username);
        if (key === null) return { image: null };
        const known = githubLoginKey(username) === key || windows.known(key) || calendarWindows.known(key);
        return { image: known ? await avatars.get(key) : null };
      }
      case 'session': return panelState(days);
      case 'login': {
        const verifier = randomBytes(32).toString('base64url'), url = new URL('/auth/plugin/start', base);
        url.searchParams.set('challenge', createHash('sha256').update(verifier).digest('base64url'));
        login = { verifier, url: url.href, expiresAt: 0 };
        return { loginUrl: login.url, interval: LOGIN_POLL, timeout: LOGIN_TIMEOUT };
      }
      case 'poll': {
        if (!login) return { code: 'login_expired' };
        const attempt = login, time = now().getTime();
        attempt.expiresAt ||= time + LOGIN_TIMEOUT;
        if (time >= attempt.expiresAt) { login = undefined; return { code: 'login_expired' }; }
        const r = await request('/api/auth/plugin/poll', { auth: false, body: { verifier: attempt.verifier } });
        if (attempt !== login) return { code: 'login_expired' };
        if (tokenPattern.test(r.token ?? '')) {
          login = undefined; await saveToken(r.token);
          if (token !== r.token || lifetime.signal.aborted) return { code: 'login_expired' };
          if (validUsername(r.username)) rememberUsername(r.username);
          void request('/api/auth/plugin/poll', { auth: false, body: { verifier: attempt.verifier, received: true } });
          return { code: 'signed_in', ...panelState(days) };
        }
        if (['login_expired', 'login_denied', 'github_unavailable'].includes(r.code)) login = undefined;
        return { code: r.code || 'unavailable' };
      }
      case 'cancel': if (!payload.loginUrl || login?.url === payload.loginUrl) login = undefined; return { ok: true };
      case 'logout': {
        login = undefined; sessionProblem = '';
        const credential = token, pending = credential ? { expiresAt: now().getTime() + SESSION_MAX_AGE, retryAt: Infinity } : null;
        if (pending) revocations.set(credential, pending);
        await saveToken('');
        if (pending) { pending.retryAt = 0; revokeSessions(); }
        return { code: 'signed_out', ...panelState(days) };
      }
      case 'submit':
      case 'sync': return { code: !token ? 'login_required' : banned ? 'banned' : manager.upload() ? 'sync_queued' : 'unavailable', ...panelState(days) };
      default: return { code: 'invalid' };
    }
  });

  const tick = () => void ready.then(() => { if (!lifetime.signal.aborted) { revokeSessions(); bindManager(); publishSession(); } });
  const timer = setInterval(tick, 1000);
  timer.unref?.();
  const stopUploadState = manager.onUploadState?.(publishSession);
  tick();
  return () => {
    lifetime.abort(); rankingAccess?.abort(); stopUploadState?.(); clearInterval(timer); registration.dispose?.();
    return Promise.allSettled([accountWrite, credentialWrite, rankingPrefWrite]);
  };
}

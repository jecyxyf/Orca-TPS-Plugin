import { sourceMessage } from './locales.mjs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { leaderboardDay, leaderboardDayStart } from './usage-summary.mjs';
import { validInstallationId } from './leaderboard-installation.mjs';
import { createAvatarCache, githubLoginKey } from './leaderboard-avatars.mjs';
import { validStatsLabel, validStatsPoint } from './leaderboard-stats.mjs';
import { uploadHourChanges } from './hourly-upload.mjs';
import { createWindowViews } from './leaderboard-windows.mjs';

const METHOD = 'tps.leaderboard';
const SECRET = 'leaderboard-session';
const ACCOUNT_CACHE = 'leaderboard:account';
const INSTALLATION = 'leaderboard:installation-id';
const HISTORY = 'leaderboard:history';
const RANKING_CACHE = 'leaderboard:ranking';
const RANKING_ENABLED = 'leaderboard:ranking-enabled';
const DEFAULT_ENDPOINT = 'https://43.157.2.14';
const LOGIN_TIMEOUT = 10 * 60 * 1000;
const LOGIN_POLL = 2000;
const SESSION_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const LOGOUT_RETRY = 15_000;
const UPLOAD_INTERVAL = 10_000;
const SYNC_SUCCEEDED = new Set(['accepted', 'initialized', 'duplicate']);
const sessionKey = value => value ? createHash('sha256').update(value).digest('hex') : '';
const tokenPattern = /^[\w-]{43}$/;
const validUsername = value => typeof value === 'string' && value.length > 0 && value.length <= 39;

function publicRows(rows, days, day) {
  if (!Array.isArray(rows) || rows.length > 100 || !rows.every(row =>
    row && typeof row.username === 'string' && Number.isSafeInteger(row.rank) && row.rank > 0 &&
    Number.isInteger(row.tokens) && row.tokens > 0 && row.tokens <= days * Number.MAX_SAFE_INTEGER &&
    Number.isSafeInteger(row.submittedAt) && Number.isFinite(new Date(row.submittedAt).getTime())
  )) return null;
  const firstDay = day && leaderboardDay(leaderboardDayStart(day) - (days - 1) * 86_400_000);
  return rows.map(({ rank, username, tokens, submittedAt, recent, daily }) => ({
    rank, username, tokens, submittedAt,
    ...(recent && Array.isArray(recent.points) && recent.points.length <= 30 && recent.points.every(point =>
      point && Number.isSafeInteger(point.submittedAt) && validStatsPoint(point)) &&
      validStatsLabel(recent.topModel) && validStatsLabel(recent.topCli) ? {
        recent: { points: recent.points.map(({ submittedAt, deltaTokens, avgTps }) => ({ submittedAt, deltaTokens, avgTps })),
          topModel: recent.topModel, topCli: recent.topCli }
      } : {}),
    ...(days > 1 && firstDay && Array.isArray(daily) && daily.length <= days && daily.every((point, index) =>
      point && typeof point.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(point.day) &&
      point.day >= firstDay && point.day <= day && (index === 0 || point.day > daily[index - 1].day) &&
      Number.isSafeInteger(point.tokens) && point.tokens > 0) ? {
        daily: daily.map(({ day, tokens }) => ({ day, tokens }))
      } : {})
  }));
}

export function startLeaderboard(orca, {
  readUsage, readHistory, readHours, stats, endpoint = process.env.ORCA_TPS_LEADERBOARD_URL || DEFAULT_ENDPOINT,
  fetcher = fetch, avatarFetcher = fetch, now = () => new Date()
}) {
  const base = new URL(endpoint);
  if (base.username || base.password || (base.protocol !== 'https:' &&
      (base.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))) {
    throw new Error(sourceMessage('notice.https-required'));
  }
  const lifetime = new AbortController();
  const avatars = createAvatarCache({ fetcher: avatarFetcher, now: () => now().getTime(), signal: lifetime.signal });
  const windows = createWindowViews({ storage: orca.storage, origin: base.origin, request, now: () => now().getTime() });
  const host = orca.host;
  let token = '', login, submitting, uploadingKind = null, scheduling = false, nextAttempt = null;
  let credentialWrite = Promise.resolve();
  let username = '', accountWrite = Promise.resolve(), sessionProblem = '';
  let uploadStatus, banned = false;
  const revocations = new Map();
  let credentialStorageFailed = false;
  let historyJob, historyWrite = Promise.resolve(), historyProblem = '';
  const rankingCaches = new Map();
  const rankingRequests = new Map();
  let rankingQueue = Promise.resolve();
  let rankingRequest = 0;
  let rankingAccess, rankingPreferenceWrite = Promise.resolve();
  const rankingPreferenceReady = Promise.resolve().then(() => orca.storage.get(RANKING_ENABLED))
    .catch(() => undefined).then(enabled => {
      if (enabled !== false && !lifetime.signal.aborted) rankingAccess = new AbortController();
    });
  let lastUpload = null, lastSyncAt = null, manualQueued = false, localUploadAt = 0;
  let installationReady;
  let hourUploadRunning = false, nextHourUploadAt = 0, uploadWake;
  const secretAvailable = method => orca.grantedCapabilities?.includes('secrets:own') && host?.has(method);
  const today = () => leaderboardDay(now().getTime());

  function installationId() {
    installationReady ??= (async () => {
      const saved = await orca.storage.get(INSTALLATION);
      if (validInstallationId(saved)) return saved;
      const created = randomUUID();
      await orca.storage.set(INSTALLATION, created);
      return created;
    })().catch(() => {
      installationReady = undefined;
      return null;
    });
    return installationReady;
  }
  void installationId();

  function rankingCache(days) {
    if (rankingCaches.has(days)) return rankingCaches.get(days);
    const key = days === 1 ? RANKING_CACHE : RANKING_CACHE + ':' + days;
    const cache = { key, latestRequest: 0, write: Promise.resolve() };
    rankingCaches.set(days, cache);
    cache.ready = Promise.resolve().then(async () => {
      const saved = await orca.storage.get(key);
      if (cache.value || saved?.origin !== base.origin || saved.day !== today() || !Number.isSafeInteger(saved.updatedAt) ||
          !Number.isFinite(new Date(saved.updatedAt).getTime())) return;
      const rows = publicRows(saved.rows, days);
      if (!rows) return;
      cache.value = { day: saved.day, rows, updatedAt: saved.updatedAt };
      cache.signature = JSON.stringify([saved.day, rows]);
    }).catch(() => {});
    return cache;
  }

  function rememberRanking(cache, day, rows, updatedAt) {
    cache.value = { day, rows, updatedAt };
    const standings = rows.map(({ rank, username, tokens, submittedAt }) => ({ rank, username, tokens, submittedAt }));
    const signature = JSON.stringify([day, standings]);
    if (signature === cache.signature) return;
    cache.signature = signature;
    const saved = { ...cache.value, rows: standings, origin: base.origin };
    cache.write = cache.write.then(async () => {
      try { await orca.storage.set(cache.key, saved); }
      catch { if (cache.signature === signature) cache.signature = undefined; }
    });
  }
  rankingCache(1);

  const ready = (async () => {
    const tasks = [readHistory ? orca.storage.get(HISTORY) : undefined, orca.storage.get(ACCOUNT_CACHE)];
    if (secretAvailable('secrets.get')) tasks.push(host.call('secrets.get', { key: SECRET }));
    const [history, account, saved] = await Promise.allSettled(tasks);
    restoreCredentials(saved?.value?.value);
    if (token) nextAttempt = now().getTime() + UPLOAD_INTERVAL;
    const cached = account.value;
    if (token && cached?.origin === base.origin && cached.session === sessionKey(token) && validUsername(cached.username)) {
      username = cached.username;
      if (Number.isSafeInteger(cached.lastSyncAt) && cached.lastSyncAt >= 0 && cached.lastSyncAt <= now().getTime()) {
        lastSyncAt = cached.lastSyncAt;
        localUploadAt = lastSyncAt + UPLOAD_INTERVAL;
      }
    }
    if (token && history.value?.origin === base.origin && history.value.session === sessionKey(token)) {
      historyJob = { next: nextAttempt };
    }
  })();

  function restoreCredentials(value) {
    if (typeof value !== 'string') return;
    // Earlier installs stored the active token as a plain string in this same secret.
    if (tokenPattern.test(value)) {
      token = value;
      return;
    }
    let saved;
    try { saved = JSON.parse(value); }
    catch { return; }
    if (saved?.origin !== base.origin) return;
    const time = now().getTime();
    if (Array.isArray(saved.pending)) {
      for (const entry of saved.pending) {
        if (typeof entry?.token === 'string' && tokenPattern.test(entry.token) &&
            Number.isSafeInteger(entry.expiresAt) && entry.expiresAt > time) {
          revocations.set(entry.token, { expiresAt: entry.expiresAt, retryAt: 0 });
        }
      }
    }
    if (typeof saved.token === 'string' && tokenPattern.test(saved.token) && !revocations.has(saved.token)) token = saved.token;
    if (Array.isArray(saved.pending) && saved.pending.length !== revocations.size) void persistCredentials();
  }

  function rememberUsername(value) {
    if (value === username) return;
    username = value;
    saveAccount();
  }

  function saveAccount() {
    const profile = username ? { origin: base.origin, session: sessionKey(token), username, lastSyncAt } : null;
    accountWrite = accountWrite.then(() => orca.storage.set(ACCOUNT_CACHE, profile)).catch(() => {});
  }

  function setHistoryJob(job) {
    historyJob = job;
    const saved = job ? { origin: base.origin, session: sessionKey(token) } : null;
    historyWrite = historyWrite.then(() => orca.storage.set(HISTORY, saved)).catch(() => {});
  }

  function persistCredentials() {
    const pending = [...revocations].map(([token, { expiresAt }]) => ({ token, expiresAt }));
    const operation = token || pending.length ? 'secrets.set' : 'secrets.delete';
    const payload = { key: SECRET };
    if (operation === 'secrets.set') payload.value = JSON.stringify({ origin: base.origin, token, pending });
    credentialWrite = credentialWrite.then(async () => {
      if (!secretAvailable(operation)) {
        credentialStorageFailed = true;
        return;
      }
      try {
        await host.call(operation, payload);
        credentialStorageFailed = false;
      } catch {
        credentialStorageFailed = true;
      }
    });
    return credentialWrite;
  }

  async function saveToken(value, problem = '') {
    const changed = token !== value;
    token = value;
    if (changed) {
      nextAttempt = token ? now().getTime() + UPLOAD_INTERVAL : null;
      lastSyncAt = null;
      manualQueued = false;
      localUploadAt = 0;
      rememberUsername('');
      sessionProblem = problem;
      uploadStatus = undefined;
      banned = false;
      lastUpload = null;
      if (historyJob) setHistoryJob(undefined);
      historyProblem = '';
      publishSession();
    }
    await persistCredentials();
  }

  async function request(path, { body, auth = true, credential = auth ? token : '', requestId, etag, acceptEtag = false,
    viewHeaders = false, signal } = {}) {
    try {
      const headers = { Accept: 'application/json' };
      if (credential) headers.Authorization = 'Bearer ' + credential;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (requestId) headers['Idempotency-Key'] = requestId;
      if (etag) headers['If-None-Match'] = etag;
      const response = await fetcher(new URL(path, base), {
        method: body === undefined ? 'GET' : 'POST', headers, redirect: 'error',
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000), ...(signal ? [signal] : [])])
      });
      const serverTime = viewHeaders ? Date.parse(response.headers?.get?.('date') ?? '') : undefined;
      if (response.status === 304 && etag) return { notModified: true, ...(viewHeaders ? { serverTime } : {}) };
      const result = await response.json();
      if (!result || typeof result !== 'object') return { code: 'unavailable' };
      if (auth && credential && token === credential && response.status === 401) {
        await saveToken('', 'session_expired');
      }
      if (viewHeaders) return { ...result, serverTime, etag: response.headers?.get?.('etag') };
      return acceptEtag ? { ...result, etag: response.headers?.get?.('etag') } : result;
    } catch {
      return { code: 'unavailable' };
    }
  }

  async function rankingPreference(enabled) {
    await rankingPreferenceReady;
    if (typeof enabled !== 'boolean' || lifetime.signal.aborted) return { enabled: Boolean(rankingAccess) };
    if (enabled !== Boolean(rankingAccess)) {
      if (enabled) rankingAccess = new AbortController();
      else {
        rankingAccess.abort();
        rankingAccess = undefined;
        windows.clear();
      }
      try { orca.panels.post?.(METHOD + '.ranking-preference', { enabled }); } catch {}
    }
    const writing = rankingPreferenceWrite.then(() => orca.storage.set(RANKING_ENABLED, enabled));
    rankingPreferenceWrite = writing.catch(() => {});
    const saved = await writing.then(() => true, () => false);
    return { enabled: Boolean(rankingAccess), saved };
  }

  async function state(days, force = false) {
    await rankingPreferenceReady;
    const signal = rankingAccess?.signal;
    if (!signal) return panelState(days);
    const running = rankingRequests.get(days);
    if (running?.signal === signal) return running.promise;
    const pending = { signal, promise: undefined };
    pending.promise = rankingQueue.then(() => fetchState(days, force, signal)).finally(() => {
      if (rankingRequests.get(days) === pending) rankingRequests.delete(days);
    });
    rankingRequests.set(days, pending);
    rankingQueue = pending.promise.catch(() => {});
    return pending.promise;
  }

  async function fetchState(days, force, signal) {
    if (signal.aborted) return panelState(days);
    const cache = rankingCache(days);
    const requested = ++rankingRequest;
    const path = stats ? `/api/today?days=${days}&stats=1${days > 1 ? '&daily=1' : ''}`
      : days === 1 ? '/api/today' : '/api/today?days=' + days;
    const etag = !force && cache.snapshot?.day === today() ? cache.etag : undefined;
    const reply = await request(path, { auth: false, etag, acceptEtag: Boolean(stats), signal });
    if (signal.aborted) return panelState(days);
    const board = reply.notModified ? cache.snapshot : reply;
    const updatedAt = now().getTime();
    const rows = (board?.days ?? 1) === days && board?.day === leaderboardDay(updatedAt) ? publicRows(board.rows, days, board.day) : null;
    if (rows && requested > cache.latestRequest) {
      cache.latestRequest = requested;
      if (!reply.notModified) {
        cache.snapshot = board;
        cache.etag = reply.etag;
      }
      rememberRanking(cache, board.day, rows, updatedAt);
    }
    if (!rows) cache.etag = undefined;
    const ranking = rows ? { day: board.day, rows, ...(board.startDay ? { startDay: board.startDay } : {}) }
      : { code: board?.code ?? 'unavailable' };
    return panelState(days, ranking, rows ? updatedAt : null);
  }

  function panelState(days, board = {}, updatedAt = null) {
    const signedIn = Boolean(token);
    if (signedIn) {
      const day = today(), time = now().getTime();
      const own = dailyScore(day);
      const status = uploadStatus?.day === day ? uploadStatus : {};
      const nextUploadAt = uploadDeadline(status, own);
      const newerScore = own && (!status.submitted || (status.tokens !== null && own.submittedAt > status.submittedAt));
      const submitted = newerScore ? { day, submitted: true, tokens: own.tokens, submittedAt: own.submittedAt } : {};
      board = {
        ...board, ...status, ...submitted, username, banned,
        lockedUntil: status.lockedUntil > time ? status.lockedUntil : null,
        nextUploadAt: nextUploadAt > time ? nextUploadAt : null
      };
    }
    if (Array.isArray(board.rows)) {
      const rows = board.rows.map(row => ({ ...row, mine: signedIn && Boolean(username) && row.username === username }));
      board = { ...board, rows, rank: rows.find(row => row.mine)?.rank ?? null };
    }
    return {
      days, board: { ...board, authenticated: signedIn }, updatedAt, signedIn, sessionProblem,
      logoutPending: revocations.size > 0, logoutStorageFailed: revocations.size > 0 && credentialStorageFailed,
      nextAutomaticAt: nextAttempt === null ? null : Math.max(nextAttempt, board.nextUploadAt ?? 0, board.lockedUntil ?? 0),
      uploading: Boolean(submitting), uploadingKind, lastUpload, lastSyncAt, manualQueued,
      initializing: Boolean(historyJob), historyProblem
    };
  }

  let sessionSignature;
  function publishSession() {
    if (lifetime.signal.aborted || !orca.panels.post) return;
    const snapshot = panelState(1), signature = JSON.stringify(snapshot);
    if (signature === sessionSignature) return;
    try {
      orca.panels.post('tps.leaderboard.session', snapshot);
      sessionSignature = signature;
    } catch { /* The panel can still restore a snapshot on open. */ }
  }

  function recordUpload(kind, code) {
    if (code !== 'upload_in_progress' && code !== 'upload_disabled') {
      lastUpload = { kind, code: code || 'unavailable', at: now().getTime() };
      if (SYNC_SUCCEEDED.has(code)) {
        lastSyncAt = lastUpload.at;
        if (username) saveAccount();
      }
    }
  }

  function dailyScore(day) {
    const daily = rankingCaches.get(1)?.value;
    return daily?.day === day && username ? daily.rows.find(row => row.username === username) : undefined;
  }

  function uploadDeadline(status, score) {
    return Math.max(localUploadAt, status.nextUploadAt ?? 0, score ? score.submittedAt + UPLOAD_INTERVAL : 0);
  }

  function beginLogin() {
    const verifier = randomBytes(32).toString('base64url');
    const url = new URL('/auth/plugin/start', base);
    url.searchParams.set('challenge', createHash('sha256').update(verifier).digest('base64url'));
    login = { verifier, url: url.href, expiresAt: 0 };
    return { loginUrl: login.url, interval: LOGIN_POLL, timeout: LOGIN_TIMEOUT };
  }

  async function pollLogin(days) {
    if (!login) return { code: 'login_expired' };
    const attempt = login;
    const time = now().getTime();
    attempt.expiresAt ||= time + LOGIN_TIMEOUT;
    if (time >= attempt.expiresAt) {
      login = undefined;
      return { code: 'login_expired' };
    }
    const result = await request('/api/auth/plugin/poll', { auth: false, body: { verifier: attempt.verifier } });
    if (attempt !== login) return { code: 'login_expired' };
    if (tokenPattern.test(result.token ?? '')) {
      login = undefined;
      await saveToken(result.token);
      if (token !== result.token || lifetime.signal.aborted) return { code: 'login_expired' };
      if (validUsername(result.username)) rememberUsername(result.username);
      void request('/api/auth/plugin/poll', { auth: false, body: { verifier: attempt.verifier, received: true } });
      if (readHistory) {
        setHistoryJob({ next: nextAttempt });
      }
      return { code: 'signed_in', ...panelState(days) };
    }
    if (['login_expired', 'login_denied', 'github_unavailable'].includes(result.code)) login = undefined;
    return { code: result.code || 'unavailable' };
  }

  function revokeSessions() {
    if (lifetime.signal.aborted) return;
    const time = now().getTime();
    let persist = false;
    for (const [credential, pending] of revocations) {
      if (pending.expiresAt <= time) {
        revocations.delete(credential);
        persist = true;
        continue;
      }
      if (pending.retryAt > time) continue;
      persist ||= credentialStorageFailed;
      pending.retryAt = Infinity;
      void request('/api/auth/logout', { auth: false, credential, body: {} }).then(result => {
        if (lifetime.signal.aborted || revocations.get(credential) !== pending) return;
        if (result.ok === true || result.code === 'login_required') {
          revocations.delete(credential);
          void persistCredentials();
        } else {
          pending.retryAt = now().getTime() + LOGOUT_RETRY;
        }
      });
    }
    if (persist) void persistCredentials();
  }

  function submit(preview, kind, stillEnabled) {
    if (submitting) return { code: 'upload_in_progress' };
    uploadingKind = kind;
    submitting = performSubmission(preview, kind, stillEnabled).finally(() => {
      submitting = undefined;
      uploadingKind = null;
    });
    publishSession();
    return submitting;
  }

  async function performSubmission(preview, kind, stillEnabled) {
    if (!token) return { code: 'login_required' };
    const credential = token;
    // Upload whatever today's total has been read so far; later syncs replace it as more files are read.
    if (!Number.isSafeInteger(preview?.tokens) || preview.tokens < 1) return { code: 'usage_unready' };
    const id = await installationId();
    if (!id) return { code: 'installation_unavailable' };
    if (!stillEnabled() || token !== credential || lifetime.signal.aborted) return { code: 'upload_disabled' };
    if (preview.day !== today()) return { code: 'new_day' };
    const status = uploadStatus?.day === preview.day ? uploadStatus : {};
    const time = now().getTime();
    const nextUploadAt = uploadDeadline(status, dailyScore(preview.day));
    if (status.lockedUntil > time) return { code: 'locked', ...status };
    if (status.submitted && status.tokens === null) return { code: 'removed', ...status };
    if (nextUploadAt > time) return { code: 'too_soon', ...status, nextUploadAt };

    const score = { day: preview.day, installationId: id, tokens: preview.tokens };
    const options = stats ? await stats.prepare(sessionKey(credential), score) : { requestId: randomUUID(), body: score };
    if (!stillEnabled() || token !== credential || lifetime.signal.aborted) return { code: 'upload_disabled' };
    const requestedAt = now().getTime();
    let result = await request('/api/today/submit', { ...options, credential });
    if (kind === 'automatic' && result.code === 'unavailable' && token === credential && stillEnabled()) {
      result = await request('/api/today/submit', { ...options, credential });
    }
    if (stats) await stats.settle(options, result.code);
    if (token === credential) {
      if (result.code !== 'banned') {
        const start = SYNC_SUCCEEDED.has(result.code) ? requestedAt : now().getTime();
        localUploadAt = Math.max(start + UPLOAD_INTERVAL, result.nextUploadAt ?? 0);
      }
      rememberUpload(result);
    }
    return result;
  }

  function rememberUpload(result) {
    const { day, tokens, submitted, submittedAt, lockedUntil, nextUploadAt } = result;
    if (validUsername(result.username)) rememberUsername(result.username);
    if (result.code === 'banned') {
      banned = true;
      nextAttempt = null;
      manualQueued = false;
      return;
    }
    if (day === today()) {
      uploadStatus = { day, tokens, submitted, submittedAt, lockedUntil, nextUploadAt };
      if (banned) nextAttempt = now().getTime() + UPLOAD_INTERVAL;
      banned = false;
    }
  }

  async function runScheduled() {
    await ready;
    if (nextAttempt === null || !token || scheduling || submitting || lifetime.signal.aborted) return;
    const day = today(), status = uploadStatus?.day === day ? uploadStatus : {};
    nextAttempt = Math.max(nextAttempt, uploadDeadline(status, dailyScore(day)), status.lockedUntil ?? 0);
    if (now().getTime() < nextAttempt) return;
    const credential = token;
    const stillSignedIn = () => token === credential && !lifetime.signal.aborted;
    scheduling = true;
    try {
      const preview = await readUsage();
      if (!stillSignedIn() || !(preview?.tokens >= 1)) return;
      const kind = manualQueued ? 'manual' : 'automatic';
      manualQueued = false;
      const result = await submit(preview, kind, stillSignedIn);
      if (stillSignedIn()) {
        recordUpload(kind, result.code);
        if (!banned) {
          const retryAt = SYNC_SUCCEEDED.has(result.code) ? localUploadAt : now().getTime() + UPLOAD_INTERVAL;
          nextAttempt = Math.max(retryAt, result.nextUploadAt ?? 0, result.lockedUntil ?? 0);
        }
      }
    } finally { scheduling = false; }
  }

  async function runHistoryInitialization() {
    await ready;
    const job = historyJob;
    if (!job || !token || banned || job.running || lifetime.signal.aborted || now().getTime() < job.next) return;
    job.running = true;
    job.next = now().getTime() + 5000;
    const active = () => historyJob === job && !lifetime.signal.aborted;
    try {
      const day = today(), status = uploadStatus?.day === day ? uploadStatus : {};
      const nextUploadAt = uploadDeadline(status, dailyScore(day));
      job.next = Math.max(job.next, status.lockedUntil ?? 0, nextUploadAt);
      if (status.lockedUntil > now().getTime() || nextUploadAt > now().getTime()) return;
      const snapshot = await readHistory();
      if (!active() || !snapshot.ready || snapshot.day !== today() || submitting || scheduling) return;
      if (!snapshot.scores.length) return setHistoryJob(undefined);
      const id = await installationId();
      if (!active() || snapshot.day !== today() || submitting || scheduling || uploadDeadline(status, dailyScore(day)) > now().getTime()) return;
      if (!id) return recordUpload('history', 'installation_unavailable');
      const attempt = request('/api/history/init', {
        requestId: randomUUID(), body: { day: snapshot.day, installationId: id, scores: snapshot.scores }
      });
      submitting = attempt;
      uploadingKind = 'history';
      publishSession();
      let result;
      try { result = await attempt; }
      finally {
        submitting = undefined;
        uploadingKind = null;
      }
      if (!active()) return;
      if (result.code !== 'banned') localUploadAt = now().getTime() + UPLOAD_INTERVAL;
      rememberUpload(result);
      recordUpload('history', result.code);
      if (['accepted', 'initialized', 'banned'].includes(result.code)) return setHistoryJob(undefined);
      if (result.code === 'invalid' && result.day === snapshot.day) {
        historyProblem = 'history_invalid';
        return setHistoryJob(undefined);
      }
      job.next = Math.max(now().getTime() + 10_000, result.nextUploadAt ?? 0, result.lockedUntil ?? 0);
    } finally { job.running = false; }
  }

  async function runHourUpload() {
    const time = now().getTime();
    if (!readHours || !token || !username || banned || hourUploadRunning || time < nextHourUploadAt || lifetime.signal.aborted) return;
    const credential = token, identity = githubLoginKey(username);
    const active = () => token === credential && githubLoginKey(username) === identity && !banned && !lifetime.signal.aborted;
    if (!identity) return;
    hourUploadRunning = true;
    nextHourUploadAt = time + UPLOAD_INTERVAL;
    try {
      const id = await installationId();
      if (!id || !active()) return;
      const outcome = await uploadHourChanges({ storage: orca.storage, identity: `${base.origin}/${identity}/${id}`,
        installationId: id, now: time, readHours, active,
        send: options => request('/api/leaderboard/window-data', { ...options, credential }) });
      if (outcome === 'not_found') nextHourUploadAt = time + 5 * 60_000;
    } finally { hourUploadRunning = false; }
  }

  async function manualSync(payload, days) {
    const reply = code => ({ code, ...panelState(days) });
    if (!token) return reply('login_required');
    if (scheduling || submitting) return reply('upload_in_progress');
    if (payload.action === 'sync') {
      const day = today(), status = uploadStatus?.day === day ? uploadStatus : {};
      const time = now().getTime();
      if (banned) return reply('banned');
      if (status.lockedUntil > time) return reply('locked');
      if (status.submitted && status.tokens === null) return reply('removed');
      if (uploadDeadline(status, dailyScore(day)) > time) {
        manualQueued = true;
        publishSession();
        return reply('sync_queued');
      }
    }
    const credential = token;
    const stillSignedIn = () => token === credential && !lifetime.signal.aborted;
    scheduling = true;
    try {
      const current = await readUsage();
      if (!stillSignedIn()) return reply('upload_disabled');
      if ((payload.day !== undefined || payload.tokens !== undefined) &&
          (payload.day !== current.day || payload.tokens !== current.tokens)) {
        recordUpload('manual', 'usage_changed');
        return reply('usage_changed');
      }
      manualQueued = false;
      const result = await submit(current, 'manual', stillSignedIn);
      if (stillSignedIn()) recordUpload('manual', result.code);
      return reply(result.code || 'unavailable');
    } finally {
      scheduling = false;
      publishSession();
    }
  }

  const registration = orca.panels.handle(METHOD, async payload => {
    const days = payload?.days === 7 || payload?.days === 30 ? payload.days : 1;
    if (payload?.action === 'ranking-preference') return rankingPreference(payload.enabled);
    if (payload?.action === 'window-state' || payload?.action === 'window-cache') {
      await rankingPreferenceReady;
      const signal = rankingAccess?.signal;
      if (!signal) return {};
      const hours = payload.days === 0 ? 0 : days * 24;
      if (payload.action === 'window-cache') return { ranking: await windows.load(hours, signal) };
      const result = await windows.fetch(hours, payload.force === true, signal);
      if (signal.aborted) return {};
      const { updatedAt, ...board } = result;
      return { board, updatedAt: updatedAt ?? null };
    }
    if (payload?.action === 'cache') {
      await rankingPreferenceReady;
      const signal = rankingAccess?.signal;
      if (!signal) return { ranking: null };
      const cache = rankingCache(days);
      if (!cache.value) await cache.ready;
      return { ranking: !signal.aborted && cache.value?.day === today() ? cache.value : null };
    }
    if (payload?.action === 'usage') return { local: await readUsage() };
    await ready;
    switch (payload?.action) {
      case 'avatar': {
        const key = githubLoginKey(payload.username);
        if (key === null) return { image: null };
        const known = githubLoginKey(username) === key || windows.known(key) || [...rankingCaches.values()].some(cache =>
          cache.value?.rows.some(row => githubLoginKey(row.username) === key));
        return { image: known ? await avatars.get(key) : null };
      }
      case 'session': return panelState(days);
      case 'state': return state(days, payload.force === true);
      case 'login': return beginLogin();
      case 'poll': return pollLogin(days);
      case 'cancel':
        if (!payload.loginUrl || login?.url === payload.loginUrl) login = undefined;
        return { ok: true };
      case 'logout': {
        login = undefined;
        sessionProblem = '';
        const credential = token;
        const pending = credential ? { expiresAt: now().getTime() + SESSION_MAX_AGE, retryAt: Infinity } : null;
        if (pending) revocations.set(credential, pending);
        await saveToken('');
        if (pending) {
          pending.retryAt = 0;
          revokeSessions();
        }
        return { code: 'signed_out', ...panelState(days) };
      }
      case 'submit':
      case 'sync': return manualSync(payload, days);
      default: return { code: 'invalid' };
    }
  });
  function wakeForUpload() {
    if (uploadWake || !token || !Number.isFinite(nextAttempt) || lifetime.signal.aborted) return;
    const remaining = nextAttempt - now().getTime();
    if (remaining <= 0 || remaining > 1000) return;
    uploadWake = setTimeout(() => {
      uploadWake = undefined;
      void runScheduled().catch(() => {}).finally(publishSession);
    }, remaining);
    uploadWake.unref?.();
  }

  function tick() {
    void ready.then(() => { revokeSessions(); publishSession(); });
    if (readHours) void ready.then(runHourUpload).catch(() => {});
    void runHistoryInitialization().catch(() => {}).then(runScheduled).catch(() => {}).finally(() => {
      publishSession();
      wakeForUpload();
    });
  }
  const timer = setInterval(tick, 1000);
  timer.unref?.();
  tick();
  return () => {
    lifetime.abort();
    rankingAccess?.abort();
    clearInterval(timer);
    clearTimeout(uploadWake);
    registration.dispose?.();
  };
}

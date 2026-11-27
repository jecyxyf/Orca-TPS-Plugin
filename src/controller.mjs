import { createHash, randomUUID } from 'node:crypto';
import { sourceMessage, sourceNotice } from './locales.mjs';
import { harnessFamily, SESSION_HARNESSES } from './harnesses.mjs';

const STORE_KEY = 'preferences-v1';
const EMPTY_ROOTS = () => Object.fromEntries(SESSION_HARNESSES.map(k => [k, []]));
const cleanText = (v, limit = 160) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, limit);
const routineCodes = ['notice.recent-files-limit', 'notice.codex-large-session'];
const HIDDEN_ROUTINE = new Set([...routineCodes, ...routineCodes.map(c => sourceMessage(c))]);
const isRoutineWarning = v => Array.isArray(v)
  ? HIDDEN_ROUTINE.has(v[0]) || (v[0] === 'notice.large-session' && v[1] === 'codex') || (v[0] === 'notice.scan-files-limit' && v[1] === 100)
  : HIDDEN_ROUTINE.has(v);

export const formatTokensPerSecond = tps => typeof tps === 'number' && Number.isFinite(tps) && tps > 0 ? (tps >= 1 ? String(Math.round(tps)) : tps.toFixed(1)) : null;

export function formatSpeedDisplay(entry, locale) {
  const tps = entry?.tokensPerSecond;
  let formatted = formatTokensPerSecond(tps);
  if (!formatted) return '—';
  if (locale) formatted = Number(formatted).toLocaleString(locale, { minimumFractionDigits: tps < 1 ? 1 : 0 });
  return entry?.isEstimatedSpeed ? `≈${formatted}` : formatted;
}

export function formatHitRatePercent(rate, locale) {
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 1) return '—';
  const pct = Math.max(0, Math.min(100, rate * 100)), digits = pct >= 99.95 ? 0 : 1;
  return locale ? rate.toLocaleString(locale, { style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits }) : `${pct.toFixed(digits)}%`;
}

export function validateRoots(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(sourceMessage('notice.invalid-roots'));
  const roots = EMPTY_ROOTS();
  for (const key of Object.keys(value)) {
    if (!SESSION_HARNESSES.includes(key)) throw new Error(sourceMessage('notice.unknown-root-type'));
    if (!Array.isArray(value[key]) || value[key].length > 16) throw new Error(sourceMessage('notice.root-limit'));
    roots[key] = [...new Set(value[key].map(p => {
      if (typeof p !== 'string' || p.length > 4096 || /[\u0000\r\n]/.test(p)) throw new Error(sourceMessage('notice.invalid-path'));
      const trimmed = p.trim();
      if (/^[a-z]+:\/\//i.test(trimmed)) throw new Error(sourceMessage('notice.local-path-required'));
      return trimmed;
    }).filter(Boolean))];
  }
  if (Buffer.byteLength(JSON.stringify(roots), 'utf8') > 16 * 1024) throw new Error(sourceMessage('notice.root-size-limit'));
  return roots;
}

const isChannelTarget = t => Boolean(t && (t.worktreePath !== undefined || Array.isArray(t.sessions)));
const targetKey = t => !t ? null : isChannelTarget(t)
  ? JSON.stringify(['channel', t.key ?? null, t.worktreeId ?? null, t.worktreePath ?? null])
  : JSON.stringify([t.key, t.provider, t.sessionId, t.transcriptPath, t.dbPath]);
export const publicChannelId = t => `channel:${createHash('sha256').update(targetKey(t)).digest('hex').slice(0, 24)}`;
const sessionsSignature = t => isChannelTarget(t) ? JSON.stringify(t.sessions ?? []) : '';
const matchesTarget = (s, t) => Boolean(s && t && (isChannelTarget(t)
  ? s.provider === 'channel' && s.id === `channel:${t.worktreeId || t.key || 'active'}`
  : s.id === `${s.provider}:${t.sessionId}` && (s.provider === t.provider || (harnessFamily(s.provider) === 'opencode' && harnessFamily(t.provider) === 'opencode'))));

const TRANSIENT_NOTICES = ['selector.not-terminal', 'selector.tab-unidentified', 'selector.sync-pending', 'selector.unidentified',
  'selector.waiting-for-orca', 'selector.updating', 'selector.later', 'selector.waiting'];
const TRANSIENT_PATTERNS = TRANSIENT_NOTICES.map(c => sourceMessage(c));
const isTransientPage = n => Array.isArray(n) ? TRANSIENT_NOTICES.includes(n[0]) : TRANSIENT_PATTERNS.some(p => n.includes(p));

export function createTpsController(orca, {
  readActive, readSession, now = Date.now, pollMs = 5000, focusPollMs = 250, livePollMs = focusPollMs,
  backgroundPollMs = pollMs, backgroundLimit = 2, watchWorkspace = false, holdActivityMs = 120_000,
  onTargetChange = () => {}, onOpenTargets = () => {}, onSessionRead, cache, locales
} = {}) {
  const t = locales?.t ?? sourceMessage, translateNotice = locales?.notice ?? sourceNotice, instanceId = randomUUID();
  let target = null, key = null, sessionsSig = '', session = null, roots = EMPTY_ROOTS(), warnings = [];
  let updatedAt = null, loading = true, generation = 0, emptyNotice = ['notice.detecting-channel'];
  let stopped = false, started = false, contextPending = null, loadTask = null, timer = null;
  let contextDueAt = -Infinity, nextContext = false, lastReadAt = -Infinity, holdUntil = -Infinity, dataStamp = '';
  let openTargets = [], lastSnapshot, lastStatus, sequence = 0, statusQueue = Promise.resolve();
  const projectReads = new Map(), channelReadAt = new Map(), backgroundReads = new Set(), registrations = [];

  const state = () => ({
    instanceId, generation,
    activeSession: target ? (isChannelTarget(target)
      ? { id: publicChannelId(target), title: cleanText(target.title || session?.title || t('current-channel')), provider: 'channel' }
      : { id: `${target.provider}:${target.sessionId}`, title: cleanText(target.title || session?.title || t('current-conversation')), provider: target.provider }) : null,
    records: session?.records?.slice(0, 100) ?? [], loading, updatedAt,
    warnings: warnings.map(v => cleanText(translateNotice(v), 500)).filter(Boolean),
    emptyMessage: cleanText(translateNotice(emptyNotice), 300)
  });

  function publish(force = false) {
    if (stopped) return Promise.resolve();
    const snapshot = state(), signature = JSON.stringify(snapshot);
    if (!force && signature === lastSnapshot) return statusQueue;
    lastSnapshot = signature;
    const published = ++sequence;
    try { orca.panels.post('tps.changed', snapshot); } catch { orca.log(t('notice.panel-push-failed')); }
    const [latest] = snapshot.records;
    if (latest) {
      const stamp = JSON.stringify([snapshot.records.length, latest.completedAt, latest.tokensPerSecond, latest.cacheHitRate]);
      if (stamp !== dataStamp) { dataStamp = stamp; holdUntil = now() + holdActivityMs; }
    }
    const text = t('status.speed-and-cache', formatSpeedDisplay(latest, locales?.code), formatHitRatePercent(latest?.cacheHitRate, locales?.code));
    const tooltip = cleanText([
      snapshot.activeSession ? t('status.session-title', t(snapshot.activeSession.provider === 'channel' ? 'current-channel' : 'current-conversation'), snapshot.activeSession.title) : snapshot.emptyMessage,
      t('status.latest-speed-note'), t(snapshot.loading ? 'status.refreshing' : snapshot.warnings.length ? 'status.partial-data' : 'status.click-refresh')
    ].join('\n'), 256);
    const status = JSON.stringify({ text, tooltip });
    statusQueue = statusQueue.then(async () => {
      if (stopped || published !== sequence || status === lastStatus) return;
      try { await orca.host.call('statusBar.update', { id: 'speed', text, tooltip, tone: 'success', visible: true }); lastStatus = status; }
      catch { orca.log(t('notice.status-unavailable')); }
    });
    return statusQueue;
  }

  function rememberOpenTargets(context, current) {
    if (!Array.isArray(context?.openTargets)) return;
    openTargets = context.openTargets;
    const visible = current && !openTargets.some(i => targetKey(i) === targetKey(current)) ? [current, ...openTargets] : openTargets;
    onOpenTargets(visible);
    const keys = new Set(visible.map(targetKey));
    for (const v of channelReadAt.keys()) if (!keys.has(v)) channelReadAt.delete(v);
  }

  async function syncActive() {
    if (contextPending) return contextPending;
    const task = (async () => {
      let context;
      try { context = await readActive(); } catch { context = { target: null, notice: ['notice.read-current-failed'] }; }
      if (stopped) return;
      const next = context?.target ?? null, nextKey = targetKey(next), nextSig = sessionsSignature(next);
      const notice = context?.notice ?? (context?.message || [next ? (isChannelTarget(next) ? 'notice.empty-channel-requests' : 'notice.empty-conversation-requests') : 'notice.empty-page-conversation']);
      if (!next && session?.records?.length && now() < holdUntil && isTransientPage(notice)) {
        rememberOpenTargets(context, target);
        const retained = ['notice.keep-recent-stats', notice];
        if (JSON.stringify(retained) !== JSON.stringify(emptyNotice)) { emptyNotice = retained; void publish(); }
        return;
      }
      const changed = nextKey !== key, messageChanged = JSON.stringify(notice) !== JSON.stringify(emptyNotice);
      let loadingCleared = false;
      if (changed) {
        const saved = cache && isChannelTarget(next) ? await cache.get(publicChannelId(next)) : null;
        if (stopped) return;
        generation++; key = nextKey; sessionsSig = nextSig;
        session = saved ? { provider: 'channel', records: saved.records } : null;
        warnings = []; updatedAt = saved?.updatedAt ?? null; lastReadAt = holdUntil = -Infinity; dataStamp = '';
        loading = Boolean(next && !saved);
      } else {
        if (!next && loading) { loading = false; loadingCleared = true; }
        if (next && nextSig !== sessionsSig) { sessionsSig = nextSig; lastReadAt = -Infinity; }
      }
      target = next; emptyNotice = notice;
      rememberOpenTargets(context, next);
      if (changed) onTargetChange(target);
      if (changed || messageChanged || loadingCleared) void publish();
    })();
    contextPending = task;
    try { await task; } finally { if (contextPending === task) contextPending = null; }
  }

  async function loadSession(reqTarget, options) {
    const result = await readSession(reqTarget, options);
    if (!stopped && onSessionRead && matchesTarget(result?.session, reqTarget)) {
      try { onSessionRead(reqTarget, result); } catch (e) { orca.log(t('notice.usage-read-failed', e?.code ?? e?.message ?? 'unknown')); }
    }
    return result;
  }

  function readProject(reqTarget, force) {
    const options = { roots: structuredClone(roots), ...(force ? { fresh: true } : {}) };
    if (!cache || !isChannelTarget(reqTarget)) return loadSession(reqTarget, options);
    const channel = targetKey(reqTarget);
    if (projectReads.has(channel)) return projectReads.get(channel);
    channelReadAt.set(channel, now());
    const id = publicChannelId(reqTarget);
    const pending = (async () => {
      await cache.get(id);
      if (stopped) return { session: null, warnings: [] };
      const result = await loadSession(reqTarget, options);
      if (stopped || !matchesTarget(result.session, reqTarget)) return result;
      const saved = cache.set(id, result.session.records, { display: channel === key && !result.warnings?.length });
      return { ...result, cachedAt: saved.updatedAt, session: { ...result.session, records: saved.records } };
    })().finally(() => projectReads.delete(channel));
    projectReads.set(channel, pending);
    return pending;
  }

  function refreshOpenChannels() {
    if (!cache || stopped || backgroundReads.size >= backgroundLimit || !openTargets.length) return;
    let candidate = null, oldest = Infinity;
    const threshold = now() - backgroundPollMs;
    for (const open of openTargets) {
      const ch = targetKey(open), last = channelReadAt.get(ch) ?? -Infinity;
      if (ch !== key && !projectReads.has(ch) && last <= threshold && last < oldest) { candidate = open; oldest = last; }
    }
    if (!candidate) return;
    const pending = readProject(candidate, false).catch(() => {}).finally(() => backgroundReads.delete(pending));
    backgroundReads.add(pending);
  }

  async function loadCurrent(force) {
    if (stopped || !target) return state();
    if (loadTask?.generation === generation) return loadTask.promise;
    if (!force && now() - lastReadAt < pollMs) return state();
    const reqGen = generation, reqTarget = structuredClone(target);
    lastReadAt = now();
    loading = !session || (force && !cache);
    const task = { generation: reqGen, promise: null };
    task.promise = (async () => {
      void publish();
      if (stopped || reqGen !== generation) return state();
      try {
        const result = await readProject(reqTarget, force);
        if (stopped || reqGen !== generation) return state();
        const loaded = matchesTarget(result.session, reqTarget) ? result.session : null;
        if (loaded) {
          session = loaded;
          warnings = (result.warnings ?? []).filter(v => !isRoutineWarning(v)).slice(0, 20);
          updatedAt = result.cachedAt ?? now();
        } else {
          warnings = result.warnings?.[0] ? [result.warnings[0]] : warnings;
          if (!cache && !reqTarget.executionHostId) updatedAt = now();
        }
      } catch {
        if (stopped || reqGen !== generation) return state();
        warnings = [['notice.keep-last-request-data']];
        if (!cache && !reqTarget.executionHostId) updatedAt = now();
      }
      loading = false;
      void publish();
      return state();
    })().finally(() => { if (loadTask === task) loadTask = null; });
    return (loadTask = task).promise;
  }

  const checkLive = force => { const r = loadCurrent(force); refreshOpenChannels(); return r; };
  const checkActive = async ({ force = false } = {}) => stopped ? state() : (await syncActive(), checkLive(force));
  const refresh = () => checkActive({ force: true });
  async function poll() {
    if (stopped || contextPending) return;
    if (now() >= contextDueAt || nextContext) { nextContext = false; contextDueAt = now() + focusPollMs; await checkActive(); }
    else await checkLive(false);
  }

  async function start({ background = false } = {}) {
    if (started) return;
    started = true;
    try { const saved = await orca.storage.get(STORE_KEY); if (saved?.roots) roots = validateRoots(saved.roots); }
    catch { orca.log(t('notice.path-settings-unavailable')); }
    if (stopped) return;
    registrations.push(orca.panels.handle('tps.state', state), orca.panels.handle('tps.refresh', refresh), orca.commands.register('tps.refresh', refresh));
    const firstRefresh = refresh();
    if (watchWorkspace && orca.events?.on) {
      registrations.push(orca.events.on('workspace.changed', () => { nextContext = true; void poll().catch(() => orca.log(t('notice.background-refresh-failed'))); }));
    }
    if (livePollMs > 0) {
      contextDueAt = now() + focusPollMs;
      timer = setInterval(() => { void poll().catch(() => orca.log(t('notice.background-refresh-failed'))); }, livePollMs);
      timer.unref?.();
    }
    if (!background) await firstRefresh;
    else void firstRefresh.catch(() => orca.log(t('notice.first-refresh-failed')));
  }

  function stop() { stopped = true; clearInterval(timer); for (const entry of registrations) entry.dispose(); }
  return { start, stop, refresh, checkActive, state, refreshLocale: () => publish(true) };
}

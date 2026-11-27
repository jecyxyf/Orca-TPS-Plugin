import { sourceMessage, sourceNotice } from './locales.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { harnessFamily } from './harnesses.mjs';
const cleanText = (value, limit = 160) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, limit);
const routineWarningCodes = ['notice.recent-files-limit', 'notice.codex-large-session'];
const HIDDEN_ROUTINE_WARNINGS = new Set([...routineWarningCodes, ...routineWarningCodes.map(code => sourceMessage(code))]);
function isRoutineWarning(value) {
  if (!Array.isArray(value)) return HIDDEN_ROUTINE_WARNINGS.has(value);
  const [code, arg] = value;
  return HIDDEN_ROUTINE_WARNINGS.has(code) ||
    (code === 'notice.large-session' && arg === 'codex') ||
    (code === 'notice.scan-files-limit' && arg === 100);
}

export function formatTokensPerSecond(tps) {
  if (typeof tps !== 'number' || !Number.isFinite(tps) || tps <= 0) return null;
  return tps >= 1 ? String(Math.round(tps)) : tps.toFixed(1);
}

export function formatSpeedDisplay(entry, locale) {
  const tps = entry?.tokensPerSecond;
  let formatted = formatTokensPerSecond(tps);
  if (!formatted) return '—';
  if (locale) formatted = Number(formatted).toLocaleString(locale, { minimumFractionDigits: tps < 1 ? 1 : 0 });
  return entry?.isEstimatedSpeed ? `≈${formatted}` : formatted;
}

export function formatHitRatePercent(rate, locale) {
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 1) return '—';
  const percent = Math.max(0, Math.min(100, rate * 100));
  if (locale) {
    const digits = percent >= 99.95 ? 0 : 1;
    return rate.toLocaleString(locale, { style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits });
  }
  return `${percent.toFixed(percent >= 99.95 ? 0 : 1)}%`;
}

const isChannelTarget = target => Boolean(target && (target.worktreePath !== undefined || Array.isArray(target.sessions)));
const targetKey = target => {
  if (!target) return null;
  if (isChannelTarget(target)) return JSON.stringify(['channel', target.key ?? null, target.worktreeId ?? null, target.worktreePath ?? null]);
  return JSON.stringify([target.key, target.provider, target.sessionId, target.transcriptPath, target.dbPath]);
};
// Channel keys contain profile and worktree paths; expose only an opaque identity to the panel.
export const publicChannelId = target => `channel:${createHash('sha256').update(targetKey(target)).digest('hex').slice(0, 24)}`;
const sessionsSignature = target => isChannelTarget(target) ? JSON.stringify(target.sessions ?? []) : '';
const matchesTarget = (session, target) => {
  if (!session || !target) return false;
  if (isChannelTarget(target)) {
    return session.provider === 'channel' && session.id === `channel:${target.worktreeId || target.key || 'active'}`;
  }
  return session.id === `${session.provider}:${target.sessionId}` &&
    (session.provider === target.provider ||
      (harnessFamily(session.provider) === 'opencode' && harnessFamily(target.provider) === 'opencode'));
};
// Transient unidentified-page reports while an agent runs (tab busy-state, capture lag).
const TRANSIENT_PAGE_NOTICES = [
  'selector.not-terminal', 'selector.tab-unidentified', 'selector.sync-pending', 'selector.unidentified',
  'selector.waiting-for-orca', 'selector.updating', 'selector.later', 'selector.waiting'
];
const TRANSIENT_PAGE_PATTERNS = TRANSIENT_PAGE_NOTICES.map(code => sourceMessage(code));

function isTransientPage(notice) {
  return Array.isArray(notice) ? TRANSIENT_PAGE_NOTICES.includes(notice[0])
    : TRANSIENT_PAGE_PATTERNS.some(pattern => notice.includes(pattern));
}

export function createTpsController(orca, {
  readActive, readSession, now = Date.now, pollMs = 5000, focusPollMs = 250,
  livePollMs = focusPollMs, backgroundPollMs = pollMs, backgroundLimit = 2, watchWorkspace = false,
  holdActivityMs = 120_000, onOpenTargets = () => {}, cache, locales
} = {}) {
  const t = locales?.t ?? sourceMessage;
  const translateNotice = locales?.notice ?? sourceNotice;
  const instanceId = randomUUID();
  let target = null, key = null, sessionsSig = '', session = null;
  let warnings = [];
  let updatedAt = null, loading = true, generation = 0;
  let emptyNotice = ['notice.detecting-channel'];
  let stopped = false, started = false;
  let contextPending = null, loadTask = null, timer = null;
  let contextDueAt = -Infinity, nextContext = false;
  let lastReadAt = -Infinity;
  let holdUntil = -Infinity, dataStamp = '';
  let openTargets = [];
  const projectReads = new Map(), channelReadAt = new Map(), backgroundReads = new Set();
  const registrations = [];

  function state() {
    return {
      instanceId, generation,
      activeSession: target ? (isChannelTarget(target) ? {
        id: publicChannelId(target),
        title: cleanText(target.title || session?.title || t('current-channel')),
        provider: 'channel'
      } : {
        id: `${target.provider}:${target.sessionId}`,
        title: cleanText(target.title || session?.title || t('current-conversation')),
        provider: target.provider
      }) : null,
      records: session?.records?.slice(0, 100) ?? [],
      loading, updatedAt,
      warnings: warnings.map(value => cleanText(translateNotice(value), 500)).filter(Boolean),
      emptyMessage: cleanText(translateNotice(emptyNotice), 300)
    };
  }

  function noteFreshRecords(records) {
    if (!records.length) return;
    const [latest] = records;
    const stamp = JSON.stringify([records.length, latest.completedAt, latest.tokensPerSecond, latest.cacheHitRate]);
    if (stamp === dataStamp) return;
    dataStamp = stamp;
    holdUntil = now() + holdActivityMs;
  }

  const publish = createControllerPublisher(orca, {
    state, t, locale: () => locales?.code, isStopped: () => stopped, noteFreshRecords
  });

  function rememberOpenTargets(context, current) {
    if (!Array.isArray(context?.openTargets)) return;
    openTargets = context.openTargets;
    const visible = current && !openTargets.some(item => targetKey(item) === targetKey(current))
      ? [current, ...openTargets] : openTargets;
    onOpenTargets(visible);
    const keys = new Set(visible.map(targetKey));
    for (const value of channelReadAt.keys()) if (!keys.has(value)) channelReadAt.delete(value);
  }

  async function syncActive() {
    if (contextPending) return contextPending;
    const task = (async () => {
      let context;
      try { context = await readActive(); }
      catch { context = { target: null, notice: ['notice.read-current-failed'] }; }
      if (stopped) return;
      const next = context?.target ?? null, nextKey = targetKey(next), nextSessionsSig = sessionsSignature(next);
      const notice = context?.notice ?? (context?.message || [next
        ? (isChannelTarget(next) ? 'notice.empty-channel-requests' : 'notice.empty-conversation-requests')
        : 'notice.empty-page-conversation']);
      const withinHold = Boolean(session?.records?.length) && now() < holdUntil;
      // Keep refreshing the previous conversation while the host catches up.
      if (!next && withinHold && isTransientPage(notice)) {
        rememberOpenTargets(context, target);
        const retained = ['notice.keep-recent-stats', notice];
        if (JSON.stringify(retained) !== JSON.stringify(emptyNotice)) {
          emptyNotice = retained;
          void publish();
        }
        return;
      }
      const changed = nextKey !== key;
      const messageChanged = JSON.stringify(notice) !== JSON.stringify(emptyNotice);
      let loadingCleared = false;
      if (changed) {
        const saved = cache && isChannelTarget(next) ? await cache.get(publicChannelId(next)) : null;
        if (stopped) return;
        generation += 1;
        key = nextKey;
        sessionsSig = nextSessionsSig;
        session = saved ? { provider: 'channel', records: saved.records } : null;
        warnings = [];
        updatedAt = saved?.updatedAt ?? null;
        lastReadAt = -Infinity;
        holdUntil = -Infinity;
        dataStamp = '';
        loading = Boolean(next && !saved);
      } else {
        if (!next && loading) {
          loading = false;
          loadingCleared = true;
        }
        if (next && nextSessionsSig !== sessionsSig) {
          sessionsSig = nextSessionsSig;
          lastReadAt = -Infinity;
        }
      }
      target = next;
      emptyNotice = notice;
      rememberOpenTargets(context, next);
      if (changed || messageChanged || loadingCleared) void publish();
    })();
    contextPending = task;
    try { await task; }
    finally { if (contextPending === task) contextPending = null; }
  }

  function readProject(requestedTarget) {
    if (!cache || !isChannelTarget(requestedTarget)) return readSession(requestedTarget);
    const channel = targetKey(requestedTarget);
    if (projectReads.has(channel)) return projectReads.get(channel);
    channelReadAt.set(channel, now());
    const id = publicChannelId(requestedTarget);
    const pending = (async () => {
      await cache.get(id);
      if (stopped) return { session: null, warnings: [] };
      const result = await readSession(requestedTarget);
      if (stopped || !matchesTarget(result.session, requestedTarget)) return result;
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
      const channel = targetKey(open), last = channelReadAt.get(channel) ?? -Infinity;
      if (channel !== key && !projectReads.has(channel) && last <= threshold && last < oldest) {
        candidate = open;
        oldest = last;
      }
    }
    if (!candidate) return;
    const pending = readProject(candidate)
      .catch(() => {})
      .finally(() => backgroundReads.delete(pending));
    backgroundReads.add(pending);
  }

  async function loadCurrent(force) {
    if (stopped || !target) return state();
    if (loadTask?.generation === generation) return loadTask.promise;
    if (!force && now() - lastReadAt < pollMs) return state();
    const requestedGeneration = generation, requestedTarget = structuredClone(target);
    lastReadAt = now();
    loading = !session || (force && !cache);
    const task = { generation: requestedGeneration, promise: null };
    task.promise = (async () => {
      void publish();
      if (stopped || requestedGeneration !== generation) return state();
      try {
        const result = await readProject(requestedTarget);
        if (stopped || requestedGeneration !== generation) return state();
        const loaded = matchesTarget(result.session, requestedTarget) ? result.session : null;
        if (loaded) {
          session = loaded;
          warnings = (result.warnings ?? []).filter(value => !isRoutineWarning(value)).slice(0, 20);
          updatedAt = result.cachedAt ?? now();
        } else {
          // Miss (file truncated, parse hiccup, capture lag): keep the previous records
          // instead of wiping the panel; surface the reason as a warning.
          const missWarning = result.warnings?.[0];
          warnings = missWarning ? [missWarning] : warnings;
          if (!cache && !requestedTarget.executionHostId) updatedAt = now();
        }
      } catch {
        if (stopped || requestedGeneration !== generation) return state();
        // Read failure: retain the last good records so a transient I/O error
        // does not blank the panel; only the warning changes.
        warnings = [['notice.keep-last-request-data']];
        if (!cache && !requestedTarget.executionHostId) updatedAt = now();
      }
      loading = false;
      void publish();
      return state();
    })().finally(() => { if (loadTask === task) loadTask = null; });
    loadTask = task;
    return task.promise;
  }

  async function checkActive({ force = false } = {}) {
    if (stopped) return state();
    await syncActive();
    return checkLive(force);
  }

  function checkLive(force) {
    const result = loadCurrent(force);
    refreshOpenChannels();
    return result;
  }
  const refresh = () => checkActive({ force: true });

  async function poll() {
    if (stopped || contextPending) return;
    if (now() >= contextDueAt || nextContext) {
      nextContext = false;
      contextDueAt = now() + focusPollMs;
      await checkActive();
    } else await checkLive(false);
  }

  async function start({ background = false } = {}) {
    if (started) return;
    started = true;
    registrations.push(
      orca.panels.handle('tps.state', state),
      orca.panels.handle('tps.refresh', refresh),
      orca.commands.register('tps.refresh', refresh)
    );
    const firstRefresh = refresh();
    if (watchWorkspace && orca.events?.on) {
      registrations.push(orca.events.on('workspace.changed', () => {
        nextContext = true;
        void poll().catch(() => orca.log(t('notice.background-refresh-failed')));
      }));
    }
    if (livePollMs > 0) {
      contextDueAt = now() + focusPollMs;
      timer = setInterval(() => { void poll().catch(() => orca.log(t('notice.background-refresh-failed'))); }, livePollMs);
      timer.unref?.();
    }
    if (!background) await firstRefresh;
    else void firstRefresh.catch(() => orca.log(t('notice.first-refresh-failed')));
  }

  function stop() {
    stopped = true;
    clearInterval(timer);
    for (const entry of registrations) entry.dispose();
  }
  return { start, stop, refresh, checkActive, state, refreshLocale: () => publish(true) };
}

function createControllerPublisher(orca, { state, t, locale, isStopped, noteFreshRecords }) {
  let lastSnapshot, lastStatus, sequence = 0, statusQueue = Promise.resolve();
  return function publish(force = false) {
    if (isStopped()) return Promise.resolve();
    const snapshot = state(), signature = JSON.stringify(snapshot);
    if (!force && signature === lastSnapshot) return statusQueue;
    lastSnapshot = signature;
    const published = ++sequence;
    try { orca.panels.post('tps.changed', snapshot); }
    catch { orca.log(t('notice.panel-push-failed')); }
    noteFreshRecords(snapshot.records);

    const [latest] = snapshot.records;
    const speed = formatSpeedDisplay(latest, locale()), cache = formatHitRatePercent(latest?.cacheHitRate, locale());
    const text = t('status.speed-and-cache', speed, cache);
    const tooltip = cleanText([
      snapshot.activeSession
        ? t('status.session-title', t(snapshot.activeSession.provider === 'channel' ? 'current-channel' : 'current-conversation'), snapshot.activeSession.title)
        : snapshot.emptyMessage,
      t('status.latest-speed-note'),
      t(snapshot.loading ? 'status.refreshing' : snapshot.warnings.length ? 'status.partial-data' : 'status.click-refresh')
    ].join('\n'), 256);
    const status = JSON.stringify({ text, tooltip });
    // Serialize writes so an older asynchronous update cannot win after a switch.
    statusQueue = statusQueue.then(async () => {
      if (isStopped() || published !== sequence || status === lastStatus) return;
      try {
        await orca.host.call('statusBar.update', { id: 'speed', text, tooltip, tone: 'success', visible: true });
        lastStatus = status;
      } catch { orca.log(t('notice.status-unavailable')); }
    });
    return statusQueue;
  };
}

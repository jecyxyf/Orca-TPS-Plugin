import { sourceMessage } from './locales.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { formatHitRatePercent, formatSpeedDisplay } from './parsers.mjs';

const PROVIDERS = ['codex', 'claude', 'opencode', 'pi', 'antigravity', 'hermes'];
const STORE_KEY = 'preferences-v1';
const EMPTY_ROOTS = () => Object.fromEntries(PROVIDERS.map(key => [key, []]));
const cleanText = (value, limit = 160) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, limit);
const HIDDEN_ROUTINE_WARNINGS = new Set([
  sourceMessage('notice.recent-files-limit'),
  sourceMessage('notice.codex-large-session')
]);

export function validateRoots(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(sourceMessage('notice.invalid-roots'));
  const roots = EMPTY_ROOTS();
  for (const key of Object.keys(value)) {
    if (!PROVIDERS.includes(key)) throw new Error(sourceMessage('notice.unknown-root-type'));
    if (!Array.isArray(value[key]) || value[key].length > 16) throw new Error(sourceMessage('notice.root-limit'));
    roots[key] = [...new Set(value[key].map(path => {
      if (typeof path !== 'string' || path.length > 4096 || /[\u0000\r\n]/.test(path)) throw new Error(sourceMessage('notice.invalid-path'));
      const trimmed = path.trim();
      if (/^[a-z]+:\/\//i.test(trimmed)) throw new Error(sourceMessage('notice.local-path-required'));
      return trimmed;
    }).filter(Boolean))];
  }
  if (Buffer.byteLength(JSON.stringify(roots), 'utf8') > 16 * 1024) throw new Error(sourceMessage('notice.root-size-limit'));
  return roots;
}

const isChannelTarget = target => Boolean(target && (target.worktreePath !== undefined || Array.isArray(target.sessions)));
const targetKey = target => {
  if (!target) return null;
  if (isChannelTarget(target)) return JSON.stringify(['channel', target.key ?? null, target.worktreeId ?? null, target.worktreePath ?? null]);
  return JSON.stringify([target.key, target.provider, target.sessionId, target.transcriptPath, target.dbPath]);
};
// Channel keys contain profile and worktree paths; expose only an opaque identity to the panel.
const publicChannelId = target => `channel:${createHash('sha256').update(targetKey(target)).digest('hex').slice(0, 24)}`;
const sessionsSignature = target => isChannelTarget(target) ? JSON.stringify(target.sessions ?? []) : '';
const matchesTarget = (session, target) => {
  if (!session || !target) return false;
  if (isChannelTarget(target)) {
    return session.provider === 'channel' && session.id === `channel:${target.worktreeId || target.key || 'active'}`;
  }
  return session.id === `${session.provider}:${target.sessionId}` &&
    (session.provider === target.provider ||
      (['opencode', 'opencode2'].includes(session.provider) && ['opencode', 'opencode2'].includes(target.provider)));
};
// Transient unidentified-page reports while an agent runs (tab busy-state, capture lag).
const TRANSIENT_PAGE_PATTERNS = [
  sourceMessage('selector.not-terminal'), sourceMessage('selector.tab-unidentified'), sourceMessage('selector.sync-pending'), sourceMessage('selector.unidentified'),
  sourceMessage('selector.waiting-for-orca'), sourceMessage('selector.updating'), sourceMessage('selector.later'), sourceMessage('selector.waiting')
];

export function createTpsController(orca, {
  readActive, readSession, now = Date.now, pollMs = 5000, focusPollMs = 250,
  livePollMs = focusPollMs, backgroundPollMs = pollMs, backgroundLimit = 2, watchWorkspace = false,
  holdActivityMs = 120_000, onTargetChange = () => {}, onOpenTargets = () => {}, onRecords = () => {}, cache, locales
} = {}) {
  const t = locales?.t ?? sourceMessage;
  const instanceId = randomUUID();
  let target = null, key = null, sessionsSig = '', session = null;
  let roots = EMPTY_ROOTS(), warnings = [];
  let updatedAt = null, loading = true, generation = 0;
  let emptyMessage = sourceMessage('notice.detecting-channel');
  let stopped = false, started = false;
  let contextPending = null, loadTask = null, timer = null;
  let contextDueAt = -Infinity, nextContext = false;
  let lastReadAt = -Infinity, lastStatus = '', lastSnapshot = '', publishSequence = 0;
  let holdUntil = -Infinity, dataStamp = '';
  let statusQueue = Promise.resolve(), openTargets = [];
  const projectReads = new Map(), channelReadAt = new Map(), backgroundReads = new Set();
  const registrations = [];

  function state() {
    return {
      instanceId, generation,
      activeSession: target ? (isChannelTarget(target) ? {
        id: publicChannelId(target),
        title: cleanText(target.title || session?.title || sourceMessage('current-channel')),
        provider: 'channel'
      } : {
        id: `${target.provider}:${target.sessionId}`,
        title: cleanText(target.title || session?.title || sourceMessage('current-conversation')),
        provider: target.provider
      }) : null,
      records: session?.records?.slice(0, 100) ?? [],
      loading, updatedAt, warnings: [...warnings], emptyMessage
    };
  }

  function panelState(snapshot = state()) {
    if (!locales) return snapshot;
    const activeSession = snapshot.activeSession;
    return {
      ...snapshot,
      activeSession: activeSession && { ...activeSession, title: locales.notice(activeSession.title) },
      warnings: snapshot.warnings.map(text => locales.notice(text)),
      emptyMessage: locales.notice(snapshot.emptyMessage)
    };
  }

  function recordsStamp(records) {
    const latest = records[0];
    return JSON.stringify([
      records.length,
      latest?.completedAt ?? null,
      latest?.tokensPerSecond ?? null,
      latest?.cacheHitRate ?? null
    ]);
  }

  function publish(force = false) {
    if (stopped) return Promise.resolve();
    const snapshot = panelState(), signature = JSON.stringify(snapshot);
    if (!force && signature === lastSnapshot) return statusQueue;
    lastSnapshot = signature;
    const sequence = ++publishSequence;
    try { orca.panels.post('tps.changed', snapshot); }
    catch { orca.log(t('notice.panel-push-failed')); }
    // Fresh data extends the retention window; stale-only snapshots do not.
    const stamp = recordsStamp(snapshot.records);
    if (snapshot.records.length && stamp !== dataStamp) {
      dataStamp = stamp;
      holdUntil = now() + holdActivityMs;
    }
    const latest = snapshot.records[0];
    const speedText = formatSpeedDisplay(latest, locales?.code);
    const cacheText = formatHitRatePercent(latest?.cacheHitRate, locales?.code);
    const text = t('status.speed-and-cache', speedText, cacheText);
    const tooltip = cleanText([
      snapshot.activeSession
        ? t('status.session-title', t(snapshot.activeSession.provider === 'channel' ? 'current-channel' : 'current-conversation'), snapshot.activeSession.title)
        : snapshot.emptyMessage,
      t('status.latest-speed-note'),
      t(snapshot.loading ? 'status.refreshing' : snapshot.warnings.length ? 'status.partial-data' : 'status.click-refresh')
    ].join('\n'), 256);
    const status = JSON.stringify({ text, tooltip });
    // Serialize host writes so an older asynchronous update cannot win after a switch.
    statusQueue = statusQueue.then(async () => {
      if (stopped || sequence !== publishSequence || status === lastStatus) return;
      try {
        await orca.host.call('statusBar.update', { id: 'speed', text, tooltip, tone: 'success', visible: true });
        lastStatus = status;
      } catch { orca.log(t('notice.status-unavailable')); }
    });
    return statusQueue;
  }

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
      catch { context = { target: null, message: sourceMessage('notice.read-current-failed') }; }
      if (stopped) return;
      const next = context?.target ?? null, nextKey = targetKey(next), nextSessionsSig = sessionsSignature(next);
      const rawMessage = context?.message || (next
        ? (isChannelTarget(next) ? sourceMessage('notice.empty-channel-requests') : sourceMessage('notice.empty-conversation-requests'))
        : sourceMessage('notice.empty-page-conversation'));
      const withinHold = Boolean(session?.records?.length) && now() < holdUntil;
      // While retention holds, an unidentified-page report during an agent run is
      // transient: change nothing (target/key/session stay on the last conversation,
      // which keeps refreshing); only soften the status message.
      if (!next && withinHold && TRANSIENT_PAGE_PATTERNS.some(pattern => rawMessage.includes(pattern))) {
        rememberOpenTargets(context, target);
        const message = cleanText(sourceMessage('notice.keep-recent-stats', rawMessage), 300);
        if (message !== emptyMessage) {
          emptyMessage = message;
          void publish();
        }
        return;
      }
      const message = cleanText(rawMessage, 300);
      const changed = nextKey !== key;
      const messageChanged = message !== emptyMessage;
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
      emptyMessage = message;
      rememberOpenTargets(context, next);
      if (changed) onTargetChange(target);
      if (changed || messageChanged || loadingCleared) void publish();
    })();
    contextPending = task;
    try { await task; }
    finally { if (contextPending === task) contextPending = null; }
  }

  function readProject(requestedTarget, force) {
    const options = { roots: structuredClone(roots), ...(force ? { fresh: true } : {}) };
    if (!cache || !isChannelTarget(requestedTarget)) return readSession(requestedTarget, options);
    const channel = targetKey(requestedTarget);
    if (projectReads.has(channel)) return projectReads.get(channel);
    channelReadAt.set(channel, now());
    const id = publicChannelId(requestedTarget);
    const pending = (async () => {
      await cache.get(id);
      if (stopped) return { session: null, warnings: [] };
      const result = await readSession(requestedTarget, options);
      if (stopped || !matchesTarget(result.session, requestedTarget)) return result;
      onRecords(result.session.records);
      const saved = cache.set(id, result.session.records);
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
    const pending = readProject(candidate, false)
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
        const result = await readProject(requestedTarget, force);
        if (stopped || requestedGeneration !== generation) return state();
        const loaded = matchesTarget(result.session, requestedTarget) ? result.session : null;
        if (loaded) {
          if (!cache || !isChannelTarget(requestedTarget)) onRecords(loaded.records);
          session = loaded;
          warnings = (result.warnings ?? []).map(text => cleanText(text, 500))
            .filter(text => !HIDDEN_ROUTINE_WARNINGS.has(text)).slice(0, 20);
          updatedAt = result.cachedAt ?? now();
        } else {
          // Miss (file truncated, parse hiccup, capture lag): keep the previous records
          // instead of wiping the panel; surface the reason as a warning.
          const missWarning = cleanText((result.warnings ?? [])[0], 500);
          warnings = missWarning ? [missWarning] : warnings;
          if (!cache && !requestedTarget.executionHostId) updatedAt = now();
        }
      } catch {
        if (stopped || requestedGeneration !== generation) return state();
        // Read failure: retain the last good records so a transient I/O error
        // does not blank the panel; only the warning changes.
        warnings = [sourceMessage('notice.keep-last-request-data')];
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
    try {
      const saved = await orca.storage.get(STORE_KEY);
      if (saved?.roots) roots = validateRoots(saved.roots);
    } catch { orca.log(t('notice.path-settings-unavailable')); }
    if (stopped) return;
    registrations.push(
      orca.panels.handle('tps.state', () => panelState()),
      orca.panels.handle('tps.refresh', async () => panelState(await refresh())),
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

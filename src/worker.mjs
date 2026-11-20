import { createLocalePreferences } from './locales.mjs';
import { createComputation } from './computation.mjs';
import { createTpsController } from './controller.mjs';
import { createRemoteChannelReader, createRemoteUsageReader } from './remote-channel.mjs';
import { createChannelCache } from './channel-cache.mjs';
import { BACKFILL_BYTES, BACKFILL_UNITS, createUsageIndex, MAX_WINDOW_DAYS } from './usage-summary.mjs';
import { startLeaderboard } from './leaderboard.mjs';

const BACKFILL_DELAY_MS = 250, DISCOVERY_MS = 15_000, IDLE_DELAY_MS = 60_000, FIRST_DELAY_MS = 3_000;
const PANEL_VIEW_KEY = 'panel-view';
const PANEL_VIEWS = new Set(['current-data', 'usage', 'leaderboard']);
const LIVE_WINDOW_MS = 30_000;
const SEEN_TTL_MS = 120_000;

export function createPulseTracker({ now = Date.now } = {}) {
  const listeners = new Set();
  const seen = new Map();
  let baselineDay = '', baselineTokens = 0, controllerReported = 0;
  let lastTps = 0, lastTpsAt = -Infinity;

  function emit(sample) {
    for (const listener of listeners) listener(sample);
  }

  function pruneSeen(time) {
    if (seen.size <= 300) return;
    const cutoff = time - SEEN_TTL_MS;
    for (const [key, at] of seen) {
      if (at < cutoff || seen.size > 300) seen.delete(key);
    }
  }

  function recordTokens(record) {
    let total = 0;
    for (const value of [record?.freshInputTokens, record?.outputTokens, record?.cacheReadTokens, record?.cacheCreationTokens]) {
      if (Number.isFinite(value) && value > 0) total += value;
    }
    return Math.trunc(total);
  }

  function handleRecords(records) {
    if (!Array.isArray(records) || !records.length) return;
    const time = now();
    const cutoff = time - LIVE_WINDOW_MS;
    let burstTokens = 0, tps = 0;
    for (const record of records.slice(0, 10)) {
      if (!record || !Number.isFinite(record.completedAt)) continue;
      if (!tps && Number.isFinite(record.tokensPerSecond) && record.tokensPerSecond > 0 && time - record.completedAt <= 600_000) {
        lastTps = record.tokensPerSecond;
        lastTpsAt = record.completedAt;
      }
      if (record.completedAt < cutoff || record.completedAt > time + 5000) continue;
      const key = `${record.provider ?? ''}:${record.completedAt}:${record.outputTokens ?? 0}:${record.freshInputTokens ?? 0}`;
      if (seen.has(key)) continue;
      seen.set(key, record.completedAt);
      burstTokens += recordTokens(record);
      if (!tps && Number.isFinite(record.tokensPerSecond) && record.tokensPerSecond > 0) {
        tps = record.tokensPerSecond;
      }
    }
    pruneSeen(time);
    if (tps > 0) {
      lastTps = tps;
      lastTpsAt = time;
    }
    if (burstTokens > 0 || tps > 0) {
      controllerReported += burstTokens;
      emit({ tps, burstTokens });
    }
  }

  function handleUsage(usage) {
    if (!usage?.ready || typeof usage.day !== 'string' || !Number.isFinite(usage.tokens)) return;
    if (baselineDay !== usage.day) {
      baselineDay = usage.day;
      baselineTokens = usage.tokens;
      controllerReported = 0;
      return;
    }
    if (usage.tokens <= baselineTokens) return;
    const totalDelta = Math.trunc(usage.tokens - baselineTokens);
    baselineTokens = usage.tokens;
    const extra = Math.max(0, totalDelta - controllerReported);
    controllerReported = Math.max(0, controllerReported - totalDelta);
    if (extra > 0) {
      const time = now();
      emit({ tps: time - lastTpsAt <= 15_000 ? lastTps : 0, burstTokens: extra });
    }
  }

  function snapshot(fallbackTps = 0) {
    const time = now();
    const recentTps = time - lastTpsAt <= 600_000 ? lastTps : 0;
    const tps = recentTps > 0 ? recentTps : (Number.isFinite(fallbackTps) && fallbackTps > 0 ? fallbackTps : 0);
    return { tps: Math.round(tps * 10) / 10, burstTokens: 0 };
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { handleRecords, handleUsage, snapshot, subscribe };
}

let controller, remote, computation, cache, usage, remoteUsage, usageAbort, timer, handler, stopLeaderboard, stopPanelView, pulseTracker, running = false;
let locales, localeRegistration;

export default async function activate(orca) {
  await deactivate();
  running = true;
  const language = locales = await createLocalePreferences(orca.storage);
  localeRegistration = orca.panels.handle('tps.locale', payload => payload?.code === undefined
    ? language.response(true)
    : language.select(payload.code, () => { void controller?.refreshLocale(); }));
  stopPanelView = registerPanelView(orca, language.t);
  const compute = computation = createComputation();
  const remoteOptions = {
    t: language.t,
    lookupSsh: ids => compute.call('sshTargets', ids),
    decode: body => compute.call('remoteReply', body)
  };
  const remoteReader = remote = createRemoteChannelReader(orca, remoteOptions);
  const channelCache = cache = createChannelCache(orca.storage);
  const tracker = pulseTracker = createPulseTracker();
  controller = createTpsController(orca, {
    cache: channelCache, locales: language,
    pollMs: 250, livePollMs: 250, focusPollMs: 1000,
    backgroundPollMs: 5000, backgroundLimit: 1, watchWorkspace: true,
    readActive: () => compute.call('active', { includeRemote: true, includeOpen: true }),
    readSession: (target, options) => target.executionHostId
      ? remoteReader.read(target, options)
      : compute.call('live', target, options),
    onOpenTargets: remoteReader.setTargets,
    onRecords: tracker.handleRecords
  });
  await controller.start({ background: true });
  const history = remoteUsage = createRemoteUsageReader(orca, remoteOptions);
  usageAbort = new AbortController();
  let discovery, discoveryKey, discoveryAt = 0;
  const index = usage = createUsageIndex({
    storage: orca.storage,
    budgetBytes: BACKFILL_BYTES,
    maxUnits: BACKFILL_UNITS,
    leaderboard: true,
    rankDays: MAX_WINDOW_DAYS,
    async discover(cutoffMs, rankDay, rankFrom) {
      const key = `${cutoffMs}/${rankDay}/${rankFrom}`;
      if (!discovery || discoveryKey !== key || Date.now() - discoveryAt >= DISCOVERY_MS) {
        await history.finish();
        const localUnits = await compute.call('discover', cutoffMs, { rankDay, rankFrom });
        const remoteUnits = await history.discover(cutoffMs, rankDay, rankFrom);
        const descriptors = localUnits.descriptors.map(unit => ({ ...unit, read: () => compute.call('usage', unit.key, unit.stamp) }));
        discovery = { ...remoteUnits, localComplete: localUnits.complete, descriptors: descriptors.concat(remoteUnits.descriptors) };
        discoveryAt = Date.now();
        discoveryKey = key;
      }
      return discovery;
    },
    log: message => orca.log(language.notice(message))
  });
  let usageReady = false;
  handler = orca.panels.handle('tps.summary', () => usageReady ? index.summary() : null);
  void index.ready().then(() => {
    usageReady = true;
    tracker.handleUsage(index.leaderboardUsage());
    if (usage === index) publishUsage(orca, index);
  });
  try {
    stopLeaderboard = startLeaderboard(orca, {
      subscribePulse: tracker.subscribe,
      readPulseSeed: () => {
        const todaySpeed = usageReady ? index.summary()?.windows?.today?.speeds?.[0]?.tokensPerSecond : 0;
        return tracker.snapshot(todaySpeed);
      },
      async readUsage() {
        await index.ready();
        return index.leaderboardUsage();
      },
      async readHistory() {
        await index.ready();
        return index.leaderboardHistory();
      }
    });
  } catch { orca.log(language.t('notice.leaderboard-url-invalid')); }
  schedule(orca, FIRST_DELAY_MS);
}

function registerPanelView(orca, t) {
  const saved = orca.storage.get(PANEL_VIEW_KEY).catch(() => undefined);
  let selected, writing = Promise.resolve();
  const registration = orca.panels.handle('tps.panel-view', async payload => {
    const view = payload?.view;
    if (PANEL_VIEWS.has(view) && view !== selected) {
      selected = view;
      writing = writing.then(() => orca.storage.set(PANEL_VIEW_KEY, view)).catch(() => {
        orca.log(t('notice.panel-view-save-failed'));
      });
      await writing;
    }
    if (selected) return { view: selected };
    const restored = await saved;
    return { view: selected ?? (PANEL_VIEWS.has(restored) ? restored : null) };
  });
  return () => {
    registration.dispose();
    return writing;
  };
}

function schedule(orca, delay) {
  clearTimeout(timer);
  timer = setTimeout(() => void tick(orca), delay);
}

function publishUsage(orca, index) {
  try { orca.panels.post('tps.usage.changed', index.summary()); }
  catch { /* The next panel request can still read the cached summary. */ }
}

async function tick(orca) {
  if (!running) return;
  const index = usage, signal = usageAbort.signal;
  let delay = DISCOVERY_MS;
  try {
    const { pending } = await index.refresh({ signal });
    if (!signal.aborted) {
      pulseTracker?.handleUsage(index.leaderboardUsage());
      publishUsage(orca, index);
    }
    delay = index.hasBackfill() ? BACKFILL_DELAY_MS : pending ? DISCOVERY_MS : IDLE_DELAY_MS;
  } catch (error) {
    if (!signal.aborted) orca.log(locales.t('notice.usage-refresh-failed', error?.message ?? 'unknown'));
  }
  if (running && usage === index) schedule(orca, delay);
}

export async function deactivate() {
  running = false;
  clearTimeout(timer);
  timer = undefined;
  handler?.dispose?.();
  handler = undefined;
  localeRegistration?.dispose?.();
  localeRegistration = undefined;
  const languageWrite = locales?.flush();
  locales = undefined;
  const panelViewWrite = stopPanelView?.();
  stopPanelView = undefined;
  stopLeaderboard?.();
  stopLeaderboard = undefined;
  pulseTracker = undefined;
  controller?.stop();
  controller = undefined;
  usage = undefined;
  usageAbort?.abort();
  usageAbort = undefined;
  const history = remoteUsage;
  remoteUsage = undefined;
  const remoteReader = remote;
  remote = undefined;
  const compute = computation;
  computation = undefined;
  await compute?.close();
  const channelCache = cache;
  cache = undefined;
  await Promise.all([remoteReader?.dispose(), history?.dispose(), channelCache?.flush(), panelViewWrite, languageWrite]);
}

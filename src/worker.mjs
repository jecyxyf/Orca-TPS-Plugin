import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { createLocalePreferences } from './locales.mjs';
import { createComputation } from './computation.mjs';
import { createTpsController } from './controller.mjs';
import { createRemoteChannelReader, createRemoteUsageReader } from './remote-channel.mjs';
import { createChannelCache } from './channel-cache.mjs';
import { BACKFILL_BYTES, BACKFILL_UNITS } from './usage-summary.mjs';
import { createRecordUsageIndex } from './record-usage-index.mjs';
import { openLocalUsageDb } from './local-usage-db.mjs';
import { localUsageDatabasePath } from './data-paths.mjs';
import { startLeaderboard } from './leaderboard.mjs';
import { loadInstallationId } from './leaderboard-installation.mjs';
import { createSqliteUploadStorage } from './usage-upload.mjs';
import { createSubmissionStats } from './submission-stats.mjs';

const BACKFILL_DELAY_MS = 250, DISCOVERY_MS = 15_000, IDLE_DELAY_MS = 60_000, FIRST_DELAY_MS = 3_000;
const RECENT_REFRESH_MS = 10_000;
const PANEL_VIEW_KEY = 'panel-view';
const PANEL_VIEWS = new Set(['current-data', 'usage', 'leaderboard']);

let controller, remote, computation, cache, usage, remoteUsage, usageAbort, timer, handler, stopLeaderboard, stopPanelView, running = false;
let locales, localeRegistration, usageDb;
let scheduledAt = 0, recentCollectionUntil = 0;

export default async function activate(orca) {
  await deactivate();
  const deviceGuid = await loadInstallationId(orca.storage);
  const db = usageDb = openLocalUsageDb(localUsageDatabasePath());
  db.prune(Date.now());
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
  const channelCache = cache = createChannelCache(orca.storage, { panels: db });
  controller = createTpsController(orca, {
    cache: channelCache, locales: language,
    pollMs: 250, livePollMs: 250, focusPollMs: 1000,
    backgroundPollMs: 5000, backgroundLimit: 1, watchWorkspace: true,
    readActive: () => compute.call('active', { includeRemote: true, includeOpen: true }),
    readSession: (target, options) => target.executionHostId
      ? remoteReader.read(target, options)
      : compute.call('live', target, options),
    onOpenTargets: remoteReader.setTargets
  });
  await controller.start({ background: true });
  const stats = await createSubmissionStats(createSqliteUploadStorage(db.queue, { origin: 'local', accountId: deviceGuid }));
  const history = remoteUsage = createRemoteUsageReader(orca, {
    ...remoteOptions, includeUsageSources: true, includeRecords: true
  });
  usageAbort = new AbortController();
  let discovery, discoveryKey, discoveryAt = 0;
  let username = null;
  const index = usage = createRecordUsageIndex({
    db, deviceGuid, username: () => username,
    budgetBytes: BACKFILL_BYTES,
    maxUnits: BACKFILL_UNITS,
    onRecentRequests: stats.observe,
    async discover(cutoffMs) {
      const interval = Date.now() < recentCollectionUntil ? RECENT_REFRESH_MS : DISCOVERY_MS;
      if (!discovery || discoveryKey !== cutoffMs || Date.now() - discoveryAt >= interval) {
        await history.finish();
        const localUnits = await compute.call('discover', cutoffMs, { includeRecords: true });
        const remoteUnits = await history.discover(cutoffMs);
        const descriptors = localUnits.descriptors.map(unit => ({
          ...unit, deviceGuid, readRecords: offset => compute.call('usageRecords', unit.key, unit.stamp, offset)
        }));
        discovery = { ...remoteUnits, localComplete: localUnits.complete, descriptors: descriptors.concat(remoteUnits.descriptors) };
        discoveryAt = Date.now();
        discoveryKey = cutoffMs;
      }
      return discovery;
    },
    log: message => orca.log(language.notice(message))
  });
  let usageReady = false;
  handler = orca.panels.handle('tps.summary', () => usageReady ? index.summary() : db.readPanel('usage', 'desktop')?.value ?? null);
  void index.ready().then(() => {
    usageReady = true;
    if (usage === index) publishUsage(orca, index);
  }).catch(error => orca.log(language.t('notice.usage-refresh-failed', error?.message ?? 'unknown')));
  try {
    const localEnv = await readFile(new URL('../.env.leaderboard.local', import.meta.url), 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return '';
    });
    stopLeaderboard = startLeaderboard(orca, {
      localDb: db, reporterGuid: deviceGuid, onUsername: value => { username = value; },
      endpoint: process.env.ORCA_TPS_LEADERBOARD_URL || parseEnv(localEnv).ORCA_TPS_LEADERBOARD_URL || undefined,
      stats: {
        prepare(session, score, sourceId) {
          const time = Date.now();
          recentCollectionUntil = time + 3 * RECENT_REFRESH_MS;
          if (scheduledAt > time + RECENT_REFRESH_MS) schedule(orca, 0);
          return stats.prepare(session, score, sourceId);
        },
        settle: stats.settle
      },
      async readUsage() {
        await index.ready();
        return index.leaderboardUsage();
      },
      async readHistory() {
        await index.ready();
        return index.leaderboardHistory();
      },
      async readUsageTimes() {
        if (!await index.ready()) return null;
        return index.leaderboardUsageTimes();
      },
      async readUsageSources(reporterId) {
        return await index.ready() ? index.leaderboardSources(reporterId) : [];
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
  scheduledAt = Date.now() + delay;
  timer = setTimeout(() => {
    scheduledAt = 0;
    void tick(orca);
  }, delay);
}

function publishUsage(orca, index) {
  const summary = index.summary();
  if (summary && summary.updatedAt !== null && index.canPublish()) {
    try { usageDb?.publishPanel('usage', 'desktop', summary, summary.updatedAt); }
    catch { /* The live summary remains available. */ }
  }
  try { orca.panels.post('tps.usage.changed', summary); }
  catch { /* The next panel request can still read the cached summary. */ }
}

async function tick(orca) {
  if (!running) return;
  const index = usage, signal = usageAbort.signal;
  let delay = DISCOVERY_MS;
  try {
    const { pending } = await index.refresh({ signal });
    if (!signal.aborted) publishUsage(orca, index);
    delay = index.hasBackfill() ? BACKFILL_DELAY_MS : Date.now() < recentCollectionUntil ? RECENT_REFRESH_MS
      : pending ? DISCOVERY_MS : IDLE_DELAY_MS;
  } catch (error) {
    if (!signal.aborted) orca.log(locales.t('notice.usage-refresh-failed', error?.message ?? 'unknown'));
  }
  if (running && usage === index) schedule(orca, delay);
}

export async function deactivate() {
  running = false;
  clearTimeout(timer);
  timer = undefined;
  scheduledAt = recentCollectionUntil = 0;
  handler?.dispose?.();
  handler = undefined;
  localeRegistration?.dispose?.();
  localeRegistration = undefined;
  const languageWrite = locales?.flush();
  locales = undefined;
  const panelViewWrite = stopPanelView?.();
  stopPanelView = undefined;
  const leaderboardWrite = stopLeaderboard?.();
  stopLeaderboard = undefined;
  controller?.stop();
  controller = undefined;
  const index = usage;
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
  const db = usageDb;
  usageDb = undefined;
  try {
    await Promise.all([remoteReader?.dispose(), history?.dispose(), channelCache?.flush(), panelViewWrite, languageWrite,
      leaderboardWrite, index?.drained()]);
  } finally { db?.close(); }
}

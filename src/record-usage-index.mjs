import { createHash } from 'node:crypto';
import { personalRecordsCutoff, USAGE_RETENTION_MS } from './local-usage-db.mjs';
import { HOUR_MS, MAX_RECENT_REQUESTS, RECENT_STATS_MS, hourStart, validStatsLabel } from './leaderboard_stats.mjs';
import { validInstallationId } from './leaderboard_stats.mjs';
import { sourceMessage } from './locales.mjs';
import {
  accumulateRecords, dailySeries, HISTORY_DAYS, leaderboardDay, localHourStart, maxRequestSpeed,
  requestTokens, summarizeHourlyUsage, summarizeUsage, usageCutoffMs
} from './usage-summary.mjs';

const sumTokens = (a, b) => Math.min(Number.MAX_SAFE_INTEGER, a + b);
const importStamp = item => `local-history-${HISTORY_DAYS}:${item.stamp}`;
const RECENT_CAPTURE_LIMIT = 4096;

export function createRecordUsageIndex({
  db, deviceGuid, discover, now = Date.now, maxUnits, budgetBytes,
  onRecentRequests, log = () => {}
}) {
  const observed = new Map(), recentCaptures = new Set();
  let collection, history, cursor = 0, progress = { done: 0, total: 0 };
  let ready, refreshTail = Promise.resolve(), recordsChanged = true, totals, pastDays, personal, hourly, updatedAt = null;

  function assemble(at) {
    const day = leaderboardDay(at), localMidnight = new Date(at).setHours(0, 0, 0, 0);
    if (!recordsChanged && totals && totals.day === day && totals.localMidnight === localMidnight && at < totals.nextExpiry) return totals;
    const leaderboardCutoff = at - USAGE_RETENTION_MS;
    const records = db.readRecords({ from: Math.min(localMidnight, leaderboardCutoff), to: at + 1 });
    const firstRankingRecord = records.find(row => row.completedAt >= leaderboardCutoff);
    const days = Object.create(null), sources = new Map(), recent = new Map();
    const today = records.filter(row => row.completedAt >= localMidnight);
    accumulateRecords(days, undefined, today);
    for (const row of records) {
      if (row.completedAt < leaderboardCutoff) continue;
      if (!sources.has(row.deviceGuid)) sources.set(row.deviceGuid, { daily: new Map(), buckets: new Map(), hours: new Map() });
      const source = sources.get(row.deviceGuid);
      const day = leaderboardDay(row.completedAt);
      const tokens = requestTokens(row);
      if (tokens > 0) {
        source.daily.set(day, sumTokens(source.daily.get(day) ?? 0, tokens));
        source.buckets.set(row.completedAt, sumTokens(source.buckets.get(row.completedAt) ?? 0, tokens));
        const hour = hourStart(row.completedAt), previous = source.hours.get(hour);
        const coveredUntil = row.completedAt + 1;
        source.hours.set(hour, { hour, coveredUntil, tokens: sumTokens(previous?.tokens ?? 0, tokens),
          updatedAt: Math.max(previous?.updatedAt ?? 0, row.indexedAt, coveredUntil) });
      }
      if (onRecentRequests && row.completedAt >= at - RECENT_STATS_MS) {
        const id = createHash('sha256').update(row.id).digest('hex').slice(0, 24);
        const list = recent.get(row.deviceGuid) ?? [];
        if (list.length < MAX_RECENT_REQUESTS) list.push([id, row.completedAt, tokens, row.tokensPerSecond || null,
          validStatsLabel(row.model) ? row.model : null, row.provider === 'opencode2' ? 'opencode' : row.provider]);
        recent.set(row.deviceGuid, list);
      }
    }
    for (const [key, items] of recent) onRecentRequests(key, items);
    totals = { day, localMidnight, days, sources, maxSpeed: maxRequestSpeed(today),
      nextExpiry: firstRankingRecord ? firstRankingRecord.completedAt + USAGE_RETENTION_MS + 1 : Infinity };
    recordsChanged = false;
    return totals;
  }

  function snapshot(at) {
    const cutoffAt = localHourStart(at), imported = collection.importedAt !== null;
    const historyDays = collection.historyDays ?? 0;
    if (!hourly || (imported && (!hourly.ready || hourly.cutoffAt !== cutoffAt || hourly.historyDays !== historyDays))) {
      const records = db.iterateRecords({ from: cutoffAt - HISTORY_DAYS * 24 * HOUR_MS, to: cutoffAt });
      hourly = { cutoffAt, ready: imported, historyDays, windows: summarizeHourlyUsage(records, cutoffAt) };
    }
    const { days, localMidnight, maxSpeed } = assemble(at);
    if (pastDays?.until !== localMidnight) {
      const historical = Object.create(null);
      accumulateRecords(historical, undefined, db.iterateRecords({ from: usageCutoffMs(at), to: localMidnight }));
      pastDays = { until: localMidnight, historical };
    }
    const dayMaps = [pastDays.historical, days];
    const windows = summarizeUsage(dayMaps, at);
    windows.today.maxSpeed = maxSpeed;
    personal = { updatedAt, progress, windows, daily: dailySeries(dayMaps, at), hourly };
  }

  const initialize = () => ready ??= Promise.resolve().then(() => {
    const at = now();
    collection = db.loadCollection(at);
    const cachedHour = db.readPanel('usage', 'desktop')?.value?.hourly;
    if (cachedHour?.cutoffAt === localHourStart(at) && cachedHour.windows?.year &&
        Object.hasOwn(cachedHour.windows.today ?? {}, 'maxSpeed')) hourly = cachedHour;
    snapshot(at);
    return true;
  });

  function updateSummaries(inserted) {
    if (!inserted.length) return;
    recordsChanged = true;
    if (pastDays) {
      const historical = inserted.filter(row => row.completedAt < pastDays.until);
      accumulateRecords(pastDays.historical, undefined, historical);
    }
  }

  async function importLocalHistory(at, signal) {
    const cutoff = personalRecordsCutoff(at);
    if (!history) {
      const units = await discover(hourStart(cutoff));
      signal?.throwIfAborted();
      const known = db.readLogVersions(deviceGuid);
      history = units.filter(unit => known.get(unit.key) !== importStamp(unit)).sort((a, b) => b.mtimeMs - a.mtimeMs);
    }
    let count = 0, spent = 0;
    while (cursor < history.length) {
      const item = history[cursor];
      if (count >= maxUnits || (count && spent + item.bytes > budgetBytes)) break;
      spent += item.bytes;
      count++;
      let offset = 0;
      const records = [];
      try {
        do {
          signal?.throwIfAborted();
          const page = await item.readRecords(offset);
          signal?.throwIfAborted();
          if (!Array.isArray(page.records) || (page.nextOffset !== null &&
              (!page.records.length || page.nextOffset !== offset + page.records.length))) throw new Error('invalid usage records page');
          for (const row of page.records) records.push(row);
          offset = page.nextOffset;
        } while (offset !== null);
        const insertedRecords = [];
        db.appendRecords({ deviceGuid, records, now: at, logUnitKey: item.key, logStamp: importStamp(item), insertedRecords });
        updateSummaries(insertedRecords);
      } catch (error) {
        signal?.throwIfAborted();
        log(sourceMessage('notice.usage-read-failed', error?.code ?? error?.message ?? 'unknown'));
      }
      cursor++;
    }
    progress = { done: cursor, total: history.length };
    if (cursor === history.length) {
      const finishedAt = now();
      const state = { ...collection, importedAt: collection.importedAt ?? finishedAt, historyDays: HISTORY_DAYS };
      db.saveCollection(state, finishedAt);
      collection = state;
      history = undefined;
    }
  }

  async function refreshUsage({ signal } = {}) {
    await initialize();
    signal?.throwIfAborted();
    const at = now();
    recordsChanged = db.prune(at) > 0 || recordsChanged;
    if (hasPendingHistory()) await importLocalHistory(at, signal);
    for (const [id, seen] of observed) if (seen <= at - 60_000) observed.delete(id);
    updatedAt = now();
    snapshot(updatedAt);
  }

  function refresh(options) {
    const result = refreshTail.then(() => refreshUsage(options));
    refreshTail = result.catch(() => {});
    return result;
  }

  function observe(sourceId, records) {
    if (!collection || !validInstallationId(sourceId) || !Array.isArray(records) || !records.length) return false;
    const from = sourceId === deviceGuid ? collection.startedAt : collection.importedAt;
    if (from === null) return false;
    const at = now();
    const cutoff = Math.max(from, personalRecordsCutoff(at));
    const candidates = records.filter(row => typeof row?.id === 'string' && row.id && typeof row.provider === 'string' &&
      row.completedAt >= cutoff && row.completedAt <= at && !recentCaptures.has(sourceId + '/' + row.id));
    const insertedRecords = [];
    const added = db.appendRecords({ deviceGuid: sourceId, records: candidates, from, now: at, insertedRecords });
    for (const row of candidates) recentCaptures.add(sourceId + '/' + row.id);
    while (recentCaptures.size > RECENT_CAPTURE_LIMIT) recentCaptures.delete(recentCaptures.values().next().value);
    observed.set(sourceId, at);
    updateSummaries(insertedRecords);
    return added > 0;
  }

  function leaderboardSources(reporterId = deviceGuid) {
    const at = now(), { sources } = assemble(at);
    return [...sources].map(([id, view]) => ({
      sourceId: id, sourceKind: id === reporterId ? 'local' : 'ssh',
      observedAt: id === reporterId ? at : observed.get(id),
      daily: [...view.daily].map(([day, tokens]) => ({ day, tokens })),
      buckets: [...view.buckets].filter(([time]) => time >= at - USAGE_RETENTION_MS)
    }));
  }

  function dayTotals() {
    const at = now(), daily = new Map();
    for (const source of leaderboardSources()) for (const { day, tokens } of source.daily) {
      daily.set(day, sumTokens(daily.get(day) ?? 0, tokens));
    }
    return { day: leaderboardDay(at), daily };
  }

  function leaderboardHours(reporterId = deviceGuid) {
    const at = now(), { sources } = assemble(at);
    // Live observations can have gaps. Only send hours that contain captured requests.
    return [...sources].map(([id, view]) => ({
      sourceId: id, observedAt: id === reporterId ? at : observed.get(id), hours: [...view.hours.values()]
    }));
  }

  const initialized = () => collection != null && collection.importedAt !== null;
  const hasPendingHistory = () => (collection?.historyDays ?? 0) < HISTORY_DAYS;

  function supplementalSummary(at, providers) {
    const exclude = { deviceGuid, providers };
    const days = Object.create(null);
    accumulateRecords(days, undefined, db.iterateRecords({ from: usageCutoffMs(at), to: at + 1, exclude }));
    const cutoffAt = localHourStart(at);
    const hourly = db.iterateRecords({ from: cutoffAt - HISTORY_DAYS * 24 * HOUR_MS, to: cutoffAt, exclude });
    return { windows: summarizeUsage([days], at), daily: dailySeries([days], at), hourly: summarizeHourlyUsage(hourly, cutoffAt) };
  }

  return {
    refresh, ready: initialize, observe, initialized, hasPendingHistory, summary: () => personal, supplementalSummary, leaderboardSources, leaderboardHours,
    canPublish: () => initialized() || progress.done > 0,
    leaderboardUsage() {
      const { day, daily } = dayTotals();
      return { day, tokens: daily.get(day) ?? 0, updatedAt, ready: initialized() };
    },
    leaderboardHistory() {
      const { day, daily } = dayTotals();
      const first = leaderboardDay(now() - 29 * 24 * HOUR_MS);
      return { day, ready: initialized(), scores: [...daily].filter(([key]) => key >= first).map(([day, tokens]) => ({ day, tokens })) };
    },
    leaderboardUsageTimes() {
      const buckets = new Map();
      for (const source of leaderboardSources()) for (const [at, tokens] of source.buckets) {
        buckets.set(at, sumTokens(buckets.get(at) ?? 0, tokens));
      }
      return { buckets: [...buckets].sort(([a], [b]) => a - b) };
    },
    drained: () => refreshTail
  };
}

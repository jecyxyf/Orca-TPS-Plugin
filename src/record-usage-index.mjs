import { createHash } from 'node:crypto';
import { personalRecordsCutoff, USAGE_RETENTION_MS } from './local-usage-db.mjs';
import { HOUR_MS, MAX_RECENT_REQUESTS, RECENT_STATS_MS, hourStart, validStatsLabel } from './leaderboard-stats.mjs';
import { validInstallationId } from './leaderboard-installation.mjs';
import { sourceMessage } from './locales.mjs';
import { accumulateRecords, dailySeries, leaderboardDay, localHourStart, requestTokens, summarizeHourlyUsage, summarizeUsage } from './usage-summary.mjs';

const sumTokens = (a, b) => Math.min(Number.MAX_SAFE_INTEGER, a + b);
const importStamp = item => 'local-history:' + item.stamp;
const RECENT_CAPTURE_LIMIT = 4096;

export function createRecordUsageIndex({
  db, deviceGuid, discover, now = Date.now, maxUnits, budgetBytes, username = () => null,
  onRecentRequests, log = () => {}
}) {
  const observed = new Map(), recentCaptures = new Set();
  let collection, history, cursor = 0, progress = { done: 0, total: 0 };
  let ready, refreshTail = Promise.resolve(), recordsChanged = true, totals, personal, hourly, updatedAt = null;

  function assemble(at) {
    if (!recordsChanged && totals && totals.day === leaderboardDay(at) && at < totals.nextExpiry) return totals;
    const leaderboardCutoff = at - USAGE_RETENTION_MS;
    const records = db.readRecords({ from: personalRecordsCutoff(at), to: at + 1 });
    const firstRankingRecord = records.find(row => row.completedAt >= leaderboardCutoff);
    const days = Object.create(null), sources = new Map(), recent = new Map();
    for (const [provider, items] of Map.groupBy(records, item => item.provider)) accumulateRecords(days, provider, items);
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
    totals = { day: leaderboardDay(at), days, sources,
      nextExpiry: firstRankingRecord ? firstRankingRecord.completedAt + USAGE_RETENTION_MS + 1 : Infinity };
    recordsChanged = false;
    return totals;
  }

  function snapshot(at) {
    const cutoffAt = localHourStart(at), imported = collection.importedAt !== null;
    if (!hourly || (imported && (!hourly.ready || hourly.cutoffAt !== cutoffAt))) {
      const records = db.readRecords({ from: personalRecordsCutoff(at), to: cutoffAt });
      hourly = { cutoffAt, ready: imported, windows: summarizeHourlyUsage(records, cutoffAt) };
    }
    const { days } = assemble(at);
    personal = { updatedAt, progress, windows: summarizeUsage([days], at), daily: dailySeries([days], at), hourly };
  }

  const initialize = () => ready ??= Promise.resolve().then(() => {
    const at = now();
    collection = db.loadCollection(at);
    const cachedHour = db.readPanel('usage', 'desktop')?.value?.hourly;
    if (cachedHour?.windows && cachedHour.cutoffAt === localHourStart(at)) hourly = cachedHour;
    snapshot(at);
    return true;
  });

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
          for (const row of page.records) records.push({ ...row, username: username() });
          offset = page.nextOffset;
        } while (offset !== null);
        const added = db.appendRecords({ deviceGuid, records, now: at, logUnitKey: item.key, logStamp: importStamp(item) });
        recordsChanged ||= added > 0;
      } catch (error) {
        signal?.throwIfAborted();
        log(sourceMessage('notice.usage-read-failed', error?.code ?? error?.message ?? 'unknown'));
      }
      cursor++;
    }
    progress = { done: cursor, total: history.length };
    if (cursor === history.length) {
      const importedAt = now();
      const state = { ...collection, importedAt };
      db.saveCollection(state, importedAt);
      collection = state;
      history = undefined;
    }
  }

  async function refreshUsage({ signal } = {}) {
    await initialize();
    signal?.throwIfAborted();
    const at = now();
    recordsChanged = db.prune(at) > 0 || recordsChanged;
    if (collection.importedAt === null) await importLocalHistory(at, signal);
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
    const account = username();
    const added = db.appendRecords({ deviceGuid: sourceId, records: candidates.map(row => ({ ...row, username: account })), from, now: at });
    for (const row of candidates) recentCaptures.add(sourceId + '/' + row.id);
    while (recentCaptures.size > RECENT_CAPTURE_LIMIT) recentCaptures.delete(recentCaptures.values().next().value);
    observed.set(sourceId, at);
    recordsChanged ||= added > 0;
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
  return {
    refresh, ready: initialize, observe, initialized, summary: () => personal, leaderboardSources, leaderboardHours,
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

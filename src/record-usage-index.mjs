import { createHash } from 'node:crypto';
import { USAGE_RETENTION_MS } from './local-usage-db.mjs';
import { HOUR_MS, MAX_RECENT_REQUESTS, RECENT_STATS_MS, validStatsLabel } from './leaderboard-stats.mjs';
import { sourceMessage } from './locales.mjs';
import { accumulateRecords, dailySeries, leaderboardDay, requestTokens, summarizeUsage } from './usage-summary.mjs';

const RETRY_MS = 15_000;
const LARGE_UNIT_BYTES = 64 * 1024 * 1024;
const LARGE_UNIT_INTERVAL_MS = 10 * 60_000;
const keyFor = ({ deviceGuid, key }) => `${deviceGuid}/${key}`;
const sumTokens = (a, b) => Math.min(Number.MAX_SAFE_INTEGER, a + b);

export function createRecordUsageIndex({
  db, deviceGuid, discover, now = Date.now, maxUnits, budgetBytes, username = () => null,
  onRecentRequests, log = () => {}
}) {
  const scans = new Map(), empty = new Map(), retries = new Map(), readAt = new Map();
  let ready, refreshTail = Promise.resolve(), recordsChanged = true, totals, personal, updatedAt = null;
  let moreBackfill = false, complete = false, progress = { done: 0, total: 0 };

  function assemble(at) {
    if (!recordsChanged && totals && totals.day === leaderboardDay(at) && at < totals.nextExpiry) return totals;
    const records = db.readRecords({ from: at - USAGE_RETENTION_MS, to: at + 1 });
    const days = Object.create(null), sources = new Map(), recent = new Map();
    for (const [provider, items] of Map.groupBy(records, item => item.provider)) accumulateRecords(days, provider, items);
    for (const row of records) {
      if (!sources.has(row.deviceGuid)) sources.set(row.deviceGuid, { daily: new Map(), buckets: new Map() });
      const source = sources.get(row.deviceGuid);
      const day = leaderboardDay(row.completedAt);
      const tokens = requestTokens(row);
      if (tokens > 0) {
        source.daily.set(day, sumTokens(source.daily.get(day) ?? 0, tokens));
        source.buckets.set(row.completedAt, sumTokens(source.buckets.get(row.completedAt) ?? 0, tokens));
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
    totals = { day: leaderboardDay(at), days, sources, nextExpiry: records.length ? records[0].completedAt + USAGE_RETENTION_MS + 1 : Infinity };
    recordsChanged = false;
    return totals;
  }

  function snapshot(at) {
    const { days } = assemble(at);
    personal = { updatedAt, progress, windows: summarizeUsage([days], at), daily: dailySeries([days], at) };
  }

  const initialize = () => ready ??= Promise.resolve().then(() => {
    snapshot(now());
    return true;
  });

  async function refreshUsage({ signal } = {}) {
    await initialize();
    signal?.throwIfAborted();
    const at = now(), cutoff = at - USAGE_RETENTION_MS;
    const purged = db.prune(at);
    recordsChanged ||= purged > 0;
    const view = await discover(Math.floor(cutoff / HOUR_MS) * HOUR_MS);
    signal?.throwIfAborted();
    scans.clear();
    complete = false;
    const successful = new Map();
    const items = view.descriptors;
    const versions = new Map([...new Set(items.map(item => item.deviceGuid))].map(id => [id, db.readLogVersions(id)]));
    const seenStamp = item => empty.get(keyFor(item)) ?? versions.get(item.deviceGuid)?.get(item.key);
    const current = item => seenStamp(item) === item.stamp;
    const deferred = item => seenStamp(item) && item.bytes > LARGE_UNIT_BYTES &&
      (readAt.get(keyFor(item)) ?? -Infinity) + LARGE_UNIT_INTERVAL_MS > at;
    const pending = items.filter(item => !current(item) && !deferred(item) && (retries.get(keyFor(item)) ?? 0) <= at)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    let spent = 0, count = 0;
    for (const item of pending) {
      if (count >= maxUnits || (count && spent + item.bytes > budgetBytes)) break;
      spent += item.bytes;
      count++;
      let offset = 0, isComplete = true;
      const records = [];
      try {
        do {
          signal?.throwIfAborted();
          const page = await item.readRecords(offset);
          signal?.throwIfAborted();
          if (!Array.isArray(page.records) || (page.nextOffset !== null &&
              (!page.records.length || page.nextOffset !== offset + page.records.length))) throw new Error('invalid usage records page');
          isComplete &&= page.complete === true;
          for (const record of page.records) if (record.completedAt >= cutoff) records.push({ ...record, username: username() });
          offset = page.nextOffset;
        } while (offset !== null);
        if (!isComplete) throw new Error('usage_log_incomplete');
        const changed = db.replaceLog({ deviceGuid: item.deviceGuid, logUnitKey: item.key, logStamp: item.stamp,
          records, complete: true, now: at });
        recordsChanged ||= changed.length > 0;
        successful.set(keyFor(item), item.stamp);
        readAt.set(keyFor(item), at);
        if (!records.length) empty.set(keyFor(item), item.stamp);
        else empty.delete(keyFor(item));
        retries.delete(keyFor(item));
      } catch (error) {
        signal?.throwIfAborted();
        retries.set(keyFor(item), at + RETRY_MS);
        log(sourceMessage('notice.usage-read-failed', error?.code ?? error?.message ?? 'unknown'));
      }
    }
    const done = item => successful.get(keyFor(item)) === item.stamp || current(item);
    const bySource = Map.groupBy(items, item => item.deviceGuid);
    const missing = id => (bySource.get(id) ?? []).filter(item => !done(item));
    function scanned(id, observedAt) {
      const unread = missing(id);
      scans.set(id, {
        observedAt: unread.some(item => (retries.get(keyFor(item)) ?? 0) > at) ? undefined : observedAt,
        coverage: unread.length ? undefined : [cutoff, at]
      });
    }
    if (view.localComplete) scanned(deviceGuid, at);
    for (const source of view.remoteSources?.values() ?? []) scanned(source.sourceId, source.observedAt);
    complete = view.localComplete && view.remoteComplete && items.every(done) &&
      db.readSources().every(id => scans.has(id));
    progress = { done: items.filter(done).length, total: items.length };
    moreBackfill = count < pending.length;
    const known = new Set(items.map(keyFor));
    for (const map of [empty, retries, readAt]) for (const key of map.keys()) if (!known.has(key)) map.delete(key);
    updatedAt = now();
    snapshot(updatedAt);
    return { pending: progress.total - progress.done };
  }

  function refresh(options) {
    const result = refreshTail.then(() => refreshUsage(options));
    refreshTail = result.catch(() => {});
    return result;
  }

  function leaderboardSources(reporterId = deviceGuid) {
    const at = now(), { sources } = assemble(at);
    const cutoff = at - USAGE_RETENTION_MS;
    return [...new Set([...scans.keys(), ...sources.keys()])].map(id => {
      const view = sources.get(id), scan = scans.get(id);
      return { sourceId: id, sourceKind: id === reporterId ? 'local' : 'ssh', observedAt: scan?.observedAt,
        coverage: scan?.coverage?.[1] > cutoff ? scan.coverage : undefined,
        daily: [...(view?.daily ?? [])].map(([day, tokens]) => ({ day, tokens })),
        buckets: [...(view?.buckets ?? [])].filter(([time]) => time >= cutoff) };
    });
  }

  function dayTotals() {
    const at = now(), daily = new Map();
    for (const source of leaderboardSources()) for (const { day, tokens } of source.daily) {
      daily.set(day, sumTokens(daily.get(day) ?? 0, tokens));
    }
    return { day: leaderboardDay(at), daily };
  }

  return {
    refresh, ready: initialize, summary: () => personal, hasBackfill: () => moreBackfill, leaderboardSources,
    canPublish: () => complete || updatedAt !== null && progress.done > 0,
    leaderboardUsage() {
      const { day, daily } = dayTotals();
      return { day, tokens: daily.get(day) ?? 0, updatedAt, ready: complete };
    },
    leaderboardHistory() {
      const { day, daily } = dayTotals();
      const first = leaderboardDay(now() - 29 * 24 * HOUR_MS);
      return { day, ready: complete, scores: [...daily].filter(([key]) => key >= first).map(([day, tokens]) => ({ day, tokens })) };
    },
    leaderboardUsageTimes() {
      const buckets = new Map(), views = leaderboardSources();
      for (const source of views) for (const [at, tokens] of source.buckets) buckets.set(at, sumTokens(buckets.get(at) ?? 0, tokens));
      return { buckets: [...buckets].sort(([a], [b]) => a - b), coverage: complete ? scans.get(deviceGuid)?.coverage : undefined };
    },
    drained: () => refreshTail
  };
}

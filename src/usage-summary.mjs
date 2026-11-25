import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { gzip, gunzip } from 'node:zlib';
import { validInstallationId } from './leaderboard_stats.mjs';
import {
  HOUR_MS, MAX_RECENT_REQUESTS, RANKING_HOURS, RECENT_STATS_MS, validStatsLabel,
  leaderboardDay, leaderboardDayStart, leaderboardUsageTimesFrom, validLeaderboardUsageTimes
} from './leaderboard_stats.mjs';
import {
  COUNTERS, SPEED_AT, localDayKey, localHourStart, usageCutoffMs, dailySeries, summarizeUsage, trimRecentRequests
} from './personal_stats.mjs';

export {
  HISTORY_DAYS, WINDOWS, ROW_LIMIT, SPEED_MIN_SAMPLES, localDayKey, dayKeyAgo, localHourStart, usageCutoffMs, accumulateRecords, trimRecentRequests, realTokens, cacheHitRate, summarizeUsage, summarizeHourlyUsage, maxRequestSpeed, summarizeGroups, dailySeries
} from './personal_stats.mjs';
export { leaderboardDay, leaderboardDayStart, leaderboardUsageTimesFrom, validLeaderboardUsageTimes, requestTokens } from './leaderboard_stats.mjs';

export const UNIT_KEY_PREFIX = 'usage:unit:';
const BUCKET_KEY_PREFIX = 'usage:b:';
const BUCKET_COUNT = 64;
const BUCKET_FORMAT = 'usage-bucket-v1';
const compress = promisify(gzip);
const decompress = promisify(gunzip);
export const REMOTE_USAGE_PREFIX = 'remote:';
export const USAGE_READ_BATCH = 16;
export const BACKFILL_BYTES = 16 * 1024 * 1024;
export const BACKFILL_UNITS = 8;
export const MAX_WINDOW_DAYS = 30;
export const USAGE_SCHEMA = 2;

const validUnit = value => value && typeof value === 'object' && typeof value.stamp === 'string' && value.days && typeof value.days === 'object';

function bucketIndex(key) {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
  return (hash >>> 0) % BUCKET_COUNT;
}

function createUsageStorage(storage, log) {
  const buckets = new Map(), pending = new Set();

  function getBucket(index) {
    if (!buckets.has(index)) buckets.set(index, { key: null, units: new Map(), legacy: new Set(), changed: false });
    return buckets.get(index);
  }

  async function load() {
    const stored = [], legacy = [];
    for (const key of await storage.keys()) {
      if (!key.startsWith(BUCKET_KEY_PREFIX) && !key.startsWith(UNIT_KEY_PREFIX)) continue;
      const value = await storage.get(key);
      if (value?.format === BUCKET_FORMAT && Number.isInteger(value.bucket) && value.bucket >= 0 && value.bucket < BUCKET_COUNT) {
        let entries = [];
        try {
          const decoded = await decompress(Buffer.from(value.data, 'base64'));
          entries = Object.entries(JSON.parse(decoded.toString('utf8')));
        } catch (error) {
          log(['notice.usage-index-read-failed', error?.message ?? 'unknown']);
        }
        stored.push({ key, index: value.bucket, entries });
      } else if (key.startsWith(UNIT_KEY_PREFIX) && validUnit(value)) {
        legacy.push([key.slice(UNIT_KEY_PREFIX.length), value]);
      }
    }
    for (const { key, index, entries } of stored) {
      const bucket = getBucket(index);
      bucket.key = key;
      for (const [unitKey, unit] of entries) {
        if (validUnit(unit) && bucketIndex(unitKey) === index) bucket.units.set(unitKey, unit);
      }
    }
    for (const [key, unit] of legacy) {
      const index = bucketIndex(key), bucket = getBucket(index);
      bucket.legacy.add(key);
      // A group that was saved before an interruption already has the newer copy.
      if (!bucket.units.has(key)) {
        bucket.units.set(key, unit);
        bucket.changed = true;
      }
      pending.add(index);
    }
    return buckets.values();
  }

  function update(key, unit) {
    const index = bucketIndex(key), bucket = getBucket(index);
    if (unit) bucket.units.set(key, unit);
    else bucket.units.delete(key);
    bucket.changed = true;
    pending.add(index);
  }

  async function flush(signal) {
    let migrationWrites = BACKFILL_UNITS;
    async function deleteLegacy(bucket, shouldDelete) {
      for (const key of bucket.legacy) {
        if (!shouldDelete(key)) continue;
        if (!migrationWrites) return false;
        signal?.throwIfAborted();
        await storage.delete(UNIT_KEY_PREFIX + key);
        bucket.legacy.delete(key);
        migrationWrites--;
      }
      return true;
    }

    for (const index of pending) {
      signal?.throwIfAborted();
      const bucket = buckets.get(index);
      try {
        // Remove expired legacy copies before saving a group without them, so a restart cannot load them again.
        if (!await deleteLegacy(bucket, key => !bucket.units.has(key))) continue;
        if (bucket.changed) {
          const legacyKey = bucket.legacy.values().next().value;
          if (bucket.legacy.size && !migrationWrites) continue;
          if (bucket.units.size) {
            // Reuse a legacy slot for the first write, even when the store has no free keys.
            const key = bucket.key ?? (legacyKey === undefined ? BUCKET_KEY_PREFIX + index : UNIT_KEY_PREFIX + legacyKey);
            const data = await compress(JSON.stringify(Object.fromEntries(bucket.units)));
            signal?.throwIfAborted();
            await storage.set(key, { format: BUCKET_FORMAT, bucket: index, data: data.toString('base64') });
            bucket.key = key;
            if (legacyKey !== undefined) migrationWrites--;
            if (key.startsWith(UNIT_KEY_PREFIX)) bucket.legacy.delete(key.slice(UNIT_KEY_PREFIX.length));
          } else if (bucket.key) {
            await storage.delete(bucket.key);
          }
          bucket.changed = false;
        }
        // Each legacy copy is removed only after its group has been written successfully.
        if (!await deleteLegacy(bucket, () => true)) continue;
        pending.delete(index);
        if (!bucket.units.size) buckets.delete(index);
      } catch (error) {
        signal?.throwIfAborted();
        log(['notice.usage-index-write-failed', error?.message ?? 'unknown']);
      }
    }
    return !migrationWrites && pending.size > 0;
  }

  return { load, update, flush };
}

/**
 * Incremental index. `discover(cutoffMs)` returns unit descriptors:
 * { key, stamp, bytes, mtimeMs, read: async () => days }. Changed units are read newest first until the byte
 * budget for this pass is spent; the first unit always goes through so one large file cannot starve the rest.
 */
const LARGE_UNIT_BYTES = 64 * 1024 * 1024, LARGE_UNIT_INTERVAL_MS = 10 * 60_000;
const RETRY_MIN_MS = 15_000, RETRY_MAX_MS = 10 * 60_000;

export function createUsageIndex({
  storage, discover, now = () => Date.now(), budgetBytes = 2 * 1024 * 1024 * 1024, maxUnits = Infinity,
  leaderboard = false, rankDays = 1, includeUsageTimes = false, onRecentRequests, log = () => {}
}) {
  const units = new Map();
  const combined = Object.create(null), scores = new Map(), usageByTime = new Map();
  const usageStorage = createUsageStorage(storage, log);
  let loaded = null, progress = { done: 0, total: 0 }, updatedAt = null, summaryCache, summaryDay;
  let refreshQueue = Promise.resolve();
  let readyLeaderboardDay = '', readyHistoryDay = '', moreBackfill = false, coveredUntil = null;
  let sourceScans = new Map();
  const recentReads = new Set();
  const scopeOf = key => key.startsWith(REMOTE_USAGE_PREFIX) ? key.slice(0, key.lastIndexOf(':') + 1) : '';

  function adjust(unit, direction) {
    if (!unit) return;
    for (const [day, agents] of Object.entries(unit.days)) {
      const dayTotals = combined[day] ??= Object.create(null);
      for (const [agent, models] of Object.entries(agents)) {
        const agentTotals = dayTotals[agent] ??= Object.create(null);
        for (const [model, counters] of Object.entries(models)) {
          const total = agentTotals[model] ??= new Array(COUNTERS).fill(0);
          for (let i = 0; i < COUNTERS; i++) total[i] += direction * (counters[i] ?? 0);
          if (!total[0]) delete agentTotals[model];
          else if (!total[SPEED_AT]) total[SPEED_AT + 1] = 0;
        }
        if (!Object.keys(agentTotals).length) delete dayTotals[agent];
      }
      if (!Object.keys(dayTotals).length) delete combined[day];
    }
    for (const [day, tokens] of Object.entries(unit.leaderboardDays ?? {})) {
      const total = (scores.get(day) ?? 0) + direction * tokens;
      if (total > 0) scores.set(day, total);
      else scores.delete(day);
    }
    if (includeUsageTimes && validLeaderboardUsageTimes(unit.leaderboardUsageByTime, unit.usageTimesFrom)) {
      for (const [timestamp, tokens] of Object.entries(unit.leaderboardUsageByTime)) {
        const at = Number(timestamp), total = (usageByTime.get(at) ?? 0n) + BigInt(direction) * BigInt(tokens);
        if (total > 0n) usageByTime.set(at, total);
        else usageByTime.delete(at);
      }
    }
  }

  function setUnit(key, previous, next) {
    if (!next || previous?.days !== next.days || previous?.leaderboardDays !== next.leaderboardDays ||
        previous?.leaderboardUsageByTime !== next.leaderboardUsageByTime) {
      adjust(previous, -1);
      adjust(next, 1);
    }
    if (next) units.set(key, next);
    else units.delete(key);
  }

  async function load() {
    for (const bucket of await usageStorage.load()) {
      for (const [key, value] of bucket.units) setUnit(key, undefined, value);
    }
    summaryCache = undefined;
    summary();
    return true;
  }

  // Persisted units are loaded once, before the first summary or refresh can read them.
  const ready = () => {
    loaded ??= load().catch(error => {
      log(['notice.usage-index-read-failed', error?.message ?? 'unknown']);
      loaded = null;
      return false;
    });
    return loaded;
  };

  function refresh(options) {
    const result = refreshQueue.then(() => refreshUsage(options));
    refreshQueue = result.catch(() => {});
    return result;
  }

  async function refreshUsage({ signal } = {}) {
    if (!await ready()) return { pending: 0 };
    signal?.throwIfAborted();
    const refreshAt = now();
    const rankDay = leaderboardDay(refreshAt);
    const rankStart = leaderboardDayStart(rankDay);
    const rankFrom = leaderboardDay(rankStart - (rankDays - 1) * 86_400_000);
    const historyStart = leaderboardDayStart(rankFrom);
    const usageTimesFrom = leaderboardUsageTimesFrom(rankFrom);
    const discovery = await discover(usageCutoffMs(refreshAt), leaderboard ? rankDay : undefined, leaderboard ? rankFrom : undefined);
    signal?.throwIfAborted();
    const { descriptors, coveredRemoteScopes, remoteSources = new Map(), localComplete = true, remoteComplete = true } = Array.isArray(discovery)
      ? { descriptors: discovery, coveredRemoteScopes: new Set() }
      : discovery;
    const wanted = new Set(descriptors.map(descriptor => descriptor.key));
    for (const key of [...units.keys()]) {
      signal?.throwIfAborted();
      if (wanted.has(key)) continue;
      const scope = scopeOf(key);
      if (scope ? !coveredRemoteScopes.has(scope) : !localComplete) continue;
      setUnit(key, units.get(key));
      recentReads.delete(key);
      usageStorage.update(key);
    }
    const missingToday = (descriptor, current) => descriptor.mtimeMs >= rankStart &&
      (current?.leaderboardThrough ?? current?.leaderboardFrom) !== rankDay;
    const missingHistory = (descriptor, current) => descriptor.mtimeMs >= historyStart &&
      (!current?.leaderboardFrom || current.leaderboardFrom > rankFrom || missingToday(descriptor, current));
    const missingUsageTimes = (descriptor, current) => includeUsageTimes && descriptor.mtimeMs >= usageTimesFrom &&
      (!current?.leaderboardUsageByTime || !(current.usageTimesFrom <= usageTimesFrom));
    // A large file that is still being written is re-read at most every LARGE_UNIT_INTERVAL_MS; until then the
    // last read stays in effect and counts as up to date.
    const deferred = descriptor => {
      const current = units.get(descriptor.key);
      return current !== undefined && !current.failed && current.stamp !== descriptor.stamp && descriptor.bytes > LARGE_UNIT_BYTES
        && (!leaderboard || !missingHistory(descriptor, current)) && !missingUsageTimes(descriptor, current)
        && now() - (current.readAt ?? 0) < LARGE_UNIT_INTERVAL_MS;
    };
    const needsRead = descriptor => {
      const current = units.get(descriptor.key);
      return !current || current.failed || current.stamp !== descriptor.stamp || current.schema !== USAGE_SCHEMA ||
        (onRecentRequests && descriptor.mtimeMs >= refreshAt - RECENT_STATS_MS && !recentReads.has(descriptor.key)) ||
        (leaderboard && missingHistory(descriptor, current)) || missingUsageTimes(descriptor, current);
    };
    const waitingRetry = descriptor => {
      const current = units.get(descriptor.key);
      return current?.failed && current.failedStamp === descriptor.stamp && now() < current.retryAt;
    };
    const aliases = new Map();
    for (const [scope, source] of remoteSources) {
      for (const legacy of source.legacyScopes) aliases.set(legacy, scope);
    }
    const legacyUnits = [];
    for (const [key, unit] of units) {
      const legacy = scopeOf(key), scope = aliases.get(legacy);
      if (!scope) continue;
      legacyUnits.push({ key, unit, scope, canonical: scope + key.slice(legacy.length) });
    }
    const known = new Map(descriptors.map(descriptor => [descriptor.key, descriptor]));
    for (const { unit, canonical } of legacyUnits) {
      if (units.has(canonical) || unit.failed || known.get(canonical)?.stamp !== unit.stamp) continue;
      setUnit(canonical, undefined, unit);
      usageStorage.update(canonical, unit);
    }
    const pending = descriptors.filter(descriptor => needsRead(descriptor) && !deferred(descriptor) && !waitingRetry(descriptor))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const incomplete = (descriptor, boundary, missing) => descriptor.mtimeMs >= boundary &&
      (missing(descriptor, units.get(descriptor.key)) || needsRead(descriptor));
    function updateReadiness() {
      if (!leaderboard) return;
      const complete = localComplete && remoteComplete;
      readyLeaderboardDay = complete && !descriptors.some(item => incomplete(item, rankStart, missingToday)) ? rankDay : '';
      readyHistoryDay = complete && !descriptors.some(item => incomplete(item, historyStart, missingHistory)) ? rankDay : '';
      if (includeUsageTimes) coveredUntil = complete && !descriptors.some(item => incomplete(item, usageTimesFrom, missingUsageTimes))
        ? refreshAt : undefined;
    }
    sourceScans = new Map();
    updateReadiness();
    let spent = 0;
    const selected = [];
    for (const descriptor of pending) {
      if (selected.length >= maxUnits) break;
      if (selected.length && spent + descriptor.bytes > budgetBytes) break;
      spent += descriptor.bytes;
      selected.push(descriptor);
    }
    moreBackfill = selected.length < pending.length;
    // Only selected, changed units are fetched. Share one SSH request per batch without
    // reading local files concurrently or taking work out of the existing byte budget.
    const groups = Map.groupBy(selected.filter(descriptor => descriptor.readMany), descriptor => descriptor.readMany);
    const buffered = new Map();
    async function readDays(descriptor) {
      if (!descriptor.readMany) return descriptor.read();
      const { key, readMany } = descriptor;
      if (!buffered.has(key)) {
        const batch = groups.get(readMany).splice(0, USAGE_READ_BATCH);
        let results;
        try { results = await readMany(batch.map(item => item.key)); }
        catch { /* Each failed unit keeps its last totals and is retried individually. */ }
        for (const item of batch) buffered.set(item.key, results?.get(item.key));
      }
      const days = buffered.get(key);
      buffered.delete(key);
      if (!days) throw new Error('remote_usage_unavailable');
      return days;
    }
    for (const descriptor of selected) {
      signal?.throwIfAborted();
      let unit;
      try {
        const result = await readDays(descriptor);
        const { days, leaderboardDays, leaderboardFrom, recent } = leaderboard ? result : { days: result };
        unit = { stamp: descriptor.stamp, days, readAt: now(), schema: USAGE_SCHEMA };
        if (leaderboard) Object.assign(unit, { leaderboardDays, leaderboardFrom, leaderboardThrough: rankDay });
        if (includeUsageTimes) {
          if (result.usageTimesFrom !== usageTimesFrom || !validLeaderboardUsageTimes(result.leaderboardUsageByTime, usageTimesFrom, rankStart + 24 * HOUR_MS)) {
            throw new Error('rolling_usage_unavailable');
          }
          Object.assign(unit, { leaderboardUsageByTime: result.leaderboardUsageByTime, usageTimesFrom });
        }
        signal?.throwIfAborted();
        if (onRecentRequests) {
          recentReads.add(descriptor.key);
          if (recent?.length) onRecentRequests(descriptor.key, recent);
        }
      } catch (error) {
        signal?.throwIfAborted();
        // Keep the last successful counts and retry even when a transient failure leaves the file unchanged.
        // Persist the retry deadline as well, so a worker restart cannot turn the failure into an empty success.
        const current = units.get(descriptor.key);
        const failures = current?.failedStamp === descriptor.stamp ? Math.min((current.failures ?? 0) + 1, 7) : 1;
        unit = {
          ...current, stamp: current?.stamp ?? '', days: current?.days ?? {},
          failed: true, failedStamp: descriptor.stamp, failures,
          retryAt: now() + Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** (failures - 1))
        };
        log(['notice.usage-read-failed', error?.code ?? error?.message ?? 'unknown']);
      }
      signal?.throwIfAborted();
      setUnit(descriptor.key, units.get(descriptor.key), unit);
      usageStorage.update(descriptor.key, unit);
    }
    const byScope = Map.groupBy(descriptors, descriptor => scopeOf(descriptor.key));
    function scanFor(scope, observedAt) {
      const items = byScope.get(scope) ?? [];
      const incompleteRead = items.some(descriptor => incomplete(descriptor, usageTimesFrom, missingUsageTimes));
      const failed = scope && items.some(item => item.mtimeMs >= usageTimesFrom && units.get(item.key)?.failed);
      return { observedAt: failed ? undefined : observedAt, ...(incompleteRead ? {} : { coverage: [usageTimesFrom, refreshAt] }) };
    }
    if (localComplete) sourceScans.set('', scanFor('', refreshAt));
    for (const [scope, source] of remoteSources) sourceScans.set(scope, scanFor(scope, source.observedAt));
    for (const { key, unit, scope, canonical } of legacyUnits) {
      const current = units.get(canonical);
      if (!sourceScans.get(scope)?.coverage && (!current || current.failed || !known.has(canonical))) continue;
      setUnit(key, unit);
      recentReads.delete(key);
      usageStorage.update(key);
    }
    const migrating = await usageStorage.flush(signal);
    moreBackfill ||= migrating;
    progress = {
      done: descriptors.filter(descriptor => !needsRead(descriptor) || deferred(descriptor)).length,
      total: descriptors.length
    };
    updatedAt = now();
    updateReadiness();
    summaryCache = undefined;
    summary();
    return { pending: progress.total - progress.done };
  }

  function summary() {
    const nowMs = now(), day = localDayKey(nowMs);
    if (!summaryCache || day !== summaryDay) {
      summaryDay = day;
      summaryCache = { updatedAt, progress, windows: summarizeUsage([combined], nowMs), daily: dailySeries([combined], nowMs) };
    }
    return summaryCache;
  }

  function leaderboardUsage() {
    const day = leaderboardDay(now());
    return { day, tokens: scores.get(day) ?? 0, updatedAt, ready: readyLeaderboardDay === day };
  }

  function leaderboardHistory() {
    const nowMs = now(), day = leaderboardDay(nowMs);
    if (readyHistoryDay !== day) return { day, ready: false };
    const from = leaderboardDay(nowMs - (rankDays - 1) * 86_400_000);
    const history = [...scores.keys()].filter(key => key >= from && key <= day).sort();
    return { day, ready: true, scores: history.map(day => ({ day, tokens: scores.get(day) })) };
  }

  function leaderboardUsageTimes() {
    const cutoff = now(), start = cutoff - RANKING_HOURS.at(-1) * HOUR_MS;
    const buckets = [...usageByTime].filter(([at]) => at >= start && at <= cutoff).sort((a, b) => a[0] - b[0])
      .map(([at, tokens]) => [at, Number(tokens > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : tokens)]);
    return { buckets, coverage: coveredUntil > start && coveredUntil <= cutoff ? [start, coveredUntil] : undefined };
  }

  function leaderboardSources(reporterId) {
    const cutoff = now(), span = RANKING_HOURS.at(-1) * HOUR_MS, start = cutoff - span;
    const today = leaderboardDay(cutoff), first = leaderboardDay(start);
    const groups = new Map([...sourceScans.keys()].map(scope => [scope, { daily: new Map(), buckets: new Map() }]));
    for (const [key, unit] of units) {
      const scope = scopeOf(key);
      if (scope && !validInstallationId(scope.slice(REMOTE_USAGE_PREFIX.length, -1))) continue;
      if (!groups.has(scope)) groups.set(scope, { daily: new Map(), buckets: new Map() });
      const source = groups.get(scope);
      const edge = sourceScans.get(scope)?.coverage?.[1];
      const from = edge === undefined ? start : Math.min(start, edge - span);
      for (const [day, tokens] of Object.entries(unit.leaderboardDays ?? {})) {
        if (day >= first && day <= today) source.daily.set(day, (source.daily.get(day) ?? 0) + tokens);
      }
      for (const [time, tokens] of Object.entries(unit.leaderboardUsageByTime ?? {})) {
        const at = Number(time);
        if (at >= from && at <= cutoff) {
          source.buckets.set(at, (source.buckets.get(at) ?? 0n) + BigInt(tokens));
        }
      }
    }
    const limit = BigInt(Number.MAX_SAFE_INTEGER);
    return [...groups].map(([scope, source]) => {
      const { coverage, observedAt } = sourceScans.get(scope) ?? {};
      return {
        sourceId: scope ? scope.slice(REMOTE_USAGE_PREFIX.length, -1) : reporterId,
        sourceKind: scope ? 'ssh' : 'local', observedAt,
        daily: [...source.daily].sort(([a], [b]) => a.localeCompare(b)).map(([day, tokens]) => ({ day, tokens })),
        buckets: [...source.buckets].sort(([a], [b]) => a - b).map(([at, tokens]) => [at, Number(tokens > limit ? limit : tokens)]),
        ...(coverage?.[1] > start && coverage[0] <= coverage[1] - span ? { coverage: [coverage[1] - span, coverage[1]] } : {})
      };
    });
  }

  return { refresh, summary, ready, leaderboardUsage, leaderboardHistory, leaderboardUsageTimes, leaderboardSources,
    hasBackfill: () => moreBackfill };
}

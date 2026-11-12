// Usage totals for the 当日/近一周/近一月 cards. Pure aggregation plus an incremental index: each source unit
// (one session file, or one OpenCode session) is parsed once, its per-day counts are stored, and it is only
// re-read when its stamp changes. Stored values are counts keyed by day, agent and model; no message text.

export const UNIT_KEY_PREFIX = 'usage:unit:';
export const WINDOWS = [['today', 1], ['week', 7], ['month', 30]];
export const MAX_WINDOW_DAYS = 30;
// The heatmap shows a year, so the index keeps a year of per-day counts; windows still use the spans above.
export const HISTORY_DAYS = 365;
const ROW_LIMIT = 30;
const SPEED_ROW_LIMIT = 10;
// Per day, provider and model: requests, fresh input, output, cache read, cache write, then speed samples:
// requests that had a per-request TPS, the sum of those TPS values, and how many were session-log estimates.
const COUNTERS = 8;
const SPEED_AT = 5;
// Units stored with an older schema keep their totals for display but are read again to fill the speed counters.
export const USAGE_SCHEMA = 2;
export const SPEED_MIN_SAMPLES = 5;

/** Local calendar day as YYYY-MM-DD. */
export function localDayKey(ms) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Local day key `daysAgo` before the day containing `nowMs`. */
export function dayKeyAgo(nowMs, daysAgo) {
  const date = new Date(nowMs);
  return localDayKey(new Date(date.getFullYear(), date.getMonth(), date.getDate() - daysAgo).getTime());
}

/** Oldest local midnight the index keeps; files last written before this cannot contribute. */
export function usageCutoffMs(nowMs) {
  const date = new Date(nowMs);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - (HISTORY_DAYS - 1)).getTime();
}

/** Adds one source's records into `days[day][provider][model] = [requests, fresh, output, cacheRead, cacheWrite]`. */
export function accumulateRecords(days, provider, records, { minDay = '' } = {}) {
  for (const record of records) {
    if (!Number.isFinite(record?.completedAt)) continue;
    const day = localDayKey(record.completedAt);
    if (day < minDay) continue;
    const model = typeof record.model === 'string' && record.model ? record.model.slice(0, 128) : '';
    const byModel = (days[day] ??= {})[provider] ??= {};
    const cell = byModel[model] ??= new Array(COUNTERS).fill(0);
    cell[0] += 1;
    cell[1] += numberOr0(record.freshInputTokens);
    cell[2] += numberOr0(record.outputTokens);
    cell[3] += numberOr0(record.cacheReadTokens);
    cell[4] += numberOr0(record.cacheCreationTokens);
    const speed = record.tokensPerSecond;
    if (Number.isFinite(speed) && speed > 0) {
      cell[SPEED_AT] += 1;
      cell[SPEED_AT + 1] += speed;
      if (record.isEstimatedSpeed) cell[SPEED_AT + 2] += 1;
    }
  }
  return days;
}

const numberOr0 = value => Number.isFinite(value) && value > 0 ? value : 0;

/** CC Switch's "real total": new input + output + cache writes + cache reads. */
export function realTokens(counters) {
  return counters.freshInput + counters.output + counters.cacheWrite + counters.cacheRead;
}

/** CC Switch's hit rate: cache reads over every input-side token. */
export function cacheHitRate(counters) {
  const cacheable = counters.freshInput + counters.cacheWrite + counters.cacheRead;
  return cacheable > 0 ? counters.cacheRead / cacheable : 0;
}

/** Totals per window, using the same real-total and hit-rate definitions as CC Switch's usage summary. */
export function summarizeUsage(dayMaps, nowMs) {
  const today = localDayKey(nowMs), windows = {};
  for (const [name, span] of WINDOWS) {
    const first = dayKeyAgo(nowMs, span - 1);
    const totals = { requests: 0, freshInput: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const rows = new Map(), speeds = new Map();
    for (const days of dayMaps) {
      for (const [day, byProvider] of Object.entries(days)) {
        if (day < first || day > today) continue;
        for (const [provider, byModel] of Object.entries(byProvider)) {
          for (const [model, cell] of Object.entries(byModel)) {
            addCounters(totals, cell);
            const key = `${provider}\u0000${model}`;
            const row = rows.get(key) ?? { provider, model, requests: 0, freshInput: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
            addCounters(row, cell);
            rows.set(key, row);
            if (model) addSpeed(speeds, provider, model, cell);
          }
        }
      }
    }
    const list = [...rows.values()].map(row => ({ ...row, tokens: realTokens(row) }))
      .sort((a, b) => b.tokens - a.tokens || b.requests - a.requests);
    const speed = rankSpeeds(speeds);
    windows[name] = {
      ...totals,
      tokens: realTokens(totals),
      cacheHitRate: cacheHitRate(totals),
      rows: list.slice(0, ROW_LIMIT),
      hiddenRows: Math.max(0, list.length - ROW_LIMIT),
      speeds: speed.speeds,
      speedHidden: speed.hidden,
      speedSparse: speed.sparse
    };
  }
  return windows;
}

/** Speed samples for one model, merged across agents; a cell without speed counters (older schema) adds nothing. */
function addSpeed(speeds, provider, model, cell) {
  const samples = cell[SPEED_AT] ?? 0;
  if (!samples) return;
  const entry = speeds.get(model) ?? { model, samples: 0, sum: 0, estimated: 0, providers: new Set() };
  entry.samples += samples;
  entry.sum += cell[SPEED_AT + 1] ?? 0;
  entry.estimated += cell[SPEED_AT + 2] ?? 0;
  entry.providers.add(provider);
  speeds.set(model, entry);
}

/** Models ranked by mean per-request TPS, fastest first; models with too few samples are counted, not ranked. */
function rankSpeeds(speeds) {
  const ranked = [];
  let sparse = 0;
  for (const entry of speeds.values()) {
    if (entry.samples < SPEED_MIN_SAMPLES) { sparse += 1; continue; }
    ranked.push({
      model: entry.model,
      tokensPerSecond: entry.sum / entry.samples,
      samples: entry.samples,
      // Shown with ≈ when most of the samples are session-log estimates.
      estimated: entry.estimated * 2 >= entry.samples,
      providers: [...entry.providers].sort()
    });
  }
  ranked.sort((a, b) => b.tokensPerSecond - a.tokensPerSecond || b.samples - a.samples || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
  return { speeds: ranked.slice(0, SPEED_ROW_LIMIT), hidden: Math.max(0, ranked.length - SPEED_ROW_LIMIT), sparse };
}

/** One entry per local day that has usage in the last HISTORY_DAYS, oldest first; drives the heatmap. */
export function dailySeries(dayMaps, nowMs) {
  const first = dayKeyAgo(nowMs, HISTORY_DAYS - 1), today = localDayKey(nowMs), perDay = new Map();
  for (const days of dayMaps) {
    for (const [day, byProvider] of Object.entries(days)) {
      if (day < first || day > today) continue;
      const cell = perDay.get(day) ?? { requests: 0, freshInput: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      for (const byModel of Object.values(byProvider)) {
        for (const counters of Object.values(byModel)) addCounters(cell, counters);
      }
      perDay.set(day, cell);
    }
  }
  return [...perDay.entries()]
    .map(([day, cell]) => ({ day, tokens: realTokens(cell), requests: cell.requests }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

function addCounters(target, cell) {
  target.requests += cell[0];
  target.freshInput += cell[1];
  target.output += cell[2];
  target.cacheRead += cell[3];
  target.cacheWrite += cell[4];
}

const validUnit = value => value && typeof value === 'object' && typeof value.stamp === 'string' && value.days && typeof value.days === 'object';

/**
 * Incremental index. `discover(cutoffMs)` returns unit descriptors:
 * { key, stamp, bytes, mtimeMs, read: async () => days }. Changed units are read newest first until the byte
 * budget for this pass is spent; the first unit always goes through so one large file cannot starve the rest.
 */
const LARGE_UNIT_BYTES = 64 * 1024 * 1024, LARGE_UNIT_INTERVAL_MS = 10 * 60_000;
const RETRY_MIN_MS = 15_000, RETRY_MAX_MS = 10 * 60_000;

export function createUsageIndex({ storage, discover, now = () => Date.now(), budgetBytes = 2 * 1024 * 1024 * 1024, log = () => {} }) {
  const units = new Map();
  let loaded = null, progress = { done: 0, total: 0 }, updatedAt = null;

  async function load() {
    const keys = (await storage.keys()).filter(key => key.startsWith(UNIT_KEY_PREFIX));
    for (const key of keys) {
      const value = await storage.get(key);
      if (validUnit(value)) units.set(key.slice(UNIT_KEY_PREFIX.length), value);
    }
  }

  // Persisted units are loaded once, before the first summary or refresh can read them.
  const ready = () => {
    loaded ??= load().catch(error => { log(`统计索引读取失败：${error?.message ?? 'unknown'}`); });
    return loaded;
  };

  async function refresh() {
    await ready();
    const descriptors = await discover(usageCutoffMs(now()));
    const wanted = new Set(descriptors.map(descriptor => descriptor.key));
    for (const key of [...units.keys()]) {
      if (wanted.has(key)) continue;
      units.delete(key);
      await storage.delete(UNIT_KEY_PREFIX + key).catch(() => {});
    }
    // A large file that is still being written is re-read at most every LARGE_UNIT_INTERVAL_MS; until then the
    // last read stays in effect and counts as up to date.
    const deferred = descriptor => {
      const current = units.get(descriptor.key);
      return current !== undefined && !current.failed && current.stamp !== descriptor.stamp && descriptor.bytes > LARGE_UNIT_BYTES
        && now() - (current.readAt ?? 0) < LARGE_UNIT_INTERVAL_MS;
    };
    const needsRead = descriptor => {
      const current = units.get(descriptor.key);
      return !current || current.failed || current.stamp !== descriptor.stamp || current.schema !== USAGE_SCHEMA;
    };
    const waitingRetry = descriptor => {
      const current = units.get(descriptor.key);
      return current?.failed && current.failedStamp === descriptor.stamp && now() < current.retryAt;
    };
    const pending = descriptors.filter(descriptor => needsRead(descriptor) && !deferred(descriptor) && !waitingRetry(descriptor))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    let spent = 0, processed = 0;
    for (const descriptor of pending) {
      if (processed > 0 && spent + descriptor.bytes > budgetBytes) break;
      spent += descriptor.bytes;
      processed += 1;
      let unit;
      try {
        unit = { stamp: descriptor.stamp, days: await descriptor.read(), readAt: now(), schema: USAGE_SCHEMA };
      } catch (error) {
        // Keep the last successful counts and retry even when a transient failure leaves the file unchanged.
        // Persist the retry deadline as well, so a worker restart cannot turn the failure into an empty success.
        const current = units.get(descriptor.key);
        const failures = current?.failedStamp === descriptor.stamp ? Math.min((current.failures ?? 0) + 1, 7) : 1;
        unit = {
          ...current, stamp: current?.stamp ?? '', days: current?.days ?? {},
          failed: true, failedStamp: descriptor.stamp, failures,
          retryAt: now() + Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** (failures - 1))
        };
        log(`统计读取失败（${error?.code ?? error?.message ?? 'unknown'}）`);
      }
      units.set(descriptor.key, unit);
      try { await storage.set(UNIT_KEY_PREFIX + descriptor.key, unit); }
      catch (error) { log(`统计索引写入失败：${error?.message ?? 'unknown'}`); }
    }
    progress = {
      done: descriptors.filter(descriptor => !needsRead(descriptor) || deferred(descriptor)).length,
      total: descriptors.length
    };
    updatedAt = now();
    return { pending: progress.total - progress.done };
  }

  function summary() {
    const nowMs = now(), dayMaps = [...units.values()].map(unit => unit.days);
    return { updatedAt, progress, windows: summarizeUsage(dayMaps, nowMs), daily: dailySeries(dayMaps, nowMs) };
  }

  return { refresh, summary, ready };
}

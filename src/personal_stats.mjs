import { createHash } from 'node:crypto';
import { HOUR_MS, MAX_RECENT_REQUESTS, leaderboardDay, requestTokens, usageCount, validStatsLabel } from './leaderboard_stats.mjs';

export const HISTORY_DAYS = 365;
export const WINDOWS = [['today', 1], ['week', 7], ['month', 30], ['year', HISTORY_DAYS]];
export const ROW_LIMIT = 30;
const SPEED_ROW_LIMIT = 10;
// Per day, provider and model: requests, fresh input, output, cache read, cache write, then speed samples:
// requests that had a per-request TPS, the sum of those TPS values, and how many were session-log estimates.
export const COUNTERS = 8;
export const SPEED_AT = 5;
// Units stored with an older schema keep their totals for display but are read again to fill the speed counters.
export const SPEED_MIN_SAMPLES = 5;

const dayMs = 24 * HOUR_MS;

export const RETENTION_DAYS = 370;

export function calendarFor(timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', minute: '2-digit', second: '2-digit'
  });
  return {
    timeZone: formatter.resolvedOptions().timeZone,
    day(at) {
      const { year, month, day } = Object.fromEntries(formatter.formatToParts(at).map(({ type, value }) => [type, value]));
      return `${year}-${month}-${day}`;
    },
    dayAgo(at, days) {
      return new Date(Date.parse(this.day(at) + 'T00:00:00Z') - days * dayMs).toISOString().slice(0, 10);
    },
    hour(at) {
      const { minute, second } = Object.fromEntries(formatter.formatToParts(at).map(({ type, value }) => [type, value]));
      return at - Number(minute) * 60_000 - Number(second) * 1000 - at % 1000;
    }
  };
}

export function makePersonalPacket(db, publishedAt) {
  const calendar = db.calendar;
  const oldest = calendar.dayAgo(publishedAt, RETENTION_DAYS - 1);
  const maxima = new Map();
  for (const row of db.details(publishedAt - 3 * dayMs)) {
    const speed = row.tokensPerSecond;
    if (!(Number.isFinite(speed) && speed > 0)) continue;
    const hour = calendar.hour(row.completedAt);
    const previous = maxima.get(hour);
    if (!previous || speed > previous.tokensPerSecond ||
        (speed === previous.tokensPerSecond && previous.estimated && !row.isEstimatedSpeed)) {
      maxima.set(hour, { hour, day: calendar.day(row.completedAt), tokensPerSecond: speed, estimated: !!row.isEstimatedSpeed });
    }
  }
  return { deviceGuid: db.deviceGuid, publishedAt, timeZone: calendar.timeZone,
    days: db.buckets(0, oldest), hours: db.buckets(1, oldest), maxima: [...maxima.values()] };
}

function group(rows) {
  const byProvider = Object.create(null);
  for (const { provider, model, counters } of rows) {
    const byModel = byProvider[provider] ??= Object.create(null);
    const cell = byModel[model] ??= Array(8).fill(0);
    for (let i = 0; i < cell.length; i++) cell[i] += counters[i];
  }
  return byProvider;
}

export function mergePersonalPackets(packets, timeZone, now = Date.now()) {
  const sources = new Map();
  for (const packet of packets) {
    if (packet.timeZone !== timeZone || (sources.get(packet.deviceGuid)?.publishedAt ?? -1) >= packet.publishedAt) continue;
    sources.set(packet.deviceGuid, packet);
  }
  if (!sources.size) return null;
  const calendar = calendarFor(timeZone);
  const today = calendar.day(now), cutoffAt = calendar.hour(now);
  const days = [], hours = [], maxima = [];
  let updatedAt = Infinity;
  for (const packet of sources.values()) {
    for (const row of packet.days) days.push(row);
    for (const row of packet.hours) hours.push(row);
    for (const row of packet.maxima) maxima.push(row);
    updatedAt = Math.min(updatedAt, packet.publishedAt);
  }
  const ranges = [...WINDOWS, ['past365', 365]];
  const natural = Object.fromEntries(ranges.map(([key, span]) => {
    const from = key === 'year' ? today.slice(0, 4) + '-01-01' : calendar.dayAgo(now, span - 1);
    return [key, summarizeGroups([group(days.filter(row => row.day >= from && row.day <= today))])];
  }));
  const hourly = Object.fromEntries(WINDOWS.map(([key, span]) => [
    key, summarizeGroups([group(hours.filter(row => row.at >= cutoffAt - span * dayMs && row.at < cutoffAt))])
  ]));
  hourly.past365 = hourly.year;
  const fastest = rows => rows.sort((a, b) => b.tokensPerSecond - a.tokensPerSecond || Number(a.estimated) - Number(b.estimated))[0] ?? null;
  natural.today.maxSpeed = fastest(maxima.filter(row => row.day === today));
  hourly.today.maxSpeed = fastest(maxima.filter(row => row.hour >= cutoffAt - dayMs && row.hour < cutoffAt));
  const dayTotals = new Map();
  const firstDay = calendar.dayAgo(now, 364);
  for (const { day, counters } of days) {
    if (day < firstDay || day > today) continue;
    const total = dayTotals.get(day) ?? { day, tokens: 0, requests: 0 };
    total.requests += counters[0];
    total.tokens += counters[1] + counters[2] + counters[3] + counters[4];
    dayTotals.set(day, total);
  }
  return { updatedAt, timeZone, progress: { done: sources.size, total: sources.size }, windows: natural,
    daily: [...dayTotals.values()].sort((a, b) => a.day.localeCompare(b.day)),
    hourly: { cutoffAt, ready: true, historyDays: RETENTION_DAYS, windows: hourly } };
}

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

export function localHourStart(ms) {
  const date = new Date(ms);
  const start = ms - date.getMinutes() * 60_000 - date.getSeconds() * 1000 - date.getMilliseconds();
  // A half-hour clock change can put the candidate between two real local hour boundaries.
  return start - new Date(start).getMinutes() * 60_000;
}

/** Oldest local midnight the index keeps; files last written before this cannot contribute. */
export function usageCutoffMs(nowMs) {
  const date = new Date(nowMs);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - (HISTORY_DAYS - 1)).getTime();
}

/** Adds one source's records into `days[day][provider][model] = [requests, fresh, output, cacheRead, cacheWrite]`. */
export function accumulateRecords(days, sourceProvider, records, { minDay = '', leaderboardDays } = {}) {
  for (const record of records) {
    if (!Number.isFinite(record?.completedAt)) continue;
    const provider = sourceProvider ?? record.provider;
    if (leaderboardDays?.records && record.completedAt >= leaderboardDays.recordFrom) {
      leaderboardDays.records.push({ ...record, provider });
    }
    const day = localDayKey(record.completedAt);
    if (day < minDay) continue;
    if (leaderboardDays?.recent && record.completedAt >= leaderboardDays.recentFrom && typeof record.id === 'string') {
      const tokens = requestTokens(record);
      if (Number.isSafeInteger(tokens)) {
        const id = createHash('sha256').update(record.id).digest('hex').slice(0, 24);
        const model = typeof record.model === 'string' ? record.model.slice(0, 128) : null;
        leaderboardDays.recent.push([id, record.completedAt, tokens, usageCount(record.tokensPerSecond) || null,
          validStatsLabel(model) ? model : null, provider === 'opencode2' ? 'opencode' : provider]);
        if (leaderboardDays.recent.length >= 2 * MAX_RECENT_REQUESTS) trimRecentRequests(leaderboardDays.recent);
      }
    }
    if (leaderboardDays && record.completedAt >= leaderboardDays.start && record.completedAt < leaderboardDays.end) {
      const tokens = requestTokens(record);
      const day = leaderboardDay(record.completedAt), { totals } = leaderboardDays;
      totals[day] = (totals[day] ?? 0) + tokens;
    }
    if (leaderboardDays?.usageByTime && record.completedAt >= leaderboardDays.usageTimesFrom && record.completedAt < leaderboardDays.end) {
      const at = Math.trunc(record.completedAt);
      const total = (leaderboardDays.usageByTime[at] ?? 0) + requestTokens(record);
      if (Number.isSafeInteger(total)) leaderboardDays.usageByTime[at] = total;
    }
    countRequest(days[day] ??= Object.create(null), provider, record);
  }
  return days;
}

function countRequest(byProvider, provider, record) {
  const model = typeof record.model === 'string' && record.model ? record.model.slice(0, 128) : '';
  const byModel = byProvider[provider] ??= Object.create(null);
  const cell = byModel[model] ??= new Array(COUNTERS).fill(0);
  cell[0] += 1;
  cell[1] += usageCount(record.freshInputTokens);
  cell[2] += usageCount(record.outputTokens);
  cell[3] += usageCount(record.cacheReadTokens);
  cell[4] += usageCount(record.cacheCreationTokens);
  const speed = usageCount(record.tokensPerSecond);
  if (speed > 0) {
    cell[SPEED_AT] += 1;
    cell[SPEED_AT + 1] += speed;
    if (record.isEstimatedSpeed) cell[SPEED_AT + 2] += 1;
  }
}

export function trimRecentRequests(requests) {
  requests.sort((a, b) => b[1] - a[1]);
  if (requests.length > MAX_RECENT_REQUESTS) requests.length = MAX_RECENT_REQUESTS;
  return requests;
}

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
  const today = localDayKey(nowMs);
  const days = dayMaps.flatMap(map => Object.entries(map));
  return Object.fromEntries(WINDOWS.map(([name, span]) => {
    const first = dayKeyAgo(nowMs, span - 1);
    const groups = days.filter(([day]) => day >= first && day <= today).map(([, byProvider]) => byProvider);
    return [name, summarizeGroups(groups)];
  }));
}

export function summarizeHourlyUsage(records, cutoffAt) {
  const segments = WINDOWS.map(([name, span]) => ({ name, start: cutoffAt - span * 24 * HOUR_MS, group: Object.create(null) }));
  let fastest = null;
  for (const record of records) {
    if (record.completedAt >= cutoffAt) continue;
    const segment = segments.find(({ start }) => record.completedAt >= start);
    if (!segment) continue;
    countRequest(segment.group, record.provider, record);
    if (segment.name === 'today') fastest = fasterRequest(fastest, record);
  }
  const groups = [];
  return Object.fromEntries(segments.map(({ name, group }) => {
    groups.push(group);
    const summary = summarizeGroups(groups);
    if (name === 'today') summary.maxSpeed = fastest;
    return [name, summary];
  }));
}

function fasterRequest(fastest, { tokensPerSecond, isEstimatedSpeed: estimated }) {
  if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return fastest;
  if (!fastest || tokensPerSecond > fastest.tokensPerSecond ||
      (tokensPerSecond === fastest.tokensPerSecond && fastest.estimated && !estimated)) {
    return { tokensPerSecond, estimated: estimated === true };
  }
  return fastest;
}

export function maxRequestSpeed(records) {
  let fastest = null;
  for (const record of records) fastest = fasterRequest(fastest, record);
  return fastest;
}

export function summarizeGroups(groups) {
  const totals = { requests: 0, freshInput: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const rows = new Map(), speeds = new Map();
  for (const byProvider of groups) {
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
  const list = [...rows.values()].map(row => ({ ...row, tokens: realTokens(row) }))
    .sort((a, b) => b.tokens - a.tokens || b.requests - a.requests);
  const speed = rankSpeeds(speeds);
  return {
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

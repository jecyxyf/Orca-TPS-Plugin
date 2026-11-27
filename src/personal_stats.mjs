import { HOUR_MS, USAGE_COUNTER, usageCounterTokens } from './leaderboard_stats.mjs';

const WINDOWS = [['today', 1], ['week', 7], ['month', 30], ['year', 365]];
const ROW_LIMIT = 30;
const SPEED_ROW_LIMIT = 10;
// A model needs this many timed requests in a window before it is ranked by speed.
const SPEED_MIN_SAMPLES = 5;

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
    total.requests += counters[USAGE_COUNTER.requests];
    total.tokens += usageCounterTokens(counters);
    dayTotals.set(day, total);
  }
  return { updatedAt, timeZone, progress: { done: sources.size, total: sources.size }, windows: natural,
    daily: [...dayTotals.values()].sort((a, b) => a.day.localeCompare(b.day)),
    hourly: { cutoffAt, ready: true, historyDays: RETENTION_DAYS, windows: hourly } };
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
  const samples = cell[USAGE_COUNTER.speedSamples] ?? 0;
  if (!samples) return;
  const entry = speeds.get(model) ?? { model, samples: 0, sum: 0, estimated: 0, providers: new Set() };
  entry.samples += samples;
  entry.sum += cell[USAGE_COUNTER.speedSum] ?? 0;
  entry.estimated += cell[USAGE_COUNTER.estimatedSpeedSamples] ?? 0;
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

function addCounters(target, cell) {
  target.requests += cell[USAGE_COUNTER.requests];
  target.freshInput += cell[USAGE_COUNTER.freshInput];
  target.output += cell[USAGE_COUNTER.output];
  target.cacheRead += cell[USAGE_COUNTER.cacheRead];
  target.cacheWrite += cell[USAGE_COUNTER.cacheWrite];
}

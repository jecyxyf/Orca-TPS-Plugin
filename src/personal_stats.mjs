import { HOUR_MS, USAGE_COUNTER, usageCounterTokens } from './leaderboard_stats.mjs';

export const HISTORY_DAYS = 365;
export const RETENTION_DAYS = 370;
export const WINDOWS = [['today', 1], ['week', 7], ['month', 30], ['year', HISTORY_DAYS]];
export const ROW_LIMIT = 30;
export const SPEED_MIN_SAMPLES = 5;
const SPEED_ROW_LIMIT = 10;
const dayMs = 24 * HOUR_MS;

export function calendarFor(timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const parts = at => Object.fromEntries(formatter.formatToParts(at).map(({ type, value }) => [type, value]));
  return {
    timeZone: formatter.resolvedOptions().timeZone,
    day(at) { const { year, month, day } = parts(at); return `${year}-${month}-${day}`; },
    dayAgo(at, days) { return new Date(Date.parse(this.day(at) + 'T00:00:00Z') - days * dayMs).toISOString().slice(0, 10); },
    hour(at) { const { minute, second } = parts(at); return at - Number(minute) * 60_000 - Number(second) * 1000 - at % 1000; }
  };
}

export function makePersonalPacket(db, publishedAt) {
  const calendar = db.calendar, oldest = calendar.dayAgo(publishedAt, RETENTION_DAYS - 1), maxima = new Map();
  const rows = db.iterateDetails ? db.iterateDetails(publishedAt - 3 * dayMs) : db.details(publishedAt - 3 * dayMs);
  for (const row of rows) {
    const speed = row.tokensPerSecond;
    if (!(Number.isFinite(speed) && speed > 0)) continue;
    const hour = calendar.hour(row.completedAt), prev = maxima.get(hour);
    if (!prev || speed > prev.tokensPerSecond || (speed === prev.tokensPerSecond && prev.estimated && !row.isEstimatedSpeed)) {
      maxima.set(hour, { hour, day: calendar.day(row.completedAt), tokensPerSecond: speed, estimated: !!row.isEstimatedSpeed });
    }
  }
  return {
    deviceGuid: db.deviceGuid, publishedAt, timeZone: calendar.timeZone,
    days: db.buckets(0, oldest), hours: db.buckets(1, oldest), maxima: [...maxima.values()]
  };
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
    if (packet.timeZone === timeZone && (sources.get(packet.deviceGuid)?.publishedAt ?? -1) < packet.publishedAt) {
      sources.set(packet.deviceGuid, packet);
    }
  }
  if (!sources.size) return null;
  const calendar = calendarFor(timeZone), today = calendar.day(now), cutoffAt = calendar.hour(now);
  const days = [], hours = [], maxima = [];
  let updatedAt = Infinity;
  for (const packet of sources.values()) {
    days.push(...packet.days); hours.push(...packet.hours); maxima.push(...packet.maxima);
    updatedAt = Math.min(updatedAt, packet.publishedAt);
  }
  const natural = Object.fromEntries([...WINDOWS, ['past365', 365]].map(([key, span]) => {
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
  const dayTotals = new Map(), firstDay = calendar.dayAgo(now, 364);
  for (const { day, counters } of days) {
    if (day < firstDay || day > today) continue;
    const total = dayTotals.get(day) ?? { day, tokens: 0, requests: 0 };
    total.requests += counters[USAGE_COUNTER.requests];
    total.tokens += usageCounterTokens(counters);
    dayTotals.set(day, total);
  }
  return {
    updatedAt, timeZone, progress: { done: sources.size, total: sources.size }, windows: natural,
    daily: [...dayTotals.values()].sort((a, b) => a.day.localeCompare(b.day)),
    hourly: { cutoffAt, ready: true, historyDays: RETENTION_DAYS, windows: hourly }
  };
}

export const realTokens = c => c.freshInput + c.output + c.cacheWrite + c.cacheRead;
export const cacheHitRate = c => { const n = c.freshInput + c.cacheWrite + c.cacheRead; return n > 0 ? c.cacheRead / n : 0; };

function addCounters(target, cell) {
  target.requests += cell[USAGE_COUNTER.requests];
  target.freshInput += cell[USAGE_COUNTER.freshInput];
  target.output += cell[USAGE_COUNTER.output];
  target.cacheRead += cell[USAGE_COUNTER.cacheRead];
  target.cacheWrite += cell[USAGE_COUNTER.cacheWrite];
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
        const samples = cell[USAGE_COUNTER.speedSamples] ?? 0;
        if (model && samples) {
          const entry = speeds.get(model) ?? { model, samples: 0, sum: 0, estimated: 0, providers: new Set() };
          entry.samples += samples; entry.sum += cell[USAGE_COUNTER.speedSum] ?? 0;
          entry.estimated += cell[USAGE_COUNTER.estimatedSpeedSamples] ?? 0; entry.providers.add(provider);
          speeds.set(model, entry);
        }
      }
    }
  }
  const list = [...rows.values()].map(row => ({ ...row, tokens: realTokens(row) }))
    .sort((a, b) => b.tokens - a.tokens || b.requests - a.requests);
  const ranked = [];
  let sparse = 0;
  for (const e of speeds.values()) {
    if (e.samples < SPEED_MIN_SAMPLES) { sparse++; continue; }
    ranked.push({
      model: e.model, tokensPerSecond: e.sum / e.samples, samples: e.samples,
      estimated: e.estimated * 2 >= e.samples, providers: [...e.providers].sort()
    });
  }
  ranked.sort((a, b) => b.tokensPerSecond - a.tokensPerSecond || b.samples - a.samples || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
  return {
    ...totals, tokens: realTokens(totals), cacheHitRate: cacheHitRate(totals),
    rows: list.slice(0, ROW_LIMIT), hiddenRows: Math.max(0, list.length - ROW_LIMIT),
    speeds: ranked.slice(0, SPEED_ROW_LIMIT), speedHidden: Math.max(0, ranked.length - SPEED_ROW_LIMIT), speedSparse: sparse
  };
}

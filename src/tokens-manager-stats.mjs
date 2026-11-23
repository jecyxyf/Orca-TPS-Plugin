import { createHash } from 'node:crypto';
import { calendarFor, RETENTION_DAYS } from './tokens-manager-db.mjs';
import { HOUR_MS, MAX_RECENT_REQUESTS, hourStart, validStatsLabel } from './leaderboard-stats.mjs';
import { requestTokens, summarizeGroups, WINDOWS } from './usage-summary.mjs';

const dayMs = 24 * HOUR_MS;
const label = value => validStatsLabel(value) ? value : null;
const add = (map, key, amount) => map.set(key, (map.get(key) ?? 0) + amount);

export const TOKENS_DEFAULT_INTERVALS = Object.freeze({
  scanMs: 5000, personalMs: 5000, uploadMs: 5000, publishMs: 5000, readMs: 5000
});
export const TOKENS_LEADERBOARD = '/api/tokens-manager';
export const TOKENS_PACKET_TTL_MS = 10_000;

export function tokensIntervals(input, previous = TOKENS_DEFAULT_INTERVALS) {
  return Object.fromEntries(Object.entries(TOKENS_DEFAULT_INTERVALS).map(([key, fallback]) => {
    const value = input?.[key];
    const max = key === 'uploadMs' ? 7500 : 3600_000;
    return [key, Number.isSafeInteger(value) && value >= 1000 && value <= max ? value : previous[key] ?? fallback];
  }));
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
  const hourly = Object.fromEntries(ranges.map(([key, span]) => [
    key, summarizeGroups([group(hours.filter(row => row.at >= cutoffAt - span * dayMs && row.at < cutoffAt))])
  ]));
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

export function makeLeaderboardPacket(db, accountId, publishedAt) {
  const hourTotals = new Map(), daily = new Map(), samples = [];
  const firstHour = hourStart(publishedAt) - 720 * HOUR_MS;
  const recentFrom = publishedAt - dayMs;
  for (const row of db.details(firstHour)) {
    if (row.completedAt > publishedAt) continue;
    const tokens = requestTokens(row), hour = hourStart(row.completedAt);
    if (!Number.isSafeInteger(tokens) || tokens < 0) continue;
    add(hourTotals, hour, tokens);
    add(daily, db.calendar.day(row.completedAt), tokens);
    if (row.completedAt >= recentFrom && samples.length < MAX_RECENT_REQUESTS) {
      const id = createHash('sha256').update(JSON.stringify([row.provider, row.sessionId, row.id])).digest('hex').slice(0, 24);
      samples.push([id, row.completedAt, tokens, row.tokensPerSecond > 0 ? row.tokensPerSecond : null,
        label(row.model), label(row.provider)]);
    }
  }
  const hours = [...hourTotals].sort((a, b) => a[0] - b[0]);
  return { deviceGuid: db.deviceGuid, accountId, publishedAt, timeZone: db.calendar.timeZone, hours, daily: [...daily].sort(), samples };
}

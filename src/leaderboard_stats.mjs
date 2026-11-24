import { createHash } from 'node:crypto';

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function validInstallationId(value) {
  return typeof value === 'string' && value.length === 36 && uuidV4.test(value);
}
export const RECENT_STATS_MS = 5 * 60_000;
export const HOUR_MS = 3_600_000;
export const RANKING_HOURS = [24, 168, 720];
export const RANKING_REFRESH_MS = 10_000;
export const USAGE_UPLOAD_BYTES = 64 * 1024;
export const SPEED_WINDOW_MS = 24 * HOUR_MS;
export const SPEED_SAMPLE_WINDOW_MS = SPEED_WINDOW_MS + HOUR_MS;
export const SPEED_MIN_DELTA = 500;
export const LEADERBOARD_DEVICE_LIMIT = 4;
export const hourStart = time => Math.floor(time / HOUR_MS) * HOUR_MS;
export const isHourStart = time => Number.isSafeInteger(time) && time >= 0 && time % HOUR_MS === 0;
export const isUsageTime = time => Number.isSafeInteger(time) && time >= 0 && time < 8_640_000_000_000_000;
export const MAX_RECENT_REQUESTS = 4096;

export function qualifyingSpeed({ deltaTokens, avgTps } = {}) {
  return deltaTokens > SPEED_MIN_DELTA && Number.isFinite(avgTps) && avgTps > 0;
}

export function validStatsLabel(value) {
  return value === null || (typeof value === 'string' && value.length > 0 && value.length <= 128 &&
    !/[\u0000-\u001f\u007f]/.test(value));
}

export function validStatsPoint({ deltaTokens, avgTps } = {}) {
  return Number.isSafeInteger(deltaTokens) && deltaTokens >= 0 &&
    (avgTps === null || (Number.isFinite(avgTps) && avgTps >= 0));
}

export function validSubmissionStats(stats) {
  return Boolean(stats && typeof stats === 'object' && !Array.isArray(stats) && validStatsPoint(stats) &&
    validStatsLabel(stats.topModel) && validStatsLabel(stats.topCli));
}

export function validRecentRequest(row) {
  return Array.isArray(row) && row.length === 6 && typeof row[0] === 'string' && row[0].length === 24 &&
    Number.isSafeInteger(row[1]) && Number.isSafeInteger(row[2]) && row[2] >= 0 &&
    (row[3] === null || (Number.isFinite(row[3]) && row[3] > 0)) && validStatsLabel(row[4]) && validStatsLabel(row[5]);
}

// Settings shared by Orca, the Tokens manager, and the leaderboard server.
export const TOKENS_DEFAULT_INTERVALS = Object.freeze({
  scanMs: 5000, personalMs: 5000, uploadMs: 5000, publishMs: 5000, readMs: 5000
});
export const TOKENS_LEADERBOARD = '/api/tokens-manager';

export function tokensIntervals(input, previous = TOKENS_DEFAULT_INTERVALS) {
  return Object.fromEntries(Object.entries(TOKENS_DEFAULT_INTERVALS).map(([key, fallback]) => {
    const value = input?.[key];
    const max = key === 'uploadMs' ? 7500 : 3600_000;
    return [key, Number.isSafeInteger(value) && value >= 1000 && value <= max ? value : previous[key] ?? fallback];
  }));
}

export const usageCount = value => Number.isFinite(value) && value > 0 ? value : 0;

export function requestTokens(record) {
  return usageCount(record.freshInputTokens) + usageCount(record.outputTokens) +
    usageCount(record.cacheReadTokens) + usageCount(record.cacheCreationTokens);
}

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
export const leaderboardDay = ms => new Date(ms + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
export const leaderboardDayStart = day => Date.parse(`${day}T00:00:00+08:00`);
export const leaderboardUsageTimesFrom = day => leaderboardDayStart(day) - 24 * HOUR_MS;

export function validLeaderboardUsageTimes(usage, from, end = Infinity) {
  return usage && typeof usage === 'object' && !Array.isArray(usage) && Object.entries(usage).every(([key, tokens]) => {
    const at = Number(key);
    return String(at) === key && isUsageTime(at) && at >= from && at < end && Number.isSafeInteger(tokens) && tokens >= 0;
  });
}

const label = value => validStatsLabel(value) ? value : null;
const add = (map, key, amount) => map.set(key, (map.get(key) ?? 0) + amount);

export function makeLeaderboardPacket(db, accountId, publishedAt) {
  const hourTotals = new Map(), daily = new Map(), samples = [];
  const firstHour = hourStart(publishedAt) - 720 * HOUR_MS;
  const recentFrom = publishedAt - SPEED_SAMPLE_WINDOW_MS;
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

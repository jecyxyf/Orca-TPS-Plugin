export const RECENT_STATS_MS = 5 * 60_000;
export const HOUR_MS = 3_600_000;
export const RANKING_HOURS = [24, 168, 720];
export const SPEED_WINDOW_MS = 24 * HOUR_MS;
export const SPEED_MIN_DELTA = 500;
export const hourStart = time => Math.floor(time / HOUR_MS) * HOUR_MS;
export const isHourStart = time => Number.isSafeInteger(time) && time >= 0 && time % HOUR_MS === 0;
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

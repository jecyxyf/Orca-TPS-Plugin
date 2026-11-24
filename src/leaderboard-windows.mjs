import { gzipSync, gunzipSync } from 'node:zlib';
import { HOUR_MS, RANKING_HOURS, RANKING_REFRESH_MS, SPEED_MIN_DELTA, isUsageTime, leaderboardDay,
  leaderboardDayStart, validStatsLabel } from './leaderboard_stats.mjs';

const dayMs = 24 * HOUR_MS;
const validTime = value => Number.isSafeInteger(value) && value >= 0 && value < 8_640_000_000_000_000;
const validUsername = value => typeof value === 'string' && value.length > 0 && value.length <= 39;
const validTokens = value => Number.isInteger(value) && value >= 0 && value <= 720 * Number.MAX_SAFE_INTEGER;
const validRows = rows => Array.isArray(rows) && rows.length <= 100 && rows.every((row, index) =>
  row && validUsername(row.username) && row.rank === index + 1 && validTime(row.submittedAt));
const unavailable = reply => ['not_found', 'login_required', 'server_update_required'].includes(reply.code)
  ? 'server_update_required' : 'unavailable';

function validWindow(board, hours, cutoffAt, nextAt, midnight) {
  const windowStart = midnight === undefined ? cutoffAt - hours * HOUR_MS : midnight - (hours / 24 - 1) * dayMs;
  return board?.hours === hours && board.cutoffAt === cutoffAt && board.nextAt === nextAt &&
    board.windowStart === windowStart && validRows(board.rows) && board.rows.every(row =>
      validTokens(row.tokens) && typeof row.complete === 'boolean' &&
      (row.lastUploadAt === null || validTime(row.lastUploadAt)) && (hours === 24 ||
        (Array.isArray(row.daily) && row.daily.length === hours / 24 && row.daily.every((point, index) =>
          point?.at === board.windowStart + index * 24 * HOUR_MS && validTokens(point.tokens) && typeof point.complete === 'boolean'))));
}

function normalizeRecent(recent) {
  const points = Array.isArray(recent?.points) ? recent.points : [];
  return {
    points: points.filter(point => validTime(point?.submittedAt))
      .sort((a, b) => a.submittedAt - b.submittedAt).slice(-30)
      .map(({ submittedAt, deltaTokens, avgTps }) => ({
        submittedAt,
        deltaTokens: Number.isSafeInteger(deltaTokens) && deltaTokens > 0 ? deltaTokens : 0,
        avgTps: Number.isFinite(avgTps) && avgTps > 0 ? avgTps : 0
      })),
    topModel: validStatsLabel(recent?.topModel) ? recent.topModel : null,
    topCli: validStatsLabel(recent?.topCli) ? recent.topCli : null
  };
}

function normalizeUsageBoards(boards) {
  const normalized = { ...boards };
  for (const hours of RANKING_HOURS) {
    const board = boards[hours];
    normalized[hours] = { ...board, rows: board.rows.map(row => ({ ...row, recent: normalizeRecent(row.recent) })) };
  }
  return normalized;
}

function validSnapshot({ cutoffAt, nextAt, boards, refreshAt, mode } = {}, expectedMode = 'hourly') {
  if (expectedMode === 'calendar' ? mode !== 'calendar' : (mode !== undefined && mode !== 'hourly')) return false;
  if (!isUsageTime(cutoffAt)) return false;
  const midnight = mode === 'calendar' && isUsageTime(cutoffAt + 8 * HOUR_MS)
    ? leaderboardDayStart(leaderboardDay(cutoffAt)) : undefined;
  if (mode === 'calendar' && !validTime(midnight)) return false;
  const speedRows = boards?.[0]?.rows;
  const interval = nextAt - cutoffAt;
  const live = validTime(refreshAt) && interval >= 1000 && interval <= HOUR_MS;
  return (live || interval === RANKING_REFRESH_MS || (interval === HOUR_MS && cutoffAt % HOUR_MS === 0)) &&
    Object.keys(boards ?? {}).length === 4 &&
    RANKING_HOURS.every(hours => validWindow(boards?.[hours], hours, cutoffAt, nextAt, midnight)) &&
    validRows(speedRows) && speedRows.every(row => Number.isFinite(row.avgTps) && row.avgTps > 0 &&
      (row.deltaTokens === undefined || (Number.isSafeInteger(row.deltaTokens) && row.deltaTokens > SPEED_MIN_DELTA)) &&
      validStatsLabel(row.topModel) && validStatsLabel(row.topCli));
}

export function createWindowViews({ storage, origin, request, now, panels, scope = () => origin, manager = false, mode = 'hourly' }) {
  const calendar = mode === 'calendar';
  const cacheKey = calendar ? 'leaderboard:calendar-snapshot' : 'leaderboard:ranking-snapshot';
  const cacheScope = calendar ? () => `calendar/${scope()}` : scope;
  let current, currentScope, pending;
  const view = (snapshot, hours) => ({ ...snapshot.boards[hours], cutoffAt: snapshot.cutoffAt, nextAt: snapshot.nextAt,
    boards: snapshot.boards, updatedAt: snapshot.updatedAt, refreshAt: snapshot.refreshAt });
  function clear() { current = currentScope = undefined; }
  function known(key) {
    return Object.values(current?.boards ?? {}).some(board => board.rows.some(row => row.username.toLowerCase() === key));
  }
  async function load(hours, signal) {
    if (signal.aborted) return null;
    const requestedScope = cacheScope();
    if (requestedScope !== currentScope) clear();
    if (!current) {
      const saved = await Promise.resolve().then(async () => {
        if (panels) return panels.readPanel('leaderboard', requestedScope)?.value;
        const value = await storage.get(cacheKey);
        return value ? JSON.parse(gunzipSync(Buffer.from(value, 'base64')).toString('utf8')) : null;
      }).catch(() => null);
      if (signal.aborted || requestedScope !== cacheScope() || saved?.origin !== origin ||
          !validTime(saved.updatedAt) || !validSnapshot(saved, mode)) return null;
      current ??= { ...saved, boards: normalizeUsageBoards(saved.boards) };
      currentScope = requestedScope;
    }
    return view(current, hours);
  }

  async function download(signal, requestedScope) {
    if (calendar && !manager) return { code: 'server_update_required' };
    let reply = await request(manager ? '/api/tokens-manager/snapshot' + (calendar ? '?mode=calendar' : '') : '/api/leaderboard/snapshot',
      { auth: false, signal, viewHeaders: true, hourlySnapshot: !manager });
    if (manager && !calendar && reply.code === 'not_found' && !signal.aborted) {
      reply = await request('/api/leaderboard/snapshot', { auth: false, signal, viewHeaders: true, hourlySnapshot: true });
    }
    if (signal.aborted || requestedScope !== cacheScope()) return {};
    if (calendar && validSnapshot(reply)) return { code: 'server_update_required' };
    if (!validSnapshot(reply, mode)) return { code: unavailable(reply) };
    const updatedAt = now();
    const { cutoffAt, nextAt } = reply;
    const boards = normalizeUsageBoards(reply.boards);
    const clockOffset = validTime(reply.serverTime) ? reply.serverTime - updatedAt : 0;
    const snapshot = { origin, cutoffAt, nextAt, boards: { ...boards, 0: { ...boards[0], clockOffset } }, updatedAt,
      ...(calendar ? { mode } : {}),
      ...(manager && validTime(reply.refreshAt) ? { refreshAt: Math.max(updatedAt + 1000, reply.refreshAt - clockOffset) } : {}) };
    current = snapshot;
    currentScope = requestedScope;
    await Promise.resolve().then(() => panels
      ? panels.publishPanel('leaderboard', requestedScope, snapshot, updatedAt)
      : storage.set(cacheKey, gzipSync(JSON.stringify(snapshot)).toString('base64'))).catch(() => {});
    return snapshot;
  }

  async function fetch(hours, force, signal) {
    if (!signal || signal.aborted) return {};
    const requestedScope = cacheScope();
    if (requestedScope !== currentScope) clear();
    if (current && !force) {
      const next = current.nextAt - (current.boards[0]?.clockOffset ?? 0);
      const refresh = current.nextAt - current.cutoffAt === HOUR_MS && next > current.updatedAt
        ? next : current.updatedAt + RANKING_REFRESH_MS;
      if (now() < (current.refreshAt ?? refresh)) return view(current, hours);
    }
    if (pending?.signal !== signal || pending.scope !== requestedScope) {
      const job = { signal, scope: requestedScope, promise: undefined };
      job.promise = download(signal, requestedScope).finally(() => { if (pending === job) pending = undefined; });
      pending = job;
    }
    const snapshot = await pending.promise;
    return snapshot.boards ? view(snapshot, hours) : snapshot;
  }
  return { fetch, load, clear, known };
}

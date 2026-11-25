import { HOUR_MS, RANKING_HOURS, RANKING_REFRESH_MS, SPEED_MIN_DELTA, isUsageTime, leaderboardDay,
  leaderboardDayStart, TOKENS_LEADERBOARD, validStatsLabel } from './leaderboard_stats.mjs';

const dayMs = 24 * HOUR_MS;
const validUsername = value => typeof value === 'string' && value.length > 0 && value.length <= 39;
const validTokens = value => Number.isInteger(value) && value >= 0 && value <= 720 * Number.MAX_SAFE_INTEGER;
const validRows = rows => Array.isArray(rows) && rows.length <= 100 && rows.every((row, index) =>
  row && validUsername(row.username) && row.rank === index + 1 && isUsageTime(row.submittedAt));
const unavailable = reply => ['not_found', 'login_required', 'server_update_required'].includes(reply.code)
  ? 'server_update_required' : 'unavailable';

function validWindow(board, hours, cutoffAt, nextAt, midnight) {
  const windowStart = midnight === undefined ? cutoffAt - hours * HOUR_MS : midnight - (hours / 24 - 1) * dayMs;
  return board?.hours === hours && board.cutoffAt === cutoffAt && board.nextAt === nextAt &&
    board.windowStart === windowStart && validRows(board.rows) && board.rows.every(row =>
      validTokens(row.tokens) && typeof row.complete === 'boolean' &&
      (row.lastUploadAt === null || isUsageTime(row.lastUploadAt)) && (hours === 24 ||
        (Array.isArray(row.daily) && row.daily.length === hours / 24 && row.daily.every((point, index) =>
          point?.at === board.windowStart + index * 24 * HOUR_MS && validTokens(point.tokens) && typeof point.complete === 'boolean'))));
}

function normalizeRecent(recent) {
  const points = Array.isArray(recent?.points) ? recent.points : [];
  return {
    points: points.filter(point => isUsageTime(point?.submittedAt))
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
  if (mode === 'calendar' && !isUsageTime(midnight)) return false;
  const speed = boards?.[0];
  const speedRows = speed?.rows;
  const speedStart = midnight ?? cutoffAt - dayMs;
  const hasSpeedWindow = speed?.windowStart !== undefined || speed?.cutoffAt !== undefined;
  if (hasSpeedWindow && (speed.windowStart !== speedStart || speed.cutoffAt !== cutoffAt)) return false;
  const interval = nextAt - cutoffAt;
  const live = isUsageTime(refreshAt) && interval >= 1000 && interval <= HOUR_MS;
  return (live || interval === RANKING_REFRESH_MS || (interval === HOUR_MS && cutoffAt % HOUR_MS === 0)) &&
    Object.keys(boards ?? {}).length === 4 &&
    RANKING_HOURS.every(hours => validWindow(boards?.[hours], hours, cutoffAt, nextAt, midnight)) &&
    validRows(speedRows) && speedRows.every(row => Number.isFinite(row.avgTps) && row.avgTps > 0 &&
      (!hasSpeedWindow || (row.submittedAt >= speedStart && (mode === 'calendar' ? row.submittedAt <= cutoffAt : row.submittedAt < cutoffAt))) &&
      (row.deltaTokens === undefined || (Number.isSafeInteger(row.deltaTokens) && row.deltaTokens > SPEED_MIN_DELTA)) &&
      validStatsLabel(row.topModel) && validStatsLabel(row.topCli));
}

export function createWindowViews({ origin, request, now, panels, scope = () => origin, mode = 'hourly' }) {
  const calendar = mode === 'calendar';
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
      const saved = await Promise.resolve().then(() => panels?.readPanel('leaderboard', requestedScope)?.value)
        .catch(() => null);
      if (signal.aborted || requestedScope !== cacheScope() || saved?.origin !== origin ||
          !isUsageTime(saved.updatedAt) || !validSnapshot(saved, mode)) return null;
      current ??= { ...saved, boards: normalizeUsageBoards(saved.boards) };
      currentScope = requestedScope;
    }
    return view(current, hours);
  }

  async function download(signal, requestedScope) {
    const path = TOKENS_LEADERBOARD + '/snapshot' + (calendar ? '?mode=calendar' : '');
    const reply = await request(path, { auth: false, signal, viewHeaders: true });
    if (signal.aborted || requestedScope !== cacheScope()) return {};
    if (calendar && validSnapshot(reply)) return { code: 'server_update_required' };
    if (!validSnapshot(reply, mode)) return { code: unavailable(reply) };
    const updatedAt = now();
    const { cutoffAt, nextAt } = reply;
    const boards = normalizeUsageBoards(reply.boards);
    const clockOffset = isUsageTime(reply.serverTime) ? reply.serverTime - updatedAt : 0;
    const snapshot = { origin, cutoffAt, nextAt, boards: { ...boards, 0: { ...boards[0], clockOffset } }, updatedAt,
      ...(calendar ? { mode } : {}),
      ...(isUsageTime(reply.refreshAt) ? { refreshAt: Math.max(updatedAt + 1000, reply.refreshAt - clockOffset) } : {}) };
    current = snapshot;
    currentScope = requestedScope;
    await Promise.resolve().then(() => panels?.publishPanel('leaderboard', requestedScope, snapshot, updatedAt)).catch(() => {});
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

import { HOUR_MS, RANKING_HOURS, RANKING_REFRESH_MS, SPEED_MIN_DELTA, isUsageTime, leaderboardDay,
  leaderboardDayStart, TOKENS_LEADERBOARD, validStatsLabel } from './leaderboard_stats.mjs';

const dayMs = 24 * HOUR_MS;
const validUsername = v => typeof v === 'string' && v.length > 0 && v.length <= 39;
const validTokens = v => Number.isInteger(v) && v >= 0 && v <= 720 * Number.MAX_SAFE_INTEGER;
const validRows = rows => Array.isArray(rows) && rows.length <= 100 && rows.every((r, i) => r && validUsername(r.username) && r.rank === i + 1 && isUsageTime(r.submittedAt));
const unavailable = r => ['not_found', 'login_required', 'server_update_required'].includes(r.code) ? 'server_update_required' : 'unavailable';

function validWindow(board, hours, cutoffAt, nextAt, midnight) {
  const windowStart = midnight === undefined ? cutoffAt - hours * HOUR_MS : midnight - (hours / 24 - 1) * dayMs;
  return board?.hours === hours && board.cutoffAt === cutoffAt && board.nextAt === nextAt && board.windowStart === windowStart &&
    validRows(board.rows) && board.rows.every(r => validTokens(r.tokens) && typeof r.complete === 'boolean' &&
      (r.lastUploadAt === null || isUsageTime(r.lastUploadAt)) && (hours === 24 ||
        (Array.isArray(r.daily) && r.daily.length === hours / 24 && r.daily.every((p, i) => p?.at === board.windowStart + i * dayMs && validTokens(p.tokens) && typeof p.complete === 'boolean'))));
}

const normalizeRecent = recent => ({
  points: (Array.isArray(recent?.points) ? recent.points : []).filter(p => isUsageTime(p?.submittedAt))
    .sort((a, b) => a.submittedAt - b.submittedAt).slice(-30)
    .map(({ submittedAt, deltaTokens, avgTps }) => ({
      submittedAt, deltaTokens: Number.isSafeInteger(deltaTokens) && deltaTokens > 0 ? deltaTokens : 0,
      avgTps: Number.isFinite(avgTps) && avgTps > 0 ? avgTps : 0
    })),
  topModel: validStatsLabel(recent?.topModel) ? recent.topModel : null,
  topCli: validStatsLabel(recent?.topCli) ? recent.topCli : null
});

const normalizeUsageBoards = boards => {
  const out = { ...boards };
  for (const h of RANKING_HOURS) out[h] = { ...boards[h], rows: boards[h].rows.map(r => ({ ...r, recent: normalizeRecent(r.recent) })) };
  return out;
};

function validSnapshot({ cutoffAt, nextAt, boards, refreshAt, mode } = {}, expectedMode = 'hourly') {
  if ((expectedMode === 'calendar' ? mode !== 'calendar' : mode !== undefined && mode !== 'hourly') || !isUsageTime(cutoffAt)) return false;
  const midnight = mode === 'calendar' && isUsageTime(cutoffAt + 8 * HOUR_MS) ? leaderboardDayStart(leaderboardDay(cutoffAt)) : undefined;
  if (mode === 'calendar' && !isUsageTime(midnight)) return false;
  const speed = boards?.[0], speedStart = midnight ?? cutoffAt - dayMs;
  const hasSpeedWindow = speed?.windowStart !== undefined || speed?.cutoffAt !== undefined;
  if (hasSpeedWindow && (speed.windowStart !== speedStart || speed.cutoffAt !== cutoffAt)) return false;
  const interval = nextAt - cutoffAt, live = isUsageTime(refreshAt) && interval >= 1000 && interval <= HOUR_MS;
  return (live || interval === RANKING_REFRESH_MS || (interval === HOUR_MS && cutoffAt % HOUR_MS === 0)) &&
    Object.keys(boards ?? {}).length === 4 && RANKING_HOURS.every(h => validWindow(boards?.[h], h, cutoffAt, nextAt, midnight)) &&
    validRows(speed?.rows) && speed.rows.every(r => Number.isFinite(r.avgTps) && r.avgTps > 0 &&
      (!hasSpeedWindow || (r.submittedAt >= speedStart && (mode === 'calendar' ? r.submittedAt <= cutoffAt : r.submittedAt < cutoffAt))) &&
      (r.deltaTokens === undefined || (Number.isSafeInteger(r.deltaTokens) && r.deltaTokens > SPEED_MIN_DELTA)) &&
      validStatsLabel(r.topModel) && validStatsLabel(r.topCli));
}

export function createWindowViews({ origin, request, now, panels, scope = () => origin, mode = 'hourly' }) {
  const calendar = mode === 'calendar', cacheScope = calendar ? () => `calendar/${scope()}` : scope;
  let current, currentScope, pending;
  const view = (snap, hours) => ({ ...snap.boards[hours], cutoffAt: snap.cutoffAt, nextAt: snap.nextAt, boards: snap.boards, updatedAt: snap.updatedAt, refreshAt: snap.refreshAt });
  const clear = () => { current = currentScope = undefined; };
  const known = key => Object.values(current?.boards ?? {}).some(b => b.rows.some(r => r.username.toLowerCase() === key));

  async function load(hours, signal) {
    if (signal.aborted) return null;
    const reqScope = cacheScope();
    if (reqScope !== currentScope) clear();
    if (!current) {
      const saved = await Promise.resolve().then(() => panels?.readPanel('leaderboard', reqScope)?.value).catch(() => null);
      if (signal.aborted || reqScope !== cacheScope() || saved?.origin !== origin || !isUsageTime(saved.updatedAt) || !validSnapshot(saved, mode)) return null;
      current ??= { ...saved, boards: normalizeUsageBoards(saved.boards) };
      currentScope = reqScope;
    }
    return view(current, hours);
  }

  async function download(signal, reqScope) {
    const reply = await request(TOKENS_LEADERBOARD + '/snapshot' + (calendar ? '?mode=calendar' : ''), { auth: false, signal, viewHeaders: true });
    if (signal.aborted || reqScope !== cacheScope()) return {};
    if (calendar && validSnapshot(reply)) return { code: 'server_update_required' };
    if (!validSnapshot(reply, mode)) return { code: unavailable(reply) };
    const updatedAt = now(), { cutoffAt, nextAt } = reply, boards = normalizeUsageBoards(reply.boards);
    const clockOffset = isUsageTime(reply.serverTime) ? reply.serverTime - updatedAt : 0;
    const snapshot = {
      origin, cutoffAt, nextAt, boards: { ...boards, 0: { ...boards[0], clockOffset } }, updatedAt,
      ...(calendar ? { mode } : {}),
      ...(isUsageTime(reply.refreshAt) ? { refreshAt: Math.max(updatedAt + 1000, reply.refreshAt - clockOffset) } : {})
    };
    current = snapshot; currentScope = reqScope;
    await Promise.resolve().then(() => panels?.publishPanel('leaderboard', reqScope, snapshot, updatedAt)).catch(() => {});
    return snapshot;
  }

  async function fetch(hours, force, signal) {
    if (!signal || signal.aborted) return {};
    const reqScope = cacheScope();
    if (reqScope !== currentScope) clear();
    if (current && !force) {
      const next = current.nextAt - (current.boards[0]?.clockOffset ?? 0);
      const refresh = current.nextAt - current.cutoffAt === HOUR_MS && next > current.updatedAt ? next : current.updatedAt + RANKING_REFRESH_MS;
      if (now() < (current.refreshAt ?? refresh)) return view(current, hours);
    }
    if (pending?.signal !== signal || pending.scope !== reqScope) {
      const job = { signal, scope: reqScope, promise: undefined };
      job.promise = download(signal, reqScope).finally(() => { if (pending === job) pending = undefined; });
      pending = job;
    }
    const snapshot = await pending.promise;
    return snapshot.boards ? view(snapshot, hours) : snapshot;
  }
  return { fetch, load, clear, known };
}

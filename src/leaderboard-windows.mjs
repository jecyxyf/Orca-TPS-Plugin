import { gzipSync, gunzipSync } from 'node:zlib';
import { HOUR_MS, RANKING_HOURS, RANKING_REFRESH_MS, SPEED_MIN_DELTA, isUsageTime, validStatsLabel, validStatsPoint } from './leaderboard-stats.mjs';

const validTime = value => Number.isSafeInteger(value) && value >= 0 && value < 8_640_000_000_000_000;
const validUsername = value => typeof value === 'string' && value.length > 0 && value.length <= 39;
const validTokens = value => Number.isInteger(value) && value >= 0 && value <= 720 * Number.MAX_SAFE_INTEGER;
const validRows = rows => Array.isArray(rows) && rows.length <= 100 && rows.every((row, index) =>
  row && validUsername(row.username) && row.rank === index + 1 && validTime(row.submittedAt));
const unavailable = reply => ['not_found', 'login_required'].includes(reply.code) ? 'server_update_required' : 'unavailable';

function validWindow(board, hours, cutoffAt, nextAt) {
  return board?.hours === hours && board.cutoffAt === cutoffAt && board.nextAt === nextAt &&
    board.windowStart === board.cutoffAt - hours * HOUR_MS && validRows(board.rows) && board.rows.every(row =>
      validTokens(row.tokens) && typeof row.complete === 'boolean' && validRecent(row) && (hours === 24 ||
        (Array.isArray(row.daily) && row.daily.length === hours / 24 && row.daily.every((point, index) =>
          point?.at === board.windowStart + index * 24 * HOUR_MS && validTokens(point.tokens) && typeof point.complete === 'boolean'))));
}

function validRecent({ lastUploadAt, recent }) {
  return (lastUploadAt === null || validTime(lastUploadAt)) &&
    validStatsLabel(recent?.topModel) && validStatsLabel(recent?.topCli) &&
    Array.isArray(recent.points) && recent.points.length <= 30 &&
    recent.points.every(point => validTime(point?.submittedAt) && validStatsPoint(point));
}

function validSnapshot({ cutoffAt, nextAt, boards } = {}) {
  const speedRows = boards?.[0]?.rows;
  return isUsageTime(cutoffAt) && nextAt === cutoffAt + RANKING_REFRESH_MS && Object.keys(boards ?? {}).length === 4 &&
    RANKING_HOURS.every(hours => validWindow(boards?.[hours], hours, cutoffAt, nextAt)) &&
    validRows(speedRows) && speedRows.every(row => Number.isFinite(row.avgTps) && row.avgTps > 0 &&
      (row.deltaTokens === undefined || (Number.isSafeInteger(row.deltaTokens) && row.deltaTokens > SPEED_MIN_DELTA)) &&
      validStatsLabel(row.topModel) && validStatsLabel(row.topCli));
}

export function createWindowViews({ storage, origin, request, now, panels, scope = () => origin }) {
  const cacheKey = 'leaderboard:ranking-snapshot';
  let current, currentScope, pending;
  const view = (snapshot, hours) => ({ ...snapshot.boards[hours], boards: snapshot.boards, updatedAt: snapshot.updatedAt });
  function clear() { current = currentScope = undefined; }
  function known(key) {
    return Object.values(current?.boards ?? {}).some(board => board.rows.some(row => row.username.toLowerCase() === key));
  }
  async function load(hours, signal) {
    if (signal.aborted) return null;
    const requestedScope = scope();
    if (requestedScope !== currentScope) clear();
    if (!current) {
      const saved = await Promise.resolve().then(async () => {
        if (panels) return panels.readPanel('leaderboard', requestedScope)?.value;
        const value = await storage.get(cacheKey);
        return value ? JSON.parse(gunzipSync(Buffer.from(value, 'base64')).toString('utf8')) : null;
      }).catch(() => null);
      if (signal.aborted || requestedScope !== scope() || saved?.origin !== origin ||
          !validTime(saved.updatedAt) || !validSnapshot(saved)) return null;
      current ??= saved;
      currentScope = requestedScope;
    }
    return view(current, hours);
  }

  async function download(signal, requestedScope) {
    const reply = await request('/api/leaderboard/snapshot', { auth: false, signal, viewHeaders: true });
    if (signal.aborted || requestedScope !== scope()) return {};
    if (!validSnapshot(reply)) return { code: unavailable(reply) };
    const updatedAt = now();
    const { cutoffAt, nextAt, boards } = reply;
    const clockOffset = validTime(reply.serverTime) ? reply.serverTime - updatedAt : 0;
    const snapshot = { origin, cutoffAt, nextAt, boards: { ...boards, 0: { ...boards[0], clockOffset } }, updatedAt };
    current = snapshot;
    currentScope = requestedScope;
    await Promise.resolve().then(() => panels
      ? panels.publishPanel('leaderboard', requestedScope, snapshot, updatedAt)
      : storage.set(cacheKey, gzipSync(JSON.stringify(snapshot)).toString('base64'))).catch(() => {});
    return snapshot;
  }

  async function fetch(hours, force, signal) {
    if (!signal || signal.aborted) return {};
    const requestedScope = scope();
    if (requestedScope !== currentScope) clear();
    if (current && !force && now() < current.updatedAt + RANKING_REFRESH_MS) return view(current, hours);
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

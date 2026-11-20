import { HOUR_MS, RECENT_STATS_MS, SPEED_WINDOW_MS, isHourStart, validStatsLabel, validStatsPoint } from './leaderboard-stats.mjs';

const validTime = value => Number.isSafeInteger(value) && value >= 0 && value < 8_640_000_000_000_000;
const validUsername = value => typeof value === 'string' && value.length > 0 && value.length <= 39;
const validTokens = value => Number.isInteger(value) && value >= 0 && value <= 720 * Number.MAX_SAFE_INTEGER;
const validRows = rows => Array.isArray(rows) && rows.length <= 100 && rows.every((row, index) =>
  row && validUsername(row.username) && row.rank === index + 1 && validTime(row.submittedAt));
const unavailable = reply => ['not_found', 'login_required'].includes(reply.code) ? 'server_update_required' : 'unavailable';

function validWindow(board, hours) {
  return board?.hours === hours && isHourStart(board.cutoffAt) && typeof board.snapshotId === 'string' &&
    /^\d+-\d+$/.test(board.snapshotId) && board.nextAt === board.cutoffAt + HOUR_MS &&
    board.windowStart === board.cutoffAt - hours * HOUR_MS && validRows(board.rows) && board.rows.every(row =>
      validTokens(row.tokens) && typeof row.complete === 'boolean' && (hours === 24 ||
        (Array.isArray(row.daily) && row.daily.length === hours / 24 && row.daily.every((point, index) =>
          point?.at === board.windowStart + index * 24 * HOUR_MS && validTokens(point.tokens) && typeof point.complete === 'boolean'))));
}

function validRecent(reply, board) {
  return reply?.snapshotId === board.snapshotId && Array.isArray(reply.rows) && reply.rows.length === board.rows.length &&
    reply.rows.every((row, index) => row?.username === board.rows[index].username &&
      (row.submittedAt === null || validTime(row.submittedAt)) && validStatsLabel(row.topModel) && validStatsLabel(row.topCli) &&
      (board.hours !== 24 || (Array.isArray(row.points) && row.points.length <= 30 &&
        row.points.every(point => validTime(point?.submittedAt) && validStatsPoint(point)))));
}

export function createWindowViews({ storage, origin, request, now }) {
  const caches = new Map();
  const pending = new Map();
  const cacheKey = hours => `leaderboard:hourly-view:${hours}`;
  function clear() { caches.clear(); }
  function known(key) {
    return [...caches.values()].some(cache => cache.board.rows.some(row => row.username.toLowerCase() === key));
  }
  async function load(hours, signal) {
    if (!hours || signal.aborted) return null;
    const current = caches.get(hours);
    if (current?.due >= now()) return { ...current.board, updatedAt: current.updatedAt };
    const saved = await Promise.resolve().then(() => storage.get(cacheKey(hours))).catch(() => null);
    if (signal.aborted || saved?.origin !== origin || !validTime(saved.updatedAt) || !validWindow(saved.board, hours) ||
        now() < saved.board.cutoffAt || now() >= saved.board.nextAt) return null;
    if (!caches.has(hours)) caches.set(hours, { board: saved.board, due: saved.board.nextAt, updatedAt: saved.updatedAt });
    return { ...saved.board, updatedAt: saved.updatedAt };
  }

  async function getSpeeds(force, signal) {
    const current = caches.get(0);
    const reply = await request('/api/leaderboard/speeds', { auth: false, signal, viewHeaders: true,
      etag: force ? undefined : current?.etag });
    if (signal.aborted) return {};
    const rows = reply.notModified ? current?.board.rows : reply.rows;
    if (!validRows(rows) || !rows.every(row => Number.isFinite(row.avgTps) && row.avgTps > 0 &&
        validStatsLabel(row.topModel) && validStatsLabel(row.topCli))) {
      return { code: unavailable(reply) };
    }
    const time = now();
    const clockOffset = validTime(reply.serverTime) ? reply.serverTime - time : current?.board.clockOffset ?? 0;
    const board = { rows: rows.filter(row => row.submittedAt > time + clockOffset - SPEED_WINDOW_MS), clockOffset };
    caches.set(0, { board: { rows, clockOffset }, etag: reply.notModified ? current.etag : reply.etag });
    return { ...board, updatedAt: time };
  }

  async function getUsage(hours, force, signal) {
    let current = caches.get(hours);
    const opts = { auth: false, signal, viewHeaders: true };
    async function fetchSnapshot(etag) {
      const reply = await request(`/api/leaderboard/usage?hours=${hours}`, { ...opts, etag });
      if (signal.aborted) return {};
      const board = reply.notModified ? current?.board : reply;
      if (!validWindow(board, hours)) return { code: unavailable(reply) };
      const time = now();
      const due = validTime(reply.serverTime) ? time + Math.max(0, board.nextAt - reply.serverTime) : board.nextAt;
      if (reply.notModified) {
        current.due = due;
      } else {
        const { hours, windowStart, cutoffAt, nextAt, snapshotId, rows } = board;
        current = { board: { hours, windowStart, cutoffAt, nextAt, snapshotId, rows }, etag: reply.etag, due, updatedAt: time };
        caches.set(hours, current);
        await Promise.resolve().then(() => storage.set(cacheKey(hours), { origin, board: current.board, updatedAt: time })).catch(() => {});
      }
      return null;
    }
    if (force || !current || now() >= current.due) {
      const failure = await fetchSnapshot(force ? undefined : current?.etag);
      if (failure) return failure;
    }
    if (signal.aborted) return {};
    const fetchRecent = etag => request(`/api/leaderboard/recent?hours=${hours}&snapshotId=${current.board.snapshotId}`, { ...opts, etag });
    let reply = await fetchRecent(force ? undefined : current.recentEtag);
    if (signal.aborted) return {};
    if (reply.code === 'snapshot_expired') {
      const failure = await fetchSnapshot();
      if (failure) return failure;
      if (signal.aborted) return {};
      reply = await fetchRecent();
    }
    if (signal.aborted) return {};
    const recent = reply.notModified ? current.recent : reply;
    const time = now();
    if (!validRecent(recent, current.board)) return { ...current.board, code: 'unavailable', updatedAt: current.updatedAt };
    if (!reply.notModified) {
      current.recent = recent;
      current.recentEtag = reply.etag;
    }
    current.updatedAt = time;
    const rows = current.board.rows.map((row, index) => {
      const { points = [], topModel, topCli, submittedAt } = recent.rows[index];
      return { ...row, lastUploadAt: submittedAt, recent: { points: points.filter(point => point.submittedAt > time - RECENT_STATS_MS), topModel, topCli } };
    });
    return { ...current.board, rows, updatedAt: time };
  }

  function fetch(hours, force, signal) {
    if (!signal || signal.aborted) return {};
    const running = pending.get(hours);
    if (running?.signal === signal) return running.promise;
    const job = { signal, promise: undefined };
    job.promise = (hours ? getUsage(hours, force, signal) : getSpeeds(force, signal)).finally(() => {
      if (pending.get(hours) === job) pending.delete(hours);
    });
    pending.set(hours, job);
    return job.promise;
  }
  return { fetch, load, clear, known };
}

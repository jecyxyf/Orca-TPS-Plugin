import { HOUR_MS, RANKING_HOURS, RANKING_REFRESH_MS, RECENT_STATS_MS } from '../src/leaderboard-stats.mjs';

export function recentRankingRows(store, hours, members, time) {
  const accounts = members.map(row => row.account);
  const entries = store.recentRows(accounts, time, hours !== 24), uploads = store.latestUploads(accounts);
  let expiresAt = Infinity;
  const rows = members.map(({ account, username }) => {
    const entry = entries.get(account);
    if (entry) expiresAt = Math.min(expiresAt, entry.points[0].submittedAt + RECENT_STATS_MS);
    return { username, submittedAt: uploads.get(account) ?? null, topModel: entry?.topModel ?? null,
      topCli: entry?.topCli ?? null, ...(hours === 24 ? { points: entry?.points ?? [] } : {}) };
  });
  return { rows, expiresAt };
}

function withRecent(store, board, hours, cutoffAt) {
  const { rows: recent } = recentRankingRows(store, hours, board.rows, cutoffAt);
  const rows = board.rows.map(({ account, ...row }, index) => {
    const { submittedAt, topModel, topCli, points = [] } = recent[index];
    return { ...row, lastUploadAt: submittedAt, recent: { topModel, topCli, points } };
  });
  return { ...board, rows };
}

export function rollingBoard(store, hours, cutoffAt) {
  return withRecent(store, store.hourly.rollingRanking(hours, cutoffAt), hours, cutoffAt);
}

export function createRankingSnapshot(store, now = Date.now) {
  return store.readSnapshot(() => {
    const cutoffAt = now();
    const boards = Object.fromEntries(RANKING_HOURS.map(hours => [hours, rollingBoard(store, hours, cutoffAt)]));
    boards[0] = { rows: store.speedRanking(cutoffAt).rows };
    return { cutoffAt, nextAt: cutoffAt + RANKING_REFRESH_MS, boards };
  });
}

export function createPublishedSnapshot(store, cutoffAt, opened = () => {}) {
  return store.readSnapshot(() => {
    const revision = store.readAdminRevision();
    opened();
    const data = store.leaderboardData.rows(cutoffAt - RANKING_HOURS.at(-1) * HOUR_MS, cutoffAt);
    const boards = store.hourly.publishedRankings(cutoffAt, data);
    for (const hours of RANKING_HOURS) boards[hours] = withRecent(store, boards[hours], hours, cutoffAt);
    boards[0] = { rows: store.publishedSpeeds(cutoffAt) };
    return { revision, snapshot: { cutoffAt, nextAt: cutoffAt + HOUR_MS, boards } };
  });
}

import { createHash, randomUUID } from 'node:crypto';
import { RECENT_STATS_MS, validRecentRequest, validSubmissionStats } from './leaderboard_stats.mjs';

const STORAGE_KEY = 'leaderboard:submission-stats';

export async function createSubmissionStats(storage, now = Date.now) {
  const saved = await Promise.resolve().then(() => storage.get(STORAGE_KEY)).catch(() => null);
  const startedAt = Number.isSafeInteger(saved?.startedAt) ? Math.min(saved.startedAt, now()) : now();
  const records = new Map();
  const acknowledged = new Map(Array.isArray(saved?.acknowledged) ? saved.acknowledged.filter(validReceipt) : []);
  let pending = validPending(saved?.pending) ? saved.pending : null;

  function validReceipt(row) {
    return Array.isArray(row) && typeof row[0] === 'string' && Number.isSafeInteger(row[1]);
  }

  function validPending(value) {
    return typeof value?.session === 'string' && Number.isSafeInteger(value.createdAt) &&
      typeof value.options?.requestId === 'string' && validSubmissionStats(value.options.body?.stats) &&
      Array.isArray(value.records) && value.records.every(validReceipt);
  }

  function discardExpired(time) {
    const cutoff = time - RECENT_STATS_MS;
    for (const [key, { record }] of records) if (record[1] <= cutoff) records.delete(key);
    for (const [key, completedAt] of acknowledged) if (completedAt <= cutoff) acknowledged.delete(key);
  }

  async function persist() {
    try { await storage.set(STORAGE_KEY, { startedAt, acknowledged: [...acknowledged], pending }); }
    catch { /* Continue with the in-memory batch until storage becomes available again. */ }
  }

  function observe(source, recent) {
    const time = now();
    discardExpired(time);
    for (const record of recent) {
      if (!validRecentRequest(record) || record[1] <= Math.max(startedAt, time - RECENT_STATS_MS) || record[1] > time + 1000) continue;
      const key = createHash('sha256').update(source).update(':').update(record[0]).digest('hex').slice(0, 24);
      records.set(key, { source, record });
    }
  }

  function countLabel(labels, label, completedAt) {
    if (!label) return;
    const current = labels.get(label);
    labels.set(label, { count: (current?.count ?? 0) + 1, latest: Math.max(current?.latest ?? 0, completedAt) });
  }

  function mostUsed(labels) {
    let winner = null;
    for (const [label, entry] of labels) {
      const current = labels.get(winner);
      if (!current || entry.count > current.count || (entry.count === current.count &&
        (entry.latest > current.latest || (entry.latest === current.latest && label < winner)))) winner = label;
    }
    return winner;
  }

  async function prepare(session, score, sourceId) {
    const time = now();
    if (pending?.session === session && pending.options?.body?.day === score.day &&
      pending.options.body.installationId === score.installationId && pending.sourceId === sourceId &&
      time - pending.createdAt < RECENT_STATS_MS) return pending.options;
    discardExpired(time);
    const sent = [], models = new Map(), tools = new Map();
    let deltaTokens = 0, speeds = 0, avgTps = 0;
    for (const [key, { source, record: [, completedAt, tokens, speed, model, cli] }] of records) {
      if (completedAt > time || (sourceId && source !== sourceId)) continue;
      if (!acknowledged.has(key)) {
        deltaTokens = Math.min(Number.MAX_SAFE_INTEGER, deltaTokens + tokens);
        sent.push([key, completedAt]);
      }
      if (speed !== null) avgTps += (speed - avgTps) / ++speeds;
      countLabel(models, model, completedAt);
      countLabel(tools, cli, completedAt);
    }
    const stats = { deltaTokens, avgTps: speeds ? avgTps : null, topModel: mostUsed(models), topCli: mostUsed(tools) };
    const options = { requestId: randomUUID(), sampledAt: time, body: { ...score, stats } };
    pending = { session, sourceId, createdAt: time, options, records: sent };
    await persist();
    return options;
  }

  async function settle(options, code) {
    if (pending?.options.requestId !== options.requestId || code === 'unavailable' || code === 'rate_limited') return;
    if (code === 'accepted') {
      for (const [key, completedAt] of pending.records) acknowledged.set(key, completedAt);
    }
    pending = null;
    discardExpired(now());
    await persist();
  }

  return { observe, prepare, settle };
}

import { Worker } from 'node:worker_threads';
import { HOUR_MS, RANKING_REFRESH_MS } from '../src/leaderboard-stats.mjs';

export const WRITE_INTERVAL_MS = 2_000;

export function createLeaderboardJobs({ filename, maxTokens, readPublished, now = Date.now, onWrite = () => {}, log = () => {} }) {
  const workerUrl = new URL('./leaderboard-thread.mjs', import.meta.url);
  const workers = new Map();
  const batches = new Map();
  let pending = [], sequence = 0, timer, stopped = false, snapshot;
  const interval = readPublished ? HOUR_MS : RANKING_REFRESH_MS;
  let rankingInFlight = false, rankingRequested = false, holdWrites = false, publicationId;
  let rankingTick = Math.floor(now() / interval);
  if (readPublished && JSON.parse(readPublished() ?? 'null')?.cutoffAt !== rankingTick * interval) rankingTick--;
  const unavailable = entry => entry.entries.map(() => ({ code: 'unavailable' }));

  function retryPublication() {
    holdWrites = false;
    if (readPublished) rankingTick = Math.min(rankingTick, Math.floor(now() / interval) - 1);
  }

  function requestRankings(cutoff) {
    const worker = workers.get('rankings');
    if (stopped || !worker) return retryPublication();
    if (rankingInFlight) { rankingRequested = cutoff ?? true; return; }
    rankingInFlight = true;
    worker.postMessage({ id: ++sequence, cutoff });
  }

  function createWorker(role) {
    const worker = new Worker(workerUrl, { workerData: { role, filename, maxTokens }, env: {} });
    workers.set(role, worker);
    worker.on('message', ({ id, results, body, failed, opened, publish, published }) => {
      if (role === 'rankings') {
        if (opened) { holdWrites = false; return; }
        rankingInFlight = false;
        if (failed) {
          log('榜单生成失败。');
          retryPublication();
        } else if (publish) {
          const writer = workers.get('writes');
          if (writer) {
            publicationId = ++sequence;
            writer.postMessage({ id: publicationId, publish });
          } else retryPublication();
        } else snapshot = body;
        if (rankingRequested) {
          const queued = rankingRequested;
          rankingRequested = false;
          requestRankings(queued === true ? undefined : queued);
        }
        return;
      }
      if (id === publicationId) {
        publicationId = undefined;
        if (!published) retryPublication();
        return;
      }
      const batch = batches.get(id);
      if (!batch) return;
      batches.delete(id);
      if (failed) log('榜单用量批量写入失败。');
      else if (batch.uploads.length) onWrite();
      for (const [index, upload] of batch.uploads.entries()) {
        upload.resolve(failed ? unavailable(upload) : results[index]);
      }
      if (batch.ranking) {
        if (failed) retryPublication();
        else requestRankings(batch.cutoff);
      }
    });
    worker.on('error', () => log(`榜单工作线程异常（${role}）。`));
    worker.on('exit', () => {
      workers.delete(role);
      if (role === 'rankings') {
        rankingInFlight = rankingRequested = false;
        retryPublication();
      }
      else {
        publicationId = undefined;
        retryPublication();
        for (const { uploads } of batches.values()) {
          for (const upload of uploads) upload.resolve(unavailable(upload));
        }
        batches.clear();
      }
      if (!stopped) setTimeout(() => { if (!stopped) createWorker(role); }, WRITE_INTERVAL_MS).unref();
    });
  }

  function flush(cutoff) {
    const worker = workers.get('writes');
    if (stopped || !worker || holdWrites) return;
    const tick = Math.floor(cutoff / interval);
    const ranking = tick > rankingTick || Boolean(readPublished && !rankingInFlight && publicationId === undefined && !readPublished());
    const publicationCutoff = readPublished && ranking ? tick * interval : undefined;
    const before = publicationCutoff ?? cutoff;
    const uploads = pending.filter(upload => upload.entries[0].receivedAt < before);
    if (!uploads.length && !ranking) return;
    pending = pending.filter(upload => upload.entries[0].receivedAt >= before);
    rankingTick = tick;
    const id = ++sequence;
    holdWrites = publicationCutoff !== undefined;
    batches.set(id, { uploads, ranking, cutoff: publicationCutoff });
    worker.postMessage({ id, requests: uploads.map(upload => upload.entries) });
  }

  function schedule() {
    const next = (Math.floor(now() / WRITE_INTERVAL_MS) + 1) * WRITE_INTERVAL_MS;
    timer = setTimeout(() => {
      flush(Math.max(next, Math.floor(now() / WRITE_INTERVAL_MS) * WRITE_INTERVAL_MS));
      schedule();
    }, Math.max(0, next - now()));
    timer.unref();
  }

  createWorker('writes');
  createWorker('rankings');
  if (readPublished) flush(now());
  else requestRankings();
  schedule();
  return {
    submit(entries) {
      return new Promise(resolve => {
        if (stopped) resolve(unavailable({ entries }));
        else pending.push({ entries, resolve });
      });
    },
    hourly: Boolean(readPublished),
    snapshot: () => readPublished ? readPublished() : snapshot,
    async close() {
      stopped = true;
      clearTimeout(timer);
      for (const upload of [...pending, ...[...batches.values()].flatMap(batch => batch.uploads)]) {
        upload.resolve(unavailable(upload));
      }
      pending = [];
      batches.clear();
      await Promise.all([...workers.values()].map(worker => worker.terminate()));
    }
  };
}

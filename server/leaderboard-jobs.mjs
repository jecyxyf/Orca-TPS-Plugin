import { Worker } from 'node:worker_threads';
import { RANKING_REFRESH_MS } from '../src/leaderboard-stats.mjs';

export const WRITE_INTERVAL_MS = 2_000;

export function createLeaderboardJobs({ filename, maxTokens, onWrite = () => {}, log = () => {} }) {
  const workerUrl = new URL('./leaderboard-thread.mjs', import.meta.url);
  const workers = new Map();
  const batches = new Map();
  let pending = [], sequence = 0, timer, stopped = false, snapshot;
  let rankingInFlight = false, rankingRequested = false;
  let rankingTick = Math.floor(Date.now() / RANKING_REFRESH_MS);
  const unavailable = entry => entry.entries.map(() => ({ code: 'unavailable' }));

  function requestRankings() {
    const worker = workers.get('rankings');
    if (stopped || !worker) return;
    if (rankingInFlight) { rankingRequested = true; return; }
    rankingInFlight = true;
    worker.postMessage({ id: ++sequence });
  }

  function createWorker(role) {
    const worker = new Worker(workerUrl, { workerData: { role, filename, maxTokens }, env: {} });
    workers.set(role, worker);
    worker.on('message', ({ id, results, body, failed }) => {
      if (role === 'rankings') {
        rankingInFlight = false;
        if (failed) log('榜单生成失败。');
        else snapshot = body;
        if (rankingRequested) {
          rankingRequested = false;
          requestRankings();
        }
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
      if (batch.ranking && !failed) requestRankings();
    });
    worker.on('error', () => log(`榜单工作线程异常（${role}）。`));
    worker.on('exit', () => {
      workers.delete(role);
      if (role === 'rankings') rankingInFlight = rankingRequested = false;
      else {
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
    if (stopped || !worker) return;
    const tick = Math.floor(cutoff / RANKING_REFRESH_MS);
    const ranking = tick > rankingTick;
    const uploads = pending.filter(upload => upload.entries[0].receivedAt < cutoff);
    if (!uploads.length && !ranking) return;
    pending = pending.filter(upload => upload.entries[0].receivedAt >= cutoff);
    rankingTick = tick;
    const id = ++sequence;
    batches.set(id, { uploads, ranking });
    worker.postMessage({ id, requests: uploads.map(upload => upload.entries) });
  }

  function schedule() {
    const next = (Math.floor(Date.now() / WRITE_INTERVAL_MS) + 1) * WRITE_INTERVAL_MS;
    timer = setTimeout(() => {
      flush(Math.max(next, Math.floor(Date.now() / WRITE_INTERVAL_MS) * WRITE_INTERVAL_MS));
      schedule();
    }, Math.max(0, next - Date.now()));
    timer.unref();
  }

  createWorker('writes');
  createWorker('rankings');
  requestRankings();
  schedule();
  return {
    submit(entries) {
      return new Promise(resolve => {
        if (stopped) resolve(unavailable({ entries }));
        else pending.push({ entries, resolve });
      });
    },
    snapshot: () => snapshot,
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

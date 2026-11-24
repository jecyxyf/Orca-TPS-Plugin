import { Worker } from 'node:worker_threads';
import { TOKENS_DEFAULT_INTERVALS, tokensIntervals } from '../src/leaderboard_stats.mjs';
import { createPacketBuffer, openPacketBuffer } from './tokens-manager-buffer.mjs';

export function createTokensManagerJobs({ maxTokens, now, intervals: input, log }) {
  const intervals = tokensIntervals({ ...input, publishMs: TOKENS_DEFAULT_INTERVALS.publishMs });
  const buffer = createPacketBuffer();
  const { release } = openPacketBuffer(buffer);
  const source = new URL('./tokens-manager-rankings.mjs', import.meta.url);
  const start = mode => new Worker(source, { workerData: { mode, buffer, intervals, maxTokens } });
  const counters = [start('validate'), start('validate')];
  let rank = start('rank'), snapshot, sequence = 0, stopped = false;
  const pending = new Map();
  function observeRank(worker) {
    const owner = worker.threadId;
    worker.on('message', result => { snapshot = result; });
    worker.on('error', () => { snapshot = undefined; log('Tokens manager ranking worker restarted'); });
    worker.on('exit', () => {
      release(owner);
      if (stopped) return;
      rank = start('rank');
      observeRank(rank);
    });
  }
  observeRank(rank);

  function observeReceiver(worker, index) {
    const owner = worker.threadId;
    worker.on('message', results => {
      for (const { id, accepted } of results) {
        const job = pending.get(id);
        if (!job) continue;
        pending.delete(id);
        job.resolve(accepted);
      }
    });
    worker.on('error', () => log('Tokens manager receiving worker restarted'));
    worker.on('exit', () => {
      release(owner);
      for (const [id, job] of pending) if (job.worker === worker) { pending.delete(id); job.resolve(false); }
      if (!stopped) observeReceiver(counters[index] = start('validate'), index);
    });
  }
  counters.forEach(observeReceiver);

  rank.postMessage({ at: now(), initial: true });
  const timer = setInterval(() => rank.postMessage({ at: now() }), intervals.publishMs);
  timer.unref();
  return {
    intervals,
    snapshot: () => snapshot,
    receive(account, raw) {
      if (stopped || pending.size >= 512) return Promise.resolve(false);
      const id = ++sequence, worker = counters[id % counters.length];
      const at = now();
      return new Promise(resolve => {
        pending.set(id, { worker, resolve });
        worker.postMessage({ id, raw, account: { id: account.id, username: account.username }, at });
      });
    },
    async close() {
      stopped = true;
      clearInterval(timer);
      await Promise.all([rank, ...counters].map(worker => worker.terminate()));
    }
  };
}

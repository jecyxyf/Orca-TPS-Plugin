import { Worker } from 'node:worker_threads';
import { tokensIntervals } from '../src/tokens-manager-stats.mjs';

export function createTokensManagerJobs({ maxTokens, now, intervals: input, log }) {
  const intervals = tokensIntervals(input);
  const source = new URL('./tokens-manager-rankings.mjs', import.meta.url);
  const start = mode => new Worker(source, { workerData: { mode } });
  const counters = [start('validate'), start('validate')];
  let rank = start('rank'), snapshot, sequence = 0, timer, stopped = false;
  const pending = new Map();
  function observeRank() {
    rank.on('message', result => { snapshot = result; });
    rank.on('error', () => { snapshot = undefined; log('Tokens manager ranking worker restarted'); });
    rank.on('exit', () => {
      if (stopped) return;
      rank = start('rank');
      observeRank();
    });
  }
  observeRank();

  function observeReceiver(worker, index) {
    worker.on('message', ({ id, packet }) => {
      const job = pending.get(id);
      if (!job) return;
      pending.delete(id);
      if (packet && !stopped) rank.postMessage({ type: 'receive', account: job.account, packet, at: job.at });
      job.resolve(Boolean(packet));
    });
    worker.on('error', () => log('Tokens manager receiving worker restarted'));
    worker.on('exit', () => {
      for (const [id, job] of pending) if (job.worker === worker) { pending.delete(id); job.resolve(false); }
      if (!stopped) observeReceiver(counters[index] = start('validate'), index);
    });
  }
  counters.forEach(observeReceiver);

  function publish() {
    if (stopped) return;
    rank.postMessage({ type: 'publish', at: now(), intervals });
    timer = setTimeout(publish, intervals.publishMs);
    timer.unref();
  }
  publish();
  return {
    intervals,
    snapshot: () => snapshot,
    receive(account, raw) {
      if (stopped || pending.size >= 512) return Promise.resolve(false);
      const id = ++sequence, worker = counters[id % counters.length];
      const at = now();
      return new Promise(resolve => {
        pending.set(id, { worker, account: { id: account.id, username: account.username }, at, resolve });
        worker.postMessage({ id, raw, accountId: account.id, at, maxTokens });
      });
    },
    async close() {
      stopped = true;
      clearTimeout(timer);
      await Promise.all([rank, ...counters].map(worker => worker.terminate()));
    }
  };
}

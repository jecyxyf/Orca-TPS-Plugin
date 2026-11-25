import { Worker } from 'node:worker_threads';
import { TOKENS_DEFAULT_INTERVALS, tokensIntervals } from '../src/leaderboard_stats.mjs';
import { createPacketBuffer, openPacketBuffer } from './tokens-manager-buffer.mjs';


export function createTokensManagerJobs({ maxTokens, now, intervals: input, log, receiverCount = 8, flushMs = 100 }) {
  if (!Number.isSafeInteger(receiverCount) || receiverCount < 1) throw new Error('Invalid LEADERBOARD_TOKENS_RECEIVERS');
  if (!Number.isSafeInteger(flushMs) || flushMs < 1 || flushMs > 2_147_483_647) {
    throw new Error('Invalid LEADERBOARD_TOKENS_FLUSH_MS');
  }
  const intervals = tokensIntervals(input, TOKENS_DEFAULT_INTERVALS);
  const buffer = createPacketBuffer();
  const { release } = openPacketBuffer(buffer);
  const source = new URL('./tokens-manager-rankings.mjs', import.meta.url);
  const bans = new Map();
  const start = mode => new Worker(source, {
    name: mode === 'validate' ? 'tps-receiver' : 'tps-ranker',
    workerData: { mode, buffer, intervals, maxTokens, flushMs, ...(mode === 'rank' && { bans }) }
  });
  const counters = Array.from({ length: receiverCount }, () => start('validate'));
  let rank = start('rank'), snapshot, sequence = 0, stopped = false;
  let rankBusy = false, roundPending = false;
  const pending = new Map(), changes = new Map();

  function dispatchRank() {
    if (stopped || rankBusy) return;
    rankBusy = true;
    rank.postMessage({ at: now(), takePackets: roundPending, changes: [...changes] });
    roundPending = false;
    changes.clear();
  }

  function scheduleRound() {
    roundPending = true;
    dispatchRank();
  }

  function observeRank(worker) {
    const owner = worker.threadId;
    worker.on('message', result => {
      if (stopped) return;
      snapshot = result;
      rankBusy = false;
      if (roundPending || changes.size) dispatchRank();
    });
    worker.on('error', () => { snapshot = undefined; log('Tokens manager ranking worker restarted'); });
    worker.on('exit', () => {
      release(owner);
      if (stopped) return;
      rank = start('rank');
      observeRank(rank);
      rankBusy = false;
      scheduleRound();
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

  dispatchRank();
  const timer = setInterval(scheduleRound, intervals.publishMs);
  timer.unref();
  return {
    intervals,
    snapshot: mode => snapshot?.[mode],
    setBan(accountId, banned) {
      if (stopped) return;
      const state = { banned, sequence };
      bans.set(accountId, state);
      // Coalesce repeated admin changes while keeping the eviction from an intervening ban.
      changes.set(accountId, { ...state, evict: banned || changes.get(accountId)?.evict });
      dispatchRank();
    },
    receive(account, raw) {
      if (stopped || bans.get(account.id)?.banned || pending.size >= 512) return Promise.resolve(false);
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

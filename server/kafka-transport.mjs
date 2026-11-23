import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { Kafka, logLevel } from 'kafkajs';
import { HOUR_MS, hourStart } from '../src/leaderboard-stats.mjs';

const PARTITIONS = 4;
const MAX_PENDING = 256;
// Leave room in Kafka's message batch for record keys and protocol overhead.
const MAX_SEND_BYTES = 1024 * 1024 - 4096;
const RECHECK_MS = 5000;
const replyUnavailable = entries => entries.map(() => ({ code: 'unavailable' }));

export function uploadPartitionKey(accountId, entries) {
  const sources = new Set(entries.flatMap(({ kind, input }) => {
    if (kind === 'sources') return input.operations.map(op => op.sourceId);
    return [kind === 'hourly-source' ? input.sourceId : input.installationId];
  }));
  const source = sources.size === 1 ? [...sources][0] : null;
  return JSON.stringify([accountId, typeof source === 'string' ? source : null]);
}

export function createKafkaLeaderboardJobs({ filename, maxTokens, brokers, topic, groupId, readPublished,
  now = Date.now, onWrite = () => {}, log = () => {}, replyMs = 8500 }) {
  if (!topic || !groupId || !brokers.length) throw new Error('Kafka requires brokers, a topic and a consumer group');
  const kafka = new Kafka({ brokers, clientId: 'orca-tps-leaderboard', logLevel: logLevel.NOTHING,
    connectionTimeout: 2000, requestTimeout: 5000, retry: { retries: 3 } });
  const producer = kafka.producer({ allowAutoTopicCreation: false, idempotent: true, maxInFlightRequests: 1 });
  const partitionNumbers = Array.from({ length: PARTITIONS }, (_, index) => index);
  const workers = new Set();
  const restarts = new Set();
  const waiting = new Map();
  const queue = [];
  let buffered = 0, ready = false, closed = false, init, pump, timer;
  let barrier, ranking, rankingJob, uncertainUpload = false, retryCutoffAt = -Infinity;
  let publishedCutoff = -Infinity;

  function settle(id, results) {
    const request = waiting.get(id);
    if (!request) return;
    waiting.delete(id);
    clearTimeout(request.timer);
    request.resolve(results ?? replyUnavailable(request.entries));
  }

  function releaseBarrier(current, retry = false) {
    if (barrier !== current) return;
    barrier = undefined;
    clearTimeout(current.timer);
    for (const { worker, gate } of current.arrivals.values()) worker.postMessage({ gate });
    if (retry) retryCutoffAt = now() + RECHECK_MS;
  }

  function computeWhenReady() {
    if (!barrier?.sent || barrier.arrivals.size !== PARTITIONS || !ranking || rankingJob) return;
    rankingJob = barrier;
    ranking.postMessage({ id: barrier.id, cutoff: barrier.cutoff });
  }

  function scheduleRestart(start) {
    if (closed) return;
    const timeout = setTimeout(() => {
      restarts.delete(timeout);
      if (!closed) start();
    }, 1000);
    restarts.add(timeout);
    timeout.unref();
  }

  function startRanking() {
    const worker = new Worker(new URL('./leaderboard-thread.mjs', import.meta.url),
      { workerData: { role: 'kafka-rankings', filename, maxTokens }, env: {} });
    ranking = worker;
    workers.add(worker);
    worker.on('message', ({ id, opened, published }) => {
      if (rankingJob?.id !== id) return;
      if (opened) {
        releaseBarrier(rankingJob);
        return;
      }
      if (published) publishedCutoff = rankingJob.cutoff;
      else {
        log('Kafka 榜单发布失败，等待补算。');
        retryCutoffAt = now() + RECHECK_MS;
      }
      releaseBarrier(rankingJob, !published);
      rankingJob = undefined;
    });
    worker.on('error', () => log('Kafka 算榜线程异常。'));
    worker.on('exit', () => {
      workers.delete(worker);
      ranking = undefined;
      if (rankingJob) releaseBarrier(rankingJob, true);
      rankingJob = undefined;
      scheduleRestart(startRanking);
    });
    computeWhenReady();
  }

  function startConsumer(index) {
    const worker = new Worker(new URL('./kafka-consumer.mjs', import.meta.url), { env: {},
      workerData: { filename, maxTokens, brokers, topic, groupId, index, partitionCount: PARTITIONS } });
    workers.add(worker);
    worker.on('message', ({ cutoff, departed, partition, gate, writes, busy, fatal }) => {
      if (fatal) return void worker.terminate();
      if (writes) {
        onWrite();
        for (const { id, results } of writes) settle(id, results);
      }
      if (busy) log(`Kafka 消费线程 ${index} 等待 SQLite 写锁。`);
      if (barrier && barrier.id === departed && barrier.arrivals.get(partition)?.worker === worker) {
        barrier.arrivals.delete(partition);
      }
      if (!cutoff) return;
      if (barrier?.id !== cutoff) {
        // A marker from a previous process or a failed publication round no longer blocks writes.
        worker.postMessage({ gate });
        return;
      }
      barrier.arrivals.set(partition, { worker, gate });
      computeWhenReady();
    });
    worker.on('error', () => log(`Kafka 消费线程 ${index} 异常。`));
    worker.on('exit', () => {
      workers.delete(worker);
      if (barrier) {
        for (const [partition, arrival] of barrier.arrivals) {
          if (arrival.worker === worker) barrier.arrivals.delete(partition);
        }
      }
      scheduleRestart(() => startConsumer(index));
    });
  }

  async function sendQueued() {
    while (!closed && queue.length) {
      const first = queue.shift();
      if (first.cutoff !== undefined) {
        if (barrier !== first) continue;
        const value = JSON.stringify({ type: 'cutoff', id: first.id, cutoff: first.cutoff });
        try {
          await producer.send({ topic, acks: -1, messages: partitionNumbers.map(partition => ({ partition, value })) });
          if (uncertainUpload) {
            uncertainUpload = false;
            releaseBarrier(first, true);
            continue;
          }
          first.sent = true;
          computeWhenReady();
        } catch {
          log('Kafka 整点标记发送失败，等待补算。');
          releaseBarrier(first, true);
        }
        continue;
      }
      const batch = [first];
      let bytes = first.message.value.length;
      while (queue[0]?.message && batch.length < 64 && bytes + queue[0].message.value.length <= MAX_SEND_BYTES) {
        const next = queue.shift();
        bytes += next.message.value.length;
        batch.push(next);
      }
      try {
        await producer.send({ topic, acks: -1, messages: batch.map(frame => frame.message) });
      } catch {
        log('Kafka 上传包入队失败。');
        uncertainUpload = true;
        for (const { id } of batch) settle(id);
      } finally {
        buffered -= batch.length;
      }
    }
  }

  function startPump() {
    if (pump || closed) return;
    pump = Promise.resolve().then(sendQueued).finally(() => {
      pump = undefined;
      if (queue.length) startPump();
    });
  }

  function queueCutoff(time) {
    if (!ready || closed || barrier || rankingJob || time < retryCutoffAt) return;
    const cutoff = hourStart(time);
    if (publishedCutoff >= cutoff) return;
    const round = { id: randomUUID(), cutoff, sent: false, arrivals: new Map() };
    round.timer = setTimeout(() => {
      log('Kafka 分区等待整点标记超时，等待补算。');
      if (rankingJob === round) void ranking.terminate();
      else releaseBarrier(round, true);
    }, 60_000);
    round.timer.unref();
    barrier = round;
    queue.push(round);
    startPump();
  }

  async function connect() {
    const admin = kafka.admin();
    try {
      await admin.connect();
      const { topics } = await admin.fetchTopicMetadata({ topics: [topic] });
      const partitions = topics[0]?.partitions.map(part => part.partitionId).sort((a, b) => a - b);
      if (partitions?.join(',') !== partitionNumbers.join(',')) throw new Error('Expected four Kafka partitions');
      if (closed) return;
      await producer.connect();
      if (closed) return;
      for (const index of partitionNumbers) startConsumer(index);
      ready = true;
      queueCutoff(now());
    } catch {
      if (!closed) {
        log('Kafka 尚未就绪，请检查连接和四分区主题。');
        scheduleRestart(() => { init = connect(); });
      }
    } finally {
      await admin.disconnect().catch(() => {});
    }
  }

  startRanking();
  init = connect();
  function schedule() {
    const time = now();
    publishedCutoff = JSON.parse(readPublished() ?? 'null')?.cutoffAt ?? -Infinity;
    queueCutoff(time);
    timer = setTimeout(schedule, Math.min(RECHECK_MS, Math.max(1, hourStart(time) + HOUR_MS - time)));
    timer.unref();
  }
  schedule();

  return {
    hourly: true,
    snapshot: readPublished,
    submit(entries, accountId) {
      if (closed || !ready || buffered >= MAX_PENDING || waiting.size >= MAX_PENDING) {
        return Promise.resolve(replyUnavailable(entries));
      }
      queueCutoff(entries[0].receivedAt);
      const id = randomUUID();
      const message = { key: uploadPartitionKey(accountId, entries),
        value: Buffer.from(JSON.stringify({ type: 'upload', id, entries })) };
      buffered++;
      queue.push({ id, message });
      startPump();
      return new Promise(resolve => {
        const timeout = setTimeout(() => settle(id), replyMs);
        waiting.set(id, { resolve, entries, timer: timeout });
      });
    },
    async close() {
      closed = true;
      clearTimeout(timer);
      for (const restart of restarts) clearTimeout(restart);
      if (barrier) releaseBarrier(barrier);
      for (const id of waiting.keys()) settle(id);
      queue.length = 0;
      const live = [...workers];
      const consumers = live.filter(worker => worker !== ranking);
      const exits = consumers.map(worker => new Promise(resolve => {
        worker.once('exit', resolve);
        worker.postMessage({ stop: true });
      }));
      await Promise.race([Promise.all(exits), sleep(6000, undefined, { ref: false })]);
      await Promise.all([...workers].map(worker => worker.terminate()));
      await Promise.race([(async () => {
        await Promise.allSettled([init, pump]);
        await producer.disconnect().catch(() => {});
      })(), sleep(2000, undefined, { ref: false })]);
    }
  };
}

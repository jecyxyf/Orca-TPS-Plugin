import { setTimeout as sleep } from 'node:timers/promises';
import { parentPort, workerData } from 'node:worker_threads';
import { Kafka, logLevel } from 'kafkajs';
import { openLeaderboardStore, writeUploadRequests } from './store.mjs';

const { filename, maxTokens, brokers, topic, groupId, index, partitionCount } = workerData;
const kafka = new Kafka({ brokers, clientId: `orca-tps-consumer-${index}`, logLevel: logLevel.NOTHING,
  connectionTimeout: 2000, requestTimeout: 5000 });
const consumer = kafka.consumer({ groupId, allowAutoTopicCreation: false, maxWaitTimeInMs: 500 });
const store = openLeaderboardStore(filename);
const waiting = new Map();
let closing = false;

parentPort.on('message', ({ gate, stop }) => {
  if (stop && !closing) {
    closing = true;
    void consumer.disconnect().catch(() => {}).finally(() => {
      store.close();
      parentPort.close();
    });
  } else if (waiting.has(gate)) waiting.set(gate, true);
});

function decode(message) {
  const payload = JSON.parse(message.value);
  if (payload?.type === 'cutoff' && typeof payload.id === 'string') return payload;
  if (payload?.type === 'upload' && typeof payload.id === 'string' && Array.isArray(payload.entries) &&
      payload.entries.length > 0) return payload;
  throw new Error('Invalid leaderboard Kafka message');
}

async function consume({ batch, heartbeat, isRunning, isStale, resolveOffset }) {
  const { partition, messages } = batch;
  const usable = () => !closing && isRunning() && !isStale();

  async function confirm(offset) {
    await consumer.commitOffsets([{ topic, partition, offset: (BigInt(offset) + 1n).toString() }]);
    resolveOffset(offset);
  }

  for (let next = 0; next < messages.length && usable();) {
    await heartbeat();
    if (!usable()) break;
    const first = decode(messages[next]);
    if (first.type === 'cutoff') {
      const offset = messages[next].offset;
      const gate = `${partition}:${offset}`;
      waiting.set(gate, false);
      parentPort.postMessage({ cutoff: first.id, partition, gate });
      try {
        while (usable() && !waiting.get(gate)) {
          await sleep(100);
          if (usable()) await heartbeat();
        }
        if (!usable()) break;
        await confirm(offset);
      } finally {
        waiting.delete(gate);
        parentPort.postMessage({ departed: first.id, partition, gate });
      }
      next++;
      continue;
    }

    const uploads = [first];
    const start = next++;
    let bytes = messages[start].value.length;
    while (next < messages.length && uploads.length < 64 && bytes + messages[next].value.length <= 1024 * 1024) {
      const upload = decode(messages[next]);
      if (upload.type === 'cutoff') break;
      uploads.push(upload);
      bytes += messages[next++].value.length;
    }

    const requests = uploads.map(upload => upload.entries);
    let results;
    let retries = 0;
    while (usable()) {
      try {
        results = writeUploadRequests(store, requests, maxTokens);
        break;
      } catch (error) {
        // SQLITE_BUSY and SQLITE_LOCKED include extended error codes.
        if (error.code !== 'ERR_SQLITE_ERROR' || ![5, 6].includes(error.errcode & 0xff)) throw error;
        if (retries++ === 0) parentPort.postMessage({ busy: true });
        await heartbeat();
        await sleep(Math.min(retries * 100, 1000));
      }
    }
    if (!results) break;
    parentPort.postMessage({ writes: uploads.map((upload, index) => ({ id: upload.id, results: results[index] })) });
    if (!usable()) break;
    await confirm(messages[next - 1].offset);
  }
}

consumer.on(consumer.events.CRASH, ({ payload }) => {
  if (!closing && !payload.restart) parentPort.postMessage({ fatal: true });
});
await consumer.connect();
if (!closing) await consumer.subscribe({ topic, fromBeginning: true });
if (!closing) await consumer.run({ eachBatch: consume, autoCommit: false, eachBatchAutoResolve: false,
  partitionsConsumedConcurrently: partitionCount });

import { parentPort, workerData } from 'node:worker_threads';
import { createPublishedSnapshot, createRankingSnapshot } from './ranking-snapshot.mjs';
import { openLeaderboardStore, writeUploadRequests } from './store.mjs';

const { filename, maxTokens, role } = workerData;
const store = openLeaderboardStore(filename, { readOnly: role === 'rankings' });

parentPort.on('message', ({ id, requests, cutoff, publish }) => {
  try {
    if (publish) {
      const { cutoffAt, generatedAt, body, revision } = publish;
      parentPort.postMessage({ id, published: store.publishHourlyResult(cutoffAt, generatedAt, body, revision) });
      return;
    }
    if (role === 'rankings' || role === 'kafka-rankings') {
      if (cutoff === undefined) parentPort.postMessage({ id, body: JSON.stringify(createRankingSnapshot(store)) });
      else {
        const { snapshot, revision } = createPublishedSnapshot(store, cutoff, () => parentPort.postMessage({ id, opened: true }));
        const generatedAt = Date.now();
        const body = JSON.stringify({ ...snapshot, generatedAt });
        if (role === 'kafka-rankings') {
          parentPort.postMessage({ id, published: store.publishHourlyResult(cutoff, generatedAt, body, revision) });
        } else {
          parentPort.postMessage({ id, publish: { cutoffAt: cutoff, generatedAt, revision, body } });
        }
      }
      return;
    }
    parentPort.postMessage({ id, results: writeUploadRequests(store, requests, maxTokens) });
  } catch {
    parentPort.postMessage({ id, failed: true });
  }
});

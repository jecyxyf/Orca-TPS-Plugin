import { parentPort, workerData } from 'node:worker_threads';
import { createPublishedSnapshot, createRankingSnapshot } from './ranking-snapshot.mjs';
import { openLeaderboardStore } from './store.mjs';

const { filename, maxTokens, role } = workerData;
const store = openLeaderboardStore(filename, { readOnly: role === 'rankings' });

parentPort.on('message', ({ id, requests, cutoff, publish }) => {
  try {
    if (publish) {
      const { cutoffAt, generatedAt, body, revision } = publish;
      parentPort.postMessage({ id, published: store.publishHourlyResult(cutoffAt, generatedAt, body, revision) });
      return;
    }
    if (role === 'rankings') {
      if (cutoff === undefined) parentPort.postMessage({ id, body: JSON.stringify(createRankingSnapshot(store)) });
      else {
        const { snapshot, revision } = createPublishedSnapshot(store, cutoff, () => parentPort.postMessage({ id, opened: true }));
        const generatedAt = Date.now();
        parentPort.postMessage({ id, publish: { cutoffAt: cutoff, generatedAt, revision,
          body: JSON.stringify({ ...snapshot, generatedAt }) } });
      }
      return;
    }
    const responses = store.uploadBatch(requests.flat(), maxTokens);
    let offset = 0;
    const results = requests.map(entries => {
      const result = responses.slice(offset, offset + entries.length);
      offset += entries.length;
      return result;
    });
    parentPort.postMessage({ id, results });
  } catch {
    parentPort.postMessage({ id, failed: true });
  }
});

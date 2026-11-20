import { parentPort, workerData } from 'node:worker_threads';
import { createRankingSnapshot } from './ranking-snapshot.mjs';
import { openLeaderboardStore } from './store.mjs';

const { filename, maxTokens, role } = workerData;
const store = openLeaderboardStore(filename, { readOnly: role === 'rankings' });

parentPort.on('message', ({ id, requests }) => {
  try {
    if (role === 'rankings') {
      parentPort.postMessage({ id, body: JSON.stringify(createRankingSnapshot(store)) });
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

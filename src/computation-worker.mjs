import { parentPort } from 'node:worker_threads';
import { readActiveConversation } from './active-conversation.mjs';

parentPort.on('message', async ({ id, operation, args }) => {
  try {
    if (operation !== 'active') throw new Error('Unknown TPS computation operation');
    const result = await readActiveConversation(...args);
    parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({ id, error: { message: error?.message ?? String(error), code: error?.code } });
  }
});

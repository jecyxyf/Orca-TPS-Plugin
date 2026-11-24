import { parentPort } from 'node:worker_threads';
import { readActiveConversation } from './active-conversation.mjs';
import { createLiveSessionReader, discoverUsageUnits, usageRecordPage } from './harness_parser.mjs';
import { readSshTargets } from './remote-channel.mjs';

const live = createLiveSessionReader();
let usageUnits = new Map();
let recordRead;

const operations = {
  active: readActiveConversation,
  live: live.read,
  sshTargets: readSshTargets,
  async discover(cutoff, options) {
    let complete = true;
    const units = await discoverUsageUnits(cutoff, { ...options, onUnavailable: () => { complete = false; } });
    usageUnits = new Map(units.map(unit => [unit.key, unit]));
    recordRead = undefined;
    const descriptors = units.map(({ key, stamp, bytes, mtimeMs }) => ({ key, stamp, bytes, mtimeMs }));
    return { descriptors, complete };
  },
  async usage(key, stamp) {
    const unit = usageUnits.get(key);
    if (unit?.stamp !== stamp) throw new Error('TPS usage source changed');
    return unit.read();
  },
  async usageRecords(key, stamp, offset) {
    const unit = usageUnits.get(key);
    if (!unit || unit.stamp !== stamp) throw new Error('TPS usage source changed');
    if (offset === 0) recordRead = { unit, result: await unit.read() };
    if (recordRead?.unit !== unit) throw new Error('TPS usage scan changed');
    const page = usageRecordPage(recordRead.result, offset);
    if (page.nextOffset === null) recordRead = undefined;
    return page;
  }
};

parentPort.on('message', async ({ id, operation, args }) => {
  try {
    const result = await operations[operation](...args);
    parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({ id, error: { message: error?.message ?? String(error), code: error?.code } });
  }
});

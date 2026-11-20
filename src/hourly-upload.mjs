import { createHash, randomUUID } from 'node:crypto';
import { HOUR_MS, RANKING_HOURS, hourStart } from './leaderboard-stats.mjs';

const BODY_LIMIT = 4096;

export async function uploadHourChanges({ storage, identity, installationId, now, readHours, send, active }) {
  const key = 'leaderboard:hours:' + createHash('sha256').update(identity).digest('hex').slice(0, 24);
  const saved = await storage.get(key);
  if (!active()) return;
  const state = saved ?? { version: 0, acknowledged: [], coverage: null, pending: null };
  const cutoff = hourStart(now), oldest = cutoff - RANKING_HOURS.at(-1) * HOUR_MS;
  const acknowledged = new Map(state.acknowledged.filter(([at]) => at >= oldest));
  let pending = state.pending;
  if (!pending) {
    const view = await readHours();
    if (!active() || !view) return;
    const { buckets, coverage } = view;
    const values = new Map(buckets);
    if (coverage) {
      for (const at of acknowledged.keys()) {
        if (at >= coverage[0] && at < coverage[1] && !values.has(at)) values.set(at, 0);
      }
    }
    const changes = [...values].filter(([at, tokens]) => at >= oldest && at <= cutoff && (acknowledged.get(at) ?? 0) !== tokens)
      .sort((a, b) => b[0] - a[0]);
    const coverageChanged = coverage && (coverage[0] !== state.coverage?.[0] || coverage[1] !== state.coverage?.[1]);
    if (!changes.length && !coverageChanged) return;
    const body = { installationId, version: Math.max(state.version + 1, now), buckets: [] };
    for (const row of changes) {
      body.buckets.push(row);
      if (Buffer.byteLength(JSON.stringify(body)) > BODY_LIMIT) {
        body.buckets.pop();
        break;
      }
    }
    if (coverageChanged && body.buckets.length === changes.length) {
      body.coverage = coverage;
      if (Buffer.byteLength(JSON.stringify(body)) > BODY_LIMIT) delete body.coverage;
    }
    pending = { requestId: randomUUID(), body };
    await storage.set(key, { ...state, acknowledged: [...acknowledged], pending });
  }
  if (!active()) return;
  const result = await send(pending);
  if (result.code === 'accepted' && result.version === pending.body.version) {
    for (const [at, tokens] of pending.body.buckets) if (at >= oldest) acknowledged.set(at, tokens);
    await storage.set(key, { version: result.version, acknowledged: [...acknowledged],
      coverage: pending.body.coverage ?? state.coverage, pending: null });
  } else if (result.code === 'stale_version' && Number.isSafeInteger(result.version) && result.version >= pending.body.version) {
    await storage.set(key, { version: result.version, acknowledged: [], coverage: null, pending: null });
  } else if (result.code === 'invalid') {
    await storage.set(key, { ...state, version: pending.body.version, pending: null });
  }
  return result.code;
}

import { createHash, randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { HOUR_MS, RANKING_HOURS, USAGE_UPLOAD_BYTES } from './leaderboard-stats.mjs';

export async function uploadUsageChanges({ storage, identity, installationId, now, readUsageTimes, send, active }) {
  const key = 'leaderboard:rolling-upload:' + createHash('sha256').update(identity).digest('hex').slice(0, 24);
  const saved = await storage.get(key);
  if (!active()) return;
  const state = saved ? JSON.parse(gunzipSync(Buffer.from(saved, 'base64')).toString('utf8'))
    : { version: 0, acknowledged: [], coverage: null, pending: null };
  const save = next => storage.set(key, gzipSync(JSON.stringify(next)).toString('base64'));
  const oldest = now - RANKING_HOURS.at(-1) * HOUR_MS;
  const acknowledged = new Map(state.acknowledged.filter(([at]) => at >= oldest));
  let pending = state.pending;
  if (!pending) {
    const view = await readUsageTimes();
    if (!active() || !view) return;
    const { buckets, coverage } = view;
    const values = new Map(buckets);
    if (coverage) {
      for (const at of acknowledged.keys()) {
        if (at >= coverage[0] && at < coverage[1] && !values.has(at)) values.set(at, 0);
      }
    }
    const changes = [...values].filter(([at, tokens]) => at >= oldest && at <= now && (acknowledged.get(at) ?? 0) !== tokens)
      .sort((a, b) => b[0] - a[0]);
    const coverageChanged = coverage && (coverage[0] !== state.coverage?.[0] || coverage[1] !== state.coverage?.[1]);
    if (!changes.length && !coverageChanged) return;
    const body = { installationId, version: Math.max(state.version + 1, now), buckets: [] };
    let bytes = Buffer.byteLength(JSON.stringify(body));
    for (const row of changes) {
      const size = Buffer.byteLength(JSON.stringify(row)) + (body.buckets.length ? 1 : 0);
      if (bytes + size > USAGE_UPLOAD_BYTES) break;
      body.buckets.push(row);
      bytes += size;
    }
    if (coverageChanged && body.buckets.length === changes.length) {
      body.coverage = coverage;
      if (Buffer.byteLength(JSON.stringify(body)) > USAGE_UPLOAD_BYTES) delete body.coverage;
    }
    pending = { requestId: randomUUID(), body };
    await save({ ...state, acknowledged: [...acknowledged], pending });
  }
  if (!active()) return;
  const result = await send(pending);
  if (result.code === 'accepted' && result.version === pending.body.version) {
    for (const [at, tokens] of pending.body.buckets) if (at >= oldest) acknowledged.set(at, tokens);
    await save({ version: result.version, acknowledged: [...acknowledged],
      coverage: pending.body.coverage ?? state.coverage, pending: null });
  } else if (result.code === 'stale_version' && Number.isSafeInteger(result.version) && result.version >= pending.body.version) {
    await save({ version: result.version, acknowledged: [], coverage: null, pending: null });
  } else if (result.code === 'invalid') {
    await save({ ...state, version: pending.body.version, pending: null });
  }
  return result.code;
}

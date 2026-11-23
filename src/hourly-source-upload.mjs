import { randomUUID } from 'node:crypto';
import { HOUR_MS, RANKING_HOURS, USAGE_UPLOAD_BYTES, hourStart } from './leaderboard-stats.mjs';

const MAX_SPAN = RANKING_HOURS.at(-1) * HOUR_MS;
const receiptKey = source => 'hourly-source:' + source;

export function createHourlySourceUploader(storage, reporterId, username) {
  const leases = new Map();
  let cursor = 0;

  return async ({ read, send, prepareStats, active, now }) => {
    let pending = await storage.journal.load();
    if (!pending) {
      const views = await read(reporterId);
      if (!active()) return { code: 'upload_disabled' };
      for (let i = 0; i < views.length; i++) {
        const index = (cursor + i) % views.length;
        const { sourceId, hours, observedAt } = views[index];
        const remote = sourceId !== reporterId;
        const lease = remote ? leases.get(sourceId) : null;
        const data = { format: 4, requestId: randomUUID(), ...(remote ? { reporterGuid: reporterId } : {}) };
        const body = { username: username(), deviceGuid: sourceId, data };
        if (remote && (!lease || lease.expiresAt <= now || (!lease.standby && lease.expiresAt - now <= 30_000 &&
            observedAt > lease.observedAt))) {
          if (!Number.isSafeInteger(observedAt) || observedAt <= now - 60_000) continue;
          Object.assign(data, { operation: 'lease', observedAt });
        } else {
          if (lease?.standby) continue;
          const state = await storage.readReceipt(receiptKey(sourceId)) ?? {};
          const from = hourStart(now) - MAX_SPAN;
          const changes = [];
          for (const hour of hours) {
            if (hour.hour < from) continue;
            const old = state[hour.hour];
            if (old?.rescanAt >= hour.updatedAt) continue;
            const complete = hour.coveredUntil === hour.hour + HOUR_MS;
            if (old && old.rescanAt == null && (!remote || old.epoch === lease.epoch) &&
                old.tokens === hour.tokens && (!complete || old.coveredUntil === hour.coveredUntil)) continue;
            changes.push({ ...hour, updatedAt: Math.max(hour.updatedAt, (old?.after ?? 0) + 1) });
          }
          if (!changes.length) continue;
          Object.assign(data, { operation: 'hourly-update', hours: [], ...(lease ? { leaseEpoch: lease.epoch } : {}) });
          const sample = await prepareStats?.(sourceId);
          if (!active()) return { code: 'upload_disabled' };
          if (sample?.body.stats) data.sample = { id: sample.requestId, at: sample.sampledAt ?? now, ...sample.body.stats };
          let bytes = Buffer.byteLength(JSON.stringify(body));
          for (const row of changes) {
            bytes += Buffer.byteLength(JSON.stringify(row)) + (data.hours.length ? 1 : 0);
            if (bytes > USAGE_UPLOAD_BYTES) break;
            data.hours.push(row);
          }
          if (!data.hours.length) continue;
          pending = { body, observedHours: Object.fromEntries(hours.map(row => [row.hour, row.updatedAt])) };
        }
        pending ??= { body };
        cursor = data.operation === 'lease' ? index : (index + 1) % views.length;
        await storage.journal.save(pending, now);
        break;
      }
    }
    if (!pending) return { code: 'usage_unready' };
    if (!active()) return { code: 'upload_disabled' };
    const result = await send(pending.body);
    if (!active()) return { code: 'upload_disabled' };
    if (['unavailable', 'too_soon', 'rate_limited'].includes(result.code)) return result;
    const { deviceGuid, data } = pending.body;
    const updates = new Map();
    if (data.operation === 'lease' && ['accepted', 'standby'].includes(result.code)) {
      leases.set(deviceGuid, { expiresAt: result.expiresAt, epoch: result.leaseEpoch, observedAt: data.observedAt,
        standby: result.code === 'standby' });
    } else if (data.operation === 'hourly-update' && ['accepted', 'rescan'].includes(result.code)) {
      const old = await storage.readReceipt(receiptKey(deviceGuid)) ?? {};
      const from = hourStart(now) - MAX_SPAN;
      const state = Object.fromEntries(Object.entries(old).filter(([hour]) => Number(hour) >= from));
      const requested = new Map((result.rescans ?? []).map(row => [row.hour, row.updatedAt]));
      for (const { hour, tokens, coveredUntil } of data.hours) {
        state[hour] = requested.has(hour)
          ? { after: requested.get(hour), rescanAt: pending.observedHours[hour] }
          : { tokens, coveredUntil, epoch: data.leaseEpoch };
      }
      updates.set(receiptKey(deviceGuid), state);
    } else if (result.code === 'lease_expired') leases.delete(deviceGuid);
    await storage.journal.finish(pending, updates, now);
    return { ...result, ...(result.sampleAccepted ? { statsAccepted: true, statsId: data.sample?.id } : {}) };
  };
}

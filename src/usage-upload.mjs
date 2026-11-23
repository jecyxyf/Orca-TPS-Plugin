import { createHash, randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { HOUR_MS, RANKING_HOURS, USAGE_UPLOAD_BYTES } from './leaderboard-stats.mjs';

const RECEIPT_CHUNK_SIZE = 32 * 1024;
const encoded = value => gzipSync(JSON.stringify(value)).toString('base64');
const decoded = value => value ? JSON.parse(gunzipSync(Buffer.from(value, 'base64')).toString('utf8')) : null;
const hash = value => createHash('sha256').update(value).digest('hex');
const receiptChunks = (key, { chunks, generation }) => Array.from({ length: chunks }, (_, index) =>
  `${key}:${generation}:${index}`);

async function readReceipt(storage, key) {
  if (storage.readReceipt) return storage.readReceipt(key);
  const head = await storage.get(key);
  if (!head?.chunks) return decoded(head);
  const parts = await Promise.all(receiptChunks(key, head).map(chunk => storage.get(chunk)));
  return decoded(parts.join(''));
}

async function writeReceipt(storage, key, receipt) {
  if (storage.writeReceipt) return storage.writeReceipt(key, receipt);
  const previous = await storage.get(key);
  const data = encoded(receipt);
  if (data.length <= RECEIPT_CHUNK_SIZE) await storage.set(key, data);
  else {
    const head = { generation: randomUUID(), chunks: Math.ceil(data.length / RECEIPT_CHUNK_SIZE) };
    const saved = [];
    let publishing = false;
    try {
      for (const [index, chunk] of receiptChunks(key, head).entries()) {
        saved.push(chunk);
        await storage.set(chunk, data.slice(index * RECEIPT_CHUNK_SIZE, (index + 1) * RECEIPT_CHUNK_SIZE));
      }
      // Keep the old receipt readable until every chunk of the new one has been saved.
      publishing = true;
      await storage.set(key, head);
    } catch (error) {
      const published = publishing && (await storage.get(key))?.generation === head.generation;
      if (!published) {
        await Promise.allSettled(saved.map(chunk => storage.delete(chunk)));
        throw error;
      }
    }
  }
  if (previous?.chunks) await Promise.allSettled(receiptChunks(key, previous).map(chunk => storage.delete(chunk)));
}

export function createSqliteUploadStorage(queue, scope, pendingState = 'pending') {
  const packetScope = pending => ({ ...scope, deviceGuid: pending.body.deviceGuid ??
    pending.body.operations?.[0]?.sourceId ?? pending.body.reporterId });
  const packetId = pending => pending.body.data?.requestId ?? pending.body.requestId;
  return {
    get: key => queue.read(scope, key),
    set: (key, value) => queue.write(scope, key, value),
    delete: key => queue.remove(scope, key),
    readReceipt: key => queue.read(scope, key),
    writeReceipt: (key, value) => queue.write(scope, key, value),
    journal: {
      load: () => queue.next(scope, pendingState)?.value,
      save: (pending, now) => queue.write(packetScope(pending), packetId(pending), pending, { state: pendingState, now }),
      finish(pending, updates, now) {
        return queue.atomic(() => {
          for (const [key, receipt] of updates) queue.write(scope, key, receipt, { now });
          queue.remove(packetScope(pending), packetId(pending));
        });
      }
    }
  };
}

export async function uploadUsageChanges({ storage, identity, installationId, now, readUsageTimes, send, active }) {
  if (!active()) return;
  const key = 'leaderboard:rolling-upload:' + hash(identity).slice(0, 24);
  const state = await readReceipt(storage, key) ?? { version: 0, acknowledged: [], coverage: null, pending: null };
  if (!active()) return;
  const save = next => writeReceipt(storage, key, next);
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
  if (result.code === 'accepted') {
    if (result.version !== pending.body.version) return 'unavailable';
    for (const [at, tokens] of pending.body.buckets) if (at >= oldest) acknowledged.set(at, tokens);
    await save({ version: result.version, acknowledged: [...acknowledged],
      coverage: pending.body.coverage ?? state.coverage, pending: null });
  } else if (result.code === 'stale_version' && Number.isSafeInteger(result.version) && result.version >= pending.body.version) {
    await save({ version: result.version, acknowledged: [], coverage: null, pending: null });
  } else if (result.code === 'invalid') {
    await save({ ...state, version: pending.body.version, pending: null });
  }
  return result.code ?? 'unavailable';
}

const SOURCE_SPAN = RANKING_HOURS.at(-1) * HOUR_MS;
const SOURCE_PART_BYTES = USAGE_UPLOAD_BYTES - 4096;
const emptyReceipt = () => ({ revision: 0, epoch: 0, daily: [], buckets: [], coverage: null });

function sourceSnapshot(source, reporter, purpose, leaseEpoch, coverage = source.coverage) {
  const { sourceId, sourceKind, daily, buckets } = source;
  const filtered = buckets.filter(([at]) => at >= coverage[0] && at < coverage[1]);
  const key = hash(JSON.stringify([reporter, sourceId, purpose, leaseEpoch, coverage, daily, filtered]));
  const snapshotId = `${key.slice(0, 8)}-${key.slice(8, 12)}-4${key.slice(13, 16)}-8${key.slice(17, 20)}-${key.slice(20, 32)}`;
  const first = { type: 'baseline-part', sourceId, sourceKind, purpose, snapshotId, coverage,
    ...(leaseEpoch === undefined ? {} : { leaseEpoch }),
    daily, buckets: [] };
  const parts = [first];
  let part = first, bytes = Buffer.byteLength(JSON.stringify(part));
  for (const row of filtered) {
    const size = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (bytes + size > SOURCE_PART_BYTES) {
      part = { ...first, daily: [], buckets: [] };
      parts.push(part);
      bytes = Buffer.byteLength(JSON.stringify(part));
    }
    part.buckets.push(row);
    bytes += size;
  }
  parts.forEach((item, partIndex) => Object.assign(item, { partIndex, partCount: parts.length }));
  return { snapshotId, parts, coverage };
}

function sourceChanges(view, receipt, lease, now) {
  const { sourceId, sourceKind, coverage } = view;
  const days = new Map(view.daily.map(({ day, tokens }) => [day, tokens]));
  const recent = new Map(view.buckets.filter(([at]) => at >= now - SOURCE_SPAN && at <= now));
  const priorDays = new Map(receipt.daily.map(({ day, tokens }) => [day, tokens]));
  const priorBuckets = new Map(receipt.buckets);
  if (coverage) {
    for (const day of priorDays.keys()) {
      if (Date.parse(day + 'T00:00:00+08:00') >= coverage[0] && !days.has(day)) days.set(day, 0);
    }
    for (const at of priorBuckets.keys()) {
      if (at >= coverage[0] && at < coverage[1] && !recent.has(at)) recent.set(at, 0);
    }
  }
  const daily = [...days].filter(([day, tokens]) => {
    const previous = priorDays.get(day);
    return (coverage || previous === undefined) && tokens !== (previous ?? 0);
  }).map(([day, tokens]) => ({ day, tokens }));
  const changes = [...recent].filter(([at, tokens]) => {
    const previous = priorBuckets.get(at);
    return (coverage || previous === undefined) && tokens !== (previous ?? 0);
  });
  const coverageChanged = coverage && (!receipt.coverage || coverage[1] > receipt.coverage[1]);
  if (!daily.length && !changes.length && !coverageChanged) return;
  const body = { type: 'update', sourceId, sourceKind, revision: Math.max(receipt.revision + 1, (lease?.revision ?? 0) + 1, now),
    ...(lease ? { leaseEpoch: lease.epoch } : {}), daily, buckets: [] };
  let bytes = Buffer.byteLength(JSON.stringify(body));
  for (const row of changes) {
    bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
    if (bytes > SOURCE_PART_BYTES) break;
    body.buckets.push(row);
  }
  if (coverageChanged && changes.length === body.buckets.length) body.coverage = coverage;
  return { body, remaining: changes.length !== body.buckets.length };
}

export function createSourceUploader(storage, identity, reporterId, { format = 2, username = () => '' } = {}) {
  const key = 'leaderboard:sources:' + hash(identity).slice(0, 24);
  const receipts = new Map(), leases = new Map(), handovers = new Map(), migrations = new Map();
  const restage = new Set();
  const journal = storage.journal;
  let pending, mode, stateLoaded = false, cursor = 0, leaseCursor = 0, previousWasLease = false;

  async function receiptFor(sourceId) {
    if (!receipts.has(sourceId)) {
      receipts.set(sourceId, await readReceipt(storage, `${key}:${sourceId}`) ?? emptyReceipt());
    }
    return receipts.get(sourceId);
  }

  async function saveReceipt(sourceId, receipt, updates) {
    if (journal) {
      updates.set(sourceId, receipt);
      return;
    }
    await writeReceipt(storage, `${key}:${sourceId}`, receipt);
    receipts.set(sourceId, receipt);
  }

  async function acknowledge(operation, result, now, updates, previous) {
    const { sourceId, revision, coverage } = operation;
    previous ??= updates.get(sourceId) ?? await receiptFor(sourceId);
    const daily = new Map(previous.daily.filter(row => Date.parse(row.day + 'T00:00:00+08:00') >= now - SOURCE_SPAN - 24 * HOUR_MS)
      .map(row => [row.day, row.tokens]));
    for (const row of operation.daily) row.tokens ? daily.set(row.day, row.tokens) : daily.delete(row.day);
    const buckets = new Map(previous.buckets.filter(([at]) => at >= now - SOURCE_SPAN));
    for (const [at, tokens] of operation.buckets) tokens ? buckets.set(at, tokens) : buckets.delete(at);
    await saveReceipt(sourceId, { revision: result.revision ?? revision, epoch: operation.leaseEpoch ?? 0,
      coverage: coverage ?? previous.coverage, daily: [...daily].map(([day, tokens]) => ({ day, tokens })), buckets: [...buckets] }, updates);
  }

  function migrationOperations(status, views, now) {
    const staged = status.staged ?? [];
    const ours = staged.filter(item => item.reporterId === reporterId);
    const available = new Set(views.map(view => view.sourceId));
    for (const view of views) {
      if (!view.coverage) continue;
      const existing = ours.find(item => item.sourceId === view.sourceId && item.end > now - SOURCE_SPAN);
      if (existing && existing.received === existing.partCount && !restage.has(view.sourceId)) continue;
      let snapshot = migrations.get(view.sourceId);
      if (!snapshot && existing && !restage.has(view.sourceId)) {
        const reconstructed = sourceSnapshot(view, reporterId, 'migration', undefined, [existing.start, existing.end]);
        if (reconstructed.snapshotId === existing.snapshotId) snapshot = reconstructed;
      }
      if (!snapshot || snapshot.coverage[1] <= now - SOURCE_SPAN) snapshot = sourceSnapshot(view, reporterId, 'migration');
      migrations.set(view.sourceId, snapshot);
      const received = existing?.snapshotId === snapshot.snapshotId ? new Set(existing.indexes.split(',').map(Number)) : new Set();
      const part = snapshot.parts.find(item => !received.has(item.partIndex));
      if (part) return [part];
      restage.delete(view.sourceId);
    }
    const completed = staged.filter(item => item.received === item.partCount && item.end > now - SOURCE_SPAN &&
      (item.reporterId !== reporterId || available.has(item.sourceId) || item.sourceKind === 'ssh'));
    if (!completed.length || !status.devices.every(device => completed.some(item =>
      item.reporterId === device.reporterId && item.sourceKind === 'local'))) return [];
    return [{ type: 'migration-commit', legacyVersions: status.legacyVersions, snapshots: completed.map(item => item.snapshotId) }];
  }

  async function liveOperations(views, now) {
    const operations = [], selections = [];
    let more = false;
    for (const view of views) {
      const { sourceId, sourceKind, observedAt } = view;
      if (!Number.isSafeInteger(observedAt) || (sourceKind === 'ssh' && observedAt <= now - 60_000)) {
        more = true;
        continue;
      }
      const lease = leases.get(sourceId);
      if (sourceKind === 'ssh' && observedAt > now - 60_000 &&
          (!lease || (lease.expiresAt <= now && (lease.standby || lease.observed < observedAt)) ||
            (!lease.standby && lease.observed < observedAt && lease.expiresAt - now <= 30_000))) {
        operations.push({ type: 'lease', sourceId, observedAt });
      }
      if (sourceKind === 'ssh' && (!lease || lease.expiresAt <= now || lease.standby)) {
        more ||= !lease || lease.expiresAt <= now;
        continue;
      }
      if (sourceKind === 'ssh' && lease.baseline) {
        more = true;
        let stage = handovers.get(sourceId);
        if (!stage && view.coverage) {
          stage = { ...sourceSnapshot(view, reporterId, 'handover', lease.epoch), index: 0 };
          handovers.set(sourceId, stage);
        }
        if (stage) selections.push({ body: stage.parts[stage.index] ?? {
          type: 'baseline-commit', sourceId, snapshotId: stage.snapshotId, leaseEpoch: lease.epoch, coverage: stage.coverage
        } });
        continue;
      }
      let receipt = await receiptFor(sourceId);
      if (lease && lease.epoch !== receipt.epoch) receipt = emptyReceipt();
      const update = sourceChanges(view, receipt, lease, now);
      if (update) selections.push(update);
    }
    if (format === 3) {
      if (operations.length && (!previousWasLease || !selections.length)) {
        previousWasLease = true;
        return { operations: [operations[leaseCursor++ % operations.length]], more: more || selections.length > 0 };
      }
      previousWasLease = false;
      const selection = selections.length && selections[cursor++ % selections.length];
      return { operations: selection ? [selection.body] : [],
        more: more || Boolean(selection?.remaining) || selections.some(other => other !== selection &&
          (other.body.type !== 'update' || other.body.daily.length || other.body.buckets.length)) ||
          views.some(view => !view.coverage) };
    }
    // Rotate the first source so a long snapshot cannot delay uploads from this computer.
    let remaining = selections.length;
    for (let index = 0; index < selections.length; index++) {
      const candidate = selections[(cursor + index) % selections.length];
      if (operations.length >= 63 || Buffer.byteLength(JSON.stringify([...operations, candidate.body])) > SOURCE_PART_BYTES + 2048) break;
      operations.push(candidate.body);
      remaining--;
      more ||= Boolean(candidate.remaining);
    }
    cursor += selections.length - remaining;
    return { operations: operations.slice(0, 64), more: more || remaining > 0 || views.some(view => !view.coverage) };
  }

  return async function upload({ now, read, send, active, stats, statsId, prepareStats }) {
    if (!stateLoaded) {
      pending = journal ? await journal.load() : decoded(await storage.get(key));
      stateLoaded = true;
    }
    if (!active()) return { code: 'upload_disabled' };
    if (journal && pending?.createdAt < now - SOURCE_SPAN) {
      await journal.finish(pending, new Map(), now);
      pending = null;
    }
    if (!pending) {
      const views = await read(reporterId);
      if (!active()) return { code: 'upload_disabled' };
      if (!mode || mode.mode === 'migration') {
        const reply = await send({ format: 2, reporterId, requestId: randomUUID(), operations: [{ type: 'migration-status' }] });
        if (!active()) return { code: 'upload_disabled' };
        mode = reply.results?.[0];
        if (!mode?.mode) return { ...reply, code: mode?.code ?? reply.code ?? 'unavailable' };
      }
      let operations, more = false;
      if (mode.mode === 'migration') {
        operations = migrationOperations(mode, views, now);
        more = true;
      } else ({ operations, more } = await liveOperations(views, now));
      if (!operations.length) return { code: more || !views.length ? 'usage_unready' : 'accepted' };
      const requestId = randomUUID();
      let body = { format: 2, reporterId, requestId, operations };
      const ranking = operations.find(op => ['update', 'baseline-commit', 'migration-commit'].includes(op.type));
      if (ranking) {
        const sample = ranking.sourceId && prepareStats ? await prepareStats(ranking.sourceId) : null;
        if (!active()) return { code: 'upload_disabled' };
        const details = sample?.body.stats ?? stats;
        if (details) Object.assign(body, { stats: details, statsId: sample?.requestId ?? statsId });
      }
      if (format === 3 && operations[0].type !== 'migration-commit') {
        const { type, sourceId, sourceKind, ...fields } = operations[0];
        body = { username: username(), deviceGuid: sourceId, data: { format: 3, operation: type, requestId,
          ...(reporterId !== sourceId ? { reporterGuid: reporterId } : {}), ...fields,
          ...(body.stats ? { stats: body.stats, statsId: body.statsId } : {}) } };
      }
      if (Buffer.byteLength(JSON.stringify(body)) > USAGE_UPLOAD_BYTES) {
        return { code: 'unavailable' };
      }
      const prepared = { body, operations, more, createdAt: now };
      const handover = operations.find(op => op.type === 'baseline-commit');
      if (journal && handover) {
        const stage = handovers.get(handover.sourceId);
        if (stage) prepared.baseline = { coverage: stage.coverage, daily: stage.parts.flatMap(item => item.daily),
          buckets: stage.parts.flatMap(item => item.buckets) };
      }
      if (journal) await journal.save(prepared, now);
      else await storage.set(key, encoded(prepared));
      pending = prepared;
    }
    if (!active()) return { code: 'upload_disabled' };
    const response = await send(pending.body);
    if (!active()) return { code: 'upload_disabled' };
    if (response.code === 'unavailable') return response;
    const before = pending;
    const { results } = response;
    const operations = before.operations ?? before.body.operations;
    const updates = new Map();
    let problem = before.more ? 'usage_unready' : null, savedRanking = false, retryAt = response.nextUploadAt ?? 0;
    if (Array.isArray(results) && results.length === operations.length) {
      for (const [index, op] of operations.entries()) {
        const entry = results[index], { sourceId } = op;
        if (op.type === 'lease' && ['accepted', 'standby'].includes(entry.code)) {
          const previous = leases.get(sourceId);
          if (previous?.epoch !== entry.leaseEpoch) handovers.delete(sourceId);
          leases.set(sourceId, { observed: op.observedAt, expiresAt: entry.expiresAt, standby: entry.code === 'standby',
            baseline: entry.baseline, epoch: entry.leaseEpoch, revision: entry.revision });
        } else if (entry.code === 'accepted') {
          if (op.type === 'update') {
            await acknowledge(op, entry, now, updates);
            savedRanking = true;
          } else if (op.type === 'baseline-part') {
            if (op.purpose === 'migration' && op.partIndex + 1 === op.partCount) restage.delete(sourceId);
            else if (handovers.get(sourceId)?.snapshotId === op.snapshotId) handovers.get(sourceId).index = op.partIndex + 1;
          } else if (op.type === 'baseline-commit') {
            const stage = handovers.get(sourceId);
            const baseline = before.baseline ?? (stage && { coverage: stage.coverage, daily: stage.parts.flatMap(item => item.daily),
              buckets: stage.parts.flatMap(item => item.buckets) });
            if (baseline) {
              await acknowledge({ ...baseline, sourceId, revision: entry.revision, leaseEpoch: op.leaseEpoch },
                entry, now, updates, emptyReceipt());
            }
            handovers.delete(sourceId);
            if (leases.has(sourceId)) leases.get(sourceId).baseline = false;
            savedRanking = true;
          } else if (op.type === 'migration-commit') {
            mode = entry;
            migrations.clear();
            restage.clear();
            problem = null;
            savedRanking = true;
          }
        } else {
          retryAt = Math.max(retryAt, entry.nextUploadAt ?? 0);
          problem = entry.code;
          if (entry.code === 'migration_required' || entry.code === 'migration_changed') mode = null;
          if (entry.code === 'migration_pending') {
            const affected = new Set(entry.devices?.map(item => item.reporterId));
            if (affected.has(reporterId)) {
              for (const item of mode?.staged ?? []) if (item.reporterId === reporterId) restage.add(item.sourceId);
              migrations.clear();
            }
          }
          if (entry.code === 'lease_expired' || entry.code === 'baseline_required') {
            leases.delete(sourceId);
            handovers.delete(sourceId);
          }
          if (entry.code === 'stale_version' && op.type === 'update') {
            const before = await receiptFor(sourceId);
            await saveReceipt(sourceId, { ...before, revision: entry.revision }, updates);
          }
        }
      }
    } else problem = response.code ?? 'unavailable';
    if (journal) {
      await journal.finish(before, new Map([...updates].map(([id, value]) => [`${key}:${id}`, value])), now);
      for (const [id, value] of updates) receipts.set(id, value);
    } else await storage.delete(key);
    pending = null;
    const submittedStats = before.body.data?.statsId ?? before.body.statsId;
    return { ...response, code: problem && !savedRanking ? problem : response.code,
      ...(problem && savedRanking ? { rollingCode: problem } : {}), nextUploadAt: retryAt,
      ...(submittedStats ? { statsId: submittedStats, statsAccepted: savedRanking } : {}) };
  };
}

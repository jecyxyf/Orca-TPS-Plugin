import { createHash } from 'node:crypto';
import { MANAGER_HARNESSES, recentRecords } from './harness_parser.mjs';

const PROVIDERS = new Set([...MANAGER_HARNESSES, 'opencode2']);
const NUMBERS = [
  'completedAt', 'createdAtSec', 'freshInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens',
  'durationMs', 'firstTokenMs', 'generationMs', 'tokensPerSecond', 'cacheHitRate'
];
const clean = value => typeof value === 'string' && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value);
const hermesModelId = /^[a-z\d][a-z\d._-]*\/[a-z\d][a-z\d._:-]*$/i;

function panelRecord(record) {
  if (!record || !PROVIDERS.has(record.provider) || !Number.isFinite(record.completedAt) || record.completedAt < 0 ||
    typeof record.id !== 'string' || !record.id) return null;
  const result = {
    id: createHash('sha256').update(record.id).digest('hex').slice(0, 24),
    provider: record.provider,
    dataSource: record.dataSource === 'proxy' || (record.provider === 'hermes' && record.dataSource === 'hermes_log')
      ? record.dataSource : 'session_log'
  };
  for (const field of NUMBERS) {
    if (Number.isFinite(record[field]) && record[field] >= 0) result[field] = record[field];
  }
  if (result.cacheHitRate > 1) delete result.cacheHitRate;
  if (clean(record.model) && record.model.length <= 128 &&
      (!/[/\\]/.test(record.model) || (record.provider === 'hermes' && hermesModelId.test(record.model)))) {
    result.model = record.model;
  }
  if (record.isEstimatedSpeed === true) result.isEstimatedSpeed = true;
  if (record.isSubagent === true) result.isSubagent = true;
  return result;
}

const PREFIX = 'tps:channel:v1:';
const MEMORY_LIMIT = 64;
const cleanRecords = records => recentRecords(records.map(panelRecord), 100);

// Persist only numeric/label data used by the panel, keyed by its opaque project ID.
export function createChannelCache(storage, { now = Date.now, panels } = {}) {
  const entries = new Map(), reads = new Map(), writes = new Map();

  function remember(key, value) {
    entries.delete(key);
    entries.set(key, value);
    while (entries.size > MEMORY_LIMIT) entries.delete(entries.keys().next().value);
    return value;
  }

  async function get(key) {
    if (entries.has(key)) return remember(key, entries.get(key));
    if (reads.has(key)) return reads.get(key);
    const pending = (async () => {
      if (writes.has(key)) await writes.get(key);
      let stored;
      try { stored = panels ? panels.readPanel('current-data', key)?.value : await storage.get(PREFIX + key); }
      catch { /* A damaged or unavailable cache can be rebuilt. */ }
      if (entries.has(key)) return entries.get(key);
      if (!Number.isFinite(stored?.updatedAt) || !Array.isArray(stored.records)) return remember(key, null);
      const records = stored.records.slice(0, 100).flatMap(row => {
        const safe = panelRecord(row);
        return safe && /^[0-9a-f]{24}$/.test(row.id) ? [{ ...safe, id: row.id }] : [];
      });
      return remember(key, { updatedAt: stored.updatedAt, records, stamp: JSON.stringify(records) });
    })().finally(() => reads.delete(key));
    reads.set(key, pending);
    return pending;
  }

  function set(key, records, { display = true } = {}) {
    const clean = cleanRecords(records), stamp = JSON.stringify(clean);
    const previous = entries.get(key);
    if (previous?.stamp === stamp) {
      if (panels && display) {
        try { panels.publishPanel('current-data', key, { records: previous.records, updatedAt: previous.updatedAt }, now()); }
        catch { /* The live view still has its last successful result. */ }
      }
      return remember(key, previous);
    }
    const updatedAt = now();
    const snapshot = remember(key, { records: clean, updatedAt, stamp });
    if (panels) {
      if (display) {
        try { panels.publishPanel('current-data', key, { records: clean, updatedAt }, updatedAt); }
        catch { /* The live view still has its last successful result. */ }
      }
      return snapshot;
    }
    const write = (writes.get(key) ?? Promise.resolve())
      .then(() => storage.set(PREFIX + key, { records: clean, updatedAt }))
      .catch(() => {})
      .finally(() => { if (writes.get(key) === write) writes.delete(key); });
    writes.set(key, write);
    return snapshot;
  }

  return { get, set, flush: () => Promise.allSettled(writes.values()) };
}

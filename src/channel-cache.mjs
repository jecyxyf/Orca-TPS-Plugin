import { createHash } from 'node:crypto';
import { isManagerHarness, recentRecords } from './harnesses.mjs';

const NUMBERS = [
  'completedAt', 'createdAtSec', 'freshInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens',
  'durationMs', 'firstTokenMs', 'generationMs', 'tokensPerSecond', 'cacheHitRate'
];
const clean = value => typeof value === 'string' && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value);
const hermesModelId = /^[a-z\d][a-z\d._-]*\/[a-z\d][a-z\d._:-]*$/i;

function panelRecord(record) {
  if (!record || !isManagerHarness(record.provider) || !Number.isFinite(record.completedAt) || record.completedAt < 0 ||
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

const MEMORY_LIMIT = 64;
const cleanRecords = records => recentRecords(records.map(panelRecord), 100);

function sameRecords(before, after) {
  return before.length === after.length && after.every((row, index) => {
    const previous = before[index], keys = Object.keys(row);
    return keys.length === Object.keys(previous).length && keys.every(key => row[key] === previous[key]);
  });
}

/**
 * Keeps only numeric and label data the panel uses, keyed by the opaque project ID. The panel database holds the
 * displayed channels; channels collected in the background stay in memory.
 */
export function createChannelCache(panels, { now = Date.now } = {}) {
  const entries = new Map();

  function remember(key, value) {
    entries.delete(key);
    entries.set(key, value);
    while (entries.size > MEMORY_LIMIT) entries.delete(entries.keys().next().value);
    return value;
  }

  function get(key) {
    if (entries.has(key)) return remember(key, entries.get(key));
    let stored;
    try { stored = panels.readPanel('current-data', key)?.value; }
    catch { /* A damaged or unavailable cache can be rebuilt. */ }
    if (!Number.isFinite(stored?.updatedAt) || !Array.isArray(stored.records)) return remember(key, null);
    const records = stored.records.slice(0, 100).flatMap(row => {
      const safe = panelRecord(row);
      return safe && /^[0-9a-f]{24}$/.test(row.id) ? [{ ...safe, id: row.id }] : [];
    });
    return remember(key, { records, updatedAt: stored.updatedAt });
  }

  function set(key, records, { display = true } = {}) {
    const normalized = cleanRecords(records);
    const previous = entries.get(key);
    const unchanged = previous && sameRecords(previous.records, normalized);
    if (unchanged && !display) return remember(key, previous);
    const announcedAt = now();
    const snapshot = remember(key, unchanged ? previous : { records: normalized, updatedAt: announcedAt });
    if (display) {
      try { panels.publishPanel('current-data', key, snapshot, announcedAt); }
      catch { /* The live view still has its last successful result. */ }
    }
    return snapshot;
  }

  return { get, set };
}

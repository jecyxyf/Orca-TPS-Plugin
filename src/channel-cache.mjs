import { remoteRecord } from './remote-collector.mjs';
import { recentRecords } from './parsers.mjs';

const PREFIX = 'tps:channel:v1:';
const MEMORY_LIMIT = 64;
const cleanRecords = records => recentRecords(records.map(remoteRecord), 100);

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
        const safe = remoteRecord(row);
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

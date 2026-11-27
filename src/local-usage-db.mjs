import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const PANELS = new Set(['current-data', 'leaderboard']);
const COLLECTION_KEY = 'usage-collection';
const SCHEMA_VERSION = 3;
const encode = value => JSON.stringify(value);
const decode = value => value == null ? undefined : JSON.parse(value);

/**
 * Keeps the last two snapshots of each panel, so a restart shows data at once, and the installation ID that
 * earlier versions stored here. Usage history lives in the Tokens Manager database; versions 1 and 2 kept a
 * copy of their own, which the upgrade drops.
 */
export function openLocalUsageDb(filename) {
  if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename, { enableExtensionLoading: false });
  try {
    db.exec('PRAGMA busy_timeout=3000; PRAGMA trusted_schema=OFF; PRAGMA journal_mode=WAL; BEGIN IMMEDIATE;');
    const { user_version: version } = db.prepare('PRAGMA user_version').get();
    if (version > SCHEMA_VERSION) throw new Error('unsupported local usage database version');
    db.exec(`
      CREATE TABLE IF NOT EXISTS panel_cache (
        panel TEXT PRIMARY KEY, current_scope TEXT NOT NULL, current_snapshot TEXT NOT NULL, current_at INTEGER NOT NULL,
        previous_scope TEXT, previous_snapshot TEXT, previous_at INTEGER
      );
      DROP TABLE IF EXISTS usage_records;
      DROP TABLE IF EXISTS usage_records_v1;
      DROP TABLE IF EXISTS upload_queue;
      DELETE FROM panel_cache WHERE panel NOT IN ('current-data', 'leaderboard', '${COLLECTION_KEY}');
      PRAGMA user_version=${SCHEMA_VERSION};
      COMMIT;
    `);
    if (version && version < SCHEMA_VERSION) {
      try { db.exec('VACUUM; PRAGMA wal_checkpoint(TRUNCATE);'); }
      catch (error) {
        // Pending readers or limited disk space can leave reusable pages in the upgraded file.
        if (![5, 6, 13].includes(error.errcode & 0xff)) throw error;
      }
    }
  } catch (error) {
    db.close();
    throw error;
  }

  const selectPanel = db.prepare('SELECT * FROM panel_cache WHERE panel=?');
  const upsertPanel = db.prepare(`INSERT INTO panel_cache(panel, current_scope, current_snapshot, current_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(panel) DO UPDATE SET previous_scope=current_scope, previous_snapshot=current_snapshot, previous_at=current_at,
    current_scope=excluded.current_scope, current_snapshot=excluded.current_snapshot, current_at=excluded.current_at
    WHERE excluded.current_at>=current_at AND (excluded.current_scope<>current_scope OR excluded.current_snapshot<>current_snapshot)`);

  return {
    /** The Tokens Manager adopts this ID when it creates its own database, so the device keeps its history. */
    legacyDeviceGuid() {
      try { return decode(selectPanel.get(COLLECTION_KEY)?.current_snapshot)?.deviceGuid; }
      catch { return undefined; }
    },
    readPanel(panel, scope, { previous = false } = {}) {
      const row = selectPanel.get(panel);
      if (!row) return null;
      if (!previous && row.current_scope === scope) return { value: decode(row.current_snapshot), at: row.current_at };
      if (row.previous_scope === scope) return { value: decode(row.previous_snapshot), at: row.previous_at };
      return null;
    },
    publishPanel(panel, scope, value, at = Date.now()) {
      if (!PANELS.has(panel)) throw new Error('unknown panel');
      upsertPanel.run(panel, scope, encode(value), at);
    },
    close: () => db.close()
  };
}

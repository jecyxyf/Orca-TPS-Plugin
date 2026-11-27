import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defaultRoots } from './harness_parser.mjs';
import { validInstallationId } from './leaderboard_stats.mjs';
import { withTransaction } from './sqlite.mjs';

const PANELS = new Set(['current-data', 'usage', 'usage-cc-switch', 'leaderboard']);
const COLLECTION_KEY = 'usage-collection';
const decode = value => value == null ? undefined : JSON.parse(value);

export function localUsageDatabasePath(options = {}) {
  const join = (options.platform ?? process.platform) === 'win32' ? path.win32.join : path.posix.join;
  return join(defaultRoots(options).userData, 'tps-plugin', 'usage.sqlite');
}

export function openLocalUsageDb(filename) {
  if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename, { enableExtensionLoading: false });
  try {
    db.exec(`PRAGMA busy_timeout=3000; PRAGMA trusted_schema=OFF; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS panel_cache (
        panel TEXT PRIMARY KEY, current_scope TEXT NOT NULL, current_snapshot TEXT NOT NULL, current_at INTEGER NOT NULL,
        previous_scope TEXT, previous_snapshot TEXT, previous_at INTEGER
      );`);
  } catch (error) {
    db.close();
    throw error;
  }

  const selectPanel = db.prepare('SELECT * FROM panel_cache WHERE panel=?');
  const upsertState = db.prepare(`INSERT INTO panel_cache(panel, current_scope, current_snapshot, current_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(panel) DO UPDATE SET current_snapshot=excluded.current_snapshot, current_at=excluded.current_at
    WHERE excluded.current_snapshot<>current_snapshot`);
  const upsertPanel = db.prepare(`INSERT INTO panel_cache(panel, current_scope, current_snapshot, current_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(panel) DO UPDATE SET previous_scope=current_scope, previous_snapshot=current_snapshot, previous_at=current_at,
    current_scope=excluded.current_scope, current_snapshot=excluded.current_snapshot, current_at=excluded.current_at
    WHERE excluded.current_at>=current_at AND (excluded.current_scope<>current_scope OR excluded.current_snapshot<>current_snapshot)`);

  const readCollection = now => decode(selectPanel.get(COLLECTION_KEY)?.current_snapshot) ?? { startedAt: now, importedAt: null };

  return {
    loadCollection(now, deviceGuid) {
      return withTransaction(db, () => {
        const state = readCollection(now);
        if (validInstallationId(deviceGuid) && !validInstallationId(state.deviceGuid)) state.deviceGuid = deviceGuid;
        upsertState.run(COLLECTION_KEY, 'desktop', JSON.stringify(state), now);
        return state;
      });
    },
    saveCollection(state, now) {
      withTransaction(db, () => {
        upsertState.run(COLLECTION_KEY, 'desktop', JSON.stringify({ ...readCollection(now), ...state }), now);
      });
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
      upsertPanel.run(panel, scope, JSON.stringify(value), at);
    },
    close: () => db.close()
  };
}

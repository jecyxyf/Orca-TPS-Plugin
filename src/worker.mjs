import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import manifest from '../orca-plugin.json' with { type: 'json' };
import { readActiveConversation } from './active-conversation.mjs';
import { createLocalePreferences } from './locales.mjs';
import { createTpsController } from './controller.mjs';
import { createChannelCache } from './channel-cache.mjs';
import { localUsageDatabasePath, openLocalUsageDb } from './local-usage-db.mjs';
import { startLeaderboard } from './leaderboard.mjs';
import { validInstallationId } from './leaderboard_stats.mjs';
import { createTokensManagerClient } from './tokens-manager-client.mjs';

const INSTALLATION_KEY = 'leaderboard:installation-id';
const PANEL_VIEW_KEY = 'panel-view';
const PANEL_VIEWS = new Set(['current-data', 'usage', 'leaderboard']);

let controller, cache, manager, stopLeaderboard, stopPanelView, db, locales;
let registrations = [];

export default async function activate(orca) {
  await deactivate();
  db = openLocalUsageDb(localUsageDatabasePath());
  const migrationGuid = db.loadCollection(Date.now()).deviceGuid;
  const deviceGuid = validInstallationId(migrationGuid) ? migrationGuid : await orca.storage.get(INSTALLATION_KEY);
  const language = locales = await createLocalePreferences(orca.storage);
  registrations.push(orca.panels.handle('tps.locale', payload => payload?.code === undefined
    ? { ...language.response(true), pluginVersion: manifest.version }
    : language.select(payload.code, () => { void controller?.refreshLocale(); })));
  stopPanelView = registerPanelView(orca, language.t);
  const localEnv = await readFile(new URL('../.env.leaderboard.local', import.meta.url), 'utf8').catch(() => '');
  const endpoint = process.env.ORCA_TPS_LEADERBOARD_URL || parseEnv(localEnv).ORCA_TPS_LEADERBOARD_URL || 'https://itps8.com';
  const getZone = () => orca.settings?.get('timeZone').catch(() => undefined);
  const client = manager = await createTokensManagerClient(orca, {
    endpoint, deviceGuid, initialZone: await getZone(),
    onChange(summary) { try { orca.panels.post('tps.usage.changed', summary); } catch {} }
  });
  registrations.push(
    orca.panels.handle('tps.summary', client.summary),
    orca.panels.handle('tps.timezone', async input => {
      const requested = typeof input === 'string' ? input : input?.timeZone;
      const result = await client.setTimeZone(requested);
      await orca.settings?.set('timeZone', requested || '');
      return result;
    })
  );
  if (orca.settings?.onDidChange) {
    registrations.push(orca.settings.onDidChange(({ key }) => {
      if (key === 'timeZone') void Promise.resolve(getZone()).then(client.setTimeZone).catch(() => {});
    }));
  }
  const channelCache = cache = createChannelCache(orca.storage, { panels: db });
  controller = createTpsController(orca, {
    cache: channelCache, locales: language,
    pollMs: 250, livePollMs: 250, focusPollMs: 1000,
    backgroundPollMs: 5000, backgroundLimit: 1, watchWorkspace: true,
    readActive: () => readActiveConversation({ includeRemote: true, includeOpen: true }),
    readSession: client.read,
    onOpenTargets: client.setTargets
  });
  await controller.start({ background: true });
  try { stopLeaderboard = startLeaderboard(orca, { endpoint, localDb: db, manager: client }); }
  catch { orca.log(language.t('notice.leaderboard-url-invalid')); }
}

function registerPanelView(orca, t) {
  const saved = orca.storage.get(PANEL_VIEW_KEY).catch(() => undefined);
  let selected, writing = Promise.resolve();
  const registration = orca.panels.handle('tps.panel-view', async payload => {
    const view = payload?.view;
    if (PANEL_VIEWS.has(view) && view !== selected) {
      selected = view;
      writing = writing.then(() => orca.storage.set(PANEL_VIEW_KEY, view)).catch(() => {
        orca.log(t('notice.panel-view-save-failed'));
      });
      await writing;
    }
    if (selected) return { view: selected };
    const restored = await saved;
    return { view: selected ?? (PANEL_VIEWS.has(restored) ? restored : null) };
  });
  return () => { registration.dispose(); return writing; };
}

export async function deactivate() {
  for (const registration of registrations) registration.dispose();
  registrations = [];
  controller?.stop();
  controller = undefined;
  const closings = [locales?.flush(), stopPanelView?.(), stopLeaderboard?.(), manager?.close(), cache?.flush()];
  locales = stopPanelView = stopLeaderboard = manager = cache = undefined;
  const database = db;
  db = undefined;
  try { await Promise.allSettled(closings); }
  finally { database?.close(); }
}

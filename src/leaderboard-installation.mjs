import { randomUUID } from 'node:crypto';
import { validInstallationId } from './leaderboard_stats.mjs';

export const INSTALLATION_KEY = 'leaderboard:installation-id';

export async function loadInstallationId(storage) {
  const saved = await storage.get(INSTALLATION_KEY);
  if (validInstallationId(saved)) return saved;
  const created = randomUUID();
  await storage.set(INSTALLATION_KEY, created);
  return created;
}

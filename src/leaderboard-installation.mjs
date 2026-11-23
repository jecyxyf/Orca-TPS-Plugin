import { randomUUID } from 'node:crypto';

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function validInstallationId(value) {
  return typeof value === 'string' && value.length === 36 && uuidV4.test(value);
}
export const INSTALLATION_KEY = 'leaderboard:installation-id';

export async function loadInstallationId(storage) {
  const saved = await storage.get(INSTALLATION_KEY);
  if (validInstallationId(saved)) return saved;
  const created = randomUUID();
  await storage.set(INSTALLATION_KEY, created);
  return created;
}

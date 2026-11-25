import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AUDIT_LIMIT, createLeaderboardStateFile, openLeaderboardStore } from './store.mjs';

export function migrateLeaderboardState(source, destination, now = Date.now()) {
  const db = new DatabaseSync(source, { readOnly: true });
  let state;
  try {
    db.exec('BEGIN');
    const accounts = db.prepare(`
      SELECT accounts.id, accounts.username, accounts.banned, ban_reasons.reason
      FROM accounts LEFT JOIN ban_reasons ON ban_reasons.account=accounts.id ORDER BY accounts.id
    `).all().map(row => ({ ...row, banned: Boolean(row.banned) }));
    const administrator = db.prepare('SELECT account FROM administrator WHERE slot=1').get()?.account ?? null;
    const sessions = db.prepare('SELECT digest, account, kind, expires FROM sessions WHERE expires>? ORDER BY digest').all(now);
    const audit = db.prepare(`
      SELECT account, action, target, at FROM audit WHERE action IN ('ban', 'unban') ORDER BY id DESC LIMIT ?
    `).all(AUDIT_LIMIT).reverse();
    state = { version: 1, accounts, administrator, sessions, audit };
  } finally {
    db.close();
  }

  createLeaderboardStateFile(destination, state);
  const store = openLeaderboardStore(destination);
  if (store.administrator() !== state.administrator || state.sessions.some(session =>
    store.session(session.digest, session.kind, now)?.id !== session.account)) {
    throw new Error('Unable to verify migrated leaderboard state');
  }
  return { accounts: state.accounts.length, sessions: state.sessions.length,
    administrator: state.administrator !== null, bans: state.accounts.filter(row => row.banned).length, audit: state.audit.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { from: { type: 'string' }, to: { type: 'string' } } });
  if (!values.from || !values.to) throw new Error('Usage: node server/migrate-leaderboard-state.mjs --from OLD.sqlite --to leaderboard.bin');
  console.log(JSON.stringify(migrateLeaderboardState(resolve(values.from), resolve(values.to))));
}

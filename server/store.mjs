import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const AUDIT_LIMIT = 25;

const validId = value => Number.isSafeInteger(value) && value > 0;
const validTime = value => Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000_000;
const validKind = value => value === 'admin' || value === 'plugin';
const validReason = value => value === null || (typeof value === 'string' && value.length <= 200);

function indexRows(rows, key, valid) {
  const index = new Map();
  for (const row of rows) {
    if (!row || !valid(row) || index.has(row[key])) throw new Error('Invalid leaderboard state');
    index.set(row[key], row);
  }
  return index;
}

function indexState(state) {
  if (state?.version !== 1 || !Array.isArray(state.accounts) || !Array.isArray(state.sessions) ||
      !Array.isArray(state.audit) || state.audit.length > AUDIT_LIMIT) {
    throw new Error('Invalid leaderboard state');
  }
  const accounts = indexRows(state.accounts, 'id', row => validId(row.id) &&
    typeof row.username === 'string' && /^[\w-]{1,39}$/.test(row.username) &&
    typeof row.banned === 'boolean' && validReason(row.reason));
  const sessions = indexRows(state.sessions, 'digest', row => typeof row.digest === 'string' &&
    /^[0-9a-f]{64}$/.test(row.digest) && accounts.has(row.account) && validKind(row.kind) && validTime(row.expires));
  if ((state.administrator !== null && !accounts.has(state.administrator)) ||
      state.audit.some(row => !row || !accounts.has(row.account) ||
        (row.action !== 'ban' && row.action !== 'unban') || typeof row.target !== 'string' || !validTime(row.at))) {
    throw new Error('Invalid leaderboard state');
  }
  return { accounts, sessions };
}

function writeState(filename, state, replace) {
  const temporary = filename + '.' + randomUUID() + '.next';
  const descriptor = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeFileSync(descriptor, Buffer.from(JSON.stringify(state), 'utf8'));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    if (replace) renameSync(temporary, filename);
    else linkSync(temporary, filename);
  } finally {
    try { unlinkSync(temporary); } catch { /* Only the temporary name may remain. */ }
  }
}

export function createLeaderboardStateFile(filename, state) {
  indexState(state);
  mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  writeState(filename, state, false);
}

function loadState(filename) {
  let bytes;
  try {
    bytes = readFileSync(filename);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const state = { version: 1, accounts: [], administrator: null, sessions: [], audit: [] };
    try {
      createLeaderboardStateFile(filename, state);
      return state;
    } catch (creationError) {
      if (creationError.code !== 'EEXIST') throw creationError;
      bytes = readFileSync(filename);
    }
  }

  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('Invalid leaderboard state');
  }
}

export function openLeaderboardStore(filename) {
  let state = loadState(filename);
  let { accounts, sessions } = indexState(state);

  function save(changes, now) {
    const next = { ...state, ...changes };
    next.sessions = next.sessions.filter(row => row.expires > now);
    const indexed = indexState(next);
    writeState(filename, next, true);
    state = next;
    ({ accounts, sessions } = indexed);
  }

  return {
    administrator: () => state.administrator,
    issueSession({ id, login }, digest, kind, expires, now) {
      if (kind === 'admin' && state.administrator !== null && state.administrator !== id) return false;
      const previous = accounts.get(id);
      const account = { id, username: login, banned: previous?.banned ?? false, reason: previous?.reason ?? null };
      const updated = new Map(accounts).set(id, account);
      save({
        accounts: [...updated.values()],
        administrator: kind === 'admin' ? id : state.administrator,
        sessions: [...state.sessions, { digest, account: id, kind, expires }]
      }, now);
      return true;
    },
    session(digest, kind, now) {
      const session = sessions.get(digest);
      if (!session || session.kind !== kind || session.expires <= now) return undefined;
      const { id, username, banned } = accounts.get(session.account);
      return { id, username, banned };
    },
    removeSession(digest, now) {
      if (sessions.has(digest)) save({ sessions: state.sessions.filter(row => row.digest !== digest) }, now);
    },
    setBan(actor, id, banned, now, reason = '') {
      const account = accounts.get(id);
      reason = reason.trim();
      if (actor !== state.administrator || !account || account.banned === banned ||
          (banned && (id === actor || !reason || !validReason(reason)))) return false;
      const updated = new Map(accounts).set(id, { ...account, banned, reason: banned ? reason : account.reason });
      const audit = { account: actor, action: banned ? 'ban' : 'unban', target: banned ? id + ' · ' + reason : String(id), at: now };
      save({ accounts: [...updated.values()], audit: [...state.audit, audit].slice(-AUDIT_LIMIT) }, now);
      return true;
    },
    adminView(search) {
      const query = search.toLowerCase();
      return {
        accounts: state.accounts.filter(row => row.username.toLowerCase().includes(query))
          .sort((a, b) => Number(b.banned) - Number(a.banned) || a.username.localeCompare(b.username)).slice(0, 500),
        audit: state.audit.slice().reverse().map(({ account, ...row }) => ({ ...row, username: accounts.get(account).username }))
      };
    }
  };
}

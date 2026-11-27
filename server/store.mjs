import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const AUDIT_LIMIT = 25;
const validId = v => Number.isSafeInteger(v) && v > 0;
const validTime = v => Number.isSafeInteger(v) && v > 0 && v <= 8_640_000_000_000_000;
const validReason = v => v === null || (typeof v === 'string' && v.length <= 200);

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
      !Array.isArray(state.audit) || state.audit.length > AUDIT_LIMIT) throw new Error('Invalid leaderboard state');
  const accounts = indexRows(state.accounts, 'id', r => validId(r.id) && typeof r.username === 'string' &&
    /^[\w-]{1,39}$/.test(r.username) && typeof r.banned === 'boolean' && validReason(r.reason));
  const sessions = indexRows(state.sessions, 'digest', r => typeof r.digest === 'string' &&
    /^[0-9a-f]{64}$/.test(r.digest) && accounts.has(r.account) && (r.kind === 'admin' || r.kind === 'plugin') && validTime(r.expires));
  if ((state.administrator !== null && !accounts.has(state.administrator)) ||
      state.audit.some(r => !r || !accounts.has(r.account) || (r.action !== 'ban' && r.action !== 'unban') || typeof r.target !== 'string' || !validTime(r.at))) {
    throw new Error('Invalid leaderboard state');
  }
  return { accounts, sessions };
}

function writeState(filename, state, replace) {
  const temporary = `${filename}.${randomUUID()}.next`, fd = openSync(temporary, 'wx', 0o600);
  try {
    try { writeFileSync(fd, Buffer.from(JSON.stringify(state), 'utf8')); fsyncSync(fd); } finally { closeSync(fd); }
    replace ? renameSync(temporary, filename) : linkSync(temporary, filename);
  } finally { try { unlinkSync(temporary); } catch {} }
}

export function createLeaderboardStateFile(filename, state) {
  indexState(state);
  mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  writeState(filename, state, false);
}

function loadState(filename) {
  let bytes;
  try { bytes = readFileSync(filename); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const state = { version: 1, accounts: [], administrator: null, sessions: [], audit: [] };
    try { createLeaderboardStateFile(filename, state); return state; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      bytes = readFileSync(filename);
    }
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('Invalid leaderboard state'); }
}

export function openLeaderboardStore(filename) {
  let state = loadState(filename), { accounts, sessions } = indexState(state);
  function save(changes, now) {
    const next = { ...state, ...changes };
    next.sessions = next.sessions.filter(r => r.expires > now);
    const indexed = indexState(next);
    writeState(filename, next, true);
    state = next; ({ accounts, sessions } = indexed);
  }
  return {
    administrator: () => state.administrator,
    issueSession({ id, login }, digest, kind, expires, now) {
      if (kind === 'admin' && state.administrator !== null && state.administrator !== id) return false;
      const prev = accounts.get(id);
      const updated = new Map(accounts).set(id, { id, username: login, banned: prev?.banned ?? false, reason: prev?.reason ?? null });
      save({
        accounts: [...updated.values()], administrator: kind === 'admin' ? id : state.administrator,
        sessions: [...state.sessions, { digest, account: id, kind, expires }]
      }, now);
      return true;
    },
    session(digest, kind, now) {
      const s = sessions.get(digest);
      if (!s || s.kind !== kind || s.expires <= now) return undefined;
      const { id, username, banned } = accounts.get(s.account);
      return { id, username, banned };
    },
    removeSession(digest, now) { if (sessions.has(digest)) save({ sessions: state.sessions.filter(r => r.digest !== digest) }, now); },
    setBan(actor, id, banned, now, reason = '') {
      const account = accounts.get(id);
      reason = reason.trim();
      if (actor !== state.administrator || !account || account.banned === banned || (banned && (id === actor || !reason || !validReason(reason)))) return false;
      const updated = new Map(accounts).set(id, { ...account, banned, reason: banned ? reason : account.reason });
      const audit = { account: actor, action: banned ? 'ban' : 'unban', target: banned ? `${id} · ${reason}` : String(id), at: now };
      save({ accounts: [...updated.values()], audit: [...state.audit, audit].slice(-AUDIT_LIMIT) }, now);
      return true;
    },
    adminView(search) {
      const query = search.toLowerCase();
      return {
        accounts: state.accounts.filter(r => r.username.toLowerCase().includes(query))
          .sort((a, b) => Number(b.banned) - Number(a.banned) || a.username.localeCompare(b.username)).slice(0, 500),
        audit: state.audit.slice().reverse().map(({ account, ...row }) => ({ ...row, username: accounts.get(account).username }))
      };
    }
  };
}

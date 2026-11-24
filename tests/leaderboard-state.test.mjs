import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openLeaderboardStore } from '../server/store.mjs';
import { migrateLeaderboardState } from '../server/migrate-leaderboard-state.mjs';

const now = Date.parse('2026-11-24T01:00:00Z');
const first = 'a'.repeat(64), second = 'b'.repeat(64);
const admin = { id: 1, login: 'admin' }, player = { id: 2, login: 'player' };

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'tps-leaderboard-state-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  return { root, filename: path.join(root, 'leaderboard.bin') };
}

test('stores sessions, administrator binding, and ban changes across reopening', async t => {
  const { root, filename } = await fixture(t);
  let store = openLeaderboardStore(filename);
  assert.equal(store.issueSession(admin, first, 'admin', now + 10000, now), true);
  assert.equal(store.issueSession(player, second, 'admin', now + 10000, now), false);
  assert.equal(store.issueSession(player, second, 'plugin', now + 20000, now), true);
  assert.equal(store.setBan(2, 1, true, now, 'invalid actor'), false);
  assert.equal(store.setBan(1, 1, true, now, 'administrator'), false);
  assert.equal(store.setBan(1, 2, true, now, '异常上报'), true);
  assert.equal(JSON.parse((await readFile(filename)).toString('utf8')).accounts[1].reason, '异常上报');
  if (process.platform !== 'win32') assert.equal((await stat(filename)).mode & 0o777, 0o600);

  store = openLeaderboardStore(filename);
  assert.equal(store.administrator(), 1);
  assert.deepEqual(store.session(second, 'plugin', now), { id: 2, username: 'player', banned: true });
  assert.equal(store.session(second, 'admin', now), undefined);
  assert.equal(store.session(first, 'admin', now + 10000), undefined);
  assert.equal(store.adminView('PLAYER').accounts[0].reason, '异常上报');
  assert.equal(store.adminView('').audit[0].action, 'ban');

  store.setBan(1, 2, false, now + 10000);
  store.removeSession(second, now + 10000);
  assert.deepEqual(JSON.parse((await readFile(filename)).toString('utf8')).sessions, []);
  assert.deepEqual(await readdir(root), ['leaderboard.bin']);
  assert.equal(openLeaderboardStore(filename).session(second, 'plugin', now + 10000), undefined);
});

test('preserves the last committed state when replacement fails and rejects a damaged file', async t => {
  const { root, filename } = await fixture(t);
  const store = openLeaderboardStore(filename);
  store.issueSession(admin, first, 'admin', now + 1000, now);
  const committed = await readFile(filename);
  const previous = path.join(root, 'previous.bin');
  await rename(filename, previous);
  await mkdir(filename);
  assert.throws(() => store.issueSession(player, second, 'plugin', now + 1000, now));
  assert.equal(store.session(second, 'plugin', now), undefined);
  assert.deepEqual(await readFile(previous), committed);
  assert.deepEqual((await readdir(root)).sort(), ['leaderboard.bin', 'previous.bin']);
  await rm(filename, { recursive: true });
  await rename(previous, filename);
  assert.equal(openLeaderboardStore(filename).session(first, 'admin', now).id, 1);

  const invalid = Buffer.from([0xff]);
  await writeFile(filename, invalid);
  assert.throws(() => openLeaderboardStore(filename), /Invalid leaderboard state/);
  assert.deepEqual(await readFile(filename), invalid);
});

test('imports current SQLite login data once and filters expired sessions and old ranking actions', async t => {
  const { root, filename } = await fixture(t);
  const source = path.join(root, 'leaderboard.sqlite');
  const db = new DatabaseSync(source);
  try {
    db.exec(`
      CREATE TABLE accounts (id INTEGER, username TEXT, banned INTEGER);
      CREATE TABLE administrator (slot INTEGER, account INTEGER);
      CREATE TABLE ban_reasons (account INTEGER, reason TEXT);
      CREATE TABLE sessions (digest TEXT, account INTEGER, kind TEXT, expires INTEGER);
      CREATE TABLE audit (id INTEGER PRIMARY KEY, account INTEGER, action TEXT, target TEXT, at INTEGER);
      INSERT INTO accounts VALUES (1, 'admin', 1), (2, 'player', 1);
      INSERT INTO administrator VALUES (1, 1);
      INSERT INTO ban_reasons VALUES (2, '异常上报');
    `);
    const session = db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)');
    session.run(first, 1, 'admin', now + 1000);
    session.run(second, 2, 'plugin', now);
    const audit = db.prepare('INSERT INTO audit(account, action, target, at) VALUES (1, ?, ?, ?)');
    for (let i = 0; i < 27; i++) audit.run('ban', '2', now + i);
    audit.run('clear', 'all', now + 28);
  } finally {
    db.close();
  }

  const summary = migrateLeaderboardState(source, filename, now);
  assert.deepEqual(summary, { accounts: 2, sessions: 1, administrator: true, bans: 2, audit: 25 });
  const store = openLeaderboardStore(filename);
  assert.equal(store.administrator(), 1);
  assert.equal(store.session(first, 'admin', now).id, 1);
  assert.equal(store.session(second, 'plugin', now), undefined);
  assert.equal(store.adminView('player').accounts[0].reason, '异常上报');
  assert.equal(store.adminView('').audit[0].at, now + 26);
  assert.equal(store.adminView('').audit.at(-1).at, now + 2);
  assert.equal(store.setBan(1, 1, false, now), true);
  const bytes = await readFile(filename);
  assert.throws(() => migrateLeaderboardState(source, filename, now), { code: 'EEXIST' });
  assert.deepEqual(await readFile(filename), bytes);
});

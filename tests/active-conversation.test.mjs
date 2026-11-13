import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { activeProfileUserData, readActiveConversation, selectActiveConversation } from '../src/active-conversation.mjs';

let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); }
catch (error) { if (error.code !== 'ERR_UNKNOWN_BUILTIN_MODULE') throw error; }
const sqlite = { skip: DatabaseSync ? false : 'requires node:sqlite' };
const options = () => ({ userDataPath: '/config/orca', profileId: 'local-default', observations: new Map(), platform: 'linux', now: 10_000 });

function state(worktreeId = 'repo-1::/workspace/orca-tps/1.5.0') {
  const s = {
    activeWorktreeId: worktreeId,
    activeWorkspaceKey: `worktree:${worktreeId}`,
    activeWorkspaceExecutionHostId: 'local',
    activeTabId: 'a',
    activeTabIdByWorktree: { [worktreeId]: 'a' },
    activeTabTypeByWorktree: { [worktreeId]: 'terminal' },
    activeGroupIdByWorktree: { [worktreeId]: 'g' },
    tabGroups: { [worktreeId]: [{ id: 'g', activeTabId: 'a' }] },
    unifiedTabs: { [worktreeId]: [] },
    tabsByWorktree: { [worktreeId]: [] },
    terminalLayoutsByTabId: {},
    sleepingAgentSessionsByPaneKey: {},
    terminalPtyIncarnationsByPaneKey: {}
  };
  for (const [id, agent] of [['a', 'claude'], ['b', 'codex']]) {
    s.unifiedTabs[worktreeId].push({ id, entityId: id, groupId: 'g', contentType: 'terminal' });
    s.tabsByWorktree[worktreeId].push({
      id, worktreeId, createdAt: 100,
      aiVaultTitle: { agent, sessionId: `session-${id}`, title: `Title ${id}` }
    });
    s.terminalLayoutsByTabId[id] = { root: { type: 'leaf', leafId: 'leaf' }, activeLeafId: 'leaf', ptyIdsByLeafId: { leaf: `pty-${id}` } };
    s.sleepingAgentSessionsByPaneKey[`${id}:leaf`] = {
      paneKey: `${id}:leaf`, tabId: id, worktreeId, agent, connectionId: null,
      providerSession: { id: `session-${id}`, transcriptPath: `/sessions/${id}.jsonl`, cwd: '/workspace/orca-tps/1.5.0' },
      capturedAt: 500, updatedAt: 400, state: 'working', prompt: 'DO_NOT_EXPOSE'
    };
    s.terminalPtyIncarnationsByPaneKey[`${id}:leaf`] = `incarnation-${id}`;
  }
  return s;
}

test('platform defaults and explicit Orca data directory are portable', () => {
  assert.equal(activeProfileUserData({ platform: 'linux', home: '/home/a', env: {} }), '/home/a/.config/orca');
  assert.equal(activeProfileUserData({ platform: 'linux', home: '/home/a', env: { XDG_CONFIG_HOME: '/xdg' } }), '/xdg/orca');
  assert.equal(activeProfileUserData({ platform: 'win32', home: 'C:\\Users\\a', env: {} }), 'C:\\Users\\a\\AppData\\Roaming\\orca');
  assert.equal(activeProfileUserData({ platform: 'darwin', home: '/Users/a', env: {} }), '/Users/a/Library/Application Support/orca');
  assert.equal(activeProfileUserData({ env: { ORCA_USER_DATA_PATH: '/custom' } }), '/custom');
});

test('channel target collects all registered terminal tabs and split panes in the active worktree without leaking prompts', () => {
  const s = state(), o = options();
  // Add a split pane inside tab 'a' as well
  s.terminalLayoutsByTabId.a.root = {
    type: 'split',
    first: { type: 'leaf', leafId: 'leaf' },
    second: { type: 'leaf', leafId: 'second' }
  };
  delete s.tabsByWorktree[s.activeWorktreeId][0].aiVaultTitle;
  s.sleepingAgentSessionsByPaneKey['a:second'] = {
    ...s.sleepingAgentSessionsByPaneKey['a:leaf'],
    paneKey: 'a:second',
    agent: 'pi',
    providerSession: { id: 'split-session', transcriptPath: '/sessions/split.jsonl' }
  };
  // Unrelated channel's pane must never leak in
  s.sleepingAgentSessionsByPaneKey['other:leaf'] = {
    paneKey: 'other:leaf', tabId: 'other', worktreeId: 'repo-1::/workspace/other',
    agent: 'codex', connectionId: null, providerSession: { id: 'other-session', transcriptPath: '/sessions/other.jsonl' }, capturedAt: 500
  };

  const res = selectActiveConversation(s, o);
  assert.equal(res.target.worktreePath, '/workspace/orca-tps/1.5.0');
  assert.equal(res.target.title, 'orca-tps/1.5.0');
  assert.deepEqual(
    res.target.sessions.map(item => `${item.provider}:${item.sessionId}`),
    ['claude:session-a', 'pi:split-session', 'codex:session-b']
  );
  assert.ok(!JSON.stringify(res).includes('DO_NOT_EXPOSE'));
  assert.ok(!JSON.stringify(res.target.title).includes('/workspace/'));
});

test('channel target stays active on editor tabs or unregistered shell terminals and isolates channel keys', () => {
  const w = 'repo-1::D:/orca/workspace/Orca-TPS-Plugin/1.5.0';
  const s = state(w);
  const o = { ...options(), platform: 'win32' };
  for (const pane of Object.values(s.sleepingAgentSessionsByPaneKey)) {
    pane.providerSession.transcriptPath = 'C:\\Users\\test\\.claude\\a.jsonl';
  }
  const initial = selectActiveConversation(s, o);
  assert.equal(initial.target.worktreePath, 'D:/orca/workspace/Orca-TPS-Plugin/1.5.0');
  assert.equal(initial.target.title, 'Orca-TPS-Plugin/1.5.0');

  // Switch active tab in the same channel to a code editor tab: channel target & key remain stable!
  s.unifiedTabs[w].push({ id: 'ed-1', entityId: 'D:/orca/workspace/Orca-TPS-Plugin/1.5.0/README.md', groupId: 'g', contentType: 'editor' });
  s.tabGroups[w][0].activeTabId = 'ed-1';
  s.activeTabTypeByWorktree[w] = 'editor';
  const onEditor = selectActiveConversation(s, o);
  assert.equal(onEditor.target.key, initial.target.key);
  assert.equal(onEditor.target.worktreePath, initial.target.worktreePath);
  assert.equal(onEditor.target.sessions.length, 2);

  // Even with zero registered sleepingAgentSessions (e.g. only manual cmd.exe terminals), worktreePath target stays valid!
  s.sleepingAgentSessionsByPaneKey = {};
  const unregisteredOnly = selectActiveConversation(s, o);
  assert.equal(unregisteredOnly.target.key, initial.target.key);
  assert.equal(unregisteredOnly.target.worktreePath, 'D:/orca/workspace/Orca-TPS-Plugin/1.5.0');
  assert.deepEqual(unregisteredOnly.target.sessions, []);

  // Switching to parent repo worktree produces a distinct channel key and path.
  const parentState = state('repo-1::D:\\orca\\workspace\\Orca-TPS-Plugin');
  parentState.sleepingAgentSessionsByPaneKey = {};
  const parentRes = selectActiveConversation(parentState, o);
  assert.notEqual(parentRes.target.key, initial.target.key);
  assert.equal(parentRes.target.worktreePath, 'D:\\orca\\workspace\\Orca-TPS-Plugin');
});

test('remote, missing, or unsynced workspaces never return a target', () => {
  for (const modify of [
    s => { delete s.activeWorktreeId; },
    s => { s.activeWorkspaceExecutionHostId = 'runtime:remote'; },
    s => { s.activeWorkspaceKey = 'worktree:other'; },
    // Synthetic worktree with neither path nor valid local sessions yields null
    s => {
      s.activeWorktreeId = 'synthetic-no-path';
      s.activeWorkspaceKey = 'worktree:synthetic-no-path';
      s.tabsByWorktree = {};
      s.sleepingAgentSessionsByPaneKey = {};
    }
  ]) {
    const s = state();
    modify(s);
    assert.equal(selectActiveConversation(s, options()).target, null);
  }
});

test('conflicting pane metadata, remote panes, and relative paths are excluded from channel sessions', () => {
  const w = 'synthetic-only';
  for (const modify of [
    s => { s.tabsByWorktree[w][0].aiVaultTitle.sessionId = 'new-session'; },
    s => { s.tabsByWorktree[w][0].aiVaultTitle.agent = 'codex'; },
    s => { s.sleepingAgentSessionsByPaneKey['a:leaf'].paneKey = 'b:leaf'; },
    s => { s.sleepingAgentSessionsByPaneKey['a:leaf'].worktreeId = 'other'; },
    s => { s.sleepingAgentSessionsByPaneKey['a:leaf'].connectionId = 'ssh'; },
    s => { s.sleepingAgentSessionsByPaneKey['a:leaf'].agent = 'unknown'; },
    s => { s.sleepingAgentSessionsByPaneKey['a:leaf'].providerSession.transcriptPath = '../secret.jsonl'; },
    s => { s.tabsByWorktree[w][0].createdAt = 1000; }
  ]) {
    const s = state(w);
    // Remove 'b' and cwd so 'a' is the sole source
    s.tabsByWorktree[w] = [s.tabsByWorktree[w][0]];
    delete s.sleepingAgentSessionsByPaneKey['b:leaf'];
    delete s.sleepingAgentSessionsByPaneKey['a:leaf'].providerSession.cwd;
    modify(s);
    assert.equal(selectActiveConversation(s, options()).target, null);
  }
});

test('terminal-reuse incarnation quarantine excludes reopened pane until refreshed while keeping sibling terminal', () => {
  const s = state(), o = options();
  o.now = 10_000_000;
  assert.deepEqual(selectActiveConversation(s, o).target.sessions.map(x => x.sessionId), ['session-a', 'session-b']);

  // Reopen terminal 'a' with stale capture: 'a' is quarantined, 'b' stays active!
  s.terminalPtyIncarnationsByPaneKey['a:leaf'] = 'new-incarnation';
  assert.deepEqual(selectActiveConversation(s, o).target.sessions.map(x => x.sessionId), ['session-b']);

  o.now += 61_000;
  assert.deepEqual(selectActiveConversation(s, o).target.sessions.map(x => x.sessionId), ['session-b'], 'time alone must not accept stale metadata');

  // Refreshed capture restores 'a'
  s.sleepingAgentSessionsByPaneKey['a:leaf'].capturedAt = 501;
  assert.deepEqual(selectActiveConversation(s, o).target.sessions.map(x => x.sessionId), ['session-a', 'session-b']);

  // A new session ID also clears quarantine immediately
  s.terminalPtyIncarnationsByPaneKey['a:leaf'] = 'third-incarnation';
  assert.deepEqual(selectActiveConversation(s, o).target.sessions.map(x => x.sessionId), ['session-b']);
  s.sleepingAgentSessionsByPaneKey['a:leaf'].providerSession.id = 'session-a2';
  s.tabsByWorktree[s.activeWorktreeId][0].aiVaultTitle.sessionId = 'session-a2';
  assert.deepEqual(selectActiveConversation(s, o).target.sessions.map(x => x.sessionId), ['session-a2', 'session-b']);
});

test('supported providers retain exact IDs and OpenCode database paths in channel sessions', () => {
  const w = 'repo-1::/workspace/proj';
  for (const agent of ['codex', 'claude', 'opencode', 'opencode2', 'pi', 'antigravity']) {
    const s = state(w);
    s.sleepingAgentSessionsByPaneKey['a:leaf'].agent = agent;
    s.tabsByWorktree[w][0].aiVaultTitle.agent = agent;
    if (agent.startsWith('opencode')) {
      delete s.sleepingAgentSessionsByPaneKey['a:leaf'].providerSession.transcriptPath;
      s.sleepingAgentSessionsByPaneKey['a:leaf'].providerSession.transcriptPath = '/data/opencode.db';
    }
    const result = selectActiveConversation(s, options());
    const first = result.target.sessions[0];
    assert.equal(first.provider, agent);
    if (agent.startsWith('opencode')) assert.equal(first.dbPath, '/data/opencode.db');
  }
});

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-tps-active-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('orca-tps-active-test-'));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, 'profiles', 'selected'), { recursive: true });
  await writeFile(path.join(root, 'orca-profile-index.json'), JSON.stringify({ activeProfileId: 'selected', profiles: [{ id: 'selected' }] }));
  return root;
}

test('reader sees committed WAL channel changes without writing database or reading other domains', sqlite, async t => {
  const root = await fixture(t), file = path.join(root, 'profiles', 'selected', 'profile-state.db'), db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE profile_state_documents(domain TEXT PRIMARY KEY,payload TEXT);');
    const write = db.prepare('INSERT OR REPLACE INTO profile_state_documents VALUES(?,?)');
    write.run('workspaceSession', JSON.stringify(state('repo-1::/workspace/ch-1')));
    write.run('settings', 'DO_NOT_READ_SECRETS');
    const walBefore = await readFile(`${file}-wal`), result = await readActiveConversation({ userDataPath: root, platform: 'linux' });
    assert.equal(result.target.worktreePath, '/workspace/ch-1');
    assert.equal(result.target.sessions.length, 2);
    assert.deepEqual(await readFile(`${file}-wal`), walBefore);
    write.run('workspaceSession', JSON.stringify(state('repo-1::/workspace/ch-2')));
    assert.equal((await readActiveConversation({ userDataPath: root, platform: 'linux' })).target.worktreePath, '/workspace/ch-2');
    assert.ok(result.target.key.includes('selected'));
  } finally { db.close(); }
});

// Orca >= 1.4.255 splits workspaceSession into per-key parts and only rewrites the legacy document occasionally.
function writeSplitState(db, legacy, live, { legacyRevision = 7 } = {}) {
  db.exec(`CREATE TABLE profile_state_documents(domain TEXT PRIMARY KEY, payload TEXT, revision INTEGER);
    CREATE TABLE profile_state_document_parts_meta(domain TEXT PRIMARY KEY, revision INTEGER, legacy_revision INTEGER);
    CREATE TABLE profile_state_document_parts(domain TEXT, part_key TEXT, ordinal INTEGER, payload TEXT, PRIMARY KEY(domain, part_key));`);
  db.prepare('INSERT INTO profile_state_documents VALUES(?,?,?)').run('workspaceSession', JSON.stringify(legacy), 7);
  db.prepare('INSERT INTO profile_state_document_parts_meta VALUES(?,?,?)').run('workspaceSession', 9, legacyRevision);
  const part = db.prepare('INSERT INTO profile_state_document_parts VALUES(?,?,?,?)');
  let ordinal = 0;
  for (const [key, value] of Object.entries(live)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [inner, innerValue] of Object.entries(value)) part.run('workspaceSession', JSON.stringify([key, inner]), ordinal++, JSON.stringify(innerValue));
    } else part.run('workspaceSession', JSON.stringify([key]), ordinal++, JSON.stringify(value));
  }
}

test('split workspace parts win over the stale legacy document', sqlite, async t => {
  const root = await fixture(t), db = new DatabaseSync(path.join(root, 'profiles', 'selected', 'profile-state.db'));
  try {
    writeSplitState(db, state('repo-1::/workspace/old'), state('repo-1::/workspace/live'));
  } finally { db.close(); }
  assert.equal((await readActiveConversation({ userDataPath: root, platform: 'linux' })).target.worktreePath, '/workspace/live');
});

test('split parts based on another legacy revision are ignored', sqlite, async t => {
  const root = await fixture(t), db = new DatabaseSync(path.join(root, 'profiles', 'selected', 'profile-state.db'));
  try {
    writeSplitState(db, state('repo-1::/workspace/legacy'), state('repo-1::/workspace/live'), { legacyRevision: 6 });
  } finally { db.close(); }
  assert.equal((await readActiveConversation({ userDataPath: root, platform: 'linux' })).target.worktreePath, '/workspace/legacy');
});

test('unchanged workspace revision reuses the last selection; a new revision re-reads', sqlite, async t => {
  const root = await fixture(t), file = path.join(root, 'profiles', 'selected', 'profile-state.db');
  const setup = new DatabaseSync(file);
  try { writeSplitState(setup, state('repo-1::/workspace/a'), state('repo-1::/workspace/b')); } finally { setup.close(); }
  const read = async () => (await readActiveConversation({ userDataPath: root, platform: 'linux' })).target.worktreePath;
  assert.equal(await read(), '/workspace/b');
  const db = new DatabaseSync(file);
  try {
    db.prepare("UPDATE profile_state_document_parts SET payload=? WHERE part_key=?").run(JSON.stringify('repo-1::/workspace/c'), JSON.stringify(['activeWorktreeId']));
    db.prepare("UPDATE profile_state_document_parts SET payload=? WHERE part_key=?").run(JSON.stringify('worktree:repo-1::/workspace/c'), JSON.stringify(['activeWorkspaceKey']));
    assert.equal(await read(), '/workspace/b');
    db.prepare("UPDATE profile_state_document_parts_meta SET revision=10 WHERE domain='workspaceSession'").run();
    assert.equal(await read(), '/workspace/c');
  } finally { db.close(); }
});

test('profile index validates membership and traversal; valid backup remains usable', sqlite, async t => {
  const root = await fixture(t), index = path.join(root, 'orca-profile-index.json');
  const db = new DatabaseSync(path.join(root, 'profiles', 'selected', 'profile-state.db'));
  try { db.exec('CREATE TABLE profile_state_documents(domain TEXT PRIMARY KEY,payload TEXT)'); db.prepare('INSERT INTO profile_state_documents VALUES(?,?)').run('workspaceSession', JSON.stringify(state())); }
  finally { db.close(); }
  const good = await readFile(index);
  await writeFile(index, JSON.stringify({ activeProfileId: '../outside', profiles: [{ id: '../outside' }] }));
  assert.equal((await readActiveConversation({ userDataPath: root })).target, null);
  await writeFile(index, JSON.stringify({ activeProfileId: 'selected', profiles: [] }));
  assert.equal((await readActiveConversation({ userDataPath: root })).target, null);
  await writeFile(`${index}.bak`, good);
  assert.equal((await readActiveConversation({ userDataPath: root, platform: 'linux' })).target.worktreePath, '/workspace/orca-tps/1.5.0');
});

test('malformed workspace state and missing database return empty without creating files', sqlite, async t => {
  const root = await fixture(t), file = path.join(root, 'profiles', 'selected', 'profile-state.db');
  assert.equal((await readActiveConversation({ userDataPath: root })).target, null);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  const db = new DatabaseSync(file);
  try { db.exec('CREATE TABLE profile_state_documents(domain TEXT PRIMARY KEY,payload TEXT)'); db.prepare('INSERT INTO profile_state_documents VALUES(?,?)').run('workspaceSession', '{bad'); }
  finally { db.close(); }
  assert.equal((await readActiveConversation({ userDataPath: root })).target, null);
});

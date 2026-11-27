import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, readFile, appendFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { discoverUsageUnits } from '../src/harness_parser.mjs';
import { defaultRoots } from '../src/harnesses.mjs';
import { createTpsController } from '../src/controller.mjs';
import { openTokensManagerDb } from '../src/database.mjs';
import { readManagerChannel } from '../src/token_manager.mjs';

let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); }
catch (error) { if (error.code !== 'ERR_UNKNOWN_BUILTIN_MODULE') throw error; }
const sqliteTestOptions = { skip: typeof DatabaseSync === 'function' ? false : 'requires node:sqlite' };

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-tps-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('orca-tps-test-'));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
const jsonl = values => values.map(value => JSON.stringify(value)).join('\n') + '\n';

/** Records the Tokens manager stores for these roots, as one scan reads them. */
async function usageRecords(roots, providers) {
  const units = await discoverUsageUnits(0, { roots, includeDefaults: false, includeRecords: true, providers });
  return (await Promise.all(units.map(unit => unit.read()))).flatMap(result => result.records);
}

/** Current Data for a channel, served from the manager database after one scan. */
async function managerChannel(t, root, records, target) {
  const db = openTokensManagerDb(path.join(root, 'manager'), { timeZone: 'UTC' });
  t.after(() => db.close());
  db.commitSource('fixture', 'stamp', records, Math.max(...records.map(record => record.completedAt)) + 1000);
  return readManagerChannel(db, target);
}

function useProxyDatabase(t, file) {
  const previous = process.env.CC_SWITCH_DB_PATH;
  t.after(() => {
    if (previous === undefined) delete process.env.CC_SWITCH_DB_PATH;
    else process.env.CC_SWITCH_DB_PATH = previous;
  });
  process.env.CC_SWITCH_DB_PATH = file;
}

function codexRows(session = 'same-session', turn = 'one') {
  return [
    { type: 'session_meta', payload: { id: session, cwd: '/test' } },
    { timestamp: '2026-01-01T00:00:00Z', type: 'event_msg', payload: { type: 'task_started', turn_id: turn } },
    { timestamp: '2026-01-01T00:00:02Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { output_tokens: 200, input_tokens: 100, cached_input_tokens: 50 }, last_token_usage: { output_tokens: 200, input_tokens: 100, cached_input_tokens: 50 } } } }
  ];
}

test('a pane session is found by its ID among many newer logs, and missing IDs never fall back', async t => {
  const root = await fixture(t), file = path.join(root, 'rollout-2020-01-01-old-session.jsonl');
  await writeFile(file, jsonl(codexRows('old-session')));
  await utimes(file, 1, 1);
  for (let i = 0; i < 101; i++) await writeFile(path.join(root, `recent-${i}.jsonl`), jsonl(codexRows(`recent-${i}`)));
  const records = await usageRecords({ codex: [root] });
  const channel = await managerChannel(t, root, records, { worktreeId: 'pane', sessions: [{ provider: 'codex', sessionId: 'old-session' }] });
  assert.equal(channel.session.records.length, 1);
  assert.equal(channel.session.records[0].tokensPerSecond, 100);
  const missing = await managerChannel(t, path.join(root, 'other'), records,
    { worktreeId: 'pane', sessions: [{ provider: 'codex', sessionId: 'missing' }] });
  assert.deepEqual(missing.session.records, []);
});

test('Claude session collects subagents/*.jsonl and subagents/workflows/*/*.jsonl without leaking prompts', async t => {
  const root = await fixture(t);
  const sid = 'claude-with-subagents';
  const mainFile = path.join(root, `${sid}.jsonl`);
  const subDir = path.join(root, sid, 'subagents');
  const wfDir = path.join(subDir, 'workflows', 'wf_abc');
  await mkdir(wfDir, { recursive: true });

  await writeFile(mainFile, jsonl([
    { type: 'user', uuid: 'u-main', sessionId: sid, cwd: '/proj', timestamp: '2026-11-07T00:00:00Z', message: { content: 'SECRET_MAIN' } },
    { type: 'assistant', uuid: 'a-main', parentUuid: 'u-main', timestamp: '2026-11-07T00:00:04Z',
      message: { id: 'msg-main', model: 'claude-opus-5-5', stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 240, cache_read_input_tokens: 300, cache_creation_input_tokens: 0 } } }
  ]));
  await writeFile(path.join(subDir, 'agent-1.jsonl'), jsonl([
    { type: 'user', uuid: 'u-sub', sessionId: sid, isSidechain: true, timestamp: '2026-11-07T00:00:01Z', message: { content: 'SECRET_SUB' } },
    { type: 'assistant', uuid: 'a-sub', parentUuid: 'u-sub', isSidechain: true, timestamp: '2026-11-07T00:00:03Z',
      message: { id: 'msg-sub-1', model: 'claude-haiku-5-5', stop_reason: 'end_turn',
        usage: { input_tokens: 50, output_tokens: 200, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 } } }
  ]));
  await writeFile(path.join(wfDir, 'agent-wf.jsonl'), jsonl([
    { type: 'user', uuid: 'u-wf', sessionId: sid, isSidechain: true, timestamp: '2026-11-07T00:00:05Z' },
    { type: 'assistant', uuid: 'a-wf', parentUuid: 'u-wf', isSidechain: true, timestamp: '2026-11-07T00:00:07Z',
      message: { id: 'msg-wf-1', model: 'claude-sonnet-5-5', stop_reason: 'end_turn',
        usage: { input_tokens: 80, output_tokens: 300, cache_read_input_tokens: 120, cache_creation_input_tokens: 0 } } }
  ]));
  await writeFile(path.join(wfDir, 'journal.jsonl'), jsonl([{ event: 'step_done' }]));

  const records = (await usageRecords({ claude: [root] })).sort((a, b) => b.completedAt - a.completedAt);
  assert.equal(records.length, 3);
  assert.equal(records[0].rawId, 'msg-wf-1');
  assert.equal(records[0].isSubagent, true);
  assert.equal(records[0].tokensPerSecond, 150);
  assert.equal(records[1].rawId, 'msg-main');
  assert.equal(records[1].tokensPerSecond, 60);
  assert.equal(records[2].rawId, 'msg-sub-1');
  assert.equal(records[2].tokensPerSecond, 100);
  assert.ok(records.every(record => record.sessionId === sid && record.cwd === '/proj'));
  assert.ok(!JSON.stringify(records).includes('SECRET_'));
});

test('channel reads merge 2xx proxy rows from cc-switch.db in read-only mode without crossing sessions', sqliteTestOptions, async t => {
  const root = await fixture(t);
  const sid = 'claude-proxy-test';
  await writeFile(path.join(root, `${sid}.jsonl`), jsonl([
    { type: 'user', uuid: 'u1', sessionId: sid, timestamp: '2026-11-07T00:00:00Z' },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-11-07T00:00:05Z',
      message: { id: 'm1', model: 'claude-sonnet-5-5', stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 150, cache_read_input_tokens: 400, cache_creation_input_tokens: 0 } } }
  ]));

  const ccDbFile = path.join(root, 'cc-switch.db');
  const db = new DatabaseSync(ccDbFile);
  try {
    db.exec(`CREATE TABLE proxy_request_logs (
      request_id TEXT PRIMARY KEY, session_id TEXT, app_type TEXT, model TEXT, request_model TEXT,
      pricing_model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
      cache_creation_tokens INTEGER, input_token_semantics INTEGER, latency_ms INTEGER,
      first_token_ms INTEGER, status_code INTEGER, created_at INTEGER, data_source TEXT
    );`);
    const ins = db.prepare('INSERT INTO proxy_request_logs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const createdSec = Math.floor(Date.parse('2026-11-07T00:00:05Z') / 1000);
    // Matching 200 proxy row for sid: 150 output tokens over (5000 - 2000) = 3000ms generation -> 50 tok/s exact!
    ins.run('proxy-req-1', sid, 'claude', 'claude-sonnet-5-5', null, null, 100, 150, 400, 0, 0, 5000, 2000, 200, createdSec, 'proxy');
    // Unrelated session's proxy row must NOT leak into sid:
    ins.run('proxy-other', 'other-session', 'claude', 'claude-sonnet-5-5', null, null, 100, 500, 0, 0, 0, 2000, 500, 200, createdSec, 'proxy');
  } finally { db.close(); }
  const bytes = await readFile(ccDbFile);

  useProxyDatabase(t, ccDbFile);
  const channel = await managerChannel(t, root, await usageRecords({ claude: [root] }),
    { worktreeId: 'app', sessions: [{ provider: 'claude', sessionId: sid }] });
  assert.equal(channel.session.records.length, 1);
  assert.equal(channel.session.records[0].dataSource, 'proxy');
  assert.equal(channel.session.records[0].isEstimatedSpeed, false);
  assert.equal(channel.session.records[0].tokensPerSecond, 50);
  assert.equal(channel.session.records[0].firstTokenMs, 2000);
  assert.deepEqual(await readFile(ccDbFile), bytes);
});

test('SQLite usage reads old sessions, separates v1/v2, stays read-only and reads live WAL', sqliteTestOptions, async t => {
  const root = await fixture(t), file = path.join(root, 'opencode.db');
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE session_v2 (id TEXT PRIMARY KEY,title TEXT,directory TEXT,time_updated INTEGER);
      CREATE TABLE session_message (id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,data TEXT,time_created INTEGER);
      CREATE TABLE session (id TEXT PRIMARY KEY,title TEXT,time_updated INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY,session_id TEXT,data TEXT,time_created INTEGER);
      INSERT INTO session_v2 VALUES ('v2','V2 statistics','/project',6000);
      INSERT INTO session VALUES ('v1','V1 statistics',1);`);
    const insert2 = db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?)');
    insert2.run('u2', 'v2', 'user', 1, '{}', 1000);
    insert2.run('a2', 'v2', 'assistant', 2, JSON.stringify({ tokens: { output: 120, reasoning: 80, input: 10, cache: { read: 80, write: 10 } }, time: { created: 2000, streamed: 4000, completed: 6000 } }), 2000);
    insert2.run('idle', 'v2', 'idle', 3, '{}', 6000);
    const insert1 = db.prepare('INSERT INTO message VALUES (?,?,?,?)');
    insert1.run('u1', 'v1', '{"role":"user"}', 1000);
    insert1.run('a1', 'v1', JSON.stringify({ role: 'assistant', finish: 'stop', tokens: { output: 200, input: 10, cache: { read: 0, write: 0 } }, time: { created: 1000, streamed: 5000, completed: 8000 } }), 1000);
    const before = db.prepare('SELECT count(*) AS n FROM session_message').get().n;
    const records = await usageRecords({ opencode: [file] });
    assert.equal(records.length, 2);
    const v2 = records.find(record => record.provider === 'opencode2'), v1 = records.find(record => record.provider === 'opencode');
    assert.equal(v2.tokensPerSecond, 100);
    assert.equal(v2.sessionId, 'v2');
    assert.equal(v2.cwd, '/project');
    assert.equal(v1.tokensPerSecond, 50);
    assert.equal(v1.sessionId, 'v1');
    assert.equal(db.prepare('SELECT count(*) AS n FROM session_message').get().n, before);
  } finally { db.close(); }
});

test('portable defaults respect Windows roaming, Linux XDG homes and CC Switch database path', () => {
  const linux = defaultRoots({ home: '/home/person', platform: 'linux', env: { XDG_CONFIG_HOME: '/config', XDG_DATA_HOME: '/data' } });
  assert.ok(linux.roots.codex.includes('/config/orca/codex-runtime-home/home/sessions'));
  assert.deepEqual(linux.roots.opencode, ['/data/opencode/opencode.db']);
  assert.equal(linux.ccSwitchDb, '/home/person/.cc-switch/cc-switch.db');
  const win = defaultRoots({ home: 'C:\\Users\\person', platform: 'win32', env: { APPDATA: 'D:\\Roaming' } });
  assert.ok(win.roots.codex.includes('D:\\Roaming\\orca\\codex-runtime-home\\home\\sessions'));
  assert.equal(win.ccSwitchDb, 'C:\\Users\\person\\.cc-switch\\cc-switch.db');
});

test('copied sessions count once, credentials are never read and prompts never leave the parser', async t => {
  const root = await fixture(t), mirror = path.join(root, 'mirror');
  await mkdir(mirror);
  await writeFile(path.join(root, 'rollout.jsonl'), jsonl(codexRows()));
  await writeFile(path.join(mirror, 'copy.jsonl'), jsonl(codexRows()));
  await writeFile(path.join(root, 'auth.json'), '{"secret":"DO_NOT_READ_ME"}');
  const records = await usageRecords({ codex: [root] });
  const channel = await managerChannel(t, root, records, { worktreeId: 'app', worktreePath: '/test', sessions: [] });
  assert.equal(channel.session.records.length, 1);
  assert.equal(channel.session.records[0].tokensPerSecond, 100);
  assert.ok(!JSON.stringify(records).includes('DO_NOT_READ_ME'));
});

test('a half-written final JSON line stays uncounted until it completes', async t => {
  const root = await fixture(t), file = path.join(root, 'rollout.jsonl');
  const rows = codexRows();
  await writeFile(file, jsonl(rows.slice(0, 2)));
  assert.deepEqual(await usageRecords({ codex: [root] }), []);
  const last = JSON.stringify(rows[2]);
  await appendFile(file, last.slice(0, 40));
  assert.deepEqual(await usageRecords({ codex: [root] }), []);
  await appendFile(file, last.slice(40) + '\n');
  assert.equal((await usageRecords({ codex: [root] })).length, 1);
});

test('unsupported databases and missing roots return empty data without writing', sqliteTestOptions, async t => {
  const root = await fixture(t), file = path.join(root, 'other.db');
  const db = new DatabaseSync(file); db.exec('CREATE TABLE unrelated (id TEXT)'); db.close();
  const bytes = await readFile(file);
  assert.deepEqual(await usageRecords({ opencode: [file], pi: [path.join(root, 'missing')] }), []);
  assert.deepEqual(await readFile(file), bytes);
});

test('channel views merge registered panes and same-folder sessions across providers while isolating the parent worktree', sqliteTestOptions, async t => {
  const root = await fixture(t);
  const claudeRoot = path.join(root, 'claude');
  const codexPrimary = path.join(root, 'codex-home');
  const codexMirror = path.join(root, 'codex-runtime');
  const agyBrain = path.join(root, 'agy', 'brain', 'agy-conv-1', '.system_generated', 'logs');
  for (const directory of [claudeRoot, codexPrimary, codexMirror, agyBrain]) await mkdir(directory, { recursive: true });

  const channelWinSlash = 'D:/orca/workspace/Orca-TPS-Plugin/1.5.0';
  const channelWinBackslash = 'D:\\orca\\workspace\\Orca-TPS-Plugin\\1.5.0';

  // 1. Registered Terminal 1: Claude session at t=2000ms
  await writeFile(path.join(claudeRoot, 'claude-t1.jsonl'), jsonl([
    { type: 'user', uuid: 'u1', sessionId: 'claude-t1', cwd: channelWinBackslash, timestamp: '2026-11-13T01:00:00Z', message: { content: 'SECRET_T1' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-11-13T01:00:02Z',
      message: { id: 'msg-t1', model: 'claude-opus-5-5', stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 240, cache_read_input_tokens: 400, cache_creation_input_tokens: 0 } } }
  ]));

  // 2. Unregistered Terminal 2 (started manually in cmd.exe): Codex session at t=5000ms, mirrored in two roots
  const codexT2Rows = [
    { type: 'session_meta', payload: { id: 'codex-t2', cwd: 'd:\\orca\\workspace\\orca-tps-plugin\\1.5.0\\', prompt: 'SECRET_T2' } },
    { timestamp: '2026-11-13T01:00:03Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 't2' } },
    { timestamp: '2026-11-13T01:00:05Z', type: 'event_msg', payload: {
      type: 'token_count',
      info: { model: 'gpt-6.1-sol', total_token_usage: { output_tokens: 300, input_tokens: 200, cached_input_tokens: 100 }, last_token_usage: { output_tokens: 300, input_tokens: 200, cached_input_tokens: 100 } }
    } }
  ];
  await writeFile(path.join(codexPrimary, 'rollout-codex-t2.jsonl'), jsonl(codexT2Rows));
  await writeFile(path.join(codexMirror, 'rollout-codex-t2.jsonl'), jsonl(codexT2Rows));

  // 3. Historical session in same channel directory: Claude session at t=1000ms
  await writeFile(path.join(claudeRoot, 'claude-old.jsonl'), jsonl([
    { type: 'user', uuid: 'u0', sessionId: 'claude-old', cwd: channelWinSlash, timestamp: '2026-11-13T00:59:58Z' },
    { type: 'assistant', uuid: 'a0', parentUuid: 'u0', timestamp: '2026-11-13T01:00:01Z',
      message: { id: 'msg-old', model: 'claude-haiku-5-5', stop_reason: 'end_turn',
        usage: { input_tokens: 50, output_tokens: 200, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 } } }
  ]));

  // 4. OpenCode v2 session matching channel CWD at t=6000ms + parent repo session that must be excluded
  const ocDb = path.join(root, 'opencode.db');
  const db = new DatabaseSync(ocDb);
  try {
    db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_updated INTEGER);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, data TEXT, time_created INTEGER);`);
    db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?)').run('oc-in-channel', 'OC', channelWinBackslash, Date.parse('2026-11-13T01:00:06Z'));
    db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?)').run('oc-parent', 'Parent', 'D:\\orca\\workspace\\Orca-TPS-Plugin', Date.parse('2026-11-13T01:00:09Z'));
    const ins = db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?)');
    ins.run('m1', 'oc-in-channel', 'assistant', 1, JSON.stringify({
      modelID: 'glm-5.3', tokens: { input: 100, output: 250, reasoning: 0, cache: { read: 100, write: 0 } },
      time: { created: Date.parse('2026-11-13T01:00:04Z'), streamed: Date.parse('2026-11-13T01:00:06Z'), completed: Date.parse('2026-11-13T01:00:06Z') }
    }), Date.parse('2026-11-13T01:00:04Z'));
    ins.run('m2', 'oc-parent', 'assistant', 1, JSON.stringify({
      modelID: 'leaked-parent-model', tokens: { input: 100, output: 500, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: Date.parse('2026-11-13T01:00:07Z'), completed: Date.parse('2026-11-13T01:00:09Z') }
    }), Date.parse('2026-11-13T01:00:07Z'));
  } finally { db.close(); }

  // 5. Parent repo Codex session (must NOT leak into 1.5.0 worktree)
  await writeFile(path.join(codexPrimary, 'rollout-parent.jsonl'), jsonl([
    { type: 'session_meta', payload: { id: 'codex-parent', cwd: 'D:\\orca\\workspace\\Orca-TPS-Plugin' } },
    { timestamp: '2026-11-13T01:00:08Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'p1' } },
    { timestamp: '2026-11-13T01:00:10Z', type: 'event_msg', payload: {
      type: 'token_count',
      info: { model: 'leaked-codex', total_token_usage: { output_tokens: 400, input_tokens: 100, cached_input_tokens: 0 }, last_token_usage: { output_tokens: 400, input_tokens: 100, cached_input_tokens: 0 } }
    } }
  ]));

  // 6. Registered Antigravity session in the same channel (no workspace in its store, resolved via target.sessions)
  await writeFile(path.join(agyBrain, 'transcript.jsonl'), jsonl([
    { step_index: 1, created_at: '2026-11-13T01:00:07Z', input_tokens: 80, output_tokens: 220, cache_read_tokens: 20 }
  ]));

  const records = await usageRecords({
    claude: [claudeRoot], codex: [codexPrimary, codexMirror], opencode: [ocDb], antigravity: [path.join(root, 'agy', 'brain')]
  });
  const channel = await managerChannel(t, root, records, {
    key: 'ch-key', worktreeId: `repo-1::${channelWinSlash}`, worktreePath: channelWinSlash, title: 'Orca-TPS-Plugin/1.5.0',
    sessions: [{ provider: 'claude', sessionId: 'claude-t1' }, { provider: 'antigravity', sessionId: 'agy-conv-1' }]
  });

  assert.equal(channel.session.id, `channel:repo-1::${channelWinSlash}`);
  assert.equal(channel.session.provider, 'channel');
  assert.equal(channel.session.title, 'Orca-TPS-Plugin/1.5.0');
  assert.deepEqual(
    channel.session.records.map(r => `${r.provider}:${r.model ?? 'agy'}`),
    ['antigravity:agy', 'opencode2:glm-5.3', 'codex:gpt-6.1-sol', 'claude:claude-opus-5-5', 'claude:claude-haiku-5-5'],
    'all 5 channel requests appear newest-first with no mirror duplicates and no parent-repo leaks'
  );
  assert.ok(!JSON.stringify(channel).includes('SECRET_'));
});

test('Codex records keep the folder from session_meta headers larger than 16 KiB', async t => {
  const root = await fixture(t), codexRoot = path.join(root, 'codex');
  await mkdir(codexRoot, { recursive: true });
  await writeFile(path.join(codexRoot, 'rollout-big-header.jsonl'), jsonl([
    { type: 'session_meta', payload: { id: 'codex-big-meta', cwd: 'D:\\orca\\workspace\\Orca-TPS-Plugin\\1.5.0', base_instructions: 'x'.repeat(30_000) } },
    { timestamp: '2026-11-13T03:00:00Z', type: 'event_msg', payload: { type: 'task_started', turn_id: '1' } },
    { timestamp: '2026-11-13T03:00:02Z', type: 'event_msg', payload: {
      type: 'token_count',
      info: { model: 'gpt-6.1-sol', total_token_usage: { output_tokens: 300, input_tokens: 100, cached_input_tokens: 50 }, last_token_usage: { output_tokens: 300, input_tokens: 100, cached_input_tokens: 50 } }
    } }
  ]));
  const channel = await managerChannel(t, root, await usageRecords({ codex: [codexRoot] }),
    { worktreeId: 'repo-1', worktreePath: 'D:/orca/workspace/Orca-TPS-Plugin/1.5.0', sessions: [] });
  assert.equal(channel.session.records.length, 1);
  assert.equal(channel.session.records[0].provider, 'codex');
  assert.equal(channel.session.records[0].tokensPerSecond, 150);
});

test('an unavailable channel read retains the last statistics and recovers on the next refresh', async t => {
  const records = [{ id: 'one', provider: 'codex', completedAt: 1000, outputTokens: 1 }];
  let target = { worktreeId: 'app', sessions: [{ provider: 'codex', sessionId: 'recover' }] }, available = true;
  const register = () => ({ dispose() {} });
  const controller = createTpsController({
    storage: { get: async () => null }, panels: { handle: register, post() {} },
    commands: { register }, host: { call: async () => {} }, log() {}
  }, {
    readActive: async () => ({ target }),
    readSession: async active => !available ? { session: null, warnings: [['notice.session-read-failed', 'codex', 'ENOENT']] }
      : { session: { id: `channel:${active.worktreeId}`, provider: 'channel', records: active.worktreeId === 'app' ? records : [] }, warnings: [] },
    focusPollMs: 0
  });
  t.after(() => controller.stop());
  await controller.start();
  assert.equal(controller.state().records.length, 1);
  available = false;
  await controller.refresh();
  assert.equal(controller.state().records.length, 1, 'an unavailable channel is not a successfully empty channel');
  assert.ok(controller.state().warnings.length > 0);
  available = true;
  await controller.refresh();
  assert.equal(controller.state().records.length, 1);
  assert.deepEqual(controller.state().warnings, []);
  target = { worktreeId: 'other', worktreePath: '/empty', sessions: [] };
  await controller.refresh();
  assert.deepEqual(controller.state().records, [], 'a genuinely empty new channel must clear old records');
  assert.deepEqual(controller.state().warnings, []);
});

test('channel proxy matching keeps different sessions with identical usage as distinct requests', sqliteTestOptions, async t => {
  const root = await fixture(t), sessions = [];
  for (const [i, sessionId] of ['first', 'second'].entries()) {
    const rows = codexRows(sessionId);
    rows[1].timestamp = new Date(Date.parse(rows[1].timestamp) + i * 10000).toISOString();
    rows[2].timestamp = new Date(Date.parse(rows[2].timestamp) + i * 10000).toISOString();
    rows[2].payload.info.model = 'gpt-test';
    await writeFile(path.join(root, `${sessionId}.jsonl`), jsonl(rows));
    sessions.push({ provider: 'codex', sessionId });
  }
  const dbPath = path.join(root, 'proxy.db'), db = new DatabaseSync(dbPath);
  try {
    db.exec(`CREATE TABLE proxy_request_logs (request_id TEXT, app_type TEXT, model TEXT,
      input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_creation_tokens INTEGER,
      latency_ms INTEGER, first_token_ms INTEGER, status_code INTEGER, created_at INTEGER);`);
    const insert = db.prepare('INSERT INTO proxy_request_logs VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    const start = Date.parse('2026-01-01T00:00:02Z') / 1000;
    insert.run('proxy-first', 'codex', 'gpt-test', 50, 200, 50, 0, 2000, 500, 200, start);
    insert.run('proxy-second', 'codex', 'gpt-test', 50, 200, 50, 0, 4000, 1000, 200, start + 10);
  } finally { db.close(); }
  useProxyDatabase(t, dbPath);
  const channel = await managerChannel(t, root, await usageRecords({ codex: [root] }), { worktreeId: 'app', sessions });
  assert.deepEqual(channel.session.records.map(record => record.id), ['proxy:proxy-second', 'proxy:proxy-first']);
  assert.ok(channel.session.records.every(record => record.provider === 'codex' && !record.isEstimatedSpeed));
});

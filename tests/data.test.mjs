import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, readFile, appendFile, utimes } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { scanSessions, readTargetSession } from '../src/data.mjs';
import { defaultRoots } from '../src/data-paths.mjs';
import { createTpsController } from '../src/controller.mjs';

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

test('targeted JSONL lookup finds a conversation older than the latest 100 files', async t => {
  const root = await fixture(t), file = path.join(root, 'rollout-2020-01-01-old-session.jsonl');
  await writeFile(file, jsonl(codexRows('old-session')));
  await utimes(file, 1, 1);
  for (let i = 0; i < 101; i++) await writeFile(path.join(root, `recent-${i}.jsonl`), jsonl(codexRows(`recent-${i}`)));
  const options = { roots: { codex: [root] }, includeDefaults: false };
  assert.ok(!(await scanSessions(options)).sessions.some(session => session.id === 'codex:old-session'));
  const target = { key: 'pane-old', provider: 'codex', sessionId: 'old-session' };
  const found = await readTargetSession(target, options);
  assert.equal(found.session.id, 'codex:old-session');
  assert.equal(found.session.records[0].tokensPerSecond, 100);
  assert.deepEqual(found.warnings, []);
  assert.equal((await readTargetSession({ ...target, transcriptPath: file }, options)).session.id, 'codex:old-session');
});

test('targeted JSONL reads verify metadata even after scan cache hits and filename matches', async t => {
  const root = await fixture(t), file = path.join(root, 'wanted.jsonl');
  const options = { roots: { codex: [root] }, includeDefaults: false };
  await writeFile(file, jsonl(codexRows('different')));
  await scanSessions(options);
  const target = { provider: 'codex', sessionId: 'wanted', transcriptPath: file };
  assert.equal((await readTargetSession(target, options)).session, null);
  assert.equal((await readTargetSession({ ...target, transcriptPath: undefined }, options)).session, null);
  assert.equal((await readTargetSession({ ...target, sessionId: 'different' }, options)).session.id, 'codex:different');
  // A replacement file must invalidate both the session records and its cached identity.
  await writeFile(file, jsonl(codexRows('wanted', 'replacement-turn')));
  assert.equal((await readTargetSession(target, options)).session.id, 'codex:wanted');
  assert.equal((await readTargetSession({ ...target, sessionId: 'different' }, options)).session, null);
});

test('missing target paths or IDs never fall back to another conversation', async t => {
  const root = await fixture(t), file = path.join(root, 'available.jsonl');
  await writeFile(file, jsonl(codexRows('available')));
  const options = { roots: { codex: [root] }, includeDefaults: false };
  assert.equal((await readTargetSession({ provider: 'codex', sessionId: 'missing' }, options)).session, null);
  assert.equal((await readTargetSession({ provider: 'codex', sessionId: 'available', transcriptPath: path.join(root, 'missing.jsonl') }, options)).session, null);
  await writeFile(path.join(root, 'no-metadata.jsonl'), jsonl(codexRows().slice(1)));
  assert.equal((await readTargetSession({ provider: 'codex', sessionId: 'no-metadata', transcriptPath: path.join(root, 'no-metadata.jsonl') }, options)).session, null);
});

test('targeted lookup supports renamed logs and scopes remembered paths to configured roots', async t => {
  const root = await fixture(t), first = path.join(root, 'first'), second = path.join(root, 'second');
  await mkdir(first); await mkdir(second);
  await writeFile(path.join(first, 'renamed.jsonl'), jsonl(codexRows('wanted')));
  await writeFile(path.join(second, 'renamed.jsonl'), jsonl(codexRows('different')));
  const target = { provider: 'codex', sessionId: 'wanted', title: 'Current title' };
  const result = await readTargetSession(target, { roots: { codex: [first] }, includeDefaults: false });
  assert.equal(result.session.id, 'codex:wanted');
  assert.equal(result.session.title, 'Current title');
  assert.equal((await readTargetSession(target, { roots: { codex: [second] }, includeDefaults: false })).session, null);
});

test('Claude and Pi explicit paths require their own session metadata', async t => {
  const root = await fixture(t);
  for (const [provider, row] of [['claude', { sessionId: 'selected', cwd: '/test' }], ['pi', { type: 'session', id: 'selected', cwd: '/test' }]]) {
    const file = path.join(root, `${provider}.jsonl`);
    await writeFile(file, jsonl([row]));
    const target = { provider, sessionId: 'selected', transcriptPath: file };
    assert.equal((await readTargetSession(target, { includeDefaults: false })).session.id, `${provider}:selected`);
    assert.equal((await readTargetSession({ ...target, sessionId: 'other' }, { includeDefaults: false })).session, null);
  }
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

  const res = await readTargetSession({ provider: 'claude', sessionId: sid, transcriptPath: mainFile }, { includeDefaults: false });
  assert.equal(res.session.records.length, 3);
  assert.equal(res.session.records[0].rawId, 'msg-wf-1');
  assert.equal(res.session.records[0].isSubagent, true);
  assert.equal(res.session.records[0].tokensPerSecond, 150);
  assert.equal(res.session.records[1].rawId, 'msg-main');
  assert.equal(res.session.records[1].tokensPerSecond, 60);
  assert.equal(res.session.records[2].rawId, 'msg-sub-1');
  assert.equal(res.session.records[2].tokensPerSecond, 100);
  assert.ok(!JSON.stringify(res).includes('SECRET_'));
});

test('readTargetSession merges 2xx proxy rows from cc-switch.db in read-only mode without crossing sessions', sqliteTestOptions, async t => {
  const root = await fixture(t);
  const sid = 'claude-proxy-test';
  const mainFile = path.join(root, `${sid}.jsonl`);
  await writeFile(mainFile, jsonl([
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

  const res = await readTargetSession(
    { provider: 'claude', sessionId: sid, transcriptPath: mainFile },
    { includeDefaults: false, ccSwitchDb: ccDbFile }
  );
  assert.equal(res.session.records.length, 1);
  assert.equal(res.session.records[0].dataSource, 'proxy');
  assert.equal(res.session.records[0].isEstimatedSpeed, false);
  assert.equal(res.session.records[0].tokensPerSecond, 50);
});

test('targeted SQLite lookup reads old IDs, separates v1/v2 and never falls back', sqliteTestOptions, async t => {
  const root = await fixture(t), file = path.join(root, 'opencode.db');
  const db = new DatabaseSync(file);
  try {
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY,title TEXT,time_updated INTEGER,parent_id TEXT);
      CREATE TABLE message (id TEXT PRIMARY KEY,session_id TEXT,data TEXT,time_created INTEGER);
      CREATE TABLE session_v2 (id TEXT PRIMARY KEY,title TEXT,time_updated INTEGER);
      CREATE TABLE session_message (id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,data TEXT,time_created INTEGER);
      INSERT INTO session VALUES ('old','Old V1',1,NULL);
      INSERT INTO session_v2 VALUES ('old','Old V2',1);
      WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<101)
      INSERT INTO session SELECT 'recent-'||n,'Recent',n+10,NULL FROM numbers;`);
    const insert = db.prepare('INSERT INTO message VALUES (?,?,?,?)');
    insert.run('u', 'old', '{"role":"user"}', 1000);
    insert.run('a', 'old', JSON.stringify({ role: 'assistant', finish: 'stop', tokens: { output: 200 }, time: { created: 1000, streamed: 5000, completed: 9000 } }), 1000);
    const insert2 = db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?)');
    insert2.run('u2', 'old', 'user', 1, '{}', 1000);
    insert2.run('a2', 'old', 'assistant', 2, JSON.stringify({ tokens: { output: 300, reasoning: 100 }, time: { created: 1000, streamed: 5000, completed: 9000 } }), 1000);
    insert2.run('idle', 'old', 'idle', 3, '{}', 9000);
  } finally { db.close(); }
  const options = { roots: { opencode: [file] }, includeDefaults: false };
  // Populate the broad-scan cache before exact lookup; the old v1 session is absent.
  assert.ok(!(await scanSessions(options)).sessions.some(session => session.id === 'opencode:old'));
  const target = { provider: 'opencode', sessionId: 'old', dbPath: file };
  const v1 = await readTargetSession(target, options);
  assert.equal(v1.session.id, 'opencode:old');
  assert.equal(v1.session.records[0].tokensPerSecond, 50);
  const v2 = await readTargetSession({ ...target, provider: 'opencode2' }, options);
  assert.equal(v2.session.id, 'opencode2:old');
  assert.equal(v2.session.records[0].tokensPerSecond, 100);
  assert.equal((await readTargetSession({ ...target, dbPath: undefined }, options)).session.id, 'opencode:old');
  assert.equal((await readTargetSession({ ...target, sessionId: "old' OR 1=1 --" }, options)).session, null);
  assert.equal((await readTargetSession({ ...target, dbPath: path.join(root, 'absent.db') }, options)).session, null);
});

function codexRows(session = 'same-session', turn = 'one') {
  return [
    { type: 'session_meta', payload: { id: session, cwd: '/test' } },
    { timestamp: '2026-01-01T00:00:00Z', type: 'event_msg', payload: { type: 'task_started', turn_id: turn } },
    { timestamp: '2026-01-01T00:00:02Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { output_tokens: 200, input_tokens: 100, cached_input_tokens: 50 }, last_token_usage: { output_tokens: 200, input_tokens: 100, cached_input_tokens: 50 } } } }
  ];
}

test('portable defaults respect Windows roaming, Linux XDG homes and CC Switch database path', () => {
  const linux = defaultRoots({ home: '/home/person', platform: 'linux', env: { XDG_CONFIG_HOME: '/config', XDG_DATA_HOME: '/data' } });
  assert.ok(linux.roots.codex.includes('/config/orca/codex-runtime-home/home/sessions'));
  assert.deepEqual(linux.roots.opencode, ['/data/opencode/opencode.db']);
  assert.equal(linux.ccSwitchDb, '/home/person/.cc-switch/cc-switch.db');
  const win = defaultRoots({ home: 'C:\\Users\\person', platform: 'win32', env: { APPDATA: 'D:\\Roaming' } });
  assert.ok(win.roots.codex.includes('D:\\Roaming\\orca\\codex-runtime-home\\home\\sessions'));
  assert.equal(win.ccSwitchDb, 'C:\\Users\\person\\.cc-switch\\cc-switch.db');
});

test('scan deduplicates mirrored sessions, reads no credentials and does not expose prompts', async t => {
  const root = await fixture(t), mirror = path.join(root, 'mirror');
  await mkdir(mirror);
  await writeFile(path.join(root, 'rollout.jsonl'), jsonl(codexRows()));
  await writeFile(path.join(mirror, 'copy.jsonl'), jsonl(codexRows()));
  await writeFile(path.join(root, 'auth.json'), '{"secret":"DO_NOT_READ_ME"}');
  const result = await scanSessions({ roots: { codex: [root] }, includeDefaults: false });
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].records[0].tokensPerSecond, 100);
  assert.ok(!JSON.stringify(result).includes('DO_NOT_READ_ME'));
});

test('changed file invalidates the parse cache while partial final JSON stays uncounted', async t => {
  const root = await fixture(t), file = path.join(root, 'rollout.jsonl');
  const rows = codexRows();
  await writeFile(file, jsonl(rows.slice(0, 2)));
  const options = { roots: { codex: [root] }, includeDefaults: false };
  assert.deepEqual((await scanSessions(options)).sessions[0].records, []);
  await appendFile(file, JSON.stringify(rows[2]));
  assert.deepEqual((await scanSessions(options)).sessions[0].records, []);
  await appendFile(file, '\n');
  assert.equal((await scanSessions(options)).sessions[0].records.length, 1);
});

test('JSONL cache preserves truncation warnings without retaining another source warning', async t => {
  const root = await fixture(t), large = path.join(root, 'large.jsonl'), small = path.join(root, 'small.jsonl');
  const largeRows = codexRows('large-session');
  await writeFile(large, Buffer.concat([
    Buffer.from(jsonl(largeRows.slice(0, 1))), Buffer.alloc(16 * 1024 * 1024, 32),
    Buffer.from('\n' + jsonl(largeRows.slice(1)))
  ]));
  await writeFile(small, jsonl(codexRows('small-session')));
  const first = await scanSessions({ roots: { codex: [homedir(), large, small] }, includeDefaults: false });
  assert.ok(first.warnings.some(value => value.includes('16 MiB')));
  assert.ok(first.warnings.some(value => value.includes('用户主目录')));
  const cachedLarge = await scanSessions({ roots: { codex: [large] }, includeDefaults: false });
  assert.ok(cachedLarge.warnings.some(value => value.includes('16 MiB')));
  assert.ok(!cachedLarge.warnings.some(value => value.includes('用户主目录')));
  const cachedSmall = await scanSessions({ roots: { codex: [small] }, includeDefaults: false });
  assert.deepEqual(cachedSmall.warnings, []);
});

test('SQLite scans v2 and v1 separately, stays read-only and reads live WAL', sqliteTestOptions, async t => {
  const root = await fixture(t), file = path.join(root, 'opencode.db');
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE session_v2 (id TEXT PRIMARY KEY,title TEXT,directory TEXT,time_updated INTEGER);
      CREATE TABLE session_message (id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,data TEXT,time_created INTEGER);
      CREATE TABLE session (id TEXT PRIMARY KEY,title TEXT,time_updated INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY,session_id TEXT,data TEXT,time_created INTEGER);
      INSERT INTO session_v2 VALUES ('v2','V2 statistics','/project',6000);
      INSERT INTO session VALUES ('v1','V1 statistics',5000);`);
    const insert2 = db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?)');
    insert2.run('u2', 'v2', 'user', 1, '{}', 1000);
    insert2.run('a2', 'v2', 'assistant', 2, JSON.stringify({ tokens: { output: 120, reasoning: 80, input: 10, cache: { read: 80, write: 10 } }, time: { created: 2000, streamed: 4000, completed: 6000 } }), 2000);
    insert2.run('idle', 'v2', 'idle', 3, '{}', 6000);
    const insert1 = db.prepare('INSERT INTO message VALUES (?,?,?,?)');
    insert1.run('u1', 'v1', '{"role":"user"}', 1000);
    insert1.run('a1', 'v1', JSON.stringify({ role: 'assistant', finish: 'stop', tokens: { output: 200, input: 10, cache: { read: 0, write: 0 } }, time: { created: 1000, streamed: 5000, completed: 8000 } }), 1000);
    const before = db.prepare('SELECT count(*) AS n FROM session_message').get().n;
    const result = await scanSessions({ roots: { opencode: [file] }, includeDefaults: false });
    assert.deepEqual(result.warnings, []);
    assert.equal(result.sessions.length, 2);
    assert.equal(result.sessions.find(value => value.provider === 'opencode2').records[0].tokensPerSecond, 100);
    assert.equal(result.sessions.find(value => value.provider === 'opencode').records[0].tokensPerSecond, 50);
    assert.equal(db.prepare('SELECT count(*) AS n FROM session_message').get().n, before);
  } finally { db.close(); }
});

test('unsupported database and missing roots return warnings or empty data, never estimates', sqliteTestOptions, async t => {
  const root = await fixture(t), file = path.join(root, 'other.db');
  const db = new DatabaseSync(file); db.exec('CREATE TABLE unrelated (id TEXT)'); db.close();
  const bytes = await readFile(file);
  const result = await scanSessions({ roots: { opencode: [file], pi: [path.join(root, 'missing')] }, includeDefaults: false });
  assert.deepEqual(result.sessions, []);
  assert.ok(result.warnings.some(value => value.includes('受支持')));
  const cached = await scanSessions({ roots: { opencode: [file] }, includeDefaults: false });
  assert.deepEqual(cached.warnings, result.warnings);
  assert.deepEqual(await readFile(file), bytes);
});

test('SQLite cache retains row truncation without copying warnings from another database', sqliteTestOptions, async t => {
  const root = await fixture(t), large = path.join(root, 'large.db'), unsupported = path.join(root, 'unsupported.db');
  const db = new DatabaseSync(large);
  try {
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY);
      CREATE TABLE message (id TEXT PRIMARY KEY,session_id TEXT,data TEXT,time_created INTEGER);
      INSERT INTO session VALUES ('large');
      WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<10001)
      INSERT INTO message SELECT 'message-'||n,'large','{"role":"system"}',n FROM numbers;`);
  } finally { db.close(); }
  const other = new DatabaseSync(unsupported);
  try { other.exec('CREATE TABLE unrelated (id TEXT)'); } finally { other.close(); }
  const first = await scanSessions({ roots: { opencode: [unsupported, large] }, includeDefaults: false });
  assert.ok(first.warnings.some(value => value.includes('10000')));
  assert.ok(first.warnings.some(value => value.includes('受支持')));
  const cachedLarge = await scanSessions({ roots: { opencode: [large] }, includeDefaults: false });
  assert.ok(cachedLarge.warnings.some(value => value.includes('10000')));
  assert.ok(!cachedLarge.warnings.some(value => value.includes('受支持')));
  const cachedOther = await scanSessions({ roots: { opencode: [unsupported] }, includeDefaults: false });
  assert.ok(cachedOther.warnings.some(value => value.includes('受支持')));
  assert.ok(!cachedOther.warnings.some(value => value.includes('10000')));
});

test('channel target merges registered panes and unregistered CWD sessions across providers while isolating parent worktree', sqliteTestOptions, async t => {
  const root = await fixture(t);
  const claudeRoot = path.join(root, 'claude');
  const codexPrimary = path.join(root, 'codex-home');
  const codexMirror = path.join(root, 'codex-runtime');
  const agyBrain = path.join(root, 'agy', 'brain', 'agy-conv-1', '.system_generated', 'logs');
  await mkdir(claudeRoot, { recursive: true });
  await mkdir(codexPrimary, { recursive: true });
  await mkdir(codexMirror, { recursive: true });
  await mkdir(agyBrain, { recursive: true });

  const channelWinSlash = 'D:/orca/workspace/Orca-TPS-Plugin/1.5.0';
  const channelWinBackslash = 'D:\\orca\\workspace\\Orca-TPS-Plugin\\1.5.0';

  // 1. Registered Terminal 1: Claude session at t=2000ms
  const claudeMain = path.join(claudeRoot, 'claude-t1.jsonl');
  await writeFile(claudeMain, jsonl([
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

  // 6. Registered Antigravity session in the same channel (no cwd in transcript, resolved via target.sessions)
  const agyTranscript = path.join(agyBrain, 'transcript.jsonl');
  await writeFile(agyTranscript, jsonl([
    { step_index: 1, created_at: '2026-11-13T01:00:07Z', input_tokens: 80, output_tokens: 220, cache_read_tokens: 20 }
  ]));

  const channelTarget = {
    key: 'ch-key',
    worktreeId: `repo-1::${channelWinSlash}`,
    worktreePath: channelWinSlash,
    title: 'Orca-TPS-Plugin/1.5.0',
    sessions: [
      { provider: 'claude', sessionId: 'claude-t1', transcriptPath: claudeMain },
      { provider: 'antigravity', sessionId: 'agy-conv-1', transcriptPath: agyTranscript }
    ]
  };
  const res = await readTargetSession(channelTarget, {
    roots: {
      claude: [claudeRoot],
      codex: [codexPrimary, codexMirror],
      opencode: [ocDb],
      antigravity: [path.join(root, 'agy', 'brain')]
    },
    includeDefaults: false,
    platform: 'win32'
  });

  assert.equal(res.session.id, `channel:repo-1::${channelWinSlash}`);
  assert.equal(res.session.provider, 'channel');
  assert.equal(res.session.title, 'Orca-TPS-Plugin/1.5.0');
  assert.deepEqual(
    res.session.records.map(r => `${r.provider}:${r.model ?? 'agy'}`),
    [
      'antigravity:agy',
      'opencode2:glm-5.3',
      'codex:gpt-6.1-sol',
      'claude:claude-opus-5-5',
      'claude:claude-haiku-5-5'
    ],
    'all 5 channel requests appear newest-first with no mirror duplicates and no parent-repo leaks'
  );
  assert.ok(!JSON.stringify(res).includes('SECRET_'));
});

test('empty channel returns empty records without error warnings and fresh refresh immediately sees a newly spawned terminal', async t => {
  const root = await fixture(t), codexRoot = path.join(root, 'codex');
  await mkdir(codexRoot, { recursive: true });
  const channelTarget = {
    key: 'new-ch',
    worktreeId: 'repo-1::/workspace/app/feat-x',
    worktreePath: '/workspace/app/feat-x',
    title: 'app/feat-x',
    sessions: []
  };
  const opts = { roots: { codex: [codexRoot] }, includeDefaults: false, platform: 'linux' };
  const emptyRes = await readTargetSession(channelTarget, opts);
  assert.equal(emptyRes.session.id, 'channel:repo-1::/workspace/app/feat-x');
  assert.deepEqual(emptyRes.session.records, []);
  assert.deepEqual(emptyRes.warnings, []);

  // Spawn a brand-new session in Terminal 2 immediately afterwards and force a fresh read:
  await writeFile(path.join(codexRoot, 'rollout-new.jsonl'), jsonl([
    { type: 'session_meta', payload: { id: 'new-t2', cwd: '/workspace/app/feat-x/' } },
    { timestamp: '2026-11-13T02:00:00Z', type: 'event_msg', payload: { type: 'task_started', turn_id: '1' } },
    { timestamp: '2026-11-13T02:00:02Z', type: 'event_msg', payload: {
      type: 'token_count',
      info: { model: 'gpt-6.1-sol', total_token_usage: { output_tokens: 260, input_tokens: 100, cached_input_tokens: 0 }, last_token_usage: { output_tokens: 260, input_tokens: 100, cached_input_tokens: 0 } }
    } }
  ]));
  const refreshed = await readTargetSession(channelTarget, { ...opts, fresh: true });
  assert.equal(refreshed.session.records.length, 1);
  assert.equal(refreshed.session.records[0].provider, 'codex');
  assert.equal(refreshed.session.records[0].tokensPerSecond, 130);
});

test('channel CWD lookup parses Codex session_meta headers larger than 16 KiB', async t => {
  const root = await fixture(t), codexRoot = path.join(root, 'codex');
  await mkdir(codexRoot, { recursive: true });
  const bigInstructions = 'x'.repeat(30_000);
  await writeFile(path.join(codexRoot, 'rollout-big-header.jsonl'), jsonl([
    { type: 'session_meta', payload: { id: 'codex-big-meta', cwd: 'D:\\orca\\workspace\\Orca-TPS-Plugin\\1.5.0', base_instructions: bigInstructions } },
    { timestamp: '2026-11-13T03:00:00Z', type: 'event_msg', payload: { type: 'task_started', turn_id: '1' } },
    { timestamp: '2026-11-13T03:00:02Z', type: 'event_msg', payload: {
      type: 'token_count',
      info: { model: 'gpt-6.1-sol', total_token_usage: { output_tokens: 300, input_tokens: 100, cached_input_tokens: 50 }, last_token_usage: { output_tokens: 300, input_tokens: 100, cached_input_tokens: 50 } }
    } }
  ]));
  const res = await readTargetSession({
    key: 'ch-big',
    worktreeId: 'repo-1::D:/orca/workspace/Orca-TPS-Plugin/1.5.0',
    worktreePath: 'D:/orca/workspace/Orca-TPS-Plugin/1.5.0',
    sessions: []
  }, { roots: { codex: [codexRoot] }, includeDefaults: false, platform: 'win32' });
  assert.equal(res.session.records.length, 1);
  assert.equal(res.session.records[0].provider, 'codex');
  assert.equal(res.session.records[0].tokensPerSecond, 150);
});

test('channel OpenCode lookup filters the directory before limiting recent sessions', sqliteTestOptions, async t => {
  const root = await fixture(t), file = path.join(root, 'opencode.db');
  const db = new DatabaseSync(file);
  try {
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, time_updated INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER);`);
    const insert = db.prepare('INSERT INTO session VALUES (?,?,?)');
    insert.run('wanted', 'D:\\projects\\app\\', 1);
    for (let i = 0; i < 501; i++) insert.run(`other-${i}`, 'D:\\projects\\other', i + 2);
    db.prepare('INSERT INTO message VALUES (?,?,?,?)').run('wanted-request', 'wanted', JSON.stringify({
      role: 'assistant', tokens: { input: 100, output: 300 }, time: { created: 1000, completed: 3000 }
    }), 1000);
  } finally { db.close(); }
  const result = await readTargetSession({ worktreeId: 'app', worktreePath: 'd:/projects/app', sessions: [] }, {
    roots: { opencode: [file] }, includeDefaults: false, platform: 'win32'
  });
  assert.equal(result.session.records.length, 1);
  assert.equal(result.session.records[0].rawId, 'wanted-request');
  assert.deepEqual(result.warnings, []);
});

test('channel header lookup retries an unchanged large header after its read budget was exhausted', async t => {
  const root = await fixture(t), channel = '/test';
  // Cold reads leave only 48 KiB for the next file: its 60 KiB header cannot finish this pass.
  const sizes = [16 * 1024 * 1024, 16 * 1024 * 1024, 16 * 1024 * 1024,
    16 * 1024 * 1024 - 4 * 32768 - 48 * 1024];
  for (const [i, size] of sizes.entries()) {
    const file = path.join(root, `filler-${i}.jsonl`), content = Buffer.alloc(size, 32);
    content.write(jsonl([{ type: 'session_meta', payload: { id: `filler-${i}`, cwd: channel } }]));
    content[size - 1] = 10;
    await writeFile(file, content);
    await utimes(file, 100 + i, 100 + i);
  }
  const file = path.join(root, 'large-header.jsonl'), rows = codexRows('deferred-header');
  rows[0].payload.base_instructions = 'x'.repeat(60_000);
  await writeFile(file, jsonl(rows));
  await utimes(file, 1, 1);
  const target = { worktreeId: 'app', worktreePath: channel, sessions: [] };
  const options = { roots: { codex: [root] }, includeDefaults: false, platform: 'linux', fresh: true };
  assert.equal((await readTargetSession(target, options)).session.records.length, 0);
  const retried = await readTargetSession(target, options);
  assert.equal(retried.session.records.length, 1, 'a deferred header must be retried without changing the file');
  assert.match(retried.session.records[0].id, /deferred-header/);
});

test('unavailable registered channel files retain the last statistics and recover on the next refresh', async t => {
  const root = await fixture(t), file = path.join(root, 'recover.jsonl'), emptyFile = path.join(root, 'empty.jsonl');
  await writeFile(file, jsonl(codexRows('recover')));
  await writeFile(emptyFile, jsonl([{ type: 'session_meta', payload: { id: 'empty', cwd: '/test' } }]));
  let target = { worktreeId: 'app', sessions: [
    { provider: 'codex', sessionId: 'recover', transcriptPath: file },
    { provider: 'codex', sessionId: 'empty', transcriptPath: emptyFile }
  ] };
  const register = () => ({ dispose() {} });
  const controller = createTpsController({
    storage: { get: async () => null }, panels: { handle: register, post() {} },
    commands: { register }, host: { call: async () => {} }, log() {}
  }, {
    readActive: async () => ({ target }),
    readSession: active => readTargetSession(active, { includeDefaults: false }), focusPollMs: 0
  });
  t.after(() => controller.stop());
  await controller.start();
  assert.equal(controller.state().records.length, 1);
  await rm(file);
  await controller.refresh();
  assert.equal(controller.state().records.length, 1, 'an unavailable channel is not a successfully empty channel');
  assert.ok(controller.state().warnings.length > 0);
  await writeFile(file, jsonl(codexRows('recover')));
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
    const file = path.join(root, `${sessionId}.jsonl`), rows = codexRows(sessionId);
    rows[1].timestamp = new Date(Date.parse(rows[1].timestamp) + i * 10000).toISOString();
    rows[2].timestamp = new Date(Date.parse(rows[2].timestamp) + i * 10000).toISOString();
    rows[2].payload.info.model = 'gpt-test';
    await writeFile(file, jsonl(rows));
    sessions.push({ provider: 'codex', sessionId, transcriptPath: file });
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
  const result = await readTargetSession({ worktreeId: 'app', sessions }, { includeDefaults: false, ccSwitchDb: dbPath });
  assert.deepEqual(result.session.records.map(record => record.id), ['proxy:proxy-second', 'proxy:proxy-first']);
  assert.ok(result.session.records.every(record => record.provider === 'codex' && !record.isEstimatedSpeed));
});

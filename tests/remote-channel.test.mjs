import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRemoteChannelReader, createRemoteUsageReader } from '../src/remote-channel.mjs';
import { collectRemoteChannel, collectorCommand, remoteRecord } from '../src/remote-collector.mjs';
import { createUsageIndex, localDayKey } from '../src/usage-summary.mjs';

test('one SSH stream merges project sessions and receives new records without sending another request', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tps-remote-test-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const otherProject = path.join(root, 'other-project');
  const codexHome = path.join(home, '.codex');
  const logs = path.join(codexHome, 'sessions');
  await Promise.all([mkdir(project), mkdir(otherProject), mkdir(logs, { recursive: true })]);
  t.after(() => rm(root, { recursive: true, force: true }));

  function writeSession(id, cwd, output, completed) {
    const tokens = { output_tokens: output, input_tokens: 100 };
    const rows = [
      { type: 'session_meta', payload: { id, cwd, prompt: 'PRIVATE_CHAT_CONTENT' } },
      { timestamp: '2026-01-01T00:00:00Z', type: 'event_msg', payload: { type: 'task_started', turn_id: id } },
      { timestamp: completed, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: tokens } } }
    ];
    return writeFile(path.join(logs, id + '.jsonl'), rows.map(value => JSON.stringify(value)).join('\n') + '\n');
  }
  await writeSession('remote-one', project, 200, '2026-01-01T00:00:02Z');
  await writeSession('remote-two', project, 330, '2026-01-01T00:00:03Z');
  await writeSession('other-project', otherProject, 999, '2026-01-01T00:00:04Z');

  const hermesHome = path.join(home, '.hermes'), hermesLogs = path.join(hermesHome, 'logs');
  await mkdir(hermesLogs, { recursive: true });
  await writeFile(path.join(hermesLogs, 'agent.log'),
    '2026-01-01 00:00:03,500 INFO [hermes-remote] agent.conversation_loop: API call #1: model=vendor/flash-model:free provider=example in=122 out=60 total=182 latency=2.0s\n');
  const target = { key: 'primary', executionHostId: 'runtime:primary', worktreeId: 'worktree', worktreePath: project,
    sessions: [{ provider: 'hermes', sessionId: 'hermes-remote' }] };
  let child, launches = 0, requests = 0;
  const remote = createRemoteChannelReader({
    grantedCapabilities: ['workspace:read'],
    host: { call: method => assert.fail('Unexpected host method: ' + method) }
  }, {
    resolveRuntime: async requested => {
      assert.equal(requested, target);
      return { directory: project };
    },
    launch(route, token) {
      assert.equal(route.directory, project);
      launches++;
      const command = collectorCommand(token).split('"')[1];
      child = spawn(process.execPath, ['--input-type=commonjs', '-e', command], {
        cwd: project, env: { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: home, ORCA_USER_DATA_PATH: home, CODEX_HOME: codexHome,
          HERMES_HOME: hermesHome, TZ: 'UTC' },
        stdio: ['pipe', 'pipe', 'ignore']
      });
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = (...args) => {
        requests++;
        return write(...args);
      };
      return child;
    }
  });
  try {
    remote.setTarget(target);
    const first = await remote.read(target);
    assert.deepEqual(first.warnings, []);
    assert.deepEqual(first.session.records.map(record => record.outputTokens), [60, 330, 200]);
    assert.deepEqual(first.session.records.map(record => record.tokensPerSecond), [30, 110, 100]);
    assert.equal(first.session.records[0].dataSource, 'hermes_log');
    assert.equal(first.session.records[0].model, 'vendor/flash-model:free');
    assert.equal(first.session.records[0].cacheHitRate, undefined);
    assert.doesNotMatch(JSON.stringify(first), /PRIVATE_CHAT_CONTENT|remote-one|remote-two|hermes-remote/);
    assert.deepEqual(await remote.read(target, { fresh: true }), first);
    assert.equal(launches, 1);

    const sends = requests;
    const newRows = [
      { timestamp: '2026-01-01T00:00:04Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'next' } },
      { timestamp: '2026-01-01T00:00:06Z', type: 'event_msg', payload: { type: 'token_count',
        info: { last_token_usage: { input_tokens: 100, output_tokens: 500 } } } }
    ];
    await appendFile(path.join(logs, 'remote-two.jsonl'), newRows.map(value => JSON.stringify(value)).join('\n') + '\n');
    let observed;
    for (let attempt = 0; attempt < 30; attempt++) {
      await delay(100);
      observed = await remote.read(target);
      if (observed.session?.records[0]?.outputTokens === 500) break;
    }
    assert.deepEqual(observed.session.records.map(record => record.outputTokens), [500, 60, 330, 200]);
    assert.equal(requests, sends, 'no repeat remote query');
  } finally {
    await remote.dispose();
  }
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'closing the project releases the collector');
});

test('Hermes remote model IDs can carry a namespace while filesystem paths stay private', () => {
  const record = { id: 'sample', completedAt: Date.now(), provider: 'hermes', dataSource: 'hermes_log' };
  assert.equal(remoteRecord({ ...record, model: 'vendor/model:free' }).model, 'vendor/model:free');
  assert.equal(remoteRecord({ ...record, model: '/home/demo/workspace' }).model, undefined);
  assert.equal(remoteRecord({ ...record, model: 'C:\\workspace\\model' }).model, undefined);
});

test('the collector rejects a request for a different project directory', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tps-wrong-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = path.join(root, 'separate-workspace');
  await mkdir(child);
  const result = await collectRemoteChannel({ worktreePath: child }, {
    cwd: root,
    load: () => assert.fail('The collector must not scan the wrong directory')
  });
  assert.deepEqual(result, { error: 'workspace' });
});

test('a denied workspace or unresolved SSH route never starts a process', async () => {
  const target = { key: 'remote', executionHostId: 'runtime:paired', worktreeId: 'target' };
  let lookups = 0;
  for (const grantedCapabilities of [[], ['workspace:read']]) {
    const remote = createRemoteChannelReader({ grantedCapabilities }, {
      async resolveRuntime() {
        lookups++;
        return null;
      },
      launch() { assert.fail('An unverified workspace must not start SSH'); }
    });
    remote.setTarget(target);
    const result = await remote.read(target);
    assert.equal(result.session, null);
    assert.match(result.warnings[0], grantedCapabilities.length ? /工作区同步/ : /授权/);
    await remote.dispose();
  }
  assert.equal(lookups, 1);
});

test('closing a project during route lookup prevents a late SSH startup', async () => {
  const target = { key: 'remote', executionHostId: 'runtime:paired', worktreeId: 'target' };
  let resolveRoute;
  const pending = new Promise(resolve => { resolveRoute = resolve; });
  const remote = createRemoteChannelReader({ grantedCapabilities: ['workspace:read'] }, {
    resolveRuntime: () => pending,
    launch() { assert.fail('A closed project must not start SSH'); }
  });
  remote.setTarget(target);
  const result = remote.read(target);
  await remote.dispose();
  resolveRoute({ directory: '/project' });
  assert.equal((await result).session, null);
});

test('remote usage counts the full history once per host and keeps totals when it disconnects', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'tps-remote-usage-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const codexHome = path.join(home, '.codex'), logs = path.join(codexHome, 'sessions');
  await mkdir(logs, { recursive: true });
  const sessions = 202, completed = new Date(), started = new Date(completed.getTime() - 1_000);
  const hermesHome = path.join(home, '.hermes'), hermesLogs = path.join(hermesHome, 'logs');
  await mkdir(hermesLogs, { recursive: true });
  const occurredAt = `${localDayKey(completed.getTime())} ${completed.toTimeString().slice(0, 8)},000`;
  await writeFile(path.join(hermesLogs, 'agent.log'),
    `${occurredAt} INFO [hermes-remote] agent.conversation_loop: API call #1: model=test-model provider=example in=7 out=5 total=12 latency=2.0s\n`);
  const expectedTokens = sessions * 5 + 3 + 12;
  await Promise.all(Array.from({ length: sessions }, (_, index) => {
    const sessionId = 'usage-' + index;
    const rows = [
      { type: 'session_meta', payload: { id: sessionId, cwd: home } },
      { timestamp: started, type: 'event_msg', payload: { type: 'task_started', turn_id: sessionId } },
      { timestamp: completed, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 2, output_tokens: 3 } } } }
    ];
    return writeFile(path.join(logs, sessionId + '.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  }));
  const host = { host: 'example.test', username: 'example', port: 22 };
  let online = true, launches = 0, writes = 0;
  const reader = createRemoteUsageReader({ grantedCapabilities: ['workspace:read'] }, {
    resolveHosts: async () => online ? [host, { ...host, alias: 'duplicate' }] : [],
    launch(_route, token) {
      launches++;
      const child = spawn(process.execPath, ['--input-type=commonjs', '-e', collectorCommand(token).split('"')[1]], {
        cwd: home, stdio: ['pipe', 'pipe', 'ignore'],
        env: { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: home, ORCA_USER_DATA_PATH: home, CODEX_HOME: codexHome,
          HERMES_HOME: hermesHome,
          CLAUDE_CONFIG_DIR: path.join(home, '.claude'), PI_CODING_AGENT_DIR: path.join(home, '.pi'),
          XDG_DATA_HOME: path.join(home, 'data'), OPENCODE_DB: ':memory:' }
      });
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = (...args) => { writes++; return write(...args); };
      return child;
    }
  });
  const stored = new Map(), day = localDayKey(completed.getTime());
  const local = { key: 'local-unit', stamp: 'same', bytes: 5, mtimeMs: completed.getTime(),
    read: async (rankDay, rankFrom) => ({ days: { [day]: { claude: { 'local-model': [1, 2, 1, 0, 0, 0, 0, 0] } } },
      leaderboardDays: { [rankDay]: 3 }, leaderboardFrom: rankFrom }) };
  const index = createUsageIndex({
    now: () => completed.getTime(),
    leaderboard: true, rankDays: 30,
    storage: { keys: async () => [...stored.keys()], get: async key => stored.get(key),
      set: async (key, value) => stored.set(key, value), delete: async key => stored.delete(key) },
    async discover(cutoffMs, rankDay, rankFrom) {
      const remote = await reader.discover(cutoffMs, rankDay, rankFrom);
      return { ...remote, descriptors: [{ ...local, read: () => local.read(rankDay, rankFrom) }, ...remote.descriptors] };
    }
  });
  async function refresh() {
    try { assert.deepEqual(await index.refresh(), { pending: 0 }); }
    finally { await reader.finish(); }
  }
  try {
    await refresh();
    assert.equal(index.summary().windows.today.requests, sessions + 2);
    assert.equal(index.summary().windows.today.tokens, expectedTokens);
    assert.equal(index.leaderboardUsage().tokens, expectedTokens);
    assert.equal(index.leaderboardUsage().ready, true);
    assert.equal(index.leaderboardHistory().ready, true);
    assert.equal(index.leaderboardHistory().scores[0].tokens, expectedTokens);
    assert.equal(launches, 1);
    const initialWrites = writes;
    await refresh();
    assert.equal(writes - initialWrites, 2, 'only the two descriptor pages are read again');
    online = false;
    await refresh();
    assert.equal(index.summary().windows.today.tokens, expectedTokens);
    assert.equal(index.leaderboardUsage().tokens, expectedTokens);
  } finally {
    await reader.dispose();
  }
});

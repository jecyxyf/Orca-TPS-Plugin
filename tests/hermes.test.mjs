import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readHermesSessions, hermesUsageUnits, resetHermesCaches } from '../src/hermes.mjs';
import { selectActiveConversation } from '../src/active-conversation.mjs';
import { normalizeComparePath } from '../src/data.mjs';
import { localDayKey } from '../src/usage-summary.mjs';

let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); }
catch (error) { if (error.code !== 'ERR_UNKNOWN_BUILTIN_MODULE') throw error; }

// One API-call line exactly as Hermes writes it (see hermes-agent evals/postmortem/forensics/logcalls.py).
const call = ({ session = 'local-abc', n = 1, model = 'deepseek-v4.1-flash:1017', input = 40184, output = 192,
  latency = '1.9', cached = 38272, id = 'chatcmpl-1', tail = '', at = '15:55:35,098' } = {}) =>
  `2026-11-14 ${at} INFO [${session}] agent.conversation_loop: API call #${n}: model=${model} provider=ollama-cloud `
  + `in=${input} out=${output} total=${input + output} latency=${latency}s cache=${cached}/${input} (95%) id=${id}${tail}\n`;

async function home(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-tps-hermes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'logs'), { recursive: true });
  await mkdir(path.join(root, 'work'), { recursive: true });
  const db = new DatabaseSync(path.join(root, 'state.db'));
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, source TEXT, cwd TEXT, started_at REAL, model TEXT)');
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?)').run('local-abc', 'TPS panel', 'cli', path.join(root, 'work'), 1794671633, 'deepseek-v4.1-flash:1017');
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?)').run('local-other', 'Other project', 'cli', path.join(root, 'elsewhere'), 1794671600, 'deepseek-v4.1-flash:1017');
  db.close();
  resetHermesCaches();
  return root;
}

test('Hermes panes are accepted as a channel conversation', () => {
  const worktreeId = 'repo::/Users/yuniorglez/.hermes';
  const state = {
    activeWorktreeId: worktreeId,
    activeWorkspaceKey: `worktree:${worktreeId}`,
    activeWorkspaceExecutionHostId: 'local',
    unifiedTabs: { [worktreeId]: [{ entityId: 'tab', contentType: 'terminal' }] },
    tabsByWorktree: { [worktreeId]: [{ id: 'tab', worktreeId, createdAt: 100 }] },
    terminalLayoutsByTabId: { tab: { root: { type: 'leaf', leafId: 'leaf' }, ptyIdsByLeafId: { leaf: 'pty' } } },
    sleepingAgentSessionsByPaneKey: {
      'tab:leaf': {
        paneKey: 'tab:leaf', tabId: 'tab', worktreeId, agent: 'hermes', connectionId: null,
        providerSession: { key: 'session_id', id: 'local-abc' }, capturedAt: 500, state: 'done'
      }
    }
  };
  const result = selectActiveConversation(state, { observations: new Map(), platform: 'darwin' });
  assert.deepEqual(result.target.sessions, [{ provider: 'hermes', sessionId: 'local-abc' }]);
});

test('per-call log lines become records with speed, cache hit rate and channel cwd matching', async t => {
  const root = await home(t);
  await writeFile(path.join(root, 'logs', 'agent.log'),
    call() + call({ n: 2, output: 1200, latency: '9.0', id: 'chatcmpl-2', tail: ' write=640', at: '15:56:10,500' }));
  const sessions = await readHermesSessions({ customRoots: [root], cwd: path.join(root, 'work'), comparePath: normalizeComparePath });
  assert.equal(sessions.length, 1, 'only the session whose cwd sits in the worktree is read');
  const [session] = sessions;
  assert.equal(session.id, 'hermes:local-abc');
  assert.equal(session.provider, 'hermes');
  assert.equal(session.title, 'TPS panel');
  assert.equal(session.records.length, 2);
  const [latest, first] = session.records;
  assert.equal(latest.outputTokens, 1200);
  assert.equal(latest.durationMs, 9000);
  assert.equal(latest.cacheCreationTokens, 640);
  assert.ok(Math.abs(latest.tokensPerSecond - 1200 / 9) < 0.001, 'speed is output over the call latency');
  assert.equal(latest.isEstimatedSpeed, true);
  assert.equal(latest.freshInputTokens, 40184 - 38272 - 640, 'cached prompt and cache writes are not fresh input');
  assert.ok(Math.abs(latest.cacheHitRate - 38272 / 40184) < 1e-9, 'hit rate is cache reads over the whole prompt');
  assert.equal(first.outputTokens, 192);
});

test('a poll reads only appended bytes and never counts a rotated copy twice', async t => {
  const root = await home(t);
  const log = path.join(root, 'logs', 'agent.log');
  await writeFile(log, call());
  const read = () => readHermesSessions({ customRoots: [root], sessionIds: ['local-abc'], comparePath: normalizeComparePath });
  assert.equal((await read())[0].records.length, 1);

  await appendFile(log, call({ n: 2, id: 'chatcmpl-2', at: '15:56:00,000' }));
  assert.equal((await read())[0].records.length, 2, 'the appended call is picked up');

  // Hermes rotates agent.log -> agent.log.1: the rotated copy repeats what the live file already held.
  await writeFile(path.join(root, 'logs', 'agent.log.1'), call() + call({ n: 2, id: 'chatcmpl-2', at: '15:56:00,000' }));
  await writeFile(log, call({ n: 3, id: 'chatcmpl-3', at: '15:57:00,000' }));
  const records = (await read())[0].records;
  assert.equal(records.length, 3, 'records are de-duplicated by response id across log files');
});

test('usage units report Hermes per-day counts', async t => {
  const root = await home(t);
  await writeFile(path.join(root, 'logs', 'agent.log'), call() + call({ n: 2, id: 'chatcmpl-2', at: '15:56:00,000' }));
  const units = await hermesUsageUnits(0, { customRoots: [root] });
  assert.equal(units.length, 1);
  const days = await units[0].read();
  const cell = days[localDayKey(new Date(2026, 10, 14, 15, 55).getTime())].hermes['deepseek-v4.1-flash:1017'];
  assert.equal(cell[0], 2, 'two requests that day');
  assert.equal(cell[2], 192 + 192);
});

test('nothing is read when the caller isolates its own roots', async () => {
  assert.deepEqual(await hermesUsageUnits(0, { includeDefaults: false }), []);
  assert.deepEqual(await readHermesSessions({ includeDefaults: false, sessionIds: ['local-abc'] }), []);
});

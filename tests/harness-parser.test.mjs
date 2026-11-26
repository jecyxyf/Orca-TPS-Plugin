import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { promisify } from 'node:util';
import * as zlib from 'node:zlib';
import { MANAGER_HARNESSES } from '../src/harnesses.mjs';
import { openReadonlyDatabase } from '../src/sqlite.mjs';

const run = promisify(execFile);
const line = value => JSON.stringify(value) + '\n';

test('harness database reads use the shared read-only settings', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tps-readonly-'));
  const file = path.join(directory, 'usage.sqlite');
  const writable = new DatabaseSync(file);
  writable.exec('CREATE TABLE usage (tokens INTEGER); INSERT INTO usage VALUES (100)');
  writable.close();
  const db = openReadonlyDatabase(file);
  t.after(async () => {
    db.close();
    await rm(directory, { recursive: true, force: true });
  });
  assert.equal(db.prepare('PRAGMA query_only').get().query_only, 1);
  assert.equal(db.prepare('PRAGMA trusted_schema').get().trusted_schema, 0);
  assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 100);
  assert.equal(db.prepare('SELECT tokens FROM usage').get().tokens, 100);
  assert.throws(() => db.exec('DELETE FROM usage'), /readonly/i);
});

function zstdLog(rows) {
  const contents = Buffer.from(rows.map(line).join(''));
  if (zlib.zstdCompressSync) return zlib.zstdCompressSync(contents);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0xfd2fb528);
  header[4] = 0xa0; // One segment with a 4-byte content size field.
  header.writeUInt32LE(contents.length, 5);
  header.writeUIntLE((contents.length << 3) | 1, 9, 3); // One last, raw block.
  return Buffer.concat([header, contents]);
}

test('the manager reads all 16 harnesses and keeps native request IDs on upgrade', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'tps-harness-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const now = Date.now(), iso = new Date(now - 6000).toISOString();
  const seconds = Math.floor((now - 6000) / 1000);
  const at = Date.parse(iso), project = path.join(home, 'repo');
  const files = async (name, rows) => {
    const file = path.join(home, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof rows === 'string' || Buffer.isBuffer(rows) ? rows : rows.map(line).join(''));
    return file;
  };
  const database = async (name, schema) => {
    const file = path.join(home, name);
    await mkdir(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec(schema);
    return db;
  };
  const usage = { input: 30, output: 220, cacheRead: 12, cacheWrite: 8 };
  const gemini = (id, input) => ({ id, type: 'gemini', timestamp: iso, model: 'gemini-fixture',
    tokens: { input, cached: 12, output: 200, thoughts: 20 } });
  const openClaw = id => ({
    type: 'message', id, timestamp: iso, message: { role: 'assistant', model: 'claw-fixture', usage }
  });

  await files('.claude/projects/p/claude.jsonl', [
    { type: 'assistant', uuid: 'response', timestamp: iso, cwd: project, sessionId: 'claude',
      message: { id: 'claude-msg', model: 'claude-fixture', stop_reason: 'end_turn',
        usage: { input_tokens: 30, output_tokens: 220, cache_read_input_tokens: 12, cache_creation_input_tokens: 8 } } }
  ]);
  await files('.codex/sessions/rollout.jsonl', [
    { type: 'session_meta', payload: { id: 'codex', cwd: project } },
    { type: 'event_msg', timestamp: iso, payload: { type: 'token_count',
      info: { total_token_usage: { input_tokens: 42, cached_input_tokens: 12, output_tokens: 220 } } } }
  ]);
  await files('pi-shared/p/pi.jsonl', [
    { type: 'session', id: 'pi', cwd: project },
    { type: 'message', id: 'pi-msg', timestamp: iso, message: { role: 'assistant', model: 'pi-fixture', usage } }
  ]);
  await files('pi-shared/p/omp.jsonl', [
    { type: 'title', title: 'fixture' },
    { type: 'session', id: 'omp', cwd: project },
    { type: 'model_usage', id: 'omp-msg', timestamp: '2024-01-01T00:00:00Z', model: 'ignore-old', usage },
    { type: 'model_usage', id: 'omp-msg', timestamp: iso, model: 'omp-fixture', usage, duration: 4000 }
  ]);
  await files('pi-shared/p/omp/child.jsonl', [
    { type: 'title', title: 'subagent' },
    { type: 'session', id: 'omp-child', cwd: project },
    { type: 'message', id: 'child-msg', timestamp: iso, message: { role: 'assistant', model: 'omp-fixture', usage } }
  ]);
  await files('.hermes/logs/agent.log',
    `${iso.slice(0, 23).replace('T', ' ').replace('.', ',')} INFO [hermes] agent.conversation_loop: API call #1: model=hermes-fixture provider=example in=30 out=220 total=250 latency=3.3s id=hermes-msg\n`);
  await files('.gemini/tmp/p/chats/session-old.json', JSON.stringify({ sessionId: 'gemini-old', messages: [gemini('old', 42)] }));
  const live = await files('.gemini/tmp/p/chats/session-live.jsonl', [
    { sessionId: 'gemini-live' }, gemini('remove', 900), { $rewindTo: 'remove' },
    { $set: { messages: [gemini('replace', 71)] } }, gemini('replace', 42)
  ]);
  const partial = line(gemini('partial', 42));
  await appendFile(live, partial.slice(0, -4));
  await files('.grok/sessions/p/grok/summary.json', JSON.stringify({ info: { cwd: project } }));
  const grok = prompt => ({ method: '_x.ai/session/update', timestamp: seconds, params: { update: {
    sessionUpdate: 'turn_completed', prompt_id: prompt,
    usage: { modelUsage: { 'grok-fixture': { inputTokens: 42, cachedReadTokens: 12, outputTokens: 220, apiDurationMs: 4000 } } }
  } } });
  const grokHead = line(grok('grok-msg')) + line({ content: '中文' });
  await files('.grok/sessions/p/grok/updates.jsonl', grokHead + line(grok()));
  await files('.kimi-code/sessions/p/kimi/agents/main/wire.jsonl', [
    { type: 'context.append_loop_event', time: at - 5000, event: { type: 'step.begin', uuid: 'step', turnId: '1', step: 1 } },
    { type: 'llm.request', time: at - 4000, kind: 'loop', turnStep: '1.1', model: 'kimi-fixture' },
    { type: 'agent.message.appended', time: at, message: { message: { role: 'assistant' }, meta: {
      messageId: 'kimi-msg', model: { provider: 'example', model: 'agent-loop' },
      usage: { inputOther: 30, output: 220, inputCacheRead: 12, inputCacheCreation: 8 }
    } } },
    { type: 'context.append_loop_event', time: at, event: { type: 'step.end', uuid: 'step', messageId: 'kimi-msg',
      llmFirstTokenLatencyMs: 200, llmStreamDurationMs: 2800 } }
  ]);
  await files('.openclaw/agents/main/sessions/claw.jsonl', [
    { type: 'session', id: 'claw', cwd: project }, openClaw('claw-msg')
  ]);
  await files('.gemini/antigravity-cli/brain/1ab2468a-0000-4000-8000-00000000abcd/.system_generated/logs/transcript.jsonl', [
    { step_index: 7, type: 'PLANNER_RESPONSE', source: 'MODEL', created_at: iso, input_tokens: 30, output_tokens: 220 }
  ]);
  await files('.copilot/session-state/copilot/workspace.yaml', `cwd: ${JSON.stringify(project)}\n`);
  await files('.copilot/session-state/copilot/events.jsonl', [
    { type: 'session.usage_checkpoint', id: 'summary', timestamp: iso, data: { usage: { inputTokens: 9000 } } },
    { type: 'session.usage_record', timestamp: iso, data: { usage: { model: 'copilot-fixture', inputTokens: 2000,
      duration: 3200, timeToFirstTokenMs: 200, accounting: { sequence: 5 },
      copilotUsage: { tokenDetails: [{ tokenType: 'input', tokenCount: 30 }, { tokenType: 'output', tokenCount: 220 },
        { tokenType: 'cache_read', tokenCount: 12 }, { tokenType: 'cache_write', tokenCount: 8 }] } } } }
  ]);
  const buddyUsage = { model: 'custom-local:buddy-fixture',
    rawUsage: { prompt_tokens: 50, completion_tokens: 220, prompt_tokens_details: { cached_tokens: 12 }, prompt_cache_write_tokens: 8 } };
  await files('.workbuddy/projects/p/buddy.jsonl', [
    { type: 'message', role: 'user', id: 'ignore', cwd: project, timestamp: at, sessionId: 'buddy', providerData: buddyUsage },
    { type: 'function_call', id: 'main', timestamp: at, sessionId: 'buddy', providerData: buddyUsage }
  ]);
  await files('.workbuddy/projects/p/buddy/subagents/agent-child.jsonl', [
    { type: 'message', role: 'assistant', id: 'child', timestamp: at, sessionId: 'different',
      providerData: { model: 'buddy-fixture', usage: { inputTokens: 42, outputTokens: 220, inputTokensDetails: [{ cached_tokens: 12 }] } } }
  ]);
  const dshHeader = id => ({ type: 'session', version: 4, id, cwd: project });
  const dshStep = (id, step) => [
    { type: 'step/start', time: at - 3200, data: { turn: 1, step } },
    { type: 'assistant/message', time: at, data: { turn: 1, step,
      message: { id, source: { model: 'global:deepseek-fixture' } },
      usage: { inputTokens: 30, outputTokens: 220, cacheReadTokens: 12, cacheWriteTokens: 8 },
      stream: [{ time0: at - 3000 }]
    } }
  ];
  await files('.dsh/sessions/p/plain/session.v4.jsonl', [dshHeader('dsh-plain'), ...dshStep('dsh-plain', 1)]);
  const firstFrame = zstdLog([dshHeader('dsh-zstd'), ...dshStep('dsh-zstd', 1)]);
  const nextFrame = zstdLog(dshStep('dsh-append', 2));
  const compressed = await files('.dsh/sessions/p/zstd/session.v4.jsonl.zstd', Buffer.concat([firstFrame, nextFrame.subarray(0, -2)]));

  const clawDb = await database('.openclaw/agents/main/agent/openclaw-agent.sqlite',
    'CREATE TABLE transcript_events (session_id TEXT, created_at INT, event_json TEXT, event_zstd BLOB, event_utf8_bytes INT)');
  if (zlib.zstdCompressSync) {
    const text = JSON.stringify(openClaw('claw-sqlite'));
    clawDb.prepare('INSERT INTO transcript_events VALUES (?, ?, NULL, ?, ?)').run('claw-db', at,
      zlib.zstdCompressSync(Buffer.from(text)), Buffer.byteLength(text));
  } else {
    clawDb.prepare('INSERT INTO transcript_events VALUES (?, ?, ?, NULL, NULL)').run('claw-db', at, JSON.stringify(openClaw('claw-sqlite')));
  }
  clawDb.close();
  const code = await database('opencode.db', `
    CREATE TABLE session (id TEXT PRIMARY KEY, time_updated INT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INT, data TEXT)`);
  code.prepare('INSERT INTO session VALUES (?, ?)').run('opencode', at);
  code.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('code-msg', 'opencode', at,
    JSON.stringify({ role: 'assistant', modelID: 'code-fixture', time: { created: at - 2000, completed: at },
      tokens: { input: 30, output: 220, cache: { read: 12, write: 8 } } }));
  code.close();
  const minimax = await database('.minimax/v2/sqlite/runtime-state.sqlite',
    `CREATE TABLE local_runtime_token_usage (id INT, session_id TEXT, model TEXT, ts INT, input_tokens INT,
      output_tokens INT, reasoning_tokens INT, cache_read_tokens INT, cache_write_tokens INT, turn_id TEXT);
    CREATE TABLE local_runtime_sessions (session_id TEXT, workspace_dir TEXT);
    CREATE TABLE local_runtime_message_rows (session_id TEXT, turn_id TEXT, role TEXT, created_at_ms INT, data_json TEXT)`);
  minimax.prepare("INSERT INTO local_runtime_token_usage VALUES (1, ?, ?, ?, 30, 200, 20, 12, 8, 'turn')").run('mcode', 'provider/mcode-fixture', at);
  minimax.prepare('INSERT INTO local_runtime_sessions VALUES (?, ?)').run('mcode', project);
  minimax.prepare("INSERT INTO local_runtime_message_rows VALUES ('mcode', 'turn', 'assistant', ?, ?)").run(at + 500,
    JSON.stringify({ usage: { input_tokens: 30, output_tokens: 200, request_duration_ms: 3200, decode_duration_ms: 3000 } }));
  minimax.close();
  const desktopData = { win32: 'desktop-roaming', darwin: 'Library/Application Support' }[process.platform] ?? '.config';
  const desktopLogs = path.join(desktopData, 'Claude', 'local-agent-mode-sessions', 'org', 'account');
  const ledgerApp = process.platform === 'win32'
    ? 'Packages/Anthropic.Claude_fixture/LocalCache/Roaming/Claude-3p' : path.join(desktopData, 'Claude-3p');
  function desktopAudit(sessionId, id, input, output) {
    return [
      { type: 'user', uuid: `${id}-prompt`, cwd: project, session_id: sessionId, timestamp: new Date(at - 3200).toISOString() },
      { type: 'assistant', uuid: `${id}-response`, parentUuid: `${id}-prompt`, session_id: sessionId, timestamp: iso,
        message: { id, model: 'claude-sonnet-fixture', stop_reason: 'end_turn',
          usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 12, cache_creation_input_tokens: 8 } } }
    ];
  }
  const audit = await files(path.join(desktopLogs, 'local_cowork', 'audit.jsonl'), desktopAudit('cowork', 'first-desktop', 30, 220));
  const lateAudit = path.join(home, desktopLogs, 'local_late', 'audit.jsonl');
  const desktopLedger = (sessionId, inputTokens, outputTokens, surface = 'cowork') => ({
    ts: at + 1000, sessionId, surface, isError: false,
    models: { 'us.anthropic.claude-sonnet-fixture-v1:0': { inputTokens, outputTokens, cacheReadTokens: '12', cacheWriteTokens: 8 } }
  });
  await files(path.join(ledgerApp, 'local-agent-mode-sessions', 'usage-ledger', 'usage.ndjson'), [
    desktopLedger('different-id', 30, 220), desktopLedger('late', 31, 221), desktopLedger('code', 300, 500, 'code')
  ]);

  const script = `
    import { appendFile, mkdir, unlink, writeFile } from 'node:fs/promises';
    import path from 'node:path';
    import { DatabaseSync } from 'node:sqlite';
    import { openTokensManagerDb } from './src/database.mjs';
    import { scanTokens } from './src/token_manager.mjs';
    const home = process.env.TEST_HARNESS_HOME, now = Number(process.env.TEST_HARNESS_NOW);
    const root = path.join(home, 'manager');
    let db = openTokensManagerDb(root, { timeZone: 'UTC' });
    db.commitSource('cc-switch', db.setting('generation'), [
      { id: 'gemini_session:gemini-old:old', provider: 'gemini', model: 'gemini-fixture', completedAt: now - 6000,
        freshInputTokens: 30, outputTokens: 220, cacheReadTokens: 12 },
      { id: 'mcode:mcode:1', provider: 'mcode', model: 'mcode-fixture', completedAt: now - 6000,
        freshInputTokens: 30, outputTokens: 220, cacheReadTokens: 12, cacheCreationTokens: 8 },
      { id: process.env.TEST_HARNESS_GROK_OLD_ID, provider: 'grokbuild', model: 'grok-fixture',
        completedAt: now - 6000, freshInputTokens: 30, outputTokens: 220, cacheReadTokens: 12 },
      { id: 'copilot:copilot:seq5', provider: 'copilot', model: 'copilot-fixture',
        completedAt: now - 6000, freshInputTokens: 30, outputTokens: 220 },
      { id: 'workbuddy:buddy:main', provider: 'workbuddy', model: 'buddy-fixture',
        completedAt: now - 6000, freshInputTokens: 30, outputTokens: 220 },
      { id: 'dsh:dsh-zstd', provider: 'dsh', model: 'deepseek-fixture',
        completedAt: now - 6000, freshInputTokens: 30, outputTokens: 220 }
    ], now);
    db.finishScan(now);
    db.close();
    db = openTokensManagerDb(root, { timeZone: 'UTC' });
    const scan = async () => {
      await scanTokens(root, db, { at: now });
      return db.details();
    };
    const first = await scan();
    const repeat = await scan();
    await appendFile(process.env.TEST_HARNESS_GEMINI, process.env.TEST_HARNESS_LINE_TAIL);
    await appendFile(process.env.TEST_HARNESS_DSH, Buffer.from(process.env.TEST_HARNESS_DSH_TAIL, 'base64'));
    const appended = await scan();
    db.close();
    db = openTokensManagerDb(root, { timeZone: 'UTC' });
    const proxy = new DatabaseSync(process.env.CC_SWITCH_DB_PATH);
    proxy.exec('CREATE TABLE proxy_request_logs (request_id TEXT, app_type TEXT, created_at INT, status_code INT, ' +
      'data_source TEXT, input_tokens INT, output_tokens INT, model TEXT)');
    proxy.prepare("INSERT INTO proxy_request_logs VALUES ('proxy-only', 'claude-desktop', ?, 200, 'proxy', 100, 200, 'proxy')").run(Math.floor(now / 1000));
    proxy.close();
    const lateAudit = process.env.TEST_HARNESS_DESKTOP_LATE;
    await mkdir(path.dirname(lateAudit), { recursive: true });
    await writeFile(lateAudit, process.env.TEST_HARNESS_DESKTOP_CONTENT);
    const matched = await scan();
    await unlink(process.env.TEST_HARNESS_DESKTOP_AUDIT);
    await unlink(lateAudit);
    const afterRotation = await scan();
    console.log(JSON.stringify({ first, repeat, appended, matched, afterRotation }));
    db.close();
  `;
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], {
    timeout: 25_000,
    env: { ...process.env,
      HOME: home, USERPROFILE: home, ORCA_USER_DATA_PATH: home, LOCALAPPDATA: home,
      APPDATA: path.join(home, 'desktop-roaming'), XDG_CONFIG_HOME: path.join(home, '.config'),
      HERMES_HOME: path.join(home, '.hermes'), CODEX_HOME: path.join(home, '.codex'),
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'), OPENCODE_DB: path.join(home, 'opencode.db'),
      GEMINI_CLI_HOME: home, GROK_HOME: path.join(home, '.grok'), KIMI_CODE_HOME: path.join(home, '.kimi-code'),
      MINIMAX_DATA_DIR: path.join(home, '.minimax'), OPENCLAW_STATE_DIR: path.join(home, '.openclaw'),
      COPILOT_HOME: path.join(home, '.copilot'), WORKBUDDY_CONFIG_DIR: path.join(home, '.workbuddy'), DSH_HOME: path.join(home, '.dsh'),
      CC_SWITCH_DB_PATH: path.join(home, 'missing-cc-switch.db'),
      PI_CODING_AGENT_DIR: path.join(home, '.pi', 'agent'), PI_CODING_AGENT_SESSION_DIR: path.join(home, 'pi-shared'),
      TZ: 'UTC', TEST_HARNESS_HOME: home, TEST_HARNESS_NOW: String(now),
      TEST_HARNESS_GEMINI: live, TEST_HARNESS_LINE_TAIL: partial.slice(-4),
      TEST_HARNESS_DSH: compressed, TEST_HARNESS_DSH_TAIL: nextFrame.subarray(-2).toString('base64'),
      TEST_HARNESS_GROK_OLD_ID: `grok_session:grok:off${Buffer.byteLength(grokHead)}:grok-fixture`,
      TEST_HARNESS_DESKTOP_AUDIT: audit, TEST_HARNESS_DESKTOP_LATE: lateAudit,
      TEST_HARNESS_DESKTOP_CONTENT: desktopAudit('late', 'second-desktop', 31, 221).map(line).join('')
    }
  });
  const { first, repeat, appended, matched, afterRotation } = JSON.parse(stdout);
  assert.deepEqual([...new Set(first.map(row => row.provider))].sort(), [...MANAGER_HARNESSES].sort());
  assert.equal(MANAGER_HARNESSES.length, 16);
  assert.equal(first.length, 23);
  assert.deepEqual(repeat, first);
  assert.equal(appended.length, first.length + 2);
  assert.equal(appended.filter(row => row.id === 'gemini_session:gemini-live:partial').length, 1);
  const desktop = rows => rows.filter(row => row.provider === 'claude-desktop');
  assert.equal(desktop(first).length, 2);
  assert.equal(desktop(first).find(row => row.sessionId === 'cowork').durationMs, 3200);
  assert.equal(desktop(matched).length, 2);
  assert.equal(desktop(matched).find(row => row.sessionId === 'late').cwd, project);
  assert.deepEqual(afterRotation, matched);
  assert.equal(first.find(row => row.provider === 'kimi').model, 'kimi-fixture');
  assert.equal(first.find(row => row.provider === 'kimi').firstTokenMs, 200);
  assert.equal(first.find(row => row.provider === 'grokbuild').cwd, project);
  assert.equal(first.filter(row => row.provider === 'grokbuild').length, 2);
  const deepSeek = first.filter(row => row.provider === 'dsh');
  assert.equal(deepSeek.length, 2);
  assert.ok(deepSeek.every(row => row.freshInputTokens === 30 && row.firstTokenMs === 200 && row.cwd === project));
  assert.equal(appended.filter(row => row.id === 'dsh:dsh-append').length, 1);
  assert.equal(first.find(row => row.provider === 'copilot').cwd, project);
  assert.equal(first.find(row => row.provider === 'copilot').freshInputTokens, 30);
  assert.equal(first.find(row => row.id === 'workbuddy:buddy:child').cwd, project);
  assert.deepEqual(first.filter(row => row.provider === 'gemini').map(row => row.freshInputTokens), [30, 30]);
  assert.equal(first.filter(row => row.provider === 'omp' && row.sessionId === 'omp-child').length, 1);
  assert.equal(first.find(row => row.provider === 'omp').cwd, project);
  const claude = first.find(row => row.provider === 'claude');
  assert.equal(claude.sessionId, 'claude');
  assert.equal(claude.cwd, project);
  const codex = first.find(row => row.provider === 'codex');
  assert.equal(codex.sessionId, 'codex');
  assert.equal(codex.cwd, project);
  const pi = first.find(row => row.provider === 'pi');
  assert.equal(pi.sessionId, 'pi');
  assert.equal(pi.cwd, project);
  const openclaw = first.find(row => row.provider === 'openclaw' && row.sessionId === 'claw');
  assert.equal(openclaw.cwd, project);
  const mcode = first.find(row => row.provider === 'mcode');
  assert.equal(mcode.outputTokens, 220);
  assert.equal(mcode.model, 'mcode-fixture');
  assert.equal(mcode.cwd, project);
  assert.equal(mcode.firstTokenMs, 200);
});

test('createJsonlCursor extracts sessionId and cwd across fed chunks and scanTokens indexes Claude and Pi for channel lookup', async t => {
  const { createJsonlCursor, normalizeComparePath } = await import('../src/harness_parser.mjs');
  const cursor = createJsonlCursor('', 'claude', '', { limit: Infinity });
  assert.equal(cursor.sessionId, null);
  assert.equal(cursor.cwd, null);
  const preambles = Array.from({ length: 35 }, (_, i) => line({ type: 'mode', index: i, sessionId: 'claude-split' })).join('');
  cursor.feed(preambles);
  assert.equal(cursor.sessionId, 'claude-split');
  assert.equal(cursor.cwd, null);
  cursor.feed(line({
    type: 'assistant', uuid: 'r1', cwd: '/proj/split', sessionId: 'claude-split',
    timestamp: new Date(Date.now() - 1000).toISOString(),
    message: { id: 'm1', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 20 } }
  }));
  assert.equal(cursor.sessionId, 'claude-split');
  assert.equal(cursor.cwd, '/proj/split');
  assert.equal(cursor.finish().length, 1);

  // A Codex session_meta row can arrive in a batch after the parser was built (empty first read, or a
  // chunk boundary before the header). Record IDs must still carry the real id, not the placeholder.
  const codexUsage = line({ type: 'event_msg', timestamp: new Date(Date.now() - 1000).toISOString(),
    payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 42, cached_input_tokens: 12, output_tokens: 220 } } } });
  const codexMeta = line({ type: 'session_meta', payload: { id: 'codex-late', cwd: '/proj/codex' } });
  for (const chunks of [[codexMeta, codexUsage], [codexUsage, codexMeta]]) {
    const codexCursor = createJsonlCursor('', 'codex', '', { limit: Infinity });
    for (const chunk of chunks) codexCursor.feed(chunk);
    const [record] = codexCursor.finish();
    assert.equal(codexCursor.sessionId, 'codex-late');
    assert.equal(codexCursor.cwd, '/proj/codex');
    assert.equal(record.id, 'codex_session:codex-late:1');
    assert.equal(codexCursor.finish()[0].id, record.id, 'repeated finish keeps the id stable');
  }
  const placeholder = createJsonlCursor('', 'codex', '', { limit: Infinity });
  placeholder.feed(codexUsage);
  assert.equal(placeholder.finish()[0].id, 'codex_session:session:1', 'a missing session_meta keeps the placeholder');

  const home = await mkdtemp(path.join(tmpdir(), 'tps-claude-channel-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const now = Date.now();
  const project = path.join(home, 'repo');
  const claudeDir = path.join(home, '.claude', 'projects', 'p');
  const piDir = path.join(home, '.pi', 'agent', 'sessions', 'p');
  await mkdir(path.join(claudeDir, 'claude-live', 'subagents'), { recursive: true });
  await mkdir(piDir, { recursive: true });

  const claudeRows = [
    ...Array.from({ length: 35 }, (_, i) => ({ type: 'mode', index: i, sessionId: 'claude-live' })),
    { type: 'user', uuid: 'u1', cwd: project, sessionId: 'claude-live', timestamp: new Date(now - 5000).toISOString() },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: new Date(now - 2000).toISOString(),
      message: { id: 'claude-main-1', model: 'claude-opus-5-5', stop_reason: 'end_turn',
        usage: { input_tokens: 40, output_tokens: 240, cache_read_input_tokens: 100 } } }
  ];
  await writeFile(path.join(claudeDir, 'claude-live.jsonl'), claudeRows.map(line).join(''));
  await writeFile(path.join(claudeDir, 'claude-live', 'subagents', 'agent-sub.jsonl'), [
    { type: 'assistant', uuid: 's1', isSidechain: true, timestamp: new Date(now - 1500).toISOString(),
      message: { id: 'claude-sub-1', model: 'claude-haiku-5-5', stop_reason: 'end_turn',
        usage: { input_tokens: 20, output_tokens: 120 } } }
  ].map(line).join(''));
  await writeFile(path.join(piDir, 'pi-live.jsonl'), [
    { type: 'session', id: 'pi-live', cwd: project },
    { type: 'message', id: 'pi-msg-1', timestamp: new Date(now - 1000).toISOString(),
      message: { role: 'assistant', model: 'pi-fixture', usage: { input: 30, output: 180, cacheRead: 10, cacheWrite: 0 } } }
  ].map(line).join(''));

  const childScript = `
    import path from 'node:path';
    import { openTokensManagerDb } from './src/database.mjs';
    import { normalizeComparePath } from './src/harness_parser.mjs';
    import { readManagerChannel, scanTokens } from './src/token_manager.mjs';
    const home = process.env.TEST_CHANNEL_HOME, now = Number(process.env.TEST_CHANNEL_NOW);
    const project = process.env.TEST_CHANNEL_PROJECT;
    const db = openTokensManagerDb(path.join(home, 'manager'), { timeZone: 'UTC' });
    const codexSeed = Array.from({ length: 100 }, (_, index) => ({
      id: 'codex-seed-' + index, provider: 'codex', sessionId: 'codex-old', cwd: project,
      model: 'gpt-6', completedAt: now - 60_000 - index * 1000,
      freshInputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0
    }));
    db.commitSource('codex-seed', 'seed-1', codexSeed, now);
    await scanTokens(path.join(home, 'manager'), db, { at: now });
    const indexed = db.channelDetails(normalizeComparePath(project), [
      { provider: 'claude', sessionId: 'claude-live' },
      { provider: 'pi', sessionId: 'pi-live' }
    ]);
    const channel = await readManagerChannel(db, {
      worktreePath: project, title: 'repo',
      sessions: [{ provider: 'claude', sessionId: 'claude-live' }, { provider: 'pi', sessionId: 'pi-live' }]
    });
    console.log(JSON.stringify({ indexed, channel: channel.session.records }));
    db.close();
  `;
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', childScript], {
    timeout: 25_000,
    env: { ...process.env,
      HOME: home, USERPROFILE: home, ORCA_USER_DATA_PATH: home, LOCALAPPDATA: home,
      APPDATA: path.join(home, 'roaming'), XDG_CONFIG_HOME: path.join(home, '.config'),
      HERMES_HOME: path.join(home, '.hermes'), CODEX_HOME: path.join(home, '.codex'),
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'), OPENCODE_DB: path.join(home, 'opencode.db'),
      GEMINI_CLI_HOME: home, GROK_HOME: path.join(home, '.grok'), KIMI_CODE_HOME: path.join(home, '.kimi-code'),
      MINIMAX_DATA_DIR: path.join(home, '.minimax'), OPENCLAW_STATE_DIR: path.join(home, '.openclaw'),
      COPILOT_HOME: path.join(home, '.copilot'), WORKBUDDY_CONFIG_DIR: path.join(home, '.workbuddy'), DSH_HOME: path.join(home, '.dsh'),
      CC_SWITCH_DB_PATH: path.join(home, 'missing-cc-switch.db'),
      PI_CODING_AGENT_DIR: path.join(home, '.pi', 'agent'), PI_CODING_AGENT_SESSION_DIR: path.join(home, 'missing-pi-shared'),
      TEST_CHANNEL_HOME: home, TEST_CHANNEL_NOW: String(now), TEST_CHANNEL_PROJECT: project
    }
  });
  const { indexed, channel } = JSON.parse(stdout);
  assert.equal(indexed.length, 100);
  const topThree = indexed.slice(0, 3);
  assert.deepEqual(topThree.map(row => row.provider), ['pi', 'claude', 'claude']);
  assert.ok(topThree.every(row => normalizeComparePath(row.cwd) === normalizeComparePath(project)));
  assert.equal(topThree[0].sessionId, 'pi-live');
  assert.equal(topThree[1].sessionId, 'claude-live');
  assert.equal(topThree[1].isSubagent, true);
  assert.equal(topThree[2].sessionId, 'claude-live');
  assert.deepEqual(channel.slice(0, 3).map(row => row.provider), ['pi', 'claude', 'claude']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CC_SWITCH_APPS, combineCcSwitchUsage, openCcSwitchUsage } from '../src/cc-switch-usage.mjs';
import { ccSwitchUsagePaths } from '../src/data-paths.mjs';
import { openLocalUsageDb } from '../src/local-usage-db.mjs';
import { createRecordUsageIndex } from '../src/record-usage-index.mjs';

const harnesses = [
  ['agy', 'antigravity', 'agy_session'],
  ['claude', 'claude', 'session_log'],
  ['codex', 'codex', 'codex_session'],
  ['dsh', 'dsh', 'dsh_session'],
  ['gemini', 'gemini', 'gemini_session'],
  ['grokbuild', 'grokbuild', 'grok_session'],
  ['kimi', 'kimi', 'kimi_session'],
  ['mcode', 'mcode', 'mcode_session'],
  ['omp', 'omp', 'omp_session'],
  ['opencode', 'opencode', 'opencode_session'],
  ['pi', 'pi', 'pi_session']
];

test('CC Switch Personal Stats returns all 11 harnesses and merges Antigravity aliases', async t => {
  const paths = ccSwitchUsagePaths();
  try { await access(paths.binary ?? paths.archive); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return t.skip('CC Switch helper is not built for this platform');
  }

  const temporary = await realpath(tmpdir());
  const root = await mkdtemp(path.join(temporary, 'tps-cc-switch-harnesses-'));
  const inputHome = path.join(root, 'input');
  const previousHome = process.env.CC_SWITCH_TEST_HOME;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.CC_SWITCH_TEST_HOME;
    else process.env.CC_SWITCH_TEST_HOME = previousHome;
    const resolved = await realpath(root);
    assert.equal(path.dirname(resolved), temporary);
    assert.ok(path.basename(resolved).startsWith('tps-cc-switch-harnesses-'));
    await rm(resolved, { force: true, recursive: true });
  });
  await mkdir(inputHome);
  process.env.CC_SWITCH_TEST_HOME = inputHome;

  const at = new Date().setHours(12, 0, 0, 0);
  const completedAt = at - 60_000;
  const seedHome = path.join(root, 'seed');
  const seed = await openCcSwitchUsage({ ...paths, sourceDb: path.join(root, 'unused.db'), stateHome: seedHome });
  assert.equal((await seed.refresh(at)).windows.today.requests, 0);
  const { name } = JSON.parse(await readFile(path.join(seedHome, 'active.json'), 'utf8'));
  const sourceDb = path.join(seedHome, name, '.cc-switch', 'cc-switch.db');
  const db = new DatabaseSync(sourceDb);
  const expected = new Map();
  try {
    const insert = db.prepare(`INSERT INTO proxy_request_logs (
      request_id, provider_id, app_type, model, request_model, input_tokens, output_tokens,
      cache_read_tokens, cache_creation_tokens, latency_ms, status_code, created_at, data_source, input_token_semantics
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 10, 200, ?, ?, 2)`);
    for (const [index, [app, provider, source]] of harnesses.entries()) {
      const counters = { freshInput: 80 + index, output: 1 + index, cacheRead: 2 * index, cacheWrite: index };
      const values = Object.values(counters);
      const model = `fixture-${provider}`;
      insert.run(`request-${app}`, 'fixture', app, model, model, ...values, completedAt / 1000, source);
      expected.set(provider, { ...counters, requests: 1, tokens: values.reduce((sum, value) => sum + value, 0) });
    }
    insert.run('request-claude-desktop', 'fixture', 'claude-desktop', 'fixture-claude', 'fixture-claude',
      7, 3, 2, 1, completedAt / 1000, 'proxy');
    const claude = expected.get('claude');
    expected.set('claude', { requests: 2, freshInput: claude.freshInput + 7, output: claude.output + 3,
      cacheRead: claude.cacheRead + 2, cacheWrite: claude.cacheWrite + 1, tokens: claude.tokens + 13 });
  } finally { db.close(); }

  const reader = await openCcSwitchUsage({ ...paths, sourceDb, stateHome: path.join(root, 'stats') });
  const official = await reader.refresh(at);
  const { windows, daily, hourly } = official;
  assert.deepEqual(new Map(windows.today.rows.map(({ provider, model, ...counts }) => [provider, counts])), expected);
  const expectedTokens = [...expected.values()].reduce((sum, row) => sum + row.tokens, 0);
  assert.deepEqual([windows.today.requests, windows.today.tokens], [12, expectedTokens]);
  assert.deepEqual([hourly.windows.today.requests, hourly.windows.today.tokens], [12, expectedTokens]);
  assert.deepEqual(daily.map(({ requests, tokens }) => [requests, tokens]), [[12, expectedTokens]]);

  const local = openLocalUsageDb(':memory:');
  const localDevice = '7947c5c1-36a1-45fa-a8ad-91705080fb7f';
  const sshDevice = '9147c5c1-36a1-45fa-a8ad-91705080fb7f';
  const usageRecord = provider => ({ id: `sample-${provider}`, model: 'fixture-antigravity', provider, completedAt, freshInputTokens: 3 });
  try {
    local.appendRecords({ deviceGuid: localDevice, records: CC_SWITCH_APPS.map(usageRecord), now: at });
    local.appendRecords({ deviceGuid: sshDevice, records: [usageRecord('agy'), usageRecord('antigravity')], now: at });
    const index = createRecordUsageIndex({ db: local, deviceGuid: localDevice, now: () => at, discover: async () => [] });
    await index.ready();
    const supplemental = index.supplementalSummary(at, CC_SWITCH_APPS);
    const combined = combineCcSwitchUsage(official, supplemental, index.summary());
    const result = combined.windows.today;
    assert.deepEqual([result.requests, result.tokens, result.rows.length], [14, expectedTokens + 6, 11]);
    assert.equal(result.rows.find(row => row.provider === 'antigravity').tokens, expected.get('antigravity').tokens + 6);
  } finally { local.close(); }
});

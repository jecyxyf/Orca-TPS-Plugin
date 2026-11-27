import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  antigravityModelId,
  antigravityNativeTimings,
  antigravitySessionIdFromPath,
  antigravityStepStart,
  parseJsonl
} from '../src/harness_parser.mjs';
import { discoverUsageUnits } from '../src/harness_parser.mjs';
import { normalizeComparePath } from '../src/harnesses.mjs';

// The manager stores these records and serves each channel by folder or session.
async function antigravityRecords(brain) {
  const units = await discoverUsageUnits(0, { roots: { antigravity: [brain] }, includeDefaults: false, includeRecords: true,
    providers: ['antigravity'] });
  return { units, records: (await Promise.all(units.map(unit => unit.read()))).flatMap(result => result.records) };
}

let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); }
catch (error) { if (error.code !== 'ERR_UNKNOWN_BUILTIN_MODULE') throw error; }
const sqliteTestOptions = { skip: typeof DatabaseSync === 'function' ? false : 'requires node:sqlite' };

const jsonl = values => values.map(value => JSON.stringify(value)).join('\n') + '\n';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-tps-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('orca-tps-test-'));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

// Minimal protobuf encoder for building Antigravity-shaped fixtures.
const varint = value => {
  const bytes = [];
  let rest = value;
  while (rest >= 128) { bytes.push((rest % 128) | 128); rest = Math.floor(rest / 128); }
  bytes.push(rest);
  return Buffer.from(bytes);
};
const varintField = (number, value) => Buffer.concat([varint(number * 8), varint(value)]);
const bytesField = (number, bytes) => Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
const stringField = (number, text) => bytesField(number, Buffer.from(text, 'utf8'));
// proto3 omits zero-valued fields, so sub-second durations carry only nanos.
const durationBytes = ms => Buffer.concat([
  ...(Math.floor(ms / 1000) > 0 ? [varintField(1, Math.floor(ms / 1000))] : []),
  ...((ms % 1000) > 0 ? [varintField(2, (ms % 1000) * 1_000_000)] : [])
]);
const stepMetadata = ({ createdSec, createdNanos, generation }) => Buffer.concat([
  bytesField(1, Buffer.concat([varintField(1, createdSec), varintField(2, createdNanos)])),
  bytesField(20, varintField(3, generation))
]);
const generationData = ({ display, base, firstTokenMs, streamMs }) => bytesField(1, Buffer.concat([
  ...(display === undefined ? [] : [stringField(21, display)]),
  ...(base === undefined ? [] : [stringField(19, base)]),
  bytesField(11, durationBytes(firstTokenMs)),
  bytesField(12, durationBytes(streamMs))
]));

const CREATED_SEC = 1792726368, CREATED_NANOS = 201_841_400; // 03:32:48.2018 UTC
const CREATED_MS = CREATED_SEC * 1000 + 201;

test('Antigravity conversation id comes only from the transcript directory layout', () => {
  assert.equal(
    antigravitySessionIdFromPath('C:\\Users\\x\\.gemini\\antigravity-cli\\brain\\abc-123\\.system_generated\\logs\\transcript.jsonl'),
    'abc-123'
  );
  assert.equal(antigravitySessionIdFromPath('/home/x/brain/abc/.system_generated/logs/transcript_full.jsonl'), null);
  assert.equal(antigravitySessionIdFromPath('/home/x/brain/abc/logs/transcript.jsonl'), null);
  assert.equal(antigravitySessionIdFromPath('/transcript.jsonl'), null);
});

test('native step and generation metadata decode to request start, model ID, and exact timing', () => {
  const metadata = stepMetadata({ createdSec: CREATED_SEC, createdNanos: CREATED_NANOS, generation: 3 });
  assert.deepEqual(antigravityStepStart(metadata), { createdMs: CREATED_MS, generationIndex: 3 });

  const timings = antigravityNativeTimings(
    [{ idx: 7, metadata }],
    new Map([[3, generationData({ display: 'Gemini 3.8 Flash (High)', base: 'gemini-3.8-flash-n', firstTokenMs: 2804, streamMs: 4 })]])
  );
  assert.deepEqual(timings.get(7), {
    createdMs: CREATED_MS, latencyMs: 2808, firstTokenMs: 2804, model: 'gemini-3.8-flash-high', baseModel: 'gemini-3.8-flash-n'
  });
});

test('model priority is the generation display name, then the latest Model Selection, then the bare family', () => {
  const planner = step => ({ step_index: step, type: 'PLANNER_RESPONSE', source: 'MODEL', created_at: '2026-10-23T03:32:48Z', input_tokens: 100, cache_read_tokens: 0, output_tokens: 300 });
  const selection = { step_index: 1, type: 'USER_INPUT', source: 'USER', created_at: '2026-10-23T03:32:00Z', content: 'The user changed setting `Model Selection` from None to Gemini 3.8 Flash (High). No need to comment' };
  const rows = [
    selection, planner(2), planner(3), planner(4),
    { step_index: 5, type: 'USER_INPUT', source: 'USER', created_at: '2026-10-23T03:33:00Z', content: 'changed setting `Model Selection` from Gemini 3.8 Flash (High) to Gemini 4 Argon (Medium). PRIVATE-TAIL' },
    planner(6)
  ];
  const metadata = generation => stepMetadata({ createdSec: CREATED_SEC, createdNanos: 0, generation });
  const generations = new Map([
    [1, generationData({ base: 'gemini-3.8-flash-n', firstTokenMs: 900, streamMs: 100 })],                                  // family only: selection supplies the tier
    [2, generationData({ display: 'Gemini 4 Argon (High)', base: 'gemini-4-argon-x', firstTokenMs: 900, streamMs: 100 })], // display name wins
    [3, generationData({ base: 'gemini-pro-default', firstTokenMs: 900, streamMs: 100 })],                                  // family only, selection applies
    [4, generationData({ base: 'gemini-3.8-flash-n', firstTokenMs: 900, streamMs: 100 })]
  ]);
  const native = antigravityNativeTimings([
    { idx: 2, metadata: metadata(2) }, { idx: 3, metadata: metadata(3) }, { idx: 4, metadata: metadata(4) }, { idx: 6, metadata: metadata(1) }
  ], generations);
  const parsed = parseJsonl(jsonl(rows), 'antigravity', '', { sessionId: 'conv-models', native });
  const models = Object.fromEntries(parsed.records.map(record => [record.rawId, record.model]));
  assert.equal(models['2'], 'gemini-4-argon-high');
  assert.equal(models['3'], 'gemini-3.8-flash-high');
  assert.equal(models['4'], 'gemini-3.8-flash-high');
  assert.equal(models['6'], 'gemini-4-argon-medium', 'a later selection replaces the earlier one');
  assert.ok(!JSON.stringify(parsed.records).includes('PRIVATE-TAIL'), 'selection text beyond the label must not be kept');
});

test('display names become the model IDs agy uses; unknown labels are dropped', () => {
  assert.equal(antigravityModelId('Gemini 3.8 Flash (High)'), 'gemini-3.8-flash-high');
  assert.equal(antigravityModelId('Gemini 4 Argon (Low)'), 'gemini-4-argon-low');
  assert.equal(antigravityModelId('gemini-4-argon-high'), 'gemini-4-argon-high');
  assert.equal(antigravityModelId(null), null);
  const metadata = stepMetadata({ createdSec: CREATED_SEC, createdNanos: 0, generation: 1 });
  const timings = antigravityNativeTimings([{ idx: 1, metadata }], new Map([[1, generationData({ display: 'unknown', firstTokenMs: 500, streamMs: 100 })]]));
  assert.equal(timings.get(1).model, null);
  assert.equal(timings.get(1).latencyMs, 600);
});

const transcriptRows = () => [
  { step_index: 0, type: 'USER_INPUT', source: 'USER', created_at: '2026-10-23T03:32:48Z', content: 'PRIVATE-PROMPT' },
  { step_index: 7, type: 'PLANNER_RESPONSE', source: 'MODEL', created_at: '2026-10-23T03:32:48Z', input_tokens: 1000, cache_read_tokens: 5000, output_tokens: 280, thinking: 'PRIVATE-THINKING', tool_calls: [{ name: 'run', args: { cmd: 'PRIVATE-ARGS' } }] },
  { step_index: 8, type: 'GENERIC', source: 'SYSTEM', created_at: '2026-10-23T03:33:00Z', content: 'PRIVATE-TOOL-OUTPUT' },
  { step_index: 9, type: 'CHECKPOINT', source: 'SYSTEM', created_at: '2026-10-23T03:34:00Z', input_tokens: 2000, cache_read_tokens: 0, output_tokens: 50 }
];

test('without the native store, Antigravity rows keep tokens and cache counters but no speed or TTFT', () => {
  const parsed = parseJsonl(jsonl(transcriptRows()), 'antigravity', '', { sessionId: 'conv-1' });
  assert.equal(parsed.sessionId, 'conv-1');
  assert.deepEqual(parsed.records.map(record => record.rawId).sort(), ['7', '9']);
  const byId = Object.fromEntries(parsed.records.map(record => [record.rawId, record]));
  assert.equal(byId['7'].durationMs, null);
  assert.equal(byId['7'].tokensPerSecond, null);
  assert.equal(byId['7'].firstTokenMs, null);
  assert.equal(byId['7'].freshInputTokens, 1000, 'input_tokens excludes cache reads for Antigravity');
  assert.ok(Math.abs(byId['7'].cacheHitRate - 5000 / 6000) < 1e-9);
  assert.equal(byId['7'].model, undefined);
  const serialized = JSON.stringify(parsed.records);
  for (const secret of ['PRIVATE-PROMPT', 'PRIVATE-THINKING', 'PRIVATE-ARGS', 'PRIVATE-TOOL-OUTPUT']) {
    assert.ok(!serialized.includes(secret), `${secret} must not leave the parser`);
  }
});

test('with the native store, rows carry model, exact latency, TTFT, and session-log speed', () => {
  const metadata = stepMetadata({ createdSec: CREATED_SEC, createdNanos: CREATED_NANOS, generation: 3 });
  const native = antigravityNativeTimings(
    [{ idx: 7, metadata }],
    new Map([[3, generationData({ display: 'Gemini 3.8 Flash (High)', base: 'gemini-3.8-flash-n', firstTokenMs: 2804, streamMs: 4 })]])
  );
  const parsed = parseJsonl(jsonl(transcriptRows()), 'antigravity', '', { sessionId: 'conv-1', native });
  const record = parsed.records.find(item => item.rawId === '7');
  assert.equal(record.model, 'gemini-3.8-flash-high');
  assert.equal(record.durationMs, 2808);
  assert.equal(record.firstTokenMs, 2804);
  assert.equal(record.completedAt, CREATED_MS + 2808);
  assert.equal(record.createdAtSec, CREATED_SEC);
  assert.equal(record.dataSource, 'antigravity_session');
  assert.ok(Math.abs(record.tokensPerSecond - 280 / 2.808) < 1e-9);
  assert.equal(record.isEstimatedSpeed, true);
  // Steps without a native generation still count their tokens.
  assert.equal(parsed.records.find(item => item.rawId === '9').durationMs, null);
});

test('discovery joins the transcript with the native conversation store', sqliteTestOptions, async t => {
  const root = await fixture(t), conversation = 'a1b2c3d4-0000-4000-8000-00000000abcd';
  const logs = path.join(root, 'brain', conversation, '.system_generated', 'logs');
  await mkdir(logs, { recursive: true });
  await mkdir(path.join(root, 'conversations'));
  await writeFile(path.join(logs, 'transcript.jsonl'), jsonl(transcriptRows()));
  // Rotated copies repeat the same steps; only the live transcript may be counted.
  await writeFile(path.join(logs, 'transcript_full.jsonl'), jsonl(transcriptRows()));
  await writeFile(path.join(root, 'history.jsonl'), jsonl([{ text: 'unrelated' }]));

  const db = new DatabaseSync(path.join(root, 'conversations', `${conversation}.db`));
  db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB, step_payload BLOB);' +
    'CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);');
  db.prepare('INSERT INTO steps VALUES (?, 15, ?, ?)').run(7, stepMetadata({ createdSec: CREATED_SEC, createdNanos: CREATED_NANOS, generation: 3 }), Buffer.from('PRIVATE-PAYLOAD'));
  db.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(3, generationData({ display: 'Gemini 3.8 Flash (High)', firstTokenMs: 2804, streamMs: 4 }));
  db.close();

  const { units, records } = await antigravityRecords(path.join(root, 'brain'));
  assert.equal(units.length, 1, 'rotated transcript copies are not counted');
  const scanned = records.find(record => record.rawId === '7');
  assert.equal(scanned.sessionId, conversation);
  assert.equal(scanned.model, 'gemini-3.8-flash-high');
  assert.equal(scanned.durationMs, 2808);
  assert.equal(scanned.firstTokenMs, 2804);
  assert.ok(!JSON.stringify(records).includes('PRIVATE-PAYLOAD'), 'step payloads must never be read');
});

test('a conversation without a readable native store keeps tokens instead of guessing', sqliteTestOptions, async t => {
  const root = await fixture(t), conversation = 'b1b2c3d4-0000-4000-8000-00000000abcd';
  const logs = path.join(root, 'brain', conversation, '.system_generated', 'logs');
  await mkdir(logs, { recursive: true });
  await mkdir(path.join(root, 'conversations'));
  await writeFile(path.join(logs, 'transcript.jsonl'), jsonl(transcriptRows()));
  await writeFile(path.join(root, 'conversations', `${conversation}.db`), 'not a sqlite database');

  const { units, records } = await antigravityRecords(path.join(root, 'brain'));
  assert.equal(units.length, 1);
  assert.equal(records.find(record => record.rawId === '7').durationMs, null);
  assert.equal(records.find(record => record.rawId === '7').outputTokens, 280);
});

test('project TPS discovers unregistered Antigravity sessions by their saved workspace', sqliteTestOptions, async t => {
  const root = await fixture(t), brain = path.join(root, 'brain');
  const selected = path.join(root, 'project with spaces'), other = path.join(selected, 'other project');
  await mkdir(path.join(root, 'conversations'));
  for (const [sessionId, workspace] of [['selected', selected], ['other', other]]) {
    const logs = path.join(brain, sessionId, '.system_generated', 'logs');
    await mkdir(logs, { recursive: true });
    await writeFile(path.join(logs, 'transcript.jsonl'), jsonl(transcriptRows()));
    const db = new DatabaseSync(path.join(root, 'conversations', sessionId + '.db'));
    try {
      db.exec('CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);' +
        'CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB);' +
        'CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);');
      const metadata = Buffer.concat([bytesField(1, stringField(1, pathToFileURL(workspace).href)), stringField(7, workspace)]);
      db.prepare("INSERT INTO trajectory_metadata_blob VALUES ('main', ?)").run(metadata);
    } finally { db.close(); }
  }
  const project = (await antigravityRecords(brain)).records.filter(record => record.cwd === normalizeComparePath(selected));
  assert.equal(project.length, parseJsonl(jsonl(transcriptRows()), 'antigravity', '', { sessionId: 'selected' }).records.length);
  assert.ok(project.length > 0);
  assert.ok(project.every(record => record.provider === 'antigravity' && record.sessionId === 'selected'));
});

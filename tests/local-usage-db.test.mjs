import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openLocalUsageDb, USAGE_RETENTION_MS } from '../src/local-usage-db.mjs';
import { createRecordUsageIndex } from '../src/record-usage-index.mjs';
import { createSourceUploader, createSqliteUploadStorage } from '../src/usage-upload.mjs';

const now = Date.UTC(2026, 10, 21, 12);
const source = '7947c5c1-36a1-45fa-a8ad-91705080fb7f';
const record = (id, completedAt, tokens = 10) => ({ id, completedAt, provider: 'codex', model: 'sample', freshInputTokens: tokens });
const reading = (records, extra) => ({ deviceGuid: source, logUnitKey: 'log', logStamp: 'stamp', records, complete: true, now, ...extra });

test('the local database keeps exactly three business tables and survives a large rebuild', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tps-local-db-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'data', 'usage.sqlite');
  let db = openLocalUsageDb(filename);
  const count = 30_000;
  db.replaceLog(reading(Array.from({ length: count }, (_, index) => ({
    ...record(String(index), now - index),
    model: ('model-' + index + '-').padEnd(125, 'x')
  }))));
  db.close();
  assert.ok((await stat(filename)).size > 5 * 1024 * 1024);
  const inspect = new DatabaseSync(filename, { readOnly: true });
  try {
    assert.deepEqual(inspect.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(row => row.name),
      ['panel_cache', 'upload_queue', 'usage_records']);
  } finally { inspect.close(); }
  db = openLocalUsageDb(filename);
  try {
    assert.equal(db.readRecords({ from: now - 1, to: now + 1 }).length, 2);
    assert.equal(db.readRecords().length, count);
    assert.equal(db.readLogVersions(source).get('log'), 'stamp');
  } finally { db.close(); }
});

test('complete log reads replace old rows, while interrupted reads preserve them and enforce the 720-hour boundary', () => {
  const db = openLocalUsageDb(':memory:');
  try {
    const edge = now - USAGE_RETENTION_MS;
    const a = record('a', edge), b = record('b', now - 1);
    db.replaceLog(reading([record('too old', edge - 1), a, b, record('future', now + 1)]));
    assert.deepEqual(db.readRecords().map(row => row.id), ['a', 'b']);
    db.replaceLog(reading([record('a', now, 20)], { complete: false, logStamp: 'partial' }));
    assert.deepEqual(db.readRecords().map(row => [row.id, row.tokens]), [['a', 10], ['b', 10]]);
    const affected = db.replaceLog(reading([record('a', now, 20)], { logStamp: 'updated' }));
    assert.deepEqual(affected, [edge, now - 1, now]);
    assert.deepEqual(db.readRecords().map(row => [row.id, row.tokens]), [['a', 20]]);
    db.prune(now + USAGE_RETENTION_MS + 1);
    assert.deepEqual(db.readRecords(), []);
  } finally { db.close(); }
});

test('each panel retains two successful snapshots and matches the requested scope', () => {
  const db = openLocalUsageDb(':memory:');
  try {
    for (const [index, value] of ['A', 'B', 'C'].entries()) db.publishPanel('current-data', 'project-a', value, now + index);
    assert.deepEqual(db.readPanel('current-data', 'project-a'), { value: 'C', at: now + 2 });
    assert.deepEqual(db.readPanel('current-data', 'project-a', { previous: true }), { value: 'B', at: now + 1 });
    db.publishPanel('current-data', 'project-b', 'D', now + 3);
    db.publishPanel('current-data', 'project-a', 'late refresh', now + 2);
    assert.equal(db.readPanel('current-data', 'project-a').value, 'C');
    assert.equal(db.readPanel('current-data', 'project-b').value, 'D');
    assert.equal(db.readPanel('current-data', 'project-c'), null);
    assert.equal(db.readPanel('leaderboard', 'project-b'), null);
  } finally { db.close(); }
});

test('the detail index retains a disconnected SSH source and counts same-time requests once per record', async () => {
  const db = openLocalUsageDb(':memory:');
  const remote = 'afe04472-9c3e-416c-a382-11a6bd1fb170';
  let online = true, complete = true, revision = 1, clock = now;
  const log = (deviceGuid, key, tokens) => ({ deviceGuid, key, stamp: String(revision), bytes: 100, mtimeMs: clock,
    readRecords: async () => ({ records: tokens.map((value, index) => record('r' + index, now - 100, value)),
      nextOffset: null, complete: deviceGuid === source || complete }) });
  const index = createRecordUsageIndex({ db, deviceGuid: source, now: () => clock, maxUnits: 10, budgetBytes: 1000,
    discover: async () => ({
      descriptors: [log(source, 'local', [30]), ...(online ? [log(remote, 'ssh', revision === 1 ? [40, 60] : [120])] : [])],
      localComplete: true, remoteComplete: online,
      remoteSources: new Map(online ? [[remote, { sourceId: remote, observedAt: clock }]] : [])
    }) });
  try {
    await index.refresh();
    assert.equal(index.leaderboardUsage().tokens, 130);
    assert.equal(index.summary().windows.today.requests, 3);
    assert.deepEqual(index.leaderboardSources().find(item => item.sourceId === remote).buckets, [[now - 100, 100]]);
    online = false;
    await index.refresh();
    assert.equal(index.leaderboardUsage().tokens, 130);
    assert.equal(index.leaderboardSources().find(item => item.sourceId === remote).coverage, undefined);
    online = true;
    revision++;
    complete = false;
    await index.refresh();
    assert.equal(index.leaderboardUsage().tokens, 130);
    complete = true;
    clock += 15_001;
    await index.refresh();
    assert.equal(index.leaderboardUsage().tokens, 150);
    assert.equal(index.summary().windows.today.requests, 2);
  } finally { db.close(); }
});

test('a single-source packet retries byte-for-byte across restart and failed receipt writes', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tps-local-queue-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'usage.sqlite');
  const scope = { origin: 'https://test.example', accountId: 1 };
  const reopen = db => createSourceUploader(createSqliteUploadStorage(db.queue, scope), 'account-1', source,
    { format: 3, username: () => 'alice' });
  let db = openLocalUsageDb(filename);
  let uploader = reopen(db), loseReply = true, tokens = 30;
  const packets = [], receipts = new Set();
  const upload = () => uploader({ now, active: () => true,
    read: async () => [{ sourceId: source, sourceKind: 'local', observedAt: now, coverage: [now - USAGE_RETENTION_MS, now],
      daily: [{ day: '2026-11-21', tokens }], buckets: [[now - 1, tokens]] }],
    send: async body => {
      if (body.format === 2) return { code: 'accepted', results: [{ code: 'accepted', mode: 'empty' }] };
      assert.deepEqual(Object.keys(body), ['username', 'deviceGuid', 'data']);
      assert.equal(body.deviceGuid, source);
      packets.push(JSON.stringify(body));
      receipts.add(body.data.requestId);
      return loseReply ? { code: 'unavailable' } :
        { code: 'accepted', results: [{ code: 'accepted', revision: body.data.revision }] };
    } });
  try {
    assert.equal((await upload()).code, 'unavailable');
    tokens = 55;
    assert.ok(db.queue.next(scope));
    assert.equal(db.queue.next({ ...scope, accountId: 2 }), undefined);
    assert.equal(db.queue.next({ ...scope, origin: 'https://prod.example' }), undefined);
    db.close();
    db = openLocalUsageDb(filename);
    uploader = reopen(db);
    loseReply = false;
    const write = db.queue.write;
    db.queue.write = (...args) => {
      if (args[3]?.state === 'confirmed') throw new Error('receipt write interrupted');
      return write(...args);
    };
    await assert.rejects(upload(), /receipt write interrupted/);
    assert.ok(db.queue.next(scope));
    db.queue.write = write;
    assert.equal((await upload()).code, 'accepted');
    assert.equal(db.queue.next(scope), undefined);
    assert.equal(receipts.size, 1);
    assert.deepEqual(packets, [packets[0], packets[0], packets[0]]);
    uploader = reopen(db);
    assert.equal((await upload()).code, 'accepted');
    assert.equal(packets.length, 4);
    assert.equal(JSON.parse(packets[3]).data.daily[0].tokens, 55);
    assert.equal(receipts.size, 2);
    assert.equal((await upload()).code, 'accepted');
    assert.equal(packets.length, 4);
  } finally { db.close(); }
});

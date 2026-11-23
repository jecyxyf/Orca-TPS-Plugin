import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openLocalUsageDb, personalRecordsCutoff, USAGE_RETENTION_MS } from '../src/local-usage-db.mjs';
import { HOUR_MS } from '../src/leaderboard-stats.mjs';
import { createRecordUsageIndex } from '../src/record-usage-index.mjs';
import { HISTORY_DAYS } from '../src/usage-summary.mjs';
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
    assert.equal(inspect.prepare('PRAGMA table_info(usage_records)').all().length, 13);
    assert.equal(inspect.prepare("SELECT count(*) AS count FROM panel_cache WHERE panel GLOB 'usage-log:*'").get().count, 1);
  } finally { inspect.close(); }
  db = openLocalUsageDb(filename);
  try {
    assert.equal(db.readRecords({ from: now - 1, to: now + 1 }).length, 2);
    assert.equal(db.readRecords().length, count);
    assert.equal(db.readLogVersions(source).get('log'), 'stamp');
  } finally { db.close(); }
});

test('complete log reads replace old rows, while interrupted reads preserve them up to the personal history boundary', () => {
  const db = openLocalUsageDb(':memory:');
  try {
    const edge = personalRecordsCutoff(now);
    const a = record('a', edge), b = record('b', now - 1);
    db.replaceLog(reading([record('too old', edge - 1), a, b, record('future', now + 1)]));
    assert.deepEqual(db.readRecords().map(row => row.id), ['a', 'b']);
    db.replaceLog(reading([record('a', now, 20)], { complete: false, logStamp: 'partial' }));
    assert.deepEqual(db.readRecords().map(row => [row.id, row.tokens]), [['a', 10], ['b', 10]]);
    const affected = db.replaceLog(reading([record('a', now, 20)], { logStamp: 'updated' }));
    assert.deepEqual(affected, [edge, now - 1, now]);
    assert.deepEqual(db.readRecords().map(row => [row.id, row.tokens]), [['a', 20]]);
    db.prune(now + HISTORY_DAYS * 24 * HOUR_MS + 2 * HOUR_MS);
    assert.deepEqual(db.readRecords(), []);
    assert.equal(db.readLogVersions(source).size, 0);
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

test('a fresh database imports local history once, then resumes live collection after a restart', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tps-live-usage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'usage.sqlite');
  let db = openLocalUsageDb(filename);
  const remote = 'afe04472-9c3e-416c-a382-11a6bd1fb170';
  let clock = now, scans = 0;
  const errors = [];
  const makeIndex = () => createRecordUsageIndex({ db, deviceGuid: source, now: () => clock, maxUnits: 1, budgetBytes: 1000,
    discover: async () => {
      scans++;
      return [
        { key: 'local', stamp: 'initial', bytes: 100, mtimeMs: now,
          readRecords: async () => ({ records: [record('history', now - 1000, 30)], nextOffset: null, complete: true }) },
        { key: 'unreadable', stamp: 'initial', bytes: 100, mtimeMs: now - 1000,
          readRecords: async () => { throw new Error('local_read_failed'); } }
      ];
    }, log: text => errors.push(text) });
  let index = makeIndex();
  try {
    await index.refresh();
    assert.equal(index.initialized(), false);
    assert.equal(index.leaderboardUsage().tokens, 30);
    clock += 1000;
    const local = record('same id', clock, 40);
    assert.equal(index.observe(source, [local]), true);
    assert.equal(index.observe(remote, [record('before init', clock, 60)]), false);
    await index.refresh();
    assert.equal(index.initialized(), true);
    assert.equal(errors.length, 1);
    clock += 1000;
    const liveRemote = record('same id', clock, 60);
    assert.equal(index.observe(remote, [record('old remote', now - 1, 100), liveRemote]), true);
    assert.equal(index.observe(remote, [liveRemote]), false);
    await index.refresh();
    assert.equal(index.leaderboardUsage().tokens, 130);
    assert.equal(index.summary().windows.today.requests, 3);
    assert.deepEqual(index.leaderboardSources().find(item => item.sourceId === remote).buckets, [[clock, 60]]);
    assert.equal(index.leaderboardHours().find(item => item.sourceId === remote).hours.length, 1);
    assert.equal(scans, 1);

    db.close();
    db = openLocalUsageDb(filename);
    index = makeIndex();
    clock += 1000;
    await index.refresh();
    assert.equal(index.leaderboardUsage().tokens, 130);
    assert.equal(index.leaderboardSources().find(item => item.sourceId === remote).observedAt, undefined);
    assert.equal(index.observe(source, [local]), false);
    assert.equal(index.observe(remote, [record('new on reconnect', clock - 300, 20)]), true);
    await index.refresh();
    assert.equal(index.leaderboardUsage().tokens, 150);
    assert.equal(scans, 1);
  } finally { db.close(); }
});

test('an existing database resumes the annual backfill without duplicating saved requests or uploading old usage', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tps-existing-usage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'usage.sqlite');
  let db = openLocalUsageDb(filename);
  const recent = record('existing', now - 100, 12);
  const older = record('100 days ago', now - 100 * 24 * HOUR_MS, 40);
  const oldest = record('200 days ago', now - 200 * 24 * HOUR_MS, 20);
  db.replaceLog(reading([recent], { logStamp: 'local-history:stamp' }));
  db.close();
  const olderDatabase = new DatabaseSync(filename);
  olderDatabase.prepare('DELETE FROM panel_cache WHERE panel=?').run('usage-collection');
  olderDatabase.close();
  db = openLocalUsageDb(filename);
  let reads = 0;
  const makeIndex = () => createRecordUsageIndex({ db, deviceGuid: source, now: () => now, maxUnits: 1, budgetBytes: 1000,
    discover: async cutoff => {
      assert.ok(cutoff <= oldest.completedAt);
      return [
        { key: 'log', stamp: 'stamp', bytes: 1, mtimeMs: now,
          readRecords: async () => { reads++; return { records: [recent, older], nextOffset: null }; } },
        { key: 'archive', stamp: 'stamp', bytes: 1, mtimeMs: older.completedAt,
          readRecords: async () => { reads++; return { records: [oldest], nextOffset: null }; } }
      ];
    } });
  let index = makeIndex();
  try {
    await index.refresh();
    assert.equal(index.initialized(), true);
    assert.equal(index.hasPendingHistory(), true);
    assert.equal(index.observe(source, [record('old unindexed', now - 200, 40)]), false);
    assert.equal(index.summary().windows.today.tokens, 12);
    assert.equal(index.summary().windows.year.tokens, 52);
    assert.equal(reads, 1);
    db.close();
    db = openLocalUsageDb(filename);
    index = makeIndex();
    await index.refresh();
    await index.refresh();
    assert.equal(index.hasPendingHistory(), false);
    assert.equal(reads, 2);
    assert.equal(index.summary().windows.year.tokens, 72);
    assert.equal(index.summary().windows.month.tokens, 12);
    assert.equal(index.summary().daily.length, 3);
    assert.equal(index.summary().hourly.windows.year.tokens - index.summary().hourly.windows.month.tokens, 60);
    assert.equal(index.leaderboardSources()[0].buckets.reduce((total, [, tokens]) => total + tokens, 0), 12);
    assert.equal(db.loadCollection(now).importedAt, now);
  } finally { db.close(); }
});

test('the version 1 migration keeps request totals, log versions, snapshots and pending packets', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tps-usage-v1-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'usage.sqlite');
  const scope = { origin: 'https://test.example', accountId: 17, deviceGuid: source };
  const packet = { body: { deviceGuid: source, data: { requestId: 'pending', hours: [] } } };
  const seed = openLocalUsageDb(filename);
  seed.replaceLog(reading([
    { ...record('request-a', now - 200, 21), outputTokens: 7, cacheReadTokens: 2, cacheCreationTokens: 3 },
    record('request-b', now - 100, 12)
  ]));
  seed.loadCollection(now - 1000, source);
  seed.saveCollection({ importedAt: now, githubUserId: 17 }, now);
  seed.publishPanel('usage', 'desktop', { totals: 34 }, now - 1);
  seed.publishPanel('usage', 'desktop', { totals: 45 }, now);
  seed.queue.write(scope, 'pending', packet, { state: 'pending-hourly', now });
  seed.queue.write(scope, 'old', { code: 'accepted' }, { state: 'confirmed', now });
  seed.queue.write(scope, 'progress', { version: 7 }, { now });
  seed.close();

  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    ALTER TABLE usage_records ADD COLUMN log_stamp TEXT NOT NULL DEFAULT 'old';
    UPDATE usage_records SET log_stamp='new', updated_at=updated_at+1 WHERE record_id='request-b';
    DELETE FROM panel_cache WHERE panel GLOB 'usage-log:*';
    UPDATE panel_cache SET previous_scope='desktop', previous_snapshot='{}', previous_at=current_at
      WHERE panel='usage-collection';
    PRAGMA user_version=1;
  `);
  legacy.close();

  const migrated = openLocalUsageDb(filename);
  try {
    assert.deepEqual(migrated.readRecords().map(row => [row.id, row.tokens]), [['request-a', 33], ['request-b', 12]]);
    assert.deepEqual([...migrated.readLogVersions(source)], [['log', 'new']]);
    assert.deepEqual(migrated.loadCollection(now, 'afe04472-9c3e-416c-a382-11a6bd1fb170'),
      { startedAt: now - 1000, importedAt: now, deviceGuid: source, githubUserId: 17 });
    assert.deepEqual(migrated.readPanel('usage', 'desktop'), { value: { totals: 45 }, at: now });
    assert.deepEqual(migrated.readPanel('usage', 'desktop', { previous: true }), { value: { totals: 34 }, at: now - 1 });
    assert.equal(migrated.readPanel('usage-collection', 'desktop', { previous: true }), null);
    assert.deepEqual(migrated.queue.next(scope, 'pending-hourly').value, packet);
    assert.deepEqual(migrated.queue.read(scope, 'progress'), { version: 7 });
    assert.equal(migrated.queue.read(scope, 'old'), undefined);
  } finally { migrated.close(); }
});

test('personal hourly stats use the last local hour for all four periods and hold until the next hour', async () => {
  const db = openLocalUsageDb(':memory:');
  const cutoff = new Date(2026, 10, 21, 14).getTime();
  const year = HISTORY_DAYS * 24 * HOUR_MS;
  let clock = cutoff + 35 * 60_000;
  const records = [
    record('before year', cutoff - year - 1, 2000),
    record('year edge', cutoff - year, 2048),
    record('before month', cutoff - 720 * HOUR_MS - 1, 1000),
    record('month edge', cutoff - 720 * HOUR_MS, 1),
    record('before week', cutoff - 168 * HOUR_MS - 1, 2),
    record('week edge', cutoff - 168 * HOUR_MS, 4),
    { ...record('before day', cutoff - 24 * HOUR_MS - 1, 8), tokensPerSecond: 1000 },
    { ...record('day edge', cutoff - 24 * HOUR_MS, 16), tokensPerSecond: 160, isEstimatedSpeed: true },
    { ...record('before cutoff', cutoff - 1, 32), tokensPerSecond: 120 },
    { ...record('at cutoff', cutoff, 64), tokensPerSecond: 260, isEstimatedSpeed: true },
    { ...record('after cutoff', cutoff + 100, 128), tokensPerSecond: 260 }
  ];
  const createIndex = () => createRecordUsageIndex({ db, deviceGuid: source, now: () => clock,
    discover: async () => assert.fail('a ready database must not rescan logs') });
  const index = createIndex();
  try {
    db.saveCollection({ startedAt: cutoff - 60_000, importedAt: cutoff - 60_000, historyDays: HISTORY_DAYS }, cutoff - 60_000);
    db.appendRecords({ deviceGuid: source, records, now: clock });
    await index.refresh();
    const first = index.summary().hourly;
    assert.equal(first.cutoffAt, cutoff);
    assert.equal(first.ready, true);
    assert.deepEqual(Object.values(first.windows).map(value => [value.tokens, value.requests]), [[48, 2], [60, 4], [63, 6], [3111, 8]]);
    assert.deepEqual(first.windows.today.maxSpeed, { tokensPerSecond: 160, estimated: true });
    assert.equal(index.summary().windows.today.tokens, 224);
    assert.deepEqual(index.summary().windows.today.maxSpeed, { tokensPerSecond: 260, estimated: false });
    assert.ok(index.leaderboardSources()[0].buckets.every(([at]) => at >= clock - USAGE_RETENTION_MS));

    clock += 10 * 60_000;
    assert.equal(index.observe(source, [{ ...record('read late', cutoff - 20, 256), tokensPerSecond: 300, isEstimatedSpeed: true }]), true);
    await index.refresh();
    assert.strictEqual(index.summary().hourly, first);
    assert.equal(index.summary().windows.today.tokens, 480);
    assert.deepEqual(index.summary().windows.today.maxSpeed, { tokensPerSecond: 300, estimated: true });

    db.publishPanel('usage', 'desktop', index.summary(), clock);
    const restarted = createIndex();
    await restarted.ready();
    assert.deepEqual(restarted.summary().hourly, first);
    clock = cutoff + HOUR_MS;
    await restarted.refresh();
    assert.equal(restarted.summary().hourly.cutoffAt, clock);
    assert.deepEqual(Object.values(restarted.summary().hourly.windows).map(value => value.tokens), [480, 504, 510, 1511]);
    assert.deepEqual(restarted.summary().hourly.windows.today.maxSpeed, { tokensPerSecond: 300, estimated: true });

    const legacy = structuredClone(restarted.summary());
    delete legacy.hourly.windows.year;
    delete legacy.hourly.windows.today.maxSpeed;
    db.publishPanel('usage', 'desktop', legacy, clock);
    const upgraded = createIndex();
    await upgraded.ready();
    assert.deepEqual(upgraded.summary().hourly, restarted.summary().hourly);
  } finally { db.close(); }
});

test('personal date stats start a new day at local midnight while hourly stats keep the recent hours', async () => {
  const db = openLocalUsageDb(':memory:');
  const midnight = new Date(2026, 10, 22).getTime();
  let clock = midnight - 1;
  const index = createRecordUsageIndex({ db, deviceGuid: source, now: () => clock, maxUnits: 10, budgetBytes: 1000,
    discover: async () => [] });
  try {
    db.replaceLog(reading([{ ...record('before midnight', clock), tokensPerSecond: 125 }], { now: clock }));
    await index.refresh();
    assert.equal(index.summary().windows.today.requests, 1);
    assert.deepEqual(index.summary().windows.today.maxSpeed, { tokensPerSecond: 125, estimated: false });
    clock = midnight;
    await index.refresh();
    assert.equal(index.summary().windows.today.requests, 0);
    assert.equal(index.summary().windows.today.maxSpeed, null);
    assert.equal(index.summary().windows.week.requests, 1);
    assert.equal(index.summary().hourly.cutoffAt, midnight);
    assert.equal(index.summary().hourly.windows.today.requests, 1);
    assert.deepEqual(index.summary().hourly.windows.today.maxSpeed, { tokensPerSecond: 125, estimated: false });
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
    const remove = db.queue.remove;
    db.queue.remove = () => { throw new Error('receipt write interrupted'); };
    await assert.rejects(upload(), /receipt write interrupted/);
    assert.ok(db.queue.next(scope));
    db.queue.remove = remove;
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

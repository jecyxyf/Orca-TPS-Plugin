import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openLocalUsageDb, personalRecordsCutoff } from '../src/local-usage-db.mjs';
import { HOUR_MS } from '../src/leaderboard_stats.mjs';
import { HISTORY_DAYS } from '../src/personal_stats.mjs';

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

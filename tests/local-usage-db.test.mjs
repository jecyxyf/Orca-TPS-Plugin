import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openLocalUsageDb } from '../src/local-usage-db.mjs';

const now = Date.UTC(2026, 10, 21, 12);
const source = '7947c5c1-36a1-45fa-a8ad-91705080fb7f';

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
    assert.throws(() => db.publishPanel('usage', 'desktop', {}), /unknown panel/);
    assert.equal(db.legacyDeviceGuid(), undefined);
  } finally { db.close(); }
});

test('upgrading drops the old usage copy and queue but keeps panel snapshots and the installation ID', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tps-usage-v2-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'data', 'usage.sqlite');
  openLocalUsageDb(filename).close();
  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    CREATE TABLE usage_records (device_guid TEXT, record_id TEXT, model TEXT, PRIMARY KEY(device_guid, record_id));
    CREATE TABLE upload_queue (origin TEXT, value TEXT);
    INSERT INTO upload_queue VALUES ('https://test.example', '{}');
    INSERT INTO panel_cache VALUES ('usage-collection', 'desktop', '{"deviceGuid":"${source}","githubUserId":17}', 1, NULL, NULL, NULL);
    INSERT INTO panel_cache VALUES ('usage', 'desktop', '{"totals":45}', 2, NULL, NULL, NULL);
    INSERT INTO panel_cache VALUES ('usage-log:${source}/log', '${source}', '"stamp"', 3, NULL, NULL, NULL);
    INSERT INTO panel_cache VALUES ('current-data', 'project', '{"records":[]}', 4, 'other', '{}', 3);
    PRAGMA user_version=2;
  `);
  const insert = legacy.prepare('INSERT INTO usage_records VALUES (?, ?, ?)');
  legacy.exec('BEGIN');
  for (let index = 0; index < 30_000; index++) insert.run(source, String(index), 'model-'.padEnd(125, 'x'));
  legacy.exec('COMMIT');
  legacy.close();
  const before = (await stat(filename)).size + (await stat(filename + '-wal').catch(() => ({ size: 0 }))).size;
  assert.ok(before > 3 * 1024 * 1024);

  const db = openLocalUsageDb(filename);
  try {
    assert.equal(db.legacyDeviceGuid(), source);
    assert.deepEqual(db.readPanel('current-data', 'project'), { value: { records: [] }, at: 4 });
    assert.deepEqual(db.readPanel('current-data', 'other'), { value: {}, at: 3 });
  } finally { db.close(); }
  assert.ok((await stat(filename)).size < 64 * 1024);
  const inspect = new DatabaseSync(filename, { readOnly: true });
  try {
    assert.deepEqual(inspect.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name), ['panel_cache']);
    assert.deepEqual(inspect.prepare('SELECT panel FROM panel_cache ORDER BY panel').all().map(row => row.panel),
      ['current-data', 'usage-collection']);
    assert.equal(inspect.prepare('PRAGMA user_version').get().user_version, 3);
  } finally { inspect.close(); }
  const newer = new DatabaseSync(filename);
  newer.exec('PRAGMA user_version=4');
  newer.close();
  assert.throws(() => openLocalUsageDb(filename), /unsupported/);
});

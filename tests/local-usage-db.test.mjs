import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
  } finally { db.close(); }
});

test('collection state preserves migrated deviceGuid and account metadata across restarts', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tps-local-db-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'data', 'usage.sqlite');
  let db = openLocalUsageDb(filename);
  db.loadCollection(now - 1000, source);
  db.saveCollection({ importedAt: now, githubUserId: 17 }, now);
  db.publishPanel('usage', 'desktop', { totals: 45 }, now);
  db.close();

  db = openLocalUsageDb(filename);
  try {
    assert.deepEqual(db.loadCollection(now, 'afe04472-9c3e-416c-a382-11a6bd1fb170'),
      { startedAt: now - 1000, importedAt: now, deviceGuid: source, githubUserId: 17 });
    assert.deepEqual(db.readPanel('usage', 'desktop'), { value: { totals: 45 }, at: now });
  } finally { db.close(); }
});

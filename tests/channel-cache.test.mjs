import test from 'node:test';
import assert from 'node:assert/strict';
import { createChannelCache } from '../src/channel-cache.mjs';
import { openLocalUsageDb } from '../src/local-usage-db.mjs';

test('one hundred project records persist across restarts with equal timestamps and unchanged reads keep their time', t => {
  const db = openLocalUsageDb(':memory:');
  t.after(() => db.close());
  let now = 1000;
  const cache = createChannelCache(db, { now: () => now });
  const request = (id, completedAt) => ({ id, completedAt, provider: 'codex', outputTokens: 250 });
  const history = Array.from({ length: 100 }, (_, i) => request('record-' + i, i));
  cache.set('project', history);
  now = 2000;
  const changed = cache.set('project', [...history, request('new', 99)]);
  assert.equal(changed.records.length, 100);
  assert.equal(changed.records.filter(record => record.completedAt === 99).length, 2);
  assert.equal(changed.records.at(-1).completedAt, 1);
  assert.equal(changed.updatedAt, 2000);
  assert.deepEqual(db.readPanel('current-data', 'project').value, changed);

  const restarted = createChannelCache(db, { now: () => 3000 });
  assert.deepEqual(restarted.get('project'), changed);
  assert.deepEqual(restarted.set('project', [...history, request('new', 99)]), changed);
  assert.equal(db.readPanel('current-data', 'project').at, 2000);
  assert.equal(restarted.get('different-project'), null);
  restarted.set('background', history, { display: false });
  assert.equal(db.readPanel('current-data', 'background'), null);
  assert.equal(restarted.get('background').records.length, 100);
});

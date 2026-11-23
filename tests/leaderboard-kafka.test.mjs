import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createLeaderboardServer } from '../server/app.mjs';
import { createLeaderboardJobs } from '../server/leaderboard-jobs.mjs';
import { openLeaderboardStore } from '../server/store.mjs';
import { HOUR_MS, hourStart } from '../src/leaderboard-stats.mjs';

const brokers = process.env.ORCA_TPS_KAFKA_TEST_BROKERS?.split(',').map(broker => broker.trim()).filter(Boolean);

async function eventually(check, message) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await sleep(50);
  }
  assert.fail(message);
}

test('four Kafka consumers write SQLite, publish at the cutoff and resume unconfirmed data', {
  skip: !brokers?.length && 'set ORCA_TPS_KAFKA_TEST_BROKERS to an isolated Kafka broker',
  timeout: 60_000
}, async t => {
  const { createKafkaLeaderboardJobs, uploadPartitionKey } = await import('../server/kafka-transport.mjs');
  const require = createRequire(new URL('../server/package.json', import.meta.url));
  const { Kafka, logLevel, Partitioners } = require('kafkajs');
  const kafka = new Kafka({ brokers, logLevel: logLevel.NOTHING });
  const admin = kafka.admin();
  const topic = `orca-tps-test-${randomUUID()}`, groupId = topic;
  await admin.connect();
  await admin.createTopics({ topics: [{ topic, numPartitions: 4, replicationFactor: 1,
    configEntries: [{ name: 'retention.ms', value: '259200000' }] }] });

  const directory = await mkdtemp(join(tmpdir(), 'orca-tps-kafka-test-'));
  const filename = join(directory, 'leaderboard.sqlite');
  const store = openLeaderboardStore(filename);
  const lock = new DatabaseSync(filename);
  const cutoff = hourStart(Date.UTC(2026, 10, 21, 12)), hour = cutoff - HOUR_MS;
  let clock = cutoff - 1000, jobs, server, locked = false;
  const messages = [];
  const options = { filename, maxTokens: 1_000_000, brokers, topic, groupId,
    now: () => clock, readPublished: store.leaderboardData.latestResult, onWrite: store.invalidateUploadCaches,
    log: message => messages.push(message) };
  t.after(async () => {
    if (locked) lock.exec('ROLLBACK');
    lock.close();
    if (server) await new Promise(resolve => server.close(resolve));
    await jobs?.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
    await admin.disconnect();
  });

  const metadata = (await admin.fetchTopicMetadata({ topics: [topic] })).topics[0].partitions;
  const partitioner = Partitioners.DefaultPartitioner();
  const partitionFor = key => partitioner({ topic, partitionMetadata: metadata, message: { key } });
  function packet(account, partition, tokens) {
    const username = `tps-${account}`, session = randomBytes(32).toString('base64url');
    const sessionDigest = createHash('sha256').update(session).digest('hex');
    store.upsertAccount({ id: account, login: username });
    store.addSession(sessionDigest, account, 'plugin', cutoff + 3 * HOUR_MS);
    let key;
    let deviceGuid;
    do {
      deviceGuid = randomUUID();
      key = uploadPartitionKey(account, [{ kind: 'hourly-source', input: { sourceId: deviceGuid } }]);
    } while (partitionFor(key) !== partition);
    const data = { format: 4, operation: 'hourly-update', requestId: randomUUID(),
      hours: [{ hour, tokens, updatedAt: clock, coveredUntil: Math.min(clock, cutoff) }],
      sample: { id: randomUUID(), at: clock, deltaTokens: 600, avgTps: 100 + account,
        topModel: 'test-model', topCli: 'codex' } };
    return { account, session, body: { username, deviceGuid, data }, entries: [{ kind: 'hourly-source',
      receivedAt: clock, sessionDigest, input: { username, sourceId: deviceGuid, reporterId: deviceGuid, ...data,
        fingerprint: key } }] };
  }
  function published() { return JSON.parse(jobs.snapshot() ?? 'null'); }
  async function offsets() {
    const [{ partitions }] = await admin.fetchOffsets({ groupId, topics: [topic] });
    return partitions;
  }
  const catchUp = async () => {
    const end = await admin.fetchTopicOffsets(topic);
    const consumed = await offsets();
    return end.every(({ partition, high }) => consumed.find(row => row.partition === partition)?.offset === high);
  };

  jobs = createKafkaLeaderboardJobs(options);
  await eventually(() => published()?.cutoffAt === hour, 'initial Kafka barrier did not publish');
  await eventually(async () => (await admin.describeGroups([groupId])).groups[0]?.members.length === 4,
    'four consumers did not join the same group');
  await eventually(catchUp, 'startup markers were not confirmed');
  const initialOffsets = await offsets();

  const uploads = [0, 1, 2, 3].map(partition => packet(partition + 1, partition, 1000 + partition));
  clock = cutoff;
  const after = packet(5, 2, 2000);
  clock = cutoff - 1000;
  lock.exec('BEGIN IMMEDIATE');
  locked = true;
  const pending = Promise.all(uploads.map(upload => jobs.submit(upload.entries, upload.account)));
  await eventually(() => messages.some(message => message.includes('SQLite 写锁')), 'SQLite write lock was not exercised');
  assert.deepEqual(await offsets(), initialOffsets);
  assert.equal(published().cutoffAt, hour);

  clock = cutoff;
  const afterResult = jobs.submit(after.entries, after.account);
  lock.exec('COMMIT');
  locked = false;
  assert.deepEqual((await pending).map(([result]) => result.code), Array(4).fill('accepted'));
  assert.equal((await afterResult)[0].code, 'accepted');
  await eventually(() => published()?.cutoffAt === cutoff, 'the next hourly Kafka barrier did not publish');
  for (const window of [24, 168, 720]) {
    assert.deepEqual(published().boards[window].rows.map(row => row.tokens), [1003, 1002, 1001, 1000]);
  }
  assert.deepEqual(published().boards[0].rows.map(row => row.username), ['tps-4', 'tps-3', 'tps-2', 'tps-1']);
  assert.equal(store.status(5, cutoff).tokens, 2000);
  await eventually(catchUp, 'writes and cutoff markers were not all confirmed');

  // Restore one older Kafka offset to reproduce a database commit whose offset was not saved.
  await jobs.close();
  await eventually(async () => !(await admin.describeGroups([groupId])).groups[0]?.members.length,
    'the Kafka group did not stop');
  await admin.setOffsets({ groupId, topic, partitions: initialOffsets.map(({ partition, offset }) => ({ partition, offset })) });
  jobs = createKafkaLeaderboardJobs(options);
  await eventually(catchUp, 'the last batch was not replayed after restart');
  assert.equal(store.status(5, cutoff).tokens, 2000);
  assert.deepEqual(published().boards[24].rows.map(row => row.tokens), [1003, 1002, 1001, 1000]);

  clock += 1000;
  const restart = packet(6, 3, 3000);
  const previous = (await admin.fetchTopicOffsets(topic)).find(row => row.partition === 3).high;
  lock.exec('BEGIN IMMEDIATE');
  locked = true;
  const unconfirmed = jobs.submit(restart.entries, restart.account);
  await eventually(async () => (await admin.fetchTopicOffsets(topic)).find(row => row.partition === 3).high !== previous,
    'the batch was not enqueued before restart');
  await jobs.close();
  assert.equal((await unconfirmed)[0].code, 'unavailable');
  assert.equal(store.status(6, clock).tokens, null);
  lock.exec('COMMIT');
  locked = false;
  jobs = createKafkaLeaderboardJobs(options);
  await eventually(catchUp, 'the batch interrupted before SQLite commit was not recovered');
  assert.equal(store.status(6, clock).tokens, 3000);

  server = createLeaderboardServer({ baseUrl: 'http://127.0.0.1:8787', store, jobs, now: () => clock });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function submit(session, body) {
    const response = await fetch(`${origin}/api/leaderboard/uploads`, { method: 'POST',
      headers: { Authorization: `Bearer ${session}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, ...await response.json() };
  }
  const repeated = await submit(after.session, after.body);
  assert.equal(repeated.status, 201);
  assert.equal(repeated.code, 'accepted');
  assert.equal(store.status(5, cutoff).tokens, 2000);
  assert.equal((await (await fetch(`${origin}/api/leaderboard/snapshot`)).json()).cutoffAt, cutoff);

  const remote = randomUUID(), reporterA = randomUUID(), reporterB = randomUUID();
  function sshPacket(reporterGuid, operation, fields) {
    return submit(after.session, { username: after.body.username, deviceGuid: remote,
      data: { format: 4, operation, reporterGuid, requestId: randomUUID(), ...fields } });
  }
  const lease = reporter => sshPacket(reporter, 'lease', { observedAt: clock });
  const update = (reporter, leaseEpoch, tokens) => sshPacket(reporter, 'hourly-update', { leaseEpoch,
    hours: [{ hour: cutoff, tokens, updatedAt: clock, coveredUntil: clock }] });
  clock += 11_000;
  const first = await lease(reporterA);
  assert.equal(first.code, 'accepted');
  assert.equal((await lease(reporterB)).code, 'standby');
  assert.equal((await update(reporterA, first.leaseEpoch, 100)).code, 'accepted');
  clock += 61_000;
  const replacement = await lease(reporterB);
  assert.equal(replacement.code, 'accepted');
  assert.equal((await update(reporterB, replacement.leaseEpoch, 200)).code, 'accepted');
  assert.equal((await update(reporterA, first.leaseEpoch, 100)).code, 'lease_expired');
  assert.equal(store.status(5, clock).tokens, 2200);

  const legacy = packet(7, 0, 1);
  const response = await fetch(`${origin}/api/leaderboard/rolling-data`, { method: 'POST',
    headers: { Authorization: `Bearer ${legacy.session}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ installationId: legacy.body.deviceGuid, version: 1, buckets: [[hour, 900]] }) });
  assert.equal((await response.json()).code, 'accepted');

  clock = cutoff + HOUR_MS;
  await eventually(() => published()?.cutoffAt === clock, 'the second cutoff did not publish');
  assert.ok(published().boards[24].rows.some(row => row.username === 'tps-5' && row.tokens === 2200));
  await eventually(catchUp, 'Kafka accumulated unconfirmed offsets before shutdown');

  const cached = jobs.snapshot();
  await new Promise(resolve => server.close(resolve));
  server = null;
  await jobs.close();
  jobs = createLeaderboardJobs(options);
  assert.equal(jobs.snapshot(), cached);
  const fallback = packet(8, 0, 4000);
  assert.equal((await jobs.submit(fallback.entries))[0].code, 'accepted');
  assert.equal(store.status(8, clock).tokens, 4000);
});

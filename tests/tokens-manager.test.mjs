import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { calendarFor } from '../src/personal_stats.mjs';
import { openTokensManagerDb, readRemoteDeviceCache } from '../src/database.mjs';
import { normalizeComparePath } from '../src/harness_parser.mjs';
import { makePersonalPacket, mergePersonalPackets } from '../src/personal_stats.mjs';
import { makeLeaderboardPacket, TOKENS_DEFAULT_INTERVALS } from '../src/leaderboard_stats.mjs';
import { createPacketReceiver, createTokensRankings, validatePacket } from '../server/tokens-manager-rankings.mjs';
import { createTokensManagerJobs } from '../server/tokens-manager-jobs.mjs';
import { createPacketBuffer, openPacketBuffer } from '../server/tokens-manager-buffer.mjs';
import { createLeaderboardServer } from '../server/app.mjs';
import { openLeaderboardStore } from '../server/store.mjs';
import { runTokensManager } from '../src/token_manager.mjs';
import { MANAGER_PROTOCOL_VERSION } from '../src/orca_connection.mjs';
import { installTokensManagerBundle, readTokensManagerBundle } from '../src/tokens-manager-client.mjs';

const at = Date.parse('2026-06-15T12:03:00Z');
const day = 86_400_000, hour = day / 24;
const entry = (id, daysAgo, tokens = 100) => ({
  id, completedAt: at - daysAgo * day, provider: 'codex', model: 'fixture', cwd: '/project',
  freshInputTokens: tokens, outputTokens: 200, tokensPerSecond: 30, isEstimatedSpeed: true
});

test('the manager installation keeps only the required modules and preserves data in the parent directory', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tps-manager-bundle-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const bin = path.join(root, 'bin');
  await mkdir(path.join(bin, 'locales'), { recursive: true });
  const bundle = await readTokensManagerBundle();
  const expected = ['database.mjs', 'harness_parser.mjs', 'harnesses.mjs', 'leaderboard_stats.mjs',
    'orca_connection.mjs', 'personal_stats.mjs', 'sqlite.mjs', 'token_manager.mjs'];
  assert.deepEqual(Object.keys(bundle.files).sort(), expected);
  for (const name of ['data.mjs', 'remote-collector.mjs', 'locales/zh-CN.xml', 'version', 'local-addon.mjs']) {
    await writeFile(path.join(bin, name), 'old copy');
  }
  const stored = ['device-guid', 'tpslugin.db', 'daily.db'];
  for (const name of stored) await writeFile(path.join(root, name), 'existing data');

  await installTokensManagerBundle(root, bundle);
  const manager = await import(pathToFileURL(path.join(bin, 'token_manager.mjs')).href);
  assert.equal(typeof manager.runTokensManager, 'function');
  assert.deepEqual((await readdir(bin)).sort(), expected);
  assert.equal(await readFile(path.join(root, 'bundle-version'), 'utf8'), bundle.version);
  for (const name of stored) assert.equal(await readFile(path.join(root, name), 'utf8'), 'existing data');

  await assert.rejects(installTokensManagerBundle(root, { ...bundle, files: { '../device-guid': 'ZGF0YQ==' } }),
    /Invalid manager bundle/);
  await writeFile(path.join(bin, 'old-copy.mjs'), 'stale');
  await installTokensManagerBundle(root, bundle);
  assert.deepEqual((await readdir(bin)).sort(), expected);
});

test('moves remote statistics into a device directory and restores the latest packet for each account', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tps-remote-cache-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const deviceGuid = randomUUID();
  const directory = path.join(root, 'remote_device', deviceGuid);
  await mkdir(directory, { recursive: true });
  const personal = { deviceGuid, publishedAt: at, timeZone: 'UTC', days: [], hours: [], maxima: [] };
  const first = { deviceGuid, accountId: 11, publishedAt: at };
  const second = { deviceGuid, accountId: 22, publishedAt: at + hour };
  const write = (file, data) => writeFile(file, JSON.stringify(data));
  const legacyNames = [`personal-${deviceGuid}.json`, `leaderboard-11-${deviceGuid}.json`, `leaderboard-22-${deviceGuid}.json`];
  await Promise.all([
    write(path.join(directory, 'personal.json'), personal),
    write(path.join(directory, 'leaderboard.json'), { 11: first }),
    write(path.join(root, legacyNames[0]), { ...personal, publishedAt: at - hour }),
    write(path.join(root, legacyNames[1]), { ...first, publishedAt: at - hour }),
    write(path.join(root, legacyNames[2]), second)
  ]);

  const loaded = await readRemoteDeviceCache(root);
  assert.deepEqual(loaded.personal.get(deviceGuid), personal);
  assert.deepEqual(Object.fromEntries(loaded.relays.get(deviceGuid)), { 11: first, 22: second });
  assert.deepEqual((await readdir(directory)).sort(), ['leaderboard.json', 'personal.json']);
  for (const name of legacyNames) await assert.rejects(access(path.join(root, name)), { code: 'ENOENT' });
  assert.deepEqual(await readRemoteDeviceCache(root), loaded);
});

test('commits details, rollups and scan progress together, and retains each for its configured period', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tps-manager-db-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const open = () => openTokensManagerDb(root, { timeZone: 'UTC', now: () => at });
  let db = open();
  assert.equal(db.setting('lastScanAt'), 0);
  const guid = db.deviceGuid;
  const sqlite = new DatabaseSync(path.join(root, 'database', 'tpslugin.db'));
  try {
    sqlite.exec(`CREATE TRIGGER fail_bucket BEFORE INSERT ON buckets
      BEGIN SELECT RAISE(ABORT, 'cannot save bucket'); END;`);
    assert.throws(() => db.commitSource('fixture', 'one', [entry('partial', 0)]), /cannot save bucket/);
    assert.equal(db.sourceStamp('fixture'), undefined);
    assert.deepEqual(db.details(), []);
    assert.deepEqual(db.buckets(0), []);
  } finally {
    sqlite.exec('DROP TRIGGER IF EXISTS fail_bucket');
    sqlite.close();
  }
  db.commitSource('fixture', 'one', [entry('today', 0), entry('boundary-in', 31), entry('boundary-out', 32),
    entry('oldest', 369), entry('too-old', 370), entry('today', 0)]);
  db.close();
  db = open();
  assert.equal(db.deviceGuid, guid);
  assert.equal(db.sourceStamp('fixture'), 'one');
  db.commitSource('mirror', 'one', [entry('today', 0), entry('oldest', 369)]);
  db.finishScan(at);
  assert.deepEqual(db.details().map(x => x.id), ['today', 'boundary-in']);
  assert.equal(db.buckets(0).length, 4);
  assert.ok(db.buckets(0).every(row => row.counters[0] === 1));
  const packet = makePersonalPacket(db, at);
  const second = { ...packet, deviceGuid: randomUUID() };
  const summary = mergePersonalPackets([packet, { ...packet, publishedAt: at - 1, days: [] }, second], 'UTC', at);
  assert.equal(summary.windows.today.tokens, 600);
  assert.equal(summary.windows.today.maxSpeed.tokensPerSecond, 30);
  assert.equal(summary.hourly.windows.month.tokens, 0);
  assert.equal(summary.hourly.windows.past365.tokens, 1200);
  assert.equal(mergePersonalPackets([packet], 'Asia/Seoul', at), null);
  assert.equal(db.setTimeZone('Asia/Seoul'), true);
  assert.equal(db.deviceGuid, guid);
  assert.equal(db.setting('lastScanAt'), 0);
  assert.equal(db.buckets(0).length, 0);
  assert.equal(db.sourceStamp('fixture'), undefined);
  db.close();
  assert.equal(calendarFor('Asia/Seoul').day(Date.parse('2026-06-15T15:01:00Z')), '2026-06-16');
});

test('merges legacy databases and WAL changes without counting already-applied batches twice', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tps-manager-db-merge-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const newPath = name => path.join(root, 'database', name);
  const oldDaily = path.join(root, 'daily.db');
  const open = () => openTokensManagerDb(root, { timeZone: 'UTC', now: () => at });
  let db = open();
  const guid = db.deviceGuid, generation = db.setting('generation');
  db.commitSource('fixture', 'one', [entry('already-applied', 0)], at);
  const completed = [0, 1].flatMap(kind => db.buckets(kind).map(row => ({ kind, ...row })));
  db.commitSource('fixture', 'two', [entry('awaiting-rollup', 0)], at);
  db.finishScan(at);
  db.close();

  const main = new DatabaseSync(newPath('tpslugin.db'));
  const daily = new DatabaseSync(newPath('daily.db'));
  const batch = completed.map(({ kind, day, at, project, provider, model, counters }) => [
    JSON.stringify([kind, day, at, project, provider, model]), counters
  ]);
  try {
    const schema = main.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='buckets'").get().sql;
    daily.exec('CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);');
    daily.exec(schema);
    const saveSetting = daily.prepare('INSERT INTO settings VALUES (?, ?)');
    saveSetting.run('generation', generation);
    saveSetting.run('applied', '0');
    const save = daily.prepare('INSERT INTO buckets VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const [key, counters] of batch) save.run(...JSON.parse(key), JSON.stringify(counters));
    main.exec(`DROP TABLE buckets;
      CREATE TABLE pending(id INTEGER PRIMARY KEY AUTOINCREMENT, buckets TEXT NOT NULL);
      UPDATE settings SET value='3' WHERE key='version';`);
    const pending = main.prepare('INSERT INTO pending(buckets) VALUES (?)');
    pending.run(JSON.stringify(batch));
    pending.run(JSON.stringify(batch));
  } finally { daily.close(); main.close(); }

  // Simulate a prior move that finished for the main file only.
  await rename(newPath('daily.db'), oldDaily);
  const sourceFiles = [newPath('tpslugin.db'), oldDaily];
  // Exit without closing either connection so the latest commits remain in the WAL files.
  const leaveWal = `
    import { DatabaseSync } from 'node:sqlite';
    const [mainPath, dailyPath] = process.argv.slice(1);
    const main = new DatabaseSync(mainPath), daily = new DatabaseSync(dailyPath);
    for (const db of [main, daily]) {
      db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
    }
    main.exec("INSERT INTO settings VALUES ('wal-marker', '123');");
    daily.exec("UPDATE settings SET value='1' WHERE key='applied';");
    process.exit(0);
  `;
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', leaveWal, ...sourceFiles]);
  for (const filename of sourceFiles) assert.ok((await stat(filename + '-wal')).size > 32);

  db = open();
  try {
    assert.equal(db.deviceGuid, guid);
    assert.equal(db.setting('generation'), generation);
    assert.equal(db.sourceStamp('fixture'), 'two');
    assert.deepEqual(db.details().map(row => row.id).sort(), ['already-applied', 'awaiting-rollup']);
    assert.equal(db.buckets(0)[0].counters[0], 2);
    assert.equal(db.buckets(1)[0].counters[0], 2);
    assert.equal(db.setting('wal-marker'), 123);
    for (const filename of [oldDaily, newPath('daily.db')]) {
      for (const suffix of ['', '-wal', '-shm']) await assert.rejects(access(filename + suffix), { code: 'ENOENT' });
    }
  } finally { db.close(); }

  db = open();
  try {
    assert.equal(db.setting('generation'), generation);
    assert.equal(db.buckets(0)[0].counters[0], 2);
    db.commitSource('fixture', 'three', [entry('after-migration', 0)], at);
    db.finishScan(at);
    assert.equal(db.details().length, 3);
    assert.equal(db.buckets(0)[0].counters[0], 3);
  } finally { db.close(); }
});

test('backfills indexed channel lookups and retrieves the newest matching requests only', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tps-manager-channel-index-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const open = () => openTokensManagerDb(root, { timeZone: 'UTC', now: () => at });
  const db = open();
  const rows = Array.from({ length: 160 }, (_, i) => ({ ...entry('request-' + i, 0), completedAt: at - i,
    cwd: i % 2 ? '/project/other' : '/project/x/', provider: i === 1 ? 'opencode2' : 'codex', sessionId: 'session-' + i }));
  db.commitSource('fixture', '321', rows, at);
  db.close();
  const old = new DatabaseSync(path.join(root, 'database', 'tpslugin.db'));
  old.exec('DROP TRIGGER detail_channels_delete; DROP TRIGGER detail_channels_insert; DROP TABLE detail_channels;');
  old.close();
  const migrated = open();
  try {
    const projectPath = normalizeComparePath('/project/x');
    assert.equal(migrated.details().length, 160);
    assert.equal(migrated.channelDetails(projectPath, []).length, 80);
    assert.equal(migrated.channelDetails(normalizeComparePath('/project/other'), []).length, 80);
    const results = migrated.channelDetails(projectPath, [{ provider: 'opencode', sessionId: 'session-1' },
      { provider: 'codex', sessionId: 'session-0' }]);
    assert.equal(results.length, 81);
    assert.deepEqual(results.slice(0, 3).map(row => row.id), ['request-0', 'request-1', 'request-2']);
    migrated.commitSource('fixture-2', '123', [{ ...rows[0], cwd: '/project/new' }], at);
    assert.deepEqual(migrated.channelDetails(normalizeComparePath('/project/new'), []).map(row => row.id), ['request-0']);
    assert.equal(migrated.channelDetails(projectPath, []).length, 79);
  } finally { migrated.close(); }
});

function packet(guid, tokens, publishedAt = at) {
  return { deviceGuid: guid, accountId: 11, publishedAt, hours: [[Date.parse('2026-06-15T11:00:00Z'), tokens]],
    daily: [['2026-06-15', tokens]], samples: [] };
}

test('switches shared buffers while the finished round is still readable', () => {
  const buffer = createPacketBuffer(64);
  const receiverA = openPacketBuffer(buffer);
  const receiverB = openPacketBuffer(buffer);
  const ranking = openPacketBuffer(buffer);
  assert.deepEqual(receiverA.appendBatch([{ value: 'first' }, { value: 'x'.repeat(64) }]), [true, false]);
  assert.deepEqual(receiverB.appendBatch([{ value: 'second' }]), [true]);
  const finished = ranking.take();
  assert.deepEqual(receiverB.appendBatch([{ value: 'next round' }]), [true]);
  assert.deepEqual([...finished], [{ value: 'first' }, { value: 'second' }]);
  assert.deepEqual([...ranking.take()], [{ value: 'next round' }]);
  assert.deepEqual([...ranking.take()], []);
});

test('flushes a receiver batch after one second or 32 packets without waiting for a ranking round', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const shared = createPacketBuffer(16 * 1024);
  const ranking = openPacketBuffer(shared);
  const replies = [];
  const receive = createPacketReceiver(openPacketBuffer(shared), 1e6, batch => replies.push(batch));
  const account = { id: 11, username: 'player' };
  const raw = JSON.stringify(packet(randomUUID(), 100));
  const send = id => receive({ id, raw, account, at });

  send(1);
  t.mock.timers.tick(999);
  assert.deepEqual(replies, []);
  assert.deepEqual([...ranking.take()], []);
  t.mock.timers.tick(1);
  assert.deepEqual(replies, [[{ id: 1, accepted: true }]]);
  assert.equal([...ranking.take()].length, 1);

  for (let id = 2; id <= 32; id++) send(id);
  assert.equal(replies.length, 1);
  send(33);
  assert.deepEqual(replies[1], Array.from({ length: 32 }, (_, index) => ({ id: index + 2, accepted: true })));
  assert.equal([...ranking.take()].length, 32);
  t.mock.timers.tick(1000);
  assert.equal(replies.length, 2);
});

test('flushes a partial receiver batch at the configured 100 ms', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const shared = createPacketBuffer(4096);
  const replies = [];
  const receive = createPacketReceiver(openPacketBuffer(shared), 1e6, batch => replies.push(batch), 100);
  receive({ id: 1, raw: JSON.stringify(packet(randomUUID(), 100)), account: { id: 11, username: 'player' }, at });
  t.mock.timers.tick(99);
  assert.deepEqual(replies, []);
  t.mock.timers.tick(1);
  assert.deepEqual(replies, [[{ id: 1, accepted: true }]]);
  assert.equal([...openPacketBuffer(shared).take()].length, 1);
});

test('keeps the last successful scores across rounds, with original curve dates', () => {
  const rankings = createTokensRankings();
  const account = { id: 11, username: 'player' };
  const [a, b, c] = Array.from({ length: 3 }, () => randomUUID());
  const entry = (raw, receivedAt) => ({ account, receivedAt,
    packet: validatePacket(JSON.stringify(raw), account.id, receivedAt, 1e6) });
  const publish = (entries, time) => rankings.publish(entries, time, TOKENS_DEFAULT_INTERVALS);
  const first = publish([
    entry(packet(a, 10), at), entry(packet(b, 20), at), entry(packet(c, 30), at),
    entry(packet(b, 20), at + 100), entry(packet(b, 7, at - 1000), at + 100)
  ], at + 5000);
  assert.equal(first.boards[24].rows[0].tokens, 60);
  assert.equal(first.boards[24].rows.length, 1);
  assert.equal(first.boards[168].rows[0].daily.some(row => row.tokens === 60), true);
  assert.deepEqual(publish([], at + 10_000).boards[24].rows, first.boards[24].rows);
  const delayed = publish([entry(packet(b, 7, at - 1000), at + 11_000)], at + 15_000);
  assert.deepEqual(delayed.boards[24].rows, first.boards[24].rows);
  const replaced = publish([entry(packet(b, 35, at + 16_000), at + 16_000)], at + 20_000);
  assert.equal(replaced.boards[24].rows[0].tokens, 75);
  assert.equal(replaced.calendar.boards[24].rows[0].tokens, 75);
  assert.equal(replaced.boards[24].rows[0].lastUploadAt, at + 16_000);
  const later = publish([], at + day);
  assert.equal(later.boards[24].rows[0].tokens, 75);
  assert.equal(later.calendar.boards[24].rows[0].tokens, 75);
  assert.deepEqual(later.calendar.boards[168].rows[0].daily.slice(-2).map(point => [point.day, point.tokens]),
    [['2026-06-15', 75], ['2026-06-16', 0]]);
  assert.deepEqual(later.boards[168].rows[0].daily.slice(-2).map(point => [point.day, point.tokens]),
    [['2026-06-15', 75], ['2026-06-16', 0]]);
  assert.equal(later.boards[168].rows[0].tokens, 75);
  assert.equal(later.calendar.boards[168].rows[0].tokens, 75);
  const longOffline = publish([], at + 31 * day);
  assert.equal(longOffline.boards[24].rows[0].tokens, 75);
  assert.equal(longOffline.calendar.boards[24].rows[0].lastUploadAt, at + 16_000);
  assert.ok(longOffline.calendar.boards[720].rows[0].daily.every(point => point.tokens === 0));
  assert.equal(validatePacket(JSON.stringify(packet(a, 10)), 12, at, 1e6), null);
});

test('keeps every device for an account and ignores older relays of its accepted reports', () => {
  const rankings = createTokensRankings();
  const account = { id: 11, username: 'player' };
  const devices = Array.from({ length: 6 }, () => randomUUID());
  const report = (device, tokens, offset, receivedOffset = offset) => ({
    account, receivedAt: at + receivedOffset, sequence: receivedOffset + 1,
    packet: { ...packet(device, tokens, at + offset), timeZone: 'Asia/Shanghai' }
  });
  const first = rankings.publish(devices.slice(0, 4).map((device, i) => report(device, 10 * (i + 1), i)),
    at + 100, TOKENS_DEFAULT_INTERVALS);
  assert.equal(first.boards[24].rows[0].tokens, 100);

  const expanded = rankings.publish([
    report(devices[4], 50, 1000), report(devices[0], 900, -1, 1200), report(devices[5], 60, 1500, 0)
  ], at + 2000, TOKENS_DEFAULT_INTERVALS);
  assert.equal(expanded.boards[24].rows[0].tokens, 210);
  assert.equal(expanded.calendar.boards[24].rows[0].tokens, 210);
  assert.equal(expanded.boards[24].rows[0].lastUploadAt, at + 1000);

  const refreshed = rankings.publish([report(devices[1], 25, 3000)], at + 3000, TOKENS_DEFAULT_INTERVALS);
  assert.equal(refreshed.boards[24].rows[0].tokens, 215);
});

test('combines device samples and retains separate speed winners until each window ends', () => {
  const rankings = createTokensRankings();
  const account = { id: 11, username: 'player' };
  const reports = [100, 200].map((rate, index) => ({
    account, receivedAt: at,
    packet: { ...packet(randomUUID(), 10), samples: [
      [String(index).repeat(24), at - hour, 300, rate, 'model', 'codex'],
      [String(index + 2).repeat(24), at, 300, rate + 100, 'model', 'codex']
    ] }
  }));
  const first = rankings.publish(reports, at, TOKENS_DEFAULT_INTERVALS);
  const rows = first.boards[0].rows;
  assert.equal(rows[0].deltaTokens, 600);
  assert.equal(rows[0].avgTps, 150);
  assert.equal(first.calendar.boards[0].rows[0].avgTps, 250);
  const next = rankings.publish([], at + 1000, TOKENS_DEFAULT_INTERVALS);
  assert.deepEqual(next.boards[0].rows, rows);
  assert.deepEqual(next.calendar.boards[0].rows, first.calendar.boards[0].rows);
  const midnight = Date.parse('2026-06-16T00:00:00+08:00');
  const afterMidnight = rankings.publish([], midnight, TOKENS_DEFAULT_INTERVALS);
  assert.deepEqual(afterMidnight.boards[0].rows, first.calendar.boards[0].rows);
  assert.deepEqual(afterMidnight.calendar.boards[0].rows, []);
  assert.deepEqual(rankings.publish([], at + day + hour, TOKENS_DEFAULT_INTERVALS).boards[0].rows, []);
});

test('uploads speed samples from the oldest hour the completed-hour board can include', () => {
  const publishedAt = Date.parse('2026-06-15T12:59:00Z');
  const firstCompleteHour = Date.parse('2026-06-14T12:00:00Z');
  const rows = [firstCompleteHour, publishedAt - 25 * hour - 1].map((completedAt, i) => ({
    ...entry('speed-' + i, 0, 1000), completedAt
  }));
  const raw = makeLeaderboardPacket({ deviceGuid: randomUUID(), calendar: calendarFor('UTC'), details: () => rows }, 11, publishedAt);
  assert.deepEqual(raw.samples.map(sample => sample[1]), [firstCompleteHour]);
  const report = { account: { id: 11, username: 'oldest' }, receivedAt: publishedAt,
    packet: validatePacket(JSON.stringify(raw), 11, publishedAt, 1e6) };
  assert.ok(report.packet);
  const { boards, calendar } = createTokensRankings().publish([report], publishedAt, TOKENS_DEFAULT_INTERVALS);
  assert.equal(boards[0].rows[0].submittedAt, firstCompleteHour);
  assert.equal(calendar.boards[0].rows.length, 0);
});

test('a ban evicts the cached account and an unban admits only subsequent uploads', () => {
  const rankings = createTokensRankings();
  const report = (id, sequence) => ({ account: { id, username: 'player-' + id }, receivedAt: at,
    sequence, packet: { ...packet(randomUUID(), 100), accountId: id } });
  const publish = entries => rankings.publish(entries, at, TOKENS_DEFAULT_INTERVALS);
  assert.equal(publish([report(11, 1), report(12, 2)]).boards[24].rows.length, 2);
  assert.equal(rankings.setBan(11, true, 3), true);
  const banned = publish([report(11, 3), report(11, 4)]);
  assert.deepEqual(banned.boards[24].rows.map(row => row.username), ['player-12']);
  assert.deepEqual(banned.calendar.boards[24].rows.map(row => row.username), ['player-12']);
  rankings.setBan(11, false, 4);
  assert.equal(publish([report(11, 4)]).boards[24].rows.length, 1);
  assert.equal(publish([report(11, 5)]).boards[24].rows.length, 2);
});

test('keeps separate rankings and cutoffs across Beijing midnight', () => {
  const midnight = Date.parse('2026-06-16T00:00:00+08:00');
  const now = midnight + 3 * 60_000;
  const report = (id, username, yesterday, today) => {
    const account = { id, username };
    const raw = { ...packet(randomUUID(), 0, now), accountId: id, timeZone: 'UTC',
      hours: [[midnight - 29 * day, 10], [midnight - 7 * day, 25], [midnight - hour, yesterday], [midnight, today]],
      daily: [['2026-06-15', yesterday + today]] };
    return { account, receivedAt: now, packet: validatePacket(JSON.stringify(raw), id, now, 1e6) };
  };
  const { boards, calendar } = createTokensRankings().publish([
    report(11, 'alice', 400, 20), report(12, 'bob', 100, 500)
  ], now, TOKENS_DEFAULT_INTERVALS);
  const totals = rows => rows.map(({ username, tokens, rank }) => ({ username, tokens, rank }));
  assert.deepEqual(totals(boards[24].rows), [
    { username: 'alice', tokens: 400, rank: 1 }, { username: 'bob', tokens: 100, rank: 2 }
  ]);
  assert.deepEqual(totals(calendar.boards[24].rows), [
    { username: 'bob', tokens: 500, rank: 1 }, { username: 'alice', tokens: 20, rank: 2 }
  ]);
  assert.equal(boards[24].cutoffAt, midnight);
  assert.equal(calendar.cutoffAt, now);
  assert.equal(calendar.boards[24].windowStart, midnight);
  assert.equal(calendar.boards[168].windowStart, midnight - 6 * day);
  assert.equal(calendar.boards[168].rows[0].tokens, 600);
  assert.equal(calendar.boards[720].rows[0].tokens, 635);
  assert.equal(boards[168].rows[0].daily.reduce((total, point) => total + point.tokens, 0), boards[168].rows[0].tokens);
  assert.equal(boards[168].rows[0].daily.at(-1).tokens, 400);
  assert.deepEqual(calendar.boards[168].rows[0].daily.slice(-2).map(({ at, tokens }) => [at, tokens]),
    [[midnight - day, 100], [midnight, 500]]);
});

test('retains 10,000 ranks in both usage modes and 100 in each speed board', () => {
  const rankings = createTokensRankings();
  const device = randomUUID();
  const base = packet(device, 1);
  const reports = Array.from({ length: 10_001 }, (_, index) => {
    const id = index + 1;
    return { account: { id, username: 'player-' + id }, receivedAt: at, packet: { ...base, accountId: id,
      hours: [[base.hours[0][0], id]], samples: [
        ['a'.repeat(24), at - hour, 600, id, 'model', 'codex'],
        ['b'.repeat(24), at, 600, 30_000 - id, 'model', 'codex']
      ] } };
  });
  const snapshot = rankings.publish(reports, at, TOKENS_DEFAULT_INTERVALS);
  for (const set of [snapshot.boards, snapshot.calendar.boards]) {
    for (const hours of [24, 168, 720]) {
      assert.equal(set[hours].rows.length, 10_000);
      assert.equal(set[hours].rows[0].username, 'player-10001');
      assert.equal(set[hours].rows.at(-1).username, 'player-2');
      assert.equal(set[hours].rows.at(-1).rank, 10_000);
    }
  }
  assert.equal(snapshot.boards[0].rows.length, 100);
  assert.equal(snapshot.boards[0].rows.at(-1).avgTps, 9902);
  assert.equal(snapshot.calendar.boards[0].rows.length, 100);
  assert.equal(snapshot.calendar.boards[0].rows[0].username, 'player-1');
  assert.equal(rankings.snapshot(), snapshot);
  rankings.setBan(10_001, true, 0);
  const afterBan = rankings.publish([], at, TOKENS_DEFAULT_INTERVALS);
  assert.equal(afterBan.boards[24].rows.length, 10_000);
  assert.equal(afterBan.boards[24].rows.at(-1).username, 'player-1');
  assert.equal(afterBan.boards[0].rows.length, 99);

  const refreshed = rankings.publish([reports[0]], at, TOKENS_DEFAULT_INTERVALS);
  assert.equal(refreshed.boards[24].rows.length, 10_000);
  assert.equal(refreshed.boards[24].rows.at(-1).username, 'player-1');
  assert.equal(refreshed.boards[24].rows.at(-1).tokens, 1);

  const future = at + day + hour;
  const fresh = { ...reports[0], receivedAt: future, packet: { ...packet(device, 1, future), accountId: 1,
    samples: [['a'.repeat(24), future - hour, 600, 50, 'model', 'codex']] } };
  assert.deepEqual(rankings.publish([fresh], future, TOKENS_DEFAULT_INTERVALS).boards[0].rows.map(row => row.username), ['player-1']);

});

test('collapses overlapping ticks to one extra ranking and advances to the newest cutoff', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let clock = at;
  const jobs = createTokensManagerJobs({ maxTokens: 1e6, now: () => clock, receiverCount: 1, log() {} });
  t.after(() => jobs.close());
  const read = () => {
    const bytes = jobs.snapshot('hourly');
    return bytes && JSON.parse(new TextDecoder().decode(bytes));
  };
  for (let i = 0; i < 200 && !read(); i++) await setTimeout(10);
  assert.equal(read()?.version, 1);
  for (let i = 0; i < 10; i++) {
    clock += 3000;
    t.mock.timers.tick(3000);
  }
  for (let i = 0; i < 200 && read()?.version < 3; i++) await setTimeout(10);
  assert.equal(read()?.version, 3);
  assert.equal(read()?.serverTime, clock);
});

test('publishes every three seconds and retains successful uploads through an unsuccessful round', { timeout: 25_000 }, async t => {
  const token = randomBytes(32).toString('base64url');
  const directory = await mkdtemp(path.join(tmpdir(), 'tps-manager-http-'));
  const filename = path.join(directory, 'leaderboard.bin');
  const digest = createHash('sha256').update(token).digest('hex');
  openLeaderboardStore(filename).issueSession({ id: 11, login: 'player' }, digest, 'plugin', at + hour, at);
  const store = openLeaderboardStore(filename);
  const jobs = createTokensManagerJobs({ maxTokens: 1e6, now: () => at, receiverCount: 8, flushMs: 100,
    intervals: { uploadMs: 3000, publishMs: 3000, readMs: 3000 }, log() {} });
  const server = createLeaderboardServer({ tokensJobs: jobs, store, baseUrl: 'http://localhost', now: () => at });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await jobs.close();
    await rm(directory, { force: true, recursive: true });
  });
  const base = `http://127.0.0.1:${server.address().port}/api/tokens-manager`;
  const config = await fetch(base + '/config').then(res => res.json());
  assert.deepEqual(config.intervals, { scanMs: 2000, personalMs: 3000, uploadMs: 3000, publishMs: 3000, readMs: 3000 });
  assert.equal(config.speedSampleWindowMs, 25 * hour);
  const upload = body => fetch(base + '/packets', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
  const guid = randomUUID();
  const latest = packet(guid, 100);
  latest.hours.push([Math.floor(at / hour) * hour, 25]);
  latest.samples = [
    ['a'.repeat(24), at - 4 * 60_000, 700, 40, 'hourly-model', 'codex'],
    ['b'.repeat(24), at - 1000, 700, 120, 'calendar-model', 'codex']
  ];
  const responses = await Promise.all([
    upload(latest), upload(packet(guid, 200, at - 1)), upload(packet(randomUUID(), 400))
  ]);
  assert.deepEqual(responses.map(res => res.status), [202, 202, 202]);

  const readSnapshot = () => fetch(base + '/snapshot').then(res => res.json());
  async function waitForSnapshot(matches) {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const snapshot = await readSnapshot();
      if (snapshot.boards && matches(snapshot)) return snapshot;
      await setTimeout(150);
    }
    assert.fail('expected leaderboard round was not published');
  }

  const snapshot = await waitForSnapshot(next => next.boards[24].rows.length > 0);
  assert.equal(snapshot.boards[24].rows[0].tokens, 500);
  assert.equal(snapshot.nextAt - snapshot.cutoffAt, 3000);
  assert.equal(snapshot.refreshAt - snapshot.serverTime, 3000);
  assert.deepEqual(await readSnapshot(), snapshot);
  const calendar = await fetch(base + '/snapshot?mode=calendar').then(res => res.json());
  assert.equal(calendar.version, snapshot.version);
  assert.equal(calendar.mode, 'calendar');
  assert.equal(calendar.boards[24].rows[0].tokens, 525);
  assert.equal(calendar.cutoffAt, at);
  assert.equal(calendar.boards[0].windowStart, Date.parse('2026-06-15T00:00:00+08:00'));
  assert.equal(snapshot.boards[0].windowStart, Math.floor(at / hour) * hour - day);
  assert.equal(calendar.boards[0].rows[0].avgTps, 120);
  assert.equal(snapshot.boards[0].rows[0].avgTps, 40);
  const hourlyBytes = jobs.snapshot('hourly');
  const calendarBytes = jobs.snapshot('calendar');
  const readers = await Promise.all(Array.from({ length: 16 }, (_, i) =>
    fetch(base + '/snapshot' + (i % 2 ? '?mode=calendar' : '')).then(res => res.bytes())));
  for (const [i, bytes] of readers.entries()) assert.deepEqual(bytes, i % 2 ? calendarBytes : hourlyBytes);
  assert.equal(jobs.snapshot('hourly'), hourlyBytes);
  assert.equal(jobs.snapshot('calendar'), calendarBytes);
  const anonymous = await fetch(base + '/packets', { method: 'POST', body: JSON.stringify(packet(guid, 100)) });
  assert.equal(anonymous.status, 401);

  assert.equal((await upload({ ...packet(guid, 100), accountId: 12 })).status, 400);
  const kept = await waitForSnapshot(next => next.version > snapshot.version);
  assert.deepEqual(kept.boards[24].rows, snapshot.boards[24].rows);
  assert.deepEqual((await fetch(base + '/snapshot?mode=calendar').then(res => res.json())).boards[24].rows,
    calendar.boards[24].rows);
  assert.equal((await upload(packet(guid, 150))).status, 202);
  const returned = await waitForSnapshot(next => next.version > kept.version);
  assert.equal(returned.boards[24].rows[0].tokens, 550);
});

test('keeps its lease across disconnects and drains before replacing the running bundle', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tps-manager-process-'));
  const stamp = path.join(root, 'bundle-version');
  const previousVersion = 'a'.repeat(64), nextVersion = 'b'.repeat(64);
  await writeFile(stamp, previousVersion);
  let allowScan;
  const waitForScan = new Promise(resolve => { allowScan = resolve; });
  let allowClosingScan, startedClosingScan;
  const closingScan = new Promise(resolve => { allowClosingScan = resolve; });
  const closingStarted = new Promise(resolve => { startedClosingScan = resolve; });
  let scans = 0;
  let clock = at;
  let stopped = false;
  const submitted = [];
  const processJob = runTokensManager(root, { clock: () => clock,
    async fetcher(url, options) {
      if (url.endsWith('/config')) return Response.json({ intervals: { personalMs: 6000 } });
      submitted.push(JSON.parse(options.body));
      return Response.json({ code: 'accepted' });
    },
    async scan(root, db, { progress }) {
    progress({ done: 0, total: 1 });
    if (++scans === 2) {
      startedClosingScan();
      await closingScan;
    }
    await waitForScan;
    db.commitSource('fixture', 'one', [entry('today', 0)], at);
    db.finishScan(at);
  } }).finally(() => { stopped = true; });
  const peers = new Set();
  t.after(async () => {
    for (const peer of peers) peer.stop();
    allowScan();
    allowClosingScan();
    clock += 60_000;
    await processJob;
    await rm(root, { recursive: true, force: true });
  });
  function subscribe(bundleVersion = previousVersion, protocolVersion) {
    const child = spawn(process.execPath, ['src/token_manager.mjs', '--connect'],
      { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, ORCA_TPS_TOKENS_ROOT: root } });
    const events = [];
    const reader = createInterface({ input: child.stdout });
    reader.on('line', line => events.push(JSON.parse(line)));
    const send = input => child.stdin.write(JSON.stringify(input) + '\n');
    const stop = () => child.stdin.end();
    async function event(type) {
      for (let i = 0; i < 200; i++) {
        const value = events.find(item => item.type === type);
        if (value) return value;
        await setTimeout(10);
      }
      throw new Error(`No manager event: ${type}`);
    }
    const exit = new Promise(resolve => child.once('exit', resolve));
    const peer = { events, event, stop, send, exit };
    peers.add(peer);
    send({ type: 'hello', timeZone: 'UTC', local: true, bundleVersion, protocolVersion });
    return peer;
  }
  const a = subscribe(), b = subscribe(previousVersion, MANAGER_PROTOCOL_VERSION);
  const first = await a.event('ready');
  assert.equal(first.bundleVersion, previousVersion);
  assert.equal(first.protocolVersion, MANAGER_PROTOCOL_VERSION);
  assert.equal((await b.event('ready')).deviceGuid, first.deviceGuid);
  const unsupported = subscribe(previousVersion, MANAGER_PROTOCOL_VERSION + 1);
  await unsupported.exit;
  assert.equal(unsupported.events.some(event => event.type === 'ready'), false);
  await runTokensManager(root, { scan: () => assert.fail('second process acquired the socket') });
  await a.event('progress');
  assert.equal(a.events.some(event => event.type === 'summary'), false);
  a.send({ type: 'channels', channels: [{ channelId: 'test-channel', target: { key: 'project', worktreePath: '/project' } }] });
  allowScan();
  assert.equal((await a.event('summary')).summary.windows.today.requests, 1);
  const channel = await a.event('channel');
  assert.equal(channel.channelId, 'test-channel');
  assert.equal(channel.result.session.records[0].id, 'today');
  await b.event('summary');
  a.send({ type: 'credential', endpoint: 'http://localhost', accountId: 11, token: randomBytes(32).toString('base64url') });
  assert.equal((await a.event('uploaded')).accountId, 11);
  assert.equal((await a.event('intervals')).intervals.personalMs, 6000);
  assert.equal(submitted[0].deviceGuid, first.deviceGuid);
  assert.equal(submitted[0].accountId, 11);
  assert.equal(b.events.some(event => event.type === 'uploaded'), false);
  a.send({ type: 'unsubscribe' });
  a.stop();
  b.stop();
  clock += 4000;
  const c = subscribe();
  assert.equal((await c.event('ready')).deviceGuid, first.deviceGuid);
  assert.equal(stopped, false);
  await c.event('summary');
  clock += 12_000;
  c.send({ type: 'heartbeat' });
  await c.event('heartbeat');
  await closingStarted;
  await writeFile(stamp, nextVersion);
  const upgrade = subscribe(nextVersion);
  await upgrade.exit;
  assert.equal(upgrade.events.some(event => event.type === 'ready'), false);
  await c.exit;
  const duringShutdown = subscribe(nextVersion);
  await duringShutdown.exit;
  assert.equal(duringShutdown.events.some(event => event.type === 'ready'), false);
  allowClosingScan();
  await processJob;
  assert.equal(stopped, true);
  const replacement = runTokensManager(root, { clock: () => clock, scan: async () => {} });
  const d = subscribe(nextVersion);
  try {
    const updated = await d.event('ready');
    assert.equal(updated.bundleVersion, nextVersion);
    assert.equal(updated.deviceGuid, first.deviceGuid);
  } finally {
    d.send({ type: 'unsubscribe' });
    d.stop();
    clock += 60_000;
    await replacement;
  }
});

test('manager rounds use the same device versions for Personal Stats and every ranking window', { timeout: 25_000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tps-sync-'));
  const devices = await Promise.all(['hub', 'a', 'b'].map(async name => {
    const root = path.join(directory, name);
    const id = randomUUID();
    await mkdir(root);
    await writeFile(path.join(root, 'device-guid'), id);
    return { name, root, id, uploads: [] };
  }));
  const [hub, a, b] = devices;
  const bridges = new Set(), jobs = new Set(), dials = [];
  let clock = at, bannedDevice;
  t.after(async () => {
    for (const child of bridges) {
      if (child.stdin.writable) child.stdin.end(JSON.stringify({ type: 'unsubscribe' }) + '\n');
    }
    clock += 60_000;
    await Promise.all(jobs);
    await rm(directory, { recursive: true, force: true });
  });

  function bridge(device) {
    const child = spawn(process.execPath, ['src/token_manager.mjs', '--connect'], {
      stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, ORCA_TPS_TOKENS_ROOT: device.root }
    });
    bridges.add(child);
    child.stdin.on('error', () => {});
    child.once('exit', () => bridges.delete(child));
    return child;
  }

  function start(device) {
    const job = runTokensManager(device.root, {
      clock: () => clock,
      openSyncPeer(target) {
        assert.equal(device, hub);
        dials.push(target.deviceGuid);
        return bridge(devices.find(candidate => candidate.id === target.deviceGuid));
      },
      async scan(_root, db, { at: scannedAt }) {
        db.commitSource(device.name, 'first', [entry(device.name, 0)], scannedAt);
        db.finishScan(scannedAt);
      },
      async fetcher(url, options) {
        if (!url.endsWith('/config')) {
          const packet = JSON.parse(options.body);
          device.uploads.push(packet);
          if (packet.deviceGuid === bannedDevice) return Response.json({ code: 'banned' }, { status: 403 });
        }
        return Response.json({});
      }
    });
    jobs.add(job);
    return job;
  }

  function client(device) {
    const child = bridge(device);
    const events = [];
    createInterface({ input: child.stdout }).on('line', line => events.push(JSON.parse(line)));
    return {
      send: value => child.stdin.write(JSON.stringify(value) + '\n'),
      close: () => child.stdin.end(JSON.stringify({ type: 'unsubscribe' }) + '\n'),
      async event(type, check = () => true) {
        for (let i = 0; i < 300; i++) {
          const message = events.find(event => event.type === type && check(event));
          if (message) return message;
          await setTimeout(20);
        }
        assert.fail('No ' + type + ' event on ' + device.name);
      }
    };
  }

  const endpoint = 'http://localhost';
  const credential = { type: 'credential', endpoint, accountId: 11, token: randomBytes(32).toString('base64url') };
  const [hubJob, aJob] = devices.map(start);
  const [local, left, right] = devices.map(client);
  for (const ui of [local, left, right]) ui.send({ type: 'hello', timeZone: 'UTC', local: true, endpoint });
  await Promise.all([local, left, right].map(ui => ui.event('ready')));
  for (const ui of [local, left, right]) ui.send(credential);
  local.send({ type: 'sync-targets', targets: [...Array(100).fill(a), b].map(device => ({ deviceGuid: device.id, host: device.name })) });

  const allDevices = event => event.summary.progress.done === devices.length;
  const summaries = await Promise.all([local, left, right].map(ui => ui.event('summary', allDevices)));
  for (const { summary } of summaries) assert.equal(summary.windows.today.tokens, devices.length * 300);
  assert.deepEqual(new Set(dials), new Set([a.id, b.id]));

  const cacheFile = path.join(a.root, 'remote_device', b.id, 'personal.json');
  let fromB;
  for (let i = 0; i < 200 && !fromB; i++) {
    fromB = await readFile(cacheFile, 'utf8').then(JSON.parse, () => null);
    if (!fromB) await setTimeout(20);
  }
  assert.equal(fromB?.ranking.deviceGuid, b.id);
  assert.equal(fromB.ranking.publishedAt, fromB.publishedAt);
  const injected = client(a);
  injected.send({ type: 'sync-hello', deviceGuid: b.id, timeZone: 'UTC' });
  assert.equal((await injected.event('sync-ready')).protocolVersion, MANAGER_PROTOCOL_VERSION);
  const prior = fromB.publishedAt - 1;
  injected.send({ type: 'device-personal', packet: { ...fromB, publishedAt: prior, ranking: { ...fromB.ranking, publishedAt: prior } } });
  injected.send({ type: 'heartbeat' });
  await injected.event('heartbeat');
  injected.close();

  local.close();
  await hubJob;
  left.close();
  await aJob;
  const cache = await readRemoteDeviceCache(a.root);
  assert.deepEqual(new Set(cache.personal.keys()), new Set([hub.id, b.id]));
  assert.ok(cache.personal.get(b.id).publishedAt >= fromB.publishedAt);

  start(a);
  const home = client(a);
  home.send({ type: 'hello', timeZone: 'UTC', local: true, endpoint });
  const restored = await home.event('summary', allDevices);
  assert.equal(restored.summary.windows.today.tokens, devices.length * 300);
  a.uploads.length = 0;
  home.send(credential);
  await home.event('uploaded');
  assert.deepEqual(new Set(a.uploads.map(packet => packet.deviceGuid)), new Set(devices.map(device => device.id)));
  assert.equal(a.uploads.reduce((sum, packet) => sum + packet.hours.at(-1)[1], 0), restored.summary.windows.today.tokens);

  clock += 1000;
  const fullHour = Math.floor(at / hour) * hour - hour;
  const newCounters = [1, 200, 0, 0, 0, 0, 0, 0];
  const newer = {
    ...fromB, publishedAt: clock,
    days: fromB.days.map(row => ({ ...row, counters: row.counters.map((count, index) => count + newCounters[index]) })),
    hours: [{ ...fromB.hours[0], at: fullHour, counters: newCounters }, ...fromB.hours],
    ranking: { ...fromB.ranking, publishedAt: clock, hours: [[fullHour, 200], ...fromB.ranking.hours] }
  };
  const extra = Array.from({ length: 98 }, () => randomUUID());
  for (const guid of [b.id, ...extra]) {
    const ranking = guid === extra.at(-1) ? undefined : { ...newer.ranking, deviceGuid: guid };
    home.send({ type: 'device-personal', packet: { ...newer, deviceGuid: guid, ranking } });
  }
  a.uploads.length = 0;
  home.send({ type: 'upload' });
  const { summary } = await home.event('summary', event => event.summary.progress.done === 101);
  await home.event('uploaded', event => event.at === clock);
  assert.equal(a.uploads.length, 101);
  const account = { id: 11, username: 'same-account' };
  const standings = createTokensRankings().publish(a.uploads.map((packet, sequence) => ({ account, packet, sequence, receivedAt: clock })),
    clock, TOKENS_DEFAULT_INTERVALS);
  for (const [hours, name] of [[24, 'today'], [168, 'week'], [720, 'month']]) {
    assert.equal(standings.calendar.boards[hours].rows[0].tokens, summary.windows[name].tokens);
    assert.equal(standings.boards[hours].rows[0].tokens, summary.hourly.windows[name].tokens);
  }
  bannedDevice = a.uploads[1].deviceGuid;
  clock += 1000;
  home.send({ type: 'upload' });
  await home.event('upload-state', event => event.at === clock && event.code === 'banned');
  home.close();
  right.close();
});

test('scans real Copilot, WorkBuddy and Hermes fixtures and ignores a broken log entry', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tps-manager-native-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const copilot = path.join(root, 'copilot'), workbuddy = path.join(root, 'workbuddy'), hermes = path.join(root, 'hermes');
  const session = path.join(copilot, 'session-state', 'session1'), project = path.join(workbuddy, 'projects', 'project1');
  const logs = path.join(hermes, 'logs');
  for (const dir of [session, project, logs]) await mkdir(dir, { recursive: true });
  const at = Date.now() - 3000, time = new Date(at).toISOString();
  const line = object => JSON.stringify(object) + '\n';
  await writeFile(path.join(session, 'events.jsonl'), '{broken}\n' + line({
    type: 'session.usage_record', id: 'fixture-1', timestamp: time,
    data: { usage: { model: 'test-copilot', inputTokens: 110, outputTokens: 85, cacheReadTokens: 10 } }
  }));
  await writeFile(path.join(project, 'session1.jsonl'), line({
    id: 'fixture-user', timestamp: at - 1000, type: 'message', role: 'user', sessionId: 'session1', cwd: project,
    content: [{ type: 'input_text', text: 'fixture' }]
  }) + line({
    id: 'fixture-2', timestamp: at, type: 'message', role: 'assistant', status: 'completed', sessionId: 'session1', cwd: project,
    content: [{ type: 'output_text', text: 'fixture' }],
    providerData: { model: 'test-workbuddy', rawUsage: { prompt_tokens: 108, completion_tokens: 14, total_tokens: 122 } }
  }));
  await writeFile(path.join(logs, 'agent.log'),
    `${time.slice(0, 23).replace('T', ' ').replace('.', ',')} INFO [local-hermes] agent.conversation_loop: API call #1: model=test-hermes provider=example in=50 out=56 total=106 latency=3.3s id=fixture-3\n`);
  const script = `
    import { mkdir } from 'node:fs/promises';
    import { openTokensManagerDb } from './src/database.mjs';
    import { scanTokens } from './src/token_manager.mjs';
    const root = process.env.TPS_FIXTURE_DB;
    await mkdir(root + '/bin', { recursive: true });
    const db = openTokensManagerDb(root, { timeZone: 'UTC' });
    await scanTokens(root, db);
    await scanTokens(root, db);
    const read = () => db.details().map(({provider, cwd}) => [provider, cwd]).sort();
    const original = read();
    db.setTimeZone('Asia/Seoul');
    await scanTokens(root, db);
    console.log(JSON.stringify([original, read()]));
    db.close();
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    timeout: 20_000,
    env: { ...process.env, HOME: root, USERPROFILE: root, ORCA_USER_DATA_PATH: root,
      APPDATA: path.join(root, 'appdata'), LOCALAPPDATA: path.join(root, 'localappdata'),
      CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
      XDG_DATA_HOME: path.join(root, 'data'), COPILOT_HOME: copilot, WORKBUDDY_CONFIG_DIR: workbuddy,
      HERMES_HOME: hermes, TZ: 'UTC', TPS_FIXTURE_DB: path.join(root, 'manager') }
  });
  const [rows, rebuilt] = JSON.parse(stdout);
  assert.deepEqual(rebuilt, rows);
  assert.deepEqual(rows.map(([provider]) => provider), ['copilot', 'hermes', 'workbuddy']);
  assert.equal(rows.find(([provider]) => provider === 'workbuddy')[1], project);
});

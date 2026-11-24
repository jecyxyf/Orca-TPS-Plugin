import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeOrca, createOrcaConnection, TOKENS_LEASE_MS, TOKENS_ROOT } from './orca_connection.mjs';
import { openTokensManagerDb } from './database.mjs';
import { HarnessParser, normalizeComparePath, readTargetSession } from './harness_parser.mjs';
import { calendarFor, makePersonalPacket, RETENTION_DAYS } from './personal_stats.mjs';
import { HOUR_MS, makeLeaderboardPacket, TOKENS_LEADERBOARD, tokensIntervals } from './leaderboard_stats.mjs';

const entry = fileURLToPath(import.meta.url);
const DAY_MS = 24 * HOUR_MS;
const tokenPattern = /^[\w-]{43}$/;

export async function runTokensManager(root = TOKENS_ROOT, { clock = Date.now, scan = scanTokens, fetcher = fetch } = {}) {
  let startupTimer, tickTimer, finished, stopped = false;
  const connection = createOrcaConnection(root, { clock, onHello, onMessage, onUnsubscribe });
  let personalPacket, nextPersonalAt = 0;
  const leaderboard = createLeaderboardReporter({ clock, fetcher, connection });
  const collection = createTokenCollection(root, {
    clock, scan, scanInterval: () => leaderboard.intervals.scanMs,
    onProgress: progress => connection.broadcast({ type: 'progress', ...progress }),
    onReset() {
      personalPacket = undefined;
      leaderboard.clearPacket();
    },
    onComplete(db, publishedAt) {
      personalPacket = makePersonalPacket(db, publishedAt);
      leaderboard.update(db, publishedAt);
      connection.markChannelsDirty();
      if (nextPersonalAt === 0) publishPersonal();
    }
  });
  if (!await connection.listen()) return;

  function onHello(peer, message) {
    const timeZone = collection.initialize(message);
    const db = collection.db;
    leaderboard.initialize(db, message.endpoint);
    connection.reply(peer, { type: 'ready', deviceGuid: db.deviceGuid, timeZone, intervals: leaderboard.intervals });
    if (collection.ready && personalPacket) connection.reply(peer, { type: 'personal', packet: personalPacket });
    else connection.reply(peer, { type: 'progress', ...collection.progress });
  }

  function onMessage(peer, message) {
    if (message.type === 'timezone') collection.changeTimeZone(message.timeZone);
    else leaderboard.receive(peer, message, collection.db, collection.ready);
  }

  function onUnsubscribe() {
    leaderboard.clearUnusedCredential();
    if (!connection.hasPeers) void stop();
  }

  function publishPersonal() {
    const now = clock();
    if (!personalPacket || now < nextPersonalAt) return;
    nextPersonalAt = now + leaderboard.intervals.personalMs;
    connection.broadcast({ type: 'personal', packet: personalPacket });
  }

  function tick() {
    connection.expirePeers();
    leaderboard.clearUnusedCredential();
    const db = collection.db;
    if (!db || stopped) return;
    if (!connection.hasPeers) return void stop();
    leaderboard.configure(db);
    collection.refresh();
    if (!collection.ready) return;
    publishPersonal();
    connection.publishChannels(db.deviceGuid, collection.readChannel, () => collection.ready);
    if (personalPacket) leaderboard.upload(db, collection.publishedAt);
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(startupTimer);
    clearInterval(tickTimer);
    leaderboard.close();
    connection.disconnect();
    try { await collection.close(); }
    finally {
      await connection.close();
      finished();
    }
  }

  startupTimer = setTimeout(() => { if (!collection.db) void stop(); }, TOKENS_LEASE_MS);
  tickTimer = setInterval(tick, 250);
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try { await new Promise(resolve => { finished = resolve; }); }
  finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}

const harnessParser = new HarnessParser();

export async function scanTokens(_root, db, { at = Date.now(), signal, progress = () => {} } = {}) {
  const cutoff = Date.parse(db.calendar.dayAgo(at, RETENTION_DAYS - 1)) - DAY_MS;
  let total = 0;
  for await (const { key, stamp, records } of harnessParser.readSince(cutoff, {
    signal,
    needsRead: source => db.sourceStamp(source.key) !== source.stamp,
    progress(event) {
      total = event.total;
      progress(event);
    }
  })) {
    db.commitSource(key, stamp, records, at);
  }
  db.finishScan(at);
  progress({ done: total, total });
}

export async function readManagerChannel(db, target) {
  const aliases = new Map([['agy', 'antigravity'], ['opencode2', 'opencode']]);
  const provider = value => aliases.get(value) ?? value;
  const sessions = new Set((target.sessions ?? []).map(session => JSON.stringify([provider(session.provider), session.sessionId])));
  const cwd = normalizeComparePath(target.worktreePath);
  const matches = row => (cwd && normalizeComparePath(row.cwd) === cwd) ||
    sessions.has(JSON.stringify([provider(row.provider), row.sessionId]));
  const records = db.details().filter(matches).slice(0, 100);
  const fallback = records.length < 100 ? await readTargetSession(target, { ccSwitchDb: null }).catch(() => null) : null;
  const combined = new Map();
  for (const row of [...(fallback?.session?.records ?? []), ...records]) {
    combined.set(JSON.stringify([provider(row.provider), row.id, row.completedAt]), row);
  }
  const display = [...combined.values()].sort((a, b) => b.completedAt - a.completedAt).slice(0, 100)
    .map(({ cwd, project, sessionId, ...record }) => record);
  return { session: {
    id: `channel:${target.worktreeId || target.key || 'active'}`, provider: 'channel', title: target.title,
    updatedAt: Date.now(), records: display
  }, warnings: [] };
}

function createTokenCollection(root, { clock, scan, scanInterval, onProgress, onReset, onComplete }) {
  let db, scanJob, pendingZone;
  let nextScan = 0, publishedAt = 0;
  let ready = false, closed = false;
  let progress = { done: 0, total: 0 };

  function initialize(message) {
    const timeZone = calendarFor(message.timeZone).timeZone;
    db ??= openTokensManagerDb(root, { deviceGuid: message.deviceGuid, timeZone, now: clock });
    if (timeZone !== db.calendar.timeZone) pendingZone = timeZone;
    if (pendingZone) ready = false;
    return timeZone;
  }

  function changeTimeZone(value) {
    const timeZone = calendarFor(value).timeZone;
    if (timeZone !== db.calendar.timeZone || pendingZone) {
      pendingZone = timeZone;
      ready = false;
    }
  }

  function refresh() {
    const at = clock();
    if (scanJob || (at < nextScan && !pendingZone)) return;
    if (pendingZone) {
      if (db.setTimeZone(pendingZone)) {
        onReset();
        progress = { done: 0, total: 0 };
        onProgress(progress);
      }
      pendingZone = null;
    }
    scanJob = scan(root, db, {
      at,
      progress(event) {
        progress = event;
        if (!ready && !closed) onProgress(event);
      }
    }).then(() => {
      if (pendingZone || closed) return;
      ready = true;
      publishedAt = Math.max(clock(), publishedAt + 1, db.setting('lastPublishedAt', 0) + 1);
      db.saveSetting('lastPublishedAt', publishedAt);
      onComplete(db, publishedAt);
    }).catch(error => {
      db.saveSetting('lastScanError', error.code ?? error.name ?? 'scan_failed');
    }).finally(() => {
      nextScan = clock() + scanInterval();
      scanJob = null;
    });
  }

  return {
    initialize, changeTimeZone, refresh,
    get db() { return db; },
    get progress() { return progress; },
    get ready() { return ready && !pendingZone && !closed; },
    get publishedAt() { return publishedAt; },
    readChannel: target => readManagerChannel(db, target),
    async close() {
      closed = true;
      await scanJob;
      db?.close();
    }
  };
}

function safeOrigin(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    if (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
      return url.origin;
    }
  } catch {}
  return null;
}

function createLeaderboardReporter({ clock, fetcher, connection }) {
  const relays = new Map();
  const abort = new AbortController();
  let credential, endpoint, packet, uploadState;
  let intervals = tokensIntervals();
  let nextConfig = 0, nextUpload = 0;
  let uploading = false;
  const requestSignal = () => AbortSignal.any([abort.signal, AbortSignal.timeout(4000)]);

  function initialize(db, origin) {
    intervals = tokensIntervals(db.setting('intervals'), intervals);
    endpoint = safeOrigin(origin) ?? endpoint;
  }

  function clearCredential() {
    credential = packet = uploadState = undefined;
    relays.clear();
  }

  function setCredential(peer, message, db, ready) {
    const origin = safeOrigin(message.endpoint);
    const id = message.accountId;
    if (origin && Number.isSafeInteger(id) && id > 0 && tokenPattern.test(message.token ?? '')) {
      peer.accountId = id;
      if (credential?.token !== message.token) {
        if (db.setting('githubAccountId') !== id) relays.clear();
        db.saveSetting('githubAccountId', id);
        credential = { accountId: id, token: message.token, origin };
        if (endpoint !== origin) nextConfig = 0;
        endpoint = origin;
        packet = uploadState = undefined;
        nextUpload = 0;
      }
      if (ready && packet?.accountId === id) connection.reply(peer, { type: 'leaderboard', packet });
      if (uploadState?.accountId === id) connection.reply(peer, uploadState);
    } else if (message.token === null && (!credential || credential.accountId === id || peer.accountId === credential.accountId)) {
      peer.accountId = undefined;
      clearCredential();
      db.saveSetting('githubAccountId', null);
    }
  }

  function receive(peer, message, db, ready) {
    if (message.type === 'credential') {
      setCredential(peer, message, db, ready);
    } else if (message.type === 'relay' && credential && message.packet?.accountId === credential.accountId) {
      const relayed = message.packet;
      if (relayed.deviceGuid !== db.deviceGuid && typeof relayed.deviceGuid === 'string' &&
          Number.isSafeInteger(relayed.publishedAt) && (relays.get(relayed.deviceGuid)?.publishedAt ?? -1) < relayed.publishedAt) {
        relays.set(relayed.deviceGuid, relayed);
      }
    } else if (message.type === 'upload') {
      nextUpload = 0;
    }
  }

  function configure(db) {
    if (!endpoint || clock() < nextConfig) return;
    const origin = endpoint;
    nextConfig = clock() + intervals.readMs;
    void fetcher(origin + TOKENS_LEADERBOARD + '/config', { signal: requestSignal() })
      .then(response => response.ok ? response.json() : null).then(result => {
        if (origin !== endpoint || !result?.intervals || abort.signal.aborted) return;
        const updated = tokensIntervals(result.intervals, intervals);
        if (JSON.stringify(updated) !== JSON.stringify(intervals)) {
          intervals = updated;
          db.saveSetting('intervals', intervals);
          connection.broadcast({ type: 'intervals', intervals });
        }
      }).catch(() => {});
  }

  function upload(db, publishedAt) {
    if (!credential || uploading || clock() < nextUpload) return;
    packet ??= makeLeaderboardPacket(db, credential.accountId, publishedAt);
    const active = credential;
    connection.broadcast({ type: 'leaderboard', packet }, active.accountId);
    nextUpload = clock() + intervals.uploadMs;
    uploading = true;
    uploadState = { type: 'upload-state', accountId: active.accountId, nextAt: nextUpload, pending: true };
    connection.broadcast(uploadState, active.accountId);
    const packets = [packet, ...[...relays.values()].filter(relayed => relayed.accountId === active.accountId)];
    void Promise.all(packets.map(item => fetcher(active.origin + TOKENS_LEADERBOARD + '/packets', {
      method: 'POST', redirect: 'error', signal: requestSignal(),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + active.token }, body: JSON.stringify(item)
    }).then(async response => response.ok ? 'accepted' : (await response.json()).code ?? 'unavailable')
      .catch(() => 'unavailable'))).then(([code]) => {
      if (credential !== active || abort.signal.aborted) return;
      uploadState = { type: 'upload-state', accountId: active.accountId, nextAt: nextUpload, pending: false, code, at: clock() };
      connection.broadcast(uploadState, active.accountId);
      if (code === 'accepted') connection.broadcast({ type: 'uploaded', at: uploadState.at, accountId: active.accountId }, active.accountId);
    }).finally(() => { uploading = false; });
  }

  return {
    initialize, receive, configure, upload,
    get intervals() { return intervals; },
    update(db, publishedAt) { packet = credential ? makeLeaderboardPacket(db, credential.accountId, publishedAt) : null; },
    clearPacket() { packet = undefined; },
    clearUnusedCredential() {
      if (credential && !connection.hasAccount(credential.accountId)) clearCredential();
    },
    close() { abort.abort(); }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === entry) {
  const task = process.argv[2] === '--serve' ? runTokensManager() : bridgeOrca(TOKENS_ROOT, entry);
  await task.catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}

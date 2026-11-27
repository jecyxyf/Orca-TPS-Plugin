import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bridgeOrca, createManagerLinks, createOrcaConnection, createSnapshotSender, MANAGER_PROTOCOL_VERSION, MESSAGE,
  TOKENS_LEASE_MS, TOKENS_ROOT } from './orca_connection.mjs';
import { channelProvider, openRemoteDeviceCache, openTokensManagerDb } from './database.mjs';
import { enrichChannelRecords, HarnessParser } from './harness_parser.mjs';
import { normalizeComparePath } from './harnesses.mjs';
import { calendarFor, makePersonalPacket, mergePersonalPackets, RETENTION_DAYS } from './personal_stats.mjs';
import { HOUR_MS, leaderboardPacketFromPersonal, makeLeaderboardPacket, SPEED_SAMPLE_WINDOW_MS, SPEED_WINDOW_MS, TOKENS_LEADERBOARD,
  tokensIntervals, validInstallationId } from './leaderboard_stats.mjs';

const entry = fileURLToPath(import.meta.url);
const DAY_MS = 24 * HOUR_MS;
const CONFIG_REFRESH_MS = 60_000;
const tokenPattern = /^[\w-]{43}$/;

function installedBundleVersion(root) {
  try { return readFileSync(path.join(root, 'bundle-version'), 'utf8').trim(); }
  catch { return ''; }
}

export async function runTokensManager(root = TOKENS_ROOT, { clock = Date.now, scan = scanTokens, fetcher = fetch, openSyncPeer } = {}) {
  let startupTimer, tickTimer, roundTimer, finished, stopped = false;
  const bundleVersion = installedBundleVersion(root);
  const remoteDevices = await openRemoteDeviceCache(root);
  const connection = createOrcaConnection(root, { clock, onHello, onSyncHello, onMessage, onUnsubscribe });
  const sendSnapshot = createSnapshotSender(devicePackets);
  const links = createManagerLinks({ clock, onPacket: receiveDevicePacket, sendSnapshot, openPeer: openSyncPeer });
  let personalPacket, personalSummary;
  const leaderboard = createLeaderboardReporter({ clock, fetcher, connection });
  const collection = createTokenCollection(root, {
    clock, scan, scanInterval: () => leaderboard.intervals.scanMs,
    onProgress: progress => connection.broadcast({ type: MESSAGE.progress, ...progress }),
    onReset() {
      personalPacket = personalSummary = undefined;
    },
    onComplete(db, publishedAt) {
      personalPacket = {
        ...makePersonalPacket(db, publishedAt),
        ranking: makeLeaderboardPacket(db, leaderboard.accountId, publishedAt)
      };
      connection.broadcast({ type: MESSAGE.personal, packet: personalPacket }, undefined, false);
      syncDevices();
      connection.markChannelsDirty();
      if (!roundTimer) publishRound();
    }
  });
  if (!await connection.listen()) return;

  function onHello(peer, message) {
    if (message.bundleVersion && message.bundleVersion !== bundleVersion) {
      if (message.bundleVersion === installedBundleVersion(root)) void stop();
      return false;
    }
    peer.localClient = message.local === true;
    peer.syncTargets = [];
    const timeZone = collection.initialize(message);
    const db = collection.db;
    leaderboard.initialize(db, message.endpoint);
    connection.reply(peer, { type: MESSAGE.ready, deviceGuid: db.deviceGuid, timeZone, bundleVersion,
      protocolVersion: MANAGER_PROTOCOL_VERSION, intervals: leaderboard.intervals });
    if (peer.localClient) {
      if (personalSummary) connection.reply(peer, { type: MESSAGE.summary, summary: personalSummary });
      else connection.reply(peer, { type: MESSAGE.progress, ...collection.progress });
    } else if (collection.ready && personalPacket) connection.reply(peer, { type: MESSAGE.personal, packet: personalPacket });
    else connection.reply(peer, { type: MESSAGE.progress, ...collection.progress });
  }

  function onSyncHello(peer, message) {
    if (!validInstallationId(message.deviceGuid)) return false;
    if (!collection.db) {
      collection.initialize({ timeZone: message.timeZone });
      leaderboard.initialize(collection.db);
    }
    const { deviceGuid } = collection.db;
    if (message.deviceGuid === deviceGuid) return false;
    connection.reply(peer, { type: MESSAGE.syncReady, deviceGuid, protocolVersion: MANAGER_PROTOCOL_VERSION });
    void sendSnapshot(peer.socket);
    return true;
  }

  function* devicePackets() {
    const ownDevice = collection.db.deviceGuid;
    if (personalPacket) yield { type: MESSAGE.devicePersonal, packet: personalPacket };
    for (const [device, packet] of remoteDevices.personal) {
      if (device !== ownDevice) yield { type: MESSAGE.devicePersonal, packet };
    }
    for (const [device, accounts] of remoteDevices.relays) {
      if (device === ownDevice) continue;
      for (const packet of accounts.values()) yield { type: MESSAGE.deviceLeaderboard, packet };
    }
  }

  function receiveDevicePacket(message) {
    const ownDevice = collection.db.deviceGuid;
    const { packet } = message;
    const accepted = message.type === MESSAGE.devicePersonal ? remoteDevices.acceptPersonal(packet, ownDevice)
      : remoteDevices.acceptLeaderboard(packet, ownDevice);
    if (accepted) syncDevices();
  }

  function syncDevices() {
    links.publish();
    for (const stream of connection.syncStreams()) void sendSnapshot(stream);
  }

  function onMessage(peer, message) {
    if (peer.sync || (peer.localClient && message.type === MESSAGE.devicePersonal)) receiveDevicePacket(message);
    else if (message.type === MESSAGE.syncTargets && peer.localClient) {
      peer.syncTargets = message.targets;
    } else if (message.type === MESSAGE.timezone) collection.changeTimeZone(message.timeZone);
    else if (message.type === MESSAGE.credential) {
      leaderboard.setCredential(peer, message, collection.db);
      if (peer.localClient && collection.ready) publishRound();
    } else if (message.type === MESSAGE.upload && peer.localClient) {
      publishRound();
    }
  }

  function onUnsubscribe() {
    leaderboard.clearUnusedCredential();
    if (!connection.hasPeers) void stop();
  }

  function publishRound() {
    clearTimeout(roundTimer);
    if (stopped) return;
    roundTimer = setTimeout(publishRound, leaderboard.intervals.personalMs);
    const localClients = connection.localClients();
    if (!collection.ready || !personalPacket || !localClients.length) return;

    const accountId = localClients.some(peer => peer.accountId === leaderboard.accountId) ? leaderboard.accountId : undefined;
    const timeZone = personalPacket.timeZone;
    const sources = [personalPacket, ...remoteDevices.personal.values()].filter(packet => packet.timeZone === timeZone);
    const reports = [];
    const personal = accountId === undefined ? sources : sources.filter(packet => {
      const legacyAccounts = remoteDevices.relays.get(packet.deviceGuid);
      const legacy = legacyAccounts?.get(accountId);
      if (!packet.ranking && legacyAccounts?.size && !legacy) return false;
      const ranking = packet.ranking ?? (legacy?.publishedAt === packet.publishedAt && legacy.timeZone === timeZone ? legacy
        : leaderboardPacketFromPersonal(packet, accountId));
      if (!ranking || (packet !== personalPacket && ranking.accountId !== undefined && ranking.accountId !== accountId)) return false;
      reports.push({ ...ranking, accountId });
      return true;
    });
    personalSummary = mergePersonalPackets(personal, timeZone, clock());
    connection.broadcast({ type: MESSAGE.summary, summary: personalSummary }, undefined, true);
    if (accountId !== undefined) leaderboard.upload(reports);
  }

  function tick() {
    connection.expirePeers();
    leaderboard.clearUnusedCredential();
    const db = collection.db;
    if (!db || stopped) return;
    if (!connection.hasPeers) return void stop();
    leaderboard.configure(db);
    links.tick(connection.localClients().flatMap(peer => peer.syncTargets), { deviceGuid: db.deviceGuid, timeZone: db.calendar.timeZone });
    if (!collection.ready) return;
    connection.publishChannels(db.deviceGuid, collection.readChannel, () => collection.ready);
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(startupTimer);
    clearTimeout(roundTimer);
    clearInterval(tickTimer);
    leaderboard.close();
    links.close();
    connection.disconnect();
    try { await Promise.all([collection.close(), remoteDevices.flush()]); }
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

export async function scanTokens(_root, db, { at = Date.now(), signal, progress = () => {}, roots } = {}) {
  const cutoff = Date.parse(db.calendar.dayAgo(at, RETENTION_DAYS - 1)) - DAY_MS;
  let total = 0;
  for await (const { key, stamp, records } of harnessParser.readSince(cutoff, {
    signal, roots,
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
  const sessions = target.sessions ?? (target.sessionId ? [{ provider: target.provider, sessionId: target.sessionId }] : []);
  const records = db.channelDetails(normalizeComparePath(target.worktreePath), sessions);
  const display = (await enrichChannelRecords(records, sessions)).map(({ cwd, project, sessionId, ...record }) => record);
  return { session: {
    id: `channel:${target.worktreeId || target.key || 'active'}`, provider: 'channel', title: target.title,
    updatedAt: Date.now(), records: display
  }, warnings: [] };
}

// Orca names each pane's log; folders outside the default roots join later scans.
function rememberRoots(roots, target) {
  let added = false;
  for (const { provider, transcriptPath, dbPath } of target.sessions ?? []) {
    const family = channelProvider(provider);
    const file = family === 'opencode' ? dbPath : transcriptPath;
    if (typeof file !== 'string' || !path.isAbsolute(file) || !['codex', 'claude', 'pi', 'antigravity', 'opencode'].includes(family)) continue;
    const folder = family === 'opencode' ? file : path.resolve(file, family === 'antigravity' ? '../../../..' : '..');
    roots[family] ??= [];
    if (roots[family].includes(folder) || roots[family].length >= 32) continue;
    roots[family].push(folder);
    added = true;
  }
  return added;
}

function createTokenCollection(root, { clock, scan, scanInterval, onProgress, onReset, onComplete }) {
  let db, scanJob, scanTimer, pendingZone;
  const extraRoots = {};
  let publishedAt = 0;
  let ready = false, closed = false;
  let progress = { done: 0, total: 0 };

  function initialize(message) {
    const timeZone = calendarFor(message.timeZone).timeZone;
    db ??= openTokensManagerDb(root, { deviceGuid: message.deviceGuid, timeZone, now: clock });
    if (timeZone !== db.calendar.timeZone) pendingZone = timeZone;
    if (pendingZone) ready = false;
    scheduleScan(0);
    return timeZone;
  }

  function changeTimeZone(value) {
    const timeZone = calendarFor(value).timeZone;
    if (timeZone !== db.calendar.timeZone || pendingZone) {
      pendingZone = timeZone;
      ready = false;
      clearTimeout(scanTimer);
      scanTimer = undefined;
      scheduleScan(0);
    }
  }

  function scheduleScan(delay) {
    if (!closed && !scanJob && !scanTimer) scanTimer = setTimeout(refresh, delay);
  }

  function refresh() {
    scanTimer = undefined;
    if (closed) return;
    const at = clock();
    if (pendingZone) {
      if (db.setTimeZone(pendingZone)) {
        onReset();
        progress = { done: 0, total: 0 };
        onProgress(progress);
      }
      pendingZone = null;
    }
    scanJob = scan(root, db, {
      at, roots: extraRoots,
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
      scanJob = null;
      scheduleScan(pendingZone ? 0 : scanInterval());
    });
  }

  return {
    initialize, changeTimeZone,
    get db() { return db; },
    get progress() { return progress; },
    get ready() { return ready && !pendingZone && !closed; },
    readChannel(target) {
      if (rememberRoots(extraRoots, target)) scheduleScan(0);
      return readManagerChannel(db, target);
    },
    async close() {
      closed = true;
      clearTimeout(scanTimer);
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
  const abort = new AbortController();
  let credential, endpoint, uploadState;
  let extendedSpeedOrigin;
  let intervals = tokensIntervals();
  let nextConfig = 0;
  let running;
  const requestSignal = () => AbortSignal.any([abort.signal, AbortSignal.timeout(4000)]);

  function initialize(db, origin) {
    intervals = tokensIntervals(db.setting('intervals'), intervals);
    endpoint = safeOrigin(origin) ?? endpoint;
  }

  function clearCredential() {
    credential = uploadState = undefined;
  }

  function setCredential(peer, message, db) {
    const origin = safeOrigin(message.endpoint);
    const id = message.accountId;
    if (origin && Number.isSafeInteger(id) && id > 0 && tokenPattern.test(message.token ?? '')) {
      peer.accountId = id;
      if (peer.localClient || !credential || !connection.localClients().some(client => client.accountId === credential.accountId)) {
        const same = credential?.token === message.token && credential.accountId === id && credential.origin === origin;
        if (!same) {
          db.saveSetting('githubAccountId', id);
          credential = { accountId: id, token: message.token, origin };
          if (endpoint !== origin) nextConfig = 0;
          endpoint = origin;
          uploadState = undefined;
        }
      }
      if (uploadState?.accountId === id) connection.reply(peer, uploadState);
    } else if (message.token === null && (!credential || credential.accountId === id || peer.accountId === credential.accountId)) {
      peer.accountId = undefined;
      if (!credential || !connection.hasAccount(credential.accountId)) {
        clearCredential();
        db.saveSetting('githubAccountId', null);
      }
    }
  }

  function configure(db) {
    if (!endpoint || clock() < nextConfig) return;
    const origin = endpoint;
    nextConfig = clock() + CONFIG_REFRESH_MS;
    void fetcher(origin + TOKENS_LEADERBOARD + '/config', { signal: requestSignal() })
      .then(response => response.ok ? response.json() : null).then(result => {
        if (origin !== endpoint || !result?.intervals || abort.signal.aborted) return;
        extendedSpeedOrigin = result.speedSampleWindowMs === SPEED_SAMPLE_WINDOW_MS ? origin : undefined;
        const updated = tokensIntervals(result.intervals, intervals);
        if (JSON.stringify(updated) !== JSON.stringify(intervals)) {
          intervals = updated;
          db.saveSetting('intervals', intervals);
          connection.broadcast({ type: MESSAGE.intervals, intervals });
        }
      }).catch(() => {});
  }

  async function upload(packets) {
    if (!credential || running || !packets.length) return;
    const active = credential;
    const nextAt = clock() + intervals.personalMs;
    running = active;
    uploadState = { type: MESSAGE.uploadState, accountId: active.accountId, nextAt, pending: true };
    connection.broadcast(uploadState, active.accountId);
    async function uploadPacket(item) {
      const body = extendedSpeedOrigin === active.origin ? item : {
        ...item, samples: (item.samples ?? []).filter(sample => sample?.[1] >= item.publishedAt - SPEED_WINDOW_MS)
      };
      try {
        const response = await fetcher(active.origin + TOKENS_LEADERBOARD + '/packets', {
          method: 'POST', redirect: 'error', signal: requestSignal(),
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + active.token }, body: JSON.stringify(body)
        });
        if (response.ok) return 'accepted';
        if (response.status === 401) return 'login_required';
        return (await response.json()).code ?? 'unavailable';
      } catch { return 'unavailable'; }
    }
    try {
      let code = 'accepted';
      for (let offset = 0; offset < packets.length; offset += 32) {
        if (credential !== active || abort.signal.aborted) return;
        const results = await Promise.all(packets.slice(offset, offset + 32).map(uploadPacket));
        const stopped = results.find(status => status === 'login_required' || status === 'banned');
        code = stopped ?? results.find(status => status !== 'accepted') ?? code;
        if (stopped) break;
      }
      if (credential !== active || abort.signal.aborted) return;
      uploadState = { type: MESSAGE.uploadState, accountId: active.accountId, nextAt, pending: false, code, at: clock() };
      connection.broadcast(uploadState, active.accountId);
      if (code === 'accepted') connection.broadcast({ type: MESSAGE.uploaded, at: uploadState.at, accountId: active.accountId }, active.accountId);
      if (code === 'login_required' || code === 'banned') clearCredential();
    } finally { running = undefined; }
  }

  return {
    initialize, setCredential, configure, upload,
    get intervals() { return intervals; },
    get accountId() { return credential?.accountId; },
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

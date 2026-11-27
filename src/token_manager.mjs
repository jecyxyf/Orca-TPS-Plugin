import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bridgeOrca, createManagerLinks, createOrcaConnection, createSnapshotSender, MANAGER_PROTOCOL_VERSION, MESSAGE,
  TOKENS_LEASE_MS, TOKENS_ROOT } from './orca_connection.mjs';
import { channelProvider, openRemoteDeviceCache, openTokensManagerDb } from './database.mjs';
import { enrichChannelRecords, HarnessParser, normalizeComparePath, readTargetSession } from './harness_parser.mjs';
import { calendarFor, makePersonalPacket, mergePersonalPackets, RETENTION_DAYS } from './personal_stats.mjs';
import { HOUR_MS, leaderboardPacketFromPersonal, makeLeaderboardPacket, SPEED_SAMPLE_WINDOW_MS, SPEED_WINDOW_MS,
  TOKENS_LEADERBOARD, tokensIntervals, validInstallationId } from './leaderboard_stats.mjs';

const entry = fileURLToPath(import.meta.url), DAY_MS = 24 * HOUR_MS, CONFIG_REFRESH_MS = 60_000, tokenPattern = /^[\w-]{43}$/;
const installedBundleVersion = root => { try { return readFileSync(path.join(root, 'bundle-version'), 'utf8').trim(); } catch { return ''; } };

export async function runTokensManager(root = TOKENS_ROOT, { clock = Date.now, scan = scanTokens, fetcher = fetch, openSyncPeer } = {}) {
  let startupTimer, tickTimer, roundTimer, finished, stopped = false, personalPacket, personalSummary;
  const bundleVersion = installedBundleVersion(root), remoteDevices = await openRemoteDeviceCache(root);
  const connection = createOrcaConnection(root, { clock, onHello, onSyncHello, onMessage, onUnsubscribe });
  const sendSnapshot = createSnapshotSender(devicePackets);
  const links = createManagerLinks({ clock, onPacket: receiveDevicePacket, sendSnapshot, openPeer: openSyncPeer });
  const leaderboard = createLeaderboardReporter({ clock, fetcher, connection });
  const collection = createTokenCollection(root, {
    clock, scan, scanInterval: () => leaderboard.intervals.scanMs,
    onProgress: progress => connection.broadcast({ type: MESSAGE.progress, ...progress }),
    onReset() { personalPacket = personalSummary = undefined; },
    onComplete(db, publishedAt) {
      personalPacket = { ...makePersonalPacket(db, publishedAt), ranking: makeLeaderboardPacket(db, leaderboard.accountId, publishedAt) };
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
    peer.localClient = message.local === true; peer.syncTargets = [];
    const timeZone = collection.initialize(message), db = collection.db;
    leaderboard.initialize(db, message.endpoint);
    connection.reply(peer, { type: MESSAGE.ready, deviceGuid: db.deviceGuid, timeZone, bundleVersion, protocolVersion: MANAGER_PROTOCOL_VERSION, intervals: leaderboard.intervals });
    if (peer.localClient) connection.reply(peer, personalSummary ? { type: MESSAGE.summary, summary: personalSummary } : { type: MESSAGE.progress, ...collection.progress });
    else connection.reply(peer, collection.ready && personalPacket ? { type: MESSAGE.personal, packet: personalPacket } : { type: MESSAGE.progress, ...collection.progress });
  }

  function onSyncHello(peer, message) {
    if (!validInstallationId(message.deviceGuid)) return false;
    if (!collection.db) { collection.initialize({ timeZone: message.timeZone }); leaderboard.initialize(collection.db); }
    const { deviceGuid } = collection.db;
    if (message.deviceGuid === deviceGuid) return false;
    connection.reply(peer, { type: MESSAGE.syncReady, deviceGuid, protocolVersion: MANAGER_PROTOCOL_VERSION });
    void sendSnapshot(peer.socket);
    return true;
  }

  function* devicePackets() {
    const own = collection.db.deviceGuid;
    if (personalPacket) yield { type: MESSAGE.devicePersonal, packet: personalPacket };
    for (const [d, packet] of remoteDevices.personal) if (d !== own) yield { type: MESSAGE.devicePersonal, packet };
    for (const [d, accounts] of remoteDevices.relays) if (d !== own) for (const packet of accounts.values()) yield { type: MESSAGE.deviceLeaderboard, packet };
  }

  function syncDevices() { links.publish(); for (const s of connection.syncStreams()) void sendSnapshot(s); }
  function receiveDevicePacket(message) {
    const own = collection.db.deviceGuid;
    if (message.type === MESSAGE.devicePersonal ? remoteDevices.acceptPersonal(message.packet, own) : remoteDevices.acceptLeaderboard(message.packet, own)) syncDevices();
  }

  function onMessage(peer, message) {
    if (peer.sync || (peer.localClient && message.type === MESSAGE.devicePersonal)) receiveDevicePacket(message);
    else if (message.type === MESSAGE.syncTargets && peer.localClient) peer.syncTargets = message.targets;
    else if (message.type === MESSAGE.timezone) collection.changeTimeZone(message.timeZone);
    else if (message.type === MESSAGE.credential) { leaderboard.setCredential(peer, message, collection.db); if (peer.localClient && collection.ready) publishRound(); }
    else if (message.type === MESSAGE.upload && peer.localClient) publishRound();
  }
  function onUnsubscribe() { leaderboard.clearUnusedCredential(); if (!connection.hasPeers) void stop(); }

  function publishRound() {
    clearTimeout(roundTimer);
    if (stopped) return;
    roundTimer = setTimeout(publishRound, leaderboard.intervals.personalMs);
    const localClients = connection.localClients();
    if (!collection.ready || !personalPacket || !localClients.length) return;
    const accountId = localClients.some(p => p.accountId === leaderboard.accountId) ? leaderboard.accountId : undefined;
    const timeZone = personalPacket.timeZone;
    const sources = [personalPacket, ...remoteDevices.personal.values()].filter(p => p.timeZone === timeZone);
    const reports = [], personal = accountId === undefined ? sources : sources.filter(packet => {
      const legacyAccounts = remoteDevices.relays.get(packet.deviceGuid), legacy = legacyAccounts?.get(accountId);
      if (!packet.ranking && legacyAccounts?.size && !legacy) return false;
      const ranking = packet.ranking ?? (legacy?.publishedAt === packet.publishedAt && legacy.timeZone === timeZone ? legacy : leaderboardPacketFromPersonal(packet, accountId));
      if (!ranking || (packet !== personalPacket && ranking.accountId !== undefined && ranking.accountId !== accountId)) return false;
      reports.push({ ...ranking, accountId });
      return true;
    });
    personalSummary = mergePersonalPackets(personal, timeZone, clock());
    connection.broadcast({ type: MESSAGE.summary, summary: personalSummary }, undefined, true);
    if (accountId !== undefined) leaderboard.upload(reports);
  }

  function tick() {
    connection.expirePeers(); leaderboard.clearUnusedCredential();
    const db = collection.db;
    if (!db || stopped) return;
    if (!connection.hasPeers) return void stop();
    leaderboard.configure(db);
    links.tick(connection.localClients().flatMap(p => p.syncTargets), { deviceGuid: db.deviceGuid, timeZone: db.calendar.timeZone });
    if (collection.ready) connection.publishChannels(db.deviceGuid, collection.readChannel, () => collection.ready);
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(startupTimer); clearTimeout(roundTimer); clearInterval(tickTimer);
    leaderboard.close(); links.close(); connection.disconnect();
    try { await Promise.all([collection.close(), remoteDevices.flush()]); }
    finally { await connection.close(); finished(); }
  }

  startupTimer = setTimeout(() => { if (!collection.db) void stop(); }, TOKENS_LEASE_MS);
  tickTimer = setInterval(tick, 250);
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try { await new Promise(resolve => { finished = resolve; }); }
  finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); }
}

const harnessParser = new HarnessParser();

export async function scanTokens(_root, db, { at = Date.now(), signal, progress = () => {} } = {}) {
  const cutoff = Date.parse(db.calendar.dayAgo(at, RETENTION_DAYS - 1)) - DAY_MS;
  let total = 0;
  for await (const { key, stamp, records } of harnessParser.readSince(cutoff, {
    signal, needsRead: s => db.sourceStamp(s.key) !== s.stamp, progress(e) { total = e.total; progress(e); }
  })) db.commitSource(key, stamp, records, at);
  db.finishScan(at);
  progress({ done: total, total });
}

export async function readManagerChannel(db, target) {
  const sessions = target.sessions ?? (target.sessionId ? [{ provider: target.provider, sessionId: target.sessionId }] : []);
  const records = db.channelDetails(normalizeComparePath(target.worktreePath), sessions);
  const fallback = records.length < 100 ? await readTargetSession(target, { ccSwitchDb: null, includeUsageRecords: true }).catch(() => null) : null;
  const combined = new Map();
  for (const row of [...(fallback?.usageRecords ?? []), ...records]) {
    combined.set(JSON.stringify([channelProvider(row.provider), row.sessionId, row.id, row.completedAt]), row);
  }
  const display = (await enrichChannelRecords([...combined.values()], sessions)).map(({ cwd, project, sessionId, ...record }) => record);
  return { session: { id: `channel:${target.worktreeId || target.key || 'active'}`, provider: 'channel', title: target.title, updatedAt: Date.now(), records: display }, warnings: [] };
}

function createTokenCollection(root, { clock, scan, scanInterval, onProgress, onReset, onComplete }) {
  let db, scanJob, scanTimer, pendingZone, publishedAt = 0, ready = false, closed = false, progress = { done: 0, total: 0 };
  const scheduleScan = delay => { if (!closed && !scanJob && !scanTimer) scanTimer = setTimeout(refresh, delay); };
  function refresh() {
    scanTimer = undefined;
    if (closed) return;
    const at = clock();
    if (pendingZone) {
      if (db.setTimeZone(pendingZone)) { onReset(); progress = { done: 0, total: 0 }; onProgress(progress); }
      pendingZone = null;
    }
    scanJob = scan(root, db, { at, progress(e) { progress = e; if (!ready && !closed) onProgress(e); } })
      .then(() => {
        if (pendingZone || closed) return;
        ready = true;
        publishedAt = Math.max(clock(), publishedAt + 1, db.setting('lastPublishedAt', 0) + 1);
        db.saveSetting('lastPublishedAt', publishedAt);
        onComplete(db, publishedAt);
      }).catch(e => db.saveSetting('lastScanError', e.code ?? e.name ?? 'scan_failed'))
      .finally(() => { scanJob = null; scheduleScan(pendingZone ? 0 : scanInterval()); });
  }
  return {
    initialize(msg) {
      const tz = calendarFor(msg.timeZone).timeZone;
      db ??= openTokensManagerDb(root, { deviceGuid: msg.deviceGuid, timeZone: tz, now: clock });
      if (tz !== db.calendar.timeZone) pendingZone = tz;
      if (pendingZone) ready = false;
      scheduleScan(0);
      return tz;
    },
    changeTimeZone(v) {
      const tz = calendarFor(v).timeZone;
      if (tz !== db.calendar.timeZone || pendingZone) { pendingZone = tz; ready = false; clearTimeout(scanTimer); scanTimer = undefined; scheduleScan(0); }
    },
    get db() { return db; }, get progress() { return progress; }, get ready() { return ready && !pendingZone && !closed; },
    readChannel: target => readManagerChannel(db, target),
    async close() { closed = true; clearTimeout(scanTimer); await scanJob; db?.close(); }
  };
}

function safeOrigin(value) {
  try {
    const u = new URL(value);
    if (!u.username && !u.password && (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))) return u.origin;
  } catch {}
  return null;
}

function createLeaderboardReporter({ clock, fetcher, connection }) {
  const abort = new AbortController(), requestSignal = () => AbortSignal.any([abort.signal, AbortSignal.timeout(4000)]);
  let credential, endpoint, uploadState, extendedSpeedOrigin, intervals = tokensIntervals(), nextConfig = 0, running;
  const clearCredential = () => { credential = uploadState = undefined; };
  return {
    initialize(db, origin) { intervals = tokensIntervals(db.setting('intervals'), intervals); endpoint = safeOrigin(origin) ?? endpoint; },
    setCredential(peer, message, db) {
      const origin = safeOrigin(message.endpoint), id = message.accountId;
      if (origin && Number.isSafeInteger(id) && id > 0 && tokenPattern.test(message.token ?? '')) {
        peer.accountId = id;
        if (peer.localClient || !credential || !connection.localClients().some(c => c.accountId === credential.accountId)) {
          if (credential?.token !== message.token || credential.accountId !== id || credential.origin !== origin) {
            db.saveSetting('githubAccountId', id);
            credential = { accountId: id, token: message.token, origin };
            if (endpoint !== origin) nextConfig = 0;
            endpoint = origin; uploadState = undefined;
          }
        }
        if (uploadState?.accountId === id) connection.reply(peer, uploadState);
      } else if (message.token === null && (!credential || credential.accountId === id || peer.accountId === credential.accountId)) {
        peer.accountId = undefined;
        if (!credential || !connection.hasAccount(credential.accountId)) { clearCredential(); db.saveSetting('githubAccountId', null); }
      }
    },
    configure(db) {
      if (!endpoint || clock() < nextConfig) return;
      const origin = endpoint; nextConfig = clock() + CONFIG_REFRESH_MS;
      void fetcher(origin + TOKENS_LEADERBOARD + '/config', { signal: requestSignal() })
        .then(r => r.ok ? r.json() : null).then(r => {
          if (origin !== endpoint || !r?.intervals || abort.signal.aborted) return;
          extendedSpeedOrigin = r.speedSampleWindowMs === SPEED_SAMPLE_WINDOW_MS ? origin : undefined;
          const updated = tokensIntervals(r.intervals, intervals);
          if (JSON.stringify(updated) !== JSON.stringify(intervals)) { intervals = updated; db.saveSetting('intervals', intervals); connection.broadcast({ type: MESSAGE.intervals, intervals }); }
        }).catch(() => {});
    },
    async upload(packets) {
      if (!credential || running || !packets.length) return;
      const active = credential, nextAt = clock() + intervals.personalMs;
      running = active;
      uploadState = { type: MESSAGE.uploadState, accountId: active.accountId, nextAt, pending: true };
      connection.broadcast(uploadState, active.accountId);
      const uploadPacket = async item => {
        const body = extendedSpeedOrigin === active.origin ? item : { ...item, samples: (item.samples ?? []).filter(s => s?.[1] >= item.publishedAt - SPEED_WINDOW_MS) };
        try {
          const r = await fetcher(active.origin + TOKENS_LEADERBOARD + '/packets', {
            method: 'POST', redirect: 'error', signal: requestSignal(),
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + active.token }, body: JSON.stringify(body)
          });
          return r.ok ? 'accepted' : r.status === 401 ? 'login_required' : (await r.json()).code ?? 'unavailable';
        } catch { return 'unavailable'; }
      };
      try {
        let code = 'accepted';
        for (let off = 0; off < packets.length; off += 32) {
          if (credential !== active || abort.signal.aborted) return;
          const results = await Promise.all(packets.slice(off, off + 32).map(uploadPacket));
          const stopped = results.find(s => s === 'login_required' || s === 'banned');
          code = stopped ?? results.find(s => s !== 'accepted') ?? code;
          if (stopped) break;
        }
        if (credential !== active || abort.signal.aborted) return;
        uploadState = { type: MESSAGE.uploadState, accountId: active.accountId, nextAt, pending: false, code, at: clock() };
        connection.broadcast(uploadState, active.accountId);
        if (code === 'accepted') connection.broadcast({ type: MESSAGE.uploaded, at: uploadState.at, accountId: active.accountId }, active.accountId);
        if (code === 'login_required' || code === 'banned') clearCredential();
      } finally { running = undefined; }
    },
    get intervals() { return intervals; },
    get accountId() { return credential?.accountId; },
    clearUnusedCredential() { if (credential && !connection.hasAccount(credential.accountId)) clearCredential(); },
    close() { abort.abort(); }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === entry) {
  await (process.argv[2] === '--serve' ? runTokensManager() : bridgeOrca(TOKENS_ROOT, entry))
    .catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}

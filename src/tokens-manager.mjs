import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { calendarFor, openTokensManagerDb } from './tokens-manager-db.mjs';
import { validInstallationId } from './leaderboard-installation.mjs';
import { remoteSourceIdPath } from './remote-collector.mjs';
import { scanTokens, readManagerChannel } from './tokens-manager-scan.mjs';
import { makeLeaderboardPacket, makePersonalPacket, tokensIntervals, TOKENS_LEADERBOARD } from './tokens-manager-stats.mjs';

const entry = fileURLToPath(import.meta.url);
export const TOKENS_ROOT = process.env.ORCA_TPS_TOKENS_ROOT || path.join(homedir(), '.orca', 'tpsplugin');
export const TOKENS_RETRY_MS = 3000;
export const TOKENS_HEARTBEAT_MS = 5000;
export const TOKENS_LEASE_MS = 15000;
export const tokensMessage = message => JSON.stringify(message) + '\n';
const send = (stream, message) => !stream.destroyed && stream.write(tokensMessage(message));
const tokenPattern = /^[\w-]{43}$/;

function socketAddress(root) {
  const key = createHash('sha256').update(root).digest('hex').slice(0, 32);
  if (process.platform === 'win32') return '\\\\.\\pipe\\orca-tps-' + key;
  if (process.platform === 'linux') return '\0orca-tps-' + key;
  return path.join(root, 'tokens-manager.sock');
}

function localSecret(root) {
  const filename = path.join(root, 'socket-key');
  try { writeFileSync(filename, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const secret = readFileSync(filename);
  if (secret.length !== 32) throw new Error('Invalid Tokens manager socket key');
  return secret;
}

function legacyDeviceGuid() {
  try {
    const guid = readFileSync(remoteSourceIdPath(), 'utf8').trim();
    if (validInstallationId(guid)) return guid;
  } catch {}
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

export async function runTokensManager(root = TOKENS_ROOT, { clock = Date.now, scan = scanTokens, fetcher = fetch } = {}) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const secret = localSecret(root);
  const peers = new Map(), relays = new Map();
  const server = createServer(addPeer);
  const address = socketAddress(root);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(address, () => { server.removeListener('error', reject); resolve(); });
  }).catch(error => {
    if (error.code !== 'EADDRINUSE') throw error;
  });
  if (!server.listening) return;

  let db, startupTimer, tickTimer, scanJob, nextScan = 0, nextPersonal = 0, nextUpload = 0, nextConfig = 0;
  let progress = { done: 0, total: 0 }, ready = false, stopped = false;
  let personal, leaderboard, credential, endpoint, pendingZone, publishedAt = 0, uploadState;
  let intervals = tokensIntervals();
  const uploadAbort = new AbortController();

  function addPeer(socket) {
    // Keep the listener as the process lock while the final transaction drains.
    if (stopped) return socket.destroy();
    const peer = { socket, expires: clock() + TOKENS_LEASE_MS, subscribed: false, channels: new Map(), dirty: true };
    peers.set(socket, peer);
    socket.on('error', () => {});
    const reader = createInterface({ input: socket });
    reader.on('line', line => {
      if (line.length > 4 * 1024 * 1024) return socket.destroy();
      try {
        const message = JSON.parse(line);
        if (!peer.authenticated) {
          const provided = Buffer.from(typeof message.key === 'string' ? message.key : '', 'base64');
          if (message.type !== 'authenticate' || provided.length !== secret.length || !timingSafeEqual(provided, secret)) {
            return socket.destroy();
          }
          peer.authenticated = true;
          return;
        }
        receive(peer, message);
      } catch {}
    });
    socket.on('close', () => { peer.socket = null; });
  }

  function receive(peer, message) {
    if (stopped) return;
    const { type } = message;
    if (type === 'unsubscribe') {
      peers.delete(peer.socket);
      peer.socket.end();
      clearUnusedCredential();
      if (!peers.size) void stop();
      return;
    }
    peer.expires = clock() + TOKENS_LEASE_MS;
    if (type === 'hello') {
      const timeZone = calendarFor(message.timeZone).timeZone;
      const deviceGuid = validInstallationId(message.deviceGuid) ? message.deviceGuid : legacyDeviceGuid();
      db ??= openTokensManagerDb(root, { deviceGuid, timeZone, now: clock });
      intervals = tokensIntervals(db.setting('intervals'), intervals);
      if (timeZone !== db.calendar.timeZone) pendingZone = timeZone;
      if (pendingZone) ready = false;
      endpoint = safeOrigin(message.endpoint) ?? endpoint;
      peer.subscribed = true;
      send(peer.socket, { type: 'ready', deviceGuid: db.deviceGuid, timeZone, intervals });
      if (ready && personal) send(peer.socket, { type: 'personal', packet: personal });
      else send(peer.socket, { type: 'progress', ...progress });
      return;
    }
    if (!peer.subscribed) return;
    if (type === 'heartbeat') return send(peer.socket, { type: 'heartbeat' });
    if (type === 'channels' && Array.isArray(message.channels)) {
      const channels = new Map();
      for (const channel of message.channels.slice(0, 100)) {
        if (typeof channel?.channelId === 'string' && typeof channel.target?.worktreePath === 'string') {
          channels.set(channel.channelId, channel.target);
        }
      }
      peer.channels = channels;
      peer.dirty = true;
    }
    if (type === 'timezone') {
      const timeZone = calendarFor(message.timeZone).timeZone;
      if (timeZone !== db.calendar.timeZone || pendingZone) {
        pendingZone = timeZone;
        ready = false;
      }
    }
    if (type === 'credential') {
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
          leaderboard = undefined;
          uploadState = undefined;
          nextUpload = 0;
        }
        if (ready && leaderboard?.accountId === id) send(peer.socket, { type: 'leaderboard', packet: leaderboard });
        if (uploadState?.accountId === id) send(peer.socket, uploadState);
      } else if (message.token === null && (!credential || credential.accountId === id || peer.accountId === credential.accountId)) {
        peer.accountId = undefined;
        credential = leaderboard = uploadState = undefined;
        relays.clear();
        db.saveSetting('githubAccountId', null);
      }
    }
    if (type === 'relay' && credential && message.packet?.accountId === credential.accountId) {
      const packet = message.packet;
      if (packet.deviceGuid !== db.deviceGuid && typeof packet.deviceGuid === 'string' &&
          Number.isSafeInteger(packet.publishedAt) && (relays.get(packet.deviceGuid)?.publishedAt ?? -1) < packet.publishedAt) {
        relays.set(packet.deviceGuid, packet);
      }
    }
    if (type === 'upload') nextUpload = 0;
  }

  function broadcast(message, accountId) {
    for (const peer of peers.values()) {
      if (peer.socket && peer.subscribed && (accountId === undefined || peer.accountId === accountId)) send(peer.socket, message);
    }
  }

  function clearUnusedCredential() {
    if (credential && ![...peers.values()].some(peer => peer.accountId === credential.accountId)) {
      credential = leaderboard = uploadState = undefined;
      relays.clear();
    }
  }

  function channels() {
    if (!ready || pendingZone) return;
    const requests = new Map();
    for (const peer of peers.values()) {
      if (!peer.socket || !peer.dirty) continue;
      peer.dirty = false;
      for (const [channelId, target] of peer.channels) {
        const key = JSON.stringify(target);
        if (!requests.has(key)) requests.set(key, readManagerChannel(db, target));
        void requests.get(key).then(result => {
          if (peer.socket && peer.channels.get(channelId) === target && ready && !pendingZone) {
            send(peer.socket, { type: 'channel', deviceGuid: db.deviceGuid, channelId, result });
          }
        }).catch(() => {});
      }
    }
  }

  function refresh() {
    const at = clock();
    if (scanJob || at < nextScan && !pendingZone) return;
    if (pendingZone) {
      if (db.setTimeZone(pendingZone)) {
        personal = leaderboard = undefined;
        progress = { done: 0, total: 0 };
        broadcast({ type: 'progress', ...progress });
      }
      pendingZone = null;
    }
    scanJob = scan(root, db, { at, progress(event) {
      progress = event;
      if (!ready) broadcast({ type: 'progress', ...event });
    } }).then(() => {
      if (pendingZone || stopped) return;
      ready = true;
      publishedAt = Math.max(clock(), publishedAt + 1, db.setting('lastPublishedAt', 0) + 1);
      db.saveSetting('lastPublishedAt', publishedAt);
      personal = makePersonalPacket(db, publishedAt);
      leaderboard = credential ? makeLeaderboardPacket(db, credential.accountId, publishedAt) : null;
      for (const peer of peers.values()) peer.dirty = true;
      if (nextPersonal === 0) publish();
    }).catch(error => {
      db.saveSetting('lastScanError', error.code ?? error.name ?? 'scan_failed');
    }).finally(() => {
      nextScan = clock() + intervals.scanMs;
      scanJob = null;
    });
  }

  function publish() {
    if (!ready || !personal || pendingZone || clock() < nextPersonal) return;
    nextPersonal = clock() + intervals.personalMs;
    broadcast({ type: 'personal', packet: personal });
  }

  function configure() {
    if (!endpoint || clock() < nextConfig) return;
    const origin = endpoint;
    nextConfig = clock() + intervals.readMs;
    void fetcher(origin + TOKENS_LEADERBOARD + '/config', {
      signal: AbortSignal.any([uploadAbort.signal, AbortSignal.timeout(4000)])
    }).then(response => response.ok ? response.json() : null).then(result => {
      if (origin !== endpoint || !result?.intervals || stopped) return;
      const updated = tokensIntervals(result.intervals, intervals);
      if (JSON.stringify(updated) !== JSON.stringify(intervals)) {
        intervals = updated;
        db.saveSetting('intervals', intervals);
        broadcast({ type: 'intervals', intervals });
      }
    }).catch(() => {});
  }

  let uploading = false;
  function upload() {
    if (!ready || !personal || pendingZone || !credential || uploading || clock() < nextUpload) return;
    if (!leaderboard) leaderboard = makeLeaderboardPacket(db, credential.accountId, publishedAt);
    const active = credential;
    broadcast({ type: 'leaderboard', packet: leaderboard }, active.accountId);
    nextUpload = clock() + intervals.uploadMs;
    uploading = true;
    uploadState = { type: 'upload-state', accountId: active.accountId, nextAt: nextUpload, pending: true };
    broadcast(uploadState, active.accountId);
    const packets = [leaderboard, ...[...relays.values()].filter(packet => packet.accountId === active.accountId)];
    void Promise.all(packets.map(packet => fetcher(active.origin + TOKENS_LEADERBOARD + '/packets', {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([uploadAbort.signal, AbortSignal.timeout(4000)]),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + active.token }, body: JSON.stringify(packet)
    }).then(async response => response.ok ? 'accepted' : (await response.json()).code ?? 'unavailable')
      .catch(() => 'unavailable'))).then(([code]) => {
      if (credential !== active || stopped) return;
      uploadState = { type: 'upload-state', accountId: active.accountId, nextAt: nextUpload, pending: false, code, at: clock() };
      broadcast(uploadState, active.accountId);
      if (code === 'accepted') broadcast({ type: 'uploaded', at: uploadState.at, accountId: active.accountId }, active.accountId);
    }).finally(() => { uploading = false; });
  }

  function tick() {
    const at = clock();
    for (const [socket, peer] of peers) if (peer.expires <= at) { peers.delete(socket); socket.destroy(); }
    clearUnusedCredential();
    if (!peers.size && db) return void stop();
    if (!db || stopped) return;
    configure();
    refresh();
    publish();
    channels();
    upload();
  }

  let finished;
  async function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(startupTimer);
    clearInterval(tickTimer);
    uploadAbort.abort();
    for (const socket of peers.keys()) socket.destroy();
    await scanJob;
    db?.close();
    server.close(finished);
  }

  startupTimer = setTimeout(() => { if (!db) void stop(); }, TOKENS_LEASE_MS);
  tickTimer = setInterval(tick, 250);
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try { await new Promise(resolve => { finished = resolve; }); }
  finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}

function dial(root) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketAddress(root));
    socket.once('error', reject);
    socket.once('connect', () => { socket.removeListener('error', reject); resolve(socket); });
  });
}

async function connectManager(root) {
  try { return await dial(root); } catch (error) {
    if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
  }
  const child = spawn(process.execPath, [entry, '--serve'], {
    detached: true, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ORCA_TPS_TOKENS_ROOT: root }
  });
  child.on('error', () => {});
  child.unref();
  for (let attempt = 0; attempt < 25; attempt++) {
    await delay(100);
    try { return await dial(root); } catch {}
  }
  throw new Error('Tokens manager startup timed out');
}

async function bridge(root) {
  const socket = await connectManager(root);
  socket.on('error', () => { socket.destroy(); });
  process.stdout.on('error', () => { socket.destroy(); });
  socket.pipe(process.stdout, { end: false });
  send(socket, { type: 'authenticate', key: localSecret(root).toString('base64') });
  process.stdin.pipe(socket);
  await new Promise(resolve => socket.once('close', resolve));
  process.stdin.destroy();
}

if (process.argv[1] && path.resolve(process.argv[1]) === entry) {
  const task = process.argv[2] === '--serve' ? runTokensManager() : bridge(TOKENS_ROOT);
  await task.catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}

import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { validInstallationId } from './leaderboard_stats.mjs';

export const TOKEN_MANAGER_ENTRY = 'token_manager.mjs';
export const TOKENS_ROOT = process.env.ORCA_TPS_TOKENS_ROOT || path.join(homedir(), '.orca', 'tpsplugin');
export const TOKENS_RETRY_MS = 3000;
export const TOKENS_HEARTBEAT_MS = 5000;
export const TOKENS_LEASE_MS = 15000;
export const TOKENS_HANDSHAKE_MS = 45_000;
export const MANAGER_PROTOCOL_VERSION = 1;

export const MESSAGE = Object.freeze({
  authenticate: 'authenticate',
  unsubscribe: 'unsubscribe',
  heartbeat: 'heartbeat',
  hello: 'hello',
  ready: 'ready',
  syncHello: 'sync-hello',
  syncReady: 'sync-ready',
  bootstrap: 'bootstrap',
  installed: 'installed',
  channels: 'channels',
  channel: 'channel',
  credential: 'credential',
  devicePersonal: 'device-personal',
  deviceLeaderboard: 'device-leaderboard',
  personal: 'personal',
  progress: 'progress',
  summary: 'summary',
  syncTargets: 'sync-targets',
  intervals: 'intervals',
  uploaded: 'uploaded',
  uploadState: 'upload-state',
  upload: 'upload',
  timezone: 'timezone',
});
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const optionalText = value => value == null || typeof value === 'string';
const accountId = value => Number.isSafeInteger(value) && value > 0;
const devicePacket = message => object(message.packet) && validInstallationId(message.packet.deviceGuid);
const validators = {
  [MESSAGE.authenticate]: message => typeof message.key === 'string',
  [MESSAGE.unsubscribe]: () => true,
  [MESSAGE.heartbeat]: () => true,
  [MESSAGE.hello]: message => optionalText(message.timeZone) && optionalText(message.bundleVersion),
  [MESSAGE.ready]: message => validInstallationId(message.deviceGuid) && optionalText(message.bundleVersion),
  [MESSAGE.syncHello]: message => validInstallationId(message.deviceGuid) && optionalText(message.timeZone),
  [MESSAGE.syncReady]: message => validInstallationId(message.deviceGuid),
  [MESSAGE.bootstrap]: message => typeof message.version === 'string',
  [MESSAGE.installed]: () => true,
  [MESSAGE.channels]: message => Array.isArray(message.channels),
  [MESSAGE.channel]: message => validInstallationId(message.deviceGuid) && typeof message.channelId === 'string' && object(message.result),
  [MESSAGE.credential]: message => message.token === null || (typeof message.token === 'string' && accountId(message.accountId)),
  [MESSAGE.devicePersonal]: devicePacket,
  [MESSAGE.deviceLeaderboard]: devicePacket,
  [MESSAGE.personal]: devicePacket,
  [MESSAGE.progress]: message => Number.isSafeInteger(message.done) && Number.isSafeInteger(message.total),
  [MESSAGE.summary]: message => object(message.summary),
  [MESSAGE.syncTargets]: message => Array.isArray(message.targets),
  [MESSAGE.intervals]: message => object(message.intervals),
  [MESSAGE.uploaded]: message => accountId(message.accountId) && Number.isFinite(message.at),
  [MESSAGE.uploadState]: message => accountId(message.accountId) && typeof message.pending === 'boolean',
  [MESSAGE.upload]: () => true,
  [MESSAGE.timezone]: message => typeof message.timeZone === 'string'
};

export function decodeManagerMessage(line) {
  const message = JSON.parse(line);
  return object(message) && Object.hasOwn(validators, message.type) && validators[message.type](message) ? message : null;
}

// Version-less peers use the original wire format, which version 1 still speaks.
export const compatibleManagerProtocol = message => message.protocolVersion === undefined ||
  message.protocolVersion === MANAGER_PROTOCOL_VERSION;

export function keepManagerLinkAlive(link, now, handshakeMs = TOKENS_LEASE_MS, heartbeatDuringHandshake = false) {
  if (now - link.lastSeen >= (link.ready ? TOKENS_LEASE_MS : handshakeMs)) return false;
  if ((link.ready || heartbeatDuringHandshake) && now >= link.nextHeartbeat && link.child.stdin.writable) {
    link.nextHeartbeat = now + TOKENS_HEARTBEAT_MS;
    link.child.stdin.write(tokensMessage({ type: MESSAGE.heartbeat }));
  }
  return true;
}
export const tokensMessage = message => JSON.stringify(message) + '\n';
const send = (socket, message) => socket && !socket.destroyed && socket.write(tokensMessage(message));

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

export function createOrcaConnection(root, { clock, onHello, onSyncHello, onMessage, onUnsubscribe }) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const secret = localSecret(root);
  const peers = new Map();
  const server = createServer(addPeer);
  let closing = false;

  function addPeer(socket) {
    if (closing) return socket.destroy();
    const peer = { socket, expires: clock() + TOKENS_LEASE_MS, subscribed: false, channels: new Map(), dirty: true };
    peers.set(socket, peer);
    socket.on('error', () => {});
    const reader = createInterface({ input: socket });
    reader.on('line', line => {
      if (closing) return;
      if (line.length > (peer.sync || peer.localClient ? 32 : 4) * 1024 * 1024) return socket.destroy();
      try {
        const message = decodeManagerMessage(line);
        if (!message) return;
        if (!peer.authenticated) {
          const provided = Buffer.from(typeof message.key === 'string' ? message.key : '', 'base64');
          if (message.type !== MESSAGE.authenticate || provided.length !== secret.length || !timingSafeEqual(provided, secret)) {
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
    const { type } = message;
    if (type === MESSAGE.unsubscribe) {
      peers.delete(peer.socket);
      peer.socket.end();
      onUnsubscribe();
      return;
    }
    peer.expires = clock() + TOKENS_LEASE_MS;
    if (type === MESSAGE.syncHello && !peer.subscribed) {
      if (!compatibleManagerProtocol(message) || !onSyncHello?.(peer, message)) return peer.socket.destroy();
      peer.subscribed = peer.sync = true;
      return;
    }
    if (peer.sync) {
      if (type === MESSAGE.heartbeat) return reply(peer, { type: MESSAGE.heartbeat });
      if (type === MESSAGE.devicePersonal || type === MESSAGE.deviceLeaderboard) onMessage(peer, message);
      return;
    }
    if (type === MESSAGE.hello) {
      if (!compatibleManagerProtocol(message) || onHello(peer, message) === false) return peer.socket.destroy();
      peer.subscribed = true;
      return;
    }
    if (!peer.subscribed) return;
    if (type === MESSAGE.heartbeat) return reply(peer, { type: MESSAGE.heartbeat });
    if (type === MESSAGE.channels && Array.isArray(message.channels)) {
      const channels = new Map();
      for (const channel of message.channels.slice(0, 100)) {
        if (typeof channel?.channelId === 'string' && typeof channel.target?.worktreePath === 'string') {
          channels.set(channel.channelId, channel.target);
        }
      }
      peer.channels = channels;
      peer.dirty = true;
      return;
    }
    onMessage(peer, message);
  }

  function reply(peer, message) {
    send(peer.socket, message);
  }

  function broadcast(message, accountId, localClient) {
    for (const peer of peers.values()) {
      if (peer.subscribed && !peer.sync && (accountId === undefined || peer.accountId === accountId) &&
          (localClient === undefined || peer.localClient === localClient)) reply(peer, message);
    }
  }

  function publishChannels(deviceGuid, readChannel, canPublish) {
    const requests = new Map();
    for (const peer of peers.values()) {
      if (!peer.socket || !peer.dirty) continue;
      peer.dirty = false;
      for (const [channelId, target] of peer.channels) {
        const key = JSON.stringify(target);
        if (!requests.has(key)) requests.set(key, readChannel(target));
        void requests.get(key).then(result => {
          if (peer.socket && peer.channels.get(channelId) === target && canPublish()) {
            reply(peer, { type: MESSAGE.channel, deviceGuid, channelId, result });
          }
        }).catch(() => {});
      }
    }
  }

  return {
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketAddress(root), () => { server.removeListener('error', reject); resolve(); });
      }).catch(error => {
        if (error.code !== 'EADDRINUSE') throw error;
      });
      return server.listening;
    },
    reply, broadcast, publishChannels,
    localClients() {
      return [...peers.values()].filter(peer => peer.socket && peer.subscribed && peer.localClient);
    },
    syncStreams() {
      return [...peers.values()].filter(peer => peer.sync && peer.socket).map(peer => peer.socket);
    },
    get hasPeers() { return peers.size > 0; },
    hasAccount(accountId) {
      for (const peer of peers.values()) if (peer.accountId === accountId) return true;
      return false;
    },
    markChannelsDirty() {
      for (const peer of peers.values()) peer.dirty = true;
    },
    expirePeers() {
      const at = clock();
      for (const [socket, peer] of peers) if (peer.expires <= at) { peers.delete(socket); socket.destroy(); }
    },
    disconnect() {
      // Hold the listener as the process lock until the outstanding database write drains.
      closing = true;
      for (const socket of peers.keys()) socket.destroy();
    },
    close() { return new Promise(resolve => server.close(resolve)); }
  };
}

function dial(root) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketAddress(root));
    socket.once('error', reject);
    socket.once('connect', () => { socket.removeListener('error', reject); resolve(socket); });
  });
}

async function connectManager(root, entry) {
  try { return await dial(root); } catch (error) {
    if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
  }
  // A small young generation and a capped old generation make V8 collect scan garbage promptly;
  // the manager keeps only a few MB of live data, so this mainly trims idle memory.
  const child = spawn(process.execPath, ['--max-semi-space-size=4', '--max-old-space-size=384', entry, '--serve'], {
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

export async function bridgeOrca(root, entry) {
  const socket = await connectManager(root, entry);
  socket.on('error', () => { socket.destroy(); });
  process.stdout.on('error', () => { socket.destroy(); });
  socket.pipe(process.stdout, { end: false });
  send(socket, { type: MESSAGE.authenticate, key: localSecret(root).toString('base64') });
  process.stdin.pipe(socket);
  await new Promise(resolve => socket.once('close', resolve));
  process.stdin.destroy();
}

const shellQuote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";

export function launchSsh(destination, token, bootstrap) {
  const { host, port, username, alias, directory } = destination;
  if (typeof host !== 'string' || !/^[a-z\d:][a-z\d.:-]*$/i.test(host) ||
    typeof username !== 'string' || !/^[a-z\d_][a-z\d_.-]*$/i.test(username) ||
    !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ssh');
  const configHost = typeof alias === 'string' && /^[\p{L}\p{N}_][\p{L}\p{N}_.-]*$/u.test(alias) ? alias : host;
  const prefix = '@TPS:' + token + ':';
  const checkNode = "const [major,minor]=process.versions.node.split('.').map(Number);" +
    "if(major<22||(major===22&&minor<13))process.exit(1);require('node:sqlite')";
  // Non-interactive SSH may skip the shell profile that normally adds Node to PATH.
  const script = [
    'cd ' + (directory ? shellQuote(directory) : '"$HOME"') + ' || { echo ' + prefix + 'workspace; exit 1; }',
    'for node in node "$HOME"/.orca-remote/runtimes/node-*/bin/node "$HOME"/.local/share/nodejs/node-*/bin/node "$HOME"/.nvm/versions/node/*/bin/node; do',
    '  if "$node" --input-type=commonjs -e ' + shellQuote(checkNode) + ' >/dev/null 2>&1; then',
    '    exec "$node" ' + '--input-type=module -e ' + shellQuote(bootstrap),
    '  fi',
    'done',
    'echo ' + prefix + 'node'
  ].join('\n');
  const options = ['BatchMode=yes', 'StrictHostKeyChecking=yes', 'UpdateHostKeys=no',
    'ClearAllForwardings=yes', 'ForwardAgent=no', 'ForwardX11=no', 'PermitLocalCommand=no',
    'ControlMaster=no', 'ControlPath=none', 'RemoteCommand=none', 'ConnectTimeout=5', 'ServerAliveInterval=15'];
  let binary = 'ssh', env;
  if (process.platform === 'win32') {
    const SystemRoot = process.env.SystemRoot || 'C:\\Windows';
    binary = path.join(SystemRoot, 'System32', 'OpenSSH', 'ssh.exe');
    // The plugin worker can omit Windows variables OpenSSH needs even with an absolute executable path.
    env = { ...process.env, SystemRoot, USERPROFILE: homedir(),
      ProgramData: process.env.ProgramData || path.join(path.parse(SystemRoot).root, 'ProgramData') };
  }
  return spawn(binary, ['-T', ...options.flatMap(option => ['-o', option]),
    '-o', 'HostName=' + host, '-p', String(port), '-l', username, configHost, 'sh -c ' + shellQuote(script)
  ], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
}

async function runInstalledBridge() {
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const root = join(homedir(), '.orca', 'tpsplugin');
  const { bridgeOrca, TOKEN_MANAGER_ENTRY } = await import(pathToFileURL(join(root, 'bin', 'orca_connection.mjs')).href);
  await bridgeOrca(root, join(root, 'bin', TOKEN_MANAGER_ENTRY));
}

function openSyncPeer(destination) {
  return launchSsh(destination, randomBytes(8).toString('hex'), `await (${runInstalledBridge})();`);
}

// A slow link can finish its current snapshot before the next round sends another.
export function createSnapshotSender(packets) {
  const sending = new WeakMap();
  const published = new WeakMap();
  return async function sendSnapshot(stream) {
    if (!stream?.writable) return;
    const active = sending.get(stream);
    if (active) {
      active.again = true;
      return;
    }
    const state = { again: false };
    const sent = published.get(stream) ?? new Map();
    published.set(stream, sent);
    sending.set(stream, state);
    try {
      do {
        state.again = false;
        for (const message of packets()) {
          if (!stream.writable) return;
          const key = JSON.stringify([message.type, message.packet.deviceGuid, message.packet.accountId]);
          if (sent.get(key) === message.packet) continue;
          sent.set(key, message.packet);
          if (!stream.write(tokensMessage(message))) {
            await once(stream, 'drain', { signal: AbortSignal.timeout(TOKENS_LEASE_MS) });
          }
        }
      } while (state.again);
    } catch {}
    finally { sending.delete(stream); }
  };
}

export function createManagerLinks({ clock, onPacket, sendSnapshot, openPeer = openSyncPeer }) {
  const links = new Map();
  const retries = new Map();

  function closeLink(link, graceful = false) {
    if (links.get(link.key) !== link) return;
    links.delete(link.key);
    if (link.child.exitCode !== null) return;
    if (graceful && link.child.stdin.writable) link.child.stdin.end(tokensMessage({ type: MESSAGE.unsubscribe }));
    else link.child.kill();
  }

  function connectPeer(key, target, hello) {
    let child;
    try { child = openPeer(target); }
    catch { retries.set(key, clock() + TOKENS_RETRY_MS); return; }
    const at = clock();
    const link = { key, child, ready: false, lastSeen: at, nextHeartbeat: at + TOKENS_HEARTBEAT_MS };
    links.set(key, link);
    const disconnect = () => {
      if (links.get(key) !== link) return;
      closeLink(link);
      retries.set(key, clock() + TOKENS_RETRY_MS);
    };
    child.stdin.on('error', disconnect);
    child.once('error', disconnect);
    child.once('exit', disconnect);
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      if (links.get(key) !== link || line.length > 32 * 1024 * 1024) return;
      try {
        const message = decodeManagerMessage(line);
        if (!message) return;
        if (!link.ready) {
          if (message.type !== MESSAGE.syncReady) return;
          if (!compatibleManagerProtocol(message) || message.deviceGuid !== target.deviceGuid) return disconnect();
          link.ready = true;
          void sendSnapshot(child.stdin);
        } else if (message.type === MESSAGE.devicePersonal || message.type === MESSAGE.deviceLeaderboard) onPacket(message);
        link.lastSeen = clock();
      } catch {}
    });
    child.stdin.write(tokensMessage({ type: MESSAGE.syncHello, ...hello, protocolVersion: MANAGER_PROTOCOL_VERSION }));
  }

  return {
    tick(targets, hello) {
      const desired = new Map();
      const devices = new Set();
      for (const target of targets) {
        if (!validInstallationId(target?.deviceGuid) || target.deviceGuid === hello.deviceGuid ||
            devices.has(target.deviceGuid)) continue;
        devices.add(target.deviceGuid);
        desired.set(JSON.stringify([target.deviceGuid, target.host, target.port, target.username, target.alias]), target);
      }
      for (const [key, link] of links) if (!desired.has(key)) closeLink(link, true);
      for (const key of retries.keys()) if (!desired.has(key)) retries.delete(key);
      const now = clock();
      for (const [key, target] of desired) {
        const link = links.get(key);
        if (!link) {
          if ((retries.get(key) ?? 0) <= now) connectPeer(key, target, hello);
        } else if (!keepManagerLinkAlive(link, now, TOKENS_LEASE_MS, true)) {
          closeLink(link);
          retries.set(key, now + TOKENS_RETRY_MS);
        }
      }
    },
    publish() {
      for (const link of links.values()) if (link.ready) void sendSnapshot(link.child.stdin);
    },
    close() {
      for (const link of links.values()) closeLink(link, true);
    }
  };
}

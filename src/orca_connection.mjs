import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

export const TOKEN_MANAGER_ENTRY = 'token_manager.mjs';
export const TOKENS_ROOT = process.env.ORCA_TPS_TOKENS_ROOT || path.join(homedir(), '.orca', 'tpsplugin');
export const TOKENS_RETRY_MS = 3000;
export const TOKENS_HEARTBEAT_MS = 5000;
export const TOKENS_LEASE_MS = 15000;
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

export function createOrcaConnection(root, { clock, onHello, onMessage, onUnsubscribe }) {
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
    const { type } = message;
    if (type === 'unsubscribe') {
      peers.delete(peer.socket);
      peer.socket.end();
      onUnsubscribe();
      return;
    }
    peer.expires = clock() + TOKENS_LEASE_MS;
    if (type === 'hello') {
      onHello(peer, message);
      peer.subscribed = true;
      return;
    }
    if (!peer.subscribed) return;
    if (type === 'heartbeat') return reply(peer, { type: 'heartbeat' });
    if (type === 'channels' && Array.isArray(message.channels)) {
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

  function broadcast(message, accountId) {
    for (const peer of peers.values()) {
      if (peer.subscribed && (accountId === undefined || peer.accountId === accountId)) reply(peer, message);
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
            reply(peer, { type: 'channel', deviceGuid, channelId, result });
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

export async function bridgeOrca(root, entry) {
  const socket = await connectManager(root, entry);
  socket.on('error', () => { socket.destroy(); });
  process.stdout.on('error', () => { socket.destroy(); });
  socket.pipe(process.stdout, { end: false });
  send(socket, { type: 'authenticate', key: localSecret(root).toString('base64') });
  process.stdin.pipe(socket);
  await new Promise(resolve => socket.once('close', resolve));
  process.stdin.destroy();
}

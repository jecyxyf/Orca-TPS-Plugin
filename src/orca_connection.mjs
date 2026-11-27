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
export const TOKENS_RETRY_MS = 3000, TOKENS_HEARTBEAT_MS = 5000, TOKENS_LEASE_MS = 15000, TOKENS_HANDSHAKE_MS = 45_000;
export const MANAGER_PROTOCOL_VERSION = 1;

export const MESSAGE = Object.freeze({
  authenticate: 'authenticate', unsubscribe: 'unsubscribe', heartbeat: 'heartbeat', hello: 'hello', ready: 'ready',
  syncHello: 'sync-hello', syncReady: 'sync-ready', bootstrap: 'bootstrap', installed: 'installed',
  channels: 'channels', channel: 'channel', credential: 'credential', devicePersonal: 'device-personal',
  deviceLeaderboard: 'device-leaderboard', personal: 'personal', progress: 'progress', summary: 'summary',
  syncTargets: 'sync-targets', intervals: 'intervals', uploaded: 'uploaded', uploadState: 'upload-state',
  upload: 'upload', timezone: 'timezone'
});

const obj = v => v && typeof v === 'object' && !Array.isArray(v);
const optText = v => v == null || typeof v === 'string';
const acctId = v => Number.isSafeInteger(v) && v > 0;
const devPkt = m => obj(m.packet) && validInstallationId(m.packet.deviceGuid);
const validators = {
  authenticate: m => typeof m.key === 'string', unsubscribe: () => true, heartbeat: () => true,
  hello: m => optText(m.timeZone) && optText(m.bundleVersion), ready: m => validInstallationId(m.deviceGuid) && optText(m.bundleVersion),
  'sync-hello': m => validInstallationId(m.deviceGuid) && optText(m.timeZone), 'sync-ready': m => validInstallationId(m.deviceGuid),
  bootstrap: m => typeof m.version === 'string', installed: () => true, channels: m => Array.isArray(m.channels),
  channel: m => validInstallationId(m.deviceGuid) && typeof m.channelId === 'string' && obj(m.result),
  credential: m => m.token === null || (typeof m.token === 'string' && acctId(m.accountId)),
  'device-personal': devPkt, 'device-leaderboard': devPkt, personal: devPkt,
  progress: m => Number.isSafeInteger(m.done) && Number.isSafeInteger(m.total), summary: m => obj(m.summary),
  'sync-targets': m => Array.isArray(m.targets), intervals: m => obj(m.intervals),
  uploaded: m => acctId(m.accountId) && Number.isFinite(m.at), 'upload-state': m => acctId(m.accountId) && typeof m.pending === 'boolean',
  upload: () => true, timezone: m => typeof m.timeZone === 'string'
};

export function decodeManagerMessage(line) {
  const m = JSON.parse(line);
  return obj(m) && Object.hasOwn(validators, m.type) && validators[m.type](m) ? m : null;
}
export const compatibleManagerProtocol = m => m.protocolVersion === undefined || m.protocolVersion === MANAGER_PROTOCOL_VERSION;
export const tokensMessage = message => JSON.stringify(message) + '\n';
const send = (socket, message) => socket && !socket.destroyed && socket.write(tokensMessage(message));

export function keepManagerLinkAlive(link, now, handshakeMs = TOKENS_LEASE_MS, duringHandshake = false) {
  if (now - link.lastSeen >= (link.ready ? TOKENS_LEASE_MS : handshakeMs)) return false;
  if ((link.ready || duringHandshake) && now >= link.nextHeartbeat && link.child.stdin.writable) {
    link.nextHeartbeat = now + TOKENS_HEARTBEAT_MS;
    link.child.stdin.write(tokensMessage({ type: MESSAGE.heartbeat }));
  }
  return true;
}

function socketAddress(root) {
  const key = createHash('sha256').update(root).digest('hex').slice(0, 32);
  return process.platform === 'win32' ? '\\\\.\\pipe\\orca-tps-' + key : process.platform === 'linux' ? '\0orca-tps-' + key : path.join(root, 'tokens-manager.sock');
}

function localSecret(root) {
  const file = path.join(root, 'socket-key');
  try { writeFileSync(file, randomBytes(32), { flag: 'wx', mode: 0o600 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const secret = readFileSync(file);
  if (secret.length !== 32) throw new Error('Invalid Tokens manager socket key');
  return secret;
}

export function createOrcaConnection(root, { clock, onHello, onSyncHello, onMessage, onUnsubscribe }) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const secret = localSecret(root), peers = new Map();
  let closing = false;
  const reply = (peer, message) => send(peer.socket, message);

  function receive(peer, message) {
    const { type } = message;
    if (type === MESSAGE.unsubscribe) { peers.delete(peer.socket); peer.socket.end(); onUnsubscribe(); return; }
    peer.expires = clock() + TOKENS_LEASE_MS;
    if (type === MESSAGE.syncHello && !peer.subscribed) {
      if (!compatibleManagerProtocol(message) || !onSyncHello?.(peer, message)) return peer.socket.destroy();
      peer.subscribed = peer.sync = true; return;
    }
    if (peer.sync) {
      if (type === MESSAGE.heartbeat) return reply(peer, { type: MESSAGE.heartbeat });
      if (type === MESSAGE.devicePersonal || type === MESSAGE.deviceLeaderboard) onMessage(peer, message);
      return;
    }
    if (type === MESSAGE.hello) {
      if (!compatibleManagerProtocol(message) || onHello(peer, message) === false) return peer.socket.destroy();
      peer.subscribed = true; return;
    }
    if (!peer.subscribed) return;
    if (type === MESSAGE.heartbeat) return reply(peer, { type: MESSAGE.heartbeat });
    if (type === MESSAGE.channels && Array.isArray(message.channels)) {
      const channels = new Map();
      for (const ch of message.channels.slice(0, 100)) if (typeof ch?.channelId === 'string' && typeof ch.target?.worktreePath === 'string') channels.set(ch.channelId, ch.target);
      peer.channels = channels; peer.dirty = true; return;
    }
    onMessage(peer, message);
  }

  const server = createServer(socket => {
    if (closing) return socket.destroy();
    const peer = { socket, expires: clock() + TOKENS_LEASE_MS, subscribed: false, channels: new Map(), dirty: true };
    peers.set(socket, peer);
    socket.on('error', () => {});
    socket.on('close', () => { peer.socket = null; });
    createInterface({ input: socket }).on('line', line => {
      if (closing) return;
      if (line.length > (peer.sync || peer.localClient ? 32 : 4) * 1024 * 1024) return socket.destroy();
      try {
        const msg = decodeManagerMessage(line);
        if (!msg) return;
        if (!peer.authenticated) {
          const provided = Buffer.from(typeof msg.key === 'string' ? msg.key : '', 'base64');
          if (msg.type !== MESSAGE.authenticate || provided.length !== secret.length || !timingSafeEqual(provided, secret)) return socket.destroy();
          peer.authenticated = true; return;
        }
        receive(peer, msg);
      } catch {}
    });
  });

  return {
    async listen() {
      await new Promise((res, rej) => { server.once('error', rej); server.listen(socketAddress(root), () => { server.removeListener('error', rej); res(); }); })
        .catch(e => { if (e.code !== 'EADDRINUSE') throw e; });
      return server.listening;
    },
    reply,
    broadcast(message, accountId, localClient) {
      for (const peer of peers.values()) {
        if (peer.subscribed && !peer.sync && (accountId === undefined || peer.accountId === accountId) && (localClient === undefined || peer.localClient === localClient)) reply(peer, message);
      }
    },
    publishChannels(deviceGuid, readChannel, canPublish) {
      const requests = new Map();
      for (const peer of peers.values()) {
        if (!peer.socket || !peer.dirty) continue;
        peer.dirty = false;
        for (const [channelId, target] of peer.channels) {
          const key = JSON.stringify(target);
          if (!requests.has(key)) requests.set(key, readChannel(target));
          void requests.get(key).then(result => {
            if (peer.socket && peer.channels.get(channelId) === target && canPublish()) reply(peer, { type: MESSAGE.channel, deviceGuid, channelId, result });
          }).catch(() => {});
        }
      }
    },
    localClients: () => [...peers.values()].filter(p => p.socket && p.subscribed && p.localClient),
    syncStreams: () => [...peers.values()].filter(p => p.sync && p.socket).map(p => p.socket),
    get hasPeers() { return peers.size > 0; },
    hasAccount: id => [...peers.values()].some(p => p.accountId === id),
    markChannelsDirty() { for (const p of peers.values()) p.dirty = true; },
    expirePeers() { const at = clock(); for (const [s, p] of peers) if (p.expires <= at) { peers.delete(s); s.destroy(); } },
    disconnect() { closing = true; for (const s of peers.keys()) s.destroy(); },
    close: () => new Promise(resolve => server.close(resolve))
  };
}

const dial = root => new Promise((res, rej) => {
  const s = connect(socketAddress(root));
  s.once('error', rej); s.once('connect', () => { s.removeListener('error', rej); res(s); });
});

async function connectManager(root, entry) {
  try { return await dial(root); } catch (e) { if (!['ENOENT', 'ECONNREFUSED'].includes(e.code)) throw e; }
  // Small young generation trims idle memory; old generation stays uncapped so large log scans never OOM.
  const child = spawn(process.execPath, ['--max-semi-space-size=4', entry, '--serve'], {
    detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ORCA_TPS_TOKENS_ROOT: root }
  });
  child.on('error', () => {});
  child.unref();
  for (let i = 0; i < 25; i++) { await delay(100); try { return await dial(root); } catch {} }
  throw new Error('Tokens manager startup timed out');
}

export async function bridgeOrca(root, entry) {
  const socket = await connectManager(root, entry);
  socket.on('error', () => socket.destroy());
  process.stdout.on('error', () => socket.destroy());
  socket.pipe(process.stdout, { end: false });
  send(socket, { type: MESSAGE.authenticate, key: localSecret(root).toString('base64') });
  process.stdin.pipe(socket);
  await new Promise(resolve => socket.once('close', resolve));
  process.stdin.destroy();
}

const shellQuote = v => "'" + v.replaceAll("'", "'\"'\"'") + "'";

export function launchSsh(destination, token, bootstrap) {
  const { host, port, username, alias, directory } = destination;
  if (typeof host !== 'string' || !/^[a-z\d:][a-z\d.:-]*$/i.test(host) ||
      typeof username !== 'string' || !/^[a-z\d_][a-z\d_.-]*$/i.test(username) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ssh');
  const configHost = typeof alias === 'string' && /^[\p{L}\p{N}_][\p{L}\p{N}_.-]*$/u.test(alias) ? alias : host;
  const prefix = '@TPS:' + token + ':';
  const checkNode = "const [major,minor]=process.versions.node.split('.').map(Number);if(major<22||(major===22&&minor<13))process.exit(1);require('node:sqlite')";
  const script = [
    'cd ' + (directory ? shellQuote(directory) : '"$HOME"') + ' || { echo ' + prefix + 'workspace; exit 1; }',
    'for node in node "$HOME"/.orca-remote/runtimes/node-*/bin/node "$HOME"/.local/share/nodejs/node-*/bin/node "$HOME"/.nvm/versions/node/*/bin/node; do',
    '  if "$node" --input-type=commonjs -e ' + shellQuote(checkNode) + ' >/dev/null 2>&1; then',
    '    exec "$node" --input-type=module -e ' + shellQuote(bootstrap), '  fi', 'done', 'echo ' + prefix + 'node'
  ].join('\n');
  const opts = ['BatchMode=yes', 'StrictHostKeyChecking=yes', 'UpdateHostKeys=no', 'ClearAllForwardings=yes',
    'ForwardAgent=no', 'ForwardX11=no', 'PermitLocalCommand=no', 'ControlMaster=no', 'ControlPath=none', 'RemoteCommand=none', 'ConnectTimeout=5', 'ServerAliveInterval=15'];
  let binary = 'ssh', env;
  if (process.platform === 'win32') {
    const SystemRoot = process.env.SystemRoot || 'C:\\Windows';
    binary = path.join(SystemRoot, 'System32', 'OpenSSH', 'ssh.exe');
    env = { ...process.env, SystemRoot, USERPROFILE: homedir(), ProgramData: process.env.ProgramData || path.join(path.parse(SystemRoot).root, 'ProgramData') };
  }
  return spawn(binary, ['-T', ...opts.flatMap(o => ['-o', o]), '-o', 'HostName=' + host, '-p', String(port), '-l', username, configHost, 'sh -c ' + shellQuote(script)],
    { env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
}

async function runInstalledBridge() {
  const { homedir } = await import('node:os'), { join } = await import('node:path'), { pathToFileURL } = await import('node:url');
  const root = join(homedir(), '.orca', 'tpsplugin');
  const { bridgeOrca, TOKEN_MANAGER_ENTRY } = await import(pathToFileURL(join(root, 'bin', 'orca_connection.mjs')).href);
  await bridgeOrca(root, join(root, 'bin', TOKEN_MANAGER_ENTRY));
}
const openSyncPeer = dest => launchSsh(dest, randomBytes(8).toString('hex'), `await (${runInstalledBridge})();`);

export function createSnapshotSender(packets) {
  const sending = new WeakMap(), published = new WeakMap();
  return async function sendSnapshot(stream) {
    if (!stream?.writable) return;
    const active = sending.get(stream);
    if (active) { active.again = true; return; }
    const state = { again: false }, sent = published.get(stream) ?? new Map();
    published.set(stream, sent); sending.set(stream, state);
    try {
      do {
        state.again = false;
        for (const msg of packets()) {
          if (!stream.writable) return;
          const key = JSON.stringify([msg.type, msg.packet.deviceGuid, msg.packet.accountId]);
          if (sent.get(key) === msg.packet) continue;
          sent.set(key, msg.packet);
          if (!stream.write(tokensMessage(msg))) await once(stream, 'drain', { signal: AbortSignal.timeout(TOKENS_LEASE_MS) });
        }
      } while (state.again);
    } catch {} finally { sending.delete(stream); }
  };
}

export function createManagerLinks({ clock, onPacket, sendSnapshot, openPeer = openSyncPeer }) {
  const links = new Map(), retries = new Map();
  function closeLink(link, graceful = false) {
    if (links.get(link.key) !== link) return;
    links.delete(link.key);
    if (link.child.exitCode !== null) return;
    if (graceful && link.child.stdin.writable) link.child.stdin.end(tokensMessage({ type: MESSAGE.unsubscribe }));
    else link.child.kill();
  }
  function connectPeer(key, target, hello) {
    let child;
    try { child = openPeer(target); } catch { retries.set(key, clock() + TOKENS_RETRY_MS); return; }
    const at = clock(), link = { key, child, ready: false, lastSeen: at, nextHeartbeat: at + TOKENS_HEARTBEAT_MS };
    links.set(key, link);
    const disconnect = () => { if (links.get(key) === link) { closeLink(link); retries.set(key, clock() + TOKENS_RETRY_MS); } };
    child.stdin.on('error', disconnect); child.once('error', disconnect); child.once('exit', disconnect);
    createInterface({ input: child.stdout }).on('line', line => {
      if (links.get(key) !== link || line.length > 32 * 1024 * 1024) return;
      try {
        const msg = decodeManagerMessage(line);
        if (!msg) return;
        if (!link.ready) {
          if (msg.type !== MESSAGE.syncReady) return;
          if (!compatibleManagerProtocol(msg) || msg.deviceGuid !== target.deviceGuid) return disconnect();
          link.ready = true; void sendSnapshot(child.stdin);
        } else if (msg.type === MESSAGE.devicePersonal || msg.type === MESSAGE.deviceLeaderboard) onPacket(msg);
        link.lastSeen = clock();
      } catch {}
    });
    child.stdin.write(tokensMessage({ type: MESSAGE.syncHello, ...hello, protocolVersion: MANAGER_PROTOCOL_VERSION }));
  }
  return {
    tick(targets, hello) {
      const desired = new Map(), devices = new Set();
      for (const t of targets) {
        if (!validInstallationId(t?.deviceGuid) || t.deviceGuid === hello.deviceGuid || devices.has(t.deviceGuid)) continue;
        devices.add(t.deviceGuid);
        desired.set(JSON.stringify([t.deviceGuid, t.host, t.port, t.username, t.alias]), t);
      }
      for (const [k, l] of links) if (!desired.has(k)) closeLink(l, true);
      for (const k of retries.keys()) if (!desired.has(k)) retries.delete(k);
      const now = clock();
      for (const [k, t] of desired) {
        const l = links.get(k);
        if (!l) { if ((retries.get(k) ?? 0) <= now) connectPeer(k, t, hello); }
        else if (!keepManagerLinkAlive(l, now, TOKENS_LEASE_MS, true)) { closeLink(l); retries.set(k, now + TOKENS_RETRY_MS); }
      }
    },
    publish() { for (const l of links.values()) if (l.ready) void sendSnapshot(l.child.stdin); },
    close() { for (const l of links.values()) closeLink(l, true); }
  };
}

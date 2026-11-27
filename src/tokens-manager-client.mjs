import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { publicChannelId } from './controller.mjs';
import { keepLatest, validPersonal } from './database.mjs';
import { tokensIntervals } from './leaderboard_stats.mjs';
import { createRuntimeLookup, launchSsh } from './remote-channel.mjs';
import { compatibleManagerProtocol, decodeManagerMessage, keepManagerLinkAlive, MANAGER_PROTOCOL_VERSION, MESSAGE,
  TOKEN_MANAGER_ENTRY, TOKENS_HANDSHAKE_MS, TOKENS_HEARTBEAT_MS, TOKENS_RETRY_MS, TOKENS_ROOT, tokensMessage } from './orca_connection.mjs';
import { calendarFor } from './personal_stats.mjs';

const localHost = '', timezoneKey = 'tokens-manager:timezone';
const managerFiles = [
  'database.mjs', 'harness_collectors.mjs', 'harness_formats.mjs', 'harness_parser.mjs', 'harnesses.mjs',
  'leaderboard_stats.mjs', 'orca_connection.mjs', 'personal_stats.mjs', 'sqlite.mjs', TOKEN_MANAGER_ENTRY
];

async function installedManagerVersion(root, names) {
  const { lstat, readFile, readdir } = await import('node:fs/promises'), { join } = await import('node:path');
  const bin = join(root, 'bin');
  try {
    if (!(await lstat(bin)).isDirectory()) return '';
    const entries = await readdir(bin, { withFileTypes: true });
    if (entries.length !== names.length || entries.some(e => !e.isFile() || !names.includes(e.name))) return '';
    return await readFile(join(root, 'bundle-version'), 'utf8');
  } catch (e) { if (e.code === 'ENOENT') return ''; throw e; }
}

async function installManagerFiles(root, payload, names, versionOf) {
  const { lstat, mkdir, readdir, realpath, rename, rm, writeFile } = await import('node:fs/promises');
  const { dirname, join } = await import('node:path'), { randomUUID } = await import('node:crypto');
  const files = Object.entries(payload.files ?? {});
  if (!/^[a-f0-9]{64}$/.test(payload.version) || files.length !== names.length || files.some(([n, d]) => !names.includes(n) || typeof d !== 'string')) {
    throw new Error('Invalid manager bundle');
  }
  const directory = join(root, 'bin');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new Error('Invalid manager bin directory');
  const parent = await realpath(root), bin = await realpath(directory);
  if (bin !== join(parent, 'bin')) throw new Error('Invalid manager bin directory');
  if (await versionOf(parent, names) === payload.version) return;
  const put = async (filename, bytes) => {
    const next = join(parent, '.bundle-' + randomUUID() + '.next');
    await writeFile(next, bytes, { flag: 'wx', mode: 0o600 });
    try { await rename(next, filename); } finally { await rm(next, { force: true }); }
  };
  for (const entry of await readdir(bin, { withFileTypes: true })) {
    if (entry.isFile() && names.includes(entry.name)) continue;
    const obsolete = join(bin, entry.name);
    if (entry.isDirectory() && dirname(await realpath(obsolete)) !== bin) throw new Error('Invalid manager cleanup path');
    await rm(obsolete, { force: true, recursive: entry.isDirectory() });
  }
  for (const [name, bytes] of files) await put(join(bin, name), Buffer.from(bytes, 'base64'));
  await put(join(parent, 'bundle-version'), payload.version);
}

export const installTokensManagerBundle = (root, payload) => installManagerFiles(root, payload, managerFiles, installedManagerVersion);

export async function readTokensManagerBundle() {
  const files = {}, source = new URL('./', import.meta.url);
  for (const name of managerFiles) files[name] = (await readFile(new URL(name, source))).toString('base64');
  return { files, version: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
}

async function remoteBootstrap(install, versionOf, names, entry, messageTypes) {
  const { createInterface } = await import('node:readline'), { homedir } = await import('node:os');
  const { join } = await import('node:path'), { spawn } = await import('node:child_process');
  const root = join(homedir(), '.orca', 'tpsplugin'), version = await versionOf(root, names);
  const reader = createInterface({ input: process.stdin });
  const request = new Promise((resolve, reject) => {
    reader.once('line', line => { reader.close(); process.stdin.pause(); resolve(JSON.parse(line)); });
    reader.once('close', () => queueMicrotask(() => reject(new Error('Manager installation cancelled'))));
  });
  console.log(JSON.stringify({ type: messageTypes.bootstrap, version }));
  const payload = await request;
  if (payload.version !== version) await install(root, payload, names, versionOf);
  const child = spawn(process.execPath, [join(root, 'bin', entry), '--connect'],
    { stdio: ['pipe', 'inherit', 'inherit'], env: { ...process.env, ORCA_TPS_TOKENS_ROOT: root } });
  process.stdin.pipe(child.stdin); child.stdin.on('error', () => {});
  console.log(JSON.stringify({ type: messageTypes.installed }));
  await new Promise(resolve => child.once('exit', resolve));
  process.stdin.destroy();
}

export const tokensManagerBootstrap = `await (${remoteBootstrap})(${installManagerFiles}, ${installedManagerVersion}, ${JSON.stringify(managerFiles)}, ${JSON.stringify(TOKEN_MANAGER_ENTRY)}, ${JSON.stringify(MESSAGE)});`;

const localBridge = root => spawn(process.execPath, [path.join(root, 'bin', TOKEN_MANAGER_ENTRY), '--connect'], {
  stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ORCA_TPS_TOKENS_ROOT: root }
});

export async function createTokensManagerClient(orca, {
  endpoint, deviceGuid, initialZone, root = TOKENS_ROOT, resolveRuntime = createRuntimeLookup(orca), onChange = () => {}, onUploaded = () => {}
} = {}) {
  const controller = new AbortController(), pendingRemote = new Map(), connections = new Map(), hostTargets = new Map([[localHost, []]]), uploadListeners = new Set();
  let timeZone = calendarFor((await orca.storage.get(timezoneKey).catch(() => undefined)) || undefined).timeZone;
  if (initialZone !== undefined) try { timeZone = calendarFor(initialZone || undefined).timeZone; } catch {}
  let credentials, stopped = false, intervals = tokensIntervals(), progress = null, personalSummary, lastUploadedAt = null, uploadStatus;
  const bundle = readTokensManagerBundle();
  const summary = () => personalSummary?.timeZone === timeZone ? personalSummary : (progress ? { updatedAt: null, timeZone, progress } : null);
  const notifyUploadState = () => { for (const listener of uploadListeners) listener(); };
  const send = (conn, msg) => { if (!conn.child?.stdin.destroyed && conn.child?.stdin.writable) conn.child.stdin.write(tokensMessage(msg)); };

  function sendChannels(conn) {
    if (!conn.ready) return;
    const channels = (hostTargets.get(conn.host) ?? []).map(target => ({ channelId: publicChannelId(target), target })), sig = JSON.stringify(channels);
    if (sig !== conn.channelSignature) { conn.channelSignature = sig; send(conn, { type: MESSAGE.channels, channels }); }
  }
  const sendCredential = conn => { if (conn.ready && credentials) send(conn, { type: MESSAGE.credential, endpoint, ...credentials }); };
  function sendSyncTargets() {
    const local = connections.get(localHost);
    if (!local?.ready) return;
    const targets = [...connections.values()].flatMap(c => c.host !== localHost && c.ready && c.destination ? [{ ...c.destination, deviceGuid: c.deviceGuid }] : []);
    const sig = JSON.stringify(targets);
    if (sig !== local.syncSignature) { local.syncSignature = sig; send(local, { type: MESSAGE.syncTargets, targets }); }
  }

  function handle(conn, event, payload) {
    conn.lastSeen = Date.now();
    switch (event.type) {
      case MESSAGE.bootstrap: send(conn, event.version === payload.version ? { version: payload.version } : payload); break;
      case MESSAGE.installed: send(conn, { type: MESSAGE.hello, endpoint, timeZone, bundleVersion: payload.version, protocolVersion: MANAGER_PROTOCOL_VERSION }); break;
      case MESSAGE.ready:
        if (!compatibleManagerProtocol(event) || event.bundleVersion !== payload.version) return disconnect(conn, true);
        conn.ready = true; conn.deviceGuid = event.deviceGuid; intervals = tokensIntervals(event.intervals, intervals);
        sendChannels(conn); sendCredential(conn); sendSyncTargets();
        if (conn.host === localHost) { for (const p of pendingRemote.values()) send(conn, { type: MESSAGE.devicePersonal, packet: p }); pendingRemote.clear(); }
        break;
      case MESSAGE.intervals: intervals = tokensIntervals(event.intervals, intervals); break;
      case MESSAGE.progress: progress = { done: event.done, total: event.total }; if (!summary()?.updatedAt) onChange(summary()); break;
      case MESSAGE.personal: {
        const packet = event.packet;
        if (conn.host === localHost || !validPersonal(packet) || packet.deviceGuid !== conn.deviceGuid) return;
        const local = connections.get(localHost);
        if (local?.ready) send(local, { type: MESSAGE.devicePersonal, packet });
        else keepLatest(pendingRemote, packet.deviceGuid, packet);
        break;
      }
      case MESSAGE.summary: if (conn.host === localHost) { personalSummary = event.summary; onChange(summary()); } break;
      case MESSAGE.channel: if (event.deviceGuid === conn.deviceGuid && typeof event.channelId === 'string') conn.channels.set(event.channelId, event.result); break;
      case MESSAGE.uploaded: if (conn === connections.get(localHost) && event.accountId === credentials?.accountId) { lastUploadedAt = event.at; onUploaded(event.at); notifyUploadState(); } break;
      case MESSAGE.uploadState: if (conn === connections.get(localHost) && event.accountId === credentials?.accountId) { uploadStatus = event; notifyUploadState(); } break;
    }
  }

  async function open(conn) {
    const payload = await bundle;
    let child;
    if (conn.host === localHost) {
      await installTokensManagerBundle(root, payload);
      if (stopped || connections.get(conn.host) !== conn) return;
      child = localBridge(root);
    } else {
      const [target] = hostTargets.get(conn.host) ?? [];
      if (!target || !orca.grantedCapabilities?.includes('workspace:read')) throw new Error('Remote project unavailable');
      const { host, port, username, alias } = await resolveRuntime(target, AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]));
      if (stopped || connections.get(conn.host) !== conn) return;
      conn.destination = { host, port, username, alias };
      child = launchSsh(conn.destination, randomBytes(8).toString('hex'), tokensManagerBootstrap);
    }
    conn.child = child; conn.lastSeen = Date.now();
    child.stdin.on('error', () => child.kill()); child.on('error', () => disconnect(conn)); child.once('exit', () => disconnect(conn));
    createInterface({ input: child.stdout }).on('line', line => { try { const ev = decodeManagerMessage(line); if (ev) handle(conn, ev, payload); } catch {} });
    if (conn.host === localHost) send(conn, { type: MESSAGE.hello, endpoint, timeZone, deviceGuid, local: true, bundleVersion: payload.version, protocolVersion: MANAGER_PROTOCOL_VERSION });
  }

  function disconnect(conn, graceful = false) {
    if (connections.get(conn.host) !== conn) return;
    connections.delete(conn.host);
    if (conn.host === localHost && uploadStatus?.pending) { uploadStatus = undefined; notifyUploadState(); }
    sendSyncTargets();
    if (conn.child?.exitCode === null) {
      if (graceful && conn.child.stdin.writable) conn.child.stdin.end(tokensMessage({ type: MESSAGE.unsubscribe }));
      else conn.child.kill();
    }
    if (!stopped && hostTargets.has(conn.host)) connections.set(conn.host, { host: conn.host, retryAt: Date.now() + TOKENS_RETRY_MS });
  }

  function tick() {
    const now = Date.now();
    for (const [host] of hostTargets) {
      const existing = connections.get(host);
      if (!existing || existing.retryAt <= now) {
        const conn = { host, channels: new Map(), lastSeen: now, nextHeartbeat: now + TOKENS_HEARTBEAT_MS };
        connections.set(host, conn);
        void open(conn).catch(() => disconnect(conn));
      } else if (existing.child && !keepManagerLinkAlive(existing, now, TOKENS_HANDSHAKE_MS)) disconnect(existing);
    }
  }

  function remove(conn) {
    if (!conn) return;
    if (conn.ready) send(conn, { type: MESSAGE.unsubscribe });
    conn.child?.stdin.end();
    connections.delete(conn.host);
    if (!stopped) sendSyncTargets();
  }

  const timer = setInterval(tick, 250);
  timer.unref?.();
  tick();
  return {
    summary, intervals: () => intervals, lastUploaded: () => lastUploadedAt, uploadStatus: () => uploadStatus,
    onUploadState(listener) { uploadListeners.add(listener); return () => uploadListeners.delete(listener); },
    setTargets(targets) {
      const next = new Map([[localHost, []]]);
      for (const target of targets) { const h = target.executionHostId || localHost; (next.get(h) ?? next.set(h, []).get(h)).push(target); }
      for (const h of hostTargets.keys()) if (!next.has(h)) remove(connections.get(h));
      hostTargets.clear();
      for (const [h, entries] of next) hostTargets.set(h, entries);
      for (const conn of connections.values()) sendChannels(conn);
      tick();
    },
    read: target => connections.get(target.executionHostId || localHost)?.channels?.get(publicChannelId(target)) ?? { session: null, warnings: [] },
    setCredential(value) {
      if (credentials?.accountId !== value.accountId || !value.token) { lastUploadedAt = null; uploadStatus = undefined; }
      credentials = value;
      for (const conn of connections.values()) sendCredential(conn);
    },
    upload() { const local = connections.get(localHost); if (local?.ready) send(local, { type: MESSAGE.upload }); return Boolean(local?.ready); },
    async setTimeZone(zone) {
      const next = calendarFor(zone || undefined).timeZone;
      if (timeZone === next) return { timeZone };
      timeZone = next;
      await orca.storage.set(timezoneKey, timeZone);
      for (const conn of connections.values()) if (conn.ready) send(conn, { type: MESSAGE.timezone, timeZone });
      onChange(summary());
      return { timeZone };
    },
    async close() { stopped = true; clearInterval(timer); controller.abort(); uploadListeners.clear(); for (const c of connections.values()) remove(c); }
  };
}

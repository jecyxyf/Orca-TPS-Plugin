import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { publicChannelId } from './controller.mjs';
import { keepLatest, validPersonal } from './database.mjs';
import { tokensIntervals, validInstallationId } from './leaderboard_stats.mjs';
import { createRuntimeLookup, launchSsh } from './remote-channel.mjs';
import { TOKEN_MANAGER_ENTRY, TOKENS_HEARTBEAT_MS, TOKENS_LEASE_MS, TOKENS_RETRY_MS, TOKENS_ROOT, tokensMessage } from './orca_connection.mjs';
import { calendarFor, mergePersonalPackets } from './personal_stats.mjs';

const localHost = '';
const timezoneKey = 'tokens-manager:timezone';
const managerFiles = [
  'database.mjs', 'harness_parser.mjs', 'leaderboard_stats.mjs', 'orca_connection.mjs', 'personal_stats.mjs', TOKEN_MANAGER_ENTRY
];

async function installedManagerVersion(root, names) {
  const { lstat, readFile, readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const bin = join(root, 'bin');
  try {
    if (!(await lstat(bin)).isDirectory()) return '';
    const entries = await readdir(bin, { withFileTypes: true });
    if (entries.length !== names.length || entries.some(entry => !entry.isFile() || !names.includes(entry.name))) return '';
    return await readFile(join(root, 'bundle-version'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

async function installManagerFiles(root, payload, names, versionOf) {
  const { lstat, mkdir, readdir, realpath, rename, rm, writeFile } = await import('node:fs/promises');
  const { dirname, join } = await import('node:path');
  const { randomUUID } = await import('node:crypto');
  const files = Object.entries(payload.files ?? {});
  if (!/^[a-f0-9]{64}$/.test(payload.version) || files.length !== names.length ||
      files.some(([name, data]) => !names.includes(name) || typeof data !== 'string')) {
    throw new Error('Invalid manager bundle');
  }
  const directory = join(root, 'bin');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new Error('Invalid manager bin directory');
  const parent = await realpath(root);
  const bin = await realpath(directory);
  if (bin !== join(parent, 'bin')) throw new Error('Invalid manager bin directory');
  if (await versionOf(parent, names) === payload.version) return;

  // Replace modules atomically and stamp the completed installation last.
  async function put(filename, bytes) {
    const next = join(parent, '.bundle-' + randomUUID() + '.next');
    await writeFile(next, bytes, { flag: 'wx', mode: 0o600 });
    try { await rename(next, filename); }
    finally { await rm(next, { force: true }); }
  }
  for (const entry of await readdir(bin, { withFileTypes: true })) {
    if (entry.isFile() && names.includes(entry.name)) continue;
    const obsolete = join(bin, entry.name);
    if (entry.isDirectory() && dirname(await realpath(obsolete)) !== bin) throw new Error('Invalid manager cleanup path');
    await rm(obsolete, { force: true, recursive: entry.isDirectory() });
  }
  for (const [name, bytes] of files) {
    await put(join(bin, name), Buffer.from(bytes, 'base64'));
  }
  await put(join(parent, 'bundle-version'), payload.version);
}

export function installTokensManagerBundle(root, payload) {
  return installManagerFiles(root, payload, managerFiles, installedManagerVersion);
}

export async function readTokensManagerBundle() {
  const files = {};
  const source = new URL('./', import.meta.url);
  for (const name of managerFiles) files[name] = (await readFile(new URL(name, source))).toString('base64');
  const version = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  return { files, version };
}

async function remoteBootstrap(install, versionOf, names, entry) {
  const { createInterface } = await import('node:readline');
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawn } = await import('node:child_process');
  const root = join(homedir(), '.orca', 'tpsplugin');
  const version = await versionOf(root, names);
  const reader = createInterface({ input: process.stdin });
  const request = new Promise((resolve, reject) => {
    reader.once('line', line => { reader.close(); process.stdin.pause(); resolve(JSON.parse(line)); });
    reader.once('close', () => queueMicrotask(() => reject(new Error('Manager installation cancelled'))));
  });
  console.log(JSON.stringify({ type: 'bootstrap', version }));
  const payload = await request;
  if (payload.version !== version) await install(root, payload, names, versionOf);
  const child = spawn(process.execPath, [join(root, 'bin', entry), '--connect'],
    { stdio: ['pipe', 'inherit', 'inherit'], env: { ...process.env, ORCA_TPS_TOKENS_ROOT: root } });
  process.stdin.pipe(child.stdin);
  child.stdin.on('error', () => {});
  console.log(JSON.stringify({ type: 'installed' }));
  await new Promise(resolve => child.once('exit', resolve));
  process.stdin.destroy();
}

export const tokensManagerBootstrap = `await (${remoteBootstrap})(${installManagerFiles}, ${installedManagerVersion}, ${JSON.stringify(managerFiles)}, ${JSON.stringify(TOKEN_MANAGER_ENTRY)});`;

function localBridge(root) {
  return spawn(process.execPath, [path.join(root, 'bin', TOKEN_MANAGER_ENTRY), '--connect'], {
    stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ORCA_TPS_TOKENS_ROOT: root }
  });
}

export async function createTokensManagerClient(orca, {
  endpoint, deviceGuid, initialZone, root = TOKENS_ROOT, resolveRuntime = createRuntimeLookup(orca), onChange = () => {}, onUploaded = () => {}
} = {}) {
  const controller = new AbortController();
  const personal = new Map(), connections = new Map(), hostTargets = new Map([[localHost, []]]);
  const uploadStateListeners = new Set();
  const storedZone = await orca.storage.get(timezoneKey).catch(() => undefined);
  let timeZone = calendarFor(storedZone || undefined).timeZone, credentials, stopped = false;
  if (initialZone !== undefined) {
    try { timeZone = calendarFor(initialZone || undefined).timeZone; } catch {}
  }
  let intervals = tokensIntervals(), progress = null, lastUploadedAt = null, uploadStatus;
  const bundle = readTokensManagerBundle();

  const summary = () => mergePersonalPackets(personal.values(), timeZone) ?? (progress
    ? { updatedAt: null, timeZone, progress } : null);

  function notifyUploadState() {
    for (const listener of uploadStateListeners) listener();
  }

  function send(connection, message) {
    if (!connection.child?.stdin.destroyed && connection.child?.stdin.writable) {
      connection.child.stdin.write(tokensMessage(message));
    }
  }

  function sendChannels(connection) {
    if (!connection.ready) return;
    const targets = hostTargets.get(connection.host) ?? [];
    const channels = targets.map(target => ({ channelId: publicChannelId(target), target }));
    const signature = JSON.stringify(channels);
    if (signature === connection.channelSignature) return;
    connection.channelSignature = signature;
    send(connection, { type: 'channels', channels });
  }

  function sendCredential(connection) {
    if (connection.ready && credentials) send(connection, { type: 'credential', endpoint, ...credentials });
  }

  function sendSyncTargets() {
    const local = connections.get(localHost);
    if (!local?.ready) return;
    const targets = [...connections.values()].flatMap(connection =>
      connection.host !== localHost && connection.ready && connection.destination
        ? [{ ...connection.destination, deviceGuid: connection.deviceGuid }] : []);
    const signature = JSON.stringify(targets);
    if (signature === local.syncSignature) return;
    local.syncSignature = signature;
    send(local, { type: 'sync-targets', targets });
  }

  function handle(connection, event, payload) {
    connection.lastSeen = Date.now();
    switch (event.type) {
      case 'bootstrap':
        if (event.version === payload.version) send(connection, { version: payload.version });
        else send(connection, payload);
        break;
      case 'installed':
        send(connection, { type: 'hello', endpoint, timeZone });
        break;
      case 'ready':
        if (!validInstallationId(event.deviceGuid)) return;
        connection.ready = true;
        connection.deviceGuid = event.deviceGuid;
        intervals = tokensIntervals(event.intervals, intervals);
        sendChannels(connection);
        sendCredential(connection);
        sendSyncTargets();
        break;
      case 'intervals':
        intervals = tokensIntervals(event.intervals, intervals);
        break;
      case 'progress':
        progress = { done: event.done, total: event.total };
        if (!summary()?.updatedAt) onChange(summary());
        break;
      case 'personal':
      case 'device-personal': {
        const packet = event.packet;
        if (connection.host !== localHost || !validPersonal(packet) ||
            (event.type === 'personal') !== (packet.deviceGuid === connection.deviceGuid) ||
            !keepLatest(personal, packet.deviceGuid, packet)) return;
        onChange(summary());
        break;
      }
      case 'channel':
        if (event.deviceGuid === connection.deviceGuid && typeof event.channelId === 'string') {
          connection.channels.set(event.channelId, event.result);
        }
        break;
      case 'uploaded':
        if (connection === connections.get(localHost) && event.accountId === credentials?.accountId) {
          lastUploadedAt = event.at;
          onUploaded(event.at);
          notifyUploadState();
        }
        break;
      case 'upload-state':
        if (connection === connections.get(localHost) && event.accountId === credentials?.accountId) {
          uploadStatus = event;
          notifyUploadState();
        }
        break;
    }
  }

  async function open(connection) {
    const payload = await bundle;
    let child;
    if (connection.host === localHost) {
      await installTokensManagerBundle(root, payload);
      if (stopped || connections.get(connection.host) !== connection) return;
      child = localBridge(root);
    } else {
      const [target] = hostTargets.get(connection.host) ?? [];
      if (!target || !orca.grantedCapabilities?.includes('workspace:read')) throw new Error('Remote project unavailable');
      const destination = await resolveRuntime(target, AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]));
      if (stopped || connections.get(connection.host) !== connection) return;
      const { host, port, username, alias } = destination;
      connection.destination = { host, port, username, alias };
      child = launchSsh(connection.destination, randomBytes(8).toString('hex'), tokensManagerBootstrap);
    }
    connection.child = child;
    connection.lastSeen = Date.now();
    child.stdin.on('error', () => child.kill());
    child.on('error', () => disconnect(connection));
    child.once('exit', () => disconnect(connection));
    const reader = createInterface({ input: child.stdout });
    reader.on('line', line => {
      try { handle(connection, JSON.parse(line), payload); } catch {}
    });
    if (connection.host === localHost) send(connection, { type: 'hello', endpoint, timeZone, deviceGuid, local: true });
  }

  function disconnect(connection) {
    if (connections.get(connection.host) !== connection) return;
    connections.delete(connection.host);
    if (connection.host === localHost && uploadStatus?.pending) {
      uploadStatus = undefined;
      notifyUploadState();
    }
    sendSyncTargets();
    if (connection.child?.exitCode === null) connection.child.kill();
    if (!stopped && hostTargets.has(connection.host)) {
      const retry = { host: connection.host, retryAt: Date.now() + TOKENS_RETRY_MS };
      connections.set(connection.host, retry);
    }
  }

  function tick() {
    const now = Date.now();
    for (const [host] of hostTargets) {
      const existing = connections.get(host);
      if (!existing || existing.retryAt <= now) {
        const connection = { host, channels: new Map(), lastSeen: now, nextHeartbeat: now + TOKENS_HEARTBEAT_MS };
        connections.set(host, connection);
        void open(connection).catch(() => disconnect(connection));
        continue;
      }
      if (!existing.child) continue;
      if (now - existing.lastSeen >= (existing.ready ? TOKENS_LEASE_MS : 45_000)) {
        disconnect(existing);
      } else if (existing.ready && now >= existing.nextHeartbeat) {
        send(existing, { type: 'heartbeat' });
        existing.nextHeartbeat = now + TOKENS_HEARTBEAT_MS;
      }
    }
  }

  function remove(connection) {
    if (!connection) return;
    if (connection.ready) send(connection, { type: 'unsubscribe' });
    connection.child?.stdin.end();
    connections.delete(connection.host);
    if (!stopped) sendSyncTargets();
  }

  function setTargets(targets) {
    const next = new Map([[localHost, []]]);
    for (const target of targets) {
      const host = target.executionHostId || localHost;
      if (!next.has(host)) next.set(host, []);
      next.get(host).push(target);
    }
    for (const host of hostTargets.keys()) if (!next.has(host)) remove(connections.get(host));
    hostTargets.clear();
    for (const [host, entries] of next) hostTargets.set(host, entries);
    for (const connection of connections.values()) sendChannels(connection);
    tick();
  }

  const timer = setInterval(tick, 250);
  timer.unref?.();
  tick();
  return {
    summary, setTargets, intervals: () => intervals, lastUploaded: () => lastUploadedAt, uploadStatus: () => uploadStatus,
    onUploadState(listener) {
      uploadStateListeners.add(listener);
      return () => uploadStateListeners.delete(listener);
    },
    read(target) {
      const connection = connections.get(target.executionHostId || localHost);
      return connection?.channels?.get(publicChannelId(target)) ?? { session: null, warnings: [] };
    },
    setCredential(value) {
      if (credentials?.accountId !== value.accountId || !value.token) {
        lastUploadedAt = null;
        uploadStatus = undefined;
      }
      credentials = value;
      for (const connection of connections.values()) sendCredential(connection);
    },
    upload() {
      const local = connections.get(localHost);
      if (local?.ready) send(local, { type: 'upload' });
      return Boolean(local?.ready);
    },
    async setTimeZone(zone) {
      const next = calendarFor(zone || undefined).timeZone;
      if (timeZone === next) return { timeZone };
      timeZone = next;
      await orca.storage.set(timezoneKey, timeZone);
      for (const connection of connections.values()) if (connection.ready) send(connection, { type: 'timezone', timeZone });
      onChange(summary());
      return { timeZone };
    },
    async close() {
      stopped = true;
      clearInterval(timer);
      controller.abort();
      uploadStateListeners.clear();
      for (const connection of connections.values()) remove(connection);
    }
  };
}

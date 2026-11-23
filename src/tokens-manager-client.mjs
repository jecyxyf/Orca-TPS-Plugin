import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { calendarFor } from './tokens-manager-db.mjs';
import { publicChannelId } from './controller.mjs';
import { validInstallationId } from './leaderboard-installation.mjs';
import { createRuntimeLookup, launchSsh } from './remote-channel.mjs';
import { TOKENS_HEARTBEAT_MS, TOKENS_LEASE_MS, TOKENS_RETRY_MS, TOKENS_ROOT, tokensMessage } from './tokens-manager.mjs';
import { mergePersonalPackets, tokensIntervals } from './tokens-manager-stats.mjs';

const localHost = '';
const timezoneKey = 'tokens-manager:timezone';
const transmittable = /^(?:[\w-]+\.mjs|locales\/[\w-]+\.xml)$/;
const json = async file => JSON.parse(await readFile(file, 'utf8'));

async function install(root, payload) {
  const { mkdir, readFile, rename, writeFile } = await import('node:fs/promises');
  const { dirname, join } = await import('node:path');
  const { gunzipSync } = await import('node:zlib');
  const { randomUUID } = await import('node:crypto');
  const bin = join(root, 'bin');
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const remember = join(bin, 'version');
  if (await readFile(remember, 'utf8').catch(() => '') === payload.version) return;
  async function put(name, bytes, mode = 0o600) {
    const filename = join(bin, name), next = filename + '.' + randomUUID() + '.next';
    await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
    await writeFile(next, bytes, { flag: 'wx', mode });
    await rename(next, filename);
  }
  for (const [name, bytes] of Object.entries(payload.files)) {
    if (!/^(?:[\w-]+\.mjs|locales\/[\w-]+\.xml)$/.test(name)) throw new Error('Invalid manager bundle path');
    await put(name, Buffer.from(bytes, 'base64'));
  }
  const scanner = payload.scanners?.[process.platform + '-' + process.arch];
  if (scanner) await put(process.platform === 'win32' ? 'tokens-manager-scan.exe' : 'tokens-manager-scan',
    gunzipSync(Buffer.from(scanner, 'base64')), 0o700);
  await put('version', payload.version);
}

async function readBundle() {
  const files = {}, scanners = {};
  const source = new URL('./', import.meta.url);
  const read = async name => { files[name] = (await readFile(new URL(name, source))).toString('base64'); };
  for (const file of (await readdir(source)).sort().filter(name => transmittable.test(name))) await read(file);
  for (const file of (await readdir(new URL('./locales/', source))).sort().filter(name => name.endsWith('.xml'))) await read('locales/' + file);
  const archive = new URL('../native/bin/', source);
  for (const platform of (await readdir(archive).catch(() => [])).sort()) {
    const filename = `${platform}/tokens-manager-scan${platform.startsWith('win32-') ? '.exe' : ''}.gz`;
    const bytes = await readFile(new URL(filename, archive)).catch(() => null);
    if (bytes) scanners[platform] = bytes.toString('base64');
  }
  const version = createHash('sha256').update(JSON.stringify({ files, scanners })).digest('hex');
  return { version, files, scanners };
}

async function remoteBootstrap(install) {
  const { createInterface } = await import('node:readline');
  const { readFile } = await import('node:fs/promises');
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawn } = await import('node:child_process');
  const root = join(homedir(), '.orca', 'tpsplugin');
  const platform = process.platform + '-' + process.arch;
  const version = await readFile(join(root, 'bin', 'version'), 'utf8').catch(() => '');
  const reader = createInterface({ input: process.stdin });
  const request = new Promise((resolve, reject) => {
    reader.once('line', line => { reader.close(); process.stdin.pause(); resolve(JSON.parse(line)); });
    reader.once('close', () => queueMicrotask(() => reject(new Error('Manager installation cancelled'))));
  });
  console.log(JSON.stringify({ type: 'bootstrap', platform, version }));
  const payload = await request;
  if (payload.version !== version) await install(root, payload);
  const child = spawn(process.execPath, [join(root, 'bin', 'tokens-manager.mjs'), '--connect'],
    { stdio: ['pipe', 'inherit', 'inherit'], env: { ...process.env, ORCA_TPS_TOKENS_ROOT: root } });
  process.stdin.pipe(child.stdin);
  child.stdin.on('error', () => {});
  console.log(JSON.stringify({ type: 'installed' }));
  await new Promise(resolve => child.once('exit', resolve));
  process.stdin.destroy();
}

const bootstrap = `await (${remoteBootstrap})(${install});`;

function localBridge(root) {
  return spawn(process.execPath, [path.join(root, 'bin', 'tokens-manager.mjs'), '--connect'], {
    stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ORCA_TPS_TOKENS_ROOT: root }
  });
}

function savePacket(root, name, packet) {
  const next = path.join(root, name + '.' + randomBytes(6).toString('hex') + '.next');
  return writeFile(next, JSON.stringify(packet), { mode: 0o600 }).then(() => rename(next, path.join(root, name)));
}

const validPersonal = packet => packet && validInstallationId(packet.deviceGuid) &&
  typeof packet.timeZone === 'string' && Number.isSafeInteger(packet.publishedAt) &&
  [packet.days, packet.hours, packet.maxima].every(Array.isArray);

export async function createTokensManagerClient(orca, {
  endpoint, deviceGuid, initialZone, root = TOKENS_ROOT, resolveRuntime = createRuntimeLookup(orca), onChange = () => {}, onUploaded = () => {}
} = {}) {
  const controller = new AbortController();
  const personal = new Map(), relays = new Map(), connections = new Map();
  const writes = new Map(), hostTargets = new Map([[localHost, []]]);
  const storedZone = await orca.storage.get(timezoneKey).catch(() => undefined);
  let timeZone = calendarFor(storedZone || undefined).timeZone, credentials, stopped = false;
  if (initialZone !== undefined) {
    try { timeZone = calendarFor(initialZone || undefined).timeZone; } catch {}
  }
  let intervals = tokensIntervals(), progress = null, lastUploadedAt = null, uploadStatus;
  const bundle = readBundle();
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const name of await readdir(root)) {
    if (!/^personal-[a-f0-9-]+\.json$|^leaderboard-\d+-[a-f0-9-]+\.json$/.test(name)) continue;
    const saved = await json(path.join(root, name)).catch(() => null);
    if (name.startsWith('personal-') && validPersonal(saved)) personal.set(saved.deviceGuid, saved);
    if (name.startsWith('leaderboard-') && validInstallationId(saved?.deviceGuid)) {
      relays.set(`${saved.accountId}/${saved.deviceGuid}`, saved);
    }
  }

  const summary = () => mergePersonalPackets(personal.values(), timeZone) ?? (progress
    ? { updatedAt: null, timeZone, progress } : null);

  function persist(name, packet) {
    const pending = (writes.get(name) ?? Promise.resolve()).then(() => savePacket(root, name, packet))
      .catch(() => {}).finally(() => { if (writes.get(name) === pending) writes.delete(name); });
    writes.set(name, pending);
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

  function sendRelays(connection) {
    if (!connection.ready || connection.host !== localHost || !credentials?.accountId) return;
    for (const packet of relays.values()) {
      if (packet.accountId === credentials.accountId) send(connection, { type: 'relay', packet });
    }
  }

  function handle(connection, event, payload) {
    connection.lastSeen = Date.now();
    switch (event.type) {
      case 'bootstrap':
        if (event.version === payload.version) send(connection, { version: payload.version });
        else send(connection, { ...payload, scanners: { [event.platform]: payload.scanners[event.platform] } });
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
        sendRelays(connection);
        break;
      case 'intervals':
        intervals = tokensIntervals(event.intervals, intervals);
        break;
      case 'progress':
        progress = { done: event.done, total: event.total };
        if (!summary()?.updatedAt) onChange(summary());
        break;
      case 'personal': {
        const packet = event.packet;
        if (!validPersonal(packet) || packet.deviceGuid !== connection.deviceGuid || packet.timeZone !== timeZone ||
            (personal.get(packet.deviceGuid)?.publishedAt ?? -1) >= packet.publishedAt) return;
        personal.set(packet.deviceGuid, packet);
        if (connection.host !== localHost) persist(`personal-${packet.deviceGuid}.json`, packet);
        onChange(summary());
        break;
      }
      case 'channel':
        if (event.deviceGuid === connection.deviceGuid && typeof event.channelId === 'string') {
          connection.channels.set(event.channelId, event.result);
        }
        break;
      case 'leaderboard': {
        const packet = event.packet;
        if (connection.host === localHost || !packet || !credentials?.accountId || packet.accountId !== credentials.accountId ||
            packet.deviceGuid !== connection.deviceGuid || !Number.isSafeInteger(packet.publishedAt)) return;
        const key = `${packet.accountId}/${packet.deviceGuid}`;
        if ((relays.get(key)?.publishedAt ?? -1) >= packet.publishedAt) return;
        relays.set(key, packet);
        persist(`leaderboard-${packet.accountId}-${packet.deviceGuid}.json`, packet);
        const local = connections.get(localHost);
        if (local?.ready) send(local, { type: 'relay', packet });
        break;
      }
      case 'uploaded':
        if (connection.host === localHost && event.accountId === credentials?.accountId) {
          lastUploadedAt = event.at;
          onUploaded(event.at);
        }
        break;
      case 'upload-state':
        if (connection.host === localHost && event.accountId === credentials?.accountId) uploadStatus = event;
        break;
    }
  }

  async function open(connection) {
    const payload = await bundle;
    let child;
    if (connection.host === localHost) {
      await install(root, payload);
      if (stopped || connections.get(connection.host) !== connection) return;
      child = localBridge(root);
    } else {
      const [target] = hostTargets.get(connection.host) ?? [];
      if (!target || !orca.grantedCapabilities?.includes('workspace:read')) throw new Error('Remote project unavailable');
      const destination = await resolveRuntime(target, AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]));
      if (stopped || connections.get(connection.host) !== connection) return;
      child = launchSsh({ ...destination, directory: undefined }, randomBytes(8).toString('hex'), bootstrap);
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
    if (connection.host === localHost) send(connection, { type: 'hello', endpoint, timeZone, deviceGuid });
  }

  function disconnect(connection) {
    if (connections.get(connection.host) !== connection) return;
    connections.delete(connection.host);
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
      const local = connections.get(localHost);
      if (local) sendRelays(local);
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
      for (const connection of connections.values()) remove(connection);
      await Promise.all(writes.values());
    }
  };
}

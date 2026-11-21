import { sourceMessage } from './locales.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { gunzipSync, gzip } from 'node:zlib';
import { readOrcaProfile } from './active-conversation.mjs';
import { normalizeComparePath, USAGE_RECORD_PAGE_SIZE } from './data.mjs';
import { COLLECTOR_FILES, MAX_RESPONSE_BASE64, USAGE_PAGE_SIZE, collectorCommand, remoteRecord } from './remote-collector.mjs';
import { validInstallationId } from './leaderboard-installation.mjs';
import { REMOTE_USAGE_PREFIX, leaderboardDayStart, leaderboardUsageTimesFrom, validLeaderboardUsageTimes } from './usage-summary.mjs';
import { HOUR_MS, MAX_RECENT_REQUESTS, validRecentRequest } from './leaderboard-stats.mjs';

const warnings = {
  api: sourceMessage('notice.remote-api-missing'),
  permission: sourceMessage('notice.remote-permission'),
  workspace: sourceMessage('notice.remote-workspace-unavailable'),
  ssh: sourceMessage('notice.remote-ssh-unavailable'),
  node: sourceMessage('notice.remote-node-unavailable'),
  connection: sourceMessage('notice.remote-connection-failed'),
  read: sourceMessage('notice.remote-log-unavailable')
};

class RemoteReadError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

const resultError = reason => ({ session: null, warnings: [warnings[reason] ?? warnings.connection] });
const id = () => randomBytes(8).toString('hex');
const samePath = (a, b) => normalizeComparePath(a, 'linux') === normalizeComparePath(b, 'linux');

let bundle;
function loadCollectorFiles() {
  bundle ??= Promise.all(COLLECTOR_FILES.map(async file => [file, await readFile(new URL(file, import.meta.url), 'utf8')]))
    .then(Object.fromEntries)
    .catch(error => { bundle = undefined; throw error; });
  return bundle;
}

export async function readSshTargets(targetIds) {
  const profile = await readOrcaProfile();
  if (!profile) return [];
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(profile.stateFile, { readOnly: true, enableExtensionLoading: false });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=100;');
    // Read only the saved destination. Authentication is handled by OpenSSH.
    const query = db.prepare(
      "SELECT json_extract(value, '$.configHost') AS alias, json_extract(value, '$.host') AS host, " +
      "json_extract(value, '$.username') AS username, json_extract(value, '$.port') AS port, " +
      "json_extract(value, '$.generation') AS generation " +
      "FROM profile_state_documents, json_each(payload) WHERE domain = 'sshTargets' AND json_extract(value, '$.id') = ?"
    );
    return targetIds.map(id => query.get(id)).filter(Boolean);
  } finally {
    db.close();
  }
}

function createOrcaRpc() {
  const exec = promisify(execFile);
  const cliEnv = { ...process.env };
  delete cliEnv.ORCA_ENVIRONMENT;
  delete cliEnv.ORCA_PAIRING_CODE;
  const windows = process.platform === 'win32';
  const linux = process.platform === 'linux';
  if (windows) {
    // Orca's worker may omit these even though its CLI needs the profile directories.
    cliEnv.APPDATA ||= path.join(homedir(), 'AppData', 'Roaming');
    cliEnv.LOCALAPPDATA ||= path.join(homedir(), 'AppData', 'Local');
  }
  const cliName = windows ? 'orca.exe' : 'orca';
  const bundledBin = path.join(path.dirname(process.execPath), 'resources', 'bin');
  const paths = [
    // The Linux AppImage puts its Electron binary ahead of the CLI on the worker's PATH.
    ...(linux ? [path.join(bundledBin, 'orca-ide')] : []),
    path.join(bundledBin, cliName),
    ...(windows
      ? [path.join(cliEnv.LOCALAPPDATA, 'Programs', 'orca', 'resources', 'bin', cliName)]
      : []),
    ...(process.platform === 'darwin' ? [
      path.resolve(path.dirname(process.execPath), '..', 'Resources', 'bin', cliName),
      '/Applications/Orca.app/Contents/Resources/bin/orca'
    ] : []),
    ...(linux ? [
      'orca-ide',
      path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'orca', 'linux-orca-cli-shim', 'orca')
    ] : []),
    cliName
  ];
  let executable;

  async function rpc(args, environment, signal) {
    for (const file of executable ? [executable] : paths) {
      let stdout, failure;
      try {
        const routedArgs = environment ? [...args.slice(0, 2), '--environment', environment, ...args.slice(2)] : args;
        ({ stdout } = await exec(file, [...routedArgs, '--json'], {
          signal, env: cliEnv, timeout: 12_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true
        }));
      } catch (error) {
        if (error.code === 'ENOENT') {
          if (file === executable) executable = undefined;
          continue;
        }
        stdout = error.stdout;
        failure = error;
      }
      signal?.throwIfAborted();
      if (!stdout) throw failure ?? new RemoteReadError('connection');
      const response = JSON.parse(stdout);
      if (response.ok === false) {
        const error = new RemoteReadError('connection');
        error.code = response.error?.code;
        error.operation = args.slice(0, 2).join('.');
        throw error;
      }
      if (failure) throw failure;
      executable = file;
      return response.result ?? response;
    }
    throw new RemoteReadError('api');
  }

  return rpc;
}

function createRuntimeLookup(orca, lookupSsh) {
  const rpc = createOrcaRpc();
  return async (target, signal) => {
    const host = target.executionHostId;
    const { environments } = await rpc(['environment', 'list'], null, signal);
    const matches = (environments ?? []).filter(item => host.startsWith('runtime:')
      ? item.id === host.slice('runtime:'.length)
      : host === 'ssh:' + item.orcadDeployment?.sshTargetId);
    if (matches.length > 1) throw new RemoteReadError('workspace');
    const [environment] = matches;
    const targetId = host.startsWith('ssh:') ? host.slice('ssh:'.length) : environment?.orcadDeployment?.sshTargetId;
    if (!targetId) throw new RemoteReadError('ssh');

    let workspace;
    if (environment) {
      const selectors = ['id:' + target.worktreeId];
      if (target.worktreePath) selectors.push('path:' + target.worktreePath);
      for (const selector of selectors) {
        let result;
        try {
          result = await rpc(['worktree', 'show', '--worktree', selector], environment.id, signal);
        } catch (error) {
          if (error.code === 'selector_not_found') continue;
          throw error;
        }
        const row = result.worktree;
        if (row?.id && row.path && row.isArchived !== true &&
          (!target.worktreePath || samePath(row.path, target.worktreePath))) {
          workspace = row;
          break;
        }
      }
    } else {
      const listing = await orca.host.call('workspace.list', undefined, { signal });
      workspace = listing.workspaces?.find(row => row.hostId === host && row.id === target.worktreeId &&
        (!target.worktreePath || samePath(row.path, target.worktreePath)));
    }
    if (!workspace?.path || !path.posix.isAbsolute(workspace.path) || /[\x00-\x1f\x7f]/.test(workspace.path)) {
      throw new RemoteReadError('workspace');
    }

    const [ssh] = await lookupSsh([targetId]);
    const generation = environment?.orcadDeployment?.sshTargetGeneration;
    if (!ssh || (generation != null && ssh.generation !== generation)) throw new RemoteReadError('ssh');
    return { ...ssh, directory: workspace.path };
  };
}

const shellQuote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";

function launchSsh(destination, token) {
  const { host, port, username, alias, directory } = destination;
  if (typeof host !== 'string' || !/^[a-z\d:][a-z\d.:-]*$/i.test(host) ||
    typeof username !== 'string' || !/^[a-z\d_][a-z\d_.-]*$/i.test(username) ||
    !Number.isInteger(port) || port < 1 || port > 65535) throw new RemoteReadError('ssh');
  const configHost = typeof alias === 'string' && /^[\p{L}\p{N}_][\p{L}\p{N}_.-]*$/u.test(alias) ? alias : host;
  const prefix = '@TPS:' + token + ':';
  const checkNode = "const [major,minor]=process.versions.node.split('.').map(Number);" +
    "if(major<22||(major===22&&minor<13))process.exit(1);require('node:sqlite')";
  // Non-interactive SSH may skip the shell profile that normally adds Node to PATH.
  const script = [
    'cd ' + (directory ? shellQuote(directory) : '"$HOME"') + ' || { echo ' + prefix + 'workspace; exit 1; }',
    'for node in node "$HOME"/.orca-remote/runtimes/node-*/bin/node "$HOME"/.local/share/nodejs/node-*/bin/node "$HOME"/.nvm/versions/node/*/bin/node; do',
    '  if "$node" --input-type=commonjs -e ' + shellQuote(checkNode) + ' >/dev/null 2>&1; then',
    '    exec "$node" ' + collectorCommand(token).slice('node '.length),
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

export function decodeCollectorReply(body) {
  return JSON.parse(gunzipSync(Buffer.from(body, 'base64'), { maxOutputLength: 8 * 1024 * 1024 }));
}

const compress = promisify(gzip);

function connectCollector(child, token, watchId, decode) {
  const prefix = '@TPS:' + token + ':';
  let ready = false, failure, waiter, latest, decodingWatch = false, pendingWatch;
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const closed = new Promise(resolve => {
    child.once('close', () => {
      fail(new RemoteReadError('connection'));
      lines.close();
      resolve();
    });
  });

  function fail(error) {
    failure ??= error;
    waiter?.finish(failure);
  }

  child.on('error', fail);
  child.stdin.on('error', fail);
  child.stdout.on('error', fail);
  lines.on('line', line => {
    if (failure || !line.startsWith(prefix)) return;
    const frame = line.slice(prefix.length);
    if (frame === 'ready') {
      ready = true;
      if (waiter?.requestId === 'ready') waiter.finish(null);
      return;
    }
    if (frame === 'node' || frame === 'workspace') {
      fail(new RemoteReadError(frame));
      return;
    }
    if (frame.length > MAX_RESPONSE_BASE64 + 17) return;
    const match = /^([a-f\d]{16}):([A-Za-z0-9+/=]+)$/.exec(frame);
    if (!match) return;
    const [, requestId, body] = match;
    const response = waiter?.requestId === requestId ? waiter : null;
    const version = watchId && requestId.startsWith(watchId) ? parseInt(requestId.slice(8), 16) : 0;
    if (!response && version <= (latest?.version ?? 0)) return;
    if (response) {
      void Promise.resolve().then(() => decode(body)).then(value => {
        if (waiter === response) response.finish(null, value);
      }, () => { if (waiter === response) fail(new RemoteReadError('read')); });
      return;
    }
    if (!pendingWatch || version > pendingWatch.version) pendingWatch = { version, body };
    if (!decodingWatch) void decodeWatch();
  });

  async function decodeWatch() {
    decodingWatch = true;
    try {
      while (pendingWatch && !failure) {
        const { version, body } = pendingWatch;
        pendingWatch = undefined;
        const answer = await decode(body);
        if (!failure && version > (latest?.version ?? 0)) latest = { version, answer };
      }
    } catch { fail(new RemoteReadError('read')); }
    finally { decodingWatch = false; }
  }

  function waitFor(requestId, signal) {
    signal.throwIfAborted();
    if (failure) throw failure;
    if (requestId === 'ready' && ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const abort = () => finish(signal.reason);
      function finish(error, result) {
        signal.removeEventListener('abort', abort);
        waiter = undefined;
        if (error) reject(error);
        else resolve(result);
      }
      waiter = { requestId, finish };
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  return {
    ready: signal => waitFor('ready', signal),
    async exchange(request, signal) {
      const body = (await compress(JSON.stringify(request))).toString('base64');
      if (body.length > 96_000) throw new RemoteReadError('read');
      const requestId = id();
      const response = waitFor(requestId, signal);
      child.stdin.write('>' + requestId + ':' + body + '\n');
      return response;
    },
    latest() {
      if (failure) throw failure;
      return latest;
    },
    close() {
      fail(new RemoteReadError('connection'));
      child.stdin.end();
      child.kill();
      return closed;
    }
  };
}

export function createRemoteChannelReader(orca, {
  timeoutMs = 20_000, startupTimeoutMs = 30_000, now = Date.now,
  lookupSsh = readSshTargets, decode = decodeCollectorReply,
  resolveRuntime = createRuntimeLookup(orca, lookupSsh), launch = launchSsh, t = sourceMessage
} = {}) {
  let wanted = new Set();
  const collectors = new Map(), retries = new Map();
  const pendingClosures = new Set();

  function retire(entry) {
    if (collectors.get(entry.key) === entry) collectors.delete(entry.key);
    entry.abort.abort();
    if (!entry.connection) return;
    const done = entry.connection.close().finally(() => pendingClosures.delete(done));
    pendingClosures.add(done);
  }

  function setTarget(target) {
    setTargets(target ? [target] : []);
  }

  function setTargets(targets) {
    wanted = new Set(targets.filter(target => target?.executionHostId).map(target => target.key));
    for (const [key, entry] of collectors) if (!wanted.has(key)) retire(entry);
    for (const key of retries.keys()) if (!wanted.has(key)) retries.delete(key);
  }

  async function start(entry, target, signal) {
    entry.stage = 'route';
    if (!orca.grantedCapabilities?.includes('workspace:read')) throw new RemoteReadError('permission');
    const route = await resolveRuntime(target, signal);
    if (!route?.directory) throw new RemoteReadError('workspace');
    signal.throwIfAborted();
    entry.stage = 'ssh';
    entry.path = route.directory;
    entry.connection = connectCollector(launch(route, entry.token), entry.token, entry.watchId, decode);
    await entry.connection.ready(signal);

    return loadCollectorFiles();
  }

  async function read(target, { fresh = false } = {}) {
    if (!wanted.has(target.key)) return resultError('workspace');
    const retry = retries.get(target.key);
    if (!fresh && retry && now() < retry.at) return resultError(retry.reason);
    let entry = collectors.get(target.key);
    if (!entry) {
      entry = { key: target.key, token: id(), watchId: id().slice(0, 8), version: 0, abort: new AbortController() };
      collectors.set(target.key, entry);
    }
    const signal = AbortSignal.any([entry.abort.signal, AbortSignal.timeout(entry.connection ? timeoutMs : startupTimeoutMs)]);
    try {
      const files = !entry.connection ? await start(entry, target, signal) : undefined;
      entry.stage = 'read';
      const signature = JSON.stringify(target.sessions ?? []);
      if (files || fresh || signature !== entry.signature || now() - entry.lastHandshake >= 30_000) {
        const response = await entry.connection.exchange({
          ...(files ? { files } : {}),
          watchId: entry.watchId,
          project: { worktreePath: entry.path, sessions: target.sessions, fresh }
        }, signal);
        if (!response.answer) throw new RemoteReadError('read');
        entry.signature = signature;
        entry.version = response.version;
        entry.lastHandshake = now();
        entry.lastReply = response.answer;
      } else {
        const latest = entry.connection.latest();
        if (latest && latest.version > entry.version) {
          entry.version = latest.version;
          entry.lastReply = latest.answer;
        }
      }
      const answer = entry.lastReply;
      if (answer.error) throw new RemoteReadError(answer.error);
      if (!Array.isArray(answer.records)) return resultError('read');
      retries.delete(target.key);
      return {
        session: {
          id: 'channel:' + target.worktreeId,
          provider: 'channel',
          records: answer.records.slice(0, 100).map(remoteRecord).filter(Boolean).sort((a, b) => b.completedAt - a.completedAt)
        },
        warnings: answer.incomplete ? [sourceMessage('notice.remote-logs-incomplete')] : []
      };
    } catch (error) {
      if (collectors.get(target.key) === entry) {
        const denied = ['capability_denied', 'consent_required', 'not_permitted'].includes(error.code);
        const lastFailure = denied ? 'permission' : Object.hasOwn(warnings, error.reason) ? error.reason : 'connection';
        const code = typeof error.code === 'string' && /^[a-z0-9_]+$/i.test(error.code) ? error.code : lastFailure;
        const action = error.operation ? entry.stage + '/' + error.operation : entry.stage;
        orca.log?.(t('notice.remote-read-failed', action, code));
        retries.set(target.key, { at: now() + 10_000, reason: lastFailure });
        retire(entry);
        return resultError(lastFailure);
      }
      return resultError('connection');
    }
  }

  async function dispose() {
    setTarget(null);
    await Promise.allSettled(pendingClosures);
  }

  return { setTarget, setTargets, read, dispose };
}

function resolveUsageHosts(lookupSsh) {
  const rpc = createOrcaRpc();
  return async signal => {
    const { hosts } = await rpc(['host', 'list'], null, signal);
    return lookupSsh((hosts ?? []).filter(row => row.kind === 'ssh' && row.connected === true).map(row => row.id));
  };
}

const usageKey = /^[a-f\d]{24}$/;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function validUsageDays(days) {
  return isObject(days) && Object.entries(days).every(([day, agents]) =>
    /^\d{4}-\d{2}-\d{2}$/.test(day) && isObject(agents) && Object.entries(agents).every(([provider, models]) =>
      /^(codex|claude|opencode2?|pi|antigravity|hermes)$/.test(provider) && isObject(models) && Object.entries(models).every(([model, counters]) =>
        model.length <= 128 && Array.isArray(counters) && counters.length === 8 &&
        counters.every(value => Number.isFinite(value) && value >= 0))));
}

export function createRemoteUsageReader(orca, {
  lookupSsh = readSshTargets, decode = decodeCollectorReply,
  resolveHosts = resolveUsageHosts(lookupSsh), launch = launchSsh, t = sourceMessage, includeRecent = false, includeUsageTimes = false,
  includeUsageSources = false, includeRecords = false
} = {}) {
  const lifetime = new AbortController();
  const connections = new Set();
  const signal = timeout => AbortSignal.any([lifetime.signal, AbortSignal.timeout(timeout)]);

  let currentScan;
  async function openScan(route, legacyScope, cutoffMs, timeZone, rankDay, rankFrom) {
    await finish();
    const token = id(), startupSignal = signal(45_000);
    const files = await loadCollectorFiles();
    startupSignal.throwIfAborted();
    const connection = connectCollector(launch(route, token), token, undefined, decode);
    connections.add(connection);
    try {
      await connection.ready(startupSignal);
      const items = new Map();
      let offset = 0, scope = legacyScope, sourceId, sourceTime;
      for (;;) {
        const page = await connection.exchange({
          ...(offset === 0 ? { files } : {}),
          usage: { type: 'list', cutoffMs, offset, timeZone, rankDay, rankFrom,
            ...(includeRecent ? { includeRecent } : {}), ...(includeUsageTimes ? { includeUsageTimes } : {}),
            ...(includeUsageSources ? { includeUsageSources } : {}), ...(includeRecords ? { includeRecords } : {}) }
        }, signal(45_000));
        if (!Array.isArray(page.items) || page.items.length > USAGE_PAGE_SIZE || typeof page.more !== 'boolean' ||
          (page.more && page.items.length !== USAGE_PAGE_SIZE)) {
          throw new RemoteReadError('read');
        }
        if (includeUsageSources) {
          if (!validInstallationId(page.sourceId) ||
              (page.sourceTime !== undefined && (!Number.isSafeInteger(page.sourceTime) || page.sourceTime <= 0)) ||
              (offset && (page.sourceId !== sourceId || page.sourceTime !== sourceTime))) throw new RemoteReadError('read');
          sourceId = page.sourceId;
          sourceTime = page.sourceTime;
          scope = `${REMOTE_USAGE_PREFIX}${sourceId}:`;
        }
        for (const item of page.items) {
          if (typeof item.key !== 'string' || !usageKey.test(item.key) || typeof item.stamp !== 'string' || !usageKey.test(item.stamp) ||
            !Number.isFinite(item.bytes) || item.bytes < 0 || !Number.isFinite(item.mtimeMs) || item.mtimeMs < 0) {
            throw new RemoteReadError('read');
          }
          const key = scope + item.key;
          items.set(key, { ...item, key, stamp: timeZone + ':' + item.stamp });
        }
        if (!page.more) break;
        offset += page.items.length;
      }
      return { scope, sourceId, sourceTime, connection, items, observedAt: Date.now() };
    } catch (error) {
      await close(connection);
      throw error;
    }

  }

  async function scanHost(route, legacyScope, cutoffMs, timeZone, rankDay, rankFrom) {
    const open = () => openScan(route, legacyScope, cutoffMs, timeZone, rankDay, rankFrom);
    const original = currentScan = await open();
    const { scope, sourceId, sourceTime, observedAt } = original;
    return { scope, sourceId, sourceTime, observedAt, items: [...original.items.values()].map(item => ({
      ...item, ...(includeRecords ? { deviceGuid: sourceId, readRecords: offset => readRecords(item, offset) } : { readMany })
    })) };

    async function readRecords(item, offset) {
      const scan = currentScan?.scope === scope ? currentScan : (currentScan = await open());
      if (scan.scope !== scope || scan.items.get(item.key)?.stamp !== item.stamp) throw new RemoteReadError('read');
      const reply = await scan.connection.exchange({ usage: { type: 'records', key: item.key.slice(scope.length), offset } }, signal(90_000));
      if (reply.sourceId !== sourceId || !Array.isArray(reply.records) || reply.records.length > USAGE_RECORD_PAGE_SIZE ||
          typeof reply.complete !== 'boolean' || (reply.nextOffset !== null &&
          (!reply.records.length || reply.nextOffset !== offset + reply.records.length)) ||
          !reply.records.every(row => row && usageKey.test(row.id) && Number.isFinite(row.completedAt))) {
        throw new RemoteReadError('read');
      }
      return reply;
    }

    async function readMany(keys) {
      const scan = currentScan?.scope === scope ? currentScan : (currentScan = await open());
      if (scan.scope !== scope) throw new RemoteReadError('read');
      const matching = keys.filter(key => scan.items.get(key)?.stamp === original.items.get(key)?.stamp);
      if (!matching.length) return new Map();
      const localKeys = matching.map(key => key.slice(scope.length));
      const reply = await scan.connection.exchange({ usage: { type: 'read', keys: localKeys } }, signal(90_000));
      if (reply.error === 'limit' && keys.length > 1) {
        const half = Math.ceil(keys.length / 2);
        const left = await readMany(keys.slice(0, half));
        const right = await readMany(keys.slice(half));
        return new Map([...left, ...right]);
      }
      if (!isObject(reply.results)) throw new RemoteReadError('read');
      return new Map(localKeys.filter(key => {
        const value = reply.results[key];
        if (!rankDay) return validUsageDays(value);
        if (value?.leaderboardFrom !== rankFrom || !validUsageDays(value.days) || !isObject(value.leaderboardDays)) return false;
        if (includeUsageTimes && (value.usageTimesFrom !== leaderboardUsageTimesFrom(rankFrom) ||
            !validLeaderboardUsageTimes(value.leaderboardUsageByTime, value.usageTimesFrom, leaderboardDayStart(rankDay) + 24 * HOUR_MS))) return false;
        if (value.recent !== undefined && (!Array.isArray(value.recent) || value.recent.length > MAX_RECENT_REQUESTS ||
          !value.recent.every(validRecentRequest))) return false;
        return Object.entries(value.leaderboardDays).every(([day, total]) =>
          /^\d{4}-\d{2}-\d{2}$/.test(day) && day >= rankFrom && day <= rankDay && Number.isSafeInteger(total) && total >= 0);
      }).map(key => [scope + key, reply.results[key]]));
    }
  }

  async function discover(cutoffMs, rankDay, rankFrom = rankDay) {
    const discovery = { descriptors: [], coveredRemoteScopes: new Set(), remoteComplete: true };
    if (includeUsageSources) discovery.remoteSources = new Map();
    if (!orca.grantedCapabilities?.includes('workspace:read') || lifetime.signal.aborted) return discovery;
    let routes;
    try { routes = await resolveHosts(signal(15_000)); }
    catch {
      discovery.remoteComplete = false;
      if (!lifetime.signal.aborted) orca.log?.(t('notice.remote-usage-list-failed'));
      return discovery;
    }
    const scopes = new Map();
    for (const route of routes) {
      const endpoint = JSON.stringify([route.host?.toLowerCase(), route.port, route.username]);
      const scope = REMOTE_USAGE_PREFIX + createHash('sha256').update(endpoint).digest('hex').slice(0, 24) + ':';
      if (!scopes.has(scope)) scopes.set(scope, route);
    }
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    for (const [legacyScope, route] of scopes) {
      if (lifetime.signal.aborted) break;
      try {
        const { scope, sourceId, sourceTime, observedAt, items } = await scanHost(route, legacyScope, cutoffMs, timeZone, rankDay, rankFrom);
        const previous = discovery.remoteSources?.get(scope);
        if (previous) {
          previous.legacyScopes.add(legacyScope);
          continue;
        }
        discovery.remoteSources?.set(scope, { sourceId, ...(sourceTime !== undefined ? { sourceTime } : {}),
          observedAt, legacyScopes: new Set([legacyScope]) });
        discovery.coveredRemoteScopes.add(scope);
        for (const item of items) discovery.descriptors.push(item);
      } catch {
        discovery.remoteComplete = false;
        if (!lifetime.signal.aborted) orca.log?.(t('notice.remote-usage-partial'));
      }
    }
    return discovery;
  }

  function close(connection) {
    return connections.delete(connection) ? connection.close() : Promise.resolve();
  }
  const finish = () => {
    currentScan = undefined;
    return Promise.all([...connections].map(close));
  };
  async function dispose() {
    lifetime.abort();
    await finish();
  }
  return { discover, finish, dispose };
}

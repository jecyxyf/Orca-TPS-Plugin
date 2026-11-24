import { execFile, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { readOrcaProfile } from './active-conversation.mjs';
import { normalizeComparePath } from './harness_parser.mjs';

class RemoteReadError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

const samePath = (a, b) => normalizeComparePath(a, 'linux') === normalizeComparePath(b, 'linux');

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

export function createRuntimeLookup(orca, lookupSsh = readSshTargets) {
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

export function launchSsh(destination, token, bootstrap) {
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

import { execFile } from 'node:child_process';
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

export { launchSsh } from './orca_connection.mjs';

import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { readOrcaProfile } from './active-conversation.mjs';
import { normalizeComparePath } from './harness_parser.mjs';
import { openReadonlyDatabase } from './sqlite.mjs';

class RemoteReadError extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}
const samePath = (a, b) => normalizeComparePath(a, 'linux') === normalizeComparePath(b, 'linux');

export async function readSshTargets(targetIds) {
  const profile = await readOrcaProfile();
  if (!profile) return [];
  const db = openReadonlyDatabase(profile.stateFile);
  try {
    const query = db.prepare(
      "SELECT json_extract(value, '$.configHost') AS alias, json_extract(value, '$.host') AS host, " +
      "json_extract(value, '$.username') AS username, json_extract(value, '$.port') AS port, json_extract(value, '$.generation') AS generation " +
      "FROM profile_state_documents, json_each(payload) WHERE domain = 'sshTargets' AND json_extract(value, '$.id') = ?"
    );
    return targetIds.map(id => query.get(id)).filter(Boolean);
  } finally { db.close(); }
}

function createOrcaRpc() {
  const exec = promisify(execFile), cliEnv = { ...process.env };
  delete cliEnv.ORCA_ENVIRONMENT; delete cliEnv.ORCA_PAIRING_CODE;
  const win = process.platform === 'win32', linux = process.platform === 'linux';
  if (win) { cliEnv.APPDATA ||= path.join(homedir(), 'AppData', 'Roaming'); cliEnv.LOCALAPPDATA ||= path.join(homedir(), 'AppData', 'Local'); }
  const cliName = win ? 'orca.exe' : 'orca', bundled = path.join(path.dirname(process.execPath), 'resources', 'bin');
  const paths = [
    ...(linux ? [path.join(bundled, 'orca-ide')] : []), path.join(bundled, cliName),
    ...(win ? [path.join(cliEnv.LOCALAPPDATA, 'Programs', 'orca', 'resources', 'bin', cliName)] : []),
    ...(process.platform === 'darwin' ? [path.resolve(path.dirname(process.execPath), '..', 'Resources', 'bin', cliName), '/Applications/Orca.app/Contents/Resources/bin/orca'] : []),
    ...(linux ? ['orca-ide', path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'orca', 'linux-orca-cli-shim', 'orca')] : []),
    cliName
  ];
  let executable;
  return async (args, environment, signal) => {
    for (const file of executable ? [executable] : paths) {
      let stdout, failure;
      try {
        const routed = environment ? [...args.slice(0, 2), '--environment', environment, ...args.slice(2)] : args;
        ({ stdout } = await exec(file, [...routed, '--json'], { signal, env: cliEnv, timeout: 12_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }));
      } catch (error) {
        if (error.code === 'ENOENT') { if (file === executable) executable = undefined; continue; }
        stdout = error.stdout; failure = error;
      }
      signal?.throwIfAborted();
      if (!stdout) throw failure ?? new RemoteReadError('connection');
      const response = JSON.parse(stdout);
      if (response.ok === false) throw Object.assign(new RemoteReadError('connection'), { code: response.error?.code, operation: args.slice(0, 2).join('.') });
      if (failure) throw failure;
      executable = file;
      return response.result ?? response;
    }
    throw new RemoteReadError('api');
  };
}

export function createRuntimeLookup(orca, lookupSsh = readSshTargets) {
  const rpc = createOrcaRpc();
  return async (target, signal) => {
    const host = target.executionHostId, { environments } = await rpc(['environment', 'list'], null, signal);
    const matches = (environments ?? []).filter(i => host.startsWith('runtime:') ? i.id === host.slice(8) : host === 'ssh:' + i.orcadDeployment?.sshTargetId);
    if (matches.length > 1) throw new RemoteReadError('workspace');
    const [environment] = matches, targetId = host.startsWith('ssh:') ? host.slice(4) : environment?.orcadDeployment?.sshTargetId;
    if (!targetId) throw new RemoteReadError('ssh');
    let workspace;
    if (environment) {
      const selectors = ['id:' + target.worktreeId, ...(target.worktreePath ? ['path:' + target.worktreePath] : [])];
      for (const selector of selectors) {
        let result;
        try { result = await rpc(['worktree', 'show', '--worktree', selector], environment.id, signal); }
        catch (e) { if (e.code === 'selector_not_found') continue; throw e; }
        const row = result.worktree;
        if (row?.id && row.path && row.isArchived !== true && (!target.worktreePath || samePath(row.path, target.worktreePath))) { workspace = row; break; }
      }
    } else {
      const listing = await orca.host.call('workspace.list', undefined, { signal });
      workspace = listing.workspaces?.find(r => r.hostId === host && r.id === target.worktreeId && (!target.worktreePath || samePath(r.path, target.worktreePath)));
    }
    if (!workspace?.path || !path.posix.isAbsolute(workspace.path) || /[\x00-\x1f\x7f]/.test(workspace.path)) throw new RemoteReadError('workspace');
    const [ssh] = await lookupSsh([targetId]), gen = environment?.orcadDeployment?.sshTargetGeneration;
    if (!ssh || (gen != null && ssh.generation !== gen)) throw new RemoteReadError('ssh');
    return { ...ssh, directory: workspace.path };
  };
}

export { launchSsh } from './orca_connection.mjs';

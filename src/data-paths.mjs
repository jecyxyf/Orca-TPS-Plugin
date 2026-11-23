import { homedir } from 'node:os';
import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export function defaultRoots({ home = homedir(), env = process.env, platform = process.platform } = {}) {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const userData = env.ORCA_USER_DATA_PATH || (platform === 'win32'
    ? join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'orca')
    : platform === 'darwin' ? join(home, 'Library', 'Application Support', 'orca')
      : join(env.XDG_CONFIG_HOME || join(home, '.config'), 'orca'));
  const data = env.XDG_DATA_HOME || join(home, '.local', 'share');
  const ccSwitchDb = env.CC_SWITCH_DB_PATH || join(home, '.cc-switch', 'cc-switch.db');
  return {
    roots: {
      codex: [env.CODEX_HOME || join(home, '.codex'), join(home, '.codex'),
        join(userData, 'codex-runtime-home', 'home')].flatMap(base => [join(base, 'sessions'), join(base, 'archived_sessions')]),
      claude: [join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects'), join(home, '.claude', 'projects')],
      opencode: [env.OPENCODE_DB && env.OPENCODE_DB !== ':memory:' ? path.isAbsolute(env.OPENCODE_DB) ? env.OPENCODE_DB : join(data, 'opencode', env.OPENCODE_DB) : join(data, 'opencode', 'opencode.db')],
      pi: [join(env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent'), 'sessions')],
      antigravity: [join(home, '.gemini', 'antigravity-cli', 'brain')],
      hermes: [env.HERMES_HOME, ...(platform === 'win32' ? [join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'hermes')] : []),
        join(home, '.hermes')].filter(Boolean)
    },
    userData,
    ccSwitchDb
  };
}

export function localUsageDatabasePath(options = {}) {
  const join = (options.platform ?? process.platform) === 'win32' ? path.win32.join : path.posix.join;
  return join(defaultRoots(options).userData, 'tps-plugin', 'usage.sqlite');
}

export function ccSwitchUsagePaths() {
  const { ccSwitchDb, userData } = defaultRoots();
  const filename = process.platform === 'win32' ? 'cc-switch-usage.exe' : 'cc-switch-usage';
  const bundled = new URL(`../native/bin/${process.platform}-${process.arch}/${filename}.gz`, import.meta.url);
  return {
    binary: process.env.ORCA_TPS_CC_SWITCH_USAGE_BIN,
    archive: fileURLToPath(bundled),
    filename,
    sourceDb: ccSwitchDb,
    stateHome: path.join(userData, 'tps-plugin', 'cc-switch-4.0.25')
  };
}

export function reportDiscoveryError(error, onUnavailable) {
  if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') onUnavailable?.();
}

export async function configuredRoots(custom = {}, includeDefaults = true, onUnavailable) {
  const defaults = defaultRoots(), roots = {};
  for (const provider of ['codex', 'claude', 'opencode', 'pi', 'antigravity', 'hermes']) {
    const values = Array.isArray(custom[provider]) ? custom[provider] : [];
    roots[provider] = [...new Set([...(includeDefaults ? defaults.roots[provider] : []), ...values]
      .filter(value => typeof value === 'string' && value.trim())
      .map(value => path.resolve(value.replace(/^~(?=$|[\\/])/, homedir()))))];
  }
  if (includeDefaults) for (const provider of ['codex', 'claude']) {
    const accountsRoot = path.join(defaults.userData, provider === 'codex' ? 'codex-accounts' : 'claude-profiles');
    try {
      const accounts = await readdir(accountsRoot, { withFileTypes: true });
      for (const entry of accounts.slice(0, 100)) if (entry.isDirectory()) {
        roots[provider].push(path.join(accountsRoot, entry.name, 'home', provider === 'codex' ? 'sessions' : 'projects'));
      }
    } catch (error) { reportDiscoveryError(error, onUnavailable); }
  }
  return roots;
}

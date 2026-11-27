import { homedir } from 'node:os';
import path from 'node:path';

// Session roots differ from record IDs for versions that share a log family.
export const SESSION_HARNESSES = Object.freeze(['codex', 'claude', 'opencode', 'pi', 'antigravity', 'hermes']);
export const MANAGER_HARNESSES = Object.freeze([
  ...SESSION_HARNESSES, 'gemini', 'grokbuild', 'mcode', 'kimi', 'omp', 'openclaw', 'claude-desktop', 'copilot', 'workbuddy', 'dsh'
]);
export const OPENCODE_V2 = 'opencode2';
const sessionIds = new Set([...SESSION_HARNESSES, OPENCODE_V2]);
const managerIds = new Set([...MANAGER_HARNESSES, OPENCODE_V2]);
const aliases = new Map([[OPENCODE_V2, 'opencode'], ['agy', 'antigravity']]);

export const isSessionHarness = value => sessionIds.has(value);
export const isManagerHarness = value => managerIds.has(value);
export const harnessFamily = value => aliases.get(value) ?? value;
export const openCodeHarness = v2 => v2 ? OPENCODE_V2 : 'opencode';

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

export function normalizeComparePath(rawPath, platform = process.platform) {
  if (typeof rawPath !== 'string') return null;
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.length > 4096 || /[\u0000\r\n]/.test(trimmed)) return null;
  const isWin = platform === 'win32' || /^[A-Za-z]:[\\/]/.test(trimmed);
  if (isWin) {
    const leadingUnc = /^[/\\]{2}/.test(trimmed) ? '\\\\' : '';
    let body = trimmed.replace(/^[/\\]+/, '').replace(/[/\\]+/g, '\\').replace(/\\+$/, '');
    const full = (leadingUnc + body).toLowerCase();
    return /^[a-z]:$/.test(full) ? `${full}\\` : full;
  }
  let norm = trimmed.replace(/\/+/g, '/');
  if (norm.length > 1) norm = norm.replace(/\/+$/, '');
  return norm;
}

/** Newest first, de-duplicated by id. Session views keep 100; usage totals pass Infinity. */
export function recentRecords(records, limit = 100) {
  return [...new Map(records.filter(Boolean).map(value => [value.id, value])).values()]
    .sort((a, b) => b.completedAt - a.completedAt).slice(0, limit);
}

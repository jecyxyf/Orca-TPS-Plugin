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

import { open } from 'node:fs/promises';
import path from 'node:path';
import { defaultRoots } from './data-paths.mjs';

const observations = new Map();
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 32768 && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const own = (value, key) => object(value) && Object.hasOwn(value, key) ? value[key] : undefined;
const list = value => Array.isArray(value) ? value : [];
const empty = message => ({ target: null, message });
const providerName = value => ['codex', 'claude', 'opencode', 'opencode2', 'pi', 'antigravity'].includes(value) ? value : null;
const family = value => value === 'opencode2' ? 'opencode' : value;

/** The packaged Orca default, also usable without APPDATA in a plugin worker. */
export function activeProfileUserData(options = {}) {
  return options.userDataPath || defaultRoots(options).userData;
}

async function readSmallJson(file, maxBytes = 256 * 1024) {
  const handle = await open(file, 'r');
  try {
    const size = (await handle.stat()).size;
    if (size > maxBytes) throw new Error('oversize');
    const buffer = Buffer.alloc(size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > size) throw new Error('changed');
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally { await handle.close(); }
}

function leafIds(root, found = [], depth = 0) {
  if (!object(root) || depth > 32 || found.length > 128) return found;
  if (root.type === 'leaf' && text(root.leafId)) found.push(root.leafId);
  else if (root.type === 'split') { leafIds(root.first, found, depth + 1); leafIds(root.second, found, depth + 1); }
  return found;
}

function channelShortTitle(worktreePath) {
  if (!worktreePath) return null;
  const withoutDrive = worktreePath.replace(/^[A-Za-z]:/, '');
  const parts = withoutDrive.split(/[\\/]+/).filter(Boolean);
  if (!parts.length) return null;
  if (parts.length === 1) return parts[0].slice(0, 200);
  if (parts.length === 2 && ['users', 'home', 'workspace'].includes(parts[0].toLowerCase())) {
    return parts[1].slice(0, 200);
  }
  return parts.slice(-2).join('/').slice(0, 200);
}

/**
 * Pure channel selection: resolves the active project channel (worktree) and collects
 * all validated local terminal pane sessions in that channel plus its worktree path.
 */
export function selectActiveConversation(state, options = {}) {
  const w = text(state?.activeWorktreeId);
  if (!w) return empty('当前没有打开对话。');
  const host = state.activeWorkspaceExecutionHostId;
  if (host != null && host !== 'local') return empty('当前是远程对话，暂不读取远程统计。');
  const workspaceKey = text(state.activeWorkspaceKey);
  if (workspaceKey && workspaceKey !== `worktree:${w}`) return empty('当前工作区状态尚未同步。');

  const pathApi = (options.platform || process.platform) === 'win32' ? path.win32 : path.posix;
  const sepIdx = w.indexOf('::');
  const rawWorktreePath = sepIdx >= 0 ? text(w.slice(sepIdx + 2)) : null;
  let worktreePath = rawWorktreePath && pathApi.isAbsolute(rawWorktreePath) ? rawWorktreePath : null;

  const unified = list(own(state.unifiedTabs, w));
  const tabs = list(own(state.tabsByWorktree, w));
  const history = options.observations || observations;
  const sessions = [], seenSessions = new Set(), paneCwds = new Set();
  let fallbackTitle = null;

  for (const tab of tabs) {
    if (!object(tab) || !text(tab.id) || tab.worktreeId !== w) continue;
    if (tab.executionHostId != null && tab.executionHostId !== 'local') continue;
    const tabId = tab.id;
    const layout = own(state.terminalLayoutsByTabId, tabId);
    const leaves = leafIds(layout?.root);
    if (!leaves.length) continue;
    const unifiedTab = unified.find(value => value?.entityId === tabId && value?.contentType === 'terminal');

    for (const leafId of leaves) {
      const paneKey = `${tabId}:${leafId}`;
      const record = own(state.sleepingAgentSessionsByPaneKey, paneKey);
      if (!object(record) || record.paneKey !== paneKey || record.worktreeId !== w || (record.tabId != null && record.tabId !== tabId)) {
        continue;
      }
      if (record.connectionId != null) continue;
      const provider = providerName(record.agent), sessionId = text(record.providerSession?.id);
      if (!provider || !sessionId || sessionId.length > 512) continue;

      const titleMetadata = [tab.aiVaultTitle, unifiedTab?.aiVaultTitle].filter(object);
      if (leaves.length === 1 && titleMetadata.some(meta =>
        (text(meta.sessionId) && meta.sessionId !== sessionId) ||
        (text(meta.agent) && family(meta.agent) !== family(provider))
      )) {
        continue;
      }

      const capturedAt = Number.isFinite(record.capturedAt) ? record.capturedAt : 0;
      if (Number.isFinite(tab.createdAt) && capturedAt && tab.createdAt > capturedAt) continue;

      const stampKey = JSON.stringify([options.userDataPath || '', options.profileId || '', w, tabId, leafId]);
      const incarnation = text(own(state.terminalPtyIncarnationsByPaneKey, paneKey)) || text(own(layout?.ptyIdsByLeafId, leafId)) || null;
      const prior = history.get(stampKey);
      const signature = `${provider}:${sessionId}`;
      const priorCapture = Number.isFinite(prior?.capturedAt) ? prior.capturedAt : 0;
      let pendingCaptureBaseline = prior?.pendingCaptureBaseline ?? null;
      if (prior && prior.incarnation !== incarnation && signature === prior.signature) pendingCaptureBaseline = priorCapture;
      if (prior && signature !== prior.signature) pendingCaptureBaseline = null;
      if (pendingCaptureBaseline !== null && capturedAt > pendingCaptureBaseline) pendingCaptureBaseline = null;
      const highestCapture = prior && signature === prior.signature ? Math.max(capturedAt, priorCapture) : capturedAt;
      history.set(stampKey, { incarnation, signature, capturedAt: highestCapture, pendingCaptureBaseline });
      while (history.size > 128) history.delete(history.keys().next().value);
      if (pendingCaptureBaseline !== null) continue;

      const transcriptPath = text(record.providerSession?.transcriptPath);
      if (transcriptPath && !pathApi.isAbsolute(transcriptPath)) continue;
      const entry = { provider, sessionId };
      if (transcriptPath) {
        if (family(provider) === 'opencode' && /\.(?:db|sqlite|sqlite3)$/i.test(transcriptPath)) entry.dbPath = transcriptPath;
        else if (/\.jsonl$/i.test(transcriptPath)) entry.transcriptPath = transcriptPath;
        else continue;
      }

      const dedupKey = `${provider}:${sessionId}`;
      if (!seenSessions.has(dedupKey)) {
        seenSessions.add(dedupKey);
        sessions.push(entry);
      }

      const paneCwd = text(record.providerSession?.cwd);
      if (paneCwd && pathApi.isAbsolute(paneCwd)) paneCwds.add(paneCwd);
      fallbackTitle ??= text(tab.customTitle) || (leaves.length === 1 ? text(tab.aiVaultTitle?.title) : null) || text(record.terminalTitle);
    }
  }

  if (!worktreePath && paneCwds.size === 1) worktreePath = [...paneCwds][0];
  if (!worktreePath && !sessions.length) return empty('当前频道暂无可统计的对话。');

  const target = {
    key: JSON.stringify([options.userDataPath || '', options.profileId || '', w, worktreePath || '']),
    worktreeId: w,
    ...(worktreePath ? { worktreePath } : {}),
    sessions
  };
  const title = channelShortTitle(worktreePath) || fallbackTitle;
  if (title) target.title = title.slice(0, 200);
  return { target };
}

const MAX_STATE_BYTES = 8 * 1024 * 1024;
const hasTable = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
const hasColumn = (db, table, column) => db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column);

/**
 * Newer Orca builds keep workspaceSession as per-key rows in profile_state_document_parts and only
 * rewrite the legacy document occasionally. Like Orca's own reader, the parts are authoritative only
 * when their legacy_revision matches the legacy document's revision; otherwise return null.
 */
function readWorkspaceParts(db) {
  if (!hasTable(db, 'profile_state_document_parts') || !hasTable(db, 'profile_state_document_parts_meta')
    || !hasColumn(db, 'profile_state_documents', 'revision')) return null;
  const meta = db.prepare("SELECT legacy_revision FROM profile_state_document_parts_meta WHERE domain='workspaceSession'").get();
  const legacy = db.prepare("SELECT revision FROM profile_state_documents WHERE domain='workspaceSession'").get();
  if (!Number.isSafeInteger(meta?.legacy_revision) || meta.legacy_revision !== legacy?.revision) return null;
  const rows = db.prepare("SELECT part_key, payload FROM profile_state_document_parts WHERE domain='workspaceSession' ORDER BY ordinal").all();
  if (!rows.length) return null;
  let bytes = 0, state = {};
  for (const row of rows) {
    bytes += row.part_key.length + row.payload.length;
    if (bytes > MAX_STATE_BYTES) return null;
    const keys = JSON.parse(row.part_key), value = JSON.parse(row.payload);
    if (!Array.isArray(keys) || keys.length > 8 || !keys.every(key => typeof key === 'string')) return null;
    if (!keys.length) { state = value; continue; }
    let node = state;
    for (const key of keys.slice(0, -1)) {
      if (!object(own(node, key))) Object.defineProperty(node, key, { value: {}, enumerable: true, writable: true, configurable: true });
      node = node[key];
    }
    Object.defineProperty(node, keys.at(-1), { value, enumerable: true, writable: true, configurable: true });
  }
  return object(state);
}

/**
 * Cheap change marker for workspaceSession: Orca bumps these revisions on every save, so an
 * unchanged stamp means the selection cannot have changed. Null when the schema has no revisions.
 */
function workspaceStamp(db) {
  if (!hasColumn(db, 'profile_state_documents', 'revision')) return null;
  const legacy = db.prepare("SELECT revision FROM profile_state_documents WHERE domain='workspaceSession'").get();
  const parts = hasTable(db, 'profile_state_document_parts_meta')
    ? db.prepare("SELECT revision, legacy_revision FROM profile_state_document_parts_meta WHERE domain='workspaceSession'").get()
    : null;
  return JSON.stringify([legacy?.revision ?? null, parts?.revision ?? null, parts?.legacy_revision ?? null]);
}

let lastSelection = null;
const copySelection = result => result.target
  ? { ...result, target: { ...result.target, sessions: (result.target.sessions ?? []).map(item => ({ ...item })) } }
  : { ...result };

/** Reads one committed SQLite snapshot per poll, including live WAL; never writes Orca state. */
export async function readActiveConversation(options = {}) {
  const userDataPath = activeProfileUserData(options);
  let profileId;
  for (const suffix of ['', '.bak']) {
    try {
      const index = await readSmallJson(path.join(userDataPath, `orca-profile-index.json${suffix}`));
      if (typeof index?.activeProfileId === 'string' && PROFILE_ID.test(index.activeProfileId) && list(index.profiles).some(profile => profile?.id === index.activeProfileId)) {
        profileId = index.activeProfileId; break;
      }
    } catch { /* The official resolver also accepts a valid backup index. */ }
  }
  if (!profileId) return empty('无法识别 Orca 当前配置。');
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); }
  catch { return empty('当前运行时不支持 SQLite，无法识别当前对话。'); }
  let db;
  try {
    db = new DatabaseSync(path.join(userDataPath, 'profiles', profileId, 'profile-state.db'), { readOnly: true, enableExtensionLoading: false });
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=100;');
    // One read transaction so the stamp, the legacy document and its parts come from the same commit.
    db.exec('BEGIN');
    const revision = workspaceStamp(db);
    const cacheKey = revision && JSON.stringify([userDataPath, profileId, options.platform || process.platform, revision]);
    if (cacheKey && lastSelection?.key === cacheKey) return copySelection(lastSelection.result);
    let state = null;
    try { state = readWorkspaceParts(db); }
    catch { state = null; }
    if (!state) {
      const row = db.prepare(`SELECT payload FROM profile_state_documents WHERE domain='workspaceSession' AND length(payload)<=${MAX_STATE_BYTES}`).get();
      if (!row) return empty('Orca 尚未保存当前工作区状态。');
      state = JSON.parse(row.payload);
    }
    if (!object(state)) return empty('Orca 当前工作区状态无效。');
    const result = selectActiveConversation(state, { ...options, userDataPath, profileId });
    lastSelection = cacheKey ? { key: cacheKey, result: copySelection(result) } : null;
    return result;
  } catch { return empty('暂时无法读取 Orca 当前对话。'); }
  finally {
    try { if (db?.isTransaction) db.exec('COMMIT'); } catch { /* read-only snapshot */ }
    db?.close();
  }
}

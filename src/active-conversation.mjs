import { open } from 'node:fs/promises';
import path from 'node:path';
import { sourceMessage } from './locales.mjs';
import { harnessFamily, isSessionHarness } from './harnesses.mjs';
import { defaultRoots } from './harness_parser.mjs';

const observations = new Map();
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const text = v => typeof v === 'string' && v.length > 0 && v.length <= 32768 && !/[\u0000-\u001f\u007f]/.test(v) ? v : null;
const object = v => v && typeof v === 'object' && !Array.isArray(v) ? v : null;
const own = (v, k) => object(v) && Object.hasOwn(v, k) ? v[k] : undefined;
const list = v => Array.isArray(v) ? v : [];
const empty = id => ({ target: null, notice: [id] });
const providerName = v => isSessionHarness(v) ? v : null;

export const activeProfileUserData = (options = {}) => options.userDataPath || defaultRoots(options).userData;

async function readSmallJson(file, maxBytes = 256 * 1024) {
  const handle = await open(file, 'r');
  try {
    const size = (await handle.stat()).size;
    if (size > maxBytes) throw new Error('oversize');
    const buf = Buffer.alloc(size + 1), { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    if (bytesRead > size) throw new Error('changed');
    return JSON.parse(buf.subarray(0, bytesRead).toString('utf8'));
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
  const parts = worktreePath.replace(/^[A-Za-z]:/, '').split(/[\\/]+/).filter(Boolean);
  if (!parts.length) return null;
  if (parts.length === 1) return parts[0].slice(0, 200);
  if (parts.length === 2 && ['users', 'home', 'workspace'].includes(parts[0].toLowerCase())) return parts[1].slice(0, 200);
  return parts.slice(-2).join('/').slice(0, 200);
}

export function selectActiveConversation(state, options = {}) {
  const w = text(state?.activeWorktreeId);
  if (!w) return empty('notice.no-conversation');
  const host = state.activeWorkspaceExecutionHostId ?? 'local';
  const remote = typeof host === 'string' && /^(?:runtime|ssh):[^\s]+$/.test(host);
  if (host !== 'local' && (!remote || !options.includeRemote)) return empty('notice.remote-conversation');
  const workspaceKey = text(state.activeWorkspaceKey);
  if (workspaceKey && workspaceKey !== `worktree:${w}`) return empty('notice.workspace-sync');

  const pathApi = (options.platform || process.platform) === 'win32' ? path.win32 : path.posix;
  const sepIdx = w.indexOf('::'), rawWorktreePath = sepIdx >= 0 ? text(w.slice(sepIdx + 2)) : null;
  const absolute = v => v && (remote ? path.posix.isAbsolute(v) || path.win32.isAbsolute(v) : pathApi.isAbsolute(v));
  let worktreePath = absolute(rawWorktreePath) ? rawWorktreePath : null;

  const unified = list(own(state.unifiedTabs, w)), tabs = list(own(state.tabsByWorktree, w));
  const history = options.observations || observations, sessions = [], seenSessions = new Set(), paneCwds = new Set();
  let fallbackTitle = null;

  for (const tab of tabs) {
    if (!object(tab) || !text(tab.id) || tab.worktreeId !== w || (tab.executionHostId != null && tab.executionHostId !== host)) continue;
    const tabId = tab.id, layout = own(state.terminalLayoutsByTabId, tabId), leaves = leafIds(layout?.root);
    if (!leaves.length) continue;
    const unifiedTab = unified.find(v => v?.entityId === tabId && v?.contentType === 'terminal');

    for (const leafId of leaves) {
      const paneKey = `${tabId}:${leafId}`, record = own(state.sleepingAgentSessionsByPaneKey, paneKey);
      if (!object(record) || record.paneKey !== paneKey || record.worktreeId !== w || (record.tabId != null && record.tabId !== tabId)) continue;
      if (record.executionHostId != null && record.executionHostId !== host) continue;
      const sameRemote = (record.connectionId != null && host === `ssh:${record.connectionId}`) ||
        record.executionHostId === host || (record.connectionId == null && tab.executionHostId === host);
      if (remote ? !sameRemote : record.connectionId != null) continue;
      const provider = providerName(record.agent), sessionId = text(record.providerSession?.id);
      if (!provider || !sessionId || sessionId.length > 512) continue;

      const titleMeta = [tab.aiVaultTitle, unifiedTab?.aiVaultTitle].filter(object);
      if (leaves.length === 1 && titleMeta.some(m => (text(m.sessionId) && m.sessionId !== sessionId) ||
          (text(m.agent) && harnessFamily(m.agent) !== harnessFamily(provider)))) continue;
      const capturedAt = Number.isFinite(record.capturedAt) ? record.capturedAt : 0;
      if (Number.isFinite(tab.createdAt) && capturedAt && tab.createdAt > capturedAt) continue;

      const stampKey = JSON.stringify([options.userDataPath || '', options.profileId || '', host, w, tabId, leafId]);
      const incarnation = text(own(state.terminalPtyIncarnationsByPaneKey, paneKey)) || text(own(layout?.ptyIdsByLeafId, leafId)) || null;
      const prior = history.get(stampKey), signature = `${provider}:${sessionId}`, priorCapture = Number.isFinite(prior?.capturedAt) ? prior.capturedAt : 0;
      let pendingBaseline = prior?.pendingCaptureBaseline ?? null;
      if (prior && prior.incarnation !== incarnation && signature === prior.signature) pendingBaseline = priorCapture;
      if (prior && signature !== prior.signature) pendingBaseline = null;
      if (pendingBaseline !== null && capturedAt > pendingBaseline) pendingBaseline = null;
      history.set(stampKey, { incarnation, signature, capturedAt: prior && signature === prior.signature ? Math.max(capturedAt, priorCapture) : capturedAt, pendingCaptureBaseline: pendingBaseline });
      while (history.size > 128) history.delete(history.keys().next().value);
      if (pendingBaseline !== null) continue;

      const transcriptPath = provider === 'hermes' ? null : text(record.providerSession?.transcriptPath);
      if (transcriptPath && !absolute(transcriptPath)) continue;
      const entry = { provider, sessionId };
      if (transcriptPath) {
        if (harnessFamily(provider) === 'opencode' && /\.(?:db|sqlite|sqlite3)$/i.test(transcriptPath)) entry.dbPath = transcriptPath;
        else if (/\.jsonl$/i.test(transcriptPath)) entry.transcriptPath = transcriptPath;
        else continue;
      }
      if (!seenSessions.has(signature)) { seenSessions.add(signature); sessions.push(entry); }
      const paneCwd = text(record.providerSession?.cwd);
      if (absolute(paneCwd)) paneCwds.add(paneCwd);
      fallbackTitle ??= text(tab.customTitle) || (leaves.length === 1 ? text(tab.aiVaultTitle?.title) : null) || text(record.terminalTitle);
    }
  }
  if (!worktreePath && paneCwds.size === 1) worktreePath = [...paneCwds][0];
  if (!remote && !worktreePath && !sessions.length) return empty('notice.channel-empty');
  const title = channelShortTitle(worktreePath) || fallbackTitle;
  return {
    target: {
      key: JSON.stringify([options.userDataPath || '', options.profileId || '', w, worktreePath || '', ...(remote ? [host] : [])]),
      worktreeId: w, ...(remote ? { executionHostId: host } : {}), ...(worktreePath ? { worktreePath } : {}), sessions,
      ...(title ? { title: title.slice(0, 200) } : {})
    }
  };
}

export function selectOpenChannels(state, byHost, options, active = selectActiveConversation(state, options).target) {
  const channels = new Map(), userTab = tab => (tab?.customTitle ?? tab?.title ?? tab?.label) !== sourceMessage('selector.remote-tab-title');
  if (active) channels.set(active.key, active);
  for (const [host, workspace] of [['local', state], ...Object.entries(byHost ?? {})]) {
    if (!object(workspace) || (host !== 'local' && !/^(?:runtime|ssh):[^\s]+$/.test(host))) continue;
    const ids = new Set(list(workspace.activeWorktreeIdsOnShutdown).filter(text));
    for (const groups of [workspace.tabsByWorktree, workspace.unifiedTabs]) {
      for (const [id, tabs] of Object.entries(groups ?? {})) {
        if (list(tabs).some(tab => userTab(tab) && (!tab?.executionHostId || tab.executionHostId === host))) ids.add(id);
      }
    }
    for (const id of ids) {
      if (host === 'local' && workspace === state && active?.executionHostId && id === active.worktreeId) continue;
      const target = selectActiveConversation({ ...workspace, activeWorktreeId: id, activeWorkspaceKey: 'worktree:' + id, activeWorkspaceExecutionHostId: host }, options).target;
      if (target && !channels.has(target.key)) channels.set(target.key, target);
    }
  }
  return [...channels.values()];
}

const hasTable = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
const hasColumn = (db, table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some(r => r.name === col);

function readWorkspaceParts(db, domain) {
  if (!hasTable(db, 'profile_state_document_parts') || !hasTable(db, 'profile_state_document_parts_meta') ||
      !hasColumn(db, 'profile_state_documents', 'revision')) return null;
  const meta = db.prepare('SELECT legacy_revision FROM profile_state_document_parts_meta WHERE domain=?').get(domain);
  const legacy = db.prepare('SELECT revision FROM profile_state_documents WHERE domain=?').get(domain);
  if (!Number.isSafeInteger(meta?.legacy_revision) || meta.legacy_revision !== legacy?.revision) return null;
  const rows = db.prepare('SELECT part_key, payload FROM profile_state_document_parts WHERE domain=? ORDER BY ordinal').all(domain);
  if (!rows.length) return null;
  let bytes = 0, state = {};
  for (const row of rows) {
    if ((bytes += row.part_key.length + row.payload.length) > MAX_STATE_BYTES) return null;
    const keys = JSON.parse(row.part_key), value = JSON.parse(row.payload);
    if (!Array.isArray(keys) || keys.length > 8 || !keys.every(k => typeof k === 'string')) return null;
    if (!keys.length) { state = value; continue; }
    let node = state;
    for (const k of keys.slice(0, -1)) {
      if (!object(own(node, k))) Object.defineProperty(node, k, { value: {}, enumerable: true, writable: true, configurable: true });
      node = node[k];
    }
    Object.defineProperty(node, keys.at(-1), { value, enumerable: true, writable: true, configurable: true });
  }
  return object(state);
}

function workspaceDocument(db, domain) {
  try { const parts = readWorkspaceParts(db, domain); if (parts) return parts; } catch {}
  const row = db.prepare('SELECT payload FROM profile_state_documents WHERE domain=? AND length(payload)<=?').get(domain, MAX_STATE_BYTES);
  return row ? JSON.parse(row.payload) : null;
}

let lastSelection = null;
const copyTarget = t => t && { ...t, sessions: t.sessions.map(i => ({ ...i })) };
const copySelection = r => ({ ...r, target: copyTarget(r.target), ...(r.notice ? { notice: [...r.notice] } : {}), ...(r.openTargets ? { openTargets: r.openTargets.map(copyTarget) } : {}) });

export async function readOrcaProfile(options = {}) {
  const userDataPath = activeProfileUserData(options);
  for (const suffix of ['', '.bak']) {
    try {
      const index = await readSmallJson(path.join(userDataPath, `orca-profile-index.json${suffix}`));
      if (typeof index?.activeProfileId === 'string' && PROFILE_ID.test(index.activeProfileId) && list(index.profiles).some(p => p?.id === index.activeProfileId)) {
        return { userDataPath, profileId: index.activeProfileId, stateFile: path.join(userDataPath, 'profiles', index.activeProfileId, 'profile-state.db') };
      }
    } catch {}
  }
  return null;
}

export async function readActiveConversation(options = {}) {
  const profile = await readOrcaProfile(options);
  if (!profile) return empty('notice.profile-unavailable');
  const { userDataPath, profileId, stateFile } = profile;
  let openReadonlyDatabase;
  try { ({ openReadonlyDatabase } = await import('./sqlite.mjs')); } catch { return empty('notice.conversation-sqlite-unavailable'); }
  let db;
  try {
    db = openReadonlyDatabase(stateFile);
    db.exec('BEGIN');
    const domains = options.includeOpen ? ['workspaceSession', 'workspaceSessionsByHostId'] : ['workspaceSession'];
    let revision = null;
    if (hasColumn(db, 'profile_state_documents', 'revision')) {
      const leg = db.prepare('SELECT revision FROM profile_state_documents WHERE domain=?');
      const parts = hasTable(db, 'profile_state_document_parts_meta') ? db.prepare('SELECT revision, legacy_revision FROM profile_state_document_parts_meta WHERE domain=?') : null;
      revision = JSON.stringify(domains.map(d => [leg.get(d), parts?.get(d)]));
    }
    const cacheKey = revision && JSON.stringify([userDataPath, profileId, options.platform || process.platform, Boolean(options.includeRemote), Boolean(options.includeOpen), revision]);
    if (cacheKey && lastSelection?.key === cacheKey) return copySelection(lastSelection.result);
    const state = workspaceDocument(db, 'workspaceSession');
    if (!state) return empty('notice.workspace-unsaved');
    if (!object(state)) return empty('notice.workspace-invalid');
    const selOpts = { ...options, userDataPath, profileId }, result = selectActiveConversation(state, selOpts);
    if (options.includeOpen) {
      let byHost;
      try { byHost = workspaceDocument(db, 'workspaceSessionsByHostId'); } catch {}
      result.openTargets = selectOpenChannels(state, byHost, selOpts, result.target);
    }
    lastSelection = cacheKey ? { key: cacheKey, result: copySelection(result) } : null;
    return result;
  } catch { return empty('notice.orca-read-failed'); }
  finally {
    try { if (db?.isTransaction) db.exec('COMMIT'); } catch {}
    db?.close();
  }
}

import { execFile } from 'node:child_process';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { discoverUsageUnits, normalizeComparePath, readTargetSession } from './data.mjs';
import { HOUR_MS } from './leaderboard-stats.mjs';
import { RETENTION_DAYS } from './tokens-manager-db.mjs';

const exec = promisify(execFile), inflate = promisify(gunzip);
const adaptedProviders = new Set(['codex', 'claude', 'pi', 'opencode', 'opencode2', 'agy', 'antigravity', 'hermes']);
const dayMs = 24 * HOUR_MS;
const scannerName = process.platform === 'win32' ? 'tokens-manager-scan.exe' : 'tokens-manager-scan';
export const scannerArchive = `native/bin/${process.platform}-${process.arch}/${scannerName}.gz`;

async function prepareScanner(root) {
  const binary = process.env.ORCA_TPS_MANAGER_SCANNER || path.join(root, 'bin', scannerName);
  try { await access(binary); return binary; } catch {}
  const archive = new URL('../' + scannerArchive, import.meta.url);
  const packed = await readFile(archive).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (!packed) return null;
  const candidate = binary + '.' + process.pid + '.next';
  await writeFile(candidate, await inflate(packed), { mode: 0o700 });
  await rename(candidate, binary);
  return binary;
}

const projectKey = (provider, session) => JSON.stringify([provider, session]);

function nativeRecord(row, projects) {
  const provider = row.app_type;
  const inclusive = ['codex', 'gemini', 'grokbuild'].includes(provider) && row.input_token_semantics !== 2;
  const cacheCreationTokens = row.cache_creation_tokens;
  const cacheReadTokens = row.cache_read_tokens;
  const freshInputTokens = Math.max(0, row.input_tokens -
    (inclusive ? cacheReadTokens + (row.input_token_semantics === 1 ? cacheCreationTokens : 0) : 0));
  const latency = row.duration_ms || row.latency_ms;
  const firstTokenMs = row.first_token_ms;
  const estimate = firstTokenMs == null;
  const generationMs = estimate ? latency : latency - firstTokenMs;
  const tokensPerSecond = generationMs > 0 && row.output_tokens >= (estimate ? 200 : 100)
    ? row.output_tokens * 1000 / generationMs : null;
  return { id: row.request_id, provider, model: row.pricing_model || row.model, sessionId: row.session_id,
    cwd: projects.get(projectKey(provider, row.session_id)),
    completedAt: row.created_at * 1000, freshInputTokens, outputTokens: row.output_tokens,
    cacheReadTokens, cacheCreationTokens, durationMs: latency, firstTokenMs, tokensPerSecond, isEstimatedSpeed: estimate };
}

async function scanNative(root, db, cutoff, at, signal) {
  const binary = await prepareScanner(root);
  if (!binary) return;
  // A timezone rebuild gets a fresh upstream cursor, including records already aged out of the scan cache.
  const directory = path.join(root, 'cc-switch-scan');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const databaseDirectory = path.join(directory, '.cc-switch');
  await mkdir(databaseDirectory, { recursive: true, mode: 0o700 });
  const name = path.join(databaseDirectory, 'cc-switch.db');
  const generation = db.setting('generation');
  const knownProjects = db.setting('nativeProjects', []);
  const projects = new Map(knownProjects);
  if (db.sourceStamp('cc-switch') !== generation) {
    const cache = new DatabaseSync(name);
    try {
      cache.exec('DROP TABLE IF EXISTS session_log_sync; DROP TABLE IF EXISTS session_usage_dedup; DROP TABLE IF EXISTS proxy_request_logs;');
    }
    finally { cache.close(); }
  }
  const { stdout } = await exec(binary, [], {
    signal, timeout: 600_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true,
    env: { ...process.env, ORCA_TPS_SCAN_HOME: directory,
      ...(db.sourceStamp('cc-switch') !== generation ? { ORCA_TPS_SCAN_PROJECTS: '1' } : {}) }
  });
  const metadata = JSON.parse(stdout).projects ?? [];
  for (const [provider, session, directory] of metadata) projects.set(projectKey(provider, session), directory);
  const source = new DatabaseSync(name, { enableExtensionLoading: false });
  try {
    const providers = [...adaptedProviders];
    const rows = source.prepare(`SELECT * FROM proxy_request_logs WHERE created_at >= ? AND status_code BETWEEN 200 AND 299
      AND app_type NOT IN (${providers.map(() => '?').join(',')}) ORDER BY created_at, request_id`
    ).iterate(Math.floor(cutoff / 1000), ...providers);
    const used = new Set();
    let batch = [];
    for (const row of rows) {
      batch.push(nativeRecord(row, projects));
      used.add(projectKey(row.app_type, row.session_id));
      if (batch.length >= 512) {
        db.commitSource('cc-switch', generation, batch, at);
        batch = [];
      }
    }
    db.commitSource('cc-switch', generation, batch, at);
    db.saveSetting('nativeProjects', [...projects].filter(([key]) => used.has(key)));
    source.prepare('DELETE FROM proxy_request_logs WHERE created_at < ?').run(Math.floor((at - 31 * dayMs) / 1000));
  } finally { source.close(); }
}

export async function scanTokens(root, db, { at = Date.now(), signal, progress = () => {} } = {}) {
  const cutoff = Date.parse(db.calendar.dayAgo(at, RETENTION_DAYS - 1)) - dayMs;
  const collection = await discoverUsageUnits(cutoff, { includeRecords: true });
  let done = 0;
  progress({ done, total: collection.length + 1 });
  for (const source of collection) {
    signal?.throwIfAborted();
    if (db.sourceStamp(source.key) !== source.stamp) {
      const result = await source.read().catch(() => null);
      if (result?.complete || result?.records?.length) {
        db.commitSource(source.key, result.complete ? source.stamp : null, result.records, at);
      }
    }
    done++;
    if (done === collection.length || done % 20 === 0) progress({ done, total: collection.length + 1 });
  }
  await scanNative(root, db, cutoff, at, signal);
  db.finishScan(at);
  progress({ done: collection.length + 1, total: collection.length + 1 });
}

export async function readManagerChannel(db, target) {
  const aliases = new Map([['agy', 'antigravity'], ['opencode2', 'opencode']]);
  const provider = value => aliases.get(value) ?? value;
  const sessions = new Set((target.sessions ?? []).map(session => JSON.stringify([provider(session.provider), session.sessionId])));
  const cwd = normalizeComparePath(target.worktreePath);
  const matches = row => (cwd && normalizeComparePath(row.cwd) === cwd) ||
    sessions.has(JSON.stringify([provider(row.provider), row.sessionId]));
  const records = db.details().filter(matches).slice(0, 100);
  const fallback = records.length < 100 ? await readTargetSession(target, { ccSwitchDb: null }).catch(() => null) : null;
  const combined = new Map();
  for (const row of [...(fallback?.session?.records ?? []), ...records]) {
    combined.set(JSON.stringify([provider(row.provider), row.id, row.completedAt]), row);
  }
  const display = [...combined.values()].sort((a, b) => b.completedAt - a.completedAt).slice(0, 100)
    .map(({ cwd, project, sessionId, ...record }) => record);
  return { session: {
    id: `channel:${target.worktreeId || target.key || 'active'}`, provider: 'channel', title: target.title,
    updatedAt: Date.now(), records: display
  }, warnings: [] };
}

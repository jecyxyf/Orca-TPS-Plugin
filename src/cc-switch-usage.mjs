import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as sqlite from 'node:sqlite';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { ccSwitchUsagePaths } from './data-paths.mjs';
import { HOUR_MS } from './leaderboard-stats.mjs';
import { HISTORY_DAYS, ROW_LIMIT, WINDOWS, cacheHitRate, localDayKey, localHourStart } from './usage-summary.mjs';

const REVISION = 'a3eafa408ae679db2e3401fca767ed2b89d9a2b2';
export const CC_SWITCH_APPS = ['antigravity', 'claude', 'codex', 'dsh', 'gemini', 'grokbuild', 'kimi', 'mcode', 'omp', 'opencode', 'opencode2', 'pi'];
const counters = ['requests', 'freshInput', 'output', 'cacheRead', 'cacheWrite', 'tokens'];
const scopeName = /^snapshot-[a-zA-Z0-9]+$/;

const missing = error => error.code === 'ENOENT' || error.code === 'ENOTDIR';
const optional = async operation => operation.catch(error => {
  if (!missing(error)) throw error;
  return null;
});

export async function openCcSwitchUsage(paths = ccSwitchUsagePaths()) {
  if (await optional(access(paths.binary ?? paths.archive, paths.binary ? constants.X_OK : constants.R_OK)) === null) return null;
  const { sourceDb, stateHome } = paths;
  await mkdir(stateHome, { recursive: true, mode: 0o700 });
  const root = await realpath(stateHome);
  const binary = paths.binary ?? await unpackHelper(paths.archive, root, paths.filename);
  const manifest = path.join(root, 'active.json');
  const saved = await optional(readFile(manifest, 'utf8'));
  let active = saved ? JSON.parse(saved) : null;
  if (active && !scopeName.test(active.name)) throw new Error('Invalid CC Switch usage snapshot directory');
  let pending;

  async function removeSnapshot(name) {
    if (!scopeName.test(name)) return;
    const target = await optional(realpath(path.join(root, name)));
    if (target && path.dirname(target) === root && path.basename(target) === name) {
      await rm(target, { force: true, recursive: true });
    }
  }

  async function sourceStamp() {
    const file = await optional(stat(sourceDb));
    if (!file?.isFile()) return null;
    const wal = await optional(stat(`${sourceDb}-wal`));
    return JSON.stringify([file.ino, file.size, file.mtimeMs, wal?.size, wal?.mtimeMs]);
  }

  async function snapshotSource(home) {
    const dir = path.join(home, '.cc-switch');
    await mkdir(dir, { mode: 0o700 });
    const db = new sqlite.DatabaseSync(sourceDb, { readOnly: true });
    try {
      const output = path.join(dir, 'cc-switch.db');
      if (sqlite.backup) await sqlite.backup(db, output);
      else db.prepare('VACUUM INTO ?').run(output);
    } finally { db.close(); }
  }

  async function refresh(at, { signal, appType } = {}) {
    const stamp = await sourceStamp();
    const found = active && await optional(stat(path.join(root, active.name)));
    const candidate = !found || (stamp !== null && stamp !== active.stamp)
      ? path.basename(await mkdtemp(path.join(root, 'snapshot-'))) : null;
    const home = path.join(root, candidate ?? active.name);
    try {
      if (candidate && stamp !== null) await snapshotSource(home);
      const result = await query(binary, home, usageQuery(at, appType), signal);
      const summary = mapSummary(result, at);
      signal?.throwIfAborted();
      if (candidate) {
        const previous = active;
        const next = { name: candidate, stamp };
        const temporary = path.join(root, `${candidate}.json`);
        await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
        await rename(temporary, manifest);
        active = next;
        if (previous) await removeSnapshot(previous.name).catch(() => {});
      }
      return summary;
    } catch (error) {
      if (candidate && active?.name !== candidate) await removeSnapshot(candidate).catch(() => {});
      throw error;
    }
  }

  return {
    refresh(at, options) {
      pending ??= refresh(at, options).finally(() => { pending = undefined; });
      return pending;
    },
    drained: () => pending?.catch(() => {})
  };
}

async function unpackHelper(archive, root, filename) {
  const packed = await readFile(archive);
  const digest = createHash('sha256').update(packed).digest('hex').slice(0, 16);
  const binary = path.join(root, `${digest}-${filename}`);
  if (await optional(access(binary, constants.X_OK)) !== null) return binary;
  const temporary = path.join(root, `${randomUUID()}.next`);
  try {
    await pipeline(Readable.from([packed]), createGunzip(), createWriteStream(temporary, { mode: 0o700 }));
    await rename(temporary, binary);
    return binary;
  } finally { await optional(rm(temporary)); }
}

function query(binary, home, request, signal) {
  return new Promise((resolve, reject) => {
    const child = execFile(binary, [], {
      env: { ...process.env, ORCA_TPS_CC_SWITCH_HOME: home },
      windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024, signal
    }, (error, output, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message, { cause: error }));
        return;
      }
      try { resolve(JSON.parse(output)); } catch (failure) { reject(failure); }
    });
    child.stdin?.on('error', () => { /* execFile reports the exit or spawn failure. */ });
    child.stdin?.end(JSON.stringify(request));
  });
}

function usageQuery(at, appType) {
  const date = new Date(at);
  const midnight = offset => new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset).getTime();
  const cutoff = localHourStart(at);
  const range = (name, from, toExclusive) => ({ name, startDate: Math.ceil(from / 1000), endDate: Math.floor((toExclusive - 1) / 1000) });
  const windows = WINDOWS.flatMap(([name, days]) => [
    range(name, midnight(1 - days), at + 1),
    range(`hourly:${name}`, cutoff - days * 24 * HOUR_MS, cutoff)
  ]);
  const days = Array.from({ length: HISTORY_DAYS }, (_, index) => {
    const offset = index - HISTORY_DAYS + 1;
    const start = midnight(offset);
    return range(localDayKey(start), start, Math.min(midnight(offset + 1), at + 1));
  });
  return { windows, days, appType, modelLimit: ROW_LIMIT };
}

function mapCounters(usage) {
  const values = {
    requests: usage.totalRequests, freshInput: usage.totalInputTokens, output: usage.totalOutputTokens,
    cacheRead: usage.totalCacheReadTokens, cacheWrite: usage.totalCacheCreationTokens, tokens: usage.realTotalTokens
  };
  if (!Object.values(values).every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('Invalid CC Switch usage counters');
  return values;
}

function mapSummary(result, at) {
  if (result.revision !== REVISION) throw new Error('Unexpected CC Switch usage engine version');
  const mapWindow = name => {
    const { summary, rows, hiddenRows } = result.windows[name];
    return {
      ...mapCounters(summary), cacheHitRate: summary.cacheHitRate, hiddenRows,
      rows: rows.map(({ appType, model, usage }) => ({ provider: appType, model, ...mapCounters(usage) }))
    };
  };
  return {
    source: 'cc-switch-4.0.25', updatedAt: at, daily: result.daily,
    windows: Object.fromEntries(WINDOWS.map(([name]) => [name, mapWindow(name)])),
    hourly: {
      cutoffAt: localHourStart(at), ready: true, historyDays: HISTORY_DAYS,
      windows: Object.fromEntries(WINDOWS.map(([name]) => [name, mapWindow(`hourly:${name}`)]))
    }
  };
}

function combineCounters(first, second) {
  return Object.fromEntries(counters.map(key => [key, first[key] + second[key]]));
}

function combineWindow(official, supplemental, speed) {
  const result = { ...official };
  for (const key of ['maxSpeed', 'speeds', 'speedHidden', 'speedSparse']) {
    if (speed?.[key] !== undefined) result[key] = speed[key];
  }
  if (!supplemental.requests) return result;
  const totals = combineCounters(official, supplemental);
  const rows = new Map(official.rows.map(row => [`${row.provider}\0${row.model}`, row]));
  for (const row of supplemental.rows) {
    const key = `${row.provider}\0${row.model}`;
    const first = rows.get(key);
    rows.set(key, first ? { ...row, ...combineCounters(first, row) } : row);
  }
  const ranked = [...rows.values()].sort((a, b) => b.tokens - a.tokens || b.requests - a.requests);
  return {
    ...result, ...totals, cacheHitRate: cacheHitRate(totals), rows: ranked.slice(0, ROW_LIMIT),
    hiddenRows: official.hiddenRows + supplemental.hiddenRows + Math.max(0, ranked.length - ROW_LIMIT)
  };
}

export function combineCcSwitchUsage(official, supplemental, legacy) {
  const windows = (official, supplemental, speeds) => Object.fromEntries(WINDOWS.map(([name]) => [
    name, combineWindow(official[name], supplemental[name], speeds?.[name])
  ]));
  const daily = new Map(official.daily.map(row => [row.day, row]));
  for (const row of supplemental.daily) {
    const first = daily.get(row.day);
    daily.set(row.day, first ? { day: row.day, tokens: first.tokens + row.tokens, requests: first.requests + row.requests } : row);
  }
  return {
    ...official, ...(legacy?.progress ? { progress: legacy.progress } : {}),
    windows: windows(official.windows, supplemental.windows, legacy?.windows),
    daily: [...daily.values()].sort((a, b) => a.day.localeCompare(b.day)),
    hourly: { ...official.hourly, windows: windows(official.hourly.windows, supplemental.hourly, legacy?.hourly?.windows) }
  };
}

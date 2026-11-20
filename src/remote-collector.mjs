import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { createLiveSessionReader, discoverUsageUnits, normalizeComparePath } from './data.mjs';
import { leaderboardDay, leaderboardDayStart, MAX_WINDOW_DAYS, USAGE_READ_BATCH } from './usage-summary.mjs';

export const COLLECTOR_FILES = [
  'remote-collector.mjs', 'data.mjs', 'data-paths.mjs', 'parsers.mjs',
  'usage-summary.mjs', 'hermes.mjs', 'locales.mjs', 'locales/zh-CN.xml'
];
export const MAX_RESPONSE_BASE64 = 1024 * 1024;
export const USAGE_PAGE_SIZE = 200;
const PROVIDERS = new Set(['codex', 'claude', 'opencode', 'opencode2', 'pi', 'antigravity', 'hermes']);
const NUMBERS = [
  'completedAt', 'createdAtSec', 'freshInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens',
  'durationMs', 'firstTokenMs', 'generationMs', 'tokensPerSecond', 'cacheHitRate'
];
const clean = value => typeof value === 'string' && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value);
const hermesModelId = /^[a-z\d][a-z\d._-]*\/[a-z\d][a-z\d._:-]*$/i;
const liveSessions = createLiveSessionReader();

export function remoteRecord(record) {
  if (!record || !PROVIDERS.has(record.provider) || !Number.isFinite(record.completedAt) || record.completedAt < 0 ||
    typeof record.id !== 'string' || !record.id) return null;
  const result = {
    id: createHash('sha256').update(record.id).digest('hex').slice(0, 24),
    provider: record.provider,
    dataSource: record.dataSource === 'proxy' || (record.provider === 'hermes' && record.dataSource === 'hermes_log')
      ? record.dataSource : 'session_log'
  };
  for (const field of NUMBERS) {
    if (Number.isFinite(record[field]) && record[field] >= 0) result[field] = record[field];
  }
  if (result.cacheHitRate > 1) delete result.cacheHitRate;
  if (clean(record.model) && record.model.length <= 128 &&
      (!/[/\\]/.test(record.model) || (record.provider === 'hermes' && hermesModelId.test(record.model)))) {
    result.model = record.model;
  }
  if (record.isEstimatedSpeed === true) result.isEstimatedSpeed = true;
  if (record.isSubagent === true) result.isSubagent = true;
  return result;
}

export async function collectRemoteChannel(request, { cwd = process.cwd(), load = liveSessions.read } = {}) {
  if (!clean(request?.worktreePath) || !path.isAbsolute(request.worktreePath)) return { error: 'workspace' };
  const [actual, expected] = await Promise.all([realpath(cwd), realpath(request.worktreePath)]);
  if (normalizeComparePath(actual) !== normalizeComparePath(expected)) return { error: 'workspace' };

  const sessions = [];
  for (const entry of (Array.isArray(request.sessions) ? request.sessions.slice(0, 128) : [])) {
    if (!PROVIDERS.has(entry?.provider) || !clean(entry.sessionId) || !entry.sessionId || entry.sessionId.length > 256) continue;
    const session = { provider: entry.provider, sessionId: entry.sessionId };
    const field = entry.provider === 'opencode' || entry.provider === 'opencode2' ? 'dbPath' : 'transcriptPath';
    if (clean(entry[field]) && path.isAbsolute(entry[field])) session[field] = entry[field];
    sessions.push(session);
  }
  const { session, warnings } = await load(
    { worktreePath: request.worktreePath, sessions },
    { fresh: request.fresh === true }
  );
  return {
    records: session ? session.records.slice(0, 100).map(remoteRecord).filter(Boolean) : null,
    incomplete: Boolean(warnings?.length)
  };
}

export function createRemoteUsageScan(discover = discoverUsageUnits) {
  let units, descriptors;
  return async request => {
    if (request.type === 'list') {
      const { offset, cutoffMs, timeZone, rankDay, rankFrom = rankDay } = request;
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset');
      if (offset === 0) {
        if (!Number.isFinite(cutoffMs) || cutoffMs < 0 || !clean(timeZone) || timeZone.length > 100) throw new Error('calendar');
        if (rankDay !== undefined || rankFrom !== undefined) {
          const date = /^\d{4}-\d{2}-\d{2}$/;
          if (!date.test(rankDay) || !date.test(rankFrom)) throw new Error('calendar');
          const end = leaderboardDayStart(rankDay), start = leaderboardDayStart(rankFrom);
          if (!Number.isFinite(start) || !Number.isFinite(end) || leaderboardDay(start) !== rankFrom ||
              leaderboardDay(end) !== rankDay || start > end || end - start >= MAX_WINDOW_DAYS * 86_400_000) throw new Error('calendar');
        }
        // Usage has its own short-lived SSH stream. Date buckets match the desktop even
        // when the machine that owns the logs has another system time zone.
        new Intl.DateTimeFormat('en', { timeZone });
        process.env.TZ = timeZone;
        let complete = true;
        const discovered = await discover(cutoffMs, { rankDay, rankFrom, onUnavailable: () => { complete = false; } });
        if (!complete) throw new Error('usage_source_unavailable');
        units = new Map(discovered.map(unit => [unit.key, unit]));
        descriptors = [...units.values()].map(({ key, stamp, bytes, mtimeMs }) => ({
          key, stamp: createHash('sha256').update(stamp).digest('hex').slice(0, 24), bytes, mtimeMs
        }));
      }
      if (!descriptors || offset > descriptors.length) throw new Error('scan');
      const items = descriptors.slice(offset, offset + USAGE_PAGE_SIZE);
      return { items, more: offset + items.length < descriptors.length };
    }
    if (request.type !== 'read' || !units || !Array.isArray(request.keys) || request.keys.length > USAGE_READ_BATCH) throw new Error('scan');
    const results = {};
    for (const key of request.keys) {
      if (!/^[a-f\d]{24}$/.test(key) || !units.has(key)) continue;
      try { results[key] = await units.get(key).read(); } catch { /* The desktop retains the last successful counts. */ }
    }
    return { results };
  };
}

// This function runs in a clean Node process on the remote host. The caller passes
// the bundled modules over the SSH stream after receiving the ready line.
async function bootstrap(token, filenames, maxResponseBase64) {
  const output = (line) => process.stdout.write(line + '\n');
  const prefix = '@TPS:' + token + ':';
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) { output(prefix + 'node'); return; }
  try { require('node:sqlite'); }
  catch { output(prefix + 'node'); return; }
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const { pathToFileURL } = require('node:url');
  const { createInterface } = require('node:readline');
  const { gzipSync, gunzipSync } = require('node:zlib');
  const input = process.stdin;
  const lines = createInterface({ input, terminal: false, crlfDelay: Infinity });
  let collect, usage, idle, watch, interval, pending;

  function respond(requestId, value) {
    const json = JSON.stringify(value);
    let body = Buffer.byteLength(json) <= 8 * 1024 * 1024 ? gzipSync(json).toString('base64') : '';
    if (!body || body.length > maxResponseBase64) body = gzipSync('{"error":"limit"}').toString('base64');
    output(prefix + requestId + ':' + body);
  }

  async function install(files) {
    if (collect || !files || filenames.some(name => typeof files[name] !== 'string')) throw new Error('bundle');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-tps-'));
    try {
      await fs.mkdir(path.join(dir, 'locales'), { mode: 0o700 });
      for (const name of filenames) await fs.writeFile(path.join(dir, name), files[name], { flag: 'wx', mode: 0o600 });
      const collector = await import(pathToFileURL(path.join(dir, filenames[0])).href);
      collect = collector.collectRemoteChannel;
      usage = collector.createRemoteUsageScan();
    } finally {
      await Promise.allSettled(filenames.map(name => fs.unlink(path.join(dir, name))));
      await fs.rmdir(path.join(dir, 'locales')).catch(() => {});
      await fs.rmdir(dir).catch(() => {});
    }
  }

  function scan(project) {
    const run = collect(project).catch(() => ({ error: 'read' }))
      .finally(() => { if (pending === run) pending = null; });
    pending = run;
    return run;
  }

  function checkWatch() {
    const current = watch;
    if (!current || pending) return;
    void scan(current.project).then(answer => {
      if (watch !== current) return;
      const stamp = JSON.stringify(answer);
      if (stamp === current.stamp) return;
      current.stamp = stamp;
      current.version++;
      respond(current.id + current.version.toString(16).padStart(8, '0'), answer);
    });
  }

  try {
    output(prefix + 'ready');
    idle = setTimeout(() => lines.close(), 90_000);
    interval = setInterval(checkWatch, 250);
    for await (const line of lines) {
      idle.refresh();
      if (line === 'quit') break;
      const frame = /^>([0-9a-f]{16}):([A-Za-z0-9+/=]{1,96000})$/.exec(line);
      if (frame) {
        const [, requestId, body] = frame;
        try {
          const request = JSON.parse(gunzipSync(Buffer.from(body, 'base64'), { maxOutputLength: 512 * 1024 }));
          if (!collect) await install(request.files);
          if (request.usage && !watch && !pending) {
            respond(requestId, await usage(request.usage));
            continue;
          }
          if (!/^[0-9a-f]{8}$/.test(request.watchId) || !request.project) throw new Error('scan');
          const version = watch?.id === request.watchId ? watch.version : 0;
          watch = null;
          if (pending) await pending;
          const answer = await scan(request.project);
          watch = {
            id: request.watchId, version, stamp: JSON.stringify(answer),
            project: { ...request.project, fresh: false }
          };
          respond(requestId, { answer, version });
        } catch {
          respond(requestId, { error: collect ? 'read' : 'bundle' });
        }
      }
    }
  } finally {
    watch = null;
    clearInterval(interval);
    clearTimeout(idle);
    lines.close();
    input.pause();
  }
}

export function collectorCommand(token) {
  const entry = '(' + bootstrap.toString() + ')(' + [token, COLLECTOR_FILES, MAX_RESPONSE_BASE64].map(value => JSON.stringify(value)).join(',') + ')';
  const compressed = gzipSync(entry).toString('base64');
  return "node --input-type=commonjs -e \"eval(require('node:zlib').gunzipSync(Buffer.from('" + compressed + "','base64')).toString())\"";
}

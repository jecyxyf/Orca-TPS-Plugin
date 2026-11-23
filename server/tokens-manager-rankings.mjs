import { parentPort, workerData } from 'node:worker_threads';
import { validInstallationId } from '../src/leaderboard-installation.mjs';
import {
  HOUR_MS, MAX_RECENT_REQUESTS, RANKING_HOURS, RECENT_STATS_MS, SPEED_MIN_DELTA, hourStart, isHourStart,
  isUsageTime, validRecentRequest
} from '../src/leaderboard-stats.mjs';
import { TOKENS_PACKET_TTL_MS } from '../src/tokens-manager-stats.mjs';
import { calendarFor } from '../src/tokens-manager-db.mjs';
import { leaderboardDay, leaderboardDayStart } from '../src/usage-summary.mjs';

const dayMs = 24 * HOUR_MS;
const sum = (map, key, amount) => map.set(key, (map.get(key) ?? 0) + amount);

export function validatePacket(json, accountId, receivedAt, maxTokens) {
  let packet;
  try { packet = JSON.parse(json); } catch { return null; }
  if (!validInstallationId(packet?.deviceGuid) || accountId !== packet.accountId ||
      !isUsageTime(packet.publishedAt) || packet.publishedAt > receivedAt + dayMs) return null;
  const { hours, daily, samples, publishedAt } = packet;
  let timeZone;
  try { timeZone = calendarFor(packet.timeZone ?? 'Asia/Shanghai').timeZone; } catch { return null; }
  const max = Math.max(1, maxTokens);
  function series(rows, limit, validKey) {
    return Array.isArray(rows) && rows.length <= limit && rows.every((row, i) => Array.isArray(row) &&
      row.length === 2 && validKey(row[0]) && (i === 0 || row[0] > rows[i - 1][0]) &&
      Number.isSafeInteger(row[1]) && row[1] >= 0 && row[1] <= max);
  }
  if (!series(hours, 721, at => isHourStart(at) && at <= publishedAt && at >= hourStart(publishedAt) - 720 * HOUR_MS) ||
      !series(daily, 32, day => typeof day === 'string' && /^\d{4}-\d\d-\d\d$/.test(day) &&
        Number.isFinite(leaderboardDayStart(day)) && leaderboardDay(leaderboardDayStart(day)) === day) ||
      !Array.isArray(samples) || samples.length > MAX_RECENT_REQUESTS || !samples.every(row => validRecentRequest(row) &&
        row[1] >= publishedAt - dayMs && row[1] <= publishedAt && row[2] <= max)) return null;
  const keys = new Set(samples.map(row => row[0]));
  if (keys.size !== samples.length) return null;
  return { accountId, deviceGuid: packet.deviceGuid, publishedAt, timeZone, hours, daily, samples };
}

function topLabel(rows, index) {
  const totals = new Map();
  for (const row of rows) if (row[index]) sum(totals, row[index], row[2]);
  return [...totals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}

function samplePoint(rows, submittedAt) {
  const speed = rows.filter(row => row[3] !== null);
  return { submittedAt, deltaTokens: rows.reduce((total, row) => total + row[2], 0),
    avgTps: speed.length ? speed.reduce((total, row) => total + row[3], 0) / speed.length : null };
}

function recentStats(rows, at) {
  const grouped = new Map();
  const recent = rows.filter(row => row[1] > at - RECENT_STATS_MS && row[1] <= at);
  for (const row of recent) {
    const slot = Math.floor(row[1] / 10_000) * 10_000;
    if (!grouped.has(slot)) grouped.set(slot, []);
    grouped.get(slot).push(row);
  }
  return { topModel: topLabel(recent, 4), topCli: topLabel(recent, 5),
    points: [...grouped].sort((a, b) => a[0] - b[0]).slice(-30).map(([, rows]) =>
      samplePoint(rows, Math.max(...rows.map(row => row[1])))) };
}

function aggregateBestSpeed(rows, at) {
  const grouped = new Map();
  for (const row of rows) {
    if (row[1] <= at - dayMs || row[1] > at) continue;
    const slot = Math.floor(row[1] / 10_000) * 10_000;
    if (!grouped.has(slot)) grouped.set(slot, []);
    grouped.get(slot).push(row);
  }
  let best;
  for (const rows of grouped.values()) {
    const point = samplePoint(rows, Math.max(...rows.map(row => row[1])));
    if (point.deltaTokens > SPEED_MIN_DELTA && (point.avgTps ?? 0) > (best?.avgTps ?? 0)) {
      best = { ...point, topModel: topLabel(rows, 4), topCli: topLabel(rows, 5) };
    }
  }
  return best;
}

const ranked = (rows, compare, limit = 100) => rows.sort((a, b) => compare(a, b) || a.username.localeCompare(b.username))
  .slice(0, limit).map((row, i) => ({ ...row, rank: i + 1 }));

export function createTokensRankings() {
  const variants = new Map();
  let version = 0;

  function receive(account, packet, receivedAt) {
    const key = `${account.id}/${packet.deviceGuid}`;
    if (!variants.has(key)) variants.set(key, new Map());
    const entries = variants.get(key);
    const previous = entries.get(packet.publishedAt);
    if (!previous || receivedAt >= previous.receivedAt) entries.set(packet.publishedAt, { account, packet, receivedAt });
  }

  function publish(at, intervals) {
    const accounts = new Map();
    for (const [key, entries] of variants) {
      let latest;
      for (const [stamp, entry] of entries) {
        if (entry.receivedAt > at) continue;
        if (entry.receivedAt <= at - TOKENS_PACKET_TTL_MS) entries.delete(stamp);
        else if (!latest || stamp > latest.packet.publishedAt) latest = entry;
      }
      if (!entries.size) variants.delete(key);
      if (!latest) continue;
      const { account, packet, receivedAt } = latest;
      let totals = accounts.get(account.id);
      if (!totals) {
        totals = { username: account.username, receivedAt, submittedAt: packet.publishedAt, timeZone: packet.timeZone,
          hours: new Map(), packets: [], samples: [] };
        accounts.set(account.id, totals);
      }
      if (packet.publishedAt > totals.submittedAt) {
        totals.submittedAt = packet.publishedAt;
        totals.timeZone = packet.timeZone;
      }
      if (receivedAt >= totals.receivedAt) {
        totals.receivedAt = receivedAt;
        totals.username = account.username;
      }
      for (const [hour, tokens] of packet.hours) sum(totals.hours, hour, tokens);
      totals.packets.push(packet);
      for (const sample of packet.samples) totals.samples.push(sample);
    }
    const cutoffAt = hourStart(at), nextAt = cutoffAt + intervals.publishMs;
    const boards = {};
    const speedRows = [], usage = new Map(RANKING_HOURS.map(hours => [hours, []]));
    for (const account of accounts.values()) {
      const { username, submittedAt, receivedAt, hours, packets, samples, timeZone } = account;
      const calendar = calendarFor(timeZone), days = new Map();
      for (const packet of packets) {
        if (packet.timeZone === timeZone) {
          for (const [day, tokens] of packet.daily) sum(days, day, tokens);
        } else {
          for (const [hour, tokens] of packet.hours) sum(days, calendar.day(hour), tokens);
        }
      }
      const recent = recentStats(samples, at);
      const speed = aggregateBestSpeed(samples, at);
      if (speed) speedRows.push({ username, ...speed, lastUploadAt: receivedAt });
      for (const span of RANKING_HOURS) {
        const start = cutoffAt - span * HOUR_MS;
        let tokens = 0;
        for (const [hour, count] of hours) if (hour >= start && hour < cutoffAt) tokens += count;
        if (!tokens) continue;
        const row = { username, tokens, submittedAt, lastUploadAt: receivedAt, complete: true, recent };
        if (span > 24) row.daily = Array.from({ length: span / 24 }, (_, i) => {
          const at = start + i * dayMs;
          const day = calendar.day(at + dayMs - 1);
          return { at, day, tokens: days.get(day) ?? 0, complete: true };
        });
        usage.get(span).push(row);
      }
    }
    for (const [hours, rows] of usage) {
      boards[hours] = { hours, cutoffAt, nextAt, windowStart: cutoffAt - hours * HOUR_MS,
        rows: ranked(rows, (a, b) => b.tokens - a.tokens) };
    }
    boards[0] = { rows: ranked(speedRows, (a, b) => b.avgTps - a.avgTps, 20) };
    return { version: ++version, serverTime: at, refreshAt: at + intervals.readMs, cutoffAt, nextAt, boards };
  }
  return { receive, publish };
}

if (parentPort && workerData?.mode === 'validate') {
  parentPort.on('message', ({ id, raw, accountId, at, maxTokens }) => {
    parentPort.postMessage({ id, packet: validatePacket(raw, accountId, at, maxTokens) });
  });
}

if (parentPort && workerData?.mode === 'rank') {
  const rankings = createTokensRankings();
  parentPort.on('message', message => {
    if (message.type === 'receive') rankings.receive(message.account, message.packet, message.at);
    else if (message.type === 'publish') parentPort.postMessage(rankings.publish(message.at, message.intervals));
  });
}

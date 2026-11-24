import { parentPort, workerData } from 'node:worker_threads';
import { validInstallationId } from '../src/leaderboard_stats.mjs';
import {
  HOUR_MS, MAX_RECENT_REQUESTS, RANKING_HOURS, RECENT_STATS_MS, SPEED_MIN_DELTA, hourStart, isHourStart,
  isUsageTime, validRecentRequest
} from '../src/leaderboard_stats.mjs';
import { calendarFor } from '../src/personal_stats.mjs';
import { leaderboardDay, leaderboardDayStart } from '../src/usage-summary.mjs';
import { openPacketBuffer } from './tokens-manager-buffer.mjs';

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
  let version = 0;

  function publish(entries, at, intervals) {
    const latest = new Map();
    for (const entry of entries) {
      const { account, packet, receivedAt } = entry;
      const key = `${account.id}/${packet.deviceGuid}`;
      const previous = latest.get(key);
      if (!previous || packet.publishedAt > previous.packet.publishedAt ||
          (packet.publishedAt === previous.packet.publishedAt && receivedAt >= previous.receivedAt)) {
        latest.set(key, entry);
      }
    }
    const accounts = new Map();
    for (const { account, packet, receivedAt } of latest.values()) {
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
  return { publish };
}

export function createPacketReceiver(buffer, maxTokens, reply) {
  let pending = [], timer;

  function flush() {
    clearTimeout(timer);
    timer = undefined;
    const batch = pending;
    pending = [];
    const accepted = buffer.appendBatch(batch.map(({ entry }) => entry));
    reply(batch.map(({ id }, index) => ({ id, accepted: accepted[index] })));
  }

  return ({ id, raw, account, at }) => {
    const packet = validatePacket(raw, account.id, at, maxTokens);
    if (!packet) {
      reply([{ id, accepted: false }]);
      return;
    }
    pending.push({ id, entry: { account, packet, receivedAt: at } });
    if (pending.length === 32) flush();
    else if (pending.length === 1) timer = setTimeout(flush, 1000);
  };
}

if (parentPort && workerData?.mode === 'validate') {
  const receive = createPacketReceiver(openPacketBuffer(workerData.buffer),
    workerData.maxTokens, results => parentPort.postMessage(results));
  parentPort.on('message', receive);
}

if (parentPort && workerData?.mode === 'rank') {
  const buffer = openPacketBuffer(workerData.buffer);
  const rankings = createTokensRankings();
  parentPort.on('message', ({ at, initial }) => {
    const entries = initial ? [] : buffer.take();
    parentPort.postMessage(rankings.publish(entries, at, workerData.intervals));
  });
}

import { parentPort, workerData } from 'node:worker_threads';
import {
  HOUR_MS, MAX_RECENT_REQUESTS, RANKING_HOURS, RECENT_STATS_MS, SPEED_SAMPLE_WINDOW_MS,
  hourStart, isHourStart, isUsageTime, leaderboardDay, leaderboardDayStart, qualifyingSpeed, validInstallationId, validRecentRequest
} from '../src/leaderboard_stats.mjs';
import { calendarFor } from '../src/personal_stats.mjs';
import { openPacketBuffer } from './tokens-manager-buffer.mjs';

const dayMs = 24 * HOUR_MS, usageLimit = 10_000, publicLimit = 100;
const usageBoardCount = RANKING_HOURS.length * 2, hourlySpeedIdx = usageBoardCount, calendarSpeedIdx = hourlySpeedIdx + 1;
const boardLimits = [...Array(usageBoardCount).fill(usageLimit), publicLimit, publicLimit];
const timeZones = new Map();
const sum = (map, key, amount) => map.set(key, (map.get(key) ?? 0) + amount);

export function validatePacket(json, accountId, receivedAt, maxTokens) {
  let packet;
  try { packet = JSON.parse(json); } catch { return null; }
  if (!validInstallationId(packet?.deviceGuid) || accountId !== packet.accountId ||
      !isUsageTime(packet.publishedAt) || packet.publishedAt > receivedAt + dayMs) return null;
  const { hours, daily, samples, publishedAt } = packet, reqZone = packet.timeZone ?? 'Asia/Shanghai';
  let timeZone = timeZones.get(reqZone);
  if (timeZone === undefined) {
    try { timeZone = calendarFor(reqZone).timeZone; } catch { return null; }
    if (timeZones.size < 32) timeZones.set(reqZone, timeZone);
  }
  const max = Math.max(1, maxTokens);
  const series = (rows, limit, validKey) => Array.isArray(rows) && rows.length <= limit && rows.every((r, i) => Array.isArray(r) &&
    r.length === 2 && validKey(r[0]) && (i === 0 || r[0] > rows[i - 1][0]) && Number.isSafeInteger(r[1]) && r[1] >= 0 && r[1] <= max);
  if (!series(hours, 721, at => isHourStart(at) && at <= publishedAt && at >= hourStart(publishedAt) - 720 * HOUR_MS) ||
      !series(daily, 32, day => typeof day === 'string' && /^\d{4}-\d\d-\d\d$/.test(day) &&
        Number.isFinite(leaderboardDayStart(day)) && leaderboardDay(leaderboardDayStart(day)) === day) ||
      !Array.isArray(samples) || samples.length > MAX_RECENT_REQUESTS || !samples.every(r => validRecentRequest(r) &&
        r[1] >= publishedAt - SPEED_SAMPLE_WINDOW_MS && r[1] <= publishedAt && r[2] <= max)) return null;
  if (new Set(samples.map(r => r[0])).size !== samples.length) return null;
  return { accountId, deviceGuid: packet.deviceGuid, publishedAt, timeZone, hours, daily, samples };
}

function topLabel(rows, index) {
  const totals = new Map();
  for (const r of rows) if (r[index]) sum(totals, r[index], r[2]);
  let title = null, highest = -Infinity;
  for (const [label, tokens] of totals) if (tokens > highest || (tokens === highest && label.localeCompare(title) < 0)) { title = label; highest = tokens; }
  return title;
}

function samplePoint(rows) {
  let submittedAt = 0, deltaTokens = 0, sumTps = 0, speedCount = 0;
  for (const r of rows) { submittedAt = Math.max(submittedAt, r[1]); deltaTokens += r[2]; if (r[3] !== null) { sumTps += r[3]; speedCount++; } }
  return { submittedAt, deltaTokens, avgTps: speedCount ? sumTps / speedCount : null };
}

function recentStats(rows, at) {
  const grouped = new Map(), recent = rows.filter(r => r[1] > at - RECENT_STATS_MS && r[1] <= at);
  for (const r of recent) { const slot = Math.floor(r[1] / 10_000) * 10_000; (grouped.get(slot) ?? grouped.set(slot, []).get(slot)).push(r); }
  return { topModel: topLabel(recent, 4), topCli: topLabel(recent, 5), points: [...grouped].sort((a, b) => a[0] - b[0]).slice(-30).map(([, rs]) => samplePoint(rs)) };
}

function aggregateBestSpeeds(rows, hourlyFrom, cutoff, midnight, at) {
  const grouped = new Map();
  for (const r of rows) {
    if (r[1] < hourlyFrom || r[1] > at) continue;
    const slot = Math.floor(r[1] / 10_000) * 10_000;
    (grouped.get(slot) ?? grouped.set(slot, []).get(slot)).push(r);
  }
  let hourly, calendar;
  for (const rs of grouped.values()) {
    const point = samplePoint(rs);
    if (!qualifyingSpeed(point)) continue;
    const inH = point.submittedAt < cutoff && point.avgTps > (hourly?.avgTps ?? 0);
    const inC = point.submittedAt >= midnight && point.avgTps > (calendar?.avgTps ?? 0);
    if (!inH && !inC) continue;
    const best = { ...point, topModel: topLabel(rs, 4), topCli: topLabel(rs, 5) };
    if (inH) hourly = best;
    if (inC) calendar = best;
  }
  return [hourly, calendar];
}

const compareReceipt = (prev, receivedAt, seq = 0) => receivedAt - prev.receivedAt || seq - prev.sequence;
const compareUpload = (prev, publishedAt, receivedAt, seq = 0) => publishedAt - prev.publishedAt || compareReceipt(prev, receivedAt, seq);

function summarizeDevice({ hours, publishedAt }, receivedAt, sequence = 0) {
  const firstHour = hours[0]?.[0] ?? 0;
  const buf = new ArrayBuffer(hours.length * 10), tokens = new Float64Array(buf, 0, hours.length), hourOffsets = new Uint16Array(buf, tokens.byteLength, hours.length);
  for (let i = 0; i < hours.length; i++) { hourOffsets[i] = (hours[i][0] - firstHour) / HOUR_MS; tokens[i] = hours[i][1]; }
  return { publishedAt, receivedAt, sequence, firstHour, hourOffsets, tokens };
}

function usageScores(devices, cutoff, midnight) {
  const scores = new Float64Array(usageBoardCount), calStart = midnight - 29 * dayMs;
  for (const { firstHour, hourOffsets, tokens } of devices.values()) {
    for (let i = 0; i < tokens.length; i++) {
      const at = firstHour + hourOffsets[i] * HOUR_MS, age = cutoff - at;
      if (age > 0 && age <= 720 * HOUR_MS) {
        scores[2] += tokens[i];
        if (age <= 168 * HOUR_MS) scores[1] += tokens[i];
        if (age <= 24 * HOUR_MS) scores[0] += tokens[i];
      }
      if (age >= 0 && at >= calStart) {
        scores[5] += tokens[i];
        if (at >= midnight - 6 * dayMs) scores[4] += tokens[i];
        if (at >= midnight) scores[3] += tokens[i];
      }
    }
  }
  return scores;
}

function usageCurve(row, dates, lastHour) {
  const start = dates[0].at, tokens = new Float64Array(dates.length);
  for (const d of row.devices.values()) {
    for (let i = 0; i < d.tokens.length; i++) {
      const at = d.firstHour + d.hourOffsets[i] * HOUR_MS;
      if (at >= start && at <= lastHour) tokens[Math.floor((at - start) / dayMs)] += d.tokens[i];
    }
  }
  return dates.map((point, i) => ({ ...point, tokens: tokens[i] }));
}

export const leaderboardSnapshotForMode = ({ calendar, ...hourly }, mode) =>
  mode !== 'calendar' ? hourly : calendar ? { ...hourly, ...calendar, mode } : undefined;

export function createTokensRankings(bans = new Map()) {
  let version = 0, snapshot, lastHourCutoff;
  const accounts = new Map(), leaders = boardLimits.map(() => []), dirty = boardLimits.map(() => false);
  const score = (row, board) => board < usageBoardCount ? row.scores[board] : row.speeds[board - usageBoardCount]?.avgTps ?? 0;

  function setBan(accountId, banned, sequence, evict = banned) {
    bans.set(accountId, { banned, sequence });
    const removed = evict && accounts.delete(accountId);
    if (removed) dirty.fill(true);
    return removed;
  }

  function updateLeaders() {
    const kept = new Set();
    for (const [board, limit] of boardLimits.entries()) {
      if (dirty[board]) {
        leaders[board] = Array.from(accounts.values()).filter(r => score(r, board) > 0)
          .sort((a, b) => score(b, board) - score(a, board) || a.username.localeCompare(b.username) || a.id - b.id).slice(0, limit);
      }
      for (const r of leaders[board]) kept.add(r.id);
    }
    const speedWinners = [new Set(leaders[hourlySpeedIdx]), new Set(leaders[calendarSpeedIdx])];
    for (const [id, row] of accounts) {
      if (!kept.has(id)) accounts.delete(id);
      else for (const [i, winners] of speedWinners.entries()) if (!winners.has(row)) row.speeds[i] = undefined;
    }
    dirty.fill(false);
  }

  function expireSpeeds(from, index) {
    const board = usageBoardCount + index;
    for (const row of leaders[board]) if (row.speeds[index]?.submittedAt < from) { row.speeds[index] = undefined; dirty[board] = true; }
  }

  function updateAccounts(entries, at, cutoff, midnight) {
    const hourlyFrom = cutoff - dayMs;
    expireSpeeds(hourlyFrom, 0);
    if (cutoff !== lastHourCutoff) {
      for (const row of leaders[calendarSpeedIdx]) {
        const s = row.speeds[1];
        if (s.submittedAt >= hourlyFrom && s.submittedAt < cutoff && s.avgTps > score(row, hourlySpeedIdx)) { row.speeds[0] = s; dirty[hourlySpeedIdx] = true; }
      }
      lastHourCutoff = cutoff;
    }
    expireSpeeds(midnight, 1);
    const touched = new Map(), earliest = cutoff - RANKING_HOURS.at(-1) * HOUR_MS, recentFrom = at - RECENT_STATS_MS;
    for (const { account, packet, receivedAt, sequence } of entries) {
      const ban = bans.get(account.id);
      if ((ban && (ban.banned || !(sequence > ban.sequence))) || packet.publishedAt < earliest) continue;
      let row = accounts.get(account.id);
      if (!row) accounts.set(account.id, row = { id: account.id, username: account.username, devices: new Map(), scores: new Float64Array(usageBoardCount), speeds: [] });
      const prev = row.devices.get(packet.deviceGuid);
      if (prev && compareUpload(prev, packet.publishedAt, receivedAt, sequence) < 0) continue;
      const accepted = summarizeDevice(packet, receivedAt, sequence);
      row.devices.set(packet.deviceGuid, accepted);
      const recent = packet.samples.filter(s => s[1] > recentFrom && s[1] <= at);
      if (recent.length) accepted.recentSamples = recent;
      (touched.get(row) ?? touched.set(row, new Map()).get(row)).set(packet.deviceGuid, packet.samples);
      if (!row.latest || compareReceipt(row.latest, receivedAt, accepted.sequence) >= 0) {
        if (row.username !== account.username) dirty.fill(true);
        row.username = account.username;
        row.latest = { receivedAt, sequence: accepted.sequence };
      }
    }
    for (const [row, fresh] of touched) {
      const recentSamples = [], seenRecent = new Set();
      for (const [guid, device] of row.devices) {
        if (device.publishedAt < earliest) { row.devices.delete(guid); continue; }
        if (!device.recentSamples) continue;
        const live = device.recentSamples.filter(s => s[1] > recentFrom && s[1] <= at);
        device.recentSamples = live.length ? live : undefined;
        for (const s of live) if (!seenRecent.has(s[0])) { seenRecent.add(s[0]); recentSamples.push(s); }
      }
      const scores = usageScores(row.devices, cutoff, midnight);
      for (let i = 0; i < scores.length; i++) if (scores[i] !== row.scores[i]) dirty[i] = true;
      row.scores = scores;
      let newest;
      for (const d of row.devices.values()) if (!newest || compareUpload(newest, d.publishedAt, d.receivedAt, d.sequence) > 0) newest = d;
      row.submittedAt = newest.publishedAt;
      const samples = fresh.size === 1 ? fresh.values().next().value : Array.from(fresh.values()).flat();
      row.recent = recentStats(recentSamples, at);
      const speeds = aggregateBestSpeeds(samples, hourlyFrom, cutoff, midnight, at);
      for (const [i, s] of speeds.entries()) if ((s?.avgTps ?? 0) !== score(row, usageBoardCount + i)) dirty[usageBoardCount + i] = true;
      row.speeds = speeds;
    }
    if (touched.size || dirty.includes(true)) updateLeaders();
  }

  function publish(entries, at, intervals, visibleLimit = usageLimit) {
    const cutoffAt = hourStart(at), nextAt = cutoffAt + intervals.publishMs, midnight = leaderboardDayStart(leaderboardDay(at));
    updateAccounts(entries, at, cutoffAt, midnight);
    const boards = {}, calendarBoards = {}, dateDetails = new Map(), hourDetails = new Map();
    const calendarDates = Array.from({ length: 30 }, (_, i) => { const t = midnight - (29 - i) * dayMs; return { at: t, day: leaderboardDay(t), complete: true }; });
    const hourlyDates = Array.from({ length: 30 }, (_, i) => { const t = cutoffAt - (30 - i) * dayMs; return { at: t, day: leaderboardDay(t + dayMs - 1), complete: true }; });
    const details = (row, byDate) => {
      const cache = byDate ? dateDetails : hourDetails;
      if (!cache.has(row)) cache.set(row, byDate ? usageCurve(row, calendarDates, cutoffAt) : usageCurve(row, hourlyDates, cutoffAt - HOUR_MS));
      return cache.get(row);
    };
    const usageRows = (board, count, byDate) => leaders[board].slice(0, visibleLimit).map((row, i) => ({
      rank: i + 1, username: row.username, submittedAt: row.submittedAt, lastUploadAt: row.latest.receivedAt,
      complete: true, recent: row.recent, tokens: row.scores[board], ...(count > 1 && { daily: details(row, byDate).slice(-count) })
    }));
    for (const [i, hours] of RANKING_HOURS.entries()) {
      const count = hours / 24;
      boards[hours] = { hours, cutoffAt, nextAt, windowStart: cutoffAt - hours * HOUR_MS, rows: usageRows(i, count, false) };
      calendarBoards[hours] = { hours, cutoffAt: at, nextAt: at + intervals.publishMs, windowStart: midnight - (count - 1) * dayMs, rows: usageRows(i + RANKING_HOURS.length, count, true) };
    }
    const speedBoard = (board, windowStart, end) => ({
      windowStart, cutoffAt: end,
      rows: leaders[board].map((row, i) => ({ rank: i + 1, username: row.username, ...row.speeds[board - usageBoardCount], lastUploadAt: row.latest.receivedAt }))
    });
    boards[0] = speedBoard(hourlySpeedIdx, cutoffAt - dayMs, cutoffAt);
    calendarBoards[0] = speedBoard(calendarSpeedIdx, midnight, at);
    return snapshot = {
      version: ++version, serverTime: at, refreshAt: at + intervals.readMs, cutoffAt, nextAt, boards,
      calendar: { cutoffAt: at, nextAt: at + intervals.publishMs, boards: calendarBoards }
    };
  }
  return { publish, setBan, snapshot: () => snapshot };
}

export function createPacketReceiver(buffer, maxTokens, reply, flushMs = 1000) {
  let pending = [], timer;
  function flush() {
    clearTimeout(timer); timer = undefined;
    const batch = pending; pending = [];
    const accepted = buffer.appendBatch(batch.map(({ entry }) => entry));
    reply(batch.map(({ id }, index) => ({ id, accepted: accepted[index] })));
  }
  return ({ id, raw, account, at }) => {
    const packet = validatePacket(raw, account.id, at, maxTokens);
    if (!packet) return reply([{ id, accepted: false }]);
    pending.push({ id, entry: { account, packet, receivedAt: at, sequence: id } });
    if (pending.length === 32) flush();
    else if (pending.length === 1) timer = setTimeout(flush, flushMs);
  };
}

if (parentPort && workerData?.mode === 'validate') {
  parentPort.on('message', createPacketReceiver(openPacketBuffer(workerData.buffer), workerData.maxTokens, results => parentPort.postMessage(results), workerData.flushMs));
}
if (parentPort && workerData?.mode === 'rank') {
  const buffer = openPacketBuffer(workerData.buffer), rankings = createTokensRankings(workerData.bans), encoder = new TextEncoder();
  parentPort.on('message', ({ at, takePackets, changes }) => {
    for (const [id, { banned, sequence, evict }] of changes) rankings.setBan(id, banned, sequence, evict);
    const snap = rankings.publish(takePackets ? buffer.take() : [], at, workerData.intervals, publicLimit);
    const hourly = encoder.encode(JSON.stringify(leaderboardSnapshotForMode(snap, 'hourly')));
    const calendar = encoder.encode(JSON.stringify(leaderboardSnapshotForMode(snap, 'calendar')));
    parentPort.postMessage({ hourly, calendar }, [hourly.buffer, calendar.buffer]);
  });
}

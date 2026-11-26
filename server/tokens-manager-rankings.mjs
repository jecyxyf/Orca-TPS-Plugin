import { parentPort, workerData } from 'node:worker_threads';
import {
  HOUR_MS, MAX_RECENT_REQUESTS, RANKING_HOURS, RECENT_STATS_MS, SPEED_SAMPLE_WINDOW_MS,
  hourStart, isHourStart, isUsageTime, leaderboardDay, leaderboardDayStart, qualifyingSpeed, validInstallationId, validRecentRequest
} from '../src/leaderboard_stats.mjs';
import { calendarFor } from '../src/personal_stats.mjs';
import { openPacketBuffer } from './tokens-manager-buffer.mjs';

const dayMs = 24 * HOUR_MS;
const usageLimit = 10_000;
const publicLimit = 100;
const usageBoardCount = RANKING_HOURS.length * 2;
const hourlySpeedIndex = usageBoardCount;
const calendarSpeedIndex = hourlySpeedIndex + 1;
const boardLimits = [...Array(usageBoardCount).fill(usageLimit), publicLimit, publicLimit];
const timeZones = new Map();
const sum = (map, key, amount) => map.set(key, (map.get(key) ?? 0) + amount);

export function validatePacket(json, accountId, receivedAt, maxTokens) {
  let packet;
  try { packet = JSON.parse(json); } catch { return null; }
  if (!validInstallationId(packet?.deviceGuid) || accountId !== packet.accountId ||
      !isUsageTime(packet.publishedAt) || packet.publishedAt > receivedAt + dayMs) return null;
  const { hours, daily, samples, publishedAt } = packet;
  const requestedZone = packet.timeZone ?? 'Asia/Shanghai';
  let timeZone = timeZones.get(requestedZone);
  if (timeZone === undefined) {
    try { timeZone = calendarFor(requestedZone).timeZone; } catch { return null; }
    if (timeZones.size < 32) timeZones.set(requestedZone, timeZone);
  }
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
        row[1] >= publishedAt - SPEED_SAMPLE_WINDOW_MS && row[1] <= publishedAt && row[2] <= max)) return null;
  const keys = new Set(samples.map(row => row[0]));
  if (keys.size !== samples.length) return null;
  return { accountId, deviceGuid: packet.deviceGuid, publishedAt, timeZone, hours, daily, samples };
}

function topLabel(rows, index) {
  const totals = new Map();
  for (const row of rows) if (row[index]) sum(totals, row[index], row[2]);
  let title = null, highest = -Infinity;
  for (const [label, tokens] of totals) {
    if (tokens > highest || (tokens === highest && label.localeCompare(title) < 0)) {
      title = label;
      highest = tokens;
    }
  }
  return title;
}

function samplePoint(rows) {
  let submittedAt = 0, deltaTokens = 0, sumTps = 0, speedCount = 0;
  for (const row of rows) {
    submittedAt = Math.max(submittedAt, row[1]);
    deltaTokens += row[2];
    if (row[3] !== null) {
      sumTps += row[3];
      speedCount++;
    }
  }
  return { submittedAt, deltaTokens, avgTps: speedCount ? sumTps / speedCount : null };
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
    points: [...grouped].sort((a, b) => a[0] - b[0]).slice(-30).map(([, rows]) => samplePoint(rows)) };
}

function aggregateBestSpeeds(rows, hourlyFrom, cutoff, midnight, at) {
  const grouped = new Map();
  for (const row of rows) {
    if (row[1] < hourlyFrom || row[1] > at) continue;
    const slot = Math.floor(row[1] / 10_000) * 10_000;
    if (!grouped.has(slot)) grouped.set(slot, []);
    grouped.get(slot).push(row);
  }
  let hourly, calendar;
  for (const rows of grouped.values()) {
    const point = samplePoint(rows);
    if (!qualifyingSpeed(point)) continue;
    const inHourly = point.submittedAt < cutoff && point.avgTps > (hourly?.avgTps ?? 0);
    const inCalendar = point.submittedAt >= midnight && point.avgTps > (calendar?.avgTps ?? 0);
    if (!inHourly && !inCalendar) continue;
    const best = { ...point, topModel: topLabel(rows, 4), topCli: topLabel(rows, 5) };
    if (inHourly) hourly = best;
    if (inCalendar) calendar = best;
  }
  return [hourly, calendar];
}

function compareReceipt(previous, receivedAt, sequence = 0) {
  return receivedAt - previous.receivedAt || sequence - previous.sequence;
}

function compareUpload(previous, publishedAt, receivedAt, sequence = 0) {
  return publishedAt - previous.publishedAt || compareReceipt(previous, receivedAt, sequence);
}

function summarizeDevice(packet, receivedAt, sequence = 0) {
  const { hours, publishedAt } = packet;
  const firstHour = hours[0]?.[0] ?? 0;
  const storage = new ArrayBuffer(hours.length * (Float64Array.BYTES_PER_ELEMENT + Uint16Array.BYTES_PER_ELEMENT));
  const tokens = new Float64Array(storage, 0, hours.length);
  const hourOffsets = new Uint16Array(storage, tokens.byteLength, hours.length);
  for (let i = 0; i < hours.length; i++) {
    hourOffsets[i] = (hours[i][0] - firstHour) / HOUR_MS;
    tokens[i] = hours[i][1];
  }
  return { publishedAt, receivedAt, sequence, firstHour, hourOffsets, tokens };
}

function recordDevice(row, packet, receivedAt, sequence) {
  const previous = row.devices.get(packet.deviceGuid);
  if (previous && compareUpload(previous, packet.publishedAt, receivedAt, sequence) < 0) return;
  const summary = summarizeDevice(packet, receivedAt, sequence);
  row.devices.set(packet.deviceGuid, summary);
  return summary;
}

function usageScores(devices, cutoff, midnight) {
  const scores = new Float64Array(usageBoardCount);
  const calendarStart = midnight - 29 * dayMs;
  for (const { firstHour, hourOffsets, tokens } of devices.values()) {
    for (let i = 0; i < tokens.length; i++) {
      const at = firstHour + hourOffsets[i] * HOUR_MS;
      const age = cutoff - at;
      if (age > 0 && age <= 720 * HOUR_MS) {
        scores[2] += tokens[i];
        if (age <= 168 * HOUR_MS) scores[1] += tokens[i];
        if (age <= 24 * HOUR_MS) scores[0] += tokens[i];
      }
      if (age >= 0 && at >= calendarStart) {
        scores[5] += tokens[i];
        if (at >= midnight - 6 * dayMs) scores[4] += tokens[i];
        if (at >= midnight) scores[3] += tokens[i];
      }
    }
  }
  return scores;
}

function usageCurve(row, dates, lastHour) {
  const start = dates[0].at;
  const tokens = new Float64Array(dates.length);
  for (const device of row.devices.values()) {
    for (let i = 0; i < device.tokens.length; i++) {
      const at = device.firstHour + device.hourOffsets[i] * HOUR_MS;
      if (at >= start && at <= lastHour) tokens[Math.floor((at - start) / dayMs)] += device.tokens[i];
    }
  }
  return dates.map((point, i) => ({ ...point, tokens: tokens[i] }));
}

export function leaderboardSnapshotForMode({ calendar, ...hourly }, mode) {
  if (mode !== 'calendar') return hourly;
  if (calendar) return { ...hourly, ...calendar, mode };
}

export function createTokensRankings(bans = new Map()) {
  let version = 0, snapshot, lastHourCutoff;
  const accounts = new Map();
  const leaders = boardLimits.map(() => []);
  const dirty = boardLimits.map(() => false);
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
        leaders[board] = Array.from(accounts.values()).filter(row => score(row, board) > 0)
          .sort((left, right) => score(right, board) - score(left, board) ||
            left.username.localeCompare(right.username) || left.id - right.id).slice(0, limit);
      }
      for (const row of leaders[board]) kept.add(row.id);
    }
    const speedWinners = [new Set(leaders[hourlySpeedIndex]), new Set(leaders[calendarSpeedIndex])];
    for (const [id, row] of accounts) {
      if (!kept.has(id)) accounts.delete(id);
      else for (const [index, winners] of speedWinners.entries()) if (!winners.has(row)) row.speeds[index] = undefined;
    }
    dirty.fill(false);
  }

  function expireSpeeds(from, index) {
    const board = usageBoardCount + index;
    for (const row of leaders[board]) {
      const speed = row.speeds[index];
      if (speed && speed.submittedAt < from) {
        row.speeds[index] = undefined;
        dirty[board] = true;
      }
    }
  }

  function updateAccounts(entries, at, cutoff, midnight) {
    const hourlyFrom = cutoff - dayMs;
    expireSpeeds(hourlyFrom, 0);
    if (cutoff !== lastHourCutoff) {
      for (const row of leaders[calendarSpeedIndex]) {
        const speed = row.speeds[1];
        if (speed.submittedAt < hourlyFrom || speed.submittedAt >= cutoff || speed.avgTps <= score(row, hourlySpeedIndex)) continue;
        row.speeds[0] = speed;
        dirty[hourlySpeedIndex] = true;
      }
      lastHourCutoff = cutoff;
    }
    expireSpeeds(midnight, 1);
    const touched = new Map();
    const earliest = cutoff - RANKING_HOURS.at(-1) * HOUR_MS;
    const recentFrom = at - RECENT_STATS_MS;
    for (const { account, packet, receivedAt, sequence } of entries) {
      const ban = bans.get(account.id);
      // Uploads queued before a ban or unban must not restore an evicted account.
      if ((ban && (ban.banned || !(sequence > ban.sequence))) || packet.publishedAt < earliest) continue;
      let row = accounts.get(account.id);
      if (!row) {
        row = { id: account.id, username: account.username, devices: new Map(), scores: new Float64Array(usageBoardCount), speeds: [] };
        accounts.set(account.id, row);
      }
      const accepted = recordDevice(row, packet, receivedAt, sequence);
      if (!accepted) continue;
      const recent = packet.samples.filter(sample => sample[1] > recentFrom && sample[1] <= at);
      if (recent.length) accepted.recentSamples = recent;
      let fresh = touched.get(row);
      if (!fresh) touched.set(row, fresh = new Map());
      fresh.set(packet.deviceGuid, packet.samples);
      if (!row.latest || compareReceipt(row.latest, receivedAt, accepted.sequence) >= 0) {
        if (row.username !== account.username) dirty.fill(true);
        row.username = account.username;
        row.latest = { receivedAt, sequence: accepted.sequence };
      }
    }
    for (const [row, fresh] of touched) {
      const recentSamples = [];
      const seenRecent = new Set();
      for (const [deviceGuid, device] of row.devices) {
        if (device.publishedAt < earliest) {
          row.devices.delete(deviceGuid);
          continue;
        }
        if (!device.recentSamples) continue;
        const live = device.recentSamples.filter(sample => sample[1] > recentFrom && sample[1] <= at);
        if (live.length) {
          device.recentSamples = live;
          for (const sample of live) {
            if (seenRecent.has(sample[0])) continue;
            seenRecent.add(sample[0]);
            recentSamples.push(sample);
          }
        } else {
          device.recentSamples = undefined;
        }
      }
      const scores = usageScores(row.devices, cutoff, midnight);
      for (let i = 0; i < scores.length; i++) if (scores[i] !== row.scores[i]) dirty[i] = true;
      row.scores = scores;
      let newest;
      for (const device of row.devices.values()) {
        if (!newest || compareUpload(newest, device.publishedAt, device.receivedAt, device.sequence) > 0) newest = device;
      }
      row.submittedAt = newest.publishedAt;
      // Merge speed samples across sources in this round, then retain only the winning point.
      const samples = fresh.size === 1 ? fresh.values().next().value : Array.from(fresh.values()).flat();
      row.recent = recentStats(recentSamples, at);
      const speeds = aggregateBestSpeeds(samples, hourlyFrom, cutoff, midnight, at);
      for (const [index, speed] of speeds.entries()) {
        const board = usageBoardCount + index;
        if ((speed?.avgTps ?? 0) !== score(row, board)) dirty[board] = true;
      }
      row.speeds = speeds;
    }
    if (touched.size || dirty.includes(true)) updateLeaders();
  }

  function publish(entries, at, intervals, visibleLimit = usageLimit) {
    const cutoffAt = hourStart(at), nextAt = cutoffAt + intervals.publishMs;
    const midnight = leaderboardDayStart(leaderboardDay(at));
    updateAccounts(entries, at, cutoffAt, midnight);

    const boards = {}, calendarBoards = {};
    const dateDetails = new Map(), hourDetails = new Map();
    const calendarDates = Array.from({ length: 30 }, (_, i) => {
      const at = midnight - (29 - i) * dayMs;
      return { at, day: leaderboardDay(at), complete: true };
    });
    const hourlyDates = Array.from({ length: 30 }, (_, i) => {
      const at = cutoffAt - (30 - i) * dayMs;
      return { at, day: leaderboardDay(at + dayMs - 1), complete: true };
    });

    function details(row, byDate) {
      const cache = byDate ? dateDetails : hourDetails;
      if (cache.has(row)) return cache.get(row);
      const curve = byDate ? usageCurve(row, calendarDates, cutoffAt) : usageCurve(row, hourlyDates, cutoffAt - HOUR_MS);
      cache.set(row, curve);
      return curve;
    }

    function usageRows(board, count, byDate) {
      return leaders[board].slice(0, visibleLimit).map((row, i) => ({
        rank: i + 1, username: row.username, submittedAt: row.submittedAt, lastUploadAt: row.latest.receivedAt,
        complete: true, recent: row.recent, tokens: row.scores[board],
        ...(count > 1 && { daily: details(row, byDate).slice(-count) })
      }));
    }

    for (const [index, hours] of RANKING_HOURS.entries()) {
      const count = hours / 24;
      boards[hours] = { hours, cutoffAt, nextAt, windowStart: cutoffAt - hours * HOUR_MS,
        rows: usageRows(index, count, false) };
      calendarBoards[hours] = { hours, cutoffAt: at, nextAt: at + intervals.publishMs,
        windowStart: midnight - (count - 1) * dayMs, rows: usageRows(index + RANKING_HOURS.length, count, true) };
    }
    function speedBoard(board, windowStart, cutoffAt) {
      const index = board - usageBoardCount;
      return { windowStart, cutoffAt, rows: leaders[board].map((row, i) => ({
        rank: i + 1, username: row.username, ...row.speeds[index], lastUploadAt: row.latest.receivedAt
      })) };
    }
    boards[0] = speedBoard(hourlySpeedIndex, cutoffAt - dayMs, cutoffAt);
    calendarBoards[0] = speedBoard(calendarSpeedIndex, midnight, at);
    snapshot = { version: ++version, serverTime: at, refreshAt: at + intervals.readMs, cutoffAt, nextAt, boards,
      calendar: { cutoffAt: at, nextAt: at + intervals.publishMs, boards: calendarBoards } };
    return snapshot;
  }
  return { publish, setBan, snapshot: () => snapshot };
}

export function createPacketReceiver(buffer, maxTokens, reply, flushMs = 1000) {
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
    pending.push({ id, entry: { account, packet, receivedAt: at, sequence: id } });
    if (pending.length === 32) flush();
    else if (pending.length === 1) timer = setTimeout(flush, flushMs);
  };
}

if (parentPort && workerData?.mode === 'validate') {
  const receive = createPacketReceiver(openPacketBuffer(workerData.buffer),
    workerData.maxTokens, results => parentPort.postMessage(results), workerData.flushMs);
  parentPort.on('message', receive);
}

if (parentPort && workerData?.mode === 'rank') {
  const buffer = openPacketBuffer(workerData.buffer);
  const rankings = createTokensRankings(workerData.bans);
  const encoder = new TextEncoder();
  parentPort.on('message', ({ at, takePackets, changes }) => {
    for (const [accountId, { banned, sequence, evict }] of changes) rankings.setBan(accountId, banned, sequence, evict);
    const entries = takePackets ? buffer.take() : [];
    const snapshot = rankings.publish(entries, at, workerData.intervals, publicLimit);
    const hourly = encoder.encode(JSON.stringify(leaderboardSnapshotForMode(snapshot, 'hourly')));
    const calendar = encoder.encode(JSON.stringify(leaderboardSnapshotForMode(snapshot, 'calendar')));
    parentPort.postMessage({ hourly, calendar }, [hourly.buffer, calendar.buffer]);
  });
}

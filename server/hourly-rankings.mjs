import { HOUR_MS, RANKING_HOURS, RANKING_REFRESH_MS, hourStart, isHourStart, isUsageTime } from '../src/leaderboard-stats.mjs';
import { leaderboardDay, leaderboardDayStart } from '../src/usage-summary.mjs';
import { validInstallationId } from '../src/leaderboard-installation.mjs';

const MAX_SPAN = RANKING_HOURS.at(-1) * HOUR_MS;
const DAY = 24 * HOUR_MS;

export function openHourlyRankings(db, transaction, readOnly = false) {
  if (!readOnly) db.exec(`
    CREATE TABLE IF NOT EXISTS hourly_usage (
      account INTEGER NOT NULL REFERENCES accounts(id), installation_id TEXT NOT NULL,
      hour_start INTEGER NOT NULL, tokens INTEGER NOT NULL, submitted_at INTEGER NOT NULL,
      PRIMARY KEY(account, installation_id, hour_start)
    );
    CREATE INDEX IF NOT EXISTS hourly_usage_time ON hourly_usage(hour_start);
    CREATE TABLE IF NOT EXISTS hourly_uploads (
      account INTEGER NOT NULL REFERENCES accounts(id), installation_id TEXT NOT NULL,
      version INTEGER NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      covered_from INTEGER, covered_until INTEGER, PRIMARY KEY(account, installation_id)
    );
    CREATE TABLE IF NOT EXISTS hourly_removed (
      account INTEGER NOT NULL, day TEXT NOT NULL, PRIMARY KEY(account, day)
    );
    CREATE TABLE IF NOT EXISTS hourly_snapshot (
      slot INTEGER PRIMARY KEY CHECK(slot=1), cutoff INTEGER NOT NULL, revision INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hourly_snapshot_usage (
      account INTEGER NOT NULL, installation_id TEXT NOT NULL, hour_start INTEGER NOT NULL,
      tokens INTEGER NOT NULL, submitted_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS hourly_snapshot_time ON hourly_snapshot_usage(hour_start);
    CREATE TABLE IF NOT EXISTS hourly_snapshot_coverage (
      account INTEGER NOT NULL, installation_id TEXT NOT NULL, covered_from INTEGER, covered_until INTEGER
    );
    CREATE TABLE IF NOT EXISTS rolling_usage (
      account INTEGER NOT NULL REFERENCES accounts(id), installation_id TEXT NOT NULL,
      completed_at INTEGER NOT NULL, tokens INTEGER NOT NULL, submitted_at INTEGER NOT NULL,
      PRIMARY KEY(account, installation_id, completed_at)
    );
    CREATE INDEX IF NOT EXISTS rolling_usage_time ON rolling_usage(completed_at);
    CREATE TABLE IF NOT EXISTS rolling_uploads (
      account INTEGER NOT NULL REFERENCES accounts(id), installation_id TEXT NOT NULL,
      version INTEGER NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      covered_from INTEGER, covered_until INTEGER, PRIMARY KEY(account, installation_id)
    );
  `);
  const current = db.prepare('SELECT cutoff, revision FROM hourly_snapshot WHERE slot=1');
  const prepareWriter = (table, timestamp) => ({
    writeBucket: db.prepare(`INSERT INTO ${table}_usage VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(account, installation_id, ${timestamp}) DO UPDATE SET tokens=excluded.tokens, submitted_at=excluded.submitted_at
      WHERE tokens<>excluded.tokens`),
    lastUpload: db.prepare(`SELECT * FROM ${table}_uploads WHERE account=? AND installation_id=?`),
    saveUpload: db.prepare(`INSERT INTO ${table}_uploads VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account, installation_id) DO UPDATE SET version=excluded.version, request_id=excluded.request_id,
      fingerprint=excluded.fingerprint, covered_from=excluded.covered_from, covered_until=excluded.covered_until`)
  });
  const hourlyWriter = prepareWriter('hourly', 'hour_start');
  const rollingWriter = prepareWriter('rolling', 'completed_at');
  const unavailableDay = db.prepare(`SELECT 1 FROM hourly_removed WHERE account=? AND day=?
    UNION ALL SELECT 1 FROM scores WHERE account=? AND day=? AND tokens IS NULL
    UNION ALL SELECT 1 FROM locks WHERE account=? AND day=? LIMIT 1`);
  const rollingRows = db.prepare(`SELECT usage.account, username, completed_at AS at, tokens, submitted_at AS submittedAt
    FROM rolling_usage usage JOIN accounts ON accounts.id=usage.account
    WHERE completed_at>=? AND completed_at<? AND accounts.banned=0 AND tokens>0`);
  const rollingCoverage = db.prepare(`SELECT devices.account, devices.installation_id, uploads.covered_from, uploads.covered_until
    FROM (SELECT account, installation_id FROM rolling_usage WHERE completed_at>=? AND completed_at<?
      UNION SELECT account, installation_id FROM installation_scores WHERE day>=? AND day<=?
      UNION SELECT account, installation_id FROM rolling_uploads WHERE covered_until>?) devices
    LEFT JOIN rolling_uploads uploads USING (account, installation_id)`);

  function submit(account, { installationId, version, buckets, coverage, requestId, fingerprint }, now, maxTokens, rolling = false) {
    const cutoff = rolling ? now : hourStart(now);
    const validTime = rolling ? isUsageTime : isHourStart;
    // A small clock difference must not reject newer data from an otherwise valid batch.
    const latest = rolling ? cutoff + 60_000 : cutoff;
    const { writeBucket, lastUpload, saveUpload } = rolling ? rollingWriter : hourlyWriter;
    if (!validInstallationId(installationId) || !Number.isSafeInteger(version) || version <= 0 ||
        !Array.isArray(buckets) || (!rolling && buckets.length > RANKING_HOURS.at(-1) + 1) ||
        !buckets.every(row => Array.isArray(row) && row.length === 2 && validTime(row[0]) && row[0] <= latest &&
          Number.isSafeInteger(row[1]) && row[1] >= 0 && row[1] <= maxTokens) ||
        new Set(buckets.map(row => row[0])).size !== buckets.length ||
        (coverage !== undefined && (!Array.isArray(coverage) || coverage.length !== 2 ||
          !coverage.every(validTime) || coverage[0] >= coverage[1] || coverage[1] > latest))) return { code: 'invalid' };
    return transaction(() => {
      const saved = lastUpload.get(account, installationId);
      if (saved && version <= saved.version) {
        return version === saved.version && requestId === saved.request_id && fingerprint === saved.fingerprint
          ? { code: 'accepted', version } : { code: 'stale_version', version: saved.version };
      }
      const days = new Map();
      for (const [at, tokens] of buckets) {
        if (at < cutoff - MAX_SPAN) continue;
        const day = leaderboardDay(at);
        if (!days.has(day)) days.set(day, unavailableDay.get(account, day, account, day, account, day));
        if (!days.get(day)) writeBucket.run(account, installationId, at, tokens, now);
      }
      const [from, to] = coverage ?? [saved?.covered_from, saved?.covered_until];
      const start = from == null ? null : Math.max(from, cutoff - MAX_SPAN);
      saveUpload.run(account, installationId, version, requestId, fingerprint,
        start != null && start < to ? start : null, start != null && start < to ? to : null);
      return { code: 'accepted', version };
    });
  }

  function settle(now) {
    const cutoff = hourStart(now);
    let snapshot = current.get();
    if (snapshot?.cutoff === cutoff) return snapshot;
    return transaction(() => {
      snapshot = current.get();
      if (snapshot?.cutoff === cutoff) return snapshot;
      db.exec('DELETE FROM hourly_snapshot_usage; DELETE FROM hourly_snapshot_coverage');
      db.prepare(`INSERT INTO hourly_snapshot_usage SELECT * FROM hourly_usage WHERE hour_start>=? AND hour_start<?`)
        .run(cutoff - MAX_SPAN, cutoff);
      db.prepare(`INSERT INTO hourly_snapshot_coverage
        SELECT devices.account, devices.installation_id, uploads.covered_from, uploads.covered_until
        FROM (SELECT account, installation_id FROM hourly_snapshot_usage
          UNION SELECT account, installation_id FROM installation_scores WHERE day>=? AND day<=?
          UNION SELECT account, installation_id FROM hourly_uploads WHERE covered_until>?) devices
        LEFT JOIN hourly_uploads uploads USING (account, installation_id)`)
        .run(leaderboardDay(cutoff - MAX_SPAN), leaderboardDay(cutoff), cutoff - MAX_SPAN);
      db.prepare(`INSERT INTO hourly_snapshot VALUES (1, ?, 1) ON CONFLICT(slot) DO UPDATE SET cutoff=excluded.cutoff, revision=1`)
        .run(cutoff);
      db.prepare('DELETE FROM hourly_usage WHERE hour_start<?').run(cutoff - MAX_SPAN);
      db.prepare('DELETE FROM rolling_usage WHERE completed_at<?').run(cutoff - MAX_SPAN);
      db.prepare('DELETE FROM hourly_removed WHERE day<?').run(leaderboardDay(cutoff - MAX_SPAN));
      return current.get();
    });
  }

  function revision() { db.exec('UPDATE hourly_snapshot SET revision=revision+1'); }

  function remove({ day, account }) {
    const recordRemoval = db.prepare('INSERT OR IGNORE INTO hourly_removed VALUES (?, ?)');
    for (const [table, timestamp] of [['hourly_usage', 'hour_start'], ['hourly_snapshot_usage', 'hour_start'], ['rolling_usage', 'completed_at']]) {
      const where = [], values = [];
      if (day) {
        const start = leaderboardDayStart(day);
        where.push(`${timestamp}>=? AND ${timestamp}<?`);
        values.push(start, start + DAY);
      }
      if (account) {
        where.push('account=?');
        values.push(account);
      }
      const filter = where.length ? ' WHERE ' + where.join(' AND ') : '';
      const affected = db.prepare(`SELECT DISTINCT account, date(${timestamp}/1000+28800,'unixepoch') AS day FROM ${table}${filter}`);
      for (const row of affected.iterate(...values)) recordRemoval.run(row.account, row.day);
      db.prepare(`DELETE FROM ${table}${filter}`).run(...values);
    }
    revision();
  }

  function buildRanking(hours, cutoff, usage, deviceCoverage, currentLag = 0) {
    const windowStart = cutoff - hours * HOUR_MS;
    const coverage = new Map();
    for (const row of deviceCoverage) {
      const entries = coverage.get(row.account) ?? [];
      entries.push(row);
      coverage.set(row.account, entries);
    }
    const results = new Map();
    for (const { account, username, at, tokens, submittedAt } of usage) {
      let row = results.get(account);
      if (!row) {
        row = { account, username, submittedAt, tokens: 0n, points: new Array(hours / 24).fill(0n) };
        results.set(account, row);
      }
      row.tokens += BigInt(tokens);
      row.submittedAt = Math.max(row.submittedAt, submittedAt);
      row.points[Math.floor((at - windowStart) / DAY)] += BigInt(tokens);
    }
    const rows = [...results.values()].sort((a, b) => a.tokens === b.tokens
      ? a.submittedAt - b.submittedAt || a.account - b.account : a.tokens > b.tokens ? -1 : 1)
      .slice(0, 100).map(({ account, username, tokens, submittedAt, points }, index) => {
        const devices = coverage.get(account) ?? [];
        const covered = (start, end) => devices.length > 0 && devices.every(device => device.covered_from !== null &&
          device.covered_from <= start && device.covered_until >= end - (end === cutoff ? currentLag : 0));
        return { account, username, tokens: Number(tokens), submittedAt, rank: index + 1,
          complete: covered(windowStart, cutoff), ...(hours > 24 ? { daily: points.map((value, day) => {
            const at = windowStart + day * DAY;
            return { at, tokens: Number(value), complete: covered(at, at + DAY) };
          }) } : {}) };
      });
    return { hours, windowStart, cutoffAt: cutoff, rows };
  }

  function ranking(hours, { cutoff, revision: version }) {
    const usage = db.prepare(`SELECT usage.account, username, hour_start AS at, tokens, submitted_at AS submittedAt
      FROM hourly_snapshot_usage usage JOIN accounts ON accounts.id=usage.account
      WHERE hour_start>=? AND accounts.banned=0 AND tokens>0`);
    const devices = db.prepare('SELECT * FROM hourly_snapshot_coverage');
    return { ...buildRanking(hours, cutoff, usage.iterate(cutoff - hours * HOUR_MS), devices.iterate()),
      nextAt: cutoff + HOUR_MS, snapshotId: `${cutoff}-${version}` };
  }

  function rollingRanking(hours, cutoff) {
    const oldest = cutoff - MAX_SPAN;
    const devices = rollingCoverage.iterate(oldest, cutoff, leaderboardDay(oldest), leaderboardDay(cutoff), oldest);
    const board = buildRanking(hours, cutoff, rollingRows.iterate(cutoff - hours * HOUR_MS, cutoff), devices, RANKING_REFRESH_MS);
    return { ...board, nextAt: cutoff + RANKING_REFRESH_MS };
  }

  return { submit, settle, ranking, rollingRanking, remove, revision };
}

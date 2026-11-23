import { HOUR_MS, RANKING_HOURS, RECENT_STATS_MS, SPEED_WINDOW_MS, hourStart, isHourStart,
  isUsageTime, qualifyingSpeed, validSubmissionStats } from '../src/leaderboard-stats.mjs';
import { validInstallationId } from '../src/leaderboard-installation.mjs';
import { leaderboardDay, leaderboardDayStart } from '../src/usage-summary.mjs';

const WINDOW = RANKING_HOURS.at(-1) * HOUR_MS;
const LEASE_MS = 60_000;
const key = (account, source, hour) => JSON.stringify([account, source, hour]);

export function validHourlySource(input, now, maxTokens) {
  const { sourceId, reporterId, operation, observedAt, hours, sample } = input;
  if (!validInstallationId(sourceId) || !validInstallationId(reporterId)) return false;
  if (operation === 'lease') {
    return sourceId !== reporterId && isUsageTime(observedAt) && observedAt > now - LEASE_MS && observedAt <= now + LEASE_MS;
  }
  if (operation !== 'hourly-update' || !Array.isArray(hours) || hours.length > RANKING_HOURS.at(-1) + 1 ||
      !hours.every(row => row && isHourStart(row.hour) && row.hour > 0 && row.hour <= hourStart(now + LEASE_MS) &&
        isUsageTime(row.updatedAt) && row.updatedAt <= now + LEASE_MS && isUsageTime(row.coveredUntil) &&
        row.coveredUntil > row.hour && row.coveredUntil <= Math.min(row.hour + HOUR_MS, row.updatedAt) &&
        Number.isSafeInteger(row.tokens) && row.tokens >= 0 && row.tokens <= maxTokens) ||
      new Set(hours.map(row => row.hour)).size !== hours.length) return false;
  if (sample === undefined) return hours.length > 0;
  return validInstallationId(sample?.id) && isUsageTime(sample.at) && sample.at > 0 && sample.at <= now + LEASE_MS &&
    validSubmissionStats(sample) && sample.deltaTokens <= maxTokens;
}

function compareUsage(saved, incoming) {
  if (saved?.usage_updated_at == null) return 'new';
  if (incoming.updatedAt < saved.usage_updated_at) {
    return incoming.tokens === saved.tokens ? 'stale' : 'rescan';
  }
  if (incoming.updatedAt === saved.usage_updated_at) {
    return incoming.tokens === saved.tokens && incoming.coveredUntil === saved.covered_until ? 'same' : 'rescan';
  }
  return incoming.coveredUntil < saved.covered_until ? 'rescan' : 'new';
}

function compareSpeeds(a, b) {
  return b.avgTps - a.avgTps || a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function openLeaderboardData(db, readOnly) {
  if (!readOnly) db.exec(`
    CREATE TABLE IF NOT EXISTS leaderboard_data (
      account_id INTEGER NOT NULL REFERENCES accounts(id), source_guid TEXT NOT NULL, hour_start INTEGER NOT NULL,
      tokens INTEGER, usage_updated_at INTEGER, covered_until INTEGER, last_upload_at INTEGER, last_upload_id TEXT,
      best_speed REAL, speed_at INTEGER, speed_tokens INTEGER, speed_model TEXT, speed_harness TEXT, speed_id TEXT,
      recent TEXT, source_kind TEXT, owner TEXT, lease_epoch INTEGER, lease_until INTEGER, observed_at INTEGER,
      PRIMARY KEY(account_id, source_guid, hour_start)
    );
    CREATE INDEX IF NOT EXISTS leaderboard_data_hours ON leaderboard_data(hour_start) WHERE hour_start>0;
    CREATE TABLE IF NOT EXISTS leaderboard_results (
      cutoff_at INTEGER PRIMARY KEY, generated_at INTEGER NOT NULL, payload TEXT NOT NULL
    );
    CREATE VIEW IF NOT EXISTS leaderboard_daily_scores AS
      SELECT scores.day, scores.account, scores.tokens, scores.submitted_at,
        COALESCE(score_updates.updated_at, scores.submitted_at) AS uploaded_at
      FROM scores LEFT JOIN score_updates USING (day, account)
      WHERE scores.tokens IS NULL OR NOT EXISTS (
        SELECT 1 FROM source_accounts WHERE account=scores.account AND active=2
      )
      UNION ALL
      SELECT date(hour_start/1000+28800,'unixepoch'), account_id, MIN(CAST(TOTAL(tokens) AS INTEGER), 9007199254740991),
        MIN(last_upload_at), MAX(last_upload_at)
      FROM leaderboard_data WHERE hour_start>0 AND tokens>0 GROUP BY 1, account_id
      UNION ALL
      SELECT h.day, h.account, NULL, 0, 0 FROM hourly_removed h
      WHERE EXISTS (SELECT 1 FROM source_accounts WHERE account=h.account AND active=2)
        AND NOT EXISTS (SELECT 1 FROM scores WHERE account=h.account AND day=h.day AND tokens IS NULL);
  `);

  const newest = db.prepare('SELECT payload FROM leaderboard_results ORDER BY cutoff_at DESC LIMIT 1');
  const dataRows = db.prepare(`SELECT d.account_id AS account, a.username, d.source_guid AS installation_id,
        d.hour_start AS at, d.tokens, d.last_upload_at AS submittedAt, d.covered_until
      FROM leaderboard_data d JOIN accounts a ON a.id=d.account_id
      WHERE d.hour_start>0 AND d.hour_start>=? AND d.hour_start<? AND a.banned=0`);
  const bestRows = db.prepare(`SELECT d.account_id AS account, a.username, d.speed_at AS submittedAt,
        d.best_speed AS avgTps, d.speed_tokens AS deltaTokens, d.speed_model AS topModel, d.speed_harness AS topCli,
        d.speed_id AS requestId
      FROM leaderboard_data d JOIN accounts a ON a.id=d.account_id
      WHERE d.hour_start>0 AND d.hour_start>=? AND d.hour_start<? AND d.best_speed IS NOT NULL AND a.banned=0`);
  const recentRows = db.prepare(`SELECT d.account_id AS account, d.recent
      FROM leaderboard_data d JOIN json_each(?) k ON d.account_id=k.value
      WHERE d.hour_start>=? AND d.hour_start<=? AND d.recent IS NOT NULL`);
  const latestUploads = db.prepare(`SELECT d.account_id AS account, MAX(d.last_upload_at) AS time
      FROM leaderboard_data d JOIN json_each(?) k ON d.account_id=k.value
      WHERE d.hour_start=0 GROUP BY d.account_id`);

  const read = {
    latestResult: () => newest.get()?.payload,
    rows: (from, until) => dataRows.all(from, until),
    speeds: (from, until) => bestRows.all(from, until),
    recent: (accounts, now) => recentRows.all(JSON.stringify(accounts), hourStart(now - RECENT_STATS_MS), hourStart(now)),
    latestUploads: accounts => latestUploads.all(JSON.stringify(accounts))
  };
  if (readOnly) return read;

  const load = db.prepare(`SELECT d.* FROM json_each(?) k CROSS JOIN leaderboard_data d
    ON d.account_id=json_extract(k.value,'$[0]') AND d.source_guid=json_extract(k.value,'$[1]')
      AND d.hour_start=json_extract(k.value,'$[2]')`);
  const saveProgress = db.prepare(`INSERT INTO leaderboard_data(account_id, source_guid, hour_start, source_kind,
      owner, lease_epoch, lease_until, observed_at, usage_updated_at, last_upload_at, last_upload_id)
    VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, source_guid, hour_start) DO UPDATE SET source_kind=excluded.source_kind,
      owner=excluded.owner, lease_epoch=excluded.lease_epoch, lease_until=excluded.lease_until,
      observed_at=excluded.observed_at, usage_updated_at=excluded.usage_updated_at,
      last_upload_at=excluded.last_upload_at, last_upload_id=excluded.last_upload_id`);
  const saveHour = db.prepare(`INSERT INTO leaderboard_data(account_id, source_guid, hour_start, tokens, usage_updated_at,
      covered_until, last_upload_at, last_upload_id, best_speed, speed_at, speed_tokens, speed_model, speed_harness, speed_id, recent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, source_guid, hour_start) DO UPDATE SET tokens=excluded.tokens,
      usage_updated_at=excluded.usage_updated_at, covered_until=excluded.covered_until,
      last_upload_at=excluded.last_upload_at, last_upload_id=excluded.last_upload_id,
      best_speed=excluded.best_speed, speed_at=excluded.speed_at, speed_tokens=excluded.speed_tokens,
      speed_model=excluded.speed_model, speed_harness=excluded.speed_harness, speed_id=excluded.speed_id, recent=excluded.recent`);
  const blocked = db.prepare(`SELECT 1 FROM hourly_removed WHERE account=? AND day=?
    UNION ALL SELECT 1 FROM scores WHERE account=? AND day=? AND tokens IS NULL
    UNION ALL SELECT 1 FROM locks WHERE account=? AND day=? LIMIT 1`);
  const importHours = db.prepare(`INSERT INTO leaderboard_data(account_id, source_guid, hour_start, tokens,
        usage_updated_at, covered_until, last_upload_at)
      SELECT account, installation_id, completed_at / ? * ? AS hour,
        MIN(CAST(TOTAL(tokens) AS INTEGER), 9007199254740991), MAX(submitted_at),
        MIN(MAX(covered_until), (completed_at / 3600000 + 1) * 3600000), MAX(submitted_at)
      FROM rolling_usage LEFT JOIN rolling_uploads USING (account, installation_id)
      WHERE account=? AND completed_at>=? GROUP BY account, installation_id, hour`);
  const importCoverage = db.prepare(`WITH RECURSIVE coverage(source, hour, until) AS (
    SELECT installation_id, MAX(?, (covered_from + ${HOUR_MS} - 1) / ${HOUR_MS} * ${HOUR_MS}), MIN(covered_until, ?)
    FROM rolling_uploads WHERE account=? AND covered_until>? AND covered_from IS NOT NULL
    UNION ALL
    SELECT source, hour+${HOUR_MS}, until FROM coverage WHERE hour+${HOUR_MS}<until
  )
  INSERT OR IGNORE INTO leaderboard_data(account_id, source_guid, hour_start, tokens, covered_until)
  SELECT ?, source, hour, 0, MIN(until, hour+${HOUR_MS}) FROM coverage WHERE hour<until`);
  const removeRows = db.prepare(`DELETE FROM leaderboard_data WHERE hour_start>0
    AND (? IS NULL OR account_id=?) AND hour_start>=? AND hour_start<? RETURNING account_id, hour_start`);
  const tombstone = db.prepare('INSERT OR IGNORE INTO hourly_removed VALUES (?, ?)');
  const saveResult = db.prepare(`INSERT INTO leaderboard_results VALUES (?, ?, ?)
    ON CONFLICT(cutoff_at) DO UPDATE SET generated_at=excluded.generated_at, payload=excluded.payload
    WHERE excluded.generated_at>=generated_at`);
  const trimResults = db.prepare('DELETE FROM leaderboard_results WHERE cutoff_at NOT IN (SELECT cutoff_at FROM leaderboard_results ORDER BY cutoff_at DESC LIMIT 2)');
  const pruneUsage = db.prepare('DELETE FROM leaderboard_data WHERE hour_start>0 AND hour_start<?');
  const pruneSpeed = db.prepare(`UPDATE leaderboard_data SET best_speed=NULL, speed_at=NULL, speed_tokens=NULL,
    speed_model=NULL, speed_harness=NULL, speed_id=NULL WHERE hour_start>0 AND hour_start<? AND best_speed IS NOT NULL`);
  const pruneRecent = db.prepare('UPDATE leaderboard_data SET recent=NULL WHERE hour_start>0 AND hour_start<? AND recent IS NOT NULL');

  function writeBatch(entries, authorize) {
    const keys = new Set();
    for (const { account, input: { sourceId, hours = [], sample } } of entries) {
      keys.add(key(account, sourceId, 0));
      for (const { hour } of hours) keys.add(key(account, sourceId, hour));
      if (sample && hourStart(sample.at) > 0) keys.add(key(account, sourceId, hourStart(sample.at)));
    }
    const rows = new Map(load.all(`[${[...keys].join(',')}]`).map(row =>
      [key(row.account_id, row.source_guid, row.hour_start), row]));
    const dirty = new Map(), removed = new Map(), authorizations = new Map();
    const get = (account, source, hour) => rows.get(key(account, source, hour));
    function update(account, source, hour, values) {
      const id = key(account, source, hour);
      const row = { account_id: account, source_guid: source, hour_start: hour, ...rows.get(id), ...values };
      rows.set(id, row);
      dirty.set(id, row);
    }
    function isBlocked(account, hour) {
      const day = leaderboardDay(hour), id = `${account}/${day}`;
      if (!removed.has(id)) removed.set(id, !!blocked.get(account, day, account, day, account, day));
      return removed.get(id);
    }
    const results = entries.map(entry => {
      const { account, receivedAt: now, input: { sourceId, reporterId, leaseEpoch, requestId, operation, observedAt, hours, sample } } = entry;
      const old = get(account, sourceId, 0);
      const kind = sourceId === reporterId ? 'local' : 'ssh';
      if (old && old.source_kind !== kind) return { code: 'invalid' };
      if (operation === 'lease') {
        if (old?.lease_until > now && old.owner !== reporterId) return { code: 'standby', expiresAt: old.lease_until };
        const current = old?.lease_until > now;
        const lease = { source_kind: kind, owner: reporterId, lease_epoch: current ? old.lease_epoch : (old?.lease_epoch ?? 0) + 1,
          lease_until: current && observedAt <= old.observed_at ? old.lease_until : now + LEASE_MS,
          observed_at: current ? Math.max(old.observed_at, observedAt) : observedAt };
        update(account, sourceId, 0, lease);
        return { code: 'accepted', leaseEpoch: lease.lease_epoch, expiresAt: lease.lease_until };
      }
      if (kind === 'ssh' && (!old || old.owner !== reporterId || old.lease_epoch !== leaseEpoch || old.lease_until <= now)) {
        return { code: 'lease_expired' };
      }
      const from = hourStart(now) - WINDOW;
      const changes = [], rescans = [];
      for (const row of hours) {
        if (row.hour < from || isBlocked(account, row.hour)) continue;
        const saved = get(account, sourceId, row.hour);
        const action = compareUsage(saved, row);
        if (action === 'new') changes.push(row);
        if (action === 'rescan') rescans.push({ hour: row.hour, updatedAt: saved.usage_updated_at });
      }
      const sampleHour = sample && hourStart(sample.at);
      const speedRow = sample && get(account, sourceId, sampleHour);
      const keepSample = sampleHour > 0 && sample.at >= hourStart(now) - SPEED_WINDOW_MS && !isBlocked(account, sampleHour);
      const prior = keepSample && speedRow?.recent ? JSON.parse(speedRow.recent) : [];
      const sameSample = speedRow?.speed_id === sample?.id || prior.some(point => point.id === sample.id);
      const best = keepSample && !sameSample && qualifyingSpeed(sample) &&
        (!speedRow?.best_speed || compareSpeeds(sample, { avgTps: speedRow.best_speed, at: speedRow.speed_at, id: speedRow.speed_id }) < 0);
      const recent = keepSample && !sameSample && sample.at >= now - RECENT_STATS_MS;
      const changed = changes.length > 0 || best || recent;
      if (changed) {
        const author = key(account, reporterId, 0);
        if (!authorizations.has(author)) authorizations.set(author, authorize(entry));
        const gate = authorizations.get(author);
        if (gate) return gate;
      }
      let newestAt = old?.usage_updated_at ?? null;
      for (const row of changes) {
        update(account, sourceId, row.hour, { tokens: row.tokens, usage_updated_at: row.updatedAt, covered_until: row.coveredUntil,
          last_upload_at: now, last_upload_id: requestId });
        newestAt = Math.max(newestAt ?? 0, row.updatedAt);
      }
      if (best || recent) update(account, sourceId, sampleHour, {
        last_upload_at: now, last_upload_id: requestId,
        ...(best ? { best_speed: sample.avgTps, speed_at: sample.at, speed_tokens: sample.deltaTokens,
          speed_model: sample.topModel, speed_harness: sample.topCli, speed_id: sample.id } : {}),
        ...(recent ? { recent: JSON.stringify([...prior.filter(point => point.at >= now - RECENT_STATS_MS), sample]
          .sort((a, b) => a.at - b.at).slice(-30)) } : {})
      });
      if (changed) update(account, sourceId, 0, { source_kind: kind, owner: reporterId, usage_updated_at: newestAt,
        last_upload_at: now, last_upload_id: requestId });
      return { code: rescans.length ? 'rescan' : 'accepted', ...(rescans.length ? { rescans } : {}),
        ...(keepSample ? { sampleAccepted: true } : {}), changed: Boolean(changed) };
    });
    for (const row of dirty.values()) {
      const { account_id: account, source_guid: source, hour_start: hour, usage_updated_at: updatedAt = null,
        last_upload_at: uploadedAt = null, last_upload_id: id = null } = row;
      if (!hour) saveProgress.run(account, source, row.source_kind, row.owner ?? null,
        row.lease_epoch ?? null, row.lease_until ?? null, row.observed_at ?? null, updatedAt, uploadedAt, id);
      else saveHour.run(account, source, hour, row.tokens ?? null, updatedAt, row.covered_until ?? null,
        uploadedAt, id, row.best_speed ?? null, row.speed_at ?? null, row.speed_tokens ?? null,
        row.speed_model ?? null, row.speed_harness ?? null, row.speed_id ?? null, row.recent ?? null);
    }
    return results;
  }

  return {
    ...read, writeBatch,
    importAccount(account, now) {
      const from = hourStart(now) - WINDOW;
      importHours.run(HOUR_MS, HOUR_MS, account, from);
      importCoverage.run(from, now, account, from, account);
    },
    remove({ account = null, day }) {
      const start = day ? leaderboardDayStart(day) : 0;
      const end = day ? start + 24 * HOUR_MS : Number.MAX_SAFE_INTEGER;
      for (const row of removeRows.all(account, account, start, end)) tombstone.run(row.account_id, leaderboardDay(row.hour_start));
    },
    persistResult(cutoff, generatedAt, payload) {
      saveResult.run(cutoff, generatedAt, payload);
      trimResults.run();
    },
    invalidateResults: () => db.exec('DELETE FROM leaderboard_results'),
    prune(cutoff) {
      pruneUsage.run(cutoff - WINDOW);
      pruneSpeed.run(cutoff - SPEED_WINDOW_MS);
      pruneRecent.run(cutoff - 2 * HOUR_MS);
    }
  };
}

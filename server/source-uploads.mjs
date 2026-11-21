import { validInstallationId } from '../src/leaderboard-installation.mjs';
import { HOUR_MS, RANKING_HOURS, isUsageTime } from '../src/leaderboard-stats.mjs';
import { leaderboardDay, leaderboardDayStart } from '../src/usage-summary.mjs';

const DAY = 24 * HOUR_MS, WINDOW = RANKING_HOURS.at(-1) * HOUR_MS;
const LEASE_MS = 60_000, CLOCK_SKEW = 60_000, MAX_PARTS = 256;

export function openSourceUploads(db, { get, all, run, nextUpload, uploadGate, invalidUpload, saveDaily, replaceLegacyDaily }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS source_accounts (
      account INTEGER PRIMARY KEY REFERENCES accounts(id), active INTEGER NOT NULL, version INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS source_admin_revision (slot INTEGER PRIMARY KEY CHECK(slot=1), version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS source_states (
      account INTEGER NOT NULL REFERENCES accounts(id), source TEXT NOT NULL, kind TEXT NOT NULL,
      owner TEXT NOT NULL, epoch INTEGER NOT NULL, expires INTEGER NOT NULL, observed INTEGER NOT NULL,
      revision INTEGER NOT NULL, baseline INTEGER NOT NULL, PRIMARY KEY(account, source)
    );
    CREATE TABLE IF NOT EXISTS source_receipts (
      account INTEGER NOT NULL REFERENCES accounts(id), reporter TEXT NOT NULL, request TEXT NOT NULL,
      fingerprint TEXT NOT NULL, result TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(account, reporter, request)
    );
    CREATE INDEX IF NOT EXISTS source_receipts_at ON source_receipts(at);
    CREATE TABLE IF NOT EXISTS source_parts (
      account INTEGER NOT NULL REFERENCES accounts(id), reporter TEXT NOT NULL, source TEXT NOT NULL,
      snapshot TEXT NOT NULL, part INTEGER NOT NULL, count INTEGER NOT NULL, kind TEXT NOT NULL, purpose TEXT NOT NULL,
      epoch INTEGER NOT NULL, at INTEGER NOT NULL, coverage_from INTEGER, coverage_until INTEGER, payload TEXT NOT NULL,
      PRIMARY KEY(account, snapshot, part)
    );
    CREATE INDEX IF NOT EXISTS source_parts_reporter ON source_parts(account, reporter, source, purpose);
    CREATE INDEX IF NOT EXISTS source_parts_at ON source_parts(at);
    CREATE TABLE IF NOT EXISTS source_write_clock (
      account INTEGER PRIMARY KEY REFERENCES accounts(id), at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS source_write_waiters (
      account INTEGER NOT NULL REFERENCES accounts(id), reporter TEXT NOT NULL,
      queued INTEGER NOT NULL, seen INTEGER NOT NULL, PRIMARY KEY(account, reporter)
    );
  `);

  const accountState = account => get('SELECT * FROM source_accounts WHERE account=?', account);
  const active = account => accountState(account)?.active === 1;
  const changeLegacy = account => run(`INSERT INTO source_accounts VALUES (?, 0, 1)
    ON CONFLICT(account) DO UPDATE SET version=version+1`, account);
  const activate = account => run(`INSERT INTO source_accounts VALUES (?, 1, 0)
    ON CONFLICT(account) DO UPDATE SET active=1`, account);
  const state = (account, source) => get('SELECT * FROM source_states WHERE account=? AND source=?', account, source);
  const save = (account, source, row) => run(`INSERT INTO source_states VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account, source) DO UPDATE SET owner=excluded.owner, epoch=excluded.epoch, expires=excluded.expires,
    observed=excluded.observed, revision=excluded.revision, baseline=excluded.baseline`, account, source,
    row.kind, row.owner, row.epoch, row.expires, row.observed, row.revision, row.baseline);
  const revisions = account => ({
    legacy: accountState(account)?.version ?? 0,
    admin: get('SELECT version FROM source_admin_revision WHERE slot=1')?.version ?? 0
  });
  const firstDay = now => leaderboardDay(now - (RANKING_HOURS.at(-1) / 24 - 1) * DAY);
  const removed = (account, day) => Boolean(get(`SELECT 1 FROM hourly_removed WHERE account=? AND day=?
    UNION ALL SELECT 1 FROM scores WHERE account=? AND day=? AND tokens IS NULL
    UNION ALL SELECT 1 FROM locks WHERE account=? AND day=? LIMIT 1`, account, day, account, day, account, day));
  const usableSource = (operation, reporter) => validInstallationId(operation.sourceId) &&
    (operation.sourceKind === 'local' ? operation.sourceId === reporter
      : operation.sourceKind === 'ssh' && operation.sourceId !== reporter);
  const fresh = (at, now) => isUsageTime(at) && at <= now + CLOCK_SKEW && at > now - LEASE_MS;
  const isCoverage = (value, now) => Array.isArray(value) && value.length === 2 &&
    value.every(isUsageTime) && value[1] > value[0] && value[1] <= now + CLOCK_SKEW && value[1] - value[0] <= WINDOW;
  const batchValues = ({ daily, buckets, coverage }, now, maxTokens) =>
    Array.isArray(daily) && daily.length <= RANKING_HOURS.at(-1) / 24 + 1 &&
    daily.every(row => typeof row?.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.day) &&
      Number.isFinite(leaderboardDayStart(row.day)) && leaderboardDay(leaderboardDayStart(row.day)) === row.day &&
      row.day <= leaderboardDay(now) && Number.isSafeInteger(row.tokens) && row.tokens >= 0 && row.tokens <= maxTokens) &&
    new Set(daily.map(row => row.day)).size === daily.length && Array.isArray(buckets) &&
    buckets.every(row => Array.isArray(row) && row.length === 2 && isUsageTime(row[0]) && row[0] <= now + CLOCK_SKEW &&
      Number.isSafeInteger(row[1]) && row[1] >= 0 && row[1] <= maxTokens) &&
    new Set(buckets.map(row => row[0])).size === buckets.length && (coverage === undefined || isCoverage(coverage, now));

  function legacyDevices(account, now) {
    return all(`
      WITH old_values AS (
        SELECT installation_id AS reporter, day, NULL AS start, NULL AS end FROM installation_scores WHERE account=? AND day>=?
        UNION ALL SELECT '', s.day, NULL, NULL FROM scores s WHERE s.account=? AND s.day>=? AND s.tokens>0
          AND NOT EXISTS (SELECT 1 FROM installation_scores i WHERE i.account=s.account AND i.day=s.day)
        UNION ALL SELECT installation_id, NULL, completed_at, completed_at+1
          FROM rolling_usage WHERE account=? AND completed_at>=? AND tokens>0
        UNION ALL SELECT installation_id, NULL, hour_start, hour_start+?
          FROM hourly_usage WHERE account=? AND hour_start>=? AND tokens>0
      ) SELECT reporter AS reporterId, MIN(day) AS firstDay, MAX(day) AS lastDay, MIN(start) AS fromTime, MAX(end) AS toTime
        FROM old_values GROUP BY reporter ORDER BY reporter`,
    account, firstDay(now), account, firstDay(now), account, now - WINDOW, HOUR_MS, account, now - WINDOW);
  }

  function migrationStatus(account, now) {
    if (active(account)) return { code: 'accepted', mode: 'active' };
    const devices = legacyDevices(account, now);
    const staged = all(`SELECT snapshot AS snapshotId, source AS sourceId, reporter AS reporterId, kind AS sourceKind,
      coverage_from AS start, coverage_until AS end, count AS partCount, COUNT(*) AS received,
      GROUP_CONCAT(part) AS indexes FROM source_parts WHERE account=? AND purpose='migration'
      GROUP BY snapshot, source, reporter, kind, count ORDER BY MAX(at) DESC`, account);
    return { code: 'accepted', mode: devices.length ? 'migration' : 'empty', devices,
      legacyVersions: revisions(account), staged };
  }

  function grant(account, reporter, { sourceId, observedAt }, now) {
    if (!validInstallationId(sourceId) || sourceId === reporter || !fresh(observedAt, now)) return { code: 'invalid' };
    const old = state(account, sourceId);
    if (old?.kind === 'local') return { code: 'invalid' };
    if (old?.expires > now && old.owner !== reporter) return { code: 'standby', expiresAt: old.expires };
    const current = old?.expires > now;
    const row = current ? { ...old } : {
      kind: 'ssh', owner: reporter, epoch: (old?.epoch ?? 0) + 1, expires: 0,
      observed: 0, revision: 0, baseline: old?.revision > 0 || old?.baseline ? 1 : 0
    };
    if (observedAt > row.observed) {
      row.observed = observedAt;
      row.expires = now + LEASE_MS;
      save(account, sourceId, row);
    }
    return { code: 'accepted', leaseEpoch: row.epoch, expiresAt: row.expires, revision: row.revision, baseline: Boolean(row.baseline) };
  }

  const leased = (row, reporter, epoch, now) => row?.kind === 'ssh' &&
    row.owner === reporter && row.epoch === epoch && row.expires > now;
  const previousCoverage = (account, source) => get(`SELECT covered_from AS start, covered_until AS end
    FROM rolling_uploads WHERE account=? AND installation_id=?`, account, source);
  const deleteRolling = (account, source, from, until) => run(`DELETE FROM rolling_usage
    WHERE account=? AND installation_id=? AND completed_at>=? AND completed_at<?`, account, source, from, until);

  function applyRows(account, source, { daily, buckets, coverage }, clock, now, replace = false) {
    const oldCoverage = previousCoverage(account, source);
    if (replace) deleteRolling(account, source, coverage[0], coverage[1]);
    const blocked = new Map();
    for (const [at, tokens] of buckets) {
      if (at < now - WINDOW || (replace && at >= coverage[1])) continue;
      const day = leaderboardDay(at);
      if (!blocked.has(day)) blocked.set(day, removed(account, day));
      if (blocked.get(day)) continue;
      if (!tokens) {
        deleteRolling(account, source, at, at + 1);
      } else {
        run(`INSERT INTO rolling_usage VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(account, installation_id, completed_at) DO UPDATE SET
          tokens=excluded.tokens, submitted_at=excluded.submitted_at WHERE tokens<>excluded.tokens`, account, source, at, tokens, now);
      }
    }
    if (coverage) {
      let [start, end] = coverage;
      if (!replace && oldCoverage?.end >= start && oldCoverage.start != null) {
        start = Math.min(start, oldCoverage.start);
        end = Math.max(end, oldCoverage.end);
      }
      run(`INSERT INTO rolling_uploads VALUES (?, ?, ?, ?, '', ?, ?)
        ON CONFLICT(account, installation_id) DO UPDATE SET version=excluded.version, request_id=excluded.request_id,
        fingerprint=excluded.fingerprint, covered_from=excluded.covered_from, covered_until=excluded.covered_until`,
      account, source, clock.revision, clock.requestId, Math.max(start, now - WINDOW), end);
    }
    const days = new Map(daily.map(({ day, tokens }) => [day, tokens]));
    if (replace) {
      const start = leaderboardDay(coverage[0]);
      for (const { day } of all(`SELECT day FROM installation_scores WHERE account=? AND installation_id=? AND day>=? AND day<=?`,
        account, source, start, leaderboardDay(coverage[1]))) {
        if (!days.has(day) && leaderboardDayStart(day) >= coverage[0]) days.set(day, 0);
      }
    }
    for (const [day, tokens] of days) {
      if (day >= firstDay(now) && !removed(account, day)) saveDaily(account, source, day, tokens, now);
    }
  }

  function update(account, reporter, op, now, maxTokens, requestId) {
    if (!usableSource(op, reporter) || !batchValues(op, now, maxTokens) ||
        !Number.isSafeInteger(op.revision) || op.revision < 1) return { code: 'invalid' };
    const old = state(account, op.sourceId);
    if (old && old.kind !== op.sourceKind) return { code: 'invalid' };
    if (op.sourceKind === 'ssh') {
      if (!leased(old, reporter, op.leaseEpoch, now)) return { code: 'lease_expired' };
      if (old.baseline) return { code: 'baseline_required' };
    }
    if (op.revision <= (old?.revision ?? 0)) return { code: 'stale_version', revision: old.revision };
    if (op.coverage && op.coverage[1] < (previousCoverage(account, op.sourceId)?.end ?? 0)) {
      return { code: 'stale_version', revision: old?.revision ?? 0 };
    }
    const row = { ...(old ?? { kind: 'local', owner: reporter, epoch: 0, expires: 0, observed: 0, baseline: 0 }),
      revision: op.revision };
    applyRows(account, op.sourceId, op, { revision: op.revision, requestId }, now);
    save(account, op.sourceId, row);
    activate(account);
    return { code: 'accepted', revision: op.revision };
  }

  function stage(account, reporter, op, now, maxTokens) {
    const { sourceId, sourceKind, snapshotId, partIndex, partCount, purpose, coverage } = op;
    if (!usableSource(op, reporter) || !batchValues(op, now, maxTokens) || !validInstallationId(snapshotId) ||
        !Number.isSafeInteger(partIndex) || !Number.isSafeInteger(partCount) || partIndex < 0 || partIndex >= partCount ||
        partCount > MAX_PARTS || !['handover', 'migration'].includes(purpose)) return { code: 'invalid' };
    if (purpose === 'handover' && (!leased(state(account, sourceId), reporter, op.leaseEpoch, now) || sourceKind !== 'ssh')) {
      return { code: 'lease_expired' };
    }
    if (purpose === 'migration' && (active(account) || !coverage)) return { code: 'invalid' };
    const epoch = purpose === 'handover' ? op.leaseEpoch : 0;
    const existing = get('SELECT * FROM source_parts WHERE account=? AND snapshot=? LIMIT 1', account, snapshotId);
    if (existing && (existing.reporter !== reporter || existing.source !== sourceId || existing.kind !== sourceKind ||
        existing.count !== partCount || existing.purpose !== purpose || existing.epoch !== epoch ||
        existing.coverage_from !== (coverage?.[0] ?? null) || existing.coverage_until !== (coverage?.[1] ?? null))) return { code: 'invalid' };
    const payload = JSON.stringify({ daily: op.daily, buckets: op.buckets });
    const duplicate = get('SELECT payload FROM source_parts WHERE account=? AND snapshot=? AND part=?', account, snapshotId, partIndex);
    if (duplicate?.payload !== undefined && duplicate.payload !== payload) return { code: 'invalid' };
    if (!existing) run('DELETE FROM source_parts WHERE account=? AND reporter=? AND source=? AND purpose=?',
      account, reporter, sourceId, purpose);
    if (!duplicate) run('INSERT INTO source_parts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      account, reporter, sourceId, snapshotId, partIndex, partCount, sourceKind, purpose, epoch, now,
      coverage?.[0] ?? null, coverage?.[1] ?? null, payload);
    return { code: 'accepted', snapshotId, partIndex };
  }

  function readSnapshot(account, id) {
    const parts = all('SELECT * FROM source_parts WHERE account=? AND snapshot=? ORDER BY part', account, id);
    if (!parts.length || parts.length !== parts[0].count) return;
    const { reporter, source, kind, purpose, epoch, coverage_from: from, coverage_until: to } = parts[0];
    const daily = [], buckets = [];
    for (const { payload } of parts) {
      const part = JSON.parse(payload);
      for (const row of part.daily) daily.push(row);
      for (const row of part.buckets) buckets.push(row);
    }
    if (new Set(daily.map(row => row.day)).size !== daily.length || new Set(buckets.map(([at]) => at)).size !== buckets.length) return;
    return { reporter, source, kind, purpose, epoch, daily, buckets, coverage: from === null ? undefined : [from, to] };
  }

  function commitBaseline(account, reporter, { sourceId, snapshotId, leaseEpoch, coverage }, now, requestId) {
    if (!validInstallationId(sourceId) || !validInstallationId(snapshotId) || !isCoverage(coverage, now)) return { code: 'invalid' };
    const old = state(account, sourceId);
    if (!leased(old, reporter, leaseEpoch, now)) return { code: 'lease_expired' };
    if (!old.baseline) return { code: 'stale_version', revision: old.revision };
    if (coverage[0] > now - WINDOW || coverage[1] < (previousCoverage(account, sourceId)?.end ?? 0) ||
        coverage[1] <= now - WINDOW) return { code: 'baseline_required' };
    const batch = readSnapshot(account, snapshotId);
    if (batch?.purpose !== 'handover' || batch.source !== sourceId || batch.reporter !== reporter ||
        batch.epoch !== leaseEpoch || (batch.coverage && batch.coverage.some((at, i) => at !== coverage[i]))) return { code: 'baseline_required' };
    applyRows(account, sourceId, { ...batch, coverage }, { revision: 1, requestId }, now, true);
    save(account, sourceId, { ...old, revision: 1, baseline: 0 });
    run('DELETE FROM source_parts WHERE account=? AND snapshot=?', account, snapshotId);
    activate(account);
    return { code: 'accepted', snapshotId, revision: 1 };
  }

  function explains(account, device, snapshots, now) {
    const { reporterId, firstDay: first, lastDay, fromTime, toTime } = device;
    if (!snapshots.some(batch => batch.kind === 'local' && batch.source === reporterId) ||
        snapshots.some(({ coverage: [from, to] }) => (first && (from > leaderboardDayStart(first) || to < leaderboardDayStart(lastDay))) ||
          (fromTime !== null && (from > fromTime || to < toTime)))) return false;
    const daily = new Map(), rolling = new Map(), hourly = new Map();
    for (const batch of snapshots) {
      for (const { day, tokens } of batch.daily) daily.set(day, (daily.get(day) ?? 0n) + BigInt(tokens));
      for (const [at, tokens] of batch.buckets) {
        rolling.set(at, (rolling.get(at) ?? 0n) + BigInt(tokens));
        const hour = Math.floor(at / HOUR_MS) * HOUR_MS;
        hourly.set(hour, (hourly.get(hour) ?? 0n) + BigInt(tokens));
      }
    }
    return all('SELECT day, tokens FROM installation_scores WHERE account=? AND installation_id=? AND day>=?', account, reporterId, firstDay(now))
      .every(({ day, tokens }) => (daily.get(day) ?? 0n) >= BigInt(tokens)) &&
      all(`SELECT completed_at AS at, tokens FROM rolling_usage WHERE account=? AND installation_id=? AND completed_at>=?`,
        account, reporterId, now - WINDOW).every(({ at, tokens }) => (rolling.get(at) ?? 0n) >= BigInt(tokens)) &&
      all(`SELECT hour_start AS at, tokens FROM hourly_usage WHERE account=? AND installation_id=? AND hour_start>=?`,
        account, reporterId, now - WINDOW).every(({ at, tokens }) => (hourly.get(at) ?? 0n) >= BigInt(tokens));
  }

  function commitMigration(account, { legacyVersions, snapshots }, now, requestId) {
    if (active(account)) return { code: 'accepted', mode: 'active' };
    const expected = revisions(account), devices = legacyDevices(account, now);
    if (legacyVersions?.legacy !== expected.legacy || legacyVersions?.admin !== expected.admin) {
      return { code: 'migration_changed', legacyVersions: expected, devices };
    }
    if (!Array.isArray(snapshots) || !snapshots.length || snapshots.length > 512 ||
        new Set(snapshots).size !== snapshots.length || !snapshots.every(validInstallationId)) return { code: 'invalid' };
    const batches = snapshots.map(id => readSnapshot(account, id));
    if (batches.some(batch => batch?.purpose !== 'migration' || !batch.coverage)) return { code: 'migration_pending', devices };
    const byReporter = Map.groupBy(batches, batch => batch.reporter);
    const pending = devices.filter(device => !explains(account, device, byReporter.get(device.reporterId) ?? [], now));
    if (pending.length) return { code: 'migration_pending', devices: pending };
    const chosen = [];
    for (const copies of Map.groupBy(batches, batch => batch.source).values()) {
      if (copies.some(batch => batch.kind !== copies[0].kind)) return { code: 'invalid' };
      const current = copies.toSorted((a, b) => b.coverage[1] - a.coverage[1]);
      const batch = current.find(candidate => {
        const daily = new Map(candidate.daily.map(row => [row.day, row.tokens]));
        const buckets = new Map(candidate.buckets);
        return current.every(other => other.daily.every(({ day, tokens }) =>
          day < firstDay(now) || removed(account, day) || (daily.get(day) ?? 0) >= tokens) &&
          other.buckets.every(([at, tokens]) => at < now - WINDOW || removed(account, leaderboardDay(at)) || (buckets.get(at) ?? 0) >= tokens));
      });
      if (!batch) return { code: 'migration_pending', devices };
      chosen.push(batch);
    }
    replaceLegacyDaily(account, firstDay(now));
    run('DELETE FROM rolling_usage WHERE account=?', account);
    run('DELETE FROM rolling_uploads WHERE account=?', account);
    for (const batch of chosen) {
      applyRows(account, batch.source, batch, { revision: 1, requestId }, now, true);
      save(account, batch.source, { kind: batch.kind, owner: batch.reporter, epoch: 0,
        expires: 0, observed: 0, revision: 1, baseline: batch.kind === 'ssh' ? 1 : 0 });
    }
    activate(account);
    run('DELETE FROM source_parts WHERE account=?', account);
    return { code: 'accepted', mode: 'active' };
  }

  const writesRanking = op => ['update', 'baseline-commit', 'migration-commit'].includes(op.type);
  function upload(account, input, now, maxTokens, expectedUsername) {
    const { reporterId, requestId, fingerprint, operations } = input;
    const day = leaderboardDay(now);
    if (get('SELECT 1 FROM locks WHERE day=? AND account=?', day, account)) return { code: 'locked' };
    const previous = get('SELECT fingerprint, result FROM source_receipts WHERE account=? AND reporter=? AND request=?',
      account, reporterId, requestId);
    if (previous) return previous.fingerprint === fingerprint ? JSON.parse(previous.result) : { code: 'invalid' };
    if (input.username !== undefined && input.username.toLowerCase() !== expectedUsername.toLowerCase()) {
      return { code: 'username_changed' };
    }
    const mutates = operations.some(op => op.type !== 'migration-status');
    const gateInput = { requestId: 'sources:' + requestId, installationId: reporterId, fingerprint };
    const gate = mutates ? uploadGate(account, day, gateInput, now) : null;
    if (gate) return { code: gate };
    const legacy = !active(account) && legacyDevices(account, now).length > 0;
    let nextAt = nextUpload(account, now) ?? 0;
    const mayWrite = operations.some(op => writesRanking(op) && (!legacy || op.type === 'migration-commit'));
    if (mayWrite) {
      run('DELETE FROM source_write_waiters WHERE account=? AND seen<=?', account, now - 30_000);
      const waiting = get('SELECT reporter FROM source_write_waiters WHERE account=? ORDER BY queued, reporter LIMIT 1', account);
      if (!waiting || waiting.reporter === reporterId) {
        if (!nextAt) run('DELETE FROM source_write_waiters WHERE account=? AND reporter=?', account, reporterId);
      } else nextAt = Math.max(nextAt, now + 1000);
      if (nextAt) run(`INSERT INTO source_write_waiters VALUES (?, ?, ?, ?)
        ON CONFLICT(account, reporter) DO UPDATE SET seen=excluded.seen`, account, reporterId, now, now);
    }
    let changed = false;
    const results = operations.map(op => {
      let result;
      if (op.type === 'migration-status') result = migrationStatus(account, now);
      else if (op.type === 'baseline-part' && op.purpose === 'migration') result = stage(account, reporterId, op, now, maxTokens);
      else if (legacy && op.type !== 'migration-commit') result = { code: 'migration_required' };
      else if (writesRanking(op) && nextAt > now) result = { code: 'too_soon', nextUploadAt: nextAt };
      else if (op.type === 'lease') result = grant(account, reporterId, op, now);
      else if (op.type === 'update') result = update(account, reporterId, op, now, maxTokens, requestId);
      else if (op.type === 'baseline-part') result = stage(account, reporterId, op, now, maxTokens);
      else if (op.type === 'baseline-commit') result = commitBaseline(account, reporterId, op, now, requestId);
      else if (op.type === 'migration-commit') result = commitMigration(account, op, now, requestId);
      else result = { code: 'invalid' };
      changed ||= writesRanking(op) && result.code === 'accepted';
      return { ...(validInstallationId(op.sourceId) ? { sourceId: op.sourceId } : {}), ...result };
    });
    if (changed) run(`INSERT INTO source_write_clock VALUES (?, ?) ON CONFLICT(account) DO UPDATE SET at=excluded.at`, account, now);
    const result = { code: 'accepted', results, changed };
    if (results.some(row => row.code === 'invalid')) {
      if (invalidUpload(account, day, gateInput, now) === 'locked') result.code = 'locked';
    }
    if (mutates) run('INSERT INTO source_receipts VALUES (?, ?, ?, ?, ?, ?)',
      account, reporterId, requestId, fingerprint, JSON.stringify({ ...result, changed: false }), now);
    return result;
  }

  return {
    active, changeLegacy, upload,
    adminChanged: () => run(`INSERT INTO source_admin_revision VALUES (1, 1)
      ON CONFLICT(slot) DO UPDATE SET version=version+1`),
    prune(now) {
      run('DELETE FROM source_receipts WHERE at<?', now - DAY);
      run('DELETE FROM source_parts WHERE at<?', now - WINDOW);
      run('DELETE FROM source_write_clock WHERE at<?', now - DAY);
      run('DELETE FROM source_write_waiters WHERE seen<=?', now - 30_000);
    }
  };
}

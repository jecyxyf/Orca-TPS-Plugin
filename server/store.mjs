import { DatabaseSync } from 'node:sqlite';
import { leaderboardDay, leaderboardDayStart, MAX_WINDOW_DAYS } from '../src/usage-summary.mjs';
import { validInstallationId } from '../src/leaderboard-installation.mjs';
import { RECENT_STATS_MS, SPEED_WINDOW_MS, SPEED_MIN_DELTA, qualifyingSpeed, validSubmissionStats } from '../src/leaderboard-stats.mjs';
import { openHourlyRankings } from './hourly-rankings.mjs';
import { openSourceUploads } from './source-uploads.mjs';
import { openLeaderboardData, validHourlySource } from './leaderboard-data.mjs';

const TEN_MINUTES = 10 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const UPLOAD_INTERVAL = 10_000;
const RAPID_UPLOAD_INTERVAL = 5000;
const RAPID_UPLOAD_REASON = '连续 4 次上传间隔不足 5 秒';
const DAILY_LOCK_REASON = '10 分钟内提交错误累计 5 次';

export function openLeaderboardStore(filename, { readOnly = false } = {}) {
  const db = new DatabaseSync(filename, { readOnly });
  let rankingRevision = 0, speedRevision = 0;
  let writing = false;
  db.exec('PRAGMA busy_timeout=3000');
  if (!readOnly) db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY, username TEXT NOT NULL, banned INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS source_accounts (
      account INTEGER PRIMARY KEY REFERENCES accounts(id), active INTEGER NOT NULL, version INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS administrator (
      slot INTEGER PRIMARY KEY CHECK(slot=1), account INTEGER NOT NULL REFERENCES accounts(id)
    );
    CREATE TABLE IF NOT EXISTS ban_reasons (
      account INTEGER PRIMARY KEY REFERENCES accounts(id), reason TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      digest TEXT PRIMARY KEY, account INTEGER NOT NULL REFERENCES accounts(id),
      kind TEXT NOT NULL, expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scores (
      day TEXT NOT NULL, account INTEGER NOT NULL REFERENCES accounts(id),
      tokens INTEGER, submitted_at INTEGER NOT NULL, PRIMARY KEY(day, account)
    );
    CREATE INDEX IF NOT EXISTS score_order ON scores(day, tokens DESC, submitted_at, account);
    CREATE TABLE IF NOT EXISTS installation_scores (
      day TEXT NOT NULL, account INTEGER NOT NULL, installation_id TEXT NOT NULL, tokens INTEGER NOT NULL,
      PRIMARY KEY(day, account, installation_id),
      FOREIGN KEY(day, account) REFERENCES scores(day, account) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS score_updates (
      day TEXT NOT NULL, account INTEGER NOT NULL REFERENCES accounts(id),
      updated_at INTEGER NOT NULL, PRIMARY KEY(day, account)
    );
    CREATE INDEX IF NOT EXISTS score_update_clock ON score_updates(account, updated_at DESC);
    CREATE TABLE IF NOT EXISTS score_initializations (
      account INTEGER PRIMARY KEY REFERENCES accounts(id), uploaded_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS upload_attempt_clock (
      account INTEGER PRIMARY KEY REFERENCES accounts(id), attempted_at INTEGER NOT NULL, consecutive INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS installation_upload_clock (
      account INTEGER NOT NULL REFERENCES accounts(id), installation_id TEXT NOT NULL,
      attempted_at INTEGER NOT NULL, consecutive INTEGER NOT NULL, PRIMARY KEY(account, installation_id)
    );
    CREATE TABLE IF NOT EXISTS attempts (
      day TEXT NOT NULL, account INTEGER NOT NULL REFERENCES accounts(id), request_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL, outcome TEXT NOT NULL, received_at INTEGER NOT NULL,
      PRIMARY KEY(day, account, request_id, fingerprint)
    );
    CREATE INDEX IF NOT EXISTS attempt_window ON attempts(day, account, received_at);
    CREATE TABLE IF NOT EXISTS submission_stats (
      account INTEGER NOT NULL REFERENCES accounts(id), request_id TEXT NOT NULL, day TEXT NOT NULL,
      submitted_at INTEGER NOT NULL, delta_tokens INTEGER NOT NULL, avg_tps REAL, top_model TEXT, top_cli TEXT,
      PRIMARY KEY(account, request_id)
    );
    CREATE INDEX IF NOT EXISTS submission_stats_by_account ON submission_stats(account, submitted_at);
    CREATE INDEX IF NOT EXISTS submission_stats_by_time ON submission_stats(submitted_at);
    CREATE INDEX IF NOT EXISTS submission_stats_speed ON submission_stats(avg_tps DESC, submitted_at, account, request_id)
      WHERE delta_tokens>${SPEED_MIN_DELTA} AND avg_tps>0;
    CREATE TABLE IF NOT EXISTS locks (
      day TEXT NOT NULL, account INTEGER NOT NULL REFERENCES accounts(id), PRIMARY KEY(day, account)
    );
    CREATE TABLE IF NOT EXISTS lock_reasons (
      day TEXT NOT NULL, account INTEGER NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(day, account),
      FOREIGN KEY(day, account) REFERENCES locks(day, account) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY, account INTEGER NOT NULL REFERENCES accounts(id),
      action TEXT NOT NULL, target TEXT NOT NULL, at INTEGER NOT NULL
    );
  `);

  function transaction(work) {
    if (writing) return work();
    const before = [rankingRevision, speedRevision];
    db.exec('BEGIN IMMEDIATE');
    writing = true;
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      [rankingRevision, speedRevision] = before;
      throw error;
    } finally {
      writing = false;
    }
  }
  const get = (sql, ...values) => db.prepare(sql).get(...values);
  const all = (sql, ...values) => db.prepare(sql).all(...values);
  const run = (sql, ...values) => db.prepare(sql).run(...values);
  const hourly = openHourlyRankings(db, transaction, readOnly);
  const sources = readOnly ? null : openSourceUploads(db, {
    get, all, run, nextUpload, uploadGate, invalidUpload, saveDaily: saveSourceDaily, replaceLegacyDaily
  });
  const leaderboardData = openLeaderboardData(db, readOnly);
  const removeOldWaiters = db.prepare('DELETE FROM source_write_waiters WHERE account=? AND seen<=?');
  const firstWaiter = db.prepare('SELECT reporter FROM source_write_waiters WHERE account=? ORDER BY queued, reporter LIMIT 1');
  const addWaiter = db.prepare(`INSERT INTO source_write_waiters VALUES (?, ?, ?, ?)
    ON CONFLICT(account, reporter) DO UPDATE SET seen=excluded.seen`);
  const clearWaiter = db.prepare('DELETE FROM source_write_waiters WHERE account=? AND reporter=?');
  const adminRevision = db.prepare('SELECT version FROM source_admin_revision WHERE slot=1');
  const readAdminRevision = () => adminRevision.get()?.version ?? 0;
  function invalidateResults() {
    sources.adminChanged();
    leaderboardData.invalidateResults();
  }
  const administrator = () => get('SELECT account FROM administrator WHERE slot=1')?.account;
  const audit = (actor, action, target, now) =>
    run('INSERT INTO audit(account, action, target, at) VALUES (?, ?, ?, ?)', actor, action, target, now);
  const periodRanks = db.prepare(`
    WITH totals AS (
      SELECT account, SUM(tokens) AS tokens, MAX(uploaded_at) AS submittedAt
      FROM leaderboard_daily_scores
      WHERE day BETWEEN ? AND ? AND tokens IS NOT NULL
      GROUP BY account
    ), ranked AS (
      SELECT *, ROW_NUMBER() OVER (ORDER BY tokens DESC, submittedAt, account) AS rank
      FROM totals
    )
    SELECT accounts.username, ranked.account, ranked.tokens, ranked.submittedAt, ranked.rank
    FROM ranked JOIN accounts ON accounts.id=ranked.account
    WHERE ranked.rank<=100 OR ranked.account=?
    ORDER BY ranked.rank
  `);
  periodRanks.setReadBigInts(true);

  function upsertAccount({ id, login }) {
    transaction(() => {
      const old = get('SELECT username FROM accounts WHERE id=?', id);
      if (run(`INSERT INTO accounts(id, username) VALUES (?, ?) ON CONFLICT(id) DO UPDATE
        SET username=excluded.username WHERE accounts.username<>excluded.username`, id, login).changes) {
        rankingRevision++;
        speedRevision++;
        hourly.revision();
        if (old) invalidateResults();
      }
    });
  }

  const fastestSubmissions = db.prepare(`SELECT submission_stats.account, accounts.username,
        submitted_at AS submittedAt, avg_tps AS avgTps, delta_tokens AS deltaTokens,
        top_model AS topModel, top_cli AS topCli, request_id AS requestId
      FROM submission_stats JOIN accounts ON accounts.id=submission_stats.account
      WHERE delta_tokens>${SPEED_MIN_DELTA} AND avg_tps>0 AND submitted_at>? AND submitted_at<=? AND accounts.banned=0
      ORDER BY avg_tps DESC, submitted_at, account, request_id`);

  function speedRanking(now) {
    const rows = [], accounts = new Set();
    let expiresAt = Infinity;
    for (const { account, requestId, ...row } of fastestSubmissions.iterate(now - SPEED_WINDOW_MS, now)) {
      if (accounts.has(account)) continue;
      accounts.add(account);
      rows.push({ ...row, rank: rows.length + 1 });
      expiresAt = Math.min(expiresAt, row.submittedAt + SPEED_WINDOW_MS);
      if (rows.length === 20) break;
    }
    return { rows, expiresAt };
  }

  function publishedSpeeds(cutoff) {
    const from = cutoff - SPEED_WINDOW_MS;
    const candidates = [...fastestSubmissions.all(from - 1, cutoff - 1), ...leaderboardData.speeds(from, cutoff)];
    candidates.sort((a, b) => b.avgTps - a.avgTps || a.submittedAt - b.submittedAt || a.account - b.account ||
      (a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0));
    const rows = [], accounts = new Set();
    for (const { account, requestId, ...row } of candidates) {
      if (accounts.has(account)) continue;
      accounts.add(account);
      rows.push({ ...row, rank: rows.length + 1 });
      if (rows.length === 20) break;
    }
    return rows;
  }

  function bindAdministrator(account) {
    run('INSERT INTO administrator(slot, account) VALUES (1, ?) ON CONFLICT(slot) DO NOTHING', account);
    return administrator() === account;
  }

  function session(digest, kind, now) {
    return get(`
      SELECT accounts.id, accounts.username, accounts.banned
      FROM sessions JOIN accounts ON accounts.id=sessions.account
      WHERE digest=? AND kind=? AND expires>?
    `, digest, kind, now);
  }

  function readScore(account, day) {
    return get('SELECT tokens, submitted_at, uploaded_at FROM leaderboard_daily_scores WHERE day=? AND account=?', day, account);
  }

  function nextUpload(account, now) {
    const updated = get('SELECT updated_at FROM score_updates WHERE account=? ORDER BY updated_at DESC LIMIT 1', account);
    const legacy = get('SELECT MAX(submitted_at) AS at FROM scores WHERE day IN (?, ?) AND account=?',
      leaderboardDay(now), leaderboardDay(now - UPLOAD_INTERVAL), account);
    const initialization = get('SELECT uploaded_at FROM score_initializations WHERE account=?', account);
    const sourceWrite = get('SELECT at FROM source_write_clock WHERE account=?', account);
    const next = Math.max(updated?.updated_at ?? -Infinity, legacy?.at ?? -Infinity,
      initialization?.uploaded_at ?? -Infinity, sourceWrite?.at ?? -Infinity) + UPLOAD_INTERVAL;
    return next > now ? next : null;
  }

  function status(account, now, score = readScore(account, leaderboardDay(now))) {
    const day = leaderboardDay(now);
    const locked = Boolean(get('SELECT 1 FROM locks WHERE day=? AND account=?', day, account));
    return {
      day, submitted: Boolean(score), tokens: score?.tokens ?? null, submittedAt: score?.uploaded_at ?? null,
      lockedUntil: locked ? leaderboardDayStart(day) + DAY : null,
      nextUploadAt: nextUpload(account, now)
    };
  }

  function ranking(account, now, days = 1, includeRecent = false, includeDaily = false) {
    const day = leaderboardDay(now);
    const score = account === null ? null : readScore(account, day);
    const state = account === null ? { day } : status(account, now, score);
    if (days > 1) {
      const startDay = leaderboardDay(now - (days - 1) * DAY);
      // Sort the exact SQLite totals before converting to numbers for MB display.
      const rows = periodRanks.all(startDay, day, account).map(row => ({
        username: row.username, tokens: Number(row.tokens), submittedAt: Number(row.submittedAt),
        rank: Number(row.rank), account: Number(row.account), mine: Number(row.account) === account
      }));
      return { ...state, days, startDay, rank: rows.find(row => row.mine)?.rank ?? null,
        rows: rankingRows(rows.slice(0, 100), now, includeRecent, includeDaily ? { startDay, day } : null) };
    }
    const rows = all(`
      SELECT accounts.username, scores.account, scores.tokens, scores.uploaded_at AS submittedAt
      FROM leaderboard_daily_scores scores JOIN accounts ON accounts.id=scores.account
      WHERE scores.day=? AND scores.tokens IS NOT NULL
      ORDER BY scores.tokens DESC, scores.submitted_at, scores.account LIMIT 100
    `, state.day).map((row, index) => ({ ...row, rank: index + 1, mine: row.account === account }));
    const rank = score?.tokens == null ? null : 1 + get(`
      SELECT COUNT(*) AS count FROM leaderboard_daily_scores WHERE day=? AND (
        tokens>? OR (tokens=? AND (submitted_at<? OR (submitted_at=? AND account<?)))
      )
    `, day, score.tokens, score.tokens, score.submitted_at, score.submitted_at, account).count;
    return { ...state, rank, rows: rankingRows(rows, now, includeRecent) };
  }

  function recentRows(accounts, now, latestOnly) {
    const recent = new Map();
    if (accounts.length) {
      const placeholders = accounts.map(() => '?').join(',');
      const points = all(`
        SELECT account, submitted_at AS submittedAt, delta_tokens AS deltaTokens, avg_tps AS avgTps,
          top_model AS topModel, top_cli AS topCli
        FROM submission_stats WHERE account IN (${placeholders})
          AND submitted_at>? AND submitted_at<=?
        ORDER BY submitted_at`, ...accounts, now - RECENT_STATS_MS, now);
      for (const { account, recent } of leaderboardData.recent(accounts, now)) {
        for (const { at, deltaTokens, avgTps, topModel, topCli } of JSON.parse(recent)) {
          if (at > now - RECENT_STATS_MS && at <= now) points.push({ account, submittedAt: at, deltaTokens, avgTps, topModel, topCli });
        }
      }
      for (const { account, topModel, topCli, ...point } of points.sort((a, b) => a.submittedAt - b.submittedAt)) {
        const entry = recent.get(account) ?? { points: [] };
        if (latestOnly) entry.points[0] = point;
        else {
          entry.points.push(point);
          if (entry.points.length > 30) entry.points.shift();
        }
        entry.topModel = topModel;
        entry.topCli = topCli;
        recent.set(account, entry);
      }
    }
    return recent;
  }

  function latestUploads(accounts) {
    if (!accounts.length) return new Map();
    const placeholders = accounts.map(() => '?').join(',');
    const times = new Map(all(`SELECT account, MAX(updated_at) AS time FROM score_updates
      WHERE account IN (${placeholders}) GROUP BY account`, ...accounts).map(({ account, time }) => [account, time]));
    for (const { account, time } of leaderboardData.latestUploads(accounts)) {
      if (time != null) times.set(account, Math.max(times.get(account) ?? 0, time));
    }
    return times;
  }

  function rankingRows(rows, now, includeRecent, dailyWindow = null) {
    if (!includeRecent && !dailyWindow) return rows.map(({ account, ...row }) => row);
    const daily = new Map(), accounts = rows.map(row => row.account);
    const recent = includeRecent ? recentRows(accounts, now, Boolean(dailyWindow)) : null;
    if (dailyWindow && rows.length) {
      const placeholders = accounts.map(() => '?').join(',');
      for (const { account, ...point } of all(`
        SELECT account, day, tokens FROM leaderboard_daily_scores WHERE account IN (${placeholders})
          AND day BETWEEN ? AND ? AND tokens IS NOT NULL ORDER BY day`, ...accounts, dailyWindow.startDay, dailyWindow.day)) {
        const points = daily.get(account) ?? [];
        points.push(point);
        daily.set(account, points);
      }
    }
    return rows.map(({ account, ...row }) => ({
      ...row,
      ...(includeRecent ? { recent: recent.get(account) ?? { points: [], topModel: null, topCli: null } } : {}),
      ...(dailyWindow ? { daily: daily.get(account) ?? [] } : {})
    }));
  }

  function uploadGate(account, day, { requestId, fingerprint, installationId }, now) {
    if (get('SELECT banned FROM accounts WHERE id=?', account)?.banned) return 'banned';
    if (get('SELECT 1 FROM locks WHERE day=? AND account=?', day, account)) return 'locked';
    const oldAttempt = get(`
      SELECT outcome FROM attempts WHERE day=? AND account=? AND request_id=? AND fingerprint=?
    `, day, account, requestId, fingerprint);
    if (oldAttempt) return oldAttempt.outcome;
    const identified = validInstallationId(installationId);
    const recent = identified
      ? get('SELECT attempted_at, consecutive FROM installation_upload_clock WHERE account=? AND installation_id=?', account, installationId)
      : get('SELECT attempted_at, consecutive FROM upload_attempt_clock WHERE account=?', account);
    // A Kafka partition can catch up after a different source from the same reporter has already written.
    if (recent && now < recent.attempted_at) return null;
    const consecutive = recent && now - recent.attempted_at < RAPID_UPLOAD_INTERVAL ? recent.consecutive + 1 : 0;
    if (identified) {
      run(`INSERT INTO installation_upload_clock VALUES (?, ?, ?, ?) ON CONFLICT(account, installation_id)
        DO UPDATE SET attempted_at=excluded.attempted_at, consecutive=excluded.consecutive`, account, installationId, now, consecutive);
    } else {
      run(`INSERT INTO upload_attempt_clock VALUES (?, ?, ?) ON CONFLICT(account)
        DO UPDATE SET attempted_at=excluded.attempted_at, consecutive=excluded.consecutive`, account, now, consecutive);
    }
    if (consecutive <= 3) return null;
    banAccount(account, RAPID_UPLOAD_REASON);
    return 'banned';
  }

  function recordAttempt(account, day, { requestId, fingerprint }, outcome, now) {
    run('INSERT INTO attempts VALUES (?, ?, ?, ?, ?, ?)', day, account, requestId, fingerprint, outcome, now);
    return outcome;
  }

  function invalidUpload(account, day, input, now) {
    recordAttempt(account, day, input, 'invalid', now);
    const { count } = get(`
      SELECT COUNT(*) AS count FROM attempts
      WHERE day=? AND account=? AND received_at>? AND outcome IN ('invalid', 'duplicate')
    `, day, account, now - TEN_MINUTES);
    if (count < 5) return 'invalid';
    run('INSERT INTO locks VALUES (?, ?)', day, account);
    run('INSERT INTO lock_reasons VALUES (?, ?, ?)', day, account, DAILY_LOCK_REASON);
    return 'locked';
  }

  const validTokens = (tokens, maxTokens) => Number.isSafeInteger(tokens) && tokens >= 1 && tokens <= maxTokens;
  const validInstallation = value => value === undefined || validInstallationId(value);
  const reusedRequest = (account, day, requestId) =>
    Boolean(get('SELECT 1 FROM attempts WHERE day=? AND account=? AND request_id=?', day, account, requestId));
  const historyInitialized = account => Boolean(get('SELECT 1 FROM score_initializations WHERE account=?', account));

  function saveInstallationScore(day, account, installationId, tokens) {
    run(`INSERT INTO installation_scores VALUES (?, ?, ?, ?)
      ON CONFLICT(day, account, installation_id) DO UPDATE SET tokens=excluded.tokens`, day, account, installationId, tokens);
  }

  function saveSourceDaily(account, source, day, tokens, now) {
    const previous = readScore(account, day);
    if (previous === undefined && !tokens) return;
    if (previous === undefined) run('INSERT INTO scores VALUES (?, ?, 0, ?)', day, account, now);
    if (tokens) saveInstallationScore(day, account, source, tokens);
    else run('DELETE FROM installation_scores WHERE day=? AND account=? AND installation_id=?', day, account, source);
    const { tokens: sum } = get('SELECT TOTAL(tokens) AS tokens FROM installation_scores WHERE day=? AND account=?', day, account);
    if (!sum) run('DELETE FROM scores WHERE day=? AND account=?', day, account);
    else {
      const safe = Math.min(Number.MAX_SAFE_INTEGER, sum);
      run('UPDATE scores SET tokens=? WHERE day=? AND account=?', safe, day, account);
      if (safe === previous?.tokens) return;
    }
    run(`INSERT INTO score_updates VALUES (?, ?, ?) ON CONFLICT(day, account) DO UPDATE SET updated_at=excluded.updated_at`,
      day, account, now);
  }

  function replaceLegacyDaily(account, fromDay) {
    run('DELETE FROM scores WHERE account=? AND day>=? AND tokens IS NOT NULL', account, fromDay);
  }

  function submit(account, input, now, maxTokens) {
    if (sources.active(account)) return 'upgrade_required';
    const { day: requestedDay, installationId, tokens, requestId, stats } = input;
    const day = leaderboardDay(now);
    let changed = false;
    const outcome = transaction(() => {
      const blocked = uploadGate(account, day, input, now);
      if (blocked) return blocked;
      const score = get('SELECT tokens FROM scores WHERE day=? AND account=?', day, account);
      if (score?.tokens === null) return 'removed';
      if (requestedDay !== day || !validInstallation(installationId) || !validTokens(tokens, maxTokens) || reusedRequest(account, day, requestId) ||
        (stats !== undefined && (!validSubmissionStats(stats) || get('SELECT 1 FROM submission_stats WHERE account=? AND request_id=?', account, requestId)))) {
        return invalidUpload(account, day, input, now);
      }
      if (installationId === undefined && get('SELECT 1 FROM installation_scores WHERE day=? AND account=? LIMIT 1', day, account)) {
        return recordAttempt(account, day, input, 'upgrade_required', now);
      }
      if (nextUpload(account, now) !== null) return recordAttempt(account, day, input, 'too_soon', now);
      const otherTokens = installationId === undefined ? 0 : get(`
        SELECT COALESCE(SUM(tokens), 0) AS tokens FROM installation_scores WHERE day=? AND account=? AND installation_id<>?
      `, day, account, installationId).tokens;
      const total = otherTokens + tokens;
      if (!Number.isSafeInteger(total)) return invalidUpload(account, day, input, now);
      // Legacy totals have no installation breakdown. The first identified upload replaces that day's legacy total.
      run(`INSERT INTO scores(day, account, tokens, submitted_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(day, account) DO UPDATE SET tokens=excluded.tokens`, day, account, total, now);
      if (installationId !== undefined) saveInstallationScore(day, account, installationId, tokens);
      run(`INSERT INTO score_updates VALUES (?, ?, ?)
        ON CONFLICT(day, account) DO UPDATE SET updated_at=excluded.updated_at`, day, account, now);
      if (stats !== undefined) run('INSERT INTO submission_stats VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        account, requestId, day, now, stats.deltaTokens, stats.avgTps, stats.topModel, stats.topCli);
      changed = true;
      sources.changeLegacy(account);
      return recordAttempt(account, day, input, 'accepted', now);
    });
    if (changed) {
      rankingRevision++;
      if (qualifyingSpeed(stats)) speedRevision++;
    }
    return outcome;
  }

  function initializeHistory(account, input, now, maxTokens) {
    if (sources.active(account)) return 'upgrade_required';
    const { day: requestedDay, installationId, scores, requestId } = input;
    const day = leaderboardDay(now);
    let inserted = 0;
    const outcome = transaction(() => {
      if (historyInitialized(account)) return 'initialized';
      const blocked = uploadGate(account, day, input, now);
      if (blocked) return blocked;
      const allowed = new Set(Array.from({ length: MAX_WINDOW_DAYS }, (_, index) => leaderboardDay(now - index * DAY)));
      if (requestedDay !== day || !validInstallation(installationId) || reusedRequest(account, day, requestId) || !Array.isArray(scores) || scores.length === 0 ||
          scores.length > MAX_WINDOW_DAYS || !scores.every(row => allowed.delete(row?.day) && validTokens(row.tokens, maxTokens))) {
        return invalidUpload(account, day, input, now);
      }
      if (nextUpload(account, now) !== null) return recordAttempt(account, day, input, 'too_soon', now);
      for (const row of scores) {
        const added = run('INSERT INTO scores(day, account, tokens, submitted_at) VALUES (?, ?, ?, ?) ON CONFLICT(day, account) DO NOTHING',
          row.day, account, row.tokens, now).changes;
        if (added && installationId !== undefined) saveInstallationScore(row.day, account, installationId, row.tokens);
        inserted += added;
      }
      run('INSERT INTO score_initializations VALUES (?, ?)', account, inserted ? now : null);
      if (inserted) sources.changeLegacy(account);
      return recordAttempt(account, day, input, 'accepted', now);
    });
    if (inserted) rankingRevision++;
    return outcome;
  }

  function banAccount(account, reason) {
    const changed = run('UPDATE accounts SET banned=1 WHERE id=? AND banned=0', account);
    if (!changed.changes) return false;
    speedRevision++;
    hourly.revision();
    invalidateResults();
    run(`INSERT INTO ban_reasons(account, reason) VALUES (?, ?)
      ON CONFLICT(account) DO UPDATE SET reason=excluded.reason`, account, reason);
    return true;
  }

  function setBan(actor, account, banned, now, reason = '') {
    if (banned && (account === administrator() || !reason.trim() || reason.length > 200)) return false;
    return transaction(() => {
      const changed = banned ? banAccount(account, reason.trim()) :
        run('UPDATE accounts SET banned=0 WHERE id=? AND banned=1', account).changes > 0;
      if (!changed) return false;
      if (!banned) {
        speedRevision++;
        hourly.revision();
        invalidateResults();
        run('DELETE FROM upload_attempt_clock WHERE account=?', account);
        run('DELETE FROM installation_upload_clock WHERE account=?', account);
      }
      audit(actor, banned ? 'ban' : 'unban', banned ? account + ' · ' + reason.trim() : String(account), now);
      return true;
    });
  }

  function removeScores(actor, { day, account }, now) {
    const first = leaderboardDay(now - (MAX_WINDOW_DAYS - 1) * DAY);
    const filter = (day ? ' AND day=?' : '') + (account ? ' AND account=?' : '');
    const params = [...(day ? [day] : []), ...(account ? [account] : [])];
    transaction(() => {
      hourly.remove({ day, account });
      leaderboardData.remove({ day, account });
      run('DELETE FROM submission_stats WHERE 1=1' + filter, ...params);
      run('DELETE FROM installation_scores WHERE 1=1' + filter, ...params);
      run('UPDATE scores SET tokens=NULL WHERE day>=?' + filter, first, ...params);
      run('DELETE FROM scores WHERE day<?' + filter, first, ...params);
      invalidateResults();
      audit(actor, account ? 'delete' : 'clear', [day || 'all', account].filter(Boolean).join('/'), now);
    });
    rankingRevision++;
    speedRevision++;
  }

  function adminView(day, search, currentDay = day) {
    return {
      scores: all(`
        SELECT scores.account, username, scores.tokens, scores.uploaded_at AS submittedAt
        FROM leaderboard_daily_scores scores JOIN accounts ON accounts.id=scores.account
        WHERE scores.day=? AND scores.tokens IS NOT NULL AND instr(lower(username), lower(?))>0
        ORDER BY scores.tokens DESC, scores.submitted_at, scores.account LIMIT 500
      `, day, search),
      accounts: all(`
        SELECT accounts.id, accounts.username, accounts.banned, ban_reasons.reason,
          locks.day AS lockedDay, lock_reasons.reason AS lockReason
        FROM accounts LEFT JOIN ban_reasons ON ban_reasons.account=accounts.id
        LEFT JOIN locks ON locks.account=accounts.id AND locks.day=?
        LEFT JOIN lock_reasons ON lock_reasons.account=locks.account AND lock_reasons.day=locks.day
        WHERE accounts.id>0 AND instr(lower(accounts.username), lower(?))>0
        ORDER BY accounts.banned DESC, (locks.day IS NOT NULL) DESC, accounts.username LIMIT 500
      `, currentDay, search),
      audit: all(`
        SELECT action, target, at, username FROM audit JOIN accounts ON accounts.id=audit.account
        ORDER BY audit.id DESC LIMIT 25
      `)
    };
  }

  function prune(now) {
    const day = leaderboardDay(now);
    const first = leaderboardDay(now - (MAX_WINDOW_DAYS - 1) * DAY);
    transaction(() => {
      run('DELETE FROM sessions WHERE expires<=?', now);
      sources.prune(now);
      run('DELETE FROM attempts WHERE day<?', day);
      run('DELETE FROM locks WHERE day<?', day);
      run('DELETE FROM installation_scores WHERE day<?', first);
      run('DELETE FROM installation_upload_clock WHERE attempted_at<=?', now - RAPID_UPLOAD_INTERVAL);
      run('DELETE FROM scores WHERE day<? AND tokens IS NULL', first);
      run(`DELETE FROM score_updates WHERE updated_at<=? AND NOT EXISTS (
        SELECT 1 FROM scores WHERE scores.day=score_updates.day AND scores.account=score_updates.account
      )`, now - UPLOAD_INTERVAL);
    });
  }

  function applyUpload({ kind, sessionDigest, input, receivedAt }, maxTokens) {
    const account = session(sessionDigest, 'plugin', receivedAt);
    if (!account) return { code: 'login_required' };
    if (account.banned) return { code: 'banned', username: account.username };
    if (kind === 'sources') {
      if (sources.hourlyActive(account.id)) return { code: 'upgrade_required', username: account.username };
      const { changed, ...result } = sources.upload(account.id, input, receivedAt, maxTokens, account.username);
      if (changed) {
        rankingRevision++;
        const { stats, statsId } = input;
        if (validInstallationId(statsId) && validSubmissionStats(stats)) {
          const inserted = run('INSERT OR IGNORE INTO submission_stats VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            account.id, statsId, leaderboardDay(receivedAt), receivedAt, stats.deltaTokens, stats.avgTps, stats.topModel, stats.topCli);
          if (inserted.changes && qualifyingSpeed(stats)) speedRevision++;
        }
      }
      return { ...result, username: account.username, ...status(account.id, receivedAt) };
    }
    if (sources.active(account.id)) return { code: 'upgrade_required', username: account.username };
    if (kind === 'rolling' || kind === 'hourly') {
      if (kind === 'hourly') hourly.settle(receivedAt);
      const last = kind === 'rolling'
        ? get('SELECT version FROM rolling_uploads WHERE account=? AND installation_id=?', account.id, input.installationId ?? null)
        : get('SELECT version FROM hourly_uploads WHERE account=? AND installation_id=?', account.id, input.installationId ?? null);
      const result = hourly.submit(account.id, input, receivedAt, maxTokens, kind === 'rolling');
      if (result.code === 'accepted' && result.version !== last?.version) sources.changeLegacy(account.id);
      return result;
    }
    const code = kind === 'history' ? initializeHistory(account.id, input, receivedAt, maxTokens) :
      submit(account.id, input, receivedAt, maxTokens);
    return { code, username: account.username, ...(code === 'banned' ? {} : status(account.id, receivedAt)) };
  }

  function uploadBatch(entries, maxTokens) {
    if (!entries.length) return [];
    return transaction(() => {
      const hourlyEntries = [];
      const results = entries.map((entry, index) => {
        if (entry.kind !== 'hourly-source') return applyUpload(entry, maxTokens);
        const { sessionDigest, input, receivedAt } = entry;
        const account = session(sessionDigest, 'plugin', receivedAt);
        if (!account) return { code: 'login_required' };
        if (account.banned) return { code: 'banned', username: account.username };
        if (typeof input.username !== 'string' || input.username.toLowerCase() !== account.username.toLowerCase()) {
          return { code: 'username_changed', username: account.username };
        }
        if (get('SELECT 1 FROM locks WHERE day=? AND account=?', leaderboardDay(receivedAt), account.id)) return { code: 'locked' };
        if (!validHourlySource(input, receivedAt, maxTokens)) {
          const day = leaderboardDay(receivedAt);
          const identity = { requestId: 'hours:' + input.requestId, fingerprint: input.fingerprint, installationId: input.reporterId };
          return { code: uploadGate(account.id, day, identity, receivedAt) ?? invalidUpload(account.id, day, identity, receivedAt) };
        }
        hourlyEntries.push({ ...entry, account: account.id, username: account.username, index });
      });
      const modes = new Map();
      const uploads = hourlyEntries.filter(({ account, receivedAt, index }) => {
        if (!modes.has(account)) {
          const ready = sources.hourlyActive(account) || sources.canStartHourly(account, receivedAt);
          if (ready && !sources.hourlyActive(account)) {
            leaderboardData.importAccount(account, receivedAt);
            sources.activateHourly(account);
          }
          modes.set(account, ready);
        }
        if (modes.get(account)) return true;
        results[index] = { code: 'migration_required' };
        return false;
      });
      if (!uploads.length) return results;
      const saved = leaderboardData.writeBatch(uploads, ({ account, receivedAt, input }) => {
        const day = leaderboardDay(receivedAt);
        const { reporterId } = input;
        removeOldWaiters.run(account, receivedAt - 30_000);
        const waiting = firstWaiter.get(account);
        const next = nextUpload(account, receivedAt) ??
          (waiting && waiting.reporter !== reporterId ? receivedAt + 1000 : null);
        if (next) {
          addWaiter.run(account, reporterId, receivedAt, receivedAt);
          return { code: 'too_soon', nextUploadAt: next };
        }
        clearWaiter.run(account, reporterId);
        const blocked = uploadGate(account, day, { ...input, installationId: input.reporterId }, receivedAt);
        return blocked ? { code: blocked } : null;
      });
      const changed = new Map();
      for (const [index, result] of saved.entries()) {
        if (result.changed) {
          const { account, receivedAt } = uploads[index];
          changed.set(account, Math.max(changed.get(account) ?? 0, receivedAt));
        }
      }
      for (const [account, at] of changed) run(`INSERT INTO source_write_clock VALUES (?, ?)
        ON CONFLICT(account) DO UPDATE SET at=MAX(source_write_clock.at, excluded.at)`, account, at);
      if (changed.size) { rankingRevision++; speedRevision++; }
      for (const [index, { changed: _changed, ...result }] of saved.entries()) {
        const upload = uploads[index];
        results[upload.index] = { ...status(upload.account, upload.receivedAt), ...result, username: upload.username };
      }
      return results;
    });
  }

  function readSnapshot(work) {
    // A single read transaction keeps all ranking periods on the same SQLite snapshot.
    db.exec('BEGIN');
    try {
      return work();
    } finally {
      db.exec('ROLLBACK');
    }
  }

  return {
    upsertAccount, bindAdministrator, administrator, session, status, ranking, submit, historyInitialized, initializeHistory,
    setBan, removeScores, adminView, prune, uploadBatch, readSnapshot, leaderboardData, readAdminRevision, publishedSpeeds,
    canUseHourlySources: (account, now) => sources.canStartHourly(account, now),
    publishHourlyResult(cutoff, generatedAt, payload, revision) {
      return transaction(() => {
        if (readAdminRevision() !== revision) return false;
        leaderboardData.persistResult(cutoff, generatedAt, payload);
        leaderboardData.prune(cutoff);
        hourly.prune(cutoff);
        return true;
      });
    },
    invalidateUploadCaches() { rankingRevision++; speedRevision++; },
    rankingRevision: () => rankingRevision, speedRanking, speedRevision: () => speedRevision, hourly, recentRows, latestUploads,
    pruneRecent: now => {
      run('DELETE FROM submission_stats WHERE submitted_at<=?', now - SPEED_WINDOW_MS);
      run(`DELETE FROM submission_stats WHERE submitted_at<=? AND (delta_tokens<=${SPEED_MIN_DELTA} OR COALESCE(avg_tps, 0)<=0)`,
        now - RECENT_STATS_MS);
    },
    addSession: (digest, account, kind, expires) => run('INSERT INTO sessions VALUES (?, ?, ?, ?)', digest, account, kind, expires),
    removeSession: digest => run('DELETE FROM sessions WHERE digest=?', digest),
    close: () => db.close()
  };
}

export function writeUploadRequests(store, requests, maxTokens) {
  const responses = store.uploadBatch(requests.flat(), maxTokens);
  let offset = 0;
  return requests.map(entries => {
    const result = responses.slice(offset, offset + entries.length);
    offset += entries.length;
    return result;
  });
}

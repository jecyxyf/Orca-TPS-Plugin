import { DatabaseSync } from 'node:sqlite';
import { leaderboardDay, leaderboardDayStart, MAX_WINDOW_DAYS } from '../src/usage-summary.mjs';
import { validInstallationId } from '../src/leaderboard-installation.mjs';

const TEN_MINUTES = 10 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const UPLOAD_INTERVAL = 10_000;
const RAPID_UPLOAD_INTERVAL = 5000;
const RAPID_UPLOAD_REASON = '连续 4 次上传间隔不足 5 秒';
const DAILY_LOCK_REASON = '10 分钟内提交错误累计 5 次';

export function openLeaderboardStore(filename) {
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=3000;
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY, username TEXT NOT NULL, banned INTEGER NOT NULL DEFAULT 0
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
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  const get = (sql, ...values) => db.prepare(sql).get(...values);
  const all = (sql, ...values) => db.prepare(sql).all(...values);
  const run = (sql, ...values) => db.prepare(sql).run(...values);
  const administrator = () => get('SELECT account FROM administrator WHERE slot=1')?.account;
  const audit = (actor, action, target, now) =>
    run('INSERT INTO audit(account, action, target, at) VALUES (?, ?, ?, ?)', actor, action, target, now);
  const periodRanks = db.prepare(`
    WITH totals AS (
      SELECT scores.account, SUM(scores.tokens) AS tokens,
        MAX(COALESCE(score_updates.updated_at, scores.submitted_at)) AS submittedAt
      FROM scores LEFT JOIN score_updates USING (day, account)
      WHERE scores.day BETWEEN ? AND ? AND scores.tokens IS NOT NULL
      GROUP BY scores.account
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
    run('INSERT INTO accounts(id, username) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET username=excluded.username', id, login);
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
    return get(`
      SELECT scores.tokens, scores.submitted_at, COALESCE(score_updates.updated_at, scores.submitted_at) AS uploaded_at
      FROM scores LEFT JOIN score_updates USING (day, account)
      WHERE scores.day=? AND scores.account=?
    `, day, account);
  }

  function nextUpload(account, now) {
    const updated = get('SELECT updated_at FROM score_updates WHERE account=? ORDER BY updated_at DESC LIMIT 1', account);
    const legacy = get('SELECT MAX(submitted_at) AS at FROM scores WHERE day IN (?, ?) AND account=?',
      leaderboardDay(now), leaderboardDay(now - UPLOAD_INTERVAL), account);
    const initialization = get('SELECT uploaded_at FROM score_initializations WHERE account=?', account);
    const next = Math.max(updated?.updated_at ?? -Infinity, legacy?.at ?? -Infinity,
      initialization?.uploaded_at ?? -Infinity) + UPLOAD_INTERVAL;
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

  function ranking(account, now, days = 1) {
    const day = leaderboardDay(now);
    const score = account === null ? null : readScore(account, day);
    const state = account === null ? { day } : status(account, now, score);
    if (days > 1) {
      const startDay = leaderboardDay(now - (days - 1) * DAY);
      // Sort the exact SQLite totals before converting to numbers for MB display.
      const rows = periodRanks.all(startDay, day, account).map(row => ({
        username: row.username, tokens: Number(row.tokens), submittedAt: Number(row.submittedAt),
        rank: Number(row.rank), mine: Number(row.account) === account
      }));
      return { ...state, days, startDay, rank: rows.find(row => row.mine)?.rank ?? null, rows: rows.slice(0, 100) };
    }
    const rows = all(`
      SELECT accounts.username, scores.account, scores.tokens,
        COALESCE(score_updates.updated_at, scores.submitted_at) AS submittedAt
      FROM scores JOIN accounts ON accounts.id=scores.account
      LEFT JOIN score_updates USING (day, account)
      WHERE scores.day=? AND scores.tokens IS NOT NULL
      ORDER BY scores.tokens DESC, scores.submitted_at, scores.account LIMIT 100
    `, state.day).map(({ account: id, ...row }, index) => ({ ...row, rank: index + 1, mine: id === account }));
    const rank = score?.tokens == null ? null : 1 + get(`
      SELECT COUNT(*) AS count FROM scores WHERE day=? AND (
        tokens>? OR (tokens=? AND (submitted_at<? OR (submitted_at=? AND account<?)))
      )
    `, day, score.tokens, score.tokens, score.submitted_at, score.submitted_at, account).count;
    return { ...state, rank, rows };
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

  function submit(account, input, now, maxTokens) {
    const { day: requestedDay, installationId, tokens, requestId } = input;
    const day = leaderboardDay(now);
    return transaction(() => {
      const blocked = uploadGate(account, day, input, now);
      if (blocked) return blocked;
      const score = get('SELECT tokens FROM scores WHERE day=? AND account=?', day, account);
      if (score?.tokens === null) return 'removed';
      if (requestedDay !== day || !validInstallation(installationId) || !validTokens(tokens, maxTokens) || reusedRequest(account, day, requestId)) {
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
      return recordAttempt(account, day, input, 'accepted', now);
    });
  }

  function initializeHistory(account, input, now, maxTokens) {
    const { day: requestedDay, installationId, scores, requestId } = input;
    const day = leaderboardDay(now);
    return transaction(() => {
      if (historyInitialized(account)) return 'initialized';
      const blocked = uploadGate(account, day, input, now);
      if (blocked) return blocked;
      const allowed = new Set(Array.from({ length: MAX_WINDOW_DAYS }, (_, index) => leaderboardDay(now - index * DAY)));
      if (requestedDay !== day || !validInstallation(installationId) || reusedRequest(account, day, requestId) || !Array.isArray(scores) || scores.length === 0 ||
          scores.length > MAX_WINDOW_DAYS || !scores.every(row => allowed.delete(row?.day) && validTokens(row.tokens, maxTokens))) {
        return invalidUpload(account, day, input, now);
      }
      if (nextUpload(account, now) !== null) return recordAttempt(account, day, input, 'too_soon', now);
      let inserted = 0;
      for (const row of scores) {
        const added = run('INSERT INTO scores(day, account, tokens, submitted_at) VALUES (?, ?, ?, ?) ON CONFLICT(day, account) DO NOTHING',
          row.day, account, row.tokens, now).changes;
        if (added && installationId !== undefined) saveInstallationScore(row.day, account, installationId, row.tokens);
        inserted += added;
      }
      run('INSERT INTO score_initializations VALUES (?, ?)', account, inserted ? now : null);
      return recordAttempt(account, day, input, 'accepted', now);
    });
  }

  function banAccount(account, reason) {
    const changed = run('UPDATE accounts SET banned=1 WHERE id=? AND banned=0', account);
    if (!changed.changes) return false;
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
      run('DELETE FROM installation_scores WHERE 1=1' + filter, ...params);
      run('UPDATE scores SET tokens=NULL WHERE day>=?' + filter, first, ...params);
      run('DELETE FROM scores WHERE day<?' + filter, first, ...params);
      audit(actor, account ? 'delete' : 'clear', [day || 'all', account].filter(Boolean).join('/'), now);
    });
  }

  function adminView(day, search, currentDay = day) {
    return {
      scores: all(`
        SELECT scores.account, username, scores.tokens, COALESCE(score_updates.updated_at, scores.submitted_at) AS submittedAt
        FROM scores JOIN accounts ON accounts.id=scores.account LEFT JOIN score_updates USING (day, account)
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

  return {
    upsertAccount, bindAdministrator, administrator, session, status, ranking, submit, historyInitialized, initializeHistory,
    setBan, removeScores, adminView, prune,
    addSession: (digest, account, kind, expires) => run('INSERT INTO sessions VALUES (?, ?, ?, ?)', digest, account, kind, expires),
    removeSession: digest => run('DELETE FROM sessions WHERE digest=?', digest),
    close: () => db.close()
  };
}

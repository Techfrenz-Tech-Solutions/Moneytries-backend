// controllers/loginAnalyticsController.js
//
// Backend for the two new Admin Dashboard analytics features:
//
//   1. Today's Active Users — unique users who opened/logged into the app
//      today (server time). Newly registered users who log in today AND
//      existing users who log in today both count, once each.
//   2. User Login Attempts — every login/open event (success or failed),
//      with a detailed, searchable/filterable/paginated admin page.
//
// Data source: a brand-new `login_attempts` table, populated server-side
// at the real authentication chokepoints in authController.js (register,
// login, 2FA verify — both success AND failure branches). This is
// intentionally a SEPARATE table from `login_history` (securityController.js):
//   • login_history is capped at the last 50 rows per user (purged on every
//     insert) and only records client-reported successes — it powers the
//     user-facing "Login Activity" screen and the Users page "Last Login"
//     column, and is left completely untouched by this feature.
//   • login_attempts here keeps full, unpurged history (needed for accurate
//     admin analytics/search over time), also records FAILED attempts, and
//     captures the client's IP address — something only the server can ever
//     know reliably (the app itself cannot report its own public IP).
//
// NOTE: no FOREIGN KEY constraint on user_id — mirrors the documented
// convention in notificationController.js (a hard FK has repeatedly made
// `CREATE TABLE IF NOT EXISTS` silently fail on some installs, e.g. a
// users.id type/engine mismatch, which then breaks every query against the
// new table). user_id is still indexed for fast lookups.

const db = require('../config/db');
const { ok, fail } = require('../utils/response');

// ── One-time migration (idempotent, safe to call from every request) ───────
let _migrated = false;
let _migrationPromise = null;

async function ensureLoginAnalyticsSchema() {
  if (_migrated) return;
  if (_migrationPromise) return _migrationPromise;
  _migrationPromise = _runMigration();
  try {
    await _migrationPromise;
  } finally {
    _migrationPromise = null;
  }
}

async function _runMigration() {
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS login_attempts (
        id             INT UNSIGNED    NOT NULL AUTO_INCREMENT,
        user_id        INT UNSIGNED    NULL DEFAULT NULL,
        user_name      VARCHAR(150)    NULL DEFAULT NULL,
        identifier     VARCHAR(191)    NOT NULL,
        device_name    VARCHAR(191)    NOT NULL DEFAULT 'Unknown Device',
        platform       VARCHAR(20)     NOT NULL DEFAULT 'unknown',
        ip_address     VARCHAR(45)     NULL DEFAULT NULL,
        status         ENUM('success','failed') NOT NULL DEFAULT 'success',
        failure_reason VARCHAR(191)    NULL DEFAULT NULL,
        event_type     ENUM('login','register') NOT NULL DEFAULT 'login',
        created_at     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

        PRIMARY KEY (id),
        KEY idx_la_user       (user_id),
        KEY idx_la_created    (created_at),
        KEY idx_la_status     (status),
        KEY idx_la_identifier (identifier)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    _migrated = true;
  } catch (err) {
    console.error('[login-analytics] migration error:', err.message);
  }
}

// Run once on module load (non-blocking) — mirrors adminUsersController's pattern.
ensureLoginAnalyticsSchema();

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Real client IP, honoring the single reverse-proxy hop server.js already
 * trusts (`app.set('trust proxy', 1)`). Falls back through X-Forwarded-For
 * in case req.ip isn't populated for some edge/runtime. */
function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.ip || req.connection?.remoteAddress || null;
}

const ALLOWED_PLATFORMS = ['android', 'ios', 'web', 'other'];

function normalizePlatform(raw, req) {
  const v = (raw || '').toString().trim().toLowerCase();
  if (ALLOWED_PLATFORMS.includes(v)) return v;

  // Fall back to a best-effort guess from the User-Agent header when the
  // client didn't explicitly send one (e.g. an older app build).
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  if (ua.includes('android')) return 'android';
  if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ios')) return 'ios';
  if (ua.includes('mozilla') || ua.includes('chrome') || ua.includes('safari')) return 'web';
  return 'unknown';
}

function normalizeDeviceName(raw) {
  const v = (raw || '').toString().trim();
  return v ? v.slice(0, 191) : 'Unknown Device';
}

/**
 * Records one login/open event. Fire-and-forget by design — analytics must
 * never affect the outcome of the actual auth request, so this catches its
 * own errors internally (same pattern as notificationController's
 * `pushForNotification`). Call it without awaiting or .catch()-ing.
 *
 * @param {import('express').Request} req
 * @param {{
 *   userId?: number|null, userName?: string|null, identifier: string,
 *   status: 'success'|'failed', failureReason?: string|null,
 *   eventType?: 'login'|'register'
 * }} data
 */
function recordLoginAttempt(req, data) {
  const {
    userId = null,
    userName = null,
    identifier,
    status,
    failureReason = null,
    eventType = 'login',
  } = data || {};

  ensureLoginAnalyticsSchema()
    .then(() => {
      const deviceName = normalizeDeviceName(req.body && req.body.device_name);
      const platform = normalizePlatform(req.body && req.body.platform, req);
      const ipAddress = getClientIp(req);

      return db.execute(
        `INSERT INTO login_attempts
           (user_id, user_name, identifier, device_name, platform, ip_address, status, failure_reason, event_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          userId,
          userName || null,
          (identifier || '').toString().slice(0, 191),
          deviceName,
          platform,
          ipAddress,
          status === 'failed' ? 'failed' : 'success',
          failureReason ? String(failureReason).slice(0, 191) : null,
          eventType === 'register' ? 'register' : 'login',
        ]
      );
    })
    .catch(e => console.error('[login-analytics] record error:', e.message));
}

function fullName(first, last) {
  return `${first || ''} ${last || ''}`.trim();
}

// ── GET /api/admin/login-attempts/stats   [Admin only] ─────────────────────
// Powers both the Dashboard KPI cards and the Login Attempts page's own
// header cards. All figures are scoped to "today" by server time (CURDATE()
// in MySQL evaluates against the session timezone, which config/db.js pins
// to UTC on every pooled connection) — so the numbers roll over to zero
// automatically at midnight server time with no cron job required.
async function getLoginAttemptsStats(_req, res) {
  await ensureLoginAnalyticsSchema();

  try {
    const [[activeRow]] = await db.query(
      `SELECT COUNT(DISTINCT user_id) AS v FROM login_attempts
        WHERE status = 'success' AND user_id IS NOT NULL AND DATE(created_at) = CURDATE()`
    );
    const [[totalRow]] = await db.query(
      `SELECT COUNT(*) AS v FROM login_attempts WHERE DATE(created_at) = CURDATE()`
    );
    const [[successRow]] = await db.query(
      `SELECT COUNT(*) AS v FROM login_attempts WHERE status = 'success' AND DATE(created_at) = CURDATE()`
    );
    const [[failedRow]] = await db.query(
      `SELECT COUNT(*) AS v FROM login_attempts WHERE status = 'failed' AND DATE(created_at) = CURDATE()`
    );

    return ok(res, 'Login analytics stats fetched', {
      today_active_users: Number(activeRow?.v) || 0,
      today_login_attempts: Number(totalRow?.v) || 0,
      today_successful_attempts: Number(successRow?.v) || 0,
      today_failed_attempts: Number(failedRow?.v) || 0,
    });
  } catch (err) {
    console.error('[login-analytics:stats]', err);
    return fail(res, 'Could not fetch login analytics stats', 500);
  }
}

// ── GET /api/admin/login-attempts   [Admin only] ────────────────────────────
// Query: ?page=1&limit=20&search=&status=&date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
async function listLoginAttempts(req, res) {
  await ensureLoginAnalyticsSchema();

  const pageNum  = Math.max(1, parseInt(req.query.page  || '1',  10));
  const limitNum = Math.max(1, Math.min(100, parseInt(req.query.limit || '20', 10)));
  const offset   = (pageNum - 1) * limitNum;

  const search   = (req.query.search || '').trim();
  const status   = ['success', 'failed'].includes(req.query.status) ? req.query.status : '';
  const dateFrom = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date_from || '') ? req.query.date_from : '';
  const dateTo   = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date_to   || '') ? req.query.date_to   : '';

  const where = [];
  const params = [];

  if (status) {
    where.push('la.status = ?');
    params.push(status);
  }
  if (dateFrom) {
    where.push('DATE(la.created_at) >= ?');
    params.push(dateFrom);
  }
  if (dateTo) {
    where.push('DATE(la.created_at) <= ?');
    params.push(dateTo);
  }
  if (search) {
    where.push(`(
      la.user_name LIKE ? OR la.identifier LIKE ? OR la.ip_address LIKE ? OR
      u.first_name LIKE ? OR u.last_name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?
    )`);
    const like = `%${search}%`;
    params.push(like, like, like, like, like, like, like);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // LEFT JOIN so failed attempts against an unknown identifier (no user_id)
  // still show up — the identifier typed at login time is preserved on the
  // login_attempts row itself.
  const fromSql = `
    FROM login_attempts la
    LEFT JOIN users u ON u.id = la.user_id
    ${whereSql}
  `;

  try {
    // Sanitized integers inlined directly (not bound params) — mirrors the
    // established workaround elsewhere in this codebase for the mysql2
    // "LIMIT ? / OFFSET ?" prepared-statement bug.
    const limitOffsetSql = `LIMIT ${limitNum} OFFSET ${offset}`;

    const [rows] = await db.query(
      `SELECT
         la.id, la.user_id, la.user_name, la.identifier, la.device_name,
         la.platform, la.ip_address, la.status, la.failure_reason,
         la.event_type, la.created_at,
         u.first_name, u.last_name, u.email, u.phone
       ${fromSql}
       ORDER BY la.id DESC
       ${limitOffsetSql}`,
      params
    );

    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total ${fromSql}`,
      params
    );

    const attempts = rows.map((r) => ({
      id: r.id,
      user_id: r.user_id,
      user_name: fullName(r.first_name, r.last_name) || r.user_name || 'Unknown User',
      email_or_mobile: r.email || r.phone || r.identifier,
      device_name: r.device_name,
      platform: r.platform,
      ip_address: r.ip_address || '—',
      status: r.status,
      failure_reason: r.failure_reason,
      event_type: r.event_type,
      created_at: r.created_at,
    }));

    return ok(res, 'Login attempts fetched', {
      attempts,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.max(1, Math.ceil(total / limitNum)),
      },
    });
  } catch (err) {
    console.error('[login-analytics:list]', err);
    return fail(res, 'Could not fetch login attempts', 500);
  }
}

module.exports = {
  ensureLoginAnalyticsSchema,
  recordLoginAttempt,
  getLoginAttemptsStats,
  listLoginAttempts,
};
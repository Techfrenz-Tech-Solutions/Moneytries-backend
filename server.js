// server.js
require('dotenv').config();

const path       = require('path');
const express    = require('express');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');

const authRoutes       = require('./routes/auth');
const kycRoutes        = require('./routes/kyc');
const depositRoutes    = require('./routes/deposit');
const withdrawalRoutes = require('./routes/withdrawal');
const planRoutes       = require('./routes/plan');
const historyRoutes    = require('./routes/history');
const supportRoutes    = require('./routes/support');
const notificationRoutes = require('./routes/notification');
const profileRoutes      = require('./routes/profile');
const referralRoutes     = require('./routes/referral');
const securityRoutes     = require('./routes/security');
const usersRoutes        = require('./routes/users');
const adminUsersRoutes   = require('./routes/adminUsers');
const adminLoginAttemptsRoutes = require('./routes/adminLoginAttempts');
const dashboardRoutes    = require('./routes/dashboard');
const adminSettingsRoutes = require('./routes/adminSettings');
const pushRoutes          = require('./routes/push');
const { getMessaging }    = require('./config/firebase');
const { runDailyRoi, ensureSchema: ensurePlanSchema } = require('./controllers/planController');
const { ensureMemberIdSchema } = require('./utils/memberId');
const db = require('./config/db');

const app  = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Railway (and most PaaS hosts) put the app behind a reverse proxy, which
// sets X-Forwarded-For. Express needs to be told to trust exactly one hop
// so express-rate-limit can read the real client IP instead of throwing
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR and mis-attributing all traffic.
app.set('trust proxy', 1);

// ── Global middleware ─────────────────────────────────────────────────────────

const allowedOrigins = (process.env.CORS_ORIGINS || '*')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin: allowedOrigins.includes('*') ? '*' : allowedOrigins,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false }));

// ── Static file serving ───────────────────────────────────────────────────────
// Mounted BEFORE the rate limiter so loading the admin console's HTML/JS/CSS
// (and user-uploaded proof images) never eats into the API's request budget.
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/admin',   express.static(path.join(__dirname, 'admin')));

// API rate limit — 300 req / 15 min per IP, scoped to /api only.
//
// ROOT CAUSE (fixed): this used to be `app.use(rateLimit(...))` — applied
// globally, BEFORE the static routes above, with no custom `message`. Two
// problems that caused:
//   1. Every static asset request (admin console JS/CSS, uploaded images)
//      counted against the same 100/15min budget as real API calls, so the
//      Admin Panel — which fires ~5 requests per page just for KPI stats —
//      could exhaust the limit from normal use alone.
//   2. When the limit *was* hit, express-rate-limit's default `message` is
//      the plain string "Too many requests, please try again later." — not
//      JSON. The frontend's `apiFetchJson()` always calls `res.json()`, so
//      instead of showing a rate-limit message it crashed with
//      `Unexpected token 'T', "Too many r"... is not valid JSON`.
// Fixed by scoping this to /api (static assets no longer count), raising
// the ceiling to fit the admin panel's request pattern, and returning the
// same { success, message } JSON envelope used everywhere else in the API.
app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      300,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { success: false, message: 'Too many requests. Please try again in a few minutes.' },
}));

// ── Routes ────────────────────────────────────────────────────────────────────

app.use('/api/auth',       authRoutes);
app.use('/api/kyc',        kycRoutes);
app.use('/api/deposit',    depositRoutes);
app.use('/api/withdrawal', withdrawalRoutes);
app.use('/api/plans',      planRoutes);
app.use('/api/history',    historyRoutes);
app.use('/api/support',        supportRoutes);
app.use('/api/notifications',  notificationRoutes);
app.use('/api/profile',        profileRoutes);
app.use('/api/referral',       referralRoutes);
app.use('/api/security',       securityRoutes);
app.use('/api/users',          usersRoutes);
app.use('/api/admin/users',    adminUsersRoutes);
app.use('/api/admin/login-attempts', adminLoginAttemptsRoutes);
app.use('/api/admin/settings', adminSettingsRoutes);
app.use('/api/dashboard',      dashboardRoutes);

// ROOT CAUSE (fixed): routes/push.js was written and imported above
// (`pushRoutes`, line 25) as part of the Firebase notification feature,
// but was never actually mounted onto the Express app. Every single call
// the Flutter app makes to POST /api/push/register-token or
// /api/push/unregister-token was therefore hitting the 404 catch-all
// below instead of controllers/pushController.js — so no FCM token ever
// reached the `device_tokens` table, and utils/pushService.js's
// sendPushToUser() always found zero tokens for every user and silently
// no-op'd. This is why notifications stopped working end-to-end (no push
// ever left the server) while everything else — permissions, channel,
// icon, in-app notification list — was already correctly implemented on
// both the app and server. This one line is the fix.
app.use('/api/push',           pushRoutes);

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// API discovery/health endpoint. In production Nginx exposes this as
// https://moneytries.com/v1/api, so opening the configured API prefix gives a
// useful response instead of being mistaken for a missing deployment route.
app.get('/api', (_req, res) => res.json({
  success: true,
  service: 'MoneyTries API',
  status: 'ok',
}));

// 404 catch-all
app.use((_req, res) => res.status(404).json({ success: false, message: 'Route not found' }));

// Global error handler
app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

// ── Daily ROI Cron ────────────────────────────────────────────────────────────
function scheduleDailyRoi() {
  runDailyRoi().catch(err => console.error('[roi-cron] startup run failed:', err.message));

  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
  setInterval(() => {
    runDailyRoi().catch(err => console.error('[roi-cron] scheduled run failed:', err.message));
  }, TWENTY_FOUR_HOURS);

  console.log('[roi-cron] Daily ROI scheduler started.');
}

// ── Start ─────────────────────────────────────────────────────────────────────
//
// ROOT CAUSE (fixed): this used to be a bare `app.listen(PORT, ...)` call
// that fired immediately on require, while config/db.js's schema.sql run,
// utils/memberId.js's `users.member_id` column migration, and
// planController.js's `roi_daily_credits` (and related) table creation all
// ran as separate, unawaited, fire-and-forget promises in parallel.
// Whichever request arrived first — a real login, a dashboard load, a
// health check — could be served before one of those migrations had
// actually finished, producing intermittent
// "Unknown column 'member_id' in 'field list'" and
// "Table 'roi_daily_credits' doesn't exist" errors that appeared to
// "randomly" happen a few minutes into a fresh deploy.
//
// Fix: explicitly await every schema-readiness step below BEFORE the HTTP
// server starts accepting any connections, so by the time app.listen()'s
// callback fires, every table/column every route depends on is guaranteed
// to already exist.
async function start() {
  await db.ready;              // MySQL connection + config/schema.sql
  await ensureMemberIdSchema(); // users.member_id column + unique index
  await ensurePlanSchema();     // investment_plans/roi_daily_credits/etc.

  const server = app.listen(PORT, HOST, () => {
    console.log(`🚀  MoneyTries API running on http://${HOST}:${PORT}`);
    // Force Firebase Admin init (and its own success/warning log line —
    // see config/firebase.js) right at boot instead of lazily on the
    // first push, so a missing/bad FIREBASE_SERVICE_ACCOUNT_* is visible
    // in the startup logs immediately rather than only surfacing later.
    const pushConfigured = !!getMessaging();
    console.log(`[push] /api/push mounted — FCM ${pushConfigured ? 'configured' : 'NOT configured'}`);
    scheduleDailyRoi();
  });

  function shutdown(signal) {
    console.log(`[shutdown] ${signal} received; draining connections`);
    server.close(() => {
      db.end().finally(() => process.exit(0));
    });
  }

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  console.error('❌  Startup failed:', err.message);
  process.exit(1);
});
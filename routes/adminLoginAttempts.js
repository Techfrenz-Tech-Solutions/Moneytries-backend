// routes/adminLoginAttempts.js
const express = require('express');

const { authenticate } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/admin');
const {
  listLoginAttempts,
  getLoginAttemptsStats,
} = require('../controllers/loginAnalyticsController');

const router = express.Router();

/**
 * GET /api/admin/login-attempts/stats   [Admin only]
 * Today's Active Users + Today's Login Attempts (+ success/failed split)
 * for the Dashboard KPI cards and this page's own header cards.
 * NOTE: registered before '/' so query semantics stay simple/explicit.
 */
router.get('/stats', authenticate, requireAdmin, getLoginAttemptsStats);

/**
 * GET /api/admin/login-attempts   [Admin only]
 * Searchable, filterable, paginated login/open-event list.
 * Query: ?page=1&limit=20&search=&status=&date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
 */
router.get('/', authenticate, requireAdmin, listLoginAttempts);

module.exports = router;
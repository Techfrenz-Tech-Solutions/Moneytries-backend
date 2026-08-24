// routes/plan.js
const express = require('express');

const { authenticate } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/admin');
const {
  getMyPlans,
  getPlanAmount,
  enrollPlan,
  withdrawRoi,
  withdrawPrincipal,
  adminListPlans,
  adminApprovePlan,
  adminRejectPlan,
  adminApproveInstalment,
  adminRejectInstalment,
  adminFixPlanDates,
} = require('../controllers/planController');

const router = express.Router();

// ── User routes ───────────────────────────────────────────────────────────────

// GET  /api/plans/my              — user's own plans + instalments
router.get('/my', authenticate, getMyPlans);

// GET  /api/plans/plan-amount     — total invested amount for profile
router.get('/plan-amount', authenticate, getPlanAmount);

// POST /api/plans/enroll          — enroll in a plan, paid from wallet balance
//
// The UPI/bank-transfer + payment-screenshot + UTR payment method has been
// permanently removed. A plan may now ONLY be started using the user's
// available wallet balance: enrollPlan() checks the balance against the
// investment amount and, if sufficient, deducts/locks it immediately in the
// same transaction that creates the plan. The plan still goes through the
// existing admin approval flow below ('under_review' → approve/reject); a
// rejection automatically refunds the locked amount back to the wallet.
router.post('/enroll', authenticate, enrollPlan);

// NOTE: Recurring monthly instalment payments have been permanently
// removed. A plan is funded by exactly one payment, submitted at
// enrollment (POST /enroll above) and reviewed once by admin — there is no
// "pay next instalment" endpoint anymore.

// POST /api/plans/:id/withdraw-roi       — transfer accrued ROI to wallet
router.post('/:id/withdraw-roi', authenticate, withdrawRoi);

// POST /api/plans/:id/withdraw-principal — redeem principal after completion
router.post('/:id/withdraw-principal', authenticate, withdrawPrincipal);

// ── Admin routes ──────────────────────────────────────────────────────────────

// GET  /api/plans/admin/list              — list all plans (with optional ?status=)
router.get('/admin/list', authenticate, requireAdmin, adminListPlans);

// POST /api/plans/admin/:id/approve       — approve a plan (under_review → approved)
router.post('/admin/:id/approve', authenticate, requireAdmin, adminApprovePlan);

// POST /api/plans/admin/:id/reject        — reject a plan
router.post('/admin/:id/reject', authenticate, requireAdmin, adminRejectPlan);

// POST /api/plans/admin/instalment/:id/approve — approve a monthly instalment
router.post('/admin/instalment/:id/approve', authenticate, requireAdmin, adminApproveInstalment);

// POST /api/plans/admin/instalment/:id/reject  — reject a monthly instalment
router.post('/admin/instalment/:id/reject', authenticate, requireAdmin, adminRejectInstalment);

// POST /api/plans/admin/fix-dates         — one-time date correction utility
router.post('/admin/fix-dates', authenticate, requireAdmin, adminFixPlanDates);

module.exports = router;
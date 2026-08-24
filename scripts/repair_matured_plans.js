// scripts/repair_matured_plans.js
//
// ── ONE-TIME REPAIR SCRIPT ───────────────────────────────────────────────────
// Fixes the "3-Day Pre Plan still receiving Daily ROI after maturity" bug for
// EXISTING plans already sitting in the database.
//
// ROOT CAUSE (fixed in controllers/planController.js → accrueRoiForPlan()):
// the daily ROI accrual used to cap its day-count AT the plan's maturity_date
// (inclusive), which credited one extra day of ROI on the maturity date
// itself instead of stopping the day before. Any plan whose maturity date had
// already passed — but which for any reason (server downtime, a missed cron
// cycle, the app never being reopened) had NOT yet been walked through
// maturePlanIfDue() — would keep being picked up by the next cron run and
// keep being treated as still "earning", because its status was still
// 'approved'/'active' and plan_amount was still > 0.
//
// This script does NOT touch accrued_roi/withdrawn_roi/wallet balances
// directly. It simply re-runs the exact same (now-fixed, idempotent) accrual
// and maturity functions the live cron and getMyPlans() already use, for
// every plan that qualifies — so any plan whose maturity_date has already
// passed is:
//   1. Accrued up to its correct final day (maturity_date − 1), never the
//      maturity day itself.
//   2. Immediately matured: principal + remaining unpaid ROI credited once,
//      status flipped to 'completed', so the next cron cycle skips it
//      permanently (query filters on status IN ('approved','active')).
//
// Both accrueRoiForPlan() and maturePlanIfDue() are safe to call any number
// of times — accrued_roi only ever moves via GREATEST(), and principal /
// settled-ROI credits are guarded by UNIQUE(plan_id) + INSERT IGNORE — so
// running this script is safe even if some of these plans already matured
// correctly and need no repair at all.
//
// HOW TO USE
// ──────────
//   node scripts/repair_matured_plans.js
//
// Safe to re-run. Run once after deploying the accrueRoiForPlan() fix.
// ─────────────────────────────────────────────────────────────────────────────

const db = require('../config/db');
const { accrueRoiForPlan, maturePlanIfDue, ensureSchema } = require('../controllers/planController');

async function main() {
  await ensureSchema();

  const [plans] = await db.execute(
    `SELECT id, plan_type, user_id, status, maturity_date, plan_amount
       FROM investment_plans
      WHERE status IN ('approved', 'active')
        AND plan_amount > 0
        AND maturity_date IS NOT NULL
        AND maturity_date <= CURDATE()`
  );

  console.log(`[repair] Found ${plans.length} plan(s) past their maturity date and still open.`);

  let fixed = 0;
  for (const row of plans) {
    try {
      await accrueRoiForPlan(row.id);
      const credited = await maturePlanIfDue(row.id);
      if (credited > 0) {
        fixed++;
        console.log(`[repair] Plan #${row.id} (user ${row.user_id}, ${row.plan_type}): matured, ₹${credited.toFixed(2)} settled to wallet.`);
      } else {
        console.log(`[repair] Plan #${row.id} (user ${row.user_id}, ${row.plan_type}): already settled, no action needed.`);
      }
    } catch (err) {
      console.error(`[repair] Plan #${row.id} failed:`, err.message);
    }
  }

  console.log(`[repair] Done. ${fixed}/${plans.length} plan(s) newly matured/settled.`);
  process.exit(0);
}

main().catch(err => {
  console.error('[repair] fatal error:', err.message);
  process.exit(1);
});
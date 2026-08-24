// controllers/passwordResetController.js
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { validationResult } = require('express-validator');
const db           = require('../config/db');
const { ok, fail } = require('../utils/response');
const { generateOtp } = require('../utils/otp');
const { sendOtpEmail } = require('../services/emailService');
const { sendOtpSms } = require('../services/smsService');

const OTP_EXPIRY_MINUTES = 5;
const RESET_SESSION_EXPIRY_MINUTES = 10;
const SALT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12');

// ── One-time migration ────────────────────────────────────────────────────────
// Lazily creates the password_reset_otps table on first use, mirroring the
// pattern already used in controllers/mobileOtpController.js.
let _migrated = false;

async function ensurePasswordResetTable() {
  if (_migrated) return;
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS password_reset_otps (
        id          INT UNSIGNED    NOT NULL AUTO_INCREMENT,
        user_id     INT UNSIGNED    NOT NULL,
        identifier  VARCHAR(191)    NOT NULL,
        channel     ENUM('EMAIL','PHONE') NOT NULL,
        otp         VARCHAR(6)      NOT NULL,
        reset_token VARCHAR(64)     DEFAULT NULL,
        reset_expires_at TIMESTAMP  NULL DEFAULT NULL,
        expires_at  TIMESTAMP       NOT NULL,
        verified    TINYINT(1)      NOT NULL DEFAULT 0,
        used        TINYINT(1)      NOT NULL DEFAULT 0,
        created_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

        PRIMARY KEY (id),
        KEY idx_pro_identifier (identifier)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    const [columns] = await db.execute(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'password_reset_otps'`
    );
    const names = new Set(columns.map(({ COLUMN_NAME }) => COLUMN_NAME));
    if (!names.has('channel')) {
      await db.execute("ALTER TABLE password_reset_otps ADD COLUMN channel ENUM('EMAIL','PHONE') NULL AFTER identifier");
      await db.execute("UPDATE password_reset_otps SET channel = IF(identifier LIKE '%@%', 'EMAIL', 'PHONE') WHERE channel IS NULL");
      await db.execute("ALTER TABLE password_reset_otps MODIFY channel ENUM('EMAIL','PHONE') NOT NULL");
    }
    if (!names.has('reset_expires_at')) {
      await db.execute('ALTER TABLE password_reset_otps ADD COLUMN reset_expires_at TIMESTAMP NULL DEFAULT NULL AFTER reset_token');
    }
    _migrated = true;
  } catch (err) {
    console.error('[password-reset-migration] error:', err.message);
    throw err;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateResetToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Resolves a raw identifier string into the users-table column + normalized
 * value to query against — mirrors the identical logic used in
 * authController.login so both endpoints treat "identifier" identically.
 */
function resolveIdentifier(identifierRaw) {
  const id = (identifierRaw || '').trim();
  const isEmail  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id);
  const isMobile = /^\d{10}$/.test(id);

  if (!isEmail && !isMobile) return null;

  return {
    column: isEmail ? 'email' : 'phone',
    value:  isEmail ? id.toLowerCase() : id,
  };
}

// ── POST /api/auth/forgot-password/send-otp ──────────────────────────────────
// Generates a 6-digit OTP for the account matching the given email/mobile,
// valid for 5 minutes. Any previous OTP(s) issued for that identifier are
// invalidated (deleted) first, so this endpoint also powers "Resend OTP".

async function sendResetOtp(req, res) {
  try {
    await ensurePasswordResetTable();
    const errors = validationResult(req);
    if (!errors.isEmpty()) return fail(res, 'Validation failed', 422, errors.array());

    const resolved = resolveIdentifier(req.body.identifier);
    if (!resolved) return fail(res, 'Enter a valid email or 10-digit mobile number', 400);
    const { column, value } = resolved;
    const channel = column === 'email' ? 'EMAIL' : 'PHONE';
    if (req.body.channel && req.body.channel.toUpperCase() !== channel) {
      return fail(res, `The selected recovery method does not match the ${column} provided.`, 400);
    }

    const [users] = await db.execute(
      `SELECT id, email, phone, first_name FROM users WHERE ${column} = ? LIMIT 1`,
      [value]
    );

    if (users.length === 0) {
      return fail(res, 'No account found with this email or mobile number', 404);
    }

    const userId = users[0].id;

    // Invalidate any previous OTP(s) for this identifier (covers resend flow).
    await db.execute(
      'DELETE FROM password_reset_otps WHERE identifier = ?',
      [value]
    );

    const otp       = generateOtp();
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

    const [insertResult] = await db.execute(
      `INSERT INTO password_reset_otps (user_id, identifier, channel, otp, expires_at, verified, used)
       VALUES (?, ?, ?, ?, ?, 0, 0)`,
      [userId, value, channel, otp, expiresAt]
    );

    try {
      if (channel === 'EMAIL') {
        await sendOtpEmail({
          to: users[0].email, otp, expiryMinutes: OTP_EXPIRY_MINUTES,
          userName: users[0].first_name, purpose: 'password-reset',
        });
      } else {
        await sendOtpSms(users[0].phone, otp);
      }
    } catch (deliveryError) {
      await db.execute('DELETE FROM password_reset_otps WHERE id = ?', [insertResult.insertId]);
      console.error(`[sendResetOtp] ${channel.toLowerCase()} delivery failed:`, deliveryError.message);
      return fail(res, `We could not send the verification ${channel === 'EMAIL' ? 'email' : 'SMS'}. Please try again.`, 502);
    }

    console.log(`[sendResetOtp] OTP sent via ${channel} for user ${userId}`);

    return ok(res, 'OTP sent successfully', {
      identifier: value,
      channel,
      expires_in_seconds: OTP_EXPIRY_MINUTES * 60,
    });
  } catch (err) {
    console.error('[sendResetOtp]', err);
    return fail(res, 'Failed to send OTP. Please try again.', 500);
  }
}

// ── POST /api/auth/forgot-password/verify-otp ────────────────────────────────
// Verifies the OTP for an identifier. On success, issues a short-lived
// reset_token that must be presented to the reset-password endpoint — this
// prevents anyone from skipping straight to resetting the password without
// having actually verified the OTP.

async function verifyResetOtp(req, res) {
  try {
    await ensurePasswordResetTable();
    const errors = validationResult(req);
    if (!errors.isEmpty()) return fail(res, 'Validation failed', 422, errors.array());
    const resolved = resolveIdentifier(req.body.identifier);
    if (!resolved) return fail(res, 'Enter a valid email or 10-digit mobile number', 400);
    const { column, value } = resolved;
    const channel = column === 'email' ? 'EMAIL' : 'PHONE';
    const otp = req.body.otp.trim();
    const [rows] = await db.execute(
      `SELECT id, otp, expires_at, verified, used, channel
         FROM password_reset_otps
        WHERE identifier = ? AND channel = ?
        ORDER BY created_at DESC
        LIMIT 1`,
      [value, channel]
    );

    if (rows.length === 0) {
      return fail(res, 'No OTP was requested for this identifier. Please request a new OTP.', 400);
    }

    const record = rows[0];

    if (record.used === 1) {
      return fail(res, 'This OTP has already been used. Please request a new OTP.', 400);
    }

    if (record.verified === 1) {
      return fail(res, 'This OTP has already been verified.', 400);
    }

    if (new Date() > new Date(record.expires_at)) {
      // Clean up the expired row so a stale OTP can never be replayed.
      await db.execute('DELETE FROM password_reset_otps WHERE id = ?', [record.id]);
      return fail(res, 'OTP has expired. Please request a new one.', 400);
    }

    if (record.otp !== otp) {
      return fail(res, 'Invalid OTP. Please try again.', 400);
    }

    const resetToken = generateResetToken();
    const resetExpiresAt = new Date(Date.now() + RESET_SESSION_EXPIRY_MINUTES * 60 * 1000);

    await db.execute(
      'UPDATE password_reset_otps SET verified = 1, reset_token = ?, reset_expires_at = ? WHERE id = ?',
      [resetToken, resetExpiresAt, record.id]
    );

    return ok(res, 'OTP verified successfully', {
      identifier: value,
      reset_token: resetToken,
      expires_in_seconds: RESET_SESSION_EXPIRY_MINUTES * 60,
    });
  } catch (err) {
    console.error('[verifyResetOtp]', err);
    return fail(res, 'Failed to verify OTP. Please try again.', 500);
  }
}

// ── POST /api/auth/forgot-password/reset-password ────────────────────────────
// Sets a new password for the account, but only if a verified, unexpired,
// unused reset_token (issued by verifyResetOtp) is presented. Hashes the new
// password with bcrypt before saving, replaces the old password hash, and
// invalidates all reset OTPs for that identifier afterwards.

async function resetPassword(req, res) {
  try {
    await ensurePasswordResetTable();
    const errors = validationResult(req);
    if (!errors.isEmpty()) return fail(res, 'Validation failed', 422, errors.array());
    const resolved = resolveIdentifier(req.body.identifier);
    if (!resolved) return fail(res, 'Enter a valid email or 10-digit mobile number', 400);
    const { value } = resolved;
    const { resetToken, newPassword } = req.body;
    const [rows] = await db.execute(
      `SELECT id, user_id, reset_expires_at, verified, used
         FROM password_reset_otps
        WHERE identifier = ? AND reset_token = ?
        ORDER BY created_at DESC
        LIMIT 1`,
      [value, resetToken]
    );

    if (rows.length === 0) {
      return fail(res, 'Invalid or expired reset session. Please restart the password reset process.', 400);
    }

    const record = rows[0];

    if (record.verified !== 1) {
      return fail(res, 'Please verify the OTP before resetting your password.', 400);
    }

    if (record.used === 1) {
      return fail(res, 'This reset session has already been used. Please request a new OTP.', 400);
    }

    if (!record.reset_expires_at || new Date() > new Date(record.reset_expires_at)) {
      await db.execute('DELETE FROM password_reset_otps WHERE identifier = ?', [value]);
      return fail(res, 'Reset session expired. Please request a new OTP.', 400);
    }

    const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);

    // Atomically claim this authorization before changing the password. Two
    // simultaneous submissions cannot both consume the same reset token.
    const [claim] = await db.execute(
      'UPDATE password_reset_otps SET used = 1 WHERE id = ? AND used = 0',
      [record.id]
    );
    if (claim.affectedRows !== 1) {
      return fail(res, 'This reset session has already been used. Please request a new OTP.', 400);
    }

    await db.execute(
      'UPDATE users SET password_hash = ? WHERE id = ?',
      [passwordHash, record.user_id]
    );

    // Invalidate every previous reset OTP for this identifier (including the
    // one just used) so none of them can ever be replayed.
    await db.execute('DELETE FROM password_reset_otps WHERE identifier = ?', [value]);

    return ok(res, 'Password updated successfully', { identifier: value });
  } catch (err) {
    console.error('[resetPassword]', err);
    return fail(res, 'Failed to reset password. Please try again.', 500);
  }
}

module.exports = { sendResetOtp, verifyResetOtp, resetPassword };

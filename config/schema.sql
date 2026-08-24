-- ============================================================
--  GreenVault Database Schema
--  Run once:  mysql -u root -p < config/schema.sql
--  Safe to re-run — all statements are idempotent.
-- ============================================================

CREATE DATABASE IF NOT EXISTS greenvault
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE greenvault;

-- ── users ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            INT UNSIGNED     NOT NULL AUTO_INCREMENT,
  -- Human-readable member ID assigned only to newly registered users.
  -- Format: MT1112, MT1113, MT1114, ... backed by member_id_sequence.
  -- NULL for users who registered before this feature was introduced;
  -- they are never backfilled. ensureMemberIdSchema() lazily adds this
  -- column via ALTER TABLE if the DB predates schema.sql being re-run.
  member_id     VARCHAR(20)      NULL DEFAULT NULL,
  first_name    VARCHAR(60)      NOT NULL,
  last_name     VARCHAR(60)      NOT NULL,
  email         VARCHAR(191)     NOT NULL,
  phone         CHAR(10)         NOT NULL,
  password_hash VARCHAR(255)     NOT NULL,
  referral_code VARCHAR(30)      DEFAULT NULL,
  email_verified TINYINT(1)      NOT NULL DEFAULT 0,
  phone_verified TINYINT(1)      NOT NULL DEFAULT 0,
  is_active      TINYINT(1)      NOT NULL DEFAULT 1,
  role           ENUM('user','admin') NOT NULL DEFAULT 'user',
  kyc_status     ENUM('not_submitted','pending','approved','rejected')
                                 NOT NULL DEFAULT 'not_submitted',
  balance        DECIMAL(15,2)   NOT NULL DEFAULT 0.00,
  vault_balance  DECIMAL(15,2)   NOT NULL DEFAULT 0.00,

  -- Forgot Login PIN recovery. Application migrations add these columns to
  -- existing installations; keeping them here makes fresh databases complete.
  login_pin_reset_otp VARCHAR(10) DEFAULT NULL,
  login_pin_reset_otp_expires_at TIMESTAMP NULL DEFAULT NULL,
  login_pin_reset_channel ENUM('EMAIL','PHONE') DEFAULT NULL,

  -- Profile fields
  profile_image  VARCHAR(512)    DEFAULT NULL,
  date_of_birth  DATE            DEFAULT NULL,
  gender         ENUM('male','female','other','prefer_not_to_say') DEFAULT NULL,
  address        TEXT            DEFAULT NULL,

  created_at    TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_member_id (member_id),
  UNIQUE KEY uq_email (email),
  UNIQUE KEY uq_phone (phone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── password recovery OTPs ──────────────────────────────────
CREATE TABLE IF NOT EXISTS password_reset_otps (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id          INT UNSIGNED NOT NULL,
  identifier       VARCHAR(191) NOT NULL,
  channel          ENUM('EMAIL','PHONE') NOT NULL,
  otp              VARCHAR(6) NOT NULL,
  reset_token      VARCHAR(64) DEFAULT NULL,
  reset_expires_at TIMESTAMP NULL DEFAULT NULL,
  expires_at       TIMESTAMP NOT NULL,
  verified         TINYINT(1) NOT NULL DEFAULT 0,
  used             TINYINT(1) NOT NULL DEFAULT 0,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_pro_identifier (identifier),
  KEY idx_pro_user (user_id),
  CONSTRAINT fk_pro_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── member_id_sequence ──────────────────────────────────────
-- Backs the human-readable MTxxxx member IDs assigned to newly
-- registered users only (see utils/memberId.js). A dedicated counter
-- table (rather than the users.id AUTO_INCREMENT PK) keeps this
-- sequence independent of the internal primary key, so existing
-- users are never touched and numbers are never reused.
CREATE TABLE IF NOT EXISTS member_id_sequence (
  name        VARCHAR(50)  NOT NULL,
  next_value  INT UNSIGNED NOT NULL,

  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Seed once: the first newly-registered user becomes MT1112, then
-- MT1113, MT1114, ... This INSERT only ever runs if the row is
-- missing, so re-running this file never resets the counter.
INSERT INTO member_id_sequence (name, next_value)
SELECT 'user_member_id', 1112
WHERE NOT EXISTS (
  SELECT 1 FROM member_id_sequence WHERE name = 'user_member_id'
);

-- ── referral_code_sequence ────────────────────────────────
-- Backs the new MT<seq><FirstInitial><LastInitial> referral codes
-- (e.g. MT001MX) assigned to newly registered users only (see
-- utils/referralCode.js). A dedicated counter table keeps this
-- sequence independent of both users.id and member_id_sequence, so
-- existing users' referral codes (my_referral_code) are never
-- touched and a sequence number is never reused.
CREATE TABLE IF NOT EXISTS referral_code_sequence (
  name        VARCHAR(50)  NOT NULL,
  next_value  INT UNSIGNED NOT NULL,

  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Seed once: the first newly-registered user's referral code uses
-- sequence 001 (e.g. MT001MX). This INSERT only ever runs if the
-- row is missing, so re-running this file never resets the counter.
INSERT INTO referral_code_sequence (name, next_value)
SELECT 'user_referral_code', 1
WHERE NOT EXISTS (
  SELECT 1 FROM referral_code_sequence WHERE name = 'user_referral_code'
);

-- ── refresh_tokens ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  user_id    INT UNSIGNED  NOT NULL,
  token_hash VARCHAR(255)  NOT NULL,
  expires_at TIMESTAMP     NOT NULL,
  created_at TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_user (user_id),
  CONSTRAINT fk_rt_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── email_templates ──────────────────────────────────────────
-- Runtime-owned email content. Application code may only select an active
-- template by its unique key and replace the allowlisted {{PLACEHOLDERS}}.
CREATE TABLE IF NOT EXISTS email_templates (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  template_key  VARCHAR(80)   NOT NULL,
  subject       VARCHAR(255)  NOT NULL,
  html_body     MEDIUMTEXT    NOT NULL,
  text_body     TEXT          NOT NULL,
  is_active     TINYINT(1)    NOT NULL DEFAULT 1,
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_email_template_key (template_key),
  CONSTRAINT chk_email_template_active CHECK (is_active IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed only when missing so database-managed edits are never overwritten by
-- application restarts or schema re-runs.
INSERT INTO email_templates (template_key, subject, html_body, text_body)
SELECT
  'otp_email',
  '{{SUBJECT}}',
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>{{SUBJECT}}</title></head><body style="margin:0;padding:0;background:#eef1ec;font-family:Arial,sans-serif;color:#16351c"><div style="display:none;max-height:0;overflow:hidden">Your Moneytries code expires in {{EXPIRY_TIME}} minutes.</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1ec"><tr><td align="center" style="padding:28px 10px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:#fff;border-radius:22px;overflow:hidden"><tr><td align="center" style="padding:18px;background:#0b2412"><img src="cid:moneytries-logo" width="130" height="130" alt="Moneytries" style="display:block;border:0"></td></tr><tr><td align="center" style="padding:30px 28px 8px"><h1 style="margin:0;font-size:30px;line-height:38px;color:#16351c">Your verification code</h1></td></tr><tr><td style="padding:10px 40px;text-align:center;font-size:15px;line-height:24px;color:#5a6b56"><strong>{{GREETING}}</strong><br>Use the code below to {{ACTION}}.</td></tr><tr><td align="center" style="padding:20px 10px"><table role="presentation" cellpadding="0" cellspacing="0"><tr>{{OTP_DIGITS}}</tr></table></td></tr><tr><td align="center" style="padding:4px 30px 10px;font-size:14px;line-height:22px;color:#5a6b56">This code expires in <strong>{{EXPIRY_TIME}} minutes</strong>.</td></tr><tr><td align="center" style="padding:0 30px 22px;font-size:12px;color:#6d7c68">Requested for {{EMAIL}}</td></tr><tr><td style="padding:18px 28px;background:#f4f9f2;border-top:1px solid #d9ecd3;text-align:center;font-size:13px;line-height:20px;color:#456141">Never share this code with anyone. If you did not request it, you can safely ignore this email.</td></tr><tr><td align="center" style="padding:18px;background:#0b2412;color:#fff;font-size:12px">&copy; {{YEAR}} Moneytries &middot; Seed Today. Freedom Tomorrow.</td></tr></table></td></tr></table></body></html>',
  '{{GREETING}}\n\nYour Moneytries verification code is: {{OTP}}\n\nThis code expires in {{EXPIRY_TIME}} minutes. It was requested for {{EMAIL}}.\n\nNever share this code. If you did not request it, ignore this email.'
WHERE NOT EXISTS (
  SELECT 1 FROM email_templates WHERE template_key = 'otp_email'
);

-- ── kyc_submissions ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kyc_submissions (
  id                  INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  user_id             INT UNSIGNED  NOT NULL,

  aadhaar_number      VARCHAR(14)   NOT NULL,
  aadhaar_front_path  VARCHAR(512)  NOT NULL,
  aadhaar_back_path   VARCHAR(512)  NOT NULL,
  pan_number          VARCHAR(10)   NOT NULL,
  pan_front_path      VARCHAR(512)  NOT NULL,
  selfie_path         VARCHAR(512)  NOT NULL,

  account_holder_name VARCHAR(120)  NOT NULL,
  account_number      VARCHAR(20)   NOT NULL,
  ifsc_code           CHAR(11)      NOT NULL,
  bank_name           VARCHAR(120)  DEFAULT NULL,
  bank_branch         VARCHAR(120)  DEFAULT NULL,
  bank_city           VARCHAR(80)   DEFAULT NULL,
  bank_state          VARCHAR(80)   DEFAULT NULL,
  bank_passbook_front_path VARCHAR(512) NOT NULL,

  status              ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  rejection_reason    TEXT          DEFAULT NULL,
  reviewed_at         TIMESTAMP     NULL DEFAULT NULL,

  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_kyc_user   (user_id),
  KEY idx_kyc_status (status),
  CONSTRAINT fk_kyc_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── deposits ─────────────────────────────────────────────────
-- Business rule: a single deposit can never exceed ₹100,000 (1 Lakh).
-- chk_deposit_amount_max enforces this at the database level for any
-- brand-new install (fresh CREATE TABLE). It is intentionally NOT
-- retro-applied via ALTER TABLE to already-existing `deposits` tables —
-- doing so would validate every historical row and could fail startup
-- if any legacy deposit already exceeds the new cap. The authoritative,
-- always-applied guard for both new and existing databases is the
-- application-level check in controllers/depositController.js
-- (createDeposit), which runs before every INSERT regardless of
-- whether this constraint is present.
CREATE TABLE IF NOT EXISTS deposits (
  id               INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  user_id          INT UNSIGNED    NOT NULL,
  amount           DECIMAL(15,2)   NOT NULL,
  utr_id           VARCHAR(100)    NOT NULL,
  proof_image      VARCHAR(512)    NOT NULL,
  order_status     ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  rejection_reason TEXT            DEFAULT NULL,
  reviewed_at      TIMESTAMP       NULL DEFAULT NULL,
  created_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_dep_user   (user_id),
  KEY idx_dep_status (order_status),
  CONSTRAINT fk_dep_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT chk_deposit_amount_max CHECK (amount <= 100000.00)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── withdrawals ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS withdrawals (
  id               INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  user_id          INT UNSIGNED    NOT NULL,
  type             ENUM('wallet','vault') NOT NULL,
  amount           DECIMAL(15,2)   NOT NULL,
  reference_id     VARCHAR(40)     DEFAULT NULL,

  -- Bank details snapshotted from KYC at the time of the request
  account_holder_name VARCHAR(120) DEFAULT NULL,
  account_number      VARCHAR(20)  DEFAULT NULL,
  ifsc_code           CHAR(11)     DEFAULT NULL,
  bank_name            VARCHAR(120) DEFAULT NULL,

  status           ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  admin_remarks    TEXT            DEFAULT NULL,
  reviewed_at      TIMESTAMP       NULL DEFAULT NULL,
  created_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_wd_user   (user_id),
  KEY idx_wd_status (status),
  KEY idx_wd_type   (type),
  CONSTRAINT fk_wd_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

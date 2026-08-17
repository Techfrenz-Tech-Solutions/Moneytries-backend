const ALLOWED_PLACEHOLDERS = new Set([
  'ACTION', 'EMAIL', 'EXPIRY_TIME', 'GREETING', 'OTP', 'OTP_DIGITS',
  'SUBJECT', 'USER_NAME', 'YEAR',
]);

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderStoredTemplate(template, values, rawHtmlValues = new Set()) {
  const replace = (content, html) => String(content).replace(/\{\{([A-Z_]+)\}\}/g, (_match, key) => {
    if (!ALLOWED_PLACEHOLDERS.has(key)) {
      throw new Error(`Email template contains unsupported placeholder: ${key}`);
    }
    if (!Object.hasOwn(values, key)) {
      throw new Error(`Email template value is missing: ${key}`);
    }
    return html && !rawHtmlValues.has(key) ? escapeHtml(values[key]) : String(values[key]);
  });

  return {
    subject: replace(template.subject, false),
    html: replace(template.html_body, true),
    text: replace(template.text_body, false),
  };
}

async function getActiveTemplate(templateKey) {
  // Load lazily so the pure renderer can be unit-tested without opening a DB
  // connection. Runtime sends still use the application's shared pool.
  const db = require('../config/db');
  const [rows] = await db.execute(
    `SELECT subject, html_body, text_body
       FROM email_templates
      WHERE template_key = ? AND is_active = 1
      LIMIT 1`,
    [templateKey]
  );
  if (rows.length === 0) throw new Error(`Active email template not found: ${templateKey}`);
  return rows[0];
}

module.exports = { getActiveTemplate, renderStoredTemplate };

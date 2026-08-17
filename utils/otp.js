const crypto = require('crypto');

function generateOtp() {
  return crypto.randomInt(100000, 1000000).toString();
}

function maskEmail(email) {
  const [local = '', domain = ''] = String(email || '').split('@');
  if (!domain) return '';
  return `${local.slice(0, 1)}${'*'.repeat(Math.max(local.length - 1, 3))}@${domain}`;
}

module.exports = { generateOtp, maskEmail };

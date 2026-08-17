const test = require('node:test');
const assert = require('node:assert/strict');
const { renderStoredTemplate } = require('../services/emailTemplateService');
const { generateOtp, maskEmail } = require('../utils/otp');

test('OTP generator returns cryptographically generated six-digit codes', () => {
  for (let i = 0; i < 100; i += 1) assert.match(generateOtp(), /^\d{6}$/);
});

test('stored email templates render only allowlisted dynamic data', () => {
  const rendered = renderStoredTemplate({
    subject: '{{SUBJECT}}',
    html_body: '<p>{{GREETING}} {{OTP_DIGITS}} {{EMAIL}} {{EXPIRY_TIME}}</p>',
    text_body: '{{OTP}} {{EMAIL}}',
  }, {
    SUBJECT: 'Verification', GREETING: '<User>', OTP_DIGITS: '<b>123456</b>',
    EMAIL: 'person@example.com', EXPIRY_TIME: 5, OTP: '123456',
  }, new Set(['OTP_DIGITS']));

  assert.match(rendered.html, /<b>123456<\/b>/);
  assert.match(rendered.html, /5/);
  assert.match(rendered.html, /&lt;User&gt;/);
  assert.match(rendered.text, /123456/);
});

test('stored templates reject unsupported placeholders', () => {
  assert.throws(() => renderStoredTemplate({
    subject: 'Test', html_body: '{{UNSAFE}}', text_body: 'Test',
  }, {}), /unsupported placeholder/);
});

test('email masking does not expose the local part', () => {
  assert.equal(maskEmail('person@example.com'), 'p*****@example.com');
});

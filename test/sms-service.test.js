const test = require('node:test');
const assert = require('node:assert/strict');
const { sendOtpSms, buildOtpMessage } = require('../services/smsService');

function withSmsEnv(callback) {
  const previous = { ...process.env };
  Object.assign(process.env, {
    SMS_API_KEY: 'test-key',
    SMS_ROUTE: '2',
    SMS_SENDER: 'INSTNE',
    SMS_OTP_TEMPLATE_ID: '1407177605846318046',
  });

  return Promise.resolve(callback()).finally(() => {
    process.env = previous;
  });
}

test('OTP message inserts the generated code into the approved template', () => {
  assert.equal(
    buildOtpMessage('123456'),
    'Your OTP for Moneytries is 123456. Please do not share this OTP.'
  );
});

test('SMS request sends the expected InstantAlerts query parameters', () => withSmsEnv(async () => {
  let requestedUrl;
  const fakeFetch = async (url) => {
    requestedUrl = url;
    return { ok: true, status: 200, text: async () => 'message-id' };
  };

  await sendOtpSms('9876543210', '123456', fakeFetch);

  assert.equal(requestedUrl.searchParams.get('number'), '9876543210');
  assert.equal(requestedUrl.searchParams.get('key'), 'test-key');
  assert.equal(requestedUrl.searchParams.get('templateid'), '1407177605846318046');
  assert.match(requestedUrl.searchParams.get('sms'), /123456/);
}));

test('SMS request rejects an unsuccessful provider response', () => withSmsEnv(async () => {
  const fakeFetch = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' });
  await assert.rejects(sendOtpSms('9876543210', '123456', fakeFetch), /HTTP 401/);
}));

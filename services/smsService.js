const DEFAULT_SMS_URL = 'https://instantalerts.in/api/smsapi';
const DEFAULT_OTP_MESSAGE = 'Your OTP for Moneytries is {{OTP}}. Please do not share this OTP.';

function requiredEnv(name) {
  const value = (process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function buildOtpMessage(otp) {
  const template = process.env.SMS_OTP_MESSAGE_TEMPLATE || DEFAULT_OTP_MESSAGE;
  if (!template.includes('{{OTP}}')) {
    throw new Error('SMS_OTP_MESSAGE_TEMPLATE must contain {{OTP}}');
  }
  return template.replaceAll('{{OTP}}', otp);
}

async function sendOtpSms(phone, otp, fetchImpl = global.fetch) {
  const url = new URL(process.env.SMS_API_URL || DEFAULT_SMS_URL);
  url.search = new URLSearchParams({
    key: requiredEnv('SMS_API_KEY'),
    route: (process.env.SMS_ROUTE || '2').trim(),
    sender: requiredEnv('SMS_SENDER'),
    number: phone,
    templateid: requiredEnv('SMS_OTP_TEMPLATE_ID'),
    sms: buildOtpMessage(otp),
  }).toString();

  const timeoutMs = Number.parseInt(process.env.SMS_TIMEOUT_MS || '10000', 10);
  const response = await fetchImpl(url, {
    method: 'GET',
    signal: AbortSignal.timeout(Number.isFinite(timeoutMs) ? timeoutMs : 10000),
  });
  const responseBody = await response.text();

  if (!response.ok || !responseBody.trim()) {
    throw new Error(`SMS provider rejected the request (HTTP ${response.status})`);
  }

  return responseBody;
}

module.exports = { sendOtpSms, buildOtpMessage };

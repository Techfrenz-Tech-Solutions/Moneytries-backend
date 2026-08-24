const path = require('path');
const nodemailer = require('nodemailer');
const { getActiveTemplate, renderStoredTemplate } = require('./emailTemplateService');

let transporter;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required email configuration: ${name}`);
  return value;
}

function getTransporter() {
  if (!transporter) {
    const port = Number(required('SMTP_PORT'));
    transporter = nodemailer.createTransport({
      host: required('SMTP_HOST'),
      port,
      secure: port === 465,
      requireTLS: port === 587,
      auth: { user: required('SMTP_USER'), pass: required('SMTP_PASS') },
    });
  }
  return transporter;
}

async function sendOtpEmail({ to, otp, expiryMinutes, userName, purpose }) {
  const fromEmail = required('SMTP_FROM_EMAIL');
  const fromName = process.env.SMTP_FROM_NAME || 'Moneytries';
  const subject = purpose === 'password-reset'
    ? 'Reset your Moneytries password'
    : purpose === 'pin-reset'
      ? 'Reset your Moneytries login PIN'
      : 'Your Moneytries verification code';
  const action = purpose === 'password-reset'
    ? 'reset your Moneytries password'
    : purpose === 'pin-reset'
      ? 'reset your Moneytries login PIN'
    : purpose === 'two-factor-authentication'
      ? 'complete your Moneytries security verification'
      : 'verify your Moneytries email address';
  const safeOtp = String(otp);
  const otpDigits = [...safeOtp].map(digit =>
    `<td style="width:46px;height:58px;background:#fff;border:1px solid #2f9e44;border-radius:12px;text-align:center;font:800 26px Arial,sans-serif;color:#16351c">${digit}</td>`
  ).join('<td style="width:8px">&nbsp;</td>');
  const template = await getActiveTemplate('otp_email');
  const rendered = renderStoredTemplate(template, {
    ACTION: action,
    EMAIL: to,
    EXPIRY_TIME: expiryMinutes,
    GREETING: userName ? `Hello ${userName},` : 'Hello!',
    OTP: safeOtp,
    OTP_DIGITS: otpDigits,
    SUBJECT: subject,
    USER_NAME: userName || '',
    YEAR: new Date().getUTCFullYear(),
  }, new Set(['OTP_DIGITS']));

  return getTransporter().sendMail({
    from: { name: fromName, address: fromEmail },
    to,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    attachments: [{
      filename: 'moneytries-logo.png',
      path: path.join(__dirname, '..', 'assets', 'email', 'moneytries-logo.png'),
      cid: 'moneytries-logo',
    }],
  });
}

async function verifyEmailTransport() {
  return getTransporter().verify();
}

module.exports = { sendOtpEmail, verifyEmailTransport };

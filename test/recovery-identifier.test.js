const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveRecoveryIdentifier,
  gmailCanonicalLocal,
} = require('../utils/recoveryIdentifier');

test('dotted email addresses remain valid email recovery identifiers', () => {
  assert.deepEqual(resolveRecoveryIdentifier(' First.Last@gmail.com '), {
    column: 'email',
    value: 'first.last@gmail.com',
    channel: 'EMAIL',
  });
});

test('ten-digit identifiers always select phone recovery', () => {
  assert.deepEqual(resolveRecoveryIdentifier('9876543210'), {
    column: 'phone',
    value: '9876543210',
    channel: 'PHONE',
  });
});

test('Gmail aliases ignore local-part dots but other providers do not', () => {
  assert.equal(gmailCanonicalLocal('first.last@gmail.com'), 'firstlast');
  assert.equal(gmailCanonicalLocal('first.last@googlemail.com'), 'firstlast');
  assert.equal(gmailCanonicalLocal('first.last@example.com'), null);
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('GET /api exposes the MoneyTries service discovery response', () => {
  assert.match(serverSource, /app\.get\('\/api'/);
  assert.match(serverSource, /service:\s*'MoneyTries API'/);
  assert.match(serverSource, /status:\s*'ok'/);
});

test('push notification routes are mounted by the production server', () => {
  assert.match(serverSource, /app\.use\('\/api\/push',\s*pushRoutes\)/);
});

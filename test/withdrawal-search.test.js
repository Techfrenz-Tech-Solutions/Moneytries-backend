const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'controllers', 'withdrawalController.js'),
  'utf8'
);

test('withdrawal history applies the app search filter to reference IDs', () => {
  assert.match(source, /const \{ type, status, search \} = req\.body/);
  assert.match(source, /reference_id LIKE \?/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isQuiet } from '../src/night.js';

const at = (h, m = 0) => Date.UTC(2026, 10, 20, (h - 7 + 24) % 24, m) / 1000; // GMT+7 clock time

test('isQuiet wraps past midnight: 23:30 to 07:00 GMT+7', () => {
  const config = { quietHours: [23.5, 7] };
  assert.equal(isQuiet(config, at(23, 29)), false);
  assert.equal(isQuiet(config, at(23, 30)), true);
  assert.equal(isQuiet(config, at(3)), true);
  assert.equal(isQuiet(config, at(6, 59)), true);
  assert.equal(isQuiet(config, at(7)), false);
  assert.equal(isQuiet(config, at(15)), false);
});

test('isQuiet without quietHours is never quiet', () => {
  assert.equal(isQuiet({}, at(3)), false);
});

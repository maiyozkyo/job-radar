import { test } from 'node:test';
import assert from 'node:assert/strict';
import { netUsd } from '../src/fees.js';
import { loadConfig } from '../src/job.js';

const fl = (budgetType, budgetMaxUsd) => ({ source: 'freelancer', budgetType, budgetMaxUsd });

test('fixed price takes 10% or $5, whichever is greater', () => {
  assert.equal(netUsd(fl('fixed', 30)), 25);
  assert.equal(netUsd(fl('fixed', 40)), 35);
  assert.equal(netUsd(fl('fixed', 100)), 90);
});

test('hourly takes 10%', () => {
  assert.equal(netUsd(fl('hourly', 20)), 18);
});

test('unknown budget or non-Freelancer source has no net', () => {
  assert.equal(netUsd(fl('fixed', null)), null);
  assert.equal(netUsd({ source: 'remoteok', budgetType: 'salary', budgetMaxUsd: 5000 }), null);
});

test('config holds the spec floors and thresholds', () => {
  const c = loadConfig();
  assert.equal(c.minFixedUsd, 30);
  assert.equal(c.minHourlyUsd, 15);
  assert.equal(c.maxBidCount, 30);
  assert.equal(c.alertScore, 7);
  assert.equal(c.digestDraftScore, 8);
});

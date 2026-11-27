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
  assert.equal(c.minFixedUsd, 15);
  assert.equal(c.minHourlyUsd, 15);
  assert.equal(c.maxBidCount, 30);
  assert.equal(c.alertScore, 7);
  assert.equal(c.digestDraftScore, 8);
});

import { suggestBid } from '../src/fees.js';

const opts = { rate: 20, hoursPerDay: 2 };
const job = (budgetType, budgetMinUsd, budgetMaxUsd, source = 'freelancer') => ({ source, budgetType, budgetMinUsd, budgetMaxUsd });

test('fixed bid = hours × rate inside the client range, with net and evening days', () => {
  assert.deepEqual(suggestBid(job('fixed', 30, 150), 6, opts),
    { amountUsd: 120, unit: '', hours: 6, days: 4, netUsd: 108, wantUsd: 120, underpaid: false, discounted: false });
});

test('fixed bid is capped at the budget and flagged when the work is worth more', () => {
  const b = suggestBid(job('fixed', 50, 100), 8, opts);
  assert.equal(b.amountUsd, 100);
  assert.equal(b.wantUsd, 160);
  assert.equal(b.underpaid, true);
});

test('fixed bid is raised to the client minimum and rounded to $5', () => {
  assert.equal(suggestBid(job('fixed', 200, 400), 3, opts).amountUsd, 200);
  assert.equal(suggestBid(job('fixed', 10, 400), 3.3, opts).amountUsd, 65);
});

test('hourly bid is the rate inside the range', () => {
  const b = suggestBid(job('hourly', 15, 25), 10, opts);
  assert.equal(b.amountUsd, 20);
  assert.equal(b.unit, '/h');
  assert.equal(b.netUsd, 18);
  assert.equal(b.underpaid, false);
  assert.equal(suggestBid(job('hourly', 10, 15), 10, opts).underpaid, true);
});

test('no bid without hours, budget or a Freelancer job', () => {
  assert.equal(suggestBid(job('fixed', 30, 150), null, opts), null);
  assert.equal(suggestBid(job('fixed', null, null), 5, opts), null);
  assert.equal(suggestBid(job('salary', null, 90000, 'remoteok'), 5, opts), null);
});

import { splitMilestones } from '../src/fees.js';

test('two milestones split about 40/60 and add up to the bid', () => {
  const bid = suggestBid(job('fixed', 250, 750), 14, opts); // $280
  assert.deepEqual(splitMilestones(bid, ['Demo', 'Hand-over']),
    [{ name: 'Demo', amountUsd: 112 }, { name: 'Hand-over', amountUsd: 168 }]);
  const odd = splitMilestones({ ...bid, amountUsd: 65 }, ['a', 'b']);
  assert.equal(odd[0].amountUsd + odd[1].amountUsd, 65);
});

test('one milestone takes the whole bid; hourly or no names give none', () => {
  const bid = suggestBid(job('fixed', 30, 150), 6, opts);
  assert.deepEqual(splitMilestones(bid, ['Fix']), [{ name: 'Fix', amountUsd: 120 }]);
  assert.deepEqual(splitMilestones(suggestBid(job('hourly', 15, 25), 10, opts), ['x']), []);
  assert.deepEqual(splitMilestones(bid, []), []);
  assert.deepEqual(splitMilestones(null, ['x']), []);
});

test('first-job discount lowers the bid, keeps the full value, stays in budget', () => {
  const d = { ...opts, discount: 0.75 };
  const b = suggestBid(job('fixed', 30, 400), 10, d);
  assert.equal(b.amountUsd, 150);
  assert.equal(b.wantUsd, 200);
  assert.equal(b.discounted, true);
  assert.equal(suggestBid(job('fixed', 30, 400), 10, opts).discounted, false);
  // the client's minimum wins over the discount
  assert.equal(suggestBid(job('fixed', 200, 400), 10, d).discounted, false);
  assert.equal(suggestBid(job('hourly', 10, 25), 10, d).amountUsd, 15);
});

test('config starts with the first-job discount on', () => {
  assert.equal(loadConfig().firstJobDiscount, 0.75);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickFresh } from '../src/fastpoll.js';
import { loadConfig, makeJob } from '../src/job.js';

const config = loadConfig();
const NOW = 1794300000;
const job = (id, ago, extra = {}) => makeJob({
  source: 'freelancer', id, title: 'Angular dashboard fix', budgetType: 'fixed', budgetMaxUsd: 100, bidCount: 1, postedAt: NOW - ago, ...extra,
});

test('new, recent, matching projects are fresh and remembered', () => {
  const { fresh, seen } = pickFresh([job(1, 60)], {}, NOW, config);
  assert.deepEqual(fresh.map((j) => j.id), ['1']);
  assert.deepEqual(seen, { 1: NOW });
});

test('already triggered, old or filtered-out projects are not fresh', () => {
  const jobs = [job(1, 60), job(2, 3600), job(3, 60, { title: 'Logo design', tags: [] }), job(4, 60, { budgetMaxUsd: 5 })];
  const { fresh } = pickFresh(jobs, { 1: NOW - 30 }, NOW, config);
  assert.deepEqual(fresh, []);
});

test('old triggered ids are forgotten', () => {
  const { seen } = pickFresh([], { 1: NOW - 3 * 3600, 2: NOW - 60 }, NOW, config);
  assert.deepEqual(seen, { 2: NOW - 60 });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadState, saveState, takeNew, prune } from '../src/state.js';
import { makeJob } from '../src/job.js';

const NOW = 1794300000;
const DAY = 24 * 3600;
const jobs = (...ids) => ids.map((id) => makeJob({ source: 'freelancer', id }));

test('missing state.json gives an empty, uninitialized state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'radar-'));
  assert.deepEqual(loadState(dir), { initialized: false, seeded: {}, seen: {}, pending: [], lastFetch: {} });
});

test('first run marks everything seen and returns nothing', () => {
  const state = { initialized: false, seen: {}, pending: [] };
  const { fresh, firstRun } = takeNew(state, jobs(1, 2, 3, 4, 5), NOW);
  assert.equal(firstRun, true);
  assert.equal(fresh.length, 0);
  assert.equal(Object.keys(state.seen).length, 5);
  assert.equal(state.initialized, true);
});

test('later runs return only unseen jobs', () => {
  const state = { initialized: true, seen: { 'freelancer:1': NOW, 'freelancer:2': NOW }, pending: [] };
  const { fresh, firstRun } = takeNew(state, jobs(1, 2, 3), NOW);
  assert.equal(firstRun, false);
  assert.deepEqual(fresh.map((j) => j.key), ['freelancer:3']);
  assert.ok(state.seen['freelancer:3']);
});

test('duplicates inside one batch are returned once', () => {
  const state = { initialized: true, seen: {}, pending: [] };
  const { fresh } = takeNew(state, jobs(7, 7), NOW);
  assert.equal(fresh.length, 1);
});

test('prune drops ids older than 60 days', () => {
  const state = { initialized: true, seen: { old: NOW - 61 * DAY, recent: NOW - 59 * DAY }, pending: [] };
  prune(state, NOW);
  assert.deepEqual(Object.keys(state.seen), ['recent']);
});

test('save then load round-trips', () => {
  const dir = mkdtempSync(join(tmpdir(), 'radar-'));
  const state = { initialized: true, seeded: { freelancer: true }, seen: { a: 1 }, pending: jobs(9), lastFetch: { remotive: 5 } };
  saveState(dir, state);
  assert.deepEqual(loadState(dir), state);
});

test('a source answering for the first time is seeded, not alerted', () => {
  const state = { initialized: true, seeded: { hn: true }, seen: {}, pending: [] };
  const { fresh } = takeNew(state, jobs(1, 2), NOW, ['freelancer']);
  assert.equal(fresh.length, 0);
  assert.equal(state.seeded.freelancer, true);
  const next = takeNew(state, jobs(1, 2, 3), NOW, ['freelancer']);
  assert.deepEqual(next.fresh.map((j) => j.key), ['freelancer:3']);
});

test('a source that failed stays unseeded', () => {
  const state = { initialized: false, seeded: {}, seen: {}, pending: [] };
  takeNew(state, [], NOW, ['hn']);
  assert.equal(state.seeded.freelancer, undefined);
  assert.equal(state.seeded.hn, true);
});

test('a corrupt state.json starts over instead of crashing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'radar-'));
  writeFileSync(join(dir, 'state.json'), '{"initialized": true, "seen": {');
  assert.equal(loadState(dir).initialized, false);
});

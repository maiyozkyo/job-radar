import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/main.js';
import { loadConfig, makeJob } from '../src/job.js';
import { loadState, saveState } from '../src/state.js';

const config = loadConfig();
const NOW = 1794300000;
const urgent = (id) => makeJob({ source: 'freelancer', id, title: 'Angular fix', url: `https://f/${id}`, budgetType: 'fixed', budgetMaxUsd: 50, bidCount: 1 });
const board = (id) => makeJob({ source: 'remoteok', id, title: 'Contract Angular dev', url: `https://r/${id}`, location: 'Worldwide' });

function setup({ jobs = [], errors = [], initialized = true, pending = [], scores = {}, scoreFails = false, sendFails = false } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'radar-'));
  if (initialized) saveState(stateDir, { initialized: true, seeded: { freelancer: true, hn: true, wwr: true, remoteok: true, himalayas: true }, seen: {}, pending });
  const sent = [];
  const deps = {
    stateDir, config, env: {}, now: NOW,
    fetchAll: async () => ({ jobs, errors, okSources: ['freelancer', 'hn', 'wwr', 'remoteok', 'himalayas'] }),
    scoreJobs: async (list) => {
      if (scoreFails) throw new Error('token expired');
      return list.map((j) => ({ key: j.key, score: scores[j.key] ?? 8, reasonVi: 'ok', proposalEn: 'Hi' }));
    },
    sendMessage: async (text) => { if (sendFails) throw new Error('telegram down'); sent.push(text); },
  };
  return { deps, sent, stateDir };
}

test('first run sends only the start message and initializes state', async () => {
  const { deps, sent, stateDir } = setup({ initialized: false, jobs: [urgent(1), urgent(2)] });
  await run('poll', deps);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /✅ Job radar đã chạy lần đầu/);
  assert.equal(loadState(stateDir).initialized, true);
});

test('urgent job scored 8 is alerted, scored 6 is not', async () => {
  const { deps, sent } = setup({ jobs: [urgent(1), urgent(2)], scores: { 'freelancer:2': 6 } });
  await run('poll', deps);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /https:\/\/f\/1/);
});

test('Claude failure sends every kept urgent job in one warning message', async () => {
  const { deps, sent } = setup({ jobs: [urgent(1), urgent(2)], scoreFails: true });
  await run('poll', deps);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /⚠️ Claude lỗi/);
  assert.match(sent[0], /https:\/\/f\/1/);
  assert.match(sent[0], /https:\/\/f\/2/);
});

test('a job Claude skipped is sent unscored, not lost', async () => {
  const { deps, sent } = setup({ jobs: [urgent(1)] });
  deps.scoreJobs = async (list) => list.map(() => null);
  await run('poll', deps);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /https:\/\/f\/1/);
});

test('digest keeps pending when Claude fails', async () => {
  const { deps, sent, stateDir } = setup({ pending: [board(1)], scoreFails: true });
  await run('digest', deps);
  assert.equal(loadState(stateDir).pending.length, 1);
  assert.match(sent[0], /Claude lỗi/);
});

test('board jobs are queued, not alerted', async () => {
  const { deps, sent, stateDir } = setup({ jobs: [board(1)] });
  await run('poll', deps);
  assert.equal(sent.length, 0);
  assert.deepEqual(loadState(stateDir).pending.map((j) => j.key), ['remoteok:1']);
});

test('the same job is not alerted twice across runs', async () => {
  const { deps, sent } = setup({ jobs: [urgent(1)] });
  await run('poll', deps);
  await run('poll', deps);
  assert.equal(sent.length, 1);
});

test('source errors ride on the first alert', async () => {
  const { deps, sent } = setup({ jobs: [urgent(1)], errors: ['remoteok: HTTP 403'] });
  await run('poll', deps);
  assert.match(sent[0], /remoteok: HTTP 403/);
});

test('digest sends only good jobs and clears pending', async () => {
  const { deps, sent, stateDir } = setup({ pending: [board(1), board(2)], scores: { 'remoteok:1': 9, 'remoteok:2': 5 } });
  await run('digest', deps);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /https:\/\/r\/1/);
  assert.doesNotMatch(sent[0], /https:\/\/r\/2/);
  assert.equal(loadState(stateDir).pending.length, 0);
});

test('digest keeps pending when Telegram fails', async () => {
  const { deps, stateDir } = setup({ pending: [board(1)], sendFails: true });
  await assert.rejects(run('digest', deps), /telegram down/);
  assert.equal(loadState(stateDir).pending.length, 1);
});

test('digest with nothing pending sends nothing', async () => {
  const { deps, sent } = setup();
  await run('digest', deps);
  assert.equal(sent.length, 0);
});

test('poll passes the saved rate-limit times to fetchAll and keeps the updated ones', async () => {
  const { deps, stateDir } = setup({ jobs: [] });
  const s = loadState(stateDir);
  s.lastFetch = { remotive: NOW - 60 };
  saveState(stateDir, s);
  let seen;
  deps.fetchAll = async (cfg, fetchFn, now, lastFetch) => {
    seen = { ...lastFetch };
    lastFetch.jobicy = now;
    return { jobs: [], errors: [], okSources: ['jobicy'] };
  };
  await run('poll', deps);
  assert.deepEqual(seen, { remotive: NOW - 60 });
  assert.deepEqual(loadState(stateDir).lastFetch, { remotive: NOW - 60, jobicy: NOW });
});

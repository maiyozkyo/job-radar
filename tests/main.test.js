import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/main.js';
import { loadConfig, makeJob } from '../src/job.js';
import { appendLog, loadState, saveState } from '../src/state.js';

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
  assert.equal(sent[0].html, true);
  assert.match(sent[0].text, /https:\/\/f\/1/);
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

test('scores are logged with key and title, proposals are not', async () => {
  const { deps } = setup({ jobs: [urgent(1)] });
  const lines = [];
  const orig = console.log;
  console.log = (l) => lines.push(String(l));
  try { await run('poll', deps); } finally { console.log = orig; }
  const line = lines.find((l) => l.startsWith('score '));
  assert.match(line, /^score 8 - freelancer:1 \| Angular fix \| https:\/\/f\/1$/);
  assert.ok(!lines.some((l) => l.includes('Hi')), 'proposal text leaked into the log');
});

test('poll writes each score and a run summary with drop reasons to scores.log', async () => {
  const offStack = makeJob({ source: 'freelancer', id: 9, title: 'Logo design', url: 'https://f/9', budgetType: 'fixed', budgetMaxUsd: 50, bidCount: 1 });
  const { deps, stateDir } = setup({ jobs: [urgent(1), urgent(2), offStack], scores: { 'freelancer:2': 6 } });
  await run('poll', deps);
  const lines = readFileSync(join(stateDir, 'scores.log'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^2026-\d\d-\d\dT\d\d:\d\dZ score 8 - freelancer:1 \| Angular fix \| https:\/\/f\/1$/);
  assert.match(lines[1], /score 6 - freelancer:2/);
  assert.match(lines[2], /run poll fresh=3 kept=2 night=0 scored=2 unscored=0 alerts=1 sent=1 dropped: no stack keyword=1$/);
  assert.doesNotMatch(lines.join('\n'), /Hi/); // no proposals
});

test('scores.log appends across runs, keeps the newest lines and stays one line per entry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'radar-'));
  appendLog(dir, ['a', 'b\nc']);
  appendLog(dir, []);
  appendLog(dir, ['d']);
  assert.equal(readFileSync(join(dir, 'scores.log'), 'utf8'), 'a\nb c\nd\n');
});

// 2026-11-20 00:30 and 07:10 GMT+7 (17:30 and 00:10 UTC).
const NIGHT = Date.UTC(2026, 10, 19, 17, 30) / 1000;
const MORNING = Date.UTC(2026, 10, 20, 0, 10) / 1000;

test('quiet hours: urgent jobs wait in state.night, nothing is scored or sent', async () => {
  const { deps, sent, stateDir } = setup({ jobs: [urgent(1), urgent(2)] });
  let scoredCount = 0;
  const score = deps.scoreJobs;
  deps.scoreJobs = async (list) => { scoredCount += list.length; return score(list); };
  deps.now = NIGHT;
  await run('poll', deps);
  assert.equal(sent.length, 0);
  assert.equal(scoredCount, 0);
  assert.deepEqual(loadState(stateDir).night.map((j) => j.key), ['freelancer:1', 'freelancer:2']);
});

test('first poll after quiet hours sends a header and the open night jobs, best first, then clears the queue', async () => {
  const { deps, sent, stateDir } = setup({ jobs: [urgent(1), urgent(2), urgent(3), urgent(4)], scores: { 'freelancer:2': 9, 'freelancer:4': 5 } });
  deps.now = NIGHT;
  await run('poll', deps);
  deps.now = MORNING;
  deps.fetchAll = async () => ({ jobs: [], errors: [], okSources: ['freelancer'] });
  // 1 and 2 open; 3 closed; 4 open but scores 5.
  deps.freelancerStatus = async (ids) => {
    assert.deepEqual(ids, ['1', '2', '3', '4']);
    return new Map([['1', { open: true, bidCount: 3 }], ['2', { open: true, bidCount: 2 }], ['3', { open: false, bidCount: 9 }], ['4', { open: true, bidCount: 1 }]]);
  };
  await run('poll', deps);
  assert.equal(sent.length, 3);
  assert.match(sent[0], /🌙 Job đêm qua: 4 job, 3 còn mở, 2 job ≥ 7/);
  assert.match(sent[1].text, /https:\/\/f\/2/);
  assert.match(sent[2].text, /https:\/\/f\/1/);
  assert.equal(loadState(stateDir).night.length, 0);
  await run('poll', deps);
  assert.equal(sent.length, 3, 'the batch goes out once');
});

test('morning batch drops night jobs that filled up with bids', async () => {
  const { deps, sent } = setup({ jobs: [urgent(1)] });
  deps.now = NIGHT;
  await run('poll', deps);
  deps.now = MORNING;
  deps.fetchAll = async () => ({ jobs: [], errors: [], okSources: ['freelancer'] });
  deps.freelancerStatus = async () => new Map([['1', { open: true, bidCount: config.maxBidCount + 1 }]]);
  await run('poll', deps);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /1 job, 0 còn mở, 0 job/);
});

test('morning batch still goes out when the status check fails', async () => {
  const { deps, sent } = setup({ jobs: [urgent(1)] });
  deps.now = NIGHT;
  await run('poll', deps);
  deps.now = MORNING;
  deps.fetchAll = async () => ({ jobs: [], errors: [], okSources: ['freelancer'] });
  deps.freelancerStatus = async () => { throw new Error('HTTP 503'); };
  await run('poll', deps);
  assert.equal(sent.length, 2);
  assert.match(sent[0], /Không kiểm tra được/);
});

test('morning batch is kept when Telegram fails', async () => {
  const { deps, stateDir } = setup({ jobs: [urgent(1)] });
  deps.now = NIGHT;
  await run('poll', deps);
  deps.now = MORNING;
  deps.fetchAll = async () => ({ jobs: [], errors: [], okSources: ['freelancer'] });
  deps.sendMessage = async () => { throw new Error('telegram down'); };
  await assert.rejects(run('poll', deps));
  assert.equal(loadState(stateDir).night.length, 1);
});

test('jobs dropped for their client are counted and reported once, on the next morning', async () => {
  const junk = (id) => ({ ...urgent(id), client: { paymentVerified: false, depositMade: false, registeredAt: NOW, reviews: 0, rating: 0, completed: 0 } });
  const DAY1 = Date.UTC(2026, 10, 19, 5, 0) / 1000;
  const { deps, sent, stateDir } = setup({ jobs: [junk(1), junk(2), urgent(3)] });
  deps.now = DAY1;
  await run('poll', deps);
  assert.equal(sent.length, 1, 'only the good job');
  assert.deepEqual(loadState(stateDir).clientDrops, { day: '2026-11-19', reasons: { 'payment not verified': 2 } });
  deps.fetchAll = async () => ({ jobs: [], errors: [], okSources: ['freelancer'] });
  deps.now = NIGHT;
  await run('poll', deps);
  assert.equal(sent.length, 1, 'no report in quiet hours');
  deps.now = MORNING;
  await run('poll', deps);
  assert.equal(sent[1], '🧹 Ngày 2026-11-19: bot loại 2 job Freelancer vì khách (chưa xác minh thanh toán: 2).');
  await run('poll', deps);
  assert.equal(sent.length, 2, 'the report goes out once');
});

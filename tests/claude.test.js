import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreJobs, ClaudeOutputError } from '../src/claude.js';
import { makeJob } from '../src/job.js';

const jobs = [
  makeJob({ source: 'freelancer', id: 1, title: 'Angular fix', description: 'x'.repeat(5000), budgetType: 'fixed', budgetMaxUsd: 50 }),
  makeJob({ source: 'hn', id: 2, title: 'SEEKING FREELANCER LLM' }),
];
const reply = (arr) => async () => `Here you go:\n${JSON.stringify(arr)}\nDone.`;
const good = [
  { key: 'hn:2', score: 5, reasonVi: 'Mơ hồ', proposalEn: null },
  { key: 'freelancer:1', score: 8, reasonVi: 'Hợp', proposalEn: 'Hi' },
];

test('parses JSON wrapped in prose and returns input order', async () => {
  const out = await scoreJobs(jobs, { draftMin: 7 }, reply(good));
  assert.deepEqual(out.map((s) => s.key), ['freelancer:1', 'hn:2']);
  assert.equal(out[0].proposalEn, 'Hi');
});

test('a missing key is an output error', async () => {
  await assert.rejects(scoreJobs(jobs, { draftMin: 7 }, reply([good[0]])), ClaudeOutputError);
});

test('a score outside 1-10 is an output error', async () => {
  await assert.rejects(
    scoreJobs(jobs, { draftMin: 7 }, reply([good[0], { ...good[1], score: 11 }])),
    ClaudeOutputError,
  );
});

test('a non-JSON reply is an output error', async () => {
  await assert.rejects(scoreJobs(jobs, { draftMin: 7 }, async () => 'Sorry, I cannot.'), ClaudeOutputError);
});

test('runner failure propagates', async () => {
  await assert.rejects(scoreJobs(jobs, { draftMin: 7 }, async () => { throw new Error('token expired'); }), /token expired/);
});

test('prompt holds the profile, every key, the threshold, and trimmed descriptions', async () => {
  let prompt = '';
  await scoreJobs(jobs, { draftMin: 7 }, async (p) => { prompt = p; return JSON.stringify(good); });
  assert.match(prompt, /ShopTemplate/);
  assert.match(prompt, /freelancer:1/);
  assert.match(prompt, /hn:2/);
  assert.match(prompt, /score >= 7/);
  assert.equal(prompt.includes('x'.repeat(3001)), false);
  assert.ok(prompt.includes('x'.repeat(3000)));
});

test('no jobs means no Claude call', async () => {
  const out = await scoreJobs([], { draftMin: 7 }, async () => { throw new Error('should not run'); });
  assert.deepEqual(out, []);
});

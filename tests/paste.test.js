import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bidFromHours, fetchPaste, findFreelancerLink, pastedJob } from '../src/paste.js';

test('a freelancer.com project link is found alone or inside a note', () => {
  const link = 'https://www.freelancer.com/projects/excel-vba/Excel-Cleanup-Sheet-Organization';
  assert.equal(findFreelancerLink(link), link);
  assert.equal(findFreelancerLink(' https://freelancer.com/projects/a/b-1?frm=x '), 'https://freelancer.com/projects/a/b-1?frm=x');
  assert.equal(findFreelancerLink(`Job này ổn không? ${link}.`), link);
  assert.equal(findFreelancerLink('https://www.upwork.com/jobs/~01abc'), null);
  assert.equal(findFreelancerLink('https://www.freelancer.com/u/someone'), null);
  assert.equal(findFreelancerLink('chào bot'), null);
});

test('pasted text becomes a job titled by its first line', () => {
  const job = pastedJob('k1', '\n  Angular dashboard fix  \nWe need charts fixed. Budget $200.');
  assert.equal(job.key, 'paste:k1');
  assert.equal(job.source, 'paste');
  assert.equal(job.title, 'Angular dashboard fix');
  assert.match(job.description, /Budget \$200/);
});

test('bid from hours at the rate, rounded to $5, with delivery days', () => {
  assert.deepEqual(bidFromHours(6, { rate: 20, hoursPerDay: 5 }),
    { amountUsd: 120, unit: '', hours: 6, days: 3, netUsd: 108, wantUsd: 120, underpaid: false, discounted: false });
  assert.equal(bidFromHours(null, { rate: 20, hoursPerDay: 5 }), null);
  assert.equal(bidFromHours(0.1, { rate: 20, hoursPerDay: 5 }).amountUsd, 5);
});

test('fetchPaste sends the token and reports a missing paste', async () => {
  let init;
  const env = { WORKER_URL: 'https://w.example', PASTE_TOKEN: 'P' };
  const text = await fetchPaste('k', env, async (url, i) => { init = i; assert.equal(url, 'https://w.example/paste/k'); return { ok: true, status: 200, text: async () => 'job text' }; });
  assert.equal(text, 'job text');
  assert.equal(init.headers.Authorization, 'Bearer P');
  await assert.rejects(fetchPaste('k', env, async () => ({ ok: false, status: 404 })), /expired or not found/);
  await assert.rejects(fetchPaste('k', {}, async () => ({})), /missing WORKER_URL/);
});

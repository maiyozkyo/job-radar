import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseReddit, fetchReddit, isHiringPost } from '../src/sources/reddit.js';
import { fetchAll } from '../src/sources/index.js';
import { isUrgent } from '../src/filter.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/reddit.json', import.meta.url), 'utf8'));
const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const KEYS = { REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'secret' };

test('Reddit: keeps open [Hiring] posts, drops [For Hire], stickied and removed posts', () => {
  const jobs = parseReddit(fixture);
  assert.deepEqual(jobs.map((j) => j.key), ['reddit:abc1', 'reddit:abc3']);
  assert.equal(jobs[0].url, 'https://www.reddit.com/r/forhire/comments/abc1/hiring_fix_a_bug/');
  assert.equal(jobs[0].postedAt, 1794299000);
  assert.deepEqual(jobs[1].tags, ['r/jobbit']);
  assert.ok(isUrgent(jobs[0]));
});

test('Reddit: flair "Hiring" counts, flair "For Hire" does not', () => {
  assert.ok(isHiringPost({ title: 'Need help', link_flair_text: 'Hiring' }));
  assert.ok(!isHiringPost({ title: 'Available', link_flair_text: 'For Hire' }));
  assert.ok(!isHiringPost({ title: '[For Hire] also [Hiring] partners', link_flair_text: null }));
});

test('Reddit: gets an app-only token, then reads the listing with it', async () => {
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ url, opts });
    return url.includes('access_token') ? ok({ access_token: 'tok' }) : ok(fixture);
  };
  const jobs = await fetchReddit(KEYS, fetchFn);
  assert.equal(jobs.length, 2);
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers.Authorization, `Basic ${Buffer.from('id:secret').toString('base64')}`);
  assert.equal(calls[0].opts.body, 'grant_type=client_credentials');
  assert.match(calls[1].url, /^https:\/\/oauth\.reddit\.com\/r\/forhire\+freelance_forhire\+jobbit\/new/);
  assert.equal(calls[1].opts.headers.Authorization, 'Bearer tok');
});

test('Reddit: a failed token call is an error without the reply body', async () => {
  const fetchFn = async () => ({ ok: false, status: 401, json: async () => ({ secret: 'x' }), text: async () => 'x' });
  await assert.rejects(fetchReddit(KEYS, fetchFn), /^Error: token HTTP 401$/);
});

test('fetchAll: Reddit runs only when both keys are set', async () => {
  const seen = [];
  const fetchFn = async (url) => {
    seen.push(url);
    if (url.includes('access_token')) return ok({ access_token: 'tok' });
    if (url.includes('oauth.reddit.com')) return ok(fixture);
    return { ok: false, status: 500, json: async () => ({}), text: async () => '' };
  };
  const off = await fetchAll({ freelancerQueries: [] }, fetchFn, 1794300000, {}, { REDDIT_CLIENT_ID: 'id' });
  assert.ok(!off.okSources.includes('reddit'));
  assert.ok(!seen.some((u) => u.includes('reddit.com')));
  const on = await fetchAll({ freelancerQueries: [] }, fetchFn, 1794300000, {}, KEYS);
  assert.ok(on.okSources.includes('reddit'));
  assert.equal(on.jobs.filter((j) => j.source === 'reddit').length, 2);
});

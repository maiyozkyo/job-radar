import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { onTap } from '../worker/index.js';
import { authorized, bidsJson, logBid, mergeBids } from '../src/bidlog.js';
import { bidStatus } from '../src/mybids.js';

const kv = (init = {}) => {
  const data = { ...init };
  return {
    data,
    get: async (k) => data[k] ?? null,
    put: async (k, v) => { data[k] = v; },
    list: async ({ prefix }) => ({ keys: Object.keys(data).filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
  };
};

const proposal = 'Hi, I can fix your Angular charts today.';
const message = {
  message_id: 5, chat: { id: 42 },
  text: `[freelancer] Angular dashboard fix\nhttps://www.freelancer.com/projects/angular/fix-1\n\n✍️ Proposal:\n${proposal}`,
};
message.entities = [{ type: 'pre', offset: message.text.length - proposal.length, length: proposal.length }];
const tap = (data) => ({ id: 'cq1', from: { id: 42 }, data, message });

test('a placed bid is logged in KV; a failed one is not', async () => {
  const env = { TELEGRAM_CHAT_ID: '42', TELEGRAM_BOT_TOKEN: 'TG', FREELANCER_TOKEN: 'FL', RADAR_KV: kv() };
  const mk = (ok) => async (url) => {
    if (url.startsWith('https://api.telegram.org/')) return { ok: true, status: 200 };
    if (url.endsWith('/users/0.1/self/')) return { ok: true, status: 200, json: async () => ({ result: { id: 77 } }) };
    return ok
      ? { ok: true, status: 200, json: async () => ({ status: 'success', result: { id: 999 } }) }
      : { ok: false, status: 400, json: async () => ({ message: 'no' }) };
  };
  await onTap(tap('b:1:45:2:100'), env, mk(false));
  assert.deepEqual(Object.keys(env.RADAR_KV.data), []);
  await onTap(tap('b:1:45:2:100'), env, mk(true));
  const rec = JSON.parse(env.RADAR_KV.data['bidlog:999']);
  assert.equal(rec.bidId, 999);
  assert.equal(rec.projectId, 1);
  assert.equal(rec.amount, 45);
  assert.equal(rec.period, 2);
  assert.equal(rec.url, 'https://www.freelancer.com/projects/angular/fix-1');
  assert.match(rec.title, /Angular dashboard fix/);
  assert.ok(!Number.isNaN(Date.parse(rec.placedAt)));
});

test('a KV failure while logging never breaks the bid', async () => {
  const bad = { put: async () => { throw new Error('kv down'); } };
  assert.equal(await logBid(bad, { bidId: 1, projectId: 2 }), false);
  assert.equal(await logBid(kv(), { bidId: null }), false);
});

const liveFetch = (bids, projects) => async (url) => {
  if (url.endsWith('/users/0.1/self/')) return { ok: true, status: 200, json: async () => ({ result: { id: 77 } }) };
  if (url.includes('/bids/')) return { ok: true, status: 200, json: async () => ({ result: { bids } }) };
  return { ok: true, status: 200, json: async () => ({ result: { projects } }) };
};

test('/bids.json: no key configured, wrong key or missing header is 401, no CORS', async () => {
  const env = { RADAR_KV: kv(), FREELANCER_TOKEN: 'FL', BIDS_READ_KEY: 'secret-key' };
  const get = (headers, e = env) => worker.fetch(new Request('https://w.example/bids.json', { headers }), e);
  for (const r of [await get({}), await get({ Authorization: 'Bearer nope' }), await get({ Authorization: 'secret-key' }), await get({ Authorization: 'Bearer secret-key' }, { ...env, BIDS_READ_KEY: undefined })]) {
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
  }
  assert.ok(authorized(new Request('https://x', { headers: { Authorization: 'Bearer k' } }), 'k'));
  assert.ok(!authorized(new Request('https://x', { headers: { Authorization: 'Bearer kk' } }), 'k'));
});

test('/bids.json with the key: live API bids merged with the KV log, old bids included', async () => {
  const logged = { bidId: 5, projectId: 50, title: 'Logged only', url: 'https://www.freelancer.com/projects/50', amount: 30, period: 3, placedAt: '2026-11-20T01:00:00.000Z' };
  const env = { RADAR_KV: kv({ 'bidlog:5': JSON.stringify(logged), 'bidlog:10': JSON.stringify({ bidId: 10, projectId: 100, title: 'from alert', amount: 45, period: 2, placedAt: '2026-11-27T01:00:00.000Z' }), other: 'x' }), FREELANCER_TOKEN: 'FL', BIDS_READ_KEY: 'k' };
  const bids = [
    { id: 10, project_id: 100, amount: 45, period: 2, time_submitted: 1795000000, award_status: 'awarded' },
    { id: 7, project_id: 70, amount: 20, period: 1, time_submitted: 1794000000 },
  ];
  const projects = [
    { id: 100, title: 'Angular dashboard fix', seo_url: 'angular/fix-100', status: 'active', currency: { code: 'USD' } },
    { id: 70, title: 'Old job', seo_url: 'x/old-70', status: 'closed', currency: { code: 'USD' } },
  ];
  const out = await (await bidsJson(new Request('https://w.example/bids.json', { headers: { Authorization: 'Bearer k' } }), env, liveFetch(bids, projects))).json();
  const byId = Object.fromEntries(out.bids.map((b) => [b.bidId, b]));
  assert.equal(out.bids.length, 3);
  assert.equal(byId[10].status, 'awarded');
  assert.equal(byId[10].title, 'Angular dashboard fix');
  assert.equal(byId[10].url, 'https://www.freelancer.com/projects/angular/fix-100');
  assert.equal(byId[7].status, 'lost');
  assert.equal(byId[5].status, 'sent');
  assert.equal(byId[5].title, 'Logged only');
  assert.ok(out.bids[0].placedAt >= out.bids[1].placedAt);
});

test('API failure still serves the KV log and says so, without the token', async () => {
  const env = { RADAR_KV: kv({ 'bidlog:5': JSON.stringify({ bidId: 5, projectId: 50, title: 'T', placedAt: '2026-11-20T01:00:00.000Z' }) }), FREELANCER_TOKEN: 'FL', BIDS_READ_KEY: 'k' };
  const res = await bidsJson(new Request('https://w.example/bids.json', { headers: { Authorization: 'Bearer k' } }), env, async () => ({ ok: false, status: 500, json: async () => ({}) }));
  const out = await res.json();
  assert.equal(out.bids.length, 1);
  assert.match(out.liveError, /HTTP 500/);
  assert.ok(!JSON.stringify(out).includes('FL"'));
});

test('merge keeps logged-only bids and prefers live data', () => {
  const m = mergeBids([{ bidId: 1, title: 'live', status: 'lost', placedAt: '2026-11-02T00:00:00Z' }], [{ bidId: 1, title: 'old', placedAt: '2026-11-01T00:00:00Z' }, { bidId: 2, title: 'only', placedAt: '2026-11-03T00:00:00Z' }]);
  assert.deepEqual(m.map((b) => [b.bidId, b.title, b.status]), [[2, 'only', 'sent'], [1, 'live', 'lost']]);
});

test('bid status mapping', () => {
  assert.equal(bidStatus({ award_status: 'awarded' }, {}), 'awarded');
  assert.equal(bidStatus({ award_status: 'rejected' }, { status: 'active' }), 'lost');
  assert.equal(bidStatus({ retracted: true }, {}), 'lost');
  assert.equal(bidStatus({}, { status: 'closed' }), 'lost');
  assert.equal(bidStatus({ shortlisted: true }, { status: 'active', frontend_project_status: 'open' }), 'sent');
  assert.equal(bidStatus({}, { status: 'active', frontend_project_status: 'work_in_progress' }), 'lost');
});

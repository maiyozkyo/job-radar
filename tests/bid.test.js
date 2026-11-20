import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bidCallback, skipCallback, parseCallback, extractProposal, placeBid, BidError } from '../src/bid.js';

test('callback data round-trips and stays under 64 bytes', () => {
  const data = bidCallback(40816417, { amount: 100000, days: 30, milestonePct: 40 });
  assert.ok(Buffer.byteLength(data) <= 64);
  assert.deepEqual(parseCallback(data), { action: 'bid', projectId: 40816417, amount: 100000, days: 30, milestonePct: 40 });
  assert.deepEqual(parseCallback(bidCallback(1, { amount: '15.50', days: 2, milestonePct: 100 })), { action: 'bid', projectId: 1, amount: 15.5, days: 2, milestonePct: 100 });
  assert.deepEqual(parseCallback(skipCallback(40816417)), { action: 'skip', projectId: 40816417 });
});

test('malformed or out-of-range callback data is ignored', () => {
  for (const bad of [undefined, '', 'b:1:2:3', 'b:x:1:1:100', 'b:1:-5:1:100', 'b:1:0:1:100', 'b:1:5:0:100', 'b:1:5:1:0', 'b:1:5:1:101', 'b:1:5.123:1:100', 'noop', 'x:1;rm']) {
    assert.equal(parseCallback(bad), null, String(bad));
  }
});

test('proposal is read from the first pre block, by UTF-16 offsets', () => {
  const head = '⭐ 8/10 – Hợp 🎯\n\n';
  const text = `${head}Hi, I fix Angular 🚀 charts.\nThanks`;
  const message = { text, entities: [{ type: 'bold', offset: 0, length: 2 }, { type: 'pre', offset: head.length, length: text.length - head.length }] };
  assert.equal(extractProposal(message), 'Hi, I fix Angular 🚀 charts.\nThanks');
  assert.equal(extractProposal({ text, entities: [] }), null);
  assert.equal(extractProposal(undefined), null);
});

const json = (status, body) => ({ ok: status < 400, status, json: async () => body });

test('placeBid reads the bidder id, then posts the bid', async () => {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/users/0.1/self/')) return json(200, { status: 'success', result: { id: 77 } });
    return json(200, { status: 'success', result: { id: 999 } });
  };
  const res = await placeBid({ projectId: 555, amount: 120, days: 3, milestonePct: 40, description: 'Hi' }, 'TOKEN', fetchFn);
  assert.deepEqual(res, { bidId: 999 });
  assert.equal(calls[0].init.headers['freelancer-oauth-v1'], 'TOKEN');
  assert.equal(calls[1].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].init.body), { project_id: 555, bidder_id: 77, amount: 120, period: 3, milestone_percentage: 40, description: 'Hi' });
});

test('placeBid reports Freelancer errors without the token', async () => {
  const fetchFn = async (url) => (url.endsWith('/self/')
    ? json(200, { result: { id: 77 } })
    : json(409, { status: 'error', message: 'You have already bid on this project' }));
  await assert.rejects(
    placeBid({ projectId: 1, amount: 1, days: 1, milestonePct: 100, description: 'x' }, 'SECRET', fetchFn),
    (err) => err instanceof BidError && /already bid/.test(err.message) && /409/.test(err.message) && !/SECRET/.test(err.message),
  );
});

test('placeBid fails clearly on a bad token or no token', async () => {
  await assert.rejects(placeBid({ projectId: 1 }, '', async () => json(200, {})), /thiếu FREELANCER_TOKEN/);
  await assert.rejects(placeBid({ projectId: 1 }, 'T', async () => json(401, { message: 'Invalid token' })), /Invalid token/);
  await assert.rejects(placeBid({ projectId: 1 }, 'T', async () => json(200, { result: {} })), /ID tài khoản/);
});

import { checkCallback } from '../src/bid.js';

test('the 🔄 recheck callback round-trips', () => {
  assert.deepEqual(parseCallback(checkCallback(40816417)), { action: 'check', projectId: 40816417 });
  assert.equal(parseCallback('c:abc'), null);
});

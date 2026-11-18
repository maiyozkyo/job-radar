import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { cleanEnv, fastPoll, onTap } from '../worker/index.js';

const NOW = 1794300000;
const kv = (init = {}) => {
  const data = { ...init };
  return { data, get: async (k) => data[k] ?? null, put: async (k, v) => { data[k] = v; } };
};
const project = (id, ago) => ({
  id, title: 'Angular dashboard fix', seo_url: `angular/fix-${id}`, type: 'fixed',
  budget: { minimum: 30, maximum: 100 }, currency: { code: 'USD', exchange_rate: 1 },
  preview_description: 'Fix charts', bid_stats: { bid_count: 1 }, time_submitted: NOW - ago, jobs: [{ name: 'Angular' }],
});

function pollFetch(projects, dispatchStatus = 204) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.includes('api.github.com')) return { ok: dispatchStatus < 300, status: dispatchStatus };
    return { ok: true, status: 200, json: async () => ({ result: { projects } }) };
  };
  return { calls, fetchFn };
}
const env = (extra = {}) => ({ RADAR_KV: kv(), GH_REPO: 'me/job-radar', GH_DISPATCH_TOKEN: 'GH', ...extra });
const dispatches = (calls) => calls.filter((c) => c.url.includes('api.github.com'));

test('a new matching project starts the radar workflow once', async () => {
  const e = env();
  const { calls, fetchFn } = pollFetch([project(1, 60)]);
  assert.equal(await fastPoll(e, fetchFn, NOW), 1);
  const [d] = dispatches(calls);
  assert.match(d.url, /repos\/me\/job-radar\/actions\/workflows\/radar\.yml\/dispatches$/);
  assert.equal(d.init.headers.Authorization, 'Bearer GH');
  assert.deepEqual(JSON.parse(d.init.body), { ref: 'main', inputs: { mode: 'poll' } });

  assert.equal(await fastPoll(e, fetchFn, NOW + 60), 0);
  assert.equal(dispatches(calls).length, 1);
});

test('nothing new: no dispatch and no KV write', async () => {
  const e = env();
  const { calls, fetchFn } = pollFetch([project(1, 3600)]);
  assert.equal(await fastPoll(e, fetchFn, NOW), 0);
  assert.equal(dispatches(calls).length, 0);
  assert.deepEqual(e.RADAR_KV.data, {});
});

test('a failed dispatch is not remembered, so the next minute retries', async () => {
  const e = env();
  await assert.rejects(fastPoll(e, pollFetch([project(1, 60)], 401).fetchFn, NOW), /HTTP 401/);
  assert.deepEqual(e.RADAR_KV.data, {});
});

// --- Telegram taps ---

const proposal = 'Hi, I can fix your Angular charts today.';
const message = {
  message_id: 5, chat: { id: 42 },
  text: `[freelancer] x\nhttps://www.freelancer.com/projects/angular/fix-1\n\n✍️ Proposal:\n${proposal}`,
};
message.entities = [{ type: 'pre', offset: message.text.length - proposal.length, length: proposal.length }];
const tap = (data, from = 42) => ({ id: 'cq1', from: { id: from }, data, message });
const tapEnv = { TELEGRAM_CHAT_ID: '42', TELEGRAM_BOT_TOKEN: 'TG', FREELANCER_TOKEN: 'FL' };

function tapFetch({ bidStatus = 200, bidBody = { status: 'success', result: { id: 999 } } } = {}) {
  const tg = [];
  const bids = [];
  const order = [];
  const fetchFn = async (url, init = {}) => {
    if (url.startsWith('https://api.telegram.org/')) {
      const method = url.split('/').pop();
      order.push(method);
      tg.push({ method, body: JSON.parse(init.body) });
      return { ok: true, status: 200 };
    }
    if (url.endsWith('/users/0.1/self/')) return { ok: true, status: 200, json: async () => ({ result: { id: 77 } }) };
    order.push('bid');
    bids.push(JSON.parse(init.body));
    return { ok: bidStatus < 400, status: bidStatus, json: async () => bidBody };
  };
  return { tg, bids, order, fetchFn };
}
const lastButton = (tg) => tg.filter((c) => c.method === 'editMessageReplyMarkup').at(-1).body.reply_markup.inline_keyboard[0][0];

test('tapping ✅ places the bid with the proposal from the message', async () => {
  const { tg, bids, fetchFn } = tapFetch();
  await onTap(tap('b:1:45:2:100'), tapEnv, fetchFn);
  assert.deepEqual(bids, [{ project_id: 1, bidder_id: 77, amount: 45, period: 2, milestone_percentage: 100, description: proposal }]);
  assert.equal(lastButton(tg).text, '✅ Đã bid #999 · mở job');
  assert.equal(lastButton(tg).url, 'https://www.freelancer.com/projects/angular/fix-1');
});

test('the buttons are swapped out before the bid goes out', async () => {
  const { order, fetchFn } = tapFetch();
  await onTap(tap('b:1:45:2:100'), tapEnv, fetchFn);
  assert.ok(order.indexOf('editMessageReplyMarkup') < order.indexOf('bid'));
});

test('a failed bid says so and keeps a link to bid by hand', async () => {
  const { tg, fetchFn } = tapFetch({ bidStatus: 409, bidBody: { status: 'error', message: 'You have already bid' } });
  await onTap(tap('b:1:45:2:100'), tapEnv, fetchFn);
  assert.equal(lastButton(tg).text, '⚠️ Bid lỗi · mở job để bid tay');
  const reply = tg.find((c) => c.method === 'sendMessage');
  assert.match(reply.body.text, /already bid/);
  assert.doesNotMatch(reply.body.text, /FL/);
});

test('❌ removes the buttons and bids nothing', async () => {
  const { tg, bids, fetchFn } = tapFetch();
  await onTap(tap('x:1'), tapEnv, fetchFn);
  assert.equal(bids.length, 0);
  assert.equal(lastButton(tg).text, '❌ Đã bỏ qua');
});

test('a tap from anyone else bids nothing', async () => {
  const { tg, bids, fetchFn } = tapFetch();
  await onTap(tap('b:1:45:2:100', 999), tapEnv, fetchFn);
  assert.equal(bids.length, 0);
  assert.deepEqual(tg.map((c) => c.method), ['answerCallbackQuery']);
});

test('webhook rejects requests without the secret header', async () => {
  const req = (headers) => new Request('https://w.example/telegram', { method: 'POST', headers, body: '{}' });
  const secret = { TG_WEBHOOK_SECRET: 's' };
  assert.equal((await worker.fetch(req({}), secret)).status, 403);
  assert.equal((await worker.fetch(req({ 'X-Telegram-Bot-Api-Secret-Token': 'wrong' }), secret)).status, 403);
  assert.equal((await worker.fetch(req({ 'X-Telegram-Bot-Api-Secret-Token': 's' }), secret)).status, 200);
  assert.equal((await worker.fetch(req({}), {})).status, 403);
  assert.equal((await worker.fetch(new Request('https://w.example/other'), secret)).status, 404);
});

test('secrets are trimmed, and one with a stray character is named', async () => {
  const env = { GH_DISPATCH_TOKEN: 'github_pat_X\r\n', GH_REPO: ' me/job-radar ', RADAR_KV: { get: () => null } };
  const clean = cleanEnv(env);
  assert.equal(clean.GH_DISPATCH_TOKEN, 'github_pat_X');
  assert.equal(clean.GH_REPO, 'me/job-radar');
  assert.equal(clean.RADAR_KV, env.RADAR_KV);
  assert.throws(() => cleanEnv({ GH_DISPATCH_TOKEN: 'github​pat' }), /GH_DISPATCH_TOKEN có ký tự lạ \(độ dài 10\)/);
});

test('the webhook accepts a secret saved with a trailing newline', async () => {
  const req = new Request('https://w.example/telegram', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 's' }, body: '{}' });
  assert.equal((await worker.fetch(req, { TG_WEBHOOK_SECRET: 's\n' })).status, 200);
});

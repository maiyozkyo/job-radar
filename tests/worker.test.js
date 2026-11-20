import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { cleanEnv, fastPoll, onMessage, onTap } from '../worker/index.js';

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

function tapFetch({ bidStatus = 200, bidBody = { status: 'success', result: { id: 999 } }, deleteOk = true } = {}) {
  const tg = [];
  const bids = [];
  const order = [];
  const fetchFn = async (url, init = {}) => {
    if (url.startsWith('https://api.telegram.org/')) {
      const method = url.split('/').pop();
      order.push(method);
      tg.push({ method, body: JSON.parse(init.body) });
      if (method === 'deleteMessage' && !deleteOk) return { ok: false, status: 400 };
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
  const rows = tg.filter((c) => c.method === 'editMessageReplyMarkup').at(-1).body.reply_markup.inline_keyboard;
  assert.equal(rows[1][0].text, '⚠️ Bid lỗi · mở job để bid tay');
  assert.equal(rows[1][0].url, 'https://www.freelancer.com/projects/angular/fix-1');
  const reply = tg.find((c) => c.method === 'sendMessage');
  assert.match(reply.body.text, /already bid/);
  assert.doesNotMatch(reply.body.text, /FL/);
});

test('a failed bid offers 🔄 with the same bid and ❌, and tapping 🔄 bids again', async () => {
  const failed = tapFetch({ bidStatus: 500, bidBody: { status: 'error', message: 'Internal error' } });
  await onTap(tap('b:1:45:2:100'), tapEnv, failed.fetchFn);
  const [retry, skip] = failed.tg.filter((c) => c.method === 'editMessageReplyMarkup').at(-1).body.reply_markup.inline_keyboard[0];
  assert.deepEqual(retry, { text: '🔄 Thử lại', callback_data: 'b:1:45:2:100' });
  assert.deepEqual(skip, { text: '❌ Bỏ', callback_data: 'x:1' });

  const ok = tapFetch();
  await onTap(tap(retry.callback_data), tapEnv, ok.fetchFn);
  assert.equal(ok.bids.length, 1);
  assert.equal(lastButton(ok.tg).text, '✅ Đã bid #999 · mở job');
});

test('❌ deletes the alert and bids nothing', async () => {
  const { tg, bids, fetchFn } = tapFetch();
  await onTap(tap('x:1'), tapEnv, fetchFn);
  assert.equal(bids.length, 0);
  const del = tg.find((c) => c.method === 'deleteMessage');
  assert.deepEqual(del.body, { chat_id: 42, message_id: 5 });
  assert.equal(tg.some((c) => c.method === 'editMessageReplyMarkup'), false);
});

test('❌ on an alert Telegram will not delete (older than 48 h) falls back to removing the buttons', async () => {
  const { tg, bids, fetchFn } = tapFetch({ deleteOk: false });
  await onTap(tap('x:1'), tapEnv, fetchFn);
  assert.equal(bids.length, 0);
  assert.equal(lastButton(tg).text, '❌ Đã bỏ qua');
});

test('the job link is read from the hyperlink when the alert shows "🔗 Mở job"', async () => {
  const { tg, fetchFn } = tapFetch();
  const text = `[freelancer] x
🔗 Mở job

✍️ Proposal:
${proposal}`;
  const linked = {
    message_id: 5, chat: { id: 42 }, text,
    entities: [
      { type: 'text_link', offset: text.indexOf('🔗'), length: 9, url: 'https://www.freelancer.com/projects/angular/fix-1' },
      { type: 'pre', offset: text.length - proposal.length, length: proposal.length },
    ],
  };
  await onTap({ id: 'cq1', from: { id: 42 }, data: 'b:1:45:2:100', message: linked }, tapEnv, fetchFn);
  assert.equal(lastButton(tg).url, 'https://www.freelancer.com/projects/angular/fix-1');
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

// --- messages: links, pasted jobs, chat ---

const owner = { id: 42 };
const msgEnv = () => ({ TELEGRAM_CHAT_ID: '42', TELEGRAM_BOT_TOKEN: 'TG', GH_REPO: 'me/job-radar', GH_DISPATCH_TOKEN: 'GH', PASTE_TOKEN: 'P', RADAR_KV: kv() });
function msgFetch() {
  const markups = [];
  const sent = [];
  const dispatched = [];
  const fetchFn = async (url, init = {}) => {
    if (url.includes('api.github.com')) { dispatched.push(JSON.parse(init.body).inputs); return { ok: true, status: 204 }; }
    const body = JSON.parse(init.body);
    sent.push(body.text);
    markups.push(body.reply_markup);
    return { ok: true, status: 200 };
  };
  return { sent, dispatched, markups, fetchFn };
}
const post = 'Upwork job: Fix our Angular 17 dashboard charts. They break after the last update. Budget $150, need it in 2 days.';

test('a pasted job is kept in KV and job mode gets only its key', async () => {
  const env = msgEnv();
  const { sent, dispatched, fetchFn } = msgFetch();
  await onMessage({ message_id: 1, chat: { id: 42 }, from: owner, text: post }, env, fetchFn);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].mode, 'job');
  const [, key] = dispatched[0].job.match(/^paste:([0-9a-f-]{36})$/);
  assert.equal(env.RADAR_KV.data[`paste:${key}`], post);
  assert.match(sent[0], /Đại ca chờ em/);
});

test('replies remove a leftover reply keyboard (the desk bot once shared this token)', async () => {
  const { markups, fetchFn } = msgFetch();
  await onMessage({ message_id: 1, chat: { id: 42 }, from: owner, text: post }, msgEnv(), fetchFn);
  await onMessage({ message_id: 2, chat: { id: 42 }, from: owner, text: '/start' }, msgEnv(), fetchFn);
  assert.deepEqual(markups, [{ remove_keyboard: true }, { remove_keyboard: true }]);
});

test('a Freelancer link goes to job mode as is', async () => {
  const { dispatched, fetchFn } = msgFetch();
  const link = 'https://www.freelancer.com/projects/excel-vba/Excel-Cleanup';
  await onMessage({ message_id: 1, chat: { id: 42 }, from: owner, text: link }, msgEnv(), fetchFn);
  assert.deepEqual(dispatched, [{ mode: 'job', job: link }]);
});

test('a Freelancer link with a note around it still goes to job mode as a link', async () => {
  const { sent, dispatched, fetchFn } = msgFetch();
  const link = 'https://www.freelancer.com/projects/excel-vba/Excel-Cleanup';
  await onMessage({ message_id: 1, chat: { id: 42 }, from: owner, text: `Job này ổn không?
${link}` }, msgEnv(), fetchFn);
  assert.deepEqual(dispatched, [{ mode: 'job', job: link }]);
  assert.match(sent[0], /Đại ca chờ em/);
});

test('short chat goes to job mode as a paste for Claude to answer', async () => {
  const env = msgEnv();
  const { sent, dispatched, fetchFn } = msgFetch();
  await onMessage({ message_id: 1, chat: { id: 42 }, from: owner, text: 'hi, hôm nay có job nào hay không?' }, env, fetchFn);
  const [, key] = dispatched[0].job.match(/^paste:([0-9a-f-]{36})$/);
  assert.equal(env.RADAR_KV.data[`paste:${key}`], 'hi, hôm nay có job nào hay không?');
  assert.match(sent[0], /Đại ca chờ em/);
});

test('commands get help; strangers are ignored', async () => {
  const { sent, dispatched, fetchFn } = msgFetch();
  await onMessage({ message_id: 2, chat: { id: 42 }, from: owner, text: '/start' }, msgEnv(), fetchFn);
  await onMessage({ message_id: 3, chat: { id: 7 }, from: { id: 7 }, text: post }, msgEnv(), fetchFn);
  assert.equal(dispatched.length, 0);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /link job Freelancer/);
  assert.match(sent[0], /Đại ca gửi em/);
});

test('/paste/<key> returns the text only with the token', async () => {
  const key = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const env = { PASTE_TOKEN: 'P', RADAR_KV: kv({ [`paste:${key}`]: post }) };
  const get = (auth, k = key) => worker.fetch(new Request(`https://w.example/paste/${k}`, { headers: auth ? { Authorization: auth } : {} }), env);
  assert.equal((await get()).status, 403);
  assert.equal((await get('Bearer wrong')).status, 403);
  const ok = await get('Bearer P');
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), post);
  assert.equal((await get('Bearer P', '1f8fad5b-d9cb-469f-a165-70867728950e')).status, 404);
  assert.equal((await worker.fetch(new Request(`https://w.example/paste/${key}`), { RADAR_KV: env.RADAR_KV })).status, 403);
});


// --- query slices ---

import { querySlice } from '../src/fastpoll.js';

test('querySlice: short lists are checked whole every minute', () => {
  const q = ['a', 'b', 'c'];
  assert.deepEqual(querySlice(q, NOW, 5), q);
});

test('querySlice: long lists rotate in even slices that cover every term', () => {
  const q = Array.from({ length: 51 }, (_, i) => `q${i}`);
  const minute = Math.floor(NOW / 60) * 60;
  const slices = [0, 1, 2, 3].map((m) => querySlice(q, minute + m * 60, 28));
  assert.ok(slices.every((s) => s.length <= 28));
  assert.deepEqual([...slices[0], ...slices[1]].sort(), [...q].sort());
  assert.deepEqual(slices[2], slices[0]);
});

test('fastPoll stays under the free-plan subrequest limit with the real config', async () => {
  const e = env();
  const { calls, fetchFn } = pollFetch([project(1, 3600)]);
  await fastPoll(e, fetchFn, NOW);
  assert.ok(calls.length <= 45, `${calls.length} requests`);
});

function checkFetch(project, users = {}) {
  const tg = [];
  const urls = [];
  const headers = [];
  const fetchFn = async (url, init = {}) => {
    if (url.startsWith('https://api.telegram.org/')) {
      tg.push({ method: url.split('/').pop(), body: JSON.parse(init.body) });
      return { ok: true, status: 200 };
    }
    urls.push(url);
    headers.push(init.headers ?? {});
    if (project === 'down') return { ok: false, status: 503, json: async () => ({}), text: async () => '' };
    if (url.includes('/users/0.1/users/')) return { ok: true, status: 200, json: async () => ({ result: { users } }) };
    return { ok: true, status: 200, json: async () => ({ result: { projects: project ? [project] : [] } }) };
  };
  return { tg, urls, headers, fetchFn };
}

test('🔄 with an owner: the project call carries the token, the client record comes as a reply with its red flags', async () => {
  const now = Date.now() / 1000;
  const users = { 7: { status: { payment_verified: false, deposit_made: true }, registration_date: now - 2 * 86400, employer_reputation: { entire_history: { overall: 0, reviews: 0, complete: 0 } }, location: { country: { name: 'India' } } } };
  const { tg, urls, headers, fetchFn } = checkFetch({ id: 1, owner_id: 7, status: 'active', frontend_project_status: 'open', bid_stats: { bid_count: 3 } }, users);
  await onTap(tap('c:1'), tapEnv, fetchFn);
  assert.equal(headers[0]['freelancer-oauth-v1'], 'FL');
  assert.match(urls[1], /users\[\]=7/);
  assert.equal(headers[1]['freelancer-oauth-v1'], undefined, 'the users call needs no token');
  assert.match(tg.find((c) => c.method === 'answerCallbackQuery').body.text, /✅ Job còn mở · 3 bid\n🚩 2 cờ đỏ/);
  const reply = tg.find((c) => c.method === 'sendMessage').body;
  assert.equal(reply.reply_to_message_id, 5);
  assert.match(reply.text, /👤 Khách: tài khoản 2 ngày · India/);
  assert.match(reply.text, /🚩 Chưa xác minh thanh toán/);
  assert.match(reply.text, /🚩 Tài khoản mới tạo 2 ngày/);
  assert.doesNotMatch(reply.text, /FL/);
});

test('🔄 on an open job shows its bid count and bids nothing', async () => {
  const { tg, urls, fetchFn } = checkFetch({ id: 1, status: 'active', frontend_project_status: 'open', bid_stats: { bid_count: 12 } });
  await onTap(tap('c:1'), tapEnv, fetchFn);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /projects\[\]=1/);
  const ans = tg.find((c) => c.method === 'answerCallbackQuery').body;
  assert.equal(ans.text, '✅ Job còn mở · 12 bid');
  assert.equal(ans.show_alert, true);
  assert.equal(tg.some((c) => c.method === 'editMessageReplyMarkup'), false);
});

test('🔄 on a closed job says so and swaps ✅ for the link', async () => {
  const { tg, fetchFn } = checkFetch({ id: 1, status: 'closed', frontend_project_status: 'work', bid_stats: { bid_count: 40 } });
  await onTap(tap('c:1'), tapEnv, fetchFn);
  assert.match(tg.find((c) => c.method === 'answerCallbackQuery').body.text, /đã đóng/);
  assert.equal(lastButton(tg).text, '🔒 Job đã đóng · mở job');
  assert.equal(lastButton(tg).url, 'https://www.freelancer.com/projects/angular/fix-1');
});

test('🔄 when Freelancer is down asks to try later and leaves the buttons', async () => {
  const { tg, fetchFn } = checkFetch('down');
  await onTap(tap('c:1'), tapEnv, fetchFn);
  assert.match(tg.find((c) => c.method === 'answerCallbackQuery').body.text, /thử lại sau/);
  assert.equal(tg.some((c) => c.method === 'editMessageReplyMarkup'), false);
});

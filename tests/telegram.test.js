import { test } from 'node:test';
import assert from 'node:assert/strict';
import { competitionLine, formatAlert, formatAlertHtml, formatDigest, formatUnscored, sendMessage, splitMessage } from '../src/telegram.js';
import { makeJob } from '../src/job.js';

const job = makeJob({
  source: 'freelancer', id: 1, title: 'Angular dashboard fix', url: 'https://www.freelancer.com/projects/x',
  budgetType: 'fixed', budgetMinUsd: 30, budgetMaxUsd: 50,
});
const scored = { key: job.key, score: 8, reasonVi: 'Đúng stack Angular', proposalEn: 'Hi, I can fix your charts today.' };

test('alert shows budget, net after fees, score, url and proposal', () => {
  const text = formatAlert(job, scored);
  assert.match(text, /\[freelancer\] Angular dashboard fix/);
  assert.match(text, /\$30–\$50/);
  assert.match(text, /≈ nhận \$45/);
  assert.match(text, /⭐ 8\/10 – Đúng stack Angular/);
  assert.match(text, /https:\/\/www\.freelancer\.com\/projects\/x/);
  assert.match(text, /I can fix your charts today/);
});

test('unscored alert carries the warning and no score', () => {
  const text = formatAlert(job, null, 'Claude lỗi');
  assert.match(text, /⚠️ Claude lỗi/);
  assert.doesNotMatch(text, /⭐/);
});

test('hourly budget shows /h', () => {
  const text = formatAlert({ ...job, budgetType: 'hourly', budgetMinUsd: 15, budgetMaxUsd: 25 }, null);
  assert.match(text, /\$15–\$25\/h/);
});

test('digest lists items and is null when empty', () => {
  assert.equal(formatDigest([]), null);
  const board = makeJob({ source: 'wwr', id: 'a', title: 'Contract Angular dev', url: 'https://wwr/a' });
  const text = formatDigest([{ job: board, scored: { ...scored, key: board.key, score: 9 } }]);
  assert.match(text, /📋 Tổng hợp job remote \(1\)/);
  assert.match(text, /Contract Angular dev/);
  assert.match(text, /⭐ 9\/10/);
});

test('long text splits on lines under the limit', () => {
  const line = 'x'.repeat(99);
  const text = Array(90).fill(line).join('\n'); // 8,999 chars
  const parts = splitMessage(text);
  assert.equal(parts.length, 3);
  assert.ok(parts.every((p) => p.length <= 4096));
  assert.equal(parts.join('\n'), text);
});

test('sendMessage posts plain text and hides the token on error', async () => {
  const calls = [];
  const env = { TELEGRAM_BOT_TOKEN: '123:SECRET', TELEGRAM_CHAT_ID: '42' };
  await sendMessage('hi', env, async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, text: async () => '' };
  }, async () => {});
  assert.match(calls[0].url, /bot123:SECRET\/sendMessage$/);
  assert.equal(calls[0].body.chat_id, '42');
  assert.equal(calls[0].body.text, 'hi');
  assert.equal('parse_mode' in calls[0].body, false);

  await assert.rejects(
    sendMessage('hi', env, async () => ({ ok: false, status: 401, text: async () => 'Unauthorized' }), async () => {}),
    (err) => /401/.test(err.message) && !err.message.includes('SECRET'),
  );
});

test('a 429 waits retry_after and retries once', async () => {
  const env = { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1' };
  const waits = [];
  let calls = 0;
  await sendMessage('hi', env, async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 429, json: async () => ({ parameters: { retry_after: 3 } }), text: async () => '' };
    return { ok: true, status: 200, text: async () => '' };
  }, async (ms) => { waits.push(ms); });
  assert.equal(calls, 2);
  assert.ok(waits.includes(3000));
});

test('sends are paced', async () => {
  const env = { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1' };
  const waits = [];
  await sendMessage('x'.repeat(5000), env, async () => ({ ok: true, status: 200, text: async () => '' }), async (ms) => { waits.push(ms); });
  assert.ok(waits.length >= 2 && waits.every((ms) => ms >= 1000));
});

test('unscored jobs are grouped into one message', () => {
  const jobsList = [job, { ...job, key: 'freelancer:2', title: 'Second job', url: 'https://f/2' }];
  const text = formatUnscored(jobsList, 'Claude lỗi');
  assert.match(text, /Angular dashboard fix/);
  assert.match(text, /Second job/);
  assert.match(text, /⚠️ Claude lỗi/);
});

test('alert shows the bid suggestion and warns when the budget is too low', () => {
  const bid = { amountUsd: 120, unit: '', hours: 6, days: 4, netUsd: 108, wantUsd: 120, underpaid: false };
  const text = formatAlert(job, { ...scored, bid });
  assert.match(text, /💵 Gợi ý bid: \$120 · ~6 giờ · giao 4 ngày \(≈ nhận \$108\)/);
  const low = formatAlert(job, { ...scored, bid: { ...bid, amountUsd: 100, wantUsd: 160, underpaid: true, netUsd: 90 } });
  assert.match(low, /⚠️ Việc ~6 giờ đáng ~\$160, ngân sách khách thấp hơn/);
});

test('HTML alert: proposal in a code block, milestones listed, copy buttons, text escaped', () => {
  const bid = { amountUsd: 280, unit: '', hours: 14, days: 5, netUsd: 252, wantUsd: 280, underpaid: false };
  const milestones = [{ name: 'Demo <inbox> & review', amountUsd: 112 }, { name: 'Hand-over', amountUsd: 168 }];
  const m = formatAlertHtml({ ...job, title: 'Fix <b>' }, { ...scored, proposalEn: 'Use a < b & c', bid, milestones });
  assert.equal(m.html, true);
  assert.match(m.text, /Fix &lt;b&gt;/);
  assert.match(m.text, /<pre>Use a &lt; b &amp; c<\/pre>/);
  assert.match(m.text, /1\. Demo &lt;inbox&gt; &amp; review — \$112/);
  assert.deepEqual(m.buttons[0].map((b) => b.callback_data), ['b:1:280:5:40', 'x:1']); // 112 / 280 = 40% upfront
  assert.equal(m.buttons[0][0].text, '✅ Bid $280 · 5 ngày');
  assert.deepEqual(m.buttons[1].map((b) => b.copy_text.text), ['280', '5']);
  assert.deepEqual(m.buttons[2].map((b) => b.copy_text.text), ['Demo <inbox> & review', '112']);
  assert.deepEqual(m.buttons[3].map((b) => b.copy_text.text), ['Hand-over', '168']);
  assert.match(m.plain, /Use a < b & c/);
});

test('sendMessage sends an HTML alert with buttons, or its plain text when too long', async () => {
  const env = { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1' };
  const bodies = [];
  const ok = async (url, init) => { bodies.push(JSON.parse(init.body)); return { ok: true, status: 200, text: async () => '' }; };
  const m = { text: '<pre>hi</pre>', html: true, plain: 'hi', buttons: [[{ text: 'x', copy_text: { text: 'y' } }]] };
  await sendMessage(m, env, ok, async () => {});
  assert.equal(bodies[0].parse_mode, 'HTML');
  assert.deepEqual(bodies[0].reply_markup.inline_keyboard, m.buttons);
  await sendMessage({ ...m, text: 'x'.repeat(5000) }, env, ok, async () => {});
  assert.equal(bodies[1].text, 'hi');
  assert.equal(bodies[1].parse_mode, undefined);
  assert.equal(bodies[1].reply_markup, undefined);
});

import { localBid } from '../src/telegram.js';

const inr = makeJob({
  source: 'freelancer', id: 9, title: 'PDF-Word Conversion', url: 'https://www.freelancer.com/projects/x',
  budgetType: 'fixed', budgetMinUsd: 133.8, budgetMaxUsd: 401.4,
  currency: { code: 'INR', sign: '₹', usdRate: 0.010704, min: 12500, max: 37500 },
});

test('non-USD job: bid, milestones and copied amounts are in the project currency', () => {
  const bid = { amountUsd: 150, unit: '', hours: 7, days: 3, netUsd: 135, wantUsd: 140, underpaid: false };
  const milestones = [{ name: 'Demo', amountUsd: 60 }, { name: 'Rest', amountUsd: 90 }];
  const m = formatAlertHtml(inr, { ...scored, key: inr.key, bid, milestones });
  assert.match(m.text, /💰 ₹12,500–₹37,500 \(≈ \$133\.80–\$401\.40 · nhận ≈ \$361\.26\)/);
  assert.match(m.text, /💵 Gợi ý bid: ₹14,000 \(≈ \$150\)/);
  assert.match(m.text, /1\. Demo — ₹5,600\n2\. Rest — ₹8,400/);
  assert.equal(m.buttons[0][0].callback_data, 'b:9:14000:3:40'); // the bid API takes the project currency
  assert.equal(m.buttons[0][0].text, '✅ Bid ₹14,000 · 3 ngày');
  assert.deepEqual(m.buttons[1].map((b) => b.copy_text.text), ['14000', '3']);
  assert.deepEqual(m.buttons[2].map((b) => b.copy_text.text), ['Demo', '5600']);
  assert.deepEqual(m.buttons[3].map((b) => b.copy_text.text), ['Rest', '8400']);
});

test('one-tap bid: one milestone asks 100% upfront; no button without a proposal, a bid, or off Freelancer', () => {
  const bid = { amountUsd: 45, unit: '', hours: 2, days: 1, netUsd: 40, wantUsd: 45, underpaid: false };
  const one = formatAlertHtml(job, { ...scored, bid, milestones: [{ name: 'Fix', amountUsd: 45 }] });
  assert.equal(one.buttons[0][0].callback_data, 'b:1:45:1:100');
  const hourly = formatAlertHtml({ ...job, budgetType: 'hourly' }, { ...scored, bid: { ...bid, amountUsd: 22.5, unit: '/h' }, milestones: [] });
  assert.equal(hourly.buttons[0][0].callback_data, 'b:1:22.50:1:100');
  assert.equal(hourly.buttons[0][0].text, '✅ Bid $22.50/h · 1 ngày');
  const noTap = (m) => !m.buttons.flat().some((b) => b.callback_data);
  assert.ok(noTap(formatAlertHtml(job, { ...scored, proposalEn: null, bid, milestones: [] })));
  assert.ok(noTap(formatAlertHtml(job, { ...scored, bid: null, milestones: [] })));
  assert.ok(noTap(formatAlertHtml({ ...job, source: 'hn' }, { ...scored, bid, milestones: [] })));
});

test('an Escrow.com project says so and has no one-tap bid, only copy buttons', () => {
  const bid = { amountUsd: 45, unit: '', hours: 2, days: 1, netUsd: 40, wantUsd: 45, underpaid: false };
  const m = formatAlertHtml({ ...job, escrow: true }, { ...scored, bid, milestones: [] });
  assert.ok(!m.buttons.flat().some((b) => b.callback_data));
  assert.ok(m.buttons.flat().some((b) => b.copy_text));
  assert.match(m.text, /Escrow\.com/);
  assert.match(formatAlert({ ...job, escrow: true }, scored), /Escrow\.com/);
  assert.doesNotMatch(formatAlertHtml(job, { ...scored, bid, milestones: [] }).text, /Escrow/);
});

test('local bid stays inside the client budget and is null for USD jobs', () => {
  const bid = { amountUsd: 40, unit: '' };
  assert.equal(localBid(inr, bid).amount, 12500); // $40 ≈ ₹3,700, raised to the client minimum
  assert.equal(localBid(inr, { amountUsd: 900, unit: '' }).amount, 37500);
  assert.equal(localBid(job, bid), null);
});

test('competition line: few fresh bids say bid early, many bids say hold', () => {
  const now = 1_800_000_000;
  const fl = (bidCount, minsAgo) => ({ source: 'freelancer', bidCount, postedAt: now - minsAgo * 60 });
  assert.equal(competitionLine(fl(3, 12), now), '👥 3 bid · đăng 12 phút trước · 🔥 ít đối thủ, bid sớm');
  assert.equal(competitionLine(fl(3, 180), now), '👥 3 bid · đăng 3 giờ trước');
  assert.equal(competitionLine(fl(20, 30), now), '👥 20 bid · đăng 30 phút trước · ⏳ đông người bid, cân nhắc giữ lượt');
  assert.equal(competitionLine({ source: 'remoteok', bidCount: null, postedAt: now }, now), null);
});

test('the HTML alert links the job under "🔗 Mở job" instead of printing the long URL', () => {
  const m = formatAlertHtml({ ...job, url: 'https://www.upwork.com/jobs/~01?a=1&b=2' }, null);
  assert.match(m.text, /<a href="https:\/\/www\.upwork\.com\/jobs\/~01\?a=1&amp;b=2">🔗 Mở job<\/a>/);
  assert.doesNotMatch(m.text.replace(/<a href="[^"]*">/g, ''), /upwork\.com/);
  assert.match(m.plain, /https:\/\/www\.upwork\.com\/jobs\/~01/); // the plain fallback keeps the URL
});

test('an hourly bid with no hour estimate leaves out the hours and days instead of printing null', () => {
  const bid = { amountUsd: 15, unit: '/h', hours: null, days: null, netUsd: 13.5, wantUsd: 15, underpaid: false };
  const m = formatAlertHtml({ ...job, budgetType: 'hourly' }, { ...scored, bid, milestones: [] });
  assert.match(m.text, /💵 Gợi ý bid: \$15\/h \(≈ nhận \$13\.50\/h\)/);
  assert.doesNotMatch(m.text + m.plain, /null/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatAlert, formatDigest, formatUnscored, sendMessage, splitMessage } from '../src/telegram.js';
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

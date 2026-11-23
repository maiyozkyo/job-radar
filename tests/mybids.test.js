import test from 'node:test';
import assert from 'node:assert/strict';
import { bidState, fetchMyBids, formatBids, isBidsCommand } from '../src/mybids.js';

test('the bids command: /bids and a few Vietnamese phrasings, nothing else', () => {
  for (const t of ['/bids', '/bids@job_radar_bot', 'bid freelancer', 'Check bid', 'bids']) assert.ok(isBidsCommand(t), t);
  for (const t of ['/start', 'bid this job https://www.freelancer.com/projects/x/y', 'hôm nay có bid nào hay']) assert.ok(!isBidsCommand(t), t);
});

test('bid state: awarded, rejected, retracted, shortlisted, closed, open', () => {
  assert.equal(bidState({ award_status: 'awarded' }, { status: 'active' }), '🏆 Được chọn');
  assert.equal(bidState({ award_status: 'rejected' }, { status: 'active' }), '❌ Bị từ chối');
  assert.equal(bidState({ retracted: true }, { status: 'active' }), '↩️ Đã rút');
  assert.equal(bidState({ shortlisted: true }, { status: 'active', frontend_project_status: 'open' }), '⭐ Vào shortlist');
  assert.equal(bidState({}, { status: 'closed' }), '🔒 Job đóng, không chọn mình');
  assert.equal(bidState({}, { status: 'active', frontend_project_status: 'work_in_progress' }), '🔒 Khách đã chọn người khác');
  assert.equal(bidState({}, { status: 'active', frontend_project_status: 'open' }), '⏳ Đang chờ');
  assert.equal(bidState({}, undefined), '⏳ Đang chờ');
});

function apiFetch({ bids, projects }) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, headers: init.headers });
    const json = url.includes('/users/0.1/self/') ? { status: 'success', result: { id: 99 } }
      : url.includes('/projects/0.1/bids/') ? { status: 'success', result: { bids } }
      : { status: 'success', result: { projects } };
    return { ok: true, status: 200, json: async () => json };
  };
  return { calls, fetchFn };
}

test('fetchMyBids reads my bids with the token, newest first, with each project', async () => {
  const { calls, fetchFn } = apiFetch({
    bids: [
      { id: 1, project_id: 10, amount: 50, time_submitted: 100, award_status: null },
      { id: 2, project_id: 20, amount: 80, time_submitted: 200, award_status: 'awarded' },
    ],
    projects: { 10: { id: 10, title: 'Old job', seo_url: 'a/old', status: 'closed', currency: { code: 'USD' } }, 20: { id: 20, title: 'New job', seo_url: 'b/new', status: 'active', currency: { code: 'AUD' } } },
  });
  const list = await fetchMyBids('TOKEN', fetchFn);
  assert.deepEqual(list.map((b) => b.title), ['New job', 'Old job']);
  assert.equal(list[0].url, 'https://www.freelancer.com/projects/b/new');
  assert.equal(list[0].state, '🏆 Được chọn');
  assert.equal(list[0].price, '80 AUD');
  assert.match(calls[1].url, /bidders\[\]=99/);
  assert.match(calls[2].url, /projects\[\]=20&projects\[\]=10|projects\[\]=10&projects\[\]=20/);
  assert.ok(calls.every((c) => c.headers['freelancer-oauth-v1'] === 'TOKEN'));
});

test('fetchMyBids without a token fails clearly; an API error never shows the token', async () => {
  await assert.rejects(fetchMyBids('', async () => ({})), /FREELANCER_TOKEN/);
  const fetchFn = async () => ({ ok: false, status: 401, json: async () => ({ message: 'bad token' }) });
  await assert.rejects(fetchMyBids('SECRET', fetchFn), (err) => !String(err.message).includes('SECRET') && /401/.test(err.message));
});

test('formatBids: counts up top, one line per bid with a link entity, empty case', () => {
  assert.match(formatBids([]).text, /Chưa có bid nào/);
  const { text, entities } = formatBids([
    { title: 'New job', url: 'https://www.freelancer.com/projects/b/new', state: '🏆 Được chọn', price: '80 AUD', submitted: 1795366472 },
    { title: 'Old job', url: 'https://www.freelancer.com/projects/a/old', state: '⏳ Đang chờ', price: '50 USD', submitted: 1795266472 },
  ]);
  assert.match(text, /2 bid/);
  assert.match(text, /🏆 1/);
  assert.match(text, /New job/);
  assert.equal(entities.length, 2);
  assert.equal(entities[0].type, 'text_link');
  assert.equal(entities[0].url, 'https://www.freelancer.com/projects/b/new');
  assert.equal(text.slice(entities[0].offset, entities[0].offset + entities[0].length), '🔗 Mở');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientCheck } from '../src/client.js';

const NOW = 1795000000;
const YEAR = 365 * 86400;
const solid = { paymentVerified: true, depositMade: true, identityVerified: true, registeredAt: NOW - 3 * YEAR, reviews: 12, rating: 4.9, completed: 15, country: 'United States' };

test('a solid client: summary and no flags', () => {
  const { summary, flags } = clientCheck(solid, NOW);
  assert.equal(summary, '👤 Khách: đã xác minh thanh toán · tài khoản 3 năm · 4.9★ (12) · xong 15 job · United States');
  assert.deepEqual(flags, []);
});

test('each red flag says why', () => {
  const f = (c) => clientCheck({ ...solid, ...c }, NOW).flags.join('\n');
  assert.match(f({ paymentVerified: false }), /🚩 Chưa xác minh thanh toán/);
  assert.match(f({ depositMade: false }), /🚩 Chưa từng nạp tiền/);
  assert.match(f({ registeredAt: NOW - 3 * 86400 }), /🚩 Tài khoản mới tạo 3 ngày/);
  assert.match(f({ rating: 3.2, reviews: 5 }), /🚩 Freelancer khác chấm 3.2\/5 \(5 đánh giá\)/);
  assert.doesNotMatch(f({ rating: 2, reviews: 1 }), /chấm/, 'one review is not a pattern');
  assert.match(f({ reviews: 0, completed: 0, rating: 0 }), /⚠️ Chưa có đánh giá nào/);
});

test('unknown fields are left out, not flagged', () => {
  const { summary, flags } = clientCheck({ paymentVerified: null, depositMade: null, registeredAt: null, reviews: 3, rating: 4.5, completed: 3, country: null }, NOW);
  assert.equal(summary, '👤 Khách: 4.5★ (3) · xong 3 job');
  assert.deepEqual(flags, []);
});

test('clientDropReport sums reasons in Vietnamese, null when nothing was dropped', async () => {
  const { clientDropReport } = await import('../src/client.js');
  assert.equal(clientDropReport({ day: '2026-11-20', reasons: { 'rated below 4': 1, 'payment not verified': 5 } }),
    '🧹 Ngày 2026-11-20: bot loại 6 job Freelancer vì khách (chưa xác minh thanh toán: 5, bị chấm dưới 4★: 1).');
  assert.equal(clientDropReport({ day: '2026-11-20', reasons: {} }), null);
});

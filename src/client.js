// A Freelancer client's account as one summary line and red flags, each with
// its reason. Only facts from the users API; nothing is guessed.

/**
 * @typedef {{ paymentVerified: boolean|null, depositMade: boolean|null, identityVerified: boolean|null,
 *   registeredAt: number|null, reviews: number, rating: number|null, completed: number, country: string|null }} Client
 */

const DAY = 86400;

function age(seconds) {
  const days = Math.floor(seconds / DAY);
  if (days < 31) return `${days} ngày`;
  if (days < 365) return `${Math.floor(days / 30)} tháng`;
  return `${Math.floor(days / 365)} năm`;
}

/** @param {Client} c @returns {{ summary: string, flags: string[] }} */
export function clientCheck(c, now = Date.now() / 1000) {
  const flags = [];
  if (c.paymentVerified === false) flags.push('🚩 Chưa xác minh thanh toán: có thể không trả tiền');
  if (c.depositMade === false) flags.push('🚩 Chưa từng nạp tiền vào tài khoản');
  const days = c.registeredAt ? (now - c.registeredAt) / DAY : null;
  if (days != null && days < 7) flags.push(`🚩 Tài khoản mới tạo ${age(now - c.registeredAt)}`);
  if (c.reviews >= 2 && c.rating != null && c.rating < 4) flags.push(`🚩 Freelancer khác chấm ${c.rating.toFixed(1)}/5 (${c.reviews} đánh giá)`);
  if (!c.reviews && !c.completed) flags.push('⚠️ Chưa có đánh giá nào, chưa xong job nào');

  const parts = [
    c.paymentVerified ? 'đã xác minh thanh toán' : null,
    days != null ? `tài khoản ${age(now - c.registeredAt)}` : null,
    c.reviews ? `${c.rating?.toFixed(1) ?? '?'}★ (${c.reviews})` : null,
    c.completed ? `xong ${c.completed} job` : null,
    c.country,
  ].filter(Boolean);
  return { summary: `👤 Khách: ${parts.join(' · ') || 'không rõ'}`, flags };
}

/** Summary then flags, one per line. */
export const clientLines = (c, now) => { const { summary, flags } = clientCheck(c, now); return [summary, ...flags]; };

/**
 * Why a job is not worth an alert because of its client, or null. Only the
 * clearest junk signs; a new client with no history is kept, since a freelancer
 * without reviews wins those most often. Unverified payment alone is kept too
 * (Freelancer clients often verify only when they award); the alert shows a
 * 🚩 line for it, see UNVERIFIED_PENALTY.
 * @param {Client} c
 */
export function clientDrop(c, now = Date.now() / 1000) {
  const days = c.registeredAt ? (now - c.registeredAt) / DAY : null;
  if (c.depositMade === false && days != null && days < 7) return 'no deposit, new account';
  if (c.reviews >= 2 && c.rating != null && c.rating < 4) return 'rated below 4';
  return null;
}

/**
 * Points taken off a job whose client has not verified payment. 0 since 27/11:
 * about 2/3 of Freelancer clients are unverified (they often verify only when
 * they award) and they posted most of the jobs worth a bid, so one point off
 * hid most alerts. The alert's 🚩 line still says it.
 */
export const UNVERIFIED_PENALTY = 0;

/** The score after the client penalty; the alert's 🚩 line says why. */
export function clientAdjustedScore(score, c) {
  return c?.paymentVerified === false ? Math.max(1, score - UNVERIFIED_PENALTY) : score;
}

const DROP_VI = {
  'payment not verified': 'chưa xác minh thanh toán',
  'no deposit, new account': 'chưa nạp tiền, tài khoản mới',
  'rated below 4': 'bị chấm dưới 4★',
};

/** Yesterday's count of jobs dropped for their client, by reason; null when none. */
export function clientDropReport(drops) {
  const entries = Object.entries(drops?.reasons ?? {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [, n]) => s + n, 0);
  if (!total) return null;
  return `🧹 Ngày ${drops.day}: bot loại ${total} job Freelancer vì khách (${entries.map(([k, n]) => `${DROP_VI[k] ?? k}: ${n}`).join(', ')}).`;
}

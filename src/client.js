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

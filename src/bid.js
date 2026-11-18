// One-tap bids on Freelancer.com. An alert carries a ✅ button whose data holds
// the bid (amount in the project's currency, days, upfront milestone %); the
// bid goes out only when the user taps it (worker/index.js), never from a run.

const API = 'https://www.freelancer.com/api';

export class BidError extends Error {}

// Telegram limits callback_data to 64 bytes; these stay well under.
/** @param {{ amount: number, days: number, milestonePct: number }} bid */
export const bidCallback = (projectId, { amount, days, milestonePct }) => `b:${projectId}:${amount}:${days}:${milestonePct}`;
export const skipCallback = (projectId) => `x:${projectId}`;

/**
 * @returns {{ action: 'bid', projectId: number, amount: number, days: number, milestonePct: number }
 *   | { action: 'skip', projectId: number } | null}
 */
export function parseCallback(data) {
  const bid = /^b:(\d+):(\d+(?:\.\d{1,2})?):(\d+):(\d{1,3})$/.exec(data ?? '');
  if (bid) {
    const [projectId, amount, days, milestonePct] = bid.slice(1).map(Number);
    if (amount > 0 && days >= 1 && milestonePct >= 1 && milestonePct <= 100) return { action: 'bid', projectId, amount, days, milestonePct };
    return null;
  }
  const skip = /^x:(\d+)$/.exec(data ?? '');
  if (skip) return { action: 'skip', projectId: Number(skip[1]) };
  return null;
}

/**
 * The proposal is the message's first <pre> block. Telegram entity offsets
 * count UTF-16 units, the same as JS string indexes.
 */
export function extractProposal(message) {
  const pre = (message?.entities ?? []).find((e) => e.type === 'pre');
  if (!pre || !message.text) return null;
  return message.text.slice(pre.offset, pre.offset + pre.length).trim() || null;
}

const errorText = async (res) => {
  const body = await res.json().catch(() => ({}));
  return body?.message ? `${body.message} (HTTP ${res.status})` : `HTTP ${res.status}`;
};

/**
 * Places one bid as the token's owner. Errors never include the token.
 * @returns {Promise<{ bidId: number|null }>}
 */
export async function placeBid({ projectId, amount, days, milestonePct, description }, token, fetchFn = fetch) {
  if (!token) throw new BidError('thiếu FREELANCER_TOKEN');
  const headers = { 'freelancer-oauth-v1': token, 'Content-Type': 'application/json' };

  const self = await fetchFn(`${API}/users/0.1/self/`, { headers });
  if (!self.ok) throw new BidError(`không đọc được tài khoản Freelancer: ${await errorText(self)}`);
  const bidderId = (await self.json())?.result?.id;
  if (!bidderId) throw new BidError('không đọc được ID tài khoản Freelancer');

  const res = await fetchFn(`${API}/projects/0.1/bids/`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      project_id: projectId,
      bidder_id: bidderId,
      amount,
      period: days,
      milestone_percentage: milestonePct,
      description,
    }),
  });
  if (!res.ok) throw new BidError(await errorText(res));
  const body = await res.json().catch(() => ({}));
  if (body?.status !== 'success') throw new BidError(body?.message ?? 'Freelancer không xác nhận bid');
  return { bidId: body.result?.id ?? null };
}

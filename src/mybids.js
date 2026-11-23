// "/bids" on Telegram: the owner's Freelancer bids and where each one stands.
// Read-only: GET calls with the owner's token, nothing is bid or changed.

const API = 'https://www.freelancer.com/api';
const SHOW = 15;

/** /bids, or a short typed ask like "bid freelancer" / "check bid". */
export function isBidsCommand(text) {
  const t = String(text ?? '').trim().toLowerCase();
  return /^\/bids(@\w+)?$/.test(t) || /^(check |xem )?bids?( freelancer)?$/.test(t);
}

/** One label per bid, from the bid and its project. */
export function bidState(bid, project) {
  if (bid.award_status === 'awarded') return '🏆 Được chọn';
  if (bid.award_status === 'rejected') return '❌ Bị từ chối';
  if (bid.retracted) return '↩️ Đã rút';
  if (project?.status && project.status !== 'active') return '🔒 Job đóng, không chọn mình';
  const front = project?.frontend_project_status;
  if (front && front !== 'open') return '🔒 Khách đã chọn người khác';
  if (bid.shortlisted) return '⭐ Vào shortlist';
  return '⏳ Đang chờ';
}

async function get(url, token, fetchFn) {
  const res = await fetchFn(url, { headers: { 'freelancer-oauth-v1': token } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.message ? `${body.message} (HTTP ${res.status})` : `HTTP ${res.status}`);
  }
  return (await res.json())?.result;
}

/**
 * The owner's bids, newest first, each with its project's title, link and state.
 * Errors never include the token.
 */
export async function fetchMyBids(token, fetchFn = fetch) {
  if (!token) throw new Error('thiếu FREELANCER_TOKEN');
  const me = (await get(`${API}/users/0.1/self/`, token, fetchFn))?.id;
  if (!me) throw new Error('không đọc được ID tài khoản Freelancer');
  const bids = ((await get(`${API}/projects/0.1/bids/?bidders[]=${me}&limit=50`, token, fetchFn))?.bids ?? [])
    .sort((a, b) => (b.time_submitted ?? 0) - (a.time_submitted ?? 0))
    .slice(0, SHOW);
  if (!bids.length) return [];

  const ids = [...new Set(bids.map((b) => b.project_id))];
  const raw = (await get(`${API}/projects/0.1/projects/?${ids.map((id) => `projects[]=${id}`).join('&')}&limit=${ids.length}`, token, fetchFn))?.projects ?? [];
  const projects = new Map((Array.isArray(raw) ? raw : Object.values(raw)).map((p) => [String(p.id), p]));

  return bids.map((b) => {
    const p = projects.get(String(b.project_id));
    return {
      title: p?.title ?? `Project #${b.project_id}`,
      url: p?.seo_url ? `https://www.freelancer.com/projects/${p.seo_url}` : `https://www.freelancer.com/projects/${b.project_id}`,
      state: bidState(b, p),
      price: `${b.amount} ${p?.currency?.code ?? ''}`.trim(),
      submitted: b.time_submitted ?? null,
    };
  });
}

const day = (sec) => {
  const d = new Date(sec * 1000);
  return `${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
};

/** A Telegram message (plain text + text_link entities, no parse_mode to escape). */
export function formatBids(list) {
  if (!list.length) return { text: 'Chưa có bid nào trên Freelancer.', entities: [] };
  const count = (s) => list.filter((b) => b.state.startsWith(s)).length;
  const head = [`📊 Freelancer: ${list.length} bid gần nhất`,
    `🏆 ${count('🏆')} · ⭐ ${count('⭐')} · ⏳ ${count('⏳')} · 🔒 ${count('🔒')} · ❌ ${count('❌')}`].join('\n');
  let text = `${head}\n`;
  const entities = [];
  list.forEach((b, i) => {
    const title = b.title.length > 60 ? `${b.title.slice(0, 57)}…` : b.title;
    text += `\n${i + 1}. ${b.state} · ${title} · ${b.price}${b.submitted ? ` · ${day(b.submitted)}` : ''} · `;
    entities.push({ type: 'text_link', offset: text.length, length: '🔗 Mở'.length, url: b.url });
    text += '🔗 Mở';
  });
  return { text, entities };
}

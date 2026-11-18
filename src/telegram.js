import { netUsd } from './fees.js';
import { riskFlags } from './risk.js';
import { bidCallback, skipCallback } from './bid.js';

const LIMIT = 4096;
const money = (n) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;

const range = (min, max, fmt) => (min != null && min !== max ? `${fmt(min)}–${fmt(max)}` : fmt(max));

/** Non-USD jobs: amounts in the project's currency, e.g. ₹14,000. */
const localMoney = (cur) => (n) => `${cur.sign}${n.toLocaleString('en-US')}`;

/** Rounds an amount in the project's currency to a tidy step for its size. */
const tidy = (n) => {
  const step = n >= 10000 ? 500 : n >= 1000 ? 100 : n >= 100 ? 10 : 1;
  return Math.round(n / step) * step;
};

/**
 * The bid and milestone amounts in the project's currency, which is what the
 * Freelancer bid form takes; null for USD jobs. Kept inside the client's
 * budget, and two milestones still add up to the bid.
 */
export function localBid(job, bid, milestones = []) {
  const cur = job.currency;
  if (!cur || !bid) return null;
  let amount = tidy(bid.amountUsd / cur.usdRate);
  if (cur.min != null) amount = Math.max(amount, cur.min);
  if (cur.max != null) amount = Math.min(amount, cur.max);
  if (milestones.length < 2) return { amount, milestones: milestones.map(() => amount) };
  const first = tidy(amount * 0.4);
  return { amount, milestones: [first, amount - first] };
}

function budgetLine(job) {
  const { budgetMinUsd: min, budgetMaxUsd: max } = job;
  if (max == null) return null;
  const unit = job.budgetType === 'hourly' ? '/h' : job.budgetType === 'salary' ? '/năm' : '';
  const net = netUsd(job);
  const cur = job.currency;
  if (cur?.max != null) {
    return `💰 ${range(cur.min, cur.max, localMoney(cur))}${unit} (≈ ${range(min, max, money)}${unit}${net != null ? ` · nhận ≈ ${money(net)}${unit}` : ''})`;
  }
  return `💰 ${range(min, max, money)}${unit}${net != null ? ` (≈ nhận ${money(net)}${unit})` : ''}`;
}

function bidLines(job, bid) {
  if (!bid) return null;
  const local = localBid(job, bid);
  const price = local
    ? `${localMoney(job.currency)(local.amount)}${bid.unit} (≈ ${money(bid.amountUsd)}${bid.unit})`
    : `${money(bid.amountUsd)}${bid.unit}`;
  return [
    `💵 Gợi ý bid: ${price} · ~${bid.hours} giờ · giao ${bid.days} ngày (≈ nhận ${money(bid.netUsd)}${bid.unit})`,
    bid.discounted ? `🎯 Giá lấy review đầu (đủ giá: ${money(bid.wantUsd)}${bid.unit})` : null,
    bid.underpaid ? `⚠️ Việc ~${bid.hours} giờ đáng ~${money(bid.wantUsd)}${bid.unit}, ngân sách khách thấp hơn` : null,
  ].filter(Boolean).join('\n');
}

const FEW_BIDS = 5;
const MANY_BIDS = 15;
const FRESH_MIN = 60;

/**
 * Freelancer only: bid count and age, since the first few bids are the ones a
 * client reads. With only a few bids a month, this says which alerts to spend
 * them on.
 */
export function competitionLine(job, now = Date.now() / 1000) {
  if (job.source !== 'freelancer' || job.bidCount == null) return null;
  const mins = job.postedAt > 0 ? Math.max(0, Math.round((now - job.postedAt) / 60)) : null;
  const age = mins == null ? '' : mins < 60 ? ` · đăng ${mins} phút trước` : ` · đăng ${Math.round(mins / 60)} giờ trước`;
  const hint = job.bidCount <= FEW_BIDS && mins != null && mins <= FRESH_MIN ? ' · 🔥 ít đối thủ, bid sớm'
    : job.bidCount > MANY_BIDS ? ' · ⏳ đông người bid, cân nhắc giữ lượt' : '';
  return `👥 ${job.bidCount} bid${age}${hint}`;
}

const ESCROW_NOTE = '🔒 Escrow.com project: phải liên kết tài khoản Escrow.com mới bid được';

function riskLines(job) {
  const flags = riskFlags(job).filter((f) => f.level === 'warn');
  const lines = flags.length
    ? [...flags.map((f) => `🚩 ${f.label}`), '🛡️ Không chạy code/cài gì của khách trên máy chính, chỉ mở trong VM hoặc Codespaces.']
    : [];
  if (job.escrow) lines.push(ESCROW_NOTE);
  return lines.length ? lines.join('\n') : null;
}

function jobBlock(job, scored, now) {
  return [
    `[${job.source}] ${job.title}`,
    budgetLine(job),
    competitionLine(job, now),
    scored ? `⭐ ${scored.score}/10 – ${scored.reasonVi}` : null,
    bidLines(job, scored?.bid),
    riskLines(job),
    job.url,
    scored?.proposalEn ? `\n✍️ Proposal:\n${scored.proposalEn}` : null,
  ].filter(Boolean).join('\n');
}

/** One job alert, plain text. */
export function formatAlert(job, scored, warning, now) {
  return [jobBlock(job, scored, now), warning ? `\n⚠️ ${warning}` : null].filter(Boolean).join('\n');
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Telegram's copy button holds at most 256 characters.
const COPY_MAX = 256;
const copyButton = (text, copy) => ({ text, copy_text: { text: String(copy).slice(0, COPY_MAX) } });
const plainAmount = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/**
 * One job alert in Telegram HTML: the proposal sits in a code block, which
 * Telegram copies in one tap, and buttons copy the bid amount, the days and
 * each milestone. `plain` is the fallback when the HTML would be too long.
 * @returns {{ text: string, html: true, plain: string, buttons: object[][] }}
 */
export function formatAlertHtml(job, scored, warning, now) {
  const head = [
    `[${job.source}] ${job.title}`,
    budgetLine(job),
    competitionLine(job, now),
    scored ? `⭐ ${scored.score}/10 – ${scored.reasonVi}` : null,
    bidLines(job, scored?.bid),
    riskLines(job),
    job.url,
  ].filter(Boolean).map(esc).join('\n');
  const milestones = scored?.milestones ?? [];
  const bid = scored?.bid;
  // Copied amounts must be in the currency the bid form uses.
  const local = localBid(job, bid, milestones);
  const fmt = local ? localMoney(job.currency) : money;
  const bidAmount = local ? local.amount : bid?.amountUsd;
  const msAmount = (m, i) => (local ? local.milestones[i] : m.amountUsd);
  const text = [
    head,
    milestones.length
      ? `\n📌 Mốc thanh toán:\n${milestones.map((m, i) => `${i + 1}. ${esc(m.name)} — ${esc(fmt(msAmount(m, i)))}`).join('\n')}`
      : null,
    scored?.proposalEn ? `\n✍️ Proposal (bấm vào khung để copy):\n<pre>${esc(scored.proposalEn)}</pre>` : null,
    warning ? `\n⚠️ ${esc(warning)}` : null,
  ].filter(Boolean).join('\n');
  // One-tap bid: the Worker places exactly this bid, with the proposal from
  // the <pre> block, only when the user taps ✅. Escrow.com projects refuse
  // API bids without a linked Escrow.com account, so they get no ✅.
  const tapBid = job.source === 'freelancer' && !job.escrow && bid && scored?.proposalEn;
  const firstPct = milestones.length >= 2 ? Math.round((msAmount(milestones[0], 0) / bidAmount) * 100) : 100;
  const buttons = [
    ...(tapBid ? [[
      { text: `✅ Bid ${fmt(bidAmount)}${bid.unit} · ${bid.days} ngày`, callback_data: bidCallback(job.id, { amount: plainAmount(bidAmount), days: bid.days, milestonePct: firstPct }) },
      { text: '❌ Bỏ', callback_data: skipCallback(job.id) },
    ]] : []),
    ...(bid ? [[copyButton(`💲 Copy giá ${fmt(bidAmount)}`, plainAmount(bidAmount)), copyButton(`📅 Copy ${bid.days} ngày`, bid.days)]] : []),
    ...milestones.map((m, i) => [
      copyButton(`📋 Mốc ${i + 1}: mô tả`, m.name),
      copyButton(`💲 Mốc ${i + 1}: ${fmt(msAmount(m, i))}`, plainAmount(msAmount(m, i))),
    ]),
  ];
  return { text, html: true, plain: formatAlert(job, scored, warning, now), buttons };
}

/** The twice-daily remote-board digest; null when there is nothing to send. */
export function formatDigest(items, warning) {
  if (!items.length) return null;
  return [
    `📋 Tổng hợp job remote (${items.length})`,
    ...items.map(({ job, scored }) => jobBlock(job, scored)),
    warning ? `⚠️ ${warning}` : null,
  ].filter(Boolean).join('\n\n');
}

/** Splits on line boundaries so no part exceeds Telegram's limit. */
export function splitMessage(text, limit = LIMIT) {
  const parts = [];
  let cur = '';
  for (const line of text.split('\n')) {
    for (let i = 0; i < Math.max(line.length, 1); i += limit) {
      const piece = line.slice(i, i + limit);
      const next = cur === '' ? piece : `${cur}\n${piece}`;
      if (next.length > limit) { parts.push(cur); cur = piece; } else cur = next;
    }
  }
  if (cur !== '' || parts.length === 0) parts.push(cur);
  return parts;
}

/** Jobs Claude could not score, in one message instead of one each. */
export function formatUnscored(jobs, warning) {
  return [
    `⚠️ ${warning}`,
    ...jobs.map((job) => [`[${job.source}] ${job.title}`, budgetLine(job), riskLines(job), job.url].filter(Boolean).join('\n')),
  ].join('\n\n');
}

const GAP_MS = 1100; // Telegram allows about one message a second per chat.
const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Sends plain text (split when long), or a message from formatAlertHtml: HTML
 * with copy buttons when it fits in one message, else its plain fallback.
 * @param {string | { text: string, html: true, plain: string, buttons: object[][] }} message
 */
export async function sendMessage(message, env, fetchFn = fetch, sleep = sleepReal) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const rich = typeof message === 'object' && message.html && message.text.length <= LIMIT ? message : null;
  const extra = rich
    ? { parse_mode: 'HTML', ...(rich.buttons.length ? { reply_markup: { inline_keyboard: rich.buttons } } : {}) }
    : {};
  const post = (part) => fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: part, disable_web_page_preview: true, ...extra }),
  });
  const parts = rich ? [rich.text] : splitMessage(typeof message === 'object' ? message.plain : message);
  for (const part of parts) {
    let res = await post(part);
    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      await sleep((body?.parameters?.retry_after ?? 5) * 1000);
      res = await post(part);
    }
    // Never include the URL in errors: it contains the bot token.
    if (!res.ok) throw new Error(`Telegram sendMessage failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    await sleep(GAP_MS);
  }
}

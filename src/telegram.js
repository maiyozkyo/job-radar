import { netUsd } from './fees.js';

const LIMIT = 4096;
const money = (n) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;

function budgetLine(job) {
  const { budgetMinUsd: min, budgetMaxUsd: max } = job;
  if (max == null) return null;
  const range = min != null && min !== max ? `${money(min)}–${money(max)}` : money(max);
  const unit = job.budgetType === 'hourly' ? '/h' : job.budgetType === 'salary' ? '/năm' : '';
  const net = netUsd(job);
  return `💰 ${range}${unit}${net != null ? ` (≈ nhận ${money(net)}${unit})` : ''}`;
}

function jobBlock(job, scored) {
  return [
    `[${job.source}] ${job.title}`,
    budgetLine(job),
    scored ? `⭐ ${scored.score}/10 – ${scored.reasonVi}` : null,
    job.url,
    scored?.proposalEn ? `\n✍️ Proposal:\n${scored.proposalEn}` : null,
  ].filter(Boolean).join('\n');
}

/** One job alert, plain text. */
export function formatAlert(job, scored, warning) {
  return [jobBlock(job, scored), warning ? `\n⚠️ ${warning}` : null].filter(Boolean).join('\n');
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

export async function sendMessage(text, env, fetchFn = fetch) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  for (const part of splitMessage(text)) {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: part, disable_web_page_preview: true }),
    });
    // Never include the URL in errors: it contains the bot token.
    if (!res.ok) throw new Error(`Telegram sendMessage failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}

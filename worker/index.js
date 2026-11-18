// Cloudflare Worker (free plan) with two jobs:
// 1. Every minute: look for new matching Freelancer projects and, if any,
//    start the radar workflow at once (it scores and alerts as usual).
// 2. Telegram webhook: when the user taps ✅ on an alert, place that bid
//    through the official Freelancer API. Nothing is bid without a tap.
import config from '../config.json' with { type: 'json' };
import { fetchFreelancer } from '../src/sources/freelancer.js';
import { pickFresh } from '../src/fastpoll.js';
import { extractProposal, parseCallback, placeBid } from '../src/bid.js';

const nowSec = () => Math.floor(Date.now() / 1000);

/** Starts radar.yml in poll mode when a new matching project appears. KV is written only then (free plan: 1,000 writes a day). */
export async function fastPoll(env, fetchFn = fetch, now = nowSec()) {
  const jobs = await fetchFreelancer(config, fetchFn, { limit: 10, full: false });
  const seen = JSON.parse((await env.RADAR_KV.get('seen')) ?? '{}');
  const { fresh, seen: next } = pickFresh(jobs, seen, now, config);
  if (!fresh.length) return 0;
  const res = await fetchFn(`https://api.github.com/repos/${env.GH_REPO}/actions/workflows/radar.yml/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'job-radar-worker',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: 'main', inputs: { mode: 'poll' } }),
  });
  if (res.status !== 204) throw new Error(`workflow dispatch failed: HTTP ${res.status}`);
  await env.RADAR_KV.put('seen', JSON.stringify(next));
  return fresh.length;
}

const telegram = (env, fetchFn) => async (method, body) => {
  const res = await fetchFn(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  // Never log the URL: it contains the bot token.
  if (!res.ok) console.warn(`telegram ${method}: HTTP ${res.status}`);
};

const JOB_URL = /https:\/\/www\.freelancer\.com\/projects\/\S+/;

/** Handles one tap on an alert's buttons. Only the owner's taps count. */
export async function onTap(cq, env, fetchFn = fetch) {
  const tg = telegram(env, fetchFn);
  const answer = (text) => tg('answerCallbackQuery', { callback_query_id: cq.id, text });
  if (String(cq.from?.id) !== String(env.TELEGRAM_CHAT_ID)) return answer('Không có quyền');
  const action = parseCallback(cq.data);
  const msg = cq.message;
  if (!action || !msg) return answer('');

  const url = msg.text?.match(JOB_URL)?.[0];
  const status = (text) => tg('editMessageReplyMarkup', {
    chat_id: msg.chat.id,
    message_id: msg.message_id,
    reply_markup: { inline_keyboard: [[url ? { text, url } : { text, callback_data: 'noop' }]] },
  });

  if (action.action === 'skip') {
    await answer('Đã bỏ qua');
    return status('❌ Đã bỏ qua');
  }

  const description = extractProposal(msg);
  if (!description) return answer('Không thấy proposal trong tin, bid tay nhé');

  // Swap the buttons out first, so a double tap cannot send a second bid.
  await answer('Đang bid…');
  await status('⏳ Đang bid…');
  try {
    const { bidId } = await placeBid({ ...action, description }, env.FREELANCER_TOKEN, fetchFn);
    await status(`✅ Đã bid${bidId ? ` #${bidId}` : ''} · mở job`);
  } catch (err) {
    await status('⚠️ Bid lỗi · mở job để bid tay');
    await tg('sendMessage', { chat_id: msg.chat.id, reply_to_message_id: msg.message_id, text: `⚠️ Bid lỗi: ${String(err.message).slice(0, 300)}` });
  }
}

export default {
  async scheduled(_event, env) {
    await fastPoll(env);
  },

  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (request.method !== 'POST' || pathname !== '/telegram') return new Response('not found', { status: 404 });
    // Telegram sends the secret given to setWebhook; anything else is not Telegram.
    if (!env.TG_WEBHOOK_SECRET || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TG_WEBHOOK_SECRET) {
      return new Response('forbidden', { status: 403 });
    }
    const update = await request.json().catch(() => null);
    if (update?.callback_query) await onTap(update.callback_query, env);
    return new Response('ok');
  },
};

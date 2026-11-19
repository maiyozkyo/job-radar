// Cloudflare Worker (free plan) with three jobs:
// 1. Every minute: look for new matching Freelancer projects and, if any,
//    start the radar workflow at once (it scores and alerts as usual).
// 2. Telegram webhook, taps: when the user taps ✅ on an alert, place that
//    bid through the official Freelancer API. Nothing is bid without a tap.
//    ❌ deletes the alert.
// 3. Telegram webhook, messages: a Freelancer link is scored and drafted by
//    the workflow in job mode. Any other text goes to job mode too, where
//    Claude scores it if it is a job post (any platform) or answers it as
//    chat. The text waits in KV for a day and is read back through
//    /paste/<key> with PASTE_TOKEN, so it never shows in the public Actions log.
import config from '../config.json' with { type: 'json' };
import { fetchFreelancer } from '../src/sources/freelancer.js';
import { pickFresh } from '../src/fastpoll.js';
import { extractProposal, parseCallback, placeBid } from '../src/bid.js';
import { findFreelancerLink, MAX_PASTE } from '../src/paste.js';

const nowSec = () => Math.floor(Date.now() / 1000);

/** Starts radar.yml in poll mode when a new matching project appears. KV is written only then (free plan: 1,000 writes a day). */
export async function fastPoll(env, fetchFn = fetch, now = nowSec()) {
  const jobs = await fetchFreelancer(config, fetchFn, { limit: 10, full: false });
  const seen = JSON.parse((await env.RADAR_KV.get('seen')) ?? '{}');
  const { fresh, seen: next } = pickFresh(jobs, seen, now, config);
  if (!fresh.length) return 0;
  await dispatch(env, { mode: 'poll' }, fetchFn);
  await env.RADAR_KV.put('seen', JSON.stringify(next));
  return fresh.length;
}

/** Starts radar.yml with these inputs. */
async function dispatch(env, inputs, fetchFn) {
  const res = await fetchFn(`https://api.github.com/repos/${env.GH_REPO}/actions/workflows/radar.yml/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'job-radar-worker',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: 'main', inputs }),
  });
  if (res.status !== 204) throw new Error(`workflow dispatch failed: HTTP ${res.status}`);
}

const telegram = (env, fetchFn) => async (method, body) => {
  const res = await fetchFn(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  // Never log the URL: it contains the bot token.
  if (!res.ok) console.warn(`telegram ${method}: HTTP ${res.status}`);
  return res.ok;
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
    // Gone from the chat; Telegram refuses to delete bot messages older than
    // 48 h, and then only the buttons are swapped.
    if (await tg('deleteMessage', { chat_id: msg.chat.id, message_id: msg.message_id })) return;
    return status('❌ Đã bỏ qua');
  }

  const description = extractProposal(msg);
  if (!description) return answer('Không thấy proposal trong tin, đại ca bid tay nhé');

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

const HELP = 'Đại ca gửi em link job Freelancer, hoặc dán/chuyển tiếp nội dung job (Upwork, Contra, Fiverr, LinkedIn…) gồm mô tả và ngân sách. Khoảng 1 phút sau em gửi điểm, proposal và giá gợi ý. Đại ca nhắn gì khác thì em trả lời như chat bình thường.';

/** A message from the owner goes to job mode: a Freelancer link as is, other text as paste:<key>. Others are ignored. */
export async function onMessage(msg, env, fetchFn = fetch) {
  if (String(msg.chat?.id) !== String(env.TELEGRAM_CHAT_ID) || String(msg.from?.id) !== String(env.TELEGRAM_CHAT_ID)) return;
  const tg = telegram(env, fetchFn);
  // remove_keyboard: the desk bot once shared this token and left a reply
  // keyboard (📝 Xem đơn / ❌ Bỏ) in this chat; this bot never uses one.
  const reply = (text) => tg('sendMessage', { chat_id: msg.chat.id, reply_to_message_id: msg.message_id, text, reply_markup: { remove_keyboard: true } });
  const text = String(msg.text ?? msg.caption ?? '').trim();
  if (!text || text.startsWith('/')) return reply(HELP);

  let job = findFreelancerLink(text);
  const ack = job ? '⏳ Đại ca chờ em chấm và viết proposal, khoảng 1 phút…' : '⏳ Đại ca chờ em đọc tin, khoảng 1 phút…';
  if (!job) {
    // Job post or chat: Claude decides in job mode.
    const key = crypto.randomUUID();
    await env.RADAR_KV.put(`paste:${key}`, text.slice(0, MAX_PASTE), { expirationTtl: 86400 });
    job = `paste:${key}`;
  }
  try {
    await dispatch(env, { mode: 'job', job }, fetchFn);
    await reply(ack);
  } catch (err) {
    await reply(`⚠️ Không chạy được: ${String(err.message).slice(0, 200)}`);
  }
}

/** GET /paste/<key> for the workflow: the pasted text, only with PASTE_TOKEN. */
async function readPaste(request, env, key) {
  if (!env.PASTE_TOKEN || request.headers.get('Authorization') !== `Bearer ${env.PASTE_TOKEN}`) return new Response('forbidden', { status: 403 });
  const text = await env.RADAR_KV.get(`paste:${key}`);
  return text == null ? new Response('not found', { status: 404 }) : new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

/**
 * Secrets pasted in a terminal or the dashboard can carry a newline or a stray
 * space, which makes fetch throw "Invalid header value". Trim string values,
 * and say which secret still has a character no header can carry.
 */
export function cleanEnv(env) {
  const out = { ...env };
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string') continue;
    out[k] = v.trim();
    if (/[^\x20-\x7e]/.test(out[k])) throw new Error(`${k} có ký tự lạ (độ dài ${out[k].length}), đặt lại secret này`);
  }
  return out;
}

export default {
  async scheduled(_event, rawEnv) {
    await fastPoll(cleanEnv(rawEnv));
  },

  async fetch(request, rawEnv) {
    const env = cleanEnv(rawEnv);
    const { pathname } = new URL(request.url);
    const paste = pathname.match(/^\/paste\/([0-9a-f-]{36})$/);
    if (request.method === 'GET' && paste) return readPaste(request, env, paste[1]);
    if (request.method !== 'POST' || pathname !== '/telegram') return new Response('not found', { status: 404 });
    // Telegram sends the secret given to setWebhook; anything else is not Telegram.
    if (!env.TG_WEBHOOK_SECRET || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TG_WEBHOOK_SECRET) {
      return new Response('forbidden', { status: 403 });
    }
    const update = await request.json().catch(() => null);
    if (update?.callback_query) await onTap(update.callback_query, env);
    else if (update?.message) await onMessage(update.message, env);
    return new Response('ok');
  },
};

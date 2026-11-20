// Scores one job on request and sends the full alert (score, bid, milestones,
// proposal) whatever the score. No state is read or written.
// Input: a Freelancer project URL or id, or `paste:<key>` for a message the
// user sent the bot (text read from the Worker). A pasted job post (any
// platform) is scored; any other message gets a plain chat reply from Claude.
// Usage: node src/one.js <input>   (Actions: mode=job, job=<input>)
import { pathToFileURL } from 'node:url';
import { loadConfig } from './job.js';
import { parseFreelancer } from './sources/freelancer.js';
import { getJson } from './sources/http.js';
import { scoreJobs } from './claude.js';
import { formatAlertHtml, sendMessage } from './telegram.js';
import { bidFromHours, fetchPaste, pastedJob } from './paste.js';
import { chatOrJob } from './chat.js';

const API = 'https://www.freelancer.com/api/projects/0.1/projects/';
const DETAILS = 'full_description=true&job_details=true&owner_info=true';

/** API URL for a project id or a freelancer.com project link; null if neither. */
export function projectApiUrl(input) {
  const s = String(input ?? '').trim();
  if (/^\d+$/.test(s)) return `${API}?projects[]=${s}&${DETAILS}`;
  let url;
  try { url = new URL(s); } catch { return null; }
  if (!/^(www\.)?freelancer\.com$/i.test(url.hostname)) return null;
  const m = url.pathname.match(/^\/projects\/([\w-]+\/[\w-]+)\/?$/);
  return m ? `${API}?seo_urls[]=${encodeURIComponent(m[1])}&${DETAILS}` : null;
}

const PASTE = /^paste:([0-9a-f-]{36})$/;

/** The job to score, or `{ reply }` when a pasted message is chat, not a job. */
async function loadJob(input, env, fetchFn, chat) {
  const paste = String(input ?? '').trim().match(PASTE);
  if (paste) {
    const text = await fetchPaste(paste[1], env, fetchFn);
    const res = await chat(text);
    return res.job ? pastedJob(paste[1], text) : { reply: res.reply };
  }
  const api = projectApiUrl(input);
  if (!api) throw new Error('not a freelancer.com project link or id');
  const [job] = parseFreelancer(await getJson(api, fetchFn));
  if (!job) throw new Error('project not found');
  return job;
}

export async function alertOne(input, { config, env = {}, scoreJobs: score, sendMessage: send, fetchFn = fetch, chat = chatOrJob }) {
  const job = await loadJob(input, env, fetchFn, chat);
  if (job.reply) {
    await send(job.reply);
    return { chat: true };
  }
  const opts = { rate: config.hourlyRateUsd ?? 20, hoursPerDay: config.hoursPerDay ?? 2 };
  let [scored] = await score([job], { draftMin: 1, ...opts, discount: config.firstJobDiscount ?? 1 });
  // A pasted job has no known budget: price it from Claude's hours at the full rate.
  if (scored && !scored.bid && job.source === 'paste') scored = { ...scored, bid: bidFromHours(scored.hours, opts) };
  await send(formatAlertHtml(job, scored, scored ? null : 'Claude bỏ sót, chưa chấm điểm'));
  return { job, scored };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const env = process.env;
  for (const name of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']) {
    if (!env[name]) { console.error(`missing ${name}`); process.exit(1); }
  }
  alertOne(process.argv[2] ?? env.JOB, {
    config: loadConfig(), env, scoreJobs, sendMessage: (m) => sendMessage(m, env),
  }).then(
    // Never log a chat reply: the Actions log is public.
    ({ chat, job, scored }) => console.log(chat ? 'chat: replied' : `job: ${job.key} score ${scored?.score ?? '-'}`),
    (err) => { console.error(`job failed: ${err.message}`); process.exit(1); },
  );
}

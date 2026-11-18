// Messages the user sends the bot: a job pasted or forwarded from any
// platform, or plain chat. The Worker keeps the text in KV; job mode reads it
// back with PASTE_TOKEN and lets Claude tell a job post from chat.
import { makeJob } from './job.js';

export const MAX_PASTE = 8000;   // enough for any post; keeps the prompt small

const FREELANCER_LINK = /https?:\/\/(?:www\.)?freelancer\.com\/projects\/[\w-]+\/[\w-]+\/?(?:\?[^\s<>"']*)?/i;

/** The first freelancer.com project link in a message, e.g. one forwarded with a note; null if none. */
export const findFreelancerLink = (text) => FREELANCER_LINK.exec(String(text ?? ''))?.[0].replace(/[.,;:!?)]+$/, '') ?? null;

/** The pasted text as a job: first line as the title, all of it as the description. */
export function pastedJob(key, text) {
  const firstLine = text.split('\n').map((l) => l.trim()).find(Boolean) ?? 'Job';
  return makeJob({ source: 'paste', id: key, title: firstLine.slice(0, 100), description: text });
}

/** Reads `paste:<key>` from the Worker. */
export async function fetchPaste(key, env, fetchFn = fetch) {
  if (!env.WORKER_URL || !env.PASTE_TOKEN) throw new Error('missing WORKER_URL or PASTE_TOKEN');
  const res = await fetchFn(`${env.WORKER_URL}/paste/${key}`, { headers: { Authorization: `Bearer ${env.PASTE_TOKEN}` } });
  if (res.status === 404) throw new Error('pasted job expired or not found');
  if (!res.ok) throw new Error(`could not read pasted job: HTTP ${res.status}`);
  return res.text();
}

/**
 * A bid suggestion from Claude's hours at the user's rate, for jobs with no
 * known budget. `netUsd` assumes a 10% platform fee, the usual rate.
 */
export function bidFromHours(hours, { rate, hoursPerDay }) {
  if (!(hours > 0)) return null;
  const amountUsd = Math.max(5, Math.round((hours * rate) / 5) * 5);
  return {
    amountUsd, unit: '', hours, days: Math.ceil(hours / hoursPerDay) + 1,
    netUsd: Math.round(amountUsd * 0.9 * 100) / 100, wantUsd: amountUsd, underpaid: false, discounted: false,
  };
}

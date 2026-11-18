// Jobs the user pastes or forwards to the bot, from any platform. The Worker
// keeps the text in KV; job mode reads it back with PASTE_TOKEN.
import { makeJob } from './job.js';

export const MIN_PASTE = 80;     // shorter than this is not a job post
export const MAX_PASTE = 8000;   // enough for any post; keeps the prompt small

/** A freelancer.com project link on its own (no other text). */
export const isFreelancerLink = (text) => /^https?:\/\/(www\.)?freelancer\.com\/projects\/[\w-]+\/[\w-]+\/?(\?\S*)?$/i.test(String(text).trim());

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

// Scores one Freelancer job on request and sends the full alert (score, bid,
// milestones, proposal) whatever the score. No state is read or written.
// Usage: node src/one.js <project URL or id>   (Actions: mode=job, job=<URL>)
import { pathToFileURL } from 'node:url';
import { loadConfig } from './job.js';
import { parseFreelancer } from './sources/freelancer.js';
import { getJson } from './sources/http.js';
import { scoreJobs } from './claude.js';
import { formatAlertHtml, sendMessage } from './telegram.js';

const API = 'https://www.freelancer.com/api/projects/0.1/projects/';
const DETAILS = 'full_description=true&job_details=true';

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

export async function alertOne(input, { config, scoreJobs: score, sendMessage: send, fetchFn = fetch }) {
  const api = projectApiUrl(input);
  if (!api) throw new Error('not a freelancer.com project link or id');
  const [job] = parseFreelancer(await getJson(api, fetchFn));
  if (!job) throw new Error('project not found');
  const rate = config.hourlyRateUsd ?? 20;
  const [scored] = await score([job], { draftMin: 1, rate, hoursPerDay: config.hoursPerDay ?? 2, discount: config.firstJobDiscount ?? 1 });
  await send(formatAlertHtml(job, scored, scored ? null : 'Claude bỏ sót, chưa chấm điểm'));
  return { job, scored };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const env = process.env;
  for (const name of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']) {
    if (!env[name]) { console.error(`missing ${name}`); process.exit(1); }
  }
  alertOne(process.argv[2] ?? env.JOB, {
    config: loadConfig(), scoreJobs, sendMessage: (m) => sendMessage(m, env),
  }).then(
    ({ job, scored }) => console.log(`job: ${job.key} score ${scored?.score ?? '-'}`),
    (err) => { console.error(`job failed: ${err.message}`); process.exit(1); },
  );
}

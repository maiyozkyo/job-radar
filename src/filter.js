import { riskFlags } from './risk.js';
import { clientDrop } from './client.js';

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Keywords match whole words, so ".net" does not hit "asp.network", "c#" does
// not hit plain "c" and "excel" does not hit "excellent". A plural "s" is
// allowed ("LLMs"); other forms ("angularjs", "dockerize") are listed in config.
const matcher = (kw) => {
  const re = new RegExp(`(?<![a-z0-9])${escape(kw.toLowerCase())}s?(?![a-z0-9#])`);
  return (text) => re.test(text);
};
const firstMatch = (text, keywords) => keywords.find((kw) => matcher(kw)(text));

const BOARDS = new Set(['wwr', 'remoteok', 'himalayas', 'remotive', 'jobicy']);
const VN_BOARDS = new Set(['freelancerviet', 'vlance']);
const FULL_TIME = /full[\s_-]?time/i; // Remotive writes "full_time"
const FLEXIBLE = /contract|part[\s-]?time|freelance/i;

/**
 * @param {import('./job.js').Job} job
 * @param {import('./job.js').Config} config
 * @returns {{ keep: boolean, reason: string }}
 */
export function filterJob(job, config, now = Date.now() / 1000) {
  const text = `${job.title}\n${job.description}\n${job.tags.join(' ')}`.normalize('NFC').toLowerCase();
  const drop = (reason) => ({ keep: false, reason });

  // Block words only in the title and tags: a description saying "daily sales
  // report" or "email verification" is a normal job. Some block words only in
  // the title: Freelancer tags Excel cleanup jobs "Data Entry".
  const blocked = firstMatch(`${job.title}
${job.tags.join(' ')}`.toLowerCase(), config.blockKeywords)
    ?? firstMatch(job.title.toLowerCase(), config.titleBlockKeywords ?? []);
  if (blocked) return drop(`block keyword: ${blocked}`);
  const scam = riskFlags(job).find((f) => f.level === 'block');
  if (scam) return drop(`risk: ${scam.label}`);
  // Vietnamese keywords only on the Vietnamese boards: "web" alone is too broad elsewhere.
  const stack = firstMatch(text, config.stackKeywords)
    ?? (VN_BOARDS.has(job.source) ? firstMatch(text, config.vnStackKeywords ?? []) : undefined);
  if (!stack) return drop('no stack keyword');

  if (job.source === 'freelancer') {
    if (job.budgetMaxUsd == null) return drop('unknown budget');
    if (job.budgetType === 'hourly' && job.budgetMaxUsd < config.minHourlyUsd) return drop('hourly below floor');
    if (job.budgetType !== 'hourly' && job.budgetMaxUsd < config.minFixedUsd) return drop('budget below floor');
    if (job.bidCount != null && job.bidCount > config.maxBidCount) return drop('too many bids');
    const junk = job.client ? clientDrop(job.client, now) : null;
    if (junk) return drop(`client: ${junk}`);
  }

  if (BOARDS.has(job.source)) {
    let loc = (job.location ?? '').toLowerCase().trim();
    if (loc === 'remote') loc = '';
    if (loc && !config.allowedLocations.some((a) => loc.includes(a))) return drop(`location: ${job.location}`);
    const fullTime = FULL_TIME.test(job.employmentType ?? '') || FULL_TIME.test(job.title);
    if (fullTime && !FLEXIBLE.test(text)) return drop('full-time only');
  }

  return { keep: true, reason: `stack: ${stack}` };
}

/** Sources where clients decide within hours, so alerts go out at once. */
// The Vietnamese boards post a few jobs a day, so they alert at once instead of waiting for the digest.
export const isUrgent = (job) => ['freelancer', 'hn', 'reddit'].includes(job.source) || VN_BOARDS.has(job.source);

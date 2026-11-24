import { fetchFreelancer } from './freelancer.js';
import { fetchHn } from './hn.js';
import { fetchWwr } from './wwr.js';
import { fetchRemoteOk } from './remoteok.js';
import { fetchHimalayas } from './himalayas.js';
import { fetchRemotive } from './remotive.js';
import { fetchJobicy } from './jobicy.js';
import { fetchFreelancerViet, fetchVlance } from './vnboards.js';
import { fetchReddit, hasRedditKeys } from './reddit.js';

/**
 * Minimum seconds between calls, from each API's terms. Polls run every 30
 * minutes, so these sources are skipped on most runs.
 * Remotive: "max. 4 times a day". Jobicy: "must not exceed once per hour".
 */
export const RATE_LIMITS = { remotive: 6 * 3600, jobicy: 2 * 3600 };

/**
 * Runs every source that is due; a failing source is reported in `errors`,
 * never thrown. Reddit runs only when its API keys are in `env`.
 * `lastFetch` (from state) is updated in place for rate-limited
 * sources, also when the call fails, so a broken API is not hammered.
 * @returns {Promise<{ jobs: import('../job.js').Job[], errors: string[], okSources: string[] }>}
 */
export async function fetchAll(config, fetchFn = fetch, now = Math.floor(Date.now() / 1000), lastFetch = {}, env = process.env) {
  const sources = {
    freelancer: () => fetchFreelancer(config, fetchFn),
    hn: () => fetchHn(fetchFn, now),
    wwr: () => fetchWwr(fetchFn),
    remoteok: () => fetchRemoteOk(fetchFn),
    himalayas: () => fetchHimalayas(fetchFn),
    remotive: () => fetchRemotive(fetchFn),
    jobicy: () => fetchJobicy(fetchFn),
    freelancerviet: () => fetchFreelancerViet(fetchFn),
    vlance: () => fetchVlance(fetchFn),
  };
  if (hasRedditKeys(env)) sources.reddit = () => fetchReddit(env, fetchFn);
  const due = (name) => !(name in RATE_LIMITS) || now - (lastFetch[name] ?? 0) >= RATE_LIMITS[name];
  const names = Object.keys(sources).filter(due);
  for (const name of names) if (name in RATE_LIMITS) lastFetch[name] = now;
  const results = await Promise.allSettled(names.map((n) => sources[n]()));
  const jobs = [];
  const errors = [];
  const okSources = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') { jobs.push(...r.value); okSources.push(names[i]); }
    else errors.push(`${names[i]}: ${r.reason?.message ?? r.reason}`);
  });
  return { jobs, errors, okSources };
}

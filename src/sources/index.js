import { fetchFreelancer } from './freelancer.js';
import { fetchHn } from './hn.js';
import { fetchWwr } from './wwr.js';
import { fetchRemoteOk } from './remoteok.js';
import { fetchHimalayas } from './himalayas.js';

/**
 * Runs every source; a failing source is reported in `errors`, never thrown.
 * @returns {Promise<{ jobs: import('../job.js').Job[], errors: string[] }>}
 */
export async function fetchAll(config, fetchFn = fetch, now = Math.floor(Date.now() / 1000)) {
  const sources = {
    freelancer: () => fetchFreelancer(config, fetchFn),
    hn: () => fetchHn(fetchFn, now),
    wwr: () => fetchWwr(fetchFn),
    remoteok: () => fetchRemoteOk(fetchFn),
    himalayas: () => fetchHimalayas(fetchFn),
  };
  const names = Object.keys(sources);
  const results = await Promise.allSettled(names.map((n) => sources[n]()));
  const jobs = [];
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') jobs.push(...r.value);
    else errors.push(`${names[i]}: ${r.reason?.message ?? r.reason}`);
  });
  return { jobs, errors };
}

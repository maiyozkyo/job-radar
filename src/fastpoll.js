import { filterJob } from './filter.js';

// The Worker checks Freelancer every minute and starts a radar run as soon as
// a new matching project shows up, instead of waiting for the next cron slot.
// The radar run does the real dedupe, scoring and alerting; this only decides
// whether a run is worth starting.

const WINDOW = 20 * 60;   // only projects posted in the last 20 minutes
const KEEP = 2 * 3600;    // forget triggered ids after 2 hours

/**
 * @param {import('./job.js').Job[]} jobs
 * @param {Record<string, number>} seen  project id -> when it triggered a run
 * @returns {{ fresh: import('./job.js').Job[], seen: Record<string, number> }}
 */
export function pickFresh(jobs, seen, now, config) {
  const fresh = jobs.filter((j) => now - j.postedAt <= WINDOW && !(j.id in seen) && filterJob(j, config).keep);
  const next = Object.fromEntries(Object.entries(seen).filter(([, at]) => now - at <= KEEP));
  for (const j of fresh) next[j.id] = now;
  return { fresh, seen: next };
}

// Cloudflare's free plan allows 50 subrequests per Worker run. With more query
// terms than that, the Worker takes a different slice each minute, so every
// term is still checked every couple of minutes.
export const WORKER_MAX_QUERIES = 28; // the load the Worker already ran at, inside its CPU limit

/** The query terms the Worker checks in the minute that contains `now`. */
export function querySlice(queries, now, size = WORKER_MAX_QUERIES) {
  if (queries.length <= size) return queries;
  const parts = Math.ceil(queries.length / size);
  const per = Math.ceil(queries.length / parts);
  const i = Math.floor(now / 60) % parts;
  return queries.slice(i * per, (i + 1) * per);
}

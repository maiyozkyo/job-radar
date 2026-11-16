import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Lives on the `state` branch. Holds job data only, never scores or proposals.
 * @typedef {{ initialized: boolean, seen: Record<string, number>, pending: import('./job.js').Job[] }} State
 */

const KEEP_SEEN = 60 * 24 * 3600;
const file = (dir) => join(dir, 'state.json');

/** @returns {State} */
export function loadState(dir) {
  if (!existsSync(file(dir))) return { initialized: false, seen: {}, pending: [] };
  const raw = readFileSync(file(dir), 'utf8').trim();
  const s = raw ? JSON.parse(raw) : {};
  return { initialized: !!s.initialized, seen: s.seen ?? {}, pending: s.pending ?? [] };
}

export function saveState(dir, state) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file(dir), JSON.stringify(state, null, 1) + '\n');
}

/**
 * Marks every job seen and returns the ones not seen before. On the first run
 * nothing is returned, so the user is not flooded with every open job.
 */
export function takeNew(state, jobs, now) {
  const firstRun = !state.initialized;
  const fresh = [];
  for (const job of jobs) {
    if (!(job.key in state.seen) && !firstRun) fresh.push(job);
    state.seen[job.key] = now;
  }
  state.initialized = true;
  return { fresh, firstRun };
}

export function prune(state, now) {
  for (const [key, at] of Object.entries(state.seen)) {
    if (now - at > KEEP_SEEN) delete state.seen[key];
  }
}

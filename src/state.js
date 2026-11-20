import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Lives on the `state` branch. Holds job data only; scores go to scores.log.
 * `seeded` records which sources have answered at least once: a source's first
 * batch is only recorded, so a source that was down at the start (or is added
 * later) does not flood the user with every open job.
 * `night` holds urgent jobs found in quiet hours, for the morning batch.
 * `lastFetch` holds the last call time of rate-limited sources (unix seconds).
 * @typedef {{ initialized: boolean, seeded: Record<string, boolean>, seen: Record<string, number>, pending: import('./job.js').Job[], night: import('./job.js').Job[], lastFetch: Record<string, number> }} State
 */

const KEEP_SEEN = 60 * 24 * 3600;
const file = (dir) => join(dir, 'state.json');
const empty = () => ({ initialized: false, seeded: {}, seen: {}, pending: [], night: [], lastFetch: {} });

/** @returns {State} */
export function loadState(dir) {
  if (!existsSync(file(dir))) return empty();
  let s;
  try {
    const raw = readFileSync(file(dir), 'utf8').trim();
    s = raw ? JSON.parse(raw) : {};
  } catch {
    console.warn('state.json is corrupt, starting over');
    return empty();
  }
  return { initialized: !!s.initialized, seeded: s.seeded ?? {}, seen: s.seen ?? {}, pending: s.pending ?? [], night: s.night ?? [], lastFetch: s.lastFetch ?? {} };
}

/** Writes to a temp file and renames, so a killed run never leaves half a file. */
export function saveState(dir, state) {
  mkdirSync(dir, { recursive: true });
  const tmp = `${file(dir)}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 1) + '\n');
  renameSync(tmp, file(dir));
}

/**
 * Marks every job seen and returns the ones not seen before from sources that
 * were already seeded. `okSources` are the sources that answered this run
 * (default: the sources present in `jobs`).
 */
export function takeNew(state, jobs, now, okSources = [...new Set(jobs.map((j) => j.source))]) {
  // A state written before `seeded` existed already knows every source.
  if (!state.seeded) state.seeded = Object.fromEntries(state.initialized ? okSources.map((s) => [s, true]) : []);
  const firstRun = !state.initialized;
  const fresh = [];
  for (const job of jobs) {
    if (!(job.key in state.seen) && state.seeded[job.source] && !firstRun) fresh.push(job);
    state.seen[job.key] = now;
  }
  for (const source of okSources) state.seeded[source] = true;
  state.initialized = true;
  return { fresh, firstRun };
}

export function prune(state, now) {
  for (const [key, at] of Object.entries(state.seen)) {
    if (now - at > KEEP_SEEN) delete state.seen[key];
  }
}

const KEEP_LOG_LINES = 20000; // about two weeks at a run every 15 minutes
const logFile = (dir) => join(dir, 'scores.log');

/**
 * Appends lines to scores.log on the `state` branch, so scores can be checked
 * from one small file instead of every Actions log. Same public data as the
 * Actions log (titles, URLs, scores); never proposals. Keeps the newest lines.
 */
export function appendLog(dir, lines) {
  if (!lines.length) return;
  mkdirSync(dir, { recursive: true });
  appendFileSync(logFile(dir), lines.map((l) => l.replace(/[\r\n]+/g, ' ')).join('\n') + '\n');
  const all = readFileSync(logFile(dir), 'utf8').split('\n').filter(Boolean);
  if (all.length > KEEP_LOG_LINES) writeFileSync(logFile(dir), all.slice(-KEEP_LOG_LINES).join('\n') + '\n');
}

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { netUsd } from './fees.js';

/**
 * @typedef {{ key: string, score: number, reasonVi: string, proposalEn: string|null }} Scored
 */

export class ClaudeOutputError extends Error {}

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const MAX_DESCRIPTION = 3000;

function buildPrompt(jobs, draftMin) {
  const data = jobs.map((j) => ({
    key: j.key,
    source: j.source,
    title: j.title,
    description: j.description.slice(0, MAX_DESCRIPTION),
    budgetType: j.budgetType,
    budgetMinUsd: j.budgetMinUsd,
    budgetMaxUsd: j.budgetMaxUsd,
    netUsd: netUsd(j),
    bidCount: j.bidCount,
    location: j.location,
    employmentType: j.employmentType,
    tags: j.tags,
  }));
  return read('prompts/score.md')
    .replace('{{DRAFT_RULE}}', `score >= ${draftMin}`)
    .replace('{{PROFILE}}', read('profile.md'))
    .replace('{{JOBS}}', JSON.stringify(data, null, 1));
}

// Job text is untrusted. If a post smuggles instructions that make Claude put
// a link in the proposal, the user could forward it to a client, so only the
// user's own links survive.
const ALLOWED_LINKS = [/^https?:\/\/(www\.)?github\.com\/maiyozkyo(\/|$)/i, /^https?:\/\/(www\.)?contra\.com\/(hoang_buu_wctxhu7k|p\/)/i];
const LINK = /\b(?:https?:\/\/|www\.)[^\s)>\]"']+/gi;

export function sanitizeProposal(text) {
  return text.replace(LINK, (url) => {
    const clean = url.replace(/[.,;:!?]+$/, '');
    const tail = url.slice(clean.length);
    return ALLOWED_LINKS.some((re) => re.test(clean)) ? url : `[link bị xóa]${tail}`;
  });
}

function parseScores(output, jobs) {
  const start = output.indexOf('[');
  const end = output.lastIndexOf(']');
  if (start < 0 || end <= start) throw new ClaudeOutputError('no JSON array in reply');
  let arr;
  try { arr = JSON.parse(output.slice(start, end + 1)); } catch { throw new ClaudeOutputError('reply is not valid JSON'); }
  const byKey = new Map(Array.isArray(arr) ? arr.map((s) => [s?.key, s]) : []);
  return jobs.map((job) => {
    const s = byKey.get(job.key);
    if (!s) throw new ClaudeOutputError(`missing score for ${job.key}`);
    if (!Number.isInteger(s.score) || s.score < 1 || s.score > 10) throw new ClaudeOutputError(`bad score for ${job.key}`);
    return { key: job.key, score: s.score, reasonVi: String(s.reasonVi ?? ''), proposalEn: s.proposalEn ? sanitizeProposal(String(s.proposalEn)) : null };
  });
}

/** Runs Claude Code headless with no tools; the prompt goes in on stdin. */
export function defaultRunClaude(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', '--output-format', 'json', '--tools', '', '--model', 'sonnet', '--no-session-persistence'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      timeout: 5 * 60_000,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err.slice(0, 300)}`));
      try {
        const res = JSON.parse(out);
        if (res.is_error) return reject(new Error(`claude error: ${String(res.result).slice(0, 300)}`));
        resolve(String(res.result ?? ''));
      } catch {
        reject(new Error('claude returned non-JSON'));
      }
    });
    child.stdin.end(prompt);
  });
}

/**
 * Scores jobs and drafts proposals for those scoring at least `draftMin`.
 * @returns {Promise<Scored[]>} in the same order as `jobs`
 */
export async function scoreJobs(jobs, { draftMin }, runClaude = defaultRunClaude) {
  if (!jobs.length) return [];
  return parseScores(await runClaude(buildPrompt(jobs, draftMin)), jobs);
}

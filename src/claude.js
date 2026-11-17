import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { netUsd, splitMilestones, suggestBid } from './fees.js';

/**
 * `hours` is Claude's effort estimate; `bid` is computed from it (see fees.js).
 * `milestones` splits the bid over Claude's milestone names (fixed-price bids only).
 * @typedef {{ key: string, score: number, reasonVi: string, proposalEn: string|null, hours: number|null, bid: ReturnType<typeof suggestBid>, milestones: ReturnType<typeof splitMilestones> }} Scored
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

// Contact details pull the talk off-platform, which breaks Freelancer's rules.
const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
const PHONE = /\+?\d[\d\s().-]{7,}\d/g;

export function sanitizeProposal(text) {
  return text
    .replace(LINK, (url) => {
      const clean = url.replace(/[.,;:!?]+$/, '');
      const tail = url.slice(clean.length);
      return ALLOWED_LINKS.some((re) => re.test(clean)) ? url : `[link bị xóa]${tail}`;
    })
    .replace(EMAIL, '[email bị xóa]')
    .replace(PHONE, '[số bị xóa]');
}

function parseArray(output) {
  const unfenced = output.replace(/```(?:json)?/gi, '').trim();
  try {
    const whole = JSON.parse(unfenced);
    if (Array.isArray(whole)) return whole;
  } catch { /* fall through to the bracket slice */ }
  const start = unfenced.indexOf('[{');
  const end = unfenced.lastIndexOf(']');
  if (start < 0 || end <= start) throw new ClaudeOutputError('no JSON array in reply');
  try { return JSON.parse(unfenced.slice(start, end + 1)); } catch { throw new ClaudeOutputError('reply is not valid JSON'); }
}

const MAX_MILESTONE = 100;

/** At most two one-line names, links removed like in proposals. */
function milestoneNames(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 2)
    .map((n) => sanitizeProposal(String(n ?? '')).replace(/\s+/g, ' ').trim().slice(0, MAX_MILESTONE))
    .filter(Boolean);
}

/** A job Claude skipped comes back as null, so one gap does not sink the batch. */
function parseScores(output, jobs, bidOpts) {
  const arr = parseArray(output);
  if (!arr.length) throw new ClaudeOutputError('empty reply');
  const byKey = new Map(arr.map((s) => [s?.key, s]));
  return jobs.map((job) => {
    const s = byKey.get(job.key);
    if (!s) return null;
    const score = Number(s.score);
    if (!Number.isInteger(score) || score < 1 || score > 10) throw new ClaudeOutputError(`bad score for ${job.key}`);
    const h = Number(s.hours);
    const hours = Number.isFinite(h) && h > 0 && h <= 500 ? h : null;
    const bid = suggestBid(job, hours, bidOpts);
    return {
      key: job.key, score, reasonVi: String(s.reasonVi ?? ''),
      proposalEn: s.proposalEn ? sanitizeProposal(String(s.proposalEn)) : null,
      hours, bid, milestones: splitMilestones(bid, milestoneNames(s.milestonesEn)),
    };
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
 * @returns {Promise<(Scored|null)[]>} in the same order as `jobs`; null when Claude skipped a job
 */
export async function scoreJobs(jobs, { draftMin, rate = 20, hoursPerDay = 2 }, runClaude = defaultRunClaude) {
  if (!jobs.length) return [];
  return parseScores(await runClaude(buildPrompt(jobs, draftMin)), jobs, { rate, hoursPerDay });
}

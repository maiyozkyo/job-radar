import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { netUsd, splitMilestones, suggestBid } from './fees.js';
import { readProfile } from './profile.js';

/**
 * `hours` is Claude's effort estimate; `bid` is computed from it (see fees.js).
 * `milestones` splits the bid over Claude's milestone names (fixed-price bids only).
 * @typedef {{ key: string, score: number, reasonVi: string, summaryVi: string[], proposalEn: string|null, hours: number|null, bid: ReturnType<typeof suggestBid>, milestones: ReturnType<typeof splitMilestones> }} Scored
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
    client: j.client ?? null,
  }));
  return read('prompts/score.md')
    .replaceAll('{{DRAFT_RULE}}', `score >= ${draftMin}`)
    // Function replacers: a `$&` in job text must stay as typed.
    .replace('{{PROFILE}}', readProfile)
    .replace('{{JOBS}}', () => JSON.stringify(data, null, 1));
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

const MAX_SUMMARY_LINES = 3;
const MAX_SUMMARY_CHARS = 110;

/** What the client asks for: a few short lines, cleaned like proposals since job text is untrusted. */
function summaryLines(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((l) => sanitizeProposal(String(l ?? '')).replace(/\s+/g, ' ').trim().slice(0, MAX_SUMMARY_CHARS))
    .filter(Boolean)
    .slice(0, MAX_SUMMARY_LINES);
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
      key: job.key, score, reasonVi: String(s.reasonVi ?? ''), summaryVi: summaryLines(s.summaryVi),
      proposalEn: s.proposalEn ? sanitizeProposal(String(s.proposalEn)) : null,
      hours, bid, milestones: splitMilestones(bid, milestoneNames(s.milestonesEn)),
    };
  });
}

/** Windows: shell:true starts cmd.exe, so kill the whole tree or claude.exe lingers. */
function killTree(child) {
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  else child.kill();
}

const TIMEOUT_MS = 5 * 60_000;

/** Runs Claude Code headless with no tools; the prompt goes in on stdin. */
export function defaultRunClaude(prompt, { timeoutMs = TIMEOUT_MS, command = 'claude', args, model = 'sonnet' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args ?? ['-p', '--output-format', 'json', '--tools', '', '--model', model, '--no-session-persistence'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    let out = '';
    let err = '';
    let timedOut = false;
    // Not spawn's own `timeout`: on Windows it would kill only cmd.exe.
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`claude timed out after ${Math.round(timeoutMs / 1000)}s`));
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err.slice(0, 300)}`));
      try {
        const res = JSON.parse(out);
        if (res.is_error) return reject(new Error(`claude error: ${String(res.result).slice(0, 300)}`));
        resolve(String(res.result ?? ''));
      } catch {
        reject(new Error('claude returned non-JSON'));
      }
    });
    child.stdin.on('error', () => {}); // a child killed early must not crash the run with EPIPE
    child.stdin.end(prompt);
  });
}

/**
 * Scores jobs and drafts proposals for those scoring at least `draftMin`.
 * @returns {Promise<(Scored|null)[]>} in the same order as `jobs`; null when Claude skipped a job
 */
export async function scoreJobs(jobs, { draftMin, rate = 20, hoursPerDay = 2, discount = 1, redraftMin = null }, runClaude = defaultRunClaude) {
  if (!jobs.length) return [];
  const scored = parseScores(await runClaude(buildPrompt(jobs, draftMin)), jobs, { rate, hoursPerDay, discount });
  return redraftMin == null ? scored : redraft(jobs, scored, redraftMin, runClaude);
}

/**
 * Jobs scoring at least `redraftMin` get their proposal rewritten by Opus in
 * one extra call: these are the ones worth winning, and a Freelancer one-tap
 * bid sends the proposal unread. Any failure keeps the first draft.
 * Each rewritten proposal carries `redrafted: true`.
 */
export async function redraft(jobs, scored, redraftMin, runClaude = defaultRunClaude) {
  const picks = jobs.map((job, i) => ({ job, s: scored[i] })).filter(({ s }) => s?.proposalEn && s.score >= redraftMin);
  if (!picks.length) return scored;
  const data = picks.map(({ job, s }) => ({
    key: job.key, source: job.source, title: job.title, description: job.description.slice(0, MAX_DESCRIPTION),
    budgetType: job.budgetType, budgetMinUsd: job.budgetMinUsd, budgetMaxUsd: job.budgetMaxUsd, tags: job.tags, draft: s.proposalEn,
  }));
  const prompt = read('prompts/redraft.md').replace('{{PROFILE}}', readProfile).replace('{{JOBS}}', () => JSON.stringify(data, null, 1));
  let byKey;
  try {
    byKey = new Map(parseArray(await runClaude(prompt, { model: 'opus' })).map((r) => [r?.key, r?.proposalEn]));
  } catch (err) {
    console.warn(`opus redraft failed, keeping the first drafts: ${String(err.message).slice(0, 120)}`);
    return scored;
  }
  return scored.map((s) => {
    const text = s && byKey.get(s.key);
    return text && typeof text === 'string' && text.trim() ? { ...s, proposalEn: sanitizeProposal(text.trim()), redrafted: true } : s;
  });
}

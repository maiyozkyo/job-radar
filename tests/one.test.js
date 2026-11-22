import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { alertOne, projectApiUrl } from '../src/one.js';
import { chatOrJob, chatPrompt } from '../src/chat.js';

process.env.PROFILE_FILE = fileURLToPath(new URL('../profile.example.md', import.meta.url));

test('project links and ids become API URLs; other input is refused', () => {
  assert.match(projectApiUrl('https://www.freelancer.com/projects/microsoft-word/PDF-Word-Conversion-40822297?frm=x&sb=t'),
    /projects\/\?seo_urls\[\]=microsoft-word%2FPDF-Word-Conversion-40822297&full_description=true/);
  assert.match(projectApiUrl(' 40822292 '), /projects\[\]=40822292&/);
  assert.equal(projectApiUrl('https://evil.example/projects/a/b'), null);
  assert.equal(projectApiUrl('https://www.freelancer.com/u/someone'), null);
  assert.equal(projectApiUrl('not a link'), null);
});

const reply = { result: { projects: [{
  id: 7, seo_url: 'data-entry/PDF-Word', title: 'PDF to Word', description: 'Convert PDFs', type: 'fixed',
  budget: { minimum: 100, maximum: 300 }, currency: { exchange_rate: 1 }, bid_stats: { bid_count: 5 }, time_submitted: 1, jobs: [],
} ] } };

test('alertOne scores the job with drafting on and sends one HTML alert', async () => {
  const sent = [];
  let opts;
  const { job } = await alertOne('7', {
    config: { hourlyRateUsd: 20, hoursPerDay: 4 },
    fetchFn: async () => ({ ok: true, json: async () => reply }),
    scoreJobs: async (jobs, o) => { opts = o; return [{ key: jobs[0].key, score: 5, reasonVi: 'ok', proposalEn: 'Hi', bid: null, milestones: [] }]; },
    sendMessage: async (m) => { sent.push(m); },
  });
  assert.equal(job.key, 'freelancer:7');
  assert.equal(opts.draftMin, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].html, true);
  assert.match(sent[0].text, /⭐ 5\/10/);
  assert.match(sent[0].text, /<pre>Hi<\/pre>/);
});

test('alertOne fails clearly on a bad link or a missing project', async () => {
  const deps = { config: {}, scoreJobs: async () => [], sendMessage: async () => {} };
  await assert.rejects(alertOne('https://evil.example/x', deps), /not a freelancer\.com project/);
  await assert.rejects(alertOne('1', { ...deps, fetchFn: async () => ({ ok: true, json: async () => ({ result: { projects: [] } }) }) }), /project not found/);
});

test('alertOne scores a pasted job and prices it from the hours', async () => {
  const key = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const sent = [];
  const { job, scored } = await alertOne(`paste:${key}`, {
    config: { hourlyRateUsd: 20, hoursPerDay: 5 },
    env: { WORKER_URL: 'https://w.example', PASTE_TOKEN: 'P' },
    fetchFn: async () => ({ ok: true, status: 200, text: async () => 'Upwork: Fix Angular charts\nBudget $150, 2 days.' }),
    chat: async () => ({ job: true }),
    scoreJobs: async (jobs) => [{ key: jobs[0].key, score: 8, reasonVi: 'ok', proposalEn: 'Hi', hours: 6, bid: null, milestones: [] }],
    sendMessage: async (m) => { sent.push(m); },
  });
  assert.equal(job.key, `paste:${key}`);
  assert.equal(scored.bid.amountUsd, 120);
  assert.match(sent[0].text, /\[paste\] Upwork: Fix Angular charts/);
  assert.match(sent[0].text, /💵 Gợi ý bid: \$120 · ~6 giờ · giao 3 ngày/);
  assert.ok(!sent[0].buttons.flat().some((b) => b.callback_data), 'no one-tap bid off Freelancer');
});

test('a pasted message that is chat gets the Claude reply and is not scored', async () => {
  const sent = [];
  let asked;
  const res = await alertOne('paste:0f8fad5b-d9cb-469f-a165-70867728950e', {
    config: {},
    env: { WORKER_URL: 'https://w.example', PASTE_TOKEN: 'P' },
    fetchFn: async () => ({ ok: true, status: 200, text: async () => 'chào bot' }),
    chat: async (text) => { asked = text; return { reply: 'Chào bạn!' }; },
    scoreJobs: async () => { throw new Error('should not score chat'); },
    sendMessage: async (m) => { sent.push(m); },
  });
  assert.equal(asked, 'chào bot');
  assert.deepEqual(res, { chat: true });
  assert.deepEqual(sent, ['Chào bạn!']);
});

test('chatOrJob: [[JOB]] means score it, anything else is the reply', async () => {
  assert.deepEqual(await chatOrJob('Need an Angular dev, $200', async () => ' [[JOB]]\n'), { job: true });
  assert.deepEqual(await chatOrJob('chào', async () => 'Chào bạn! '), { reply: 'Chào bạn!' });
  await assert.rejects(chatOrJob('chào', async () => '  '), /empty chat reply/);
});

test('chatPrompt keeps the message as typed, $ patterns included', () => {
  const p = chatPrompt('giá $& và $1 nhé');
  assert.match(p, /<message>\r?\ngiá \$& và \$1 nhé\r?\n<\/message>/);
  assert.doesNotMatch(p, /\{\{(PROFILE|MESSAGE)\}\}/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { scoreJobs, ClaudeOutputError } from '../src/claude.js';
import { makeJob } from '../src/job.js';

process.env.PROFILE_FILE = fileURLToPath(new URL('../profile.example.md', import.meta.url));

const jobs = [
  makeJob({ source: 'freelancer', id: 1, title: 'Angular fix', description: 'x'.repeat(5000), budgetType: 'fixed', budgetMaxUsd: 50 }),
  makeJob({ source: 'hn', id: 2, title: 'SEEKING FREELANCER LLM' }),
];
const reply = (arr) => async () => `Here you go:\n${JSON.stringify(arr)}\nDone.`;
const good = [
  { key: 'hn:2', score: 5, reasonVi: 'Mơ hồ', proposalEn: null },
  { key: 'freelancer:1', score: 8, reasonVi: 'Hợp', proposalEn: 'Hi' },
];

test('parses JSON wrapped in prose and returns input order', async () => {
  const out = await scoreJobs(jobs, { draftMin: 7 }, reply(good));
  assert.deepEqual(out.map((s) => s.key), ['freelancer:1', 'hn:2']);
  assert.equal(out[0].proposalEn, 'Hi');
});

test('an empty array is an output error', async () => {
  await assert.rejects(scoreJobs(jobs, { draftMin: 7 }, reply([])), ClaudeOutputError);
});

test('a score outside 1-10 is an output error', async () => {
  await assert.rejects(
    scoreJobs(jobs, { draftMin: 7 }, reply([good[0], { ...good[1], score: 11 }])),
    ClaudeOutputError,
  );
});

test('a non-JSON reply is an output error', async () => {
  await assert.rejects(scoreJobs(jobs, { draftMin: 7 }, async () => 'Sorry, I cannot.'), ClaudeOutputError);
});

test('runner failure propagates', async () => {
  await assert.rejects(scoreJobs(jobs, { draftMin: 7 }, async () => { throw new Error('token expired'); }), /token expired/);
});

test('prompt holds the profile, every key, the threshold, and trimmed descriptions', async () => {
  let prompt = '';
  await scoreJobs(jobs, { draftMin: 7 }, async (p) => { prompt = p; return JSON.stringify(good); });
  assert.match(prompt, /ExampleShop/);
  assert.match(prompt, /freelancer:1/);
  assert.match(prompt, /hn:2/);
  assert.match(prompt, /score >= 7/);
  assert.equal(prompt.includes('x'.repeat(3001)), false);
  assert.ok(prompt.includes('x'.repeat(3000)));
});

test('no jobs means no Claude call', async () => {
  const out = await scoreJobs([], { draftMin: 7 }, async () => { throw new Error('should not run'); });
  assert.deepEqual(out, []);
});

test('links in proposals outside the allowlist are removed', async () => {
  const injected = [
    { key: 'hn:2', score: 5, reasonVi: 'x', proposalEn: null },
    { key: 'freelancer:1', score: 8, reasonVi: 'x', proposalEn: 'See https://evil.example/pay and https://github.com/maiyozkyo/claude-agent-office, also www.evil.example' },
  ];
  const [out] = await scoreJobs(jobs, { draftMin: 7 }, async () => JSON.stringify(injected));
  assert.doesNotMatch(out.proposalEn, /evil/);
  assert.match(out.proposalEn, /github\.com\/maiyozkyo\/claude-agent-office/);
  assert.match(out.proposalEn, /\[link bị xóa\]/);
});

test('a string score is coerced and a missing job comes back null', async () => {
  const out = await scoreJobs(jobs, { draftMin: 7 }, reply([{ ...good[1], score: '8' }]));
  assert.equal(out[0].score, 8);
  assert.equal(out[1], null);
});

test('emails and phone numbers in proposals are removed', async () => {
  const out = await scoreJobs(jobs, { draftMin: 7 }, reply([
    { ...good[1], proposalEn: 'Mail me at bob@evil.example or WhatsApp +84 912 345 678.' }, good[0],
  ]));
  assert.doesNotMatch(out[0].proposalEn, /bob@|912/);
});

test('hours become a bid suggestion; bad hours are ignored', async () => {
  const out = await scoreJobs(jobs, { draftMin: 7, rate: 20, hoursPerDay: 2 }, reply([
    { key: 'freelancer:1', score: 8, reasonVi: 'Hợp', proposalEn: 'Hi', hours: 2 },
    { key: 'hn:2', score: 5, reasonVi: 'x', proposalEn: null, hours: 'lots' },
  ]));
  assert.equal(out[0].hours, 2);
  assert.equal(out[0].bid.amountUsd, 40);
  assert.equal(out[1].hours, null);
  assert.equal(out[1].bid, null);
});

test('milestone names get amounts from the bid; links and extra names are dropped', async () => {
  const out = await scoreJobs(jobs, { draftMin: 7, rate: 20, hoursPerDay: 2 }, reply([
    { key: 'freelancer:1', score: 8, reasonVi: 'Hợp', proposalEn: 'Hi', hours: 2,
      milestonesEn: ['Fixed charts\nsee https://evil.example/x', 'Hand-over', 'Third'] },
    { key: 'hn:2', score: 5, reasonVi: 'x', proposalEn: null, milestonesEn: 'nope' },
  ]));
  assert.deepEqual(out[0].milestones, [
    { name: 'Fixed charts see [link bị xóa]', amountUsd: 16 },
    { name: 'Hand-over', amountUsd: 24 },
  ]);
  assert.deepEqual(out[1].milestones, []);
});

test('prompt asks for an hours estimate', async () => {
  let prompt = '';
  await scoreJobs(jobs, { draftMin: 7 }, async (p) => { prompt = p; return JSON.stringify(good); });
  assert.match(prompt, /"hours"/);
});

test('jobs at or above redraftMin get an Opus rewrite in one extra call; others keep the first draft', async () => {
  const both = [
    { key: 'hn:2', score: 7, reasonVi: 'Ổn', proposalEn: 'Seven draft' },
    { key: 'freelancer:1', score: 8, reasonVi: 'Hợp', proposalEn: 'Sonnet draft' },
  ];
  const calls = [];
  const run = async (prompt, opts = {}) => {
    calls.push({ prompt, model: opts.model ?? 'sonnet' });
    return calls.length === 1 ? JSON.stringify(both) : JSON.stringify([{ key: 'freelancer:1', proposalEn: 'Opus draft, see www.evil.example' }]);
  };
  const out = await scoreJobs(jobs, { draftMin: 7, redraftMin: 8 }, run);
  assert.deepEqual(calls.map((c) => c.model), ['sonnet', 'opus']);
  assert.match(calls[1].prompt, /Sonnet draft/);
  assert.doesNotMatch(calls[1].prompt, /Seven draft/, 'below redraftMin is not sent');
  assert.equal(out[0].proposalEn, 'Opus draft, see [link bị xóa]');
  assert.equal(out[0].redrafted, true);
  assert.equal(out[0].score, 8, 'score and bid stay from the first call');
  assert.equal(out[1].proposalEn, 'Seven draft');
  assert.equal(out[1].redrafted, undefined);
});

test('an Opus failure keeps the first drafts; no redraftMin means no extra call', async () => {
  let n = 0;
  const run = async () => { n++; if (n === 2) throw new Error('opus not on this plan'); return JSON.stringify(good); };
  const out = await scoreJobs(jobs, { draftMin: 7, redraftMin: 8 }, run);
  assert.equal(n, 2);
  assert.equal(out[0].proposalEn, 'Hi');
  n = 0;
  await scoreJobs(jobs, { draftMin: 7 }, run);
  assert.equal(n, 1);
});

test('summaryVi: at most 3 short clean lines; anything else is empty', async () => {
  const out = await scoreJobs(jobs, { draftMin: 7 }, reply([
    { ...good[1], summaryVi: ['Dựng store\ntheme free', 'Xem https://evil.example/x, mail bob@evil.example', ' ', 'x'.repeat(300), 'dòng thừa'] },
    { ...good[0], summaryVi: 'không phải mảng' },
  ]));
  assert.deepEqual(out[0].summaryVi, ['Dựng store theme free', 'Xem [link bị xóa], mail [email bị xóa]', 'x'.repeat(110)]);
  assert.deepEqual(out[1].summaryVi, []);
});

test('todoVi: cleaned like summaryVi; missing is empty', async () => {
  const out = await scoreJobs(jobs, { draftMin: 7 }, reply([
    { ...good[1], todoVi: ['Sửa theme\nDawn', 'Xem https://evil.example/x', 'a', 'b'] },
    { ...good[0] },
  ]));
  assert.deepEqual(out[0].todoVi, ['Sửa theme Dawn', 'Xem [link bị xóa]', 'a']);
  assert.deepEqual(out[1].todoVi, []);
});

test('the scoring prompt asks for summaryVi', async () => {
  let prompt = '';
  await scoreJobs(jobs, { draftMin: 7 }, async (p) => { prompt = p; return JSON.stringify(good); });
  assert.match(prompt, /`summaryVi`/);
});

test('dollar signs in job text reach the prompt as typed', async () => {
  let prompt = '';
  const description = "Budget $150, pattern $& and $' and $` end";
  const job = makeJob({ source: 'freelancer', id: 9, title: 'Regex fix', description });
  await scoreJobs([job], { draftMin: 7 }, async (p) => { prompt = p; return JSON.stringify([{ key: job.key, score: 5 }]); });
  assert.ok(prompt.includes(JSON.stringify(description)));
  assert.doesNotMatch(prompt, /\{\{JOBS\}\}/);
});

test('Vietnamese boards: price in VND from the hours, rounded to 50k, and no Opus rewrite', async () => {
  const vn = makeJob({ source: 'vlance', id: 9, title: 'Viết 10 bài SEO' });
  const calls = [];
  const run = async (prompt, opts) => { calls.push(opts); return JSON.stringify([{ key: 'vlance:9', score: 9, reasonVi: 'Hợp', proposalEn: 'Chào anh/chị', hours: 2.6 }]); };
  const [s] = await scoreJobs([vn], { draftMin: 7, redraftMin: 8, vnHourlyVnd: 200000 }, run);
  assert.equal(s.priceVnd, 500000);
  assert.equal(s.bid, null);
  assert.equal(calls.length, 1, 'no Opus redraft for a Vietnamese proposal');
  const [none] = await scoreJobs([vn], { draftMin: 7, vnHourlyVnd: 200000 }, async () => JSON.stringify([{ key: 'vlance:9', score: 3, reasonVi: 'x', hours: null }]));
  assert.equal(none.priceVnd, null);
  const one = (extra) => scoreJobs([vn], { draftMin: 7, vnHourlyVnd: 200000 }, async () => JSON.stringify([{ key: 'vlance:9', score: 8, hours: 1.5, ...extra }]));
  assert.equal((await one({ budgetVnd: 620000 }))[0].priceVnd, 600000, 'stated budget wins, rounded to 50k');
  assert.equal((await one({ budgetVnd: 'không rõ' }))[0].priceVnd, 300000, 'no usable budget: hours x rate');
  const [fl] = await scoreJobs([jobs[0]], { draftMin: 7, vnHourlyVnd: 200000 }, async () => JSON.stringify([{ key: 'freelancer:1', score: 8, hours: 2, budgetVnd: 900000 }]));
  assert.equal(fl.priceVnd, null, 'only on the Vietnamese boards');
});

test('the draft rule names the lower Vietnamese-board threshold when given', async () => {
  let prompt = '';
  await scoreJobs(jobs, { draftMin: 7, vnDraftMin: 6 }, async (p) => { prompt = p; return JSON.stringify(good); });
  assert.match(prompt, /score >= 7 \(Vietnamese boards: score >= 6\)/);
  await scoreJobs(jobs, { draftMin: 7 }, async (p) => { prompt = p; return JSON.stringify(good); });
  assert.doesNotMatch(prompt, /Vietnamese boards: score >=/);
});

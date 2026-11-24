import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterJob, isUrgent } from '../src/filter.js';
import { loadConfig, makeJob } from '../src/job.js';

const config = loadConfig();
const fl = (over) => makeJob({
  source: 'freelancer', id: 1, title: 'Angular dashboard fix', description: '',
  budgetType: 'fixed', budgetMaxUsd: 50, bidCount: 3, ...over,
});
const board = (source, over) => makeJob({
  source, id: 2, title: 'Angular developer', description: 'Contract role', ...over,
});
const keep = (job) => filterJob(job, config).keep;

test('fixed budget floor is $30', () => {
  assert.equal(keep(fl({ budgetMaxUsd: 29.99 })), false);
  assert.equal(keep(fl({ budgetMaxUsd: 30 })), true);
});

test('hourly floor is $15/h', () => {
  assert.equal(keep(fl({ budgetType: 'hourly', budgetMaxUsd: 14 })), false);
  assert.equal(keep(fl({ budgetType: 'hourly', budgetMaxUsd: 15 })), true);
});

test('a converted INR budget of $132 passes', () => {
  assert.equal(keep(fl({ budgetMaxUsd: 132.73 })), true);
});

test('unknown Freelancer budget is dropped', () => {
  assert.equal(keep(fl({ budgetMaxUsd: null })), false);
});

test('block keywords drop the job', () => {
  const r = filterJob(fl({ title: 'Sales partner, Angular' }), config);
  assert.equal(r.keep, false);
  assert.match(r.reason, /sales/);
});

test('short keywords match whole tokens only', () => {
  assert.equal(keep(fl({ title: 'Java developer' })), false);
  assert.equal(keep(fl({ title: 'Need help in C programming' })), false);
  assert.equal(keep(fl({ title: 'Fix my C# API' })), true);
  assert.equal(keep(fl({ title: 'ASP.NET Core bug' })), true);
  assert.equal(keep(fl({ title: 'Upgrade .NET 8 app' })), true);
  assert.equal(keep(fl({ title: 'Salesforce expert' })), false); // no stack match
});

test('bid count above 30 is dropped', () => {
  assert.equal(keep(fl({ bidCount: 31 })), false);
  assert.equal(keep(fl({ bidCount: 30 })), true);
});

test('remote boards need an open or Asia location', () => {
  assert.equal(keep(board('remoteok', { location: 'USA only' })), false);
  assert.equal(keep(board('remoteok', { location: 'Worldwide' })), true);
  assert.equal(keep(board('wwr', { location: 'Anywhere in the World' })), true);
  assert.equal(keep(board('himalayas', { location: null })), true);
});

test('full-time board jobs need contract or part-time wording', () => {
  assert.equal(keep(board('himalayas', { employmentType: 'Full Time', description: 'Great team' })), false);
  assert.equal(keep(board('himalayas', { employmentType: 'Full Time', description: 'contract to hire' })), true);
  assert.equal(keep(board('himalayas', { employmentType: 'Contractor', description: '' })), true);
});

test('HN needs only a stack match', () => {
  assert.equal(keep(makeJob({ source: 'hn', id: 3, title: 'SEEKING FREELANCER | LLM agent' })), true);
  assert.equal(keep(makeJob({ source: 'hn', id: 4, title: 'SEEKING FREELANCER | iOS app' })), false);
});

test('urgent sources are Freelancer and HN', () => {
  assert.equal(isUrgent(fl({})), true);
  assert.equal(isUrgent(makeJob({ source: 'hn', id: 1 })), true);
  assert.equal(isUrgent(board('wwr', {})), false);
});

test('block keywords only look at the title and tags', () => {
  assert.equal(keep(fl({ title: 'Angular dashboard', description: 'Show daily sales and email verification from our .NET API' })), true);
  assert.equal(keep(fl({ title: 'Angular dashboard', tags: ['Sales'] })), false);
});

test('a plain "Remote" location counts as open', () => {
  assert.equal(keep(board('remoteok', { location: 'Remote' })), true);
});

test('plural and ChatGPT forms of AI keywords match', () => {
  assert.equal(keep(fl({ title: 'Integrate LLMs into our app' })), true);
  assert.equal(keep(fl({ title: 'ChatGPT integration' })), true);
});

test('Remotive and Jobicy follow the remote-board rules', () => {
  for (const source of ['remotive', 'jobicy']) {
    assert.equal(keep(board(source, { location: 'USA' })), false, `${source}: US-only`);
    assert.equal(keep(board(source, { location: 'Worldwide', employmentType: 'full_time', description: '' })), false, `${source}: full-time`);
    assert.equal(keep(board(source, { location: 'Anywhere', employmentType: 'Contract' })), true, `${source}: open contract`);
    assert.equal(isUrgent(board(source)), false);
  }
});

test('work Claude can do beyond code passes the keyword filter', () => {
  for (const title of ['Translate app from English to Vietnamese', 'Google Sheets automation', 'Clean and merge CSV data', 'Web scraping product prices', 'Write API documentation', 'Extract tables from PDF to Excel']) {
    assert.equal(keep(fl({ title })), true, title);
  }
});

test('academic cheating and manual data entry stay blocked', () => {
  assert.equal(keep(fl({ title: 'Write my essay on Excel history' })), false);
  assert.equal(keep(fl({ title: 'Data entry from PDF to Excel' })), false);
});

test('a "Data Entry" tag alone does not block Excel cleanup', () => {
  assert.equal(keep(fl({ title: 'Excel Data Cleanup Expert', tags: ['Excel', 'Data Entry'] })), true);
  assert.equal(keep(fl({ title: 'Excel data entry, 150 pages', tags: ['Excel'] })), false);
});

test('long keywords match at a word start: "excellent" is not Excel', () => {
  assert.equal(keep(fl({ title: 'Office assistant', description: 'Excellent communication skills' })), false);
  assert.equal(keep(fl({ title: 'Office assistant', description: 'Build reports in Excel' })), true);
});

test('junk clients are dropped with the reason; a new client with no history is kept', () => {
  const NOW = 1795000000;
  const ok = { paymentVerified: true, depositMade: true, registeredAt: NOW - 400 * 86400, reviews: 5, rating: 4.8, completed: 5 };
  const why = (c) => filterJob(fl({ client: { ...ok, ...c } }), config, NOW).reason;
  assert.equal(why({ paymentVerified: false }), 'client: payment not verified');
  assert.equal(why({ depositMade: false, registeredAt: NOW - 2 * 86400 }), 'client: no deposit, new account');
  assert.equal(why({ rating: 3.5, reviews: 4 }), 'client: rated below 4');
  assert.equal(filterJob(fl({ client: { ...ok, depositMade: false } }), config, NOW).keep, true, 'no deposit on an old account stays');
  assert.equal(filterJob(fl({ client: { ...ok, reviews: 0, completed: 0, rating: 0, registeredAt: NOW - 86400 } }), config, NOW).keep, true, 'new verified client stays');
  assert.equal(keep(fl()), true, 'no record, no drop');
});

test('FreelancerViet: Vietnamese keywords count only for that board, and it alerts at once', () => {
  const vn = (over) => makeJob({ source: 'freelancerviet', id: 3, title: 'Làm landing page cho shop', description: '', ...over });
  assert.equal(keep(vn()), true);
  assert.equal(keep(vn({ title: 'Dịch thuật tài liệu', description: 'Tiếng Anh sang tiếng Việt' })), true);
  assert.equal(keep(vn({ title: 'Gõ văn bản', description: 'Gõ lại tài liệu' })), false);
  assert.equal(keep(board('wwr', { title: 'Làm landing page', description: 'Contract' })), false);
  // NFD text from a copy-paste still matches
  assert.equal(keep(vn({ title: 'Dịch thuật'.normalize('NFD') })), true);
  assert.equal(isUrgent(vn()), true);
});

test('vLance: Vietnamese keywords too; account verification jobs are dropped', () => {
  const vl = (over) => makeJob({ source: 'vlance', id: 4, title: 'Thiết kế lập trình website', description: '', ...over });
  assert.equal(keep(vl()), true);
  assert.equal(keep(vl({ title: 'Cần người hỗ trợ xác minh tài khoản công cụ AI Claude' })), false);
  assert.equal(isUrgent(vl()), true);
});

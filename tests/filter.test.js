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

test('fixed budget floor is $15', () => {
  assert.equal(keep(fl({ budgetMaxUsd: 14.99 })), false);
  assert.equal(keep(fl({ budgetMaxUsd: 15 })), true);
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

test('bid count above 45 is dropped', () => {
  assert.equal(keep(fl({ bidCount: 46 })), false);
  assert.equal(keep(fl({ bidCount: 45 })), true);
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

test('junk clients are dropped with the reason; unverified payment and a new client with no history are kept', () => {
  const NOW = 1795000000;
  const ok = { paymentVerified: true, depositMade: true, registeredAt: NOW - 400 * 86400, reviews: 5, rating: 4.8, completed: 5 };
  const why = (c) => filterJob(fl({ client: { ...ok, ...c } }), config, NOW).reason;
  assert.equal(filterJob(fl({ client: { ...ok, paymentVerified: false } }), config, NOW).keep, true, 'unverified payment stays (scored one lower)');
  assert.equal(why({ paymentVerified: false, depositMade: false, registeredAt: NOW - 2 * 86400 }), 'client: no deposit, new account');
  assert.equal(why({ depositMade: false, registeredAt: NOW - 2 * 86400 }), 'client: no deposit, new account');
  assert.equal(why({ rating: 3.5, reviews: 4 }), 'client: rated below 4');
  assert.equal(filterJob(fl({ client: { ...ok, depositMade: false } }), config, NOW).keep, true, 'no deposit on an old account stays');
  assert.equal(filterJob(fl({ client: { ...ok, reviews: 0, completed: 0, rating: 0, registeredAt: NOW - 86400 } }), config, NOW).keep, true, 'new verified client stays');
  assert.equal(keep(fl()), true, 'no record, no drop');
});

test('Vietnamese boards: no keyword gate (Claude scores every job), block words still apply', () => {
  const vn = (source, over) => makeJob({ source, id: 3, title: 'Viết bài chuẩn SEO', description: '', ...over });
  assert.equal(keep(vn('freelancerviet')), true);
  assert.equal(keep(vn('vlance', { title: 'Thiết kế slide thuyết trình' })), true);
  assert.equal(keep(vn('vlance', { title: 'Cần người hỗ trợ xác minh tài khoản công cụ AI Claude' })), false);
  assert.equal(keep(vn('freelancerviet', { title: 'Xác minh tài khoản'.normalize('NFD') })), false);
  assert.equal(keep(board('wwr', { title: 'Viết bài chuẩn SEO', description: 'Contract' })), false);
  assert.equal(isUrgent(vn('freelancerviet')), true);
  assert.equal(isUrgent(vn('vlance')), true);
});

test('QA, website audit and product upload jobs pass the keyword gate', () => {
  for (const title of ['QA tester for our web app', 'Manual testing of checkout flow', 'Website accessibility audit (WCAG 2.1)', 'Improve PageSpeed and Core Web Vitals', 'Find broken links on our site', 'Playwright end-to-end tests', 'Shopify product upload from CSV']) {
    assert.equal(keep(fl({ title })), true, title);
  }
  // whole words only: "qa" does not hit "Qatar"
  assert.equal(keep(fl({ title: 'Logo for a Qatar bakery' })), false);
});

test('code-based web design jobs pass the gate', () => {
  assert.equal(keep(fl({ title: 'Landing page for my SaaS' })), true);
  assert.equal(keep(fl({ title: 'Convert Figma to HTML', description: 'pixel perfect' })), true);
  assert.equal(keep(fl({ title: 'Website redesign', description: 'restyle our portal' })), true);
  assert.equal(keep(fl({ title: 'Fix mobile layout', description: 'responsive design issues with CSS' })), true);
  assert.equal(keep(fl({ title: 'Shopify theme tweaks' })), true);
});

test('no-code builders and pure design jobs are blocked', () => {
  for (const title of ['Framer website', 'Webflow landing page', 'Wix site redesign', 'Squarespace website design',
    'Elementor landing page', 'Logo design for startup', 'Graphic designer for landing page', 'UX designer, Figma redesign']) {
    assert.equal(keep(fl({ title })), false, title);
  }
  assert.equal(keep(fl({ title: 'Logo design for bakery', tags: ['Logo Design', 'Graphic Design'] })), false);
});

test('design words in Freelancer tags do not block a coded web job', () => {
  // Real titles and tags from 26/11 (the last one also gets Illustrator and Logo Design tags).
  const jobs = [
    { title: 'Modernize Web Portal UI/UX', tags: ['PHP', 'JavaScript', 'Website Design', 'Graphic Design', 'CSS', 'HTML', 'UX / User Experience', 'UI / User Interface', 'Figma', 'Web Design'] },
    { title: 'Website UI/UX Redesign for an Existing Dating Platform', tags: ['PHP', 'Website Design', 'Graphic Design', 'User Interface / IA', 'UX / User Experience', 'UI / User Interface', 'Web Development', 'Web Design'] },
    { title: 'Corporate Website Full Modern Redesign', tags: ['Website Design', 'Graphic Design', 'User Interface / IA', 'HTML', 'UX / User Experience', 'UI / User Interface', 'Web Design', 'Illustrator', 'Logo Design'] },
  ];
  for (const j of jobs) assert.deepEqual(filterJob(fl(j), config).keep, true, j.title);
});

test('wider scope keywords keep Node, slides and writing jobs', () => {
  assert.equal(keep(fl({ title: 'Node.js Role-Based Access Control' })), true);
  assert.equal(keep(fl({ title: 'SaaS Proposal Slide Refresh', description: 'Refresh our PowerPoint deck' })), true);
  assert.equal(keep(fl({ title: 'Rewrite my CV', description: 'Tailor my resume' })), true);
  assert.equal(keep(fl({ title: 'Tracking dashboard in Excel' })), true);
});

test('short keywords match whole words only', () => {
  assert.equal(keep(fl({ title: 'Need a nodemailer expert', description: 'jsp pages and cvx files' })), false);
  assert.equal(keep(fl({ title: 'Reactive music app', description: 'node-based audio' })), true); // "node" is a word here
  assert.equal(keep(fl({ title: 'Reactive music app', description: 'jsonnet cvx' })), false);
});

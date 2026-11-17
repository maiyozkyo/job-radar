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

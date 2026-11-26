import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchHn } from '../src/sources/hn.js';
import { parseWwr } from '../src/sources/wwr.js';
import { parseRemoteOk } from '../src/sources/remoteok.js';
import { parseHimalayas } from '../src/sources/himalayas.js';
import { parseRemotive } from '../src/sources/remotive.js';
import { parseJobicy } from '../src/sources/jobicy.js';
import { fetchAll } from '../src/sources/index.js';

const read = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const json = (name) => JSON.parse(read(name));
const NOW = 1794300000;

const hnItems = json('hn-items.json');
const hnFetch = async (url) => {
  if (url.includes('hn.algolia.com')) return ok(json('hn-search.json'));
  const id = url.match(/item\/(\d+)\.json/)[1];
  return ok(hnItems[id]);
};
function ok(body, text) {
  return { ok: true, status: 200, json: async () => body, text: async () => text ?? JSON.stringify(body) };
}

test('HN: reads the busiest recent thread and keeps only SEEKING FREELANCER', async () => {
  const jobs = await fetchHn(hnFetch, NOW);
  assert.deepEqual(jobs.map((j) => j.key), ['hn:1', 'hn:4']);
  assert.equal(jobs[0].url, 'https://news.ycombinator.com/item?id=1');
  assert.equal(jobs[0].title, 'SEEKING FREELANCER | Remote | Angular + .NET');
  assert.equal(jobs[0].budgetType, 'unknown');
  assert.match(jobs[1].description, /Python & LLM/);
});

test('WWR: parses items with region as location', () => {
  const jobs = parseWwr(read('wwr.xml'));
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].key, 'wwr:https://weworkremotely.com/remote-jobs/lemon-io-senior-angular-developer');
  assert.equal(jobs[0].location, 'Anywhere in the World');
  assert.match(jobs[0].description, /Contract role/);
  assert.ok(jobs[0].postedAt > 0);
});

test('RemoteOK: skips the legal element and treats salary 0 as unknown', () => {
  const jobs = parseRemoteOk(json('remoteok.json'));
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].key, 'remoteok:1130001');
  assert.equal(jobs[0].budgetMinUsd, null);
  assert.equal(jobs[0].budgetMaxUsd, 60000);
  assert.deepEqual(jobs[0].tags, ['angular', 'typescript']);
});

test('Himalayas: maps employment type, location and USD-only salary', () => {
  const [a, b] = parseHimalayas(json('himalayas.json'));
  assert.equal(a.key, 'himalayas:https://himalayas.app/companies/fable/jobs/se-contract');
  assert.equal(a.location, null);
  assert.equal(a.employmentType, 'Contractor');
  assert.equal(a.budgetMaxUsd, 70);
  assert.equal(b.location, 'Canada, USA');
  assert.equal(b.budgetMaxUsd, null); // CAD, not converted
});

const allFetch = (overrides = {}) => async (url) => {
  for (const [host, res] of Object.entries(overrides)) if (url.includes(host)) return res;
  if (url.includes('freelancer.com')) return ok(json('freelancer.json'));
  if (url.includes('weworkremotely')) return ok(null, read('wwr.xml'));
  if (url.includes('himalayas')) return ok(json('himalayas.json'));
  if (url.includes('remoteok.com')) return ok(json('remoteok.json'));
  if (url.includes('remotive.com')) return ok(json('remotive.json'));
  if (url.includes('jobicy.com')) return ok(json('jobicy.json'));
  if (url.includes('freelancerviet.vn')) return ok(null, read('freelancerviet.xml'));
  if (url.includes('vlance.vn')) return ok(null, read('vlance.xml'));
  return hnFetch(url);
};

test('fetchAll: one source down does not stop the others', async () => {
  const down = { ok: false, status: 403, json: async () => ({}), text: async () => '' };
  const { jobs, errors } = await fetchAll({ freelancerQueries: ['angular'] }, allFetch({ 'remoteok.com': down }), NOW);
  assert.deepEqual(errors, ['remoteok: HTTP 403']);
  const sources = new Set(jobs.map((j) => j.source));
  assert.deepEqual([...sources].sort(), ['freelancer', 'freelancerviet', 'himalayas', 'hn', 'jobicy', 'remotive', 'vlance', 'wwr']);
});

test('Remotive: company in title, location and job type kept, link back to Remotive', () => {
  const [a, b] = parseRemotive(json('remotive.json'));
  assert.equal(a.key, 'remotive:2070001');
  assert.equal(a.url, 'https://remotive.com/remote-jobs/writing/technical-writer-2070001');
  assert.equal(a.title, 'Acme: Technical Writer (API docs)');
  assert.equal(a.location, 'Worldwide');
  assert.equal(a.employmentType, 'contract');
  assert.deepEqual(a.tags, ['Writing', 'documentation', 'api']);
  assert.match(a.description, /API docs/);
  assert.ok(a.postedAt > 0);
  assert.equal(b.title, 'Rails Engineer');
  assert.equal(b.employmentType, 'full_time');
});

test('Jobicy: maps title, geo, job type and industry', () => {
  const [a, b] = parseJobicy(json('jobicy.json'));
  assert.equal(a.key, 'jobicy:162700');
  assert.equal(a.url, 'https://jobicy.com/jobs/162700-vietnamese-translator');
  assert.equal(a.title, 'LinguaCo: English to Vietnamese Translator');
  assert.equal(a.location, 'Anywhere');
  assert.equal(a.employmentType, 'Contract');
  assert.deepEqual(a.tags, ['Content & Editorial']);
  assert.match(a.description, /English to Vietnamese/);
  assert.equal(b.employmentType, 'Full-Time');
});

test('fetchAll: Remotive and Jobicy are rate-limited per their API terms', async () => {
  const calls = [];
  const fetchFn = async (url) => { calls.push(url); return allFetch()(url); };
  const lastFetch = { remotive: NOW - 3600, jobicy: NOW - 3 * 3600 };
  const { okSources } = await fetchAll({ freelancerQueries: ['angular'] }, fetchFn, NOW, lastFetch);
  assert.ok(!calls.some((u) => u.includes('remotive.com')), 'Remotive asked again within 6 h');
  assert.ok(calls.some((u) => u.includes('jobicy.com')));
  assert.ok(!okSources.includes('remotive'));
  assert.equal(lastFetch.remotive, NOW - 3600);
  assert.equal(lastFetch.jobicy, NOW);
});

test('fetchAll: Jobicy waits a little over an hour between calls', async () => {
  const ask = async (ago) => {
    const calls = [];
    const fetchFn = async (url) => { calls.push(url); return allFetch()(url); };
    await fetchAll({ freelancerQueries: ['angular'] }, fetchFn, NOW, { remotive: NOW, jobicy: NOW - ago });
    return calls.some((u) => u.includes('jobicy.com'));
  };
  assert.equal(await ask(3600), false, 'exactly one hour is too soon: keep a margin');
  assert.equal(await ask(62 * 60), true);
});

test('fetchAll: a failed rate-limited source still waits before the next try', async () => {
  const down = { ok: false, status: 500, json: async () => ({}), text: async () => '' };
  const lastFetch = {};
  const { errors } = await fetchAll({ freelancerQueries: ['angular'] }, allFetch({ 'jobicy.com': down }), NOW, lastFetch);
  assert.deepEqual(errors, ['jobicy: HTTP 500']);
  assert.equal(lastFetch.jobicy, NOW);
});

test('FreelancerViet: parses the RSS feed, content over description, slug as id', async () => {
  const { parseFreelancerViet } = await import('../src/sources/vnboards.js');
  const [a, b] = parseFreelancerViet(read('freelancerviet.xml'));
  assert.equal(a.key, 'freelancerviet:web-landing-page-cho-shop-nho');
  assert.equal(a.url, 'https://freelancerviet.vn/thong-tin-viec-freelance/web-landing-page-cho-shop-nho.html');
  assert.equal(a.title, 'web/landing page cho shop nhỏ');
  assert.match(a.description, /landing page bán hàng & form đặt hàng\nNgân sách 3 triệu/);
  assert.equal(a.postedAt, Math.floor(Date.parse('2026-11-17T22:53:38+07:00') / 1000));
  assert.equal(a.location, 'Việt Nam');
  assert.equal(b.description, 'Gõ lại tài liệu');
});

test('vLance: parses the RSS feed with its numeric job id', async () => {
  const { parseVlance } = await import('../src/sources/vnboards.js');
  const [a] = parseVlance(read('vlance.xml'));
  assert.equal(a.key, 'vlance:94900');
  assert.equal(a.url, 'https://www.vlance.vn/viec-freelance/thiet-ke-lap-trinh-website-tren-wordpress');
  assert.match(a.description, /Ngân sách: 5 triệu/);
  assert.equal(a.location, 'Việt Nam');
});

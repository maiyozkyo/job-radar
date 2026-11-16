import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchHn } from '../src/sources/hn.js';
import { parseWwr } from '../src/sources/wwr.js';
import { parseRemoteOk } from '../src/sources/remoteok.js';
import { parseHimalayas } from '../src/sources/himalayas.js';
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

test('fetchAll: one source down does not stop the others', async () => {
  const fetchFn = async (url) => {
    if (url.includes('remoteok.com')) return { ok: false, status: 403, json: async () => ({}), text: async () => '' };
    if (url.includes('freelancer.com')) return ok(json('freelancer.json'));
    if (url.includes('weworkremotely')) return ok(null, read('wwr.xml'));
    if (url.includes('himalayas')) return ok(json('himalayas.json'));
    return hnFetch(url);
  };
  const { jobs, errors } = await fetchAll({ freelancerQueries: ['angular'] }, fetchFn, NOW);
  assert.deepEqual(errors, ['remoteok: HTTP 403']);
  const sources = new Set(jobs.map((j) => j.source));
  assert.deepEqual([...sources].sort(), ['freelancer', 'himalayas', 'hn', 'wwr']);
});

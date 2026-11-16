import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseFreelancer, fetchFreelancer } from '../src/sources/freelancer.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/freelancer.json', import.meta.url)));
const config = { freelancerQueries: ['angular', 'docker'] };
const okResponse = (body) => ({ ok: true, status: 200, json: async () => body });

test('converts a non-USD budget with exchange_rate', () => {
  const [inr] = parseFreelancer(fixture);
  assert.equal(inr.key, 'freelancer:40816417');
  assert.equal(inr.budgetMaxUsd, 1061.8);
  assert.equal(inr.budgetMinUsd, 132.73);
  assert.equal(inr.url, 'https://www.freelancer.com/projects/angular/Angular-dashboard-fix');
  assert.equal(inr.bidCount, 6);
  assert.equal(inr.postedAt, 1794564778);
  assert.deepEqual(inr.tags, ['Angular', 'TypeScript']);
});

test('hourly job keeps type and falls back to preview_description', () => {
  const hourly = parseFreelancer(fixture)[1];
  assert.equal(hourly.budgetType, 'hourly');
  assert.equal(hourly.budgetMaxUsd, 25);
  assert.equal(hourly.description, 'Build an ASP.NET Core API');
});

test('missing exchange_rate gives null budget', () => {
  const eur = parseFreelancer(fixture)[2];
  assert.equal(eur.budgetMaxUsd, null);
  assert.equal(eur.budgetMinUsd, null);
});

test('the same project from two queries is returned once', async () => {
  const fetchFn = async () => okResponse(fixture);
  const jobs = await fetchFreelancer(config, fetchFn);
  assert.equal(jobs.length, 3);
});

test('a failing query does not stop the others', async () => {
  const fetchFn = async (url) => {
    if (url.includes('query=angular')) throw new Error('boom');
    return okResponse(fixture);
  };
  const jobs = await fetchFreelancer(config, fetchFn);
  assert.equal(jobs.length, 3);
});

test('all queries failing rejects so the source is reported', async () => {
  const fetchFn = async () => ({ ok: false, status: 403, json: async () => ({}) });
  await assert.rejects(fetchFreelancer(config, fetchFn), /403/);
});

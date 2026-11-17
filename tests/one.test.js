import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertOne, projectApiUrl } from '../src/one.js';

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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { riskFlags } from '../src/risk.js';
import { filterJob } from '../src/filter.js';
import { formatAlert } from '../src/telegram.js';
import { loadConfig, makeJob } from '../src/job.js';

const job = (description, title = 'Angular dashboard') => makeJob({
  source: 'freelancer', id: 1, title, description, budgetType: 'fixed', budgetMaxUsd: 100, bidCount: 1,
});
const levels = (text) => riskFlags(job(text)).map((f) => f.level);

test('a plain job has no flags', () => {
  assert.deepEqual(riskFlags(job('Fix charts in our Angular 17 admin panel.')), []);
});

test('fake-interview repo tasks are flagged as warn', () => {
  for (const text of [
    'Clone our repo https://github.com/acme/test-task and run npm install',
    'Please download the project from bitbucket and run it locally',
    'Open the project in VS Code and run yarn install to start the test',
  ]) assert.deepEqual(levels(text), ['warn'], text);
});

test('off-platform contact and crypto are flagged as warn', () => {
  assert.ok(riskFlags(job('Contact me on Telegram @bob')).some((f) => f.level === 'warn'));
  assert.ok(riskFlags(job('DM me via t.me/bob')).some((f) => f.level === 'warn'));
  assert.ok(riskFlags(job('Web3 wallet integration with MetaMask')).some((f) => f.level === 'warn'));
});

test('a Telegram bot job is not off-platform contact', () => {
  assert.deepEqual(riskFlags(job('Build a Telegram bot with Claude')), []);
});

test('certain scams are blocked', () => {
  for (const text of [
    'Install AnyDesk so I can show you the work',
    'Send your seed phrase to verify the wallet',
    'Pay a $20 registration fee to start',
    'Share your account login and the verification code you receive',
  ]) assert.ok(levels(text).includes('block'), text);
});

test('blocked jobs are dropped by the filter', () => {
  const r = filterJob(job('Angular app. Install TeamViewer first.'), loadConfig());
  assert.equal(r.keep, false);
  assert.match(r.reason, /risk/);
});

test('alerts show warn flags and the safety reminder', () => {
  const j = job('Angular test task: clone https://github.com/x/y and run npm install');
  const text = formatAlert(j, null);
  assert.match(text, /🚩/);
  assert.match(text, /Không chạy code/);
});

test('shortened links, download hosts and risky files are flagged', () => {
  for (const text of [
    'Brief here: https://bit.ly/3abc',
    'Specs on https://drive.google.com/file/d/xyz',
    'Download https://mega.nz/file/abc',
    'Attached: task.zip, please review',
    'Run setup.exe to see the bug',
  ]) assert.ok(riskFlags(job(text)).some((f) => f.label.startsWith('Có link/file tải')), text);
});

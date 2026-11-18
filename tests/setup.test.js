import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyKeys, masked, authorizeUrl, chatIdFrom, codeFrom, kvIdFrom, workerUrlFrom } from '../worker/setup.mjs';

test('reads the KV id from wrangler output (toml or json style)', () => {
  const id = 'a'.repeat(32);
  assert.equal(kvIdFrom(`[[kv_namespaces]]\nbinding = "RADAR_KV"\nid = "${id}"`), id);
  assert.equal(kvIdFrom(`{ "binding": "RADAR_KV", "id": "${id}" }`), id);
  assert.equal(kvIdFrom('error'), null);
});

test('reads the workers.dev URL from deploy output', () => {
  assert.equal(workerUrlFrom('Deployed job-radar triggers\n  https://job-radar.buu.workers.dev\n  schedule: * * * * *'), 'https://job-radar.buu.workers.dev');
  assert.equal(workerUrlFrom('no url'), null);
  assert.equal(workerUrlFrom('Version Preview URL: https://3f2a9c1e-job-radar.buu.workers.dev\nDeployed job-radar triggers\n  https://job-radar.buu.workers.dev'), 'https://job-radar.buu.workers.dev');
});

test('authorize URL asks for the bid and profile scopes with the localhost redirect', () => {
  const u = new URL(authorizeUrl('123'));
  assert.equal(u.origin + u.pathname, 'https://accounts.freelancer.com/oauth/authorize');
  assert.equal(u.searchParams.get('client_id'), '123');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://localhost/callback');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('advanced_scopes'), '2 6');
});

test('code comes from the pasted redirect URL or a bare code', () => {
  assert.equal(codeFrom(' https://localhost/callback?code=abc123&state=x '), 'abc123');
  assert.equal(codeFrom('abc123'), 'abc123');
  assert.equal(codeFrom('https://localhost/callback?error=access_denied'), null);
  assert.equal(codeFrom(''), null);
});

test('chat id is the latest private chat in getUpdates', () => {
  const updates = { result: [
    { message: { chat: { id: 1, type: 'private' } } },
    { message: { chat: { id: -5, type: 'group' } } },
    { message: { chat: { id: 42, type: 'private' } } },
    { callback_query: {} },
  ] };
  assert.equal(chatIdFrom(updates), '42');
  assert.equal(chatIdFrom({ result: [] }), null);
});

test('hidden input: typing, paste markers, backspace, enter and Ctrl+C', () => {
  assert.deepEqual(applyKeys('', 'ab'), { value: 'ab', done: false });
  assert.deepEqual(applyKeys('ab', '\x1b[200~ghp_X1\x1b[201~'), { value: 'abghp_X1', done: false });
  assert.deepEqual(applyKeys('abc', '\u007f\r'), { value: 'ab', done: true });
  assert.deepEqual(applyKeys('abc', '\b'), { value: 'ab', done: false });
  assert.equal(applyKeys('x', '\u0003').cancel, true);
  assert.deepEqual(applyKeys('', 'tok\nextra'), { value: 'tok', done: true });
});

test('masked shows only the start and the length', () => {
  assert.equal(masked('github_pat_ABCDEFGHIJ'), 'github… (21 ký tự)');
});

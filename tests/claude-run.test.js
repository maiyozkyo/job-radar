import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultRunClaude } from '../src/claude.js';

const hang = fileURLToPath(new URL('./fixtures/hang.mjs', import.meta.url));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('a stuck claude is killed with its whole tree on timeout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'radar-'));
  const pidFile = join(dir, 'pid');
  try {
    await assert.rejects(defaultRunClaude('', { timeoutMs: 1500, command: 'node', args: [hang, pidFile] }), /timed out after 2s/);
    assert.ok(existsSync(pidFile), 'the stuck process started');
    // On Windows this is node under cmd.exe: the grandchild must be gone too.
    const pid = Number(readFileSync(pidFile, 'utf8'));
    for (let i = 0; i < 40 && alive(pid); i++) await wait(100);
    assert.equal(alive(pid), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

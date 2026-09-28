// Unit tests: the post-production functions against the shared vectors in test/vectors/.
// The remaining Python tools (voice-over placement and pause detection) use their shared vectors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function python() {
  if (process.env.GHOSTCAST_PYTHON) return process.env.GHOSTCAST_PYTHON;
  const names = process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];
  return names.find((p) => spawnSync(p, ['--version'], { stdio: 'ignore' }).status === 0) || 'python3';
}

test('remaining Python tools match test/vectors', () => {
  const r = spawnSync(python(), ['-m', 'unittest', 'discover', '-s', 'test/py', '-t', 'test/py'],
    { cwd: REPO, encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});

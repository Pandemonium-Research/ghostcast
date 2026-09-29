import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ghostcast.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostcast-rehearse-'));
const repo = path.join(tmp, 'repo');
const cache = path.join(tmp, 'cache');
const counter = path.join(tmp, 'counter');
let failed = false;

function run(bin, args) {
  const result = spawnSync(bin, args, { cwd: repo, encoding: 'utf8', timeout: 15 * 60_000,
    env: { ...process.env, GHOSTCAST_CACHE: cache, GHOSTCAST_TEST_COUNTER: counter }, maxBuffer: 8 * 1024 * 1024 });
  return { code: result.status, out: `${result.stdout || ''}${result.stderr || ''}`, error: result.error };
}
function good(result) { assert.equal(result.code, 0, `${result.error?.message || ''}\n${result.out}`); }
function fingerprint() {
  const status = run('git', ['status', '--porcelain=v2', '--untracked-files=all']).out;
  const refs = run('git', ['for-each-ref', '--format=%(refname) %(objectname)']).out;
  const page = crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, 'page.html'))).digest('hex');
  return { status, refs, page };
}

fs.mkdirSync(repo);
fs.writeFileSync(path.join(repo, 'page.html'), '<!doctype html><title>Demo</title><button onclick="document.querySelector(\'#result\').hidden=false">Reveal</button><p id="result" hidden>It worked</p>\n');
good(run('git', ['init', '-q']));
good(run('git', ['-c', 'user.name=Ghostcast Test', '-c', 'user.email=test@example.invalid', 'add', '.']));
good(run('git', ['-c', 'user.name=Ghostcast Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial']));
good(run(process.execPath, [CLI, 'init']));
const studio = path.join(repo, '.ghostcast');
fs.writeFileSync(path.join(studio, 'brief.md'), `---\naudience: Developers\ngoal: Show a working page\nweight: quick\ntype: how-to\ncap: 120\ndestinations: [docs]\naudio: none\npanel_share: 0.5\n---\n`);
fs.writeFileSync(path.join(studio, 'product.md'), '## What it is\nA test page.\n## How to run it\nOpen page.html.\n## Seed data\nnone needed\n## Signing in\nnone needed\n## Flows worth showing\n- Reveal a result.\n## Off limits\nnone needed\n');
fs.writeFileSync(path.join(studio, 'audio.yaml'), 'provider: none\n');
const flakyCode = `const file = process.env.GHOSTCAST_TEST_COUNTER;\nconst n = Number(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 0) + 1;\nfs.writeFileSync(file, String(n));\nif (n === 2) throw new Error('second run failed');`;
const story = { video: 'rehearsal', weight: 'quick', type: 'how-to', cap: 120, beats: [
  { id: 'intro', surface: 'panel', panel: { use: 'title', title: 'Test video' }, say: 'A demo starts.' },
  { id: 'reveal', surface: 'web', open: 'page.html', do: [{ click: 'Reveal' }], show: 'text "It worked"', say: 'The result appears.' },
  { id: 'terminal', surface: 'terminal', do: [{ run: 'echo ready' }], show: 'row "ready"', say: 'The terminal is ready.' },
  { id: 'flaky', surface: 'web', open: 'page.html', do: [{ code: flakyCode }], show: 'text "Reveal"', say: 'This action is flaky.' },
] };
fs.writeFileSync(path.join(studio, 'storyboard.yaml'), YAML.stringify(story));
const before = fingerprint();

after(() => {
  if (failed) console.log(`rehearse test kept at ${tmp}`);
  else fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});
const step = (name, fn) => test(name, () => { try { fn(); } catch (error) { failed = true; throw error; } });

step('three dry runs report a flaky beat and leave the source untouched', () => {
  const result = run(process.execPath, [CLI, 'rehearse']);
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /flaky\s+flaky \(2 of 3\): second run failed/);
  assert.match(result.out, /3 of 4 beats pass \(3 runs\)/);
  const report = JSON.parse(fs.readFileSync(path.join(studio, 'cache', 'rehearsal.json'), 'utf8'));
  assert.deepEqual(Object.keys(report), ['storyboardHash', 'at', 'runs', 'partial', 'servicesRestarted', 'beats']);
  assert.equal(report.storyboardHash, crypto.createHash('sha256').update(fs.readFileSync(path.join(studio, 'storyboard.yaml'))).digest('hex'));
  assert.equal(report.runs, 3);
  assert.equal(report.servicesRestarted, false);
  assert.equal(report.partial, false);
  assert.deepEqual(report.beats.map((beat) => beat.status), ['pass', 'pass', 'pass', 'flaky']);
  assert.deepEqual(report.beats[3].errors, ['second run failed']);
  assert.equal(report.beats[3].passes, 2);
  assert.equal(report.beats[3].reached, 3);
  assert.equal(report.beats[3].ms.length, 3);
  assert.ok(fs.existsSync(path.join(studio, 'cache', 'rehearsal', '2-flaky.png')));
  assert.deepEqual(fingerprint(), before);
});

step('all records one storyboard take segmented by beat ids', () => {
  // The code fails only on its second execution; the previous three dry runs consumed it.
  const result = run(process.execPath, [CLI, 'all']);
  good(result);
  const raw = path.join(studio, 'raw', 'storyboard');
  const log = JSON.parse(fs.readFileSync(path.join(raw, 'log.json'), 'utf8'));
  assert.deepEqual(log.filter((entry) => entry[1].startsWith('+')).map((entry) => entry[1].slice(1)), story.beats.map((beat) => beat.id));
  assert.deepEqual(fingerprint(), before);
});

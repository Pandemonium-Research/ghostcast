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
fs.writeFileSync(path.join(repo, 'page.html'), '<!doctype html><title>Demo</title><button onclick="document.querySelector(\'#result\').hidden=false">Reveal</button><p id="result" hidden>It worked</p><main><span>First finding</span><span style="margin-left:80px">Second finding</span></main><a href="next.html">Browse registry</a>\n');
fs.writeFileSync(path.join(repo, 'next.html'), '<!doctype html><title>Next</title><button onclick="document.querySelector(\'#loaded\').hidden=false">Show loaded result</button><p id="loaded" hidden>Loaded result</p>\n');
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
  assert.match(result.out, /each run starts from a fresh copy of the source; services keep running between runs/);
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
  assert.equal(fs.existsSync(path.join(studio, '.ghostcast')), false);
  assert.equal(fs.existsSync(path.join(studio, 'chrome-profile')), false);
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

step('direction keeps adjacent web shots, widens before terminal actions, and fits holds', () => {
  const directed = { ...story, beats: [
    { id: 'first', surface: 'web', open: 'page.html', show: 'text "First finding"',
      say: 'The first finding is clearly visible on this page.' },
    { id: 'second', surface: 'web', show: 'text "Second finding"',
      say: 'The second finding sits right beside the first.' },
    { id: 'command', surface: 'terminal', do: [{ run: 'echo ready' }], show: 'row "ready"',
      say: 'A terminal command confirms that the system is ready.' },
  ] };
  fs.writeFileSync(path.join(studio, 'storyboard.yaml'), YAML.stringify(directed));
  good(run(process.execPath, [CLI, 'rehearse', '--runs', '1']));
  const rehearsal = JSON.parse(fs.readFileSync(path.join(studio, 'cache', 'rehearsal.json'), 'utf8'));
  assert.deepEqual(rehearsal.beats.map((beat) => beat.status), ['pass', 'pass', 'pass']);
  assert.ok(rehearsal.beats[1].ms[0] < 3000, `second rehearsal beat took ${rehearsal.beats[1].ms[0]} ms`);

  good(run(process.execPath, [CLI, 'all']));
  const log = JSON.parse(fs.readFileSync(path.join(studio, 'raw', 'storyboard', 'log.json'), 'utf8'));
  const events = (id) => log.slice(log.findIndex((entry) => entry[1] === `+${id}`), log.findIndex((entry) => entry[1] === `-${id}`) + 1);
  for (const id of ['first', 'second']) assert.equal(events(id).filter((entry) => entry[1] === 'focus').length, 1, id);
  const firstEnd = log.findIndex((entry) => entry[1] === '-first');
  const secondEnd = log.findIndex((entry) => entry[1] === '-second');
  assert.equal(log.slice(firstEnd, secondEnd).filter((entry) => entry[1] === 'unfocus').length, 0);
  const command = events('command');
  assert.ok(command.findIndex((entry) => entry[1] === 'unfocus') < command.findIndex((entry) => entry[1] === 'show'));
  assert.equal(command.filter((entry) => entry[1] === 'unfocus').length, 1);
  for (const beat of directed.beats) {
    const entries = events(beat.id);
    const hold = entries.findIndex((entry) => entry[1] === 'hold');
    const end = entries.findIndex((entry) => entry[1] === 'holdend');
    assert.ok(hold >= 0 && end > hold, beat.id);
    assert.equal(entries.filter((entry) => entry[1] === 'hold').length, 1);
    assert.equal(entries.filter((entry) => entry[1] === 'holdend').length, 1);
    assert.deepEqual(entries[hold][2], { beat: beat.id });
    assert.equal(entries.slice(hold + 1, end).filter((entry) => ['focus', 'unfocus', 'show'].includes(entry[1])).length, 0);
    assert.ok(entries.findIndex((entry) => entry[1] === 'show') < hold);
    const shown = entries.find((entry) => entry[1] === 'show')[2];
    assert.ok(shown.text && ['x', 'y', 'w', 'h'].every((key) => Number.isFinite(shown.rect[key])), beat.id);
  }
  assert.match(events('first').find((entry) => entry[1] === 'show')[2].text, /First finding/);
  assert.match(events('second').find((entry) => entry[1] === 'show')[2].text, /Second finding/);
  assert.match(events('command').find((entry) => entry[1] === 'show')[2].text, /ready/);
  const clips = JSON.parse(fs.readFileSync(path.join(studio, 'clips', 'storyboard.json'), 'utf8'));
  for (const beat of directed.beats) {
    const fit = clips.segments.find((segment) => segment.segment === beat.id)?.fit;
    assert.ok(fit, `${beat.id} has a fit`);
    assert.ok(Math.abs(fit.output - fit.target) < 0.75, `${beat.id}: ${JSON.stringify(fit)}`);
  }
  assert.deepEqual(fingerprint(), before);
});

step('a click navigation restores the driver for the next action in the same beat', () => {
  fs.writeFileSync(path.join(studio, 'storyboard.yaml'), YAML.stringify({ ...story, beats: [
    { id: 'navigate', surface: 'web', open: 'page.html',
      do: [{ click: 'Browse registry' }, { click: 'Show loaded result' }],
      show: 'text "Loaded result"', say: 'The linked page shows its loaded result.' },
  ] }));
  good(run(process.execPath, [CLI, 'rehearse', '--runs', '1']));
  const report = JSON.parse(fs.readFileSync(path.join(studio, 'cache', 'rehearsal.json'), 'utf8'));
  assert.equal(report.beats[0].status, 'pass');
  assert.deepEqual(fingerprint(), before);
});

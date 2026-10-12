import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkTake, formatCheck, writeCheckReport } from '../src/check/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const template = JSON.parse(fs.readFileSync(path.join(here, '../templates/project/project.json'), 'utf8'));
function fixture({ story = false, config = {}, timeline = null, voice = null, facts = [], logExtra = [], storyboard = '' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostcast-check-'));
  fs.mkdirSync(path.join(root, 'raw', 'alpha'), { recursive: true });
  fs.mkdirSync(path.join(root, 'clips'), { recursive: true });
  const cfg = structuredClone(template); cfg.output.fps = 2; cfg.output.width = 1920; cfg.output.height = 1080;
  const merge = (base, add) => { for (const [key, value] of Object.entries(add)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object') merge(base[key], value);
    else base[key] = value;
  } };
  merge(cfg, config); fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify(cfg));
  const base = [[0, 'viewport', { w: cfg.viewport.width, h: cfg.viewport.height }], [1000, '+alpha'], ...logExtra,
    ...facts.map(([time, data]) => [time, 'facts', data]), [10000, '-alpha']];
  fs.writeFileSync(path.join(root, 'raw', 'alpha', 'log.json'), JSON.stringify(base));
  fs.writeFileSync(path.join(root, 'raw', 'alpha', 'frames.json'), JSON.stringify(Array.from({ length: 31 }, (_, i) => [i * .4, `${i}.jpg`])));
  fs.writeFileSync(path.join(root, 'timeline.json'), JSON.stringify(timeline || { items: [{ take: 'alpha' }] }));
  if (story) fs.writeFileSync(path.join(root, 'storyboard.yaml'), storyboard || `video: sample\ncap: 100\nweight: standard\nbeats:\n  - id: alpha\n    surface: web\n    show: text "Done"\n    say: 'We quote "Missing phrase".'\n`);
  if (voice) { fs.mkdirSync(path.join(root, 'voiceover'), { recursive: true }); fs.writeFileSync(path.join(root, 'voiceover', 'plan.json'), JSON.stringify({ pieces: voice })); }
  return root;
}
const fact = (text = 'All systems ready', px = 24) => ({ text, boxes: [{ t: text, px, x: 1, y: 1, w: 80, h: 20 }] });
const checks = (root) => checkTake(root, 'alpha', { pixels: false });

test('pure: page facts flag small text, email and identifying home path; clean facts pass', () => {
  const bad = fixture({ facts: [[4000, fact('contact jane@example.org C:\\Users\\alice\\secret sk-abcdefghijklmnop', 4)]] });
  const names = checks(bad).map((p) => p.check);
  assert.ok(names.includes('small-text')); assert.ok(names.includes('secrets'));
  const clean = fixture({ facts: [[4000, fact()]] });
  assert.deepEqual(checks(clean), []);
});

test('pure: page text under the minimum size at a wide view passes when zoomed', () => {
  const root = fixture({ facts: [[5000, fact('Tiny but framed', 8)]], logExtra: [[4000, 'focus', { x: 20, y: 20, w: 100, h: 40, zoom: 2 }]] });
  assert.ok(!checks(root).some((p) => p.check === 'small-text'));
});

test('pure: the show target has its separate 20px minimum', () => {
  const root = fixture({ facts: [[4500, fact('Done', 8)]], logExtra: [[4000, 'show', { text: 'Done', rect: { x: 1, y: 1, w: 80, h: 20 } }]] });
  assert.ok(checks(root).some((p) => p.message.includes('show target text')));
});

test('pure: a failed world check is an error, but takes without a world record are not checked', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'raw', 'alpha', 'world.json'), JSON.stringify({ untouched: false, leaks: ['secret.txt'], changed: [] }));
  assert.ok(checks(root).some((p) => p.check === 'untouched'));
  fs.rmSync(path.join(root, 'raw', 'alpha', 'world.json'));
  assert.ok(!checks(root).some((p) => p.check === 'untouched'));
});

test('pure: caption length, reading time and cross segment hold are errors and warnings', () => {
  const root = fixture({ logExtra: [[11000, '+beta'], [22000, '-beta']],
    timeline: { items: [{ take: 'alpha', captions: [
      { text: 'many words that cannot be read this quickly', from: 'alpha', at: 0, until: 10 },
      { text: 'a very long caption line that cannot possibly be read in a tiny fraction of a second', from: 'alpha', at: 0, until: .2 },
    ] }] } });
  const found = checks(root).map((p) => p.check);
  assert.ok(found.includes('caption-long')); assert.ok(found.includes('caption-read'));
});

test('pure: storyboard checks show visibility, narration duration, copy drift, panel share and cap', () => {
  const root = fixture({ story: true, config: { output: { capSeconds: 2 } }, storyboard: `video: sample\ncap: 2\npanel_share: 0.1\nbeats:\n  - id: alpha\n    surface: panel\n    show: text "Done"\n    say: 'This line quotes "Missing phrase" and has many words to be too long for this beat. This is a deliberately longer narration that should run well past the available cut duration for this single beat, because it contains enough words to make the duration exceed what the output cut can ever hold, including these extra sentences added for the fixture.'\n` });
  const found = checks(root).map((p) => p.check);
  assert.ok(found.includes('show-visible')); assert.ok(found.includes('narration-long'));
  assert.ok(found.includes('copy-drift')); assert.ok(found.includes('panel-share')); assert.ok(found.includes('cap'));
});

test('pure: classic voice placement reports a voice piece past its take', () => {
  const root = fixture({ voice: [{ clip: 'line.wav', from: 0, to: 6, take: 'alpha' }] });
  fs.writeFileSync(path.join(root, 'clips', 'alpha.json'), JSON.stringify({ duration: 1, segments: [{ segment: 'alpha', start: 0, end: 1 }] }));
  assert.ok(checks(root).some((p) => p.check === 'narration-long'));
});

test('pure: trim into movement and too many camera moves are detected', () => {
  const root = fixture({ config: { trims: { alpha: 3 }, direction: { movesPerMinute: 1 } }, logExtra: [
    [2000, 'focus', { x: 10, y: 10, w: 20, h: 20 }], [3500, 'unfocus'],
    [4000, 'focus', { x: 20, y: 20, w: 20, h: 20 }], [5000, 'unfocus'],
  ] });
  const found = checks(root).map((p) => p.check);
  assert.ok(found.includes('cut-in-move')); assert.ok(found.includes('camera-moves'));
});

test('pure: report orders errors before warnings and prints a summary', () => {
  const text = formatCheck({ problems: [
    { check: 'copy-drift', level: 'warning', take: 'alpha', at: 63, message: 'quote is absent' },
    { check: 'small-text', level: 'error', take: 'alpha', segment: 'alpha', at: 61.2, message: 'text is small' },
  ], errors: 1, warnings: 1 });
  assert.ok(text.indexOf('ERROR') < text.indexOf('WARNING'));
  assert.match(text, /1:01\.2/); assert.match(text, /1 errors, 1 warnings/);
});

test('pure: ghostcast check writes a report for a synthetic page-facts fixture', () => {
  const root = fixture({ facts: [[4000, fact('contact jane@example.org', 4)]] });
  fs.writeFileSync(path.join(root, 'raw', 'alpha', 'frames.json'), '[]');
  fs.writeFileSync(path.join(root, 'raw', 'alpha', 'world.json'), JSON.stringify({ untouched: false, leaks: ['leaked.txt'], changed: [] }));
  const cli = path.join(here, '../bin/ghostcast.mjs');
  const run = spawnSync(process.execPath, [cli, 'check', '--project', root], { encoding: 'utf8' });
  assert.equal(run.status, 1, run.stderr || run.stdout);
  const report = fs.readFileSync(path.join(root, 'out', 'check-report.md'), 'utf8');
  assert.match(report, /small-text/); assert.match(report, /secrets/); assert.match(report, /untouched/);
  assert.ok(fs.existsSync(path.join(root, 'cache', 'checks.json')));
  if (process.env.GHOSTCAST_PRINT_FIXTURE_REPORT) process.stdout.write(report);
});

test('pure: checks.json records the cut file hashes used by the report', () => {
  const root = fixture();
  const clip = path.join(root, 'clips', 'alpha.json'); fs.writeFileSync(clip, '{"duration":1}');
  const report = { problems: [], errors: 0, warnings: 0, takes: ['alpha'] };
  writeCheckReport(root, report);
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'cache', 'checks.json'), 'utf8'));
  assert.equal(saved.cut.alpha, crypto.createHash('sha256').update(fs.readFileSync(clip)).digest('hex'));
});

test('ffmpeg pixels: white frames with small text trigger empty, small text and caption-over; zoom passes', async () => {
  const make = (zoom) => {
    const root = fixture({ config: { viewport: { width: 960, height: 540, dpr: 1 }, output: { width: 1920, height: 1080, fps: 2 } },
      timeline: { items: [{ take: 'alpha', captions: [{ text: 'caption', from: 'alpha', at: 0, until: 3 }] }] },
      // Framed from the start, so no sampled second shows the ease from wide.
      logExtra: zoom ? [[0, 'focus', { x: 245, y: 495, w: 100, h: 20, zoom: 2 }]] : [] });
    const raw = path.join(root, 'raw', 'alpha');
    fs.mkdirSync(path.join(raw, 'frames'), { recursive: true });
    const image = path.join(raw, 'frames', 'sample.jpg');
    const made = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=960x540',
      '-vf', 'drawbox=x=200:y=500:w=40:h=4:color=black:t=fill,drawbox=x=120:y=480:w=720:h=4:color=black:t=fill', '-frames:v', '1', '-q:v', '2', image]);
    assert.equal(made.status, 0, made.stderr.toString());
    fs.writeFileSync(path.join(raw, 'frames.json'), JSON.stringify(Array.from({ length: 31 }, (_, i) => [i * .4, 'sample.jpg'])));
    return root;
  };
  const wide = checkTake(make(false), 'alpha');
  assert.ok(wide.some((p) => p.check === 'near-empty'), 'thin lines on a white wide view are near-empty');
  assert.ok(wide.some((p) => p.check === 'small-text' || p.check === 'near-empty'));
  assert.ok(wide.some((p) => p.check === 'caption-over'));
  assert.ok(wide.some((p) => p.check === 'frozen'));
  const zoomed = checkTake(make(true), 'alpha');
  assert.ok(!zoomed.some((p) => p.check === 'small-text' || p.check === 'near-empty'));
});

test('Chrome: a terminal opens after a page whose policy blocks inline scripts, as VS Code does', { timeout: 180_000 }, async () => {
  const root = fixture();
  const html = `<!doctype html><meta http-equiv="Content-Security-Policy" content="script-src 'unsafe-eval'"><h1>Strict page</h1>`;
  fs.writeFileSync(path.join(root, 'scene.mjs'), `export default async (h) => { await h.goto(${JSON.stringify(`data:text/html,${encodeURIComponent(html)}`)}); await h.terminal.open('.'); await h.seg('alpha', () => h.run('echo terminal-ok')); };\n`);
  fs.writeFileSync(path.join(root, 'timeline.json'), JSON.stringify({ items: [{ take: 'alpha', scene: 'scene.mjs' }] }));
  const record = spawnSync(process.execPath, [path.join(here, '../bin/ghostcast.mjs'), 'record', 'alpha', '--project', root], { encoding: 'utf8', timeout: 150_000 });
  assert.equal(record.status, 0, record.stderr || record.stdout);
});

test('Chrome: a recorded take logs page facts and ghostcast check passes', { timeout: 180_000 }, async () => {
  const root = fixture({ story: true, storyboard: `video: sample\ncap: 100\nweight: standard\nbeats:\n  - id: alpha\n    surface: web\n    say: 'All systems are ready.'\n` });
  const html = '<!doctype html><style>body{margin:0;font:32px Arial;background:repeating-linear-gradient(0deg,#f8f2dc 0 20px,#c7e4f3 20px 40px)}main{display:grid;grid-template-columns:repeat(12,1fr);gap:4px;padding:24px}i{height:42px;background:linear-gradient(135deg,#e84a5f,#355c7d)}p{grid-column:1/-1;margin:0}b{font-weight:normal;color:#355c7d}</style><main><h1>Facts driver works</h1>'
    + '<p><b>name</b><b>:&nbsp;</b><b>conventional-commit</b></p><p><b>Search</b> <b>skills</b></p>' + '<i></i>'.repeat(120) + '</main>';
  fs.writeFileSync(path.join(root, 'scene.mjs'), `export default async (h) => { await h.goto('data:text/html,${encodeURIComponent(html)}'); await h.seg('alpha', async () => { await h.sleep(2500); }); };\n`);
  fs.writeFileSync(path.join(root, 'timeline.json'), JSON.stringify({ items: [{ take: 'storyboard', scene: 'scene.mjs' }] }));
  const node = process.execPath, cli = path.join(here, '../bin/ghostcast.mjs');
  const record = spawnSync(node, [cli, 'record', 'storyboard', '--project', root], { encoding: 'utf8', timeout: 150_000 });
  assert.equal(record.status, 0, record.stderr || record.stdout);
  const log = JSON.parse(fs.readFileSync(path.join(root, 'raw', 'storyboard', 'log.json'), 'utf8'));
  const snapshot = log.find((e) => e[1] === 'facts' && e[2]?.text);
  assert.ok(snapshot, 'facts event should be present'); assert.ok(snapshot[2].boxes.some((b) => b.px >= 24));
  // Coloured tokens on one line read as that line, as an editor's syntax highlighting splits it.
  assert.match(snapshot[2].text, /^name: conventional-commit$/m);
  assert.match(snapshot[2].text, /^Search skills$/m);
  const checked = spawnSync(node, [cli, 'check', '--project', root], { encoding: 'utf8', timeout: 150_000 });
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  assert.match(checked.stdout, /0 errors, 0 warnings/);
});

test('Chrome + ffmpeg: a recorded storyboard gets beat sheets and checkable confirmations', { timeout: 240_000 }, async (t) => {
  const root = fixture();
  const studio = path.join(root, '.ghostcast'); fs.mkdirSync(studio, { recursive: true });
  const html = '<!doctype html><meta charset="utf-8"><style>body{font:32px Arial;padding:80px;background:#eef}</style><h1>Logged result: release-notes-649bc42f</h1><p>Search: release notes</p>';
  fs.writeFileSync(path.join(root, 'index.html'), html);
  fs.writeFileSync(path.join(studio, 'product.md'), '# Fixture\n');
  fs.writeFileSync(path.join(studio, 'storyboard.yaml'), `video: sample\nweight: standard\ntype: how-to\ncap: 100\nbeats:\n  - id: registry\n    surface: web\n    open: index.html\n    show: 'text "Logged result: release-notes-649bc42f"'\n    claim: The first result is visible.\n    say: The registry shows its first result.\n  - id: query\n    surface: web\n    show: 'text "Search: release notes"'\n    say: The search text stays visible.\n`);
  const cli = path.join(here, '../bin/ghostcast.mjs'), node = process.execPath;
  const all = spawnSync(node, [cli, 'all', '--project', studio], { encoding: 'utf8', timeout: 210_000 });
  assert.equal(all.status, 0, all.stderr || all.stdout);
  const source = JSON.parse(fs.readFileSync(path.join(studio, 'raw', 'storyboard', 'source.json'), 'utf8'));
  assert.match(source.storyboardHash, /^[a-f0-9]{64}$/);
  const review = spawnSync(node, [cli, 'review', 'beats', '--project', studio], { encoding: 'utf8', timeout: 90_000 });
  assert.equal(review.status, 0, review.stderr || review.stdout);
  const sheet = path.join(studio, 'out', 'review', 'beats', 'storyboard-registry.png');
  assert.ok(fs.existsSync(sheet));
  assert.deepEqual(fs.readdirSync(path.dirname(sheet)).filter((name) => name.endsWith('.png')).sort(), ['storyboard-query.png', 'storyboard-registry.png']);
  const wrong = spawnSync(node, [cli, 'confirm', 'registry', 'The result is "not on the page".', '--project', studio], { encoding: 'utf8' });
  assert.equal(wrong.status, 1); assert.match(wrong.stderr, /not found in page text.*look at the sheet again/);
  assert.ok(!fs.existsSync(path.join(studio, 'confirmations.json')));
  const right = spawnSync(node, [cli, 'confirm', 'registry', 'The result is "release-notes-649bc42f" under `release notes`.', '--project', studio], { encoding: 'utf8' });
  assert.equal(right.status, 0, right.stderr || right.stdout);
  assert.match(right.stdout, /confirmed registry/);
  assert.ok(fs.existsSync(path.join(studio, 'confirmations.json')));
});

test('pure: dissolve leaves caption length and reading checks at the same times', (t) => {
  const root = fixture({ timeline: { items: [{ take: 'alpha', captions: [
    { text: 'Read this caption', from: 'alpha', at: .3, until: 7.8 },
  ] }] } });
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const plain = checks(root);
  assert.ok(!plain.some((p) => p.check === 'caption-long' || p.check === 'caption-read'));
  const file = path.join(root, 'timeline.json'), timeline = JSON.parse(fs.readFileSync(file));
  timeline.items[0].transitions = { alpha: 'fade' };
  fs.writeFileSync(file, JSON.stringify(timeline));
  assert.deepEqual(checks(root), plain);
});

test('ffmpeg pixels: a dissolve is motion even when its incoming source is frozen', (t) => {
  const root = fixture({ config: { viewport: { width: 320, height: 180, dpr: 1 },
    output: { width: 320, height: 180, fps: 30 }, direction: { fadeSeconds: 6 } } });
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const raw = path.join(root, 'raw', 'alpha'); fs.mkdirSync(path.join(raw, 'frames'), { recursive: true });
  const made = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:d=0.1',
    '-frames:v', '1', '-y', path.join(raw, 'frames', 'sample.jpg')], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  fs.writeFileSync(path.join(raw, 'frames.json'), JSON.stringify([[0, 'sample.jpg']]));
  assert.ok(checkTake(root, 'alpha').some((p) => p.check === 'frozen'));
  fs.writeFileSync(path.join(root, 'timeline.json'), JSON.stringify({ items: [{ take: 'alpha', transitions: { alpha: 'fade' } }] }));
  assert.ok(!checkTake(root, 'alpha').some((p) => p.check === 'frozen'));
});

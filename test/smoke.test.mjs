// Smoke test: a fresh project from the template, recorded headlessly, cut, assembled, voiced and
// reviewed, end to end through the CLI. A failing take is checked too.
//
// Needs what `ghostcast doctor` checks except VS Code, which only editor scenes use: the template's
// terminal take runs in ghostcast's own terminal page. The project is made in the system temp
// directory and removed afterwards, unless a step failed (then its path is printed).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'bin', 'ghostcast.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostcast-smoke-'));
const dir = path.join(tmp, 'smoke');
let failed = false;

const gc = (...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args, '--project', dir], { encoding: 'utf8', timeout: 10 * 60_000 });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};
const ok = (r, what) => assert.equal(r.code, 0, `${what} failed:\n${r.out}`);
const file = (rel) => path.join(dir, rel);
const read = (rel) => fs.readFileSync(file(rel), 'utf8');
const json = (rel) => JSON.parse(read(rel));
const probe = (rel, entries) =>
  JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_entries', entries, '-of', 'json', file(rel)], { encoding: 'utf8' }).stdout);
const ffmpeg = (...args) => spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' });

// Steps share one project and run in order; a failure keeps the project for inspection.
const step = (name, fn) => test(name, async () => {
  try { await fn(); } catch (e) { failed = true; throw e; }
});

after(() => {
  if (failed) console.log(`smoke project kept at ${dir}`);
  else fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

step('init makes a project from the template', () => {
  ok(gc('init', dir), 'init');
});

step('all records, cuts and assembles every template take', () => {
  ok(gc('all'), 'all');
  const segments = (take) => json(`clips/${take}.json`).segments.map((s) => s.segment);
  assert.deepEqual(segments('title'), ['title_card']);
  assert.deepEqual(segments('terminal'), ['terminal_list', 'terminal_count', 'terminal_wait@fit2']);
  assert.deepEqual(segments('web'), ['web_hero', 'web_install']);

  const clips = ['title', 'terminal', 'web'].reduce((sum, take) => sum + json(`clips/${take}.json`).duration, 0);
  const info = probe('out/smoke-silent.mp4', 'stream=width,height,r_frame_rate:format=duration');
  assert.deepEqual([info.streams[0].width, info.streams[0].height, info.streams[0].r_frame_rate], [1920, 1080, '30/1']);
  const length = Number(info.format.duration);
  assert.ok(Math.abs(length - clips) < 0.15, `silent cut is ${length}s; its clips add up to ${clips}s`);
  assert.match(read('out/smoke.cues.md'), /web · web_install/);
  assert.match(read('out/smoke.cues.md'), /terminal · terminal_count/);
});

step('review writes sheets and labelled stills for a take and the final cut', () => {
  ok(gc('review', 'title', '--every', '1'), 'review take --every');
  assert.ok(fs.existsSync(file('out/review/title.png')));
  const take = gc('review', 'title', '--at', '0.2', '--at', '0.5');
  ok(take, 'review take --at');
  assert.match(take.out, /title_card/);
  assert.ok(fs.existsSync(file('out/review/title@0.2.png')));
  assert.ok(fs.existsSync(file('out/review/title@0.5.png')));
  ok(gc('review', 'final'), 'review final');
  assert.ok(fs.existsSync(file('out/review/final.png')));
  const final = gc('review', 'final', '--at', '0.2');
  ok(final, 'review final --at');
  assert.match(final.out, /title · title_card/);
  assert.ok(fs.existsSync(file('out/review/final@0.2.png')));
});

step('vo-script times the narration against the cut', () => {
  ok(gc('vo-script'), 'vo-script');
  const script = read('out/voiceover-script.md');
  assert.match(script, /fits/);
  assert.doesNotMatch(script, /too long/);
});

step('pauses finds the silence in a clip', () => {
  // A stand-in for a recorded clip: 1 s of tone, 0.6 s of silence, 1.2 s of tone.
  fs.mkdirSync(file('voiceover'), { recursive: true });
  const r = ffmpeg(
    '-f', 'lavfi', '-i', 'sine=frequency=220:duration=1:sample_rate=48000',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono',
    '-f', 'lavfi', '-i', 'sine=frequency=330:duration=1.2:sample_rate=48000',
    '-filter_complex', '[1]atrim=0:0.6[gap];[0][gap][2]concat=n=3:v=0:a=1', '-y', file('voiceover/v1.wav'));
  assert.equal(r.status, 0, r.stderr);

  const p = gc('pauses', file('voiceover/v1.wav'));
  ok(p, 'pauses');
  const m = p.out.match(/pause\s+([\d.]+)\s+–\s+([\d.]+)/);
  assert.ok(m, p.out);
  assert.ok(Math.abs(Number(m[1]) - 1.0) < 0.05 && Math.abs(Number(m[2]) - 1.6) < 0.05, p.out);
});

step('vo-mix lays the voice on its beats at broadcast loudness', () => {
  fs.writeFileSync(file('voiceover/plan.json'), JSON.stringify({
    pieces: [
      { clip: 'v1.wav', from: 0, to: 1.0, take: 'title', offset: 0.3, text: 'first' },
      { clip: 'v1.wav', from: 1.6, to: 2.8, take: 'web', segment: 'web_install', offset: 0.2, text: 'second' },
    ],
  }));
  ok(gc('vo-mix'), 'vo-mix');
  assert.match(read('out/smoke.placement.md'), /Problems: none/);

  const info = probe('out/smoke.mp4', 'stream=codec_type,channels');
  const audio = info.streams.find((s) => s.codec_type === 'audio');
  assert.ok(audio, 'no audio stream');
  assert.equal(audio.channels, 2);

  // Integrated loudness, measured independently of vo-mix's own loudnorm pass.
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file('out/smoke.mp4'), '-af', 'ebur128', '-f', 'null', '-'],
    { encoding: 'utf8' });
  const readings = [...r.stderr.matchAll(/I:\s+(-?[\d.]+) LUFS/g)];
  const lufs = Number(readings.at(-1)[1]);
  assert.ok(Math.abs(lufs + 16) <= 1, `integrated loudness ${lufs} LUFS, want -16 ± 1`);
});

step('review final uses the finished video when it exists', () => {
  const silent = file('out/smoke-silent.mp4'), held = `${silent}.held`;
  fs.renameSync(silent, held);
  try {
    ok(gc('review', 'final', '--every', '4'), 'review finished video');
    assert.ok(fs.existsSync(file('out/review/final.png')));
  } finally { fs.renameSync(held, silent); }
});

step('a failing take leaves a screenshot and is reviewable', () => {
  fs.writeFileSync(file('scenes/broken.mjs'), [
    "export async function setup(h) { await h.terminal.open('workspace'); }",
    'export default async function (h) {',
    "  await h.seg('broken_start', async () => {",
    '    await h.sleep(300);',
    "    throw new Error('planned failure');",
    '  });',
    '}',
    '',
  ].join('\n'));
  const r = gc('record', 'broken');
  assert.notEqual(r.code, 0, 'a take that throws must exit non-zero');
  assert.ok(fs.existsSync(file('raw/broken/failed.png')), r.out);
  ok(gc('review', 'broken', '--raw'), 'review --raw');
  assert.ok(fs.existsSync(file('out/review/broken.raw.png')));
});

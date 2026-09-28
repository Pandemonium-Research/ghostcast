import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { segments, smooth, view_track, box_at, windows, speed_tag, beat_plan, captionPieces } from '../src/post/logic.mjs';
import { runs, perspectiveExpressions } from '../src/post/render.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vectors');
const read = (name) => JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
const cfg = read('config'), cut = read('cut'), assemble = read('assemble');
function close(got, want) {
  if (Array.isArray(want)) { assert.equal(got.length, want.length); want.forEach((v, i) => close(got[i], v)); }
  else if (typeof want === 'number') assert.ok(Math.abs(got - want) < 1e-6, `${got} != ${want}`);
  else assert.deepEqual(got, want);
}
for (const c of cut.segments) test(`segments: ${c.name}`, () => close(segments(c.log), c.expected));
test('smooth vectors', () => { for (const [k, v] of cut.smooth) close(smooth(k), v); });
for (const c of cut.view_track) test(`view_track: ${c.name}`, () => close(view_track(c.log, ...c.src, c.dpr, cfg), c.expected));
for (const c of cut.box_at) test(`box_at: ${c.name}`, () => { for (const [t, v] of c.samples) close(box_at(c.keys, t), v); });
for (const c of assemble.windows) test(`windows: ${c.name}`, () => close(windows(c.item, c.meta), c.expected));
for (const c of assemble.windows_errors) test(`windows error: ${c.name}`, () => assert.throws(() => windows(c.item, c.meta)));
test('speed_tag vectors', () => { for (const [s, tag] of assemble.speed_tag) assert.equal(speed_tag(s), tag); });
test('tick count rounds half frames to even as Python does', () => {
  const c = { ...cfg, trims: { first: 2.5 / 30 } };
  const p = beat_plan([[200, '+first'], [1000, '-first']], [[0, 'frame.jpg']], c, 320, 180);
  assert.equal(p.beats[0].ticks.length, 2);
});
test('a caption spanning beats fades only at its own ends', () => {
  const caps = [['hello', .3, 2.2, 'bottom']];
  const pieces = [[0, 1], [1, 2], [2, 3]].map(([start, end]) => captionPieces(caps, { start, end })[0]);
  assert.deepEqual(pieces.map((p) => [p.fadeIn, p.fadeOut]), [[true, false], [false, false], [false, true]]);
  close(pieces.map((p) => [p.a, p.b]), [[.3, 1], [0, 1], [0, .2]]);
});

// A small evaluator for the ffmpeg expression subset emitted by perspectiveExpressions.
function compilePerspective(source) {
  const input = source.replace(/\\,/g, ',');
  const tokens = input.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|[A-Za-z_]+|[()+*/;,-]/gi);
  assert.equal(tokens.join(''), input.replace(/\s+/g, ''));
  let at = 0;
  const take = (v) => { if (tokens[at] !== v) throw new Error(`want ${v}, got ${tokens[at]}`); at++; };
  const primary = () => {
    const t = tokens[at++];
    if (t === '(') { const e = sum(); take(')'); return e; }
    if (t === '-') return ['neg', primary()];
    if (/^(?:\d|\.)/.test(t)) return ['number', Number(t)];
    if (t === 'in') return ['input'];
    take('(');
    const args = [];
    if (tokens[at] !== ')') { args.push(sum()); while (tokens[at] === ',') { at++; args.push(sum()); } }
    take(')');
    return [t, ...args];
  };
  const product = () => { let e = primary(); while (tokens[at] === '*' || tokens[at] === '/') { const op = tokens[at++]; e = [op, e, primary()]; } return e; };
  const sum = () => { let e = product(); while (tokens[at] === '+' || tokens[at] === '-') { const op = tokens[at++]; e = [op, e, product()]; } return e; };
  const statements = [sum()];
  while (tokens[at] === ';') { at++; statements.push(sum()); }
  assert.equal(at, tokens.length);
  return (frame) => {
    const registers = [];
    const evaluate = (e) => {
      const v = (i) => evaluate(e[i]);
      switch (e[0]) {
        case 'number': return e[1]; case 'input': return frame; case 'neg': return -v(1);
        case '+': return v(1) + v(2); case '-': return v(1) - v(2);
        case '*': return v(1) * v(2); case '/': return v(1) / v(2);
        case 'clip': return Math.max(v(2), Math.min(v(3), v(1)));
        case 'gte': return Number(v(1) >= v(2));
        case 'between': return Number(v(1) >= v(2) && v(1) <= v(3));
        case 'st': { const index = v(1), value = v(2); registers[index] = value; return value; }
        case 'ld': return registers[v(1)] ?? 0;
        default: throw new Error(`unknown operation ${e[0]}`);
      }
    };
    let result;
    for (const statement of statements) result = evaluate(statement);
    return result;
  };
}

function cameraFixture(moves, start = 0) {
  const full = [0, 0, 320, 180], keys = [[-1e18, full]];
  for (let i = 0; i < moves; i++) keys.push([.5 + i * .18,
    i % 3 === 2 ? full : [20 + i % 5 * 8, 10 + i % 7 * 5, 220 + i % 3 * 10, 124 + i % 3 * 6]]);
  const fps = 30, end = .5 + moves * .18 + 1.5, count = Math.ceil((end - start) * fps);
  const ticks = Array.from({ length: count }, (_, i) => {
    const sourceTime = start + i / fps;
    return { file: 'frame.jpg', sourceTime, box: box_at(keys, sourceTime) };
  });
  return { keys, beat: { a: start, speed: 1, fps, ticks }, rs: runs(ticks) };
}

for (const moves of [1, 8, 50]) test(`perspective corners match box_at for ${moves} camera moves`, () => {
  const { keys, beat, rs } = cameraFixture(moves, moves === 1 ? 0 : moves === 8 ? 1.2 : 3);
  const evaluators = perspectiveExpressions(rs, beat, keys).map(compilePerspective);
  let tick = 0;
  for (let i = 0; i < rs.length; i++) {
    const got = evaluators.map((evaluate) => evaluate(i + 1));
    for (let j = 0; j < rs[i].count; j++, tick++) {
      const [x, y, w, h] = box_at(keys, beat.ticks[tick].sourceTime);
      close(got, [x, y, x + w, y + h]);
    }
  }
  assert.equal(tick, beat.ticks.length);
});

test('perspective expression size is linear for 50 moves and 500 runs', () => {
  const sizes = {};
  for (const moves of [2, 8, 50]) {
    const fixture = cameraFixture(moves);
    if (moves === 50) {
      fixture.rs = Array.from({ length: 500 }, (_, i) => ({ file: `f${i}.jpg`, box: [i % 2, 0, 220, 124], count: 2 }));
      fixture.beat.ticks = Array.from({ length: 1000 }, (_, i) => ({ sourceTime: i / 30 }));
    }
    sizes[moves] = Math.max(...perspectiveExpressions(fixture.rs, fixture.beat, fixture.keys).map((s) => s.length));
    assert.ok(sizes[moves] < 200_000, `${moves} moves: ${sizes[moves]} characters`);
  }
  console.log('perspective expression maximum characters by move count:', sizes);
});

test('ffmpeg renders a synthetic take with 20 camera moves at the planned frame count', { timeout: 120000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostcast-camera-'));
  try {
    const raw = path.join(root, 'raw', 'moves'); fs.mkdirSync(path.join(raw, 'frames'), { recursive: true });
    const jpg = path.join(raw, 'frames', 'frame.jpg');
    const image = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
      'testsrc2=s=320x180:d=0.1', '-frames:v', '1', '-y', jpg], { encoding: 'utf8' });
    assert.equal(image.status, 0, image.stderr);
    const project = { name: 'moves', viewport: { width: 320, height: 180, dpr: 1 },
      output: { width: 320, height: 180, fps: 30 } };
    fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify(project));
    fs.writeFileSync(path.join(raw, 'frames.json'), JSON.stringify([[0, 'frame.jpg']]));
    const log = [[200, '+many']];
    for (let i = 0; i < 20; i++) log.push([300 + i * 180, i % 2 ? 'unfocus' : 'focus',
      { x: 40 + i % 4 * 12, y: 25, w: 80, h: 45 }]);
    log.push([4100, '-many']);
    fs.writeFileSync(path.join(raw, 'log.json'), JSON.stringify(log));
    const expected = beat_plan(log, [[0, 'frame.jpg']], project, 320, 180).beats[0].ticks.length;
    const cli = path.resolve(dir, '..', '..', 'bin', 'ghostcast.mjs');
    const render = spawnSync(process.execPath, [cli, 'cut', 'moves', '--project', root],
      { encoding: 'utf8', timeout: 120000 });
    assert.equal(render.status, 0, render.stdout + render.stderr);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=nb_frames', '-of', 'csv=p=0',
      path.join(root, 'clips', 'moves.mp4')], { encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(Number(probe.stdout.trim()), expected);
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});

test('caption edits invalidate only covered beats; assemble joins exact beat duration', { timeout: 180000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostcast-post-'));
  try {
    const raw = path.join(root, 'raw', 'demo', 'frames'); fs.mkdirSync(raw, { recursive: true });
    const jpg = path.join(raw, 'frame.jpg');
    const gen = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:d=0.1', '-frames:v', '1', '-y', jpg], { encoding: 'utf8' });
    assert.equal(gen.status, 0, gen.stderr);
    fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify({ name: 'demo', viewport: { width: 320, height: 180, dpr: 1 }, output: { width: 320, height: 180, fps: 30, capSeconds: 10 }, captions: { size: 18 } }));
    fs.writeFileSync(path.join(root, 'raw', 'demo', 'frames.json'), JSON.stringify([[0, 'frame.jpg']]));
    fs.writeFileSync(path.join(root, 'raw', 'demo', 'log.json'), JSON.stringify([
      [0, 'viewport', { w: 320, h: 180 }], [0, '+first'], [1000, '-first'],
      [1300, '+second'], [1600, 'focus', { x: 80, y: 40, w: 80, h: 50 }],
      [1800, 'focus', { x: 120, y: 60, w: 60, h: 40 }], [2100, 'unfocus'], [2300, '-second'],
    ]));
    const timeline = { items: [{ take: 'demo', captions: [{ text: 'First caption', from: 'first' }] }] };
    fs.writeFileSync(path.join(root, 'timeline.json'), JSON.stringify(timeline));
    const cli = path.resolve(dir, '..', '..', 'bin', 'ghostcast.mjs');
    const gc = (...args) => {
      const r = spawnSync(process.execPath, [cli, ...args, '--project', root], { encoding: 'utf8', timeout: 120000 });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      return r.stdout;
    };
    assert.equal((gc('cut', 'demo').match(/: rendered /g) ?? []).length, 2);
    assert.equal((gc('cut', 'demo').match(/: rendered /g) ?? []).length, 0);
    timeline.items[0].captions[0].text = 'Changed caption';
    fs.writeFileSync(path.join(root, 'timeline.json'), JSON.stringify(timeline));
    const changed = gc('assemble');
    assert.equal((changed.match(/: rendered /g) ?? []).length, 1, changed);
    assert.match(changed, /second: cache hit/);
    assert.equal((gc('cut', 'demo').match(/: rendered /g) ?? []).length, 0);
    const styled = JSON.parse(fs.readFileSync(path.join(root, 'project.json')));
    styled.captions.background = [12, 12, 12, 225];
    fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify(styled));
    const restyled = gc('assemble');
    assert.equal((restyled.match(/: rendered /g) ?? []).length, 1, restyled);
    assert.match(restyled, /second: cache hit/);
    const meta = JSON.parse(fs.readFileSync(path.join(root, 'clips', 'demo.json')));
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'clips', 'demo.beats.json')));
    const probe = (p) => {
      const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=nb_frames:format=duration', '-of', 'json', p], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout);
    };
    const beatFrames = manifest.reduce((n, p) => n + Number(probe(path.join(root, p)).streams[0].nb_frames), 0);
    const silent = probe(path.join(root, 'out', 'demo-silent.mp4'));
    assert.equal(Number(silent.streams[0].nb_frames), beatFrames);
    assert.ok(Math.abs(Number(silent.format.duration) - beatFrames / 30) <= 1 / 30);
    assert.ok(Math.abs(meta.duration - beatFrames / 30) <= 1 / 30);
    const capped = JSON.parse(fs.readFileSync(path.join(root, 'project.json')));
    capped.output.capSeconds = .1;
    fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify(capped));
    const over = spawnSync(process.execPath, [cli, 'assemble', '--project', root], { encoding: 'utf8' });
    assert.notEqual(over.status, 0);
    assert.match(over.stderr, /over the cap/);
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});

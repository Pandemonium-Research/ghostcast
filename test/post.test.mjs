import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { segments, smooth, view_track, box_at, windows, speed_tag, beat_plan, captionPieces } from '../src/post/logic.mjs';
import { runs, perspectiveExpressions } from '../src/post/render.mjs';
import { directCamera, fitSegment, fitTargets, motionIntervals } from '../src/post/fit.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vectors');
const read = (name) => JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
const cfg = read('config'), cut = read('cut'), assemble = read('assemble');
const fit = read('fit');
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

for (const c of fit.cases) test(`fitSegment: ${c.name}`, () => {
  const result = fitSegment(c);
  for (const key of ['natural', 'output', 'removed', 'speed', 'overrun', 'shortfall']) close(result[key], c[key]);
  const gaps = result.pieces.slice(1).map((p, i) => [result.pieces[i].b, p.a]).filter(([a, b]) => b - a > 1e-8);
  close(gaps.reduce((sum, [a, b]) => sum + b - a, 0), result.removed);
  for (const [a, b] of gaps) {
    const still = c.still.find((s) => a >= s.a && b <= s.b);
    assert.ok(still, `cut ${a}–${b} must be in stillness`);
    assert.ok(a - still.a >= .15 - 1e-8 && still.b - b >= .15 - 1e-8);
  }
  const protectedStill = c.still.find((s) => s.postFraming);
  if (protectedStill) {
    const retained = result.pieces.reduce((sum, p) => sum + Math.max(0,
      Math.min(p.b, protectedStill.b) - Math.max(p.a, protectedStill.a)), 0);
    assert.ok(retained >= Math.max(1.5, c.reading) - 1e-8);
  }
});

test('fitTargets reads only a storyboard take and counts say and show words', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostcast-targets-'));
  try {
    fs.writeFileSync(path.join(root, 'product.md'), '# Product\n');
    fs.writeFileSync(path.join(root, 'storyboard.yaml'), 'beats:\n  - id: claim\n    say: "One two three four five"\n');
    const log = [[200, '+claim'], [1000, 'show', { text: 'Read these three words', rect: {} }], [3000, '-claim']];
    const result = fitTargets(root, 'storyboard', log, { voiceover: { wordsPerSecond: 2.5 } });
    close(result.targets.claim, 2.6);
    close(result.readings.claim, .5 + 4 / 3);
    fs.writeFileSync(path.join(root, 'storyboard.yaml'), 'beats:\n  - id: claim\n    say: "One"\n');
    close(fitTargets(root, 'storyboard', log, { voiceover: { wordsPerSecond: 2.5 } }).targets.claim, 2);
    assert.deepEqual(fitTargets(root, 'other', log, cfg), { targets: {}, readings: {} });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('fitted targets never cut a move or jump the camera at either target', () => {
  const log = [[200, '+claim'], [2000, 'focus', { x: 80, y: 40, w: 60, h: 40 }],
    [2000, 'hold', { beat: 'claim' }], [2700, 'show', { text: 'a result', rect: {} }],
    [9000, 'holdend'], [9650, '-claim']];
  for (const target of [7, 4]) {
    const plan = beat_plan(log, [[0, 'frame.jpg']], { ...cfg, output: { fps: 30 }, zoom: { max: 2 } }, 320, 180,
      { targets: { claim: target }, readings: { claim: 1.2 } });
    const moving = motionIntervals(segments(log)[0], directCamera(log, { zoom: { max: 2 } }, 320, 180, 1)).moving;
    for (let i = 1; i < plan.beats.length; i++) {
      const a = plan.beats[i - 1].b, b = plan.beats[i].a;
      if (b - a < 1e-8) continue;
      assert.ok(moving.every((m) => b <= m.a || a >= m.b), `cut ${a}–${b} overlaps motion`);
      close(box_at(plan.keys, a), box_at(plan.keys, b));
    }
    assert.ok(plan.meta.segments[0].fit);
  }
});

test('motion intervals include margins and holds but exclude camera easing', () => {
  const log = [[200, '+claim'], [2000, 'focus', { x: 80, y: 40, w: 60, h: 40 }],
    [2000, 'hold', { beat: 'claim' }], [9000, 'holdend'], [9650, '-claim']];
  const { still, moving } = motionIntervals(segments(log)[0], log);
  close(still.map((s) => [s.a, s.b]), [[0, .2], [2.75, 9], [9.65, 10]]);
  close(moving.map((s) => [s.a, s.b]), [[.2, 2.75], [9, 9.65]]);
  assert.equal(still[1].postFraming, true);
});

test('speed tags cover only fast fitted pieces', () => {
  const log = [[200, '+claim'], [500, 'hold', { beat: 'claim' }], [1000, 'holdend'], [9650, '-claim']];
  const plan = beat_plan(log, [[0, 'frame.jpg']], { ...cfg, output: { fps: 30 } }, 320, 180,
    { targets: { claim: 4 } });
  const segment = plan.meta.segments[0];
  assert.ok(segment.pieces.some((p) => p.speed >= 1.5));
  close(windows({ take: 'storyboard' }, plan.meta), segment.pieces.filter((p) => p.speed >= 1.5)
    .map((p) => [speed_tag(p.speed), p.start, p.end, 'corner']));
  assert.ok(segment.pieces.some((p) => p.speed === 1));
});

test('directCamera removes low gain, merges close returns, and caps moves', () => {
  const conf = { zoom: { max: 3 }, direction: { minHold: 0, movesPerMinute: 2 } };
  const low = [[0, 'hold'], [1000, 'focus', { x: 0, y: 0, w: 300, h: 160 }], [4000, 'unfocus']];
  assert.deepEqual(directCamera(low, conf, 320, 180, 1).map((e) => e[1]), ['hold']);
  const closeReturn = [[0, 'hold'], [1000, 'focus', { x: 30, y: 20, w: 60, h: 30 }],
    [5000, 'unfocus'], [5200, 'focus', { x: 60, y: 30, w: 50, h: 30 }]];
  assert.deepEqual(directCamera(closeReturn, { ...conf, direction: { ...conf.direction, movesPerMinute: 12 } }, 320, 180, 1)
    .map((e) => e[1]), ['hold', 'focus', 'focus']);
  const log = [[0, 'hold'], ...[1.3, 2, 2.5, 3].map((zoom, i) => [i * 10000 + 1000, 'focus',
    { x: 30, y: 20, w: 40, h: 30, zoom }])];
  const retained = directCamera(log, conf, 320, 180, 1).filter((e) => e[1] === 'focus');
  assert.equal(retained.length, 2);
  assert.deepEqual(retained.map((e) => e[2].zoom), [2.5, 3]);
});

test('directCamera keeps a framing through a too-early unfocus or another focus', () => {
  const box = { x: 30, y: 20, w: 60, h: 30 };
  const conf = { zoom: { max: 2 } };
  const earlyReturn = [[0, 'hold'], [1000, 'focus', box], [2000, 'unfocus']];
  assert.deepEqual(directCamera(earlyReturn, conf, 320, 180, 1).map((e) => e[1]), ['hold', 'focus']);
  const earlyRefocus = [[0, 'hold'], [1000, 'focus', box], [2000, 'focus', box], [10000, 'focus', box]];
  assert.deepEqual(directCamera(earlyRefocus, conf, 320, 180, 1).map((e) => e[0]), [0, 2000, 10000]);
});

test('a hand-written segment ignores targets and keeps the original beat plan', () => {
  const log = [[200, '+one'], [1000, 'focus', { x: 40, y: 20, w: 80, h: 45 }], [3200, '-one']];
  const frames = [[0, 'frame.jpg']];
  assert.deepEqual(beat_plan(log, frames, cfg, 320, 180, { targets: { one: 2 } }),
    beat_plan(log, frames, cfg, 320, 180));
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

test('ffmpeg fits held storyboard pieces and rejects an animated still cut', { timeout: 180000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostcast-fit-'));
  try {
    const raw = path.join(root, 'raw', 'storyboard'), images = path.join(raw, 'frames');
    fs.mkdirSync(images, { recursive: true });
    for (const color of ['red', 'blue']) {
      const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
        `color=c=${color}:s=320x180:d=0.1`, '-frames:v', '1', '-y', path.join(images, `${color}.jpg`)], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
    fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify({ name: 'fit',
      viewport: { width: 320, height: 180, dpr: 1 }, output: { width: 320, height: 180, fps: 30 } }));
    fs.writeFileSync(path.join(root, 'product.md'), '# Synthetic product\n');
    fs.writeFileSync(path.join(root, 'storyboard.yaml'), 'beats:\n  - id: held\n    say: "Now see it"\n');
    const log = [[200, '+held'], [1000, 'hold', { beat: 'held' }],
      [1500, 'show', { text: 'The result', rect: { x: 30, y: 30, w: 100, h: 40 } }],
      [9000, 'holdend'], [9650, '-held']];
    fs.writeFileSync(path.join(raw, 'log.json'), JSON.stringify(log));
    const cli = path.resolve(dir, '..', '..', 'bin', 'ghostcast.mjs');
    const cutTake = () => {
      const result = spawnSync(process.execPath, [cli, 'cut', 'storyboard', '--project', root],
        { encoding: 'utf8', timeout: 120000 });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return JSON.parse(fs.readFileSync(path.join(root, 'clips', 'storyboard.json')));
    };
    const probe = (file) => {
      const result = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=nb_frames',
        '-of', 'csv=p=0', file], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return Number(result.stdout.trim());
    };
    fs.writeFileSync(path.join(raw, 'frames.json'), JSON.stringify([[0, 'red.jpg']]));
    const still = cutTake();
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'clips', 'storyboard.beats.json')));
    assert.ok(manifest.length > 1);
    assert.equal(manifest.length, still.segments[0].pieces.length);
    assert.equal(probe(path.join(root, 'clips', 'storyboard.mp4')),
      manifest.reduce((sum, name) => sum + probe(path.join(root, name)), 0));
    assert.ok(Math.abs(still.duration - probe(path.join(root, 'clips', 'storyboard.mp4')) / 30) <= .001);
    fs.writeFileSync(path.join(raw, 'frames.json'), JSON.stringify([[0, 'red.jpg'], [5000, 'blue.jpg']]));
    const animated = cutTake();
    assert.ok(animated.segments[0].fit.removed < still.segments[0].fit.removed);
    assert.ok(animated.segments[0].fit.removed <= .051, 'the animated hold must not be cut');
    assert.ok(animated.segments[0].fit.speed > 1.5);
    const plan = beat_plan(log, [[0, 'red.jpg'], [5000, 'blue.jpg']],
      { output: { fps: 30 } }, 320, 180,
      { targets: { held: 2 }, unstable: { held: [{ a: 1, b: 9 }] } });
    assert.ok(plan.beats.slice(1).every((b, i) => !(plan.beats[i].b < 9 && b.a > 1 && b.a - plan.beats[i].b > 1e-8)));
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});

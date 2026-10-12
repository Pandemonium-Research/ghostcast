import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { loadProject } from '../project.mjs';
import { beat_plan, windows, box_at, segments } from '../post/logic.mjs';
import { fitTargets, directCamera, motionIntervals } from '../post/fit.mjs';
import { place } from '../post/voice.mjs';
import { probeSize } from '../post/render.mjs';
import { parseYaml, readBrief } from '../studio/schema.mjs';
import { KNOWN_TOKEN, LONG_RUN, randomToken, words } from '../studio/lint.mjs';

const DEFAULTS = { minTextPx: 16, minShowPx: 20, captionMaxSeconds: 8, frozenSeconds: 4, emptyShare: .88, emptyInk: .01, captionInk: .03 };
const read = (p, fallback) => fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback;
const generic = new Set(['runner', 'user', 'public', 'default']);
const pathSecret = /(?:C:\\Users\\([^\\\s]+)|\/Users\/([^/\s]+)|\/home\/([^/\s]+))/gi;
const normalize = (s) => String(s).toLocaleLowerCase().replace(/\s+/g, ' ').trim();
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
const captionFonts = ['C:/Windows/Fonts/seguisb.ttf', '/System/Library/Fonts/SFNS.ttf', '/System/Library/Fonts/Helvetica.ttc',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'];
const pillCache = new Map();

function pillBounds(c, cap) {
  const style = c.cfg.captions ?? {}, width = c.cfg.output.width, height = c.cfg.output.height;
  const size = Math.round((style.size ?? Math.round(34 * height / 1080)) * (cap.pos === 'corner' ? .88 : 1));
  const font = style.font ? path.resolve(c.root, style.font) : captionFonts.find((p) => fs.existsSync(p));
  const fontBytes = font ? fs.readFileSync(font) : null;
  const key = sha(JSON.stringify({ text: cap.text, pos: cap.pos, style, size, width, height, fontHash: fontBytes ? sha(fontBytes) : null, version: 'perspective-beats-9' }));
  if (!pillCache.has(key)) {
    const file = path.join(c.root, 'cache', 'pills', `${key}.png`);
    let bounds = null;
    if (fs.existsSync(file)) {
      const raw = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { maxBuffer: width * height * 4 + 1024 });
      if (!raw.error && raw.status === 0 && raw.stdout?.length === width * height * 4) {
        let x0 = width, y0 = height, x1 = -1, y1 = -1;
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (raw.stdout[(y * width + x) * 4 + 3] > 0) {
          x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
        }
        if (x1 >= x0) bounds = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
      }
    }
    pillCache.set(key, bounds);
  }
  const cached = pillCache.get(key);
  if (cached) return cached;
  const scaleX = 960 / width, scaleY = 540 / height;
  const pillW = Math.min(960, (cap.text.length * size * .58 + 2 * size) * scaleX);
  const pillH = Math.min(540, size * 2 * scaleY), margin = .05 * height * scaleY;
  return { x: cap.pos === 'corner' ? 960 - pillW - margin * .75 : (960 - pillW) / 2,
    y: cap.pos === 'corner' ? margin * .75 : cap.pos === 'top' ? margin : 540 - margin - pillH, w: pillW, h: pillH };
}

function context(root, take) {
  const cfg = loadProject(root).config, raw = path.join(root, 'raw', take);
  const log = read(path.join(raw, 'log.json'), []), frames = read(path.join(raw, 'frames.json'), []);
  const item = (read(path.join(root, 'timeline.json'), { items: [] }).items || []).find((x) => x.take === take) || { take };
  const width = cfg.viewport?.width || 1440, height = cfg.viewport?.height || 810, dpr = cfg.viewport?.dpr || 1;
  const storyFile = path.join(root, 'storyboard.yaml');
  const storyboard = fs.existsSync(storyFile) ? parseYaml(fs.readFileSync(storyFile, 'utf8'), 'storyboard.yaml').data : null;
  const briefFile = path.join(root, 'brief.md');
  const brief = fs.existsSync(briefFile) ? readBrief(fs.readFileSync(briefFile, 'utf8')).data || {} : {};
  const beats = storyboard?.beats || [], isStory = take === 'storyboard' || beats.some((b) => log.some((e) => e[1] === `+${b.id}`));
  const { targets, readings } = fitTargets(root, take, log, cfg);
  // Plan exactly as `cut` did: from the frames' real size (takes shot before stage 1 are 1×
  // whatever the config says), with page pixels scaled by the logged viewport.
  const first = frames.length && path.join(raw, 'frames', frames[0][1]);
  const [srcW, srcH] = first && fs.existsSync(first) ? probeSize(first) : [width * dpr, height * dpr];
  const vp = log.find((e) => e[1] === 'viewport')?.[2];
  const scale = vp ? srcW / vp.w : dpr;
  const plan = frames.length ? beat_plan(log, frames, cfg, srcW, srcH, { targets, readings }) : { beats: [], keys: [], meta: { duration: 0, segments: [] } };
  return { root, cfg, take, raw, log, frames, item, width, height, dpr: scale, srcW, srcH, storyboard, brief, beats, isStory, plan };
}

function makeProblem(take, check, level, at, message, segment, until) {
  return { check, level, take, ...(segment ? { segment } : {}), at: Math.max(0, at || 0), ...(until === undefined ? {} : { until: Math.max(0, until) }), message };
}
function outputAt(c, source) {
  for (const b of c.plan.beats) if (source >= b.a - .001 && source <= b.b + .001) {
    const tick = b.ticks.find((t) => Math.abs(t.sourceTime - source) < 1 / (c.cfg.output?.fps || 30) * (b.speed || 1) * 1.1);
    if (tick) return { at: tick.start ?? b.start + (tick.sourceTime - b.a) / (b.speed || 1), segment: b.segment };
    const idx = Math.max(0, b.ticks.findIndex((t) => t.sourceTime >= source));
    return { at: b.start + idx / (c.cfg.output?.fps || 30), segment: b.segment };
  }
  return { at: 0, segment: undefined };
}
function outputTime(c, source) {
  let offset = 0;
  for (const b of c.plan.beats) {
    if (source >= b.a && source <= b.b) return offset + (source - b.a) / (b.speed || 1);
    offset = b.end;
  }
  return offset;
}
function mergedCaptions(c) {
  const caps = windows(c.item, { ...c.plan.meta, segments: c.plan.meta.segments });
  const list = caps.filter((x) => x[3] !== 'corner').map(([text, a, b, pos]) => ({ text, a, b, pos })).sort((a, b) => a.a - b.a);
  const merged = [];
  for (const cap of list) {
    const last = merged.at(-1);
    if (last && last.text === cap.text && cap.a <= last.b + .001) last.b = Math.max(last.b, cap.b);
    else merged.push({ ...cap });
  }
  return merged;
}
function factsChecks(c, problems, thresholds) {
  const facts = c.log.filter((e) => e[1] === 'facts' && e[2]).sort((a, b) => a[0] - b[0]);
  const minText = thresholds.minTextPx;
  for (const [ms, , data] of facts) {
    const source = ms / 1000, { at, segment } = outputAt(c, source);
    // "Too small once zoomed": facts logged as the camera starts a move are judged at the framing
    // it moves to, not at the view it is leaving.
    const move = c.plan.keys.findLast(([tk]) => tk <= source + .05 && source < tk + .75);
    const view = c.plan.keys.length ? box_at(c.plan.keys, move ? move[0] + .75 : source) : [0, 0, c.srcW, c.srcH];
    const scale = c.cfg.output.width / Math.max(1, view[2]);
    const small = (data.boxes || []).filter((b) => Number(b.px) * c.dpr * scale < minText);
    if (small.length > (data.boxes || []).length / 2 && small.length)
      problems.push(makeProblem(c.take, 'small-text', 'error', at, `${small.length} of ${(data.boxes || []).length} visible text boxes render below ${minText}px`, segment));
    const show = c.log.filter((e) => e[1] === 'show' && Math.abs(e[0] - ms) < 1500).at(-1);
    const sr = show?.[2]?.rect;
    const insideShow = sr ? (data.boxes || []).filter((b) => b.x < sr.x + sr.w && b.x + b.w > sr.x && b.y < sr.y + sr.h && b.y + b.h > sr.y) : [];
    const exactShow = insideShow.find((b) => normalize(b.t) === normalize(show?.[2]?.text));
    const showBoxes = exactShow ? [exactShow] : (normalize(insideShow.map((b) => b.t).join(' ')).includes(normalize(show?.[2]?.text)) ? insideShow : []);
    if (showBoxes.some((b) => b.px * c.dpr * scale < thresholds.minShowPx))
      problems.push(makeProblem(c.take, 'small-text', 'error', at, `show target text renders below ${thresholds.minShowPx}px`, segment));
    const text = String(data.text || '');
    const matches = [...text.matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi), ...text.matchAll(KNOWN_TOKEN), ...[...text.matchAll(LONG_RUN)].filter((m) => randomToken(m[0]))];
    for (const m of matches) problems.push(makeProblem(c.take, 'secrets', 'error', at, `page text contains a possible email or token (${m[0].slice(0, 48)})`, segment));
    for (const m of text.matchAll(pathSecret)) if (!generic.has((m[1] || m[2] || m[3]).toLowerCase()))
      problems.push(makeProblem(c.take, 'secrets', 'error', at, `page text contains identifying home path (${m[0]})`, segment));
  }
  const caps = mergedCaptions(c);
  for (const cap of caps) {
    const aSeg = c.plan.meta.segments.find((s) => cap.a >= s.start && cap.a < s.end)?.segment;
    const bSeg = c.plan.meta.segments.find((s) => cap.b > s.start && cap.b <= s.end)?.segment;
    // Too long to stay up is an error; merely crossing into the next segment is worth a look.
    const across = aSeg && bSeg && aSeg !== bSeg, long = cap.b - cap.a > thresholds.captionMaxSeconds;
    if (long || across)
      problems.push(makeProblem(c.take, 'caption-long', long ? 'error' : 'warning', cap.a, `caption “${cap.text}” lasts ${(cap.b - cap.a).toFixed(1)}s${across ? ' across segments' : ''}`, aSeg, cap.b));
    const need = words(cap.text) / (c.cfg.direction?.readingWordsPerSecond || 3) + .5;
    if (cap.b - cap.a < need) problems.push(makeProblem(c.take, 'caption-read', 'warning', cap.a, `caption needs ${need.toFixed(1)}s to read; it is up ${(cap.b - cap.a).toFixed(1)}s`, aSeg, cap.b));
  }
  if (c.isStory) for (const beat of c.beats) {
    const name = beat.id, seg = c.plan.meta.segments.find((s) => s.segment === name);
    const src = segments(c.log).find((s) => s.name === name);
    const show = src && c.log.filter((e) => e[1] === 'show' && e[0] / 1000 >= src.a && e[0] / 1000 <= src.b).at(-1);
    if (beat.show && !show) problems.push(makeProblem(c.take, 'show-visible', 'error', seg?.start || 0, `show target for beat ${name} never appeared`, name));
    if (beat.show && seg) {
      const hold = c.log.filter((e) => e[1] === 'hold' && e[2]?.beat === name).at(-1);
      // The hold as the cut shows it: fitting may split it around a removed stretch, so add up
      // what each piece keeps of it. A tenth of a second covers rounding to whole frames.
      // The hold ends the beat, so the segment's closing margin still shows the same picture.
      const from = hold ? hold[0] / 1000 : src.a, to = src.b;
      const duration = c.plan.beats.filter((b) => b.segment === name)
        .reduce((sum, b) => sum + Math.max(0, Math.min(b.b, to) - Math.max(b.a, from)) / (b.speed || 1), 0);
      const need = (c.cfg.direction?.readingBase ?? .5) + words(show?.[2]?.text) / (c.cfg.direction?.readingWordsPerSecond || 3);
      if (duration < need - .1) problems.push(makeProblem(c.take, 'show-visible', 'error', seg.start, `the hold on the show target is ${duration.toFixed(1)}s; reading it needs ${need.toFixed(1)}s`, name, seg.end));
    }
    if (seg) {
      const narr = words(beat.say || '') / (c.cfg.voiceover?.wordsPerSecond || 2.5);
      const placed = c.root && read(path.join(c.root, 'voiceover', 'plan.json'), { pieces: [] }).pieces || [];
      const voiceDur = placed.filter((p) => p.take === c.take && (p.segment || name) === name).reduce((n, p) => n + Math.max(0, p.to - p.from), 0);
      if (Math.max(narr, voiceDur) > seg.end - seg.start) problems.push(makeProblem(c.take, 'narration-long', 'error', seg.start, `narration needs ${Math.max(narr, voiceDur).toFixed(1)}s; beat is ${(seg.end - seg.start).toFixed(1)}s`, name, seg.end));
      const fact = c.log.filter((e) => e[1] === 'facts' && e[0] / 1000 >= (src?.a ?? 0) && e[0] / 1000 <= (src?.b ?? 0)).map((e) => e[2]?.text || '').join(' ');
      for (const phrase of String(beat.say || '').matchAll(/[“"]([^”"]+)[”"]|`([^`]+)`/g)) {
        const quoted = phrase[1] || phrase[2];
        if (!normalize(fact).includes(normalize(quoted))) problems.push(makeProblem(c.take, 'copy-drift', 'warning', seg.start, `quoted narration “${quoted}” is absent from logged page text`, name));
      }
    }
  }
  if (!c.isStory && (read(path.join(c.root, 'timeline.json'), { items: [] }).items || [])[0]?.take === c.take) {
    const voice = read(path.join(c.root, 'voiceover', 'plan.json'), { pieces: [] });
    if (voice.pieces?.length) {
      const items = read(path.join(c.root, 'timeline.json'), { items: [] }).items || [];
      const takes = {}; let start = 0;
      for (const item of items) {
        const meta = read(path.join(c.root, 'clips', `${item.take}.json`), c.plan.meta);
        takes[item.take] = { start, end: start + meta.duration, segments: Object.fromEntries((meta.segments || []).map((s) => [s.segment, s.start])) };
        start += meta.duration;
      }
      try {
        // vo-mix's own rule: a piece may run `spill` (1.5 s) into the next take to finish a line.
        const [placed, placementProblems] = place(voice.pieces, takes, start);
        for (const p of placed) if (p.end > takes[p.take].end + (p.spill ?? 1.5))
          problems.push(makeProblem(p.take, 'narration-long', 'error', p.start - takes[p.take].start, `voice piece ends ${(p.end - takes[p.take].end).toFixed(1)}s after its take`, p.segment, p.end - takes[p.take].start));
        for (const message of placementProblems.filter((m) => m.startsWith('voice-over ends')))
          problems.push(makeProblem(c.take, 'narration-long', 'error', start, message));
      } catch (e) { problems.push(makeProblem(c.take, 'narration-long', 'error', 0, `voice plan cannot be placed: ${e.message}`)); }
    }
  }
  const untouchedFile = path.join(c.raw, 'world.json');
  if (fs.existsSync(untouchedFile)) { const w = read(untouchedFile, {}); if (w.untouched === false) problems.push(makeProblem(c.take, 'untouched', 'error', 0, `world changed: ${(w.leaks || []).concat(w.changed || []).join(', ') || 'world check failed'}`)); }
  const panel = c.plan.meta.segments.filter((s) => c.beats.find((b) => b.id === s.segment)?.surface === 'panel').reduce((n, s) => n + s.end - s.start, 0);
  if (c.isStory && c.plan.meta.duration && panel / c.plan.meta.duration > (c.brief.panel_share ?? c.storyboard?.panel_share ?? .2)) problems.push(makeProblem(c.take, 'panel-share', 'error', 0, `panels take ${(panel / c.plan.meta.duration * 100).toFixed(1)}% of the cut`));
  const cap = c.storyboard?.cap ?? c.cfg.output?.capSeconds;
  if (cap && c.plan.meta.duration > cap) problems.push(makeProblem(c.take, 'cap', 'error', 0, `cut is ${c.plan.meta.duration.toFixed(1)}s; cap is ${cap}s`));
  const dirs = directCamera(c.log, c.cfg, c.srcW, c.srcH, c.dpr);
  const moves = dirs.filter((e) => e[1] === 'focus' || e[1] === 'unfocus').map((e) => e[0] / 1000);
  const maxMoves = c.cfg.direction?.movesPerMinute ?? 12;
  for (const t of moves) if (moves.filter((x) => x >= t && x < t + 60).length > maxMoves) { problems.push(makeProblem(c.take, 'camera-moves', 'warning', outputTime(c, t), `more than ${maxMoves} camera moves in a 60s window`)); break; }
  const checkLog = directCamera(c.log, c.cfg, c.srcW, c.srcH, c.dpr);
  for (const seg of segments(checkLog)) {
    const intervals = motionIntervals(seg, checkLog, c.cfg);
    const trim = c.cfg.trims?.[seg.name];
    const rate = seg.speed * (c.cfg.speeds?.[seg.name] ?? 1), cutAt = seg.a + trim * rate;
    if (trim != null && trim < (seg.b - seg.a) / rate && intervals.moving.some((m) => m.a + .02 < cutAt && m.b > cutAt - .02))
      problems.push(makeProblem(c.take, 'cut-in-move', 'error', outputTime(c, cutAt), `trim of ${trim}s cuts a moving interval`, seg.name));
    const pieces = c.plan.beats.filter((b) => b.segment === seg.name).sort((a, b) => a.a - b.a);
    for (let i = 1; i < pieces.length; i++) if (pieces[i].a > pieces[i - 1].b + .01
      && intervals.moving.some((m) => m.a < pieces[i].a && m.b > pieces[i - 1].b))
      problems.push(makeProblem(c.take, 'cut-in-move', 'error', outputTime(c, pieces[i - 1].b), 'fit removes source frames inside a moving interval', seg.name));
  }
}

function pixels(c, problems, thresholds) {
  if (!c.frames.length) return;
  const samples = [];
  let previousImage = null, previousSec = null, freezeStart = null;
  for (const b of c.plan.beats) for (let sec = Math.ceil(b.start); sec < b.end; sec++) {
    const tick = b.ticks[Math.min(b.ticks.length - 1, Math.max(0, Math.floor((sec - b.start) * (c.cfg.output.fps || 30))))];
    if (tick) samples.push({ sec, tick, segment: b.segment });
  }
  let emptyStart = null;
  const emptySecs = [];
  for (const s of samples) {
    const crop = box_at(c.plan.keys, s.tick.sourceTime), x = Math.max(0, Math.round(crop[0])), y = Math.max(0, Math.round(crop[1]));
    const w = Math.max(1, Math.round(crop[2])), h = Math.max(1, Math.round(crop[3]));
    const file = path.join(c.raw, 'frames', s.tick.file);
    const ff = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `crop=${w}:${h}:${x}:${y},scale=960:540:flags=area,format=gray`, '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { maxBuffer: 2_000_000 });
    if (ff.error || ff.status !== 0 || !ff.stdout || ff.stdout.length !== 960 * 540) { s.unreadable = true; continue; }
    const data = ff.stdout, hist = new Uint32Array(256), rowInk = new Uint16Array(540);
    for (let i = 0; i < data.length; i++) hist[data[i]]++;
    let mode = 0; for (let i = 1; i < 256; i++) if (hist[i] > hist[mode]) mode = i;
    let near = 0; for (const level of data) if (Math.abs(level - mode) <= 12) near++;
    const wide = crop[2] / (c.srcW) > .8;
    const background = mode;
    let ink = 0;
    for (let yy = 0; yy < 540; yy++) for (let xx = 0; xx < 960; xx++) if (Math.abs(data[yy * 960 + xx] - background) >= 40) { rowInk[yy]++; ink++; }
    // Near-empty: a wide view that is mostly background with next to no content (two small
    // prompts are about 0.1%); a title card's large text is several percent and passes.
    const empty = wide && near / data.length > thresholds.emptyShare && ink / data.length < thresholds.emptyInk;
    if (empty) emptySecs.push(s.sec);
    s.ink = ink / data.length;
    const lines = []; let start = null;
    for (let yy = 0; yy < 540; yy++) { if (rowInk[yy] > 1 && start === null) start = yy; if ((rowInk[yy] <= 1 || yy === 539) && start !== null) { if (yy - start >= 1) lines.push(yy - start); start = null; } }
    // Lines are measured on the 540-row analysis image: scale them up to output pixels before
    // comparing with the ink height of the minimum font (about 0.7 of its size).
    const toOutput = c.cfg.output.height / 540;
    const tooSmall = lines.length > 0 && lines.filter((h0) => h0 * toOutput < thresholds.minTextPx * .7).length > lines.length / 2;
    const hash = `${crop.map((v) => Math.round(v * 10) / 10).join(',')}:${data.toString('base64')}`;
    if (hash === previousImage && previousSec !== null && s.sec - previousSec <= 1.1) s.frozenSince = freezeStart;
    else { previousImage = hash; freezeStart = s.sec; }
    previousImage = hash; previousSec = s.sec;
    s.empty = empty; s.small = tooSmall; s.lines = lines.length; s.data = data; s.background = mode;
  }
  // Frames that cannot be read leave the pixel checks blind; say so rather than pass unchecked.
  const unreadable = samples.filter((s) => s.unreadable).length;
  if (unreadable) problems.push(makeProblem(c.take, 'pixels', 'warning', samples.find((s) => s.unreadable).sec,
    `${unreadable} of ${samples.length} sampled frames could not be read; the pixel checks skipped them`));
  let emptyRun = [], candidate = [];
  for (const sec of emptySecs) {
    if (candidate.length && sec - candidate.at(-1) > 1.1) { if (candidate.length > emptyRun.length) emptyRun = candidate; candidate = []; }
    candidate.push(sec);
  }
  if (candidate.length > emptyRun.length) emptyRun = candidate;
  const emptyHolds = emptyRun.length > 1 && emptyRun.at(-1) - emptyRun[0] + 1 >= 1.5;
  const co = emptyHolds;
  if (co) {
    const inRun = samples.filter((s) => s.empty && s.sec >= emptyRun[0] && s.sec <= emptyRun.at(-1));
    const share = Math.max(...inRun.map((s) => s.ink)) * 100;
    problems.push(makeProblem(c.take, 'near-empty', 'error', emptyRun[0],
      `for ${emptyRun.at(-1) - emptyRun[0] + 1}s the wide view is almost empty (content covers ${share.toFixed(1)}% of it); frame what is there`, inRun[0]?.segment, emptyRun.at(-1) + 1));
  }
  if (!c.log.some((e) => e[1] === 'facts')) for (const s of samples) if (s.small && !(co && s.empty && s.sec >= emptyRun[0] && s.sec <= emptyRun.at(-1)))
    problems.push(makeProblem(c.take, 'small-text', 'error', s.sec, 'pixel text lines are too small in this take', s.segment));
  for (const s of samples) if (s.frozenSince !== undefined) {
    const source = s.tick.sourceTime;
    const hold = c.log.find((e) => e[1] === 'hold' && e[0] / 1000 <= source && c.log.some((end) => end[1] === 'holdend' && end[0] / 1000 >= source && end[0] > e[0]));
    let limit = thresholds.frozenSeconds;
    if (hold && c.isStory) {
      const id = hold[2]?.beat, beat = c.beats.find((b) => b.id === id);
      const srcSeg = segments(c.log).find((seg) => seg.name === id);
      const show = srcSeg && c.log.filter((e) => e[1] === 'show' && e[0] / 1000 >= srcSeg.a && e[0] / 1000 <= srcSeg.b).at(-1);
      const target = beat ? Math.max(c.cfg.direction?.minBeat ?? 2, words(beat.say || '') / (c.cfg.voiceover?.wordsPerSecond || 2.5) + .6,
        (c.cfg.direction?.readingBase ?? .5) + words(show?.[2]?.text || '') / (c.cfg.direction?.readingWordsPerSecond || 3)) : thresholds.frozenSeconds;
      limit = target + 1;
    }
    if (s.sec - s.frozenSince > limit) problems.push(makeProblem(c.take, 'frozen', 'warning', s.frozenSince, `same rendered frame persists for ${s.sec - s.frozenSince}s`, s.segment, s.sec));
  }
  const captions = mergedCaptions(c);
  for (const s of samples) {
    const cap = captions.find((item) => s.sec >= item.a && s.sec < item.b);
    if (!s.data || !cap) continue;
    const pill = pillBounds(c, cap);
    const left = Math.max(0, Math.floor(pill.x)), right = Math.min(960, Math.ceil(pill.x + pill.w));
    const top = Math.max(0, Math.floor(pill.y)), bottom = Math.min(540, Math.ceil(pill.y + pill.h));
    let ink = 0, area = (right - left) * (bottom - top);
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) if (Math.abs(s.data[y * 960 + x] - s.background) >= 40) ink++;
    if (ink / area > thresholds.captionInk) problems.push(makeProblem(c.take, 'caption-over', 'error', s.sec, `content ink under caption is ${(ink / area * 100).toFixed(1)}% of pill area`, s.segment));
  }
}

export function checkTake(root, take, { pixels: pixelChecks = true } = {}) {
  const c = context(path.resolve(root), take), configured = c.cfg.checks || {}, thresholds = { ...DEFAULTS, ...configured };
  const problems = [];
  factsChecks(c, problems, thresholds);
  if (pixelChecks) pixels(c, problems, thresholds);
  return problems;
}

export function checkProject(root, { pixels: pixelChecks = true } = {}) {
  const timeline = read(path.join(root, 'timeline.json'), { items: [] });
  const takes = (timeline.items || []).map((item) => item.take).filter((take) => fs.existsSync(path.join(root, 'raw', take, 'log.json')));
  // Where each take starts in the assembled cut, so every problem can be found in the video.
  const offsets = {};
  let offset = 0;
  for (const item of timeline.items || []) {
    offsets[item.take] = offset;
    offset += read(path.join(root, 'clips', `${item.take}.json`), { duration: 0 }).duration || 0;
  }
  const found = takes.flatMap((take) => checkTake(root, take, { pixels: pixelChecks }))
    .map((p) => ({ ...p, cutAt: (offsets[p.take] ?? 0) + p.at, ...(p.until === undefined ? {} : { cutUntil: (offsets[p.take] ?? 0) + p.until }) }));
  const problems = mergeRuns(found);
  problems.sort((a, b) => (a.level === b.level ? a.cutAt - b.cutAt : a.level === 'error' ? -1 : 1));
  return { problems, errors: problems.filter((p) => p.level === 'error').length, warnings: problems.filter((p) => p.level === 'warning').length, takes };
}
// The pixel checks look once a second: the same finding on consecutive seconds is one problem
// over a range, not a line per second.
function mergeRuns(problems) {
  const out = [];
  for (const p of [...problems].sort((a, b) => a.cutAt - b.cutAt)) {
    const run = out.findLast((q) => q.check === p.check && q.take === p.take && q.segment === p.segment && q.message === p.message);
    const end = run && (run.cutUntil ?? run.cutAt + 1);
    if (run && p.cutAt <= end + .1) { run.cutUntil = Math.max(end, p.cutUntil ?? p.cutAt + 1); run.until = run.cutUntil - (run.cutAt - run.at); }
    else out.push({ ...p });
  }
  return out;
}
export function formatTime(seconds) { const m = Math.floor(seconds / 60), s = seconds - m * 60; return `${m}:${s.toFixed(1).padStart(4, '0')}`; }
export function formatCheck(report) {
  const lines = [];
  for (const level of ['error', 'warning']) for (const p of report.problems.filter((x) => x.level === level)) {
    const at = p.cutAt ?? p.at, until = p.cutUntil ?? p.until;
    lines.push(`${level.toUpperCase()} ${p.check} · ${formatTime(at)}${until == null ? '' : `–${formatTime(until)}`} · ${p.take}${p.segment ? `/${p.segment}` : ''} · ${p.message}`);
  }
  lines.push(`${report.errors} errors, ${report.warnings} warnings`);
  return lines.join('\n') + '\n';
}

export function writeCheckReport(root, report, customPath = null) {
  const base = customPath ? path.resolve(root, customPath) : path.join(root, 'out', 'check-report.md');
  const jsonPath = customPath ? `${base}.json` : path.join(root, 'cache', 'checks.json');
  fs.mkdirSync(path.dirname(base), { recursive: true }); fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(base, `# ghostcast check\n\n${formatCheck(report)}`, 'utf8');
  const timeline = read(path.join(root, 'timeline.json'), { items: [] });
  report.cut = Object.fromEntries((timeline.items || []).map(({ take }) => {
    const file = path.join(root, 'clips', `${take}.json`);
    return [take, fs.existsSync(file) ? sha(fs.readFileSync(file)) : null];
  }));
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { report: base, json: jsonPath };
}

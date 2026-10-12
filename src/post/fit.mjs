import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from '../studio/schema.mjs';
import { words } from '../studio/lint.mjs';

export const directionDefaults = Object.freeze({ readingWordsPerSecond: 3, readingBase: .5, readingMax: 4,
  minHold: 1.5, minBeat: 2, movesPerMinute: 12, minZoomGain: 1.2, maxSpeed: 12, stillSsim: .995 });
export const direction = (cfg = {}) => ({ ...directionDefaults, ...cfg.direction });
// How long a show target needs on screen. A long target (a paragraph) is glanced at while the
// narration explains it, not read through, so the time is capped.
export function readingSeconds(text, cfg = {}) {
  const policy = direction(cfg);
  return Math.min(policy.readingMax, policy.readingBase + words(text) / policy.readingWordsPerSecond);
}

const EPS = 1e-9;
const duration = (span) => span.b - span.a;
function merge(spans) {
  const out = [];
  for (const span of spans.filter((s) => s.b > s.a + EPS).sort((x, y) => x.a - y.a)) {
    if (out.length && span.a <= out.at(-1).b + EPS) out.at(-1).b = Math.max(out.at(-1).b, span.b);
    else out.push({ a: span.a, b: span.b });
  }
  return out;
}
function subtract(spans, exclusions) {
  let result = spans;
  for (const cut of merge(exclusions)) result = result.flatMap((s) => {
    if (cut.b <= s.a + EPS || cut.a >= s.b - EPS) return [s];
    return [{ a: s.a, b: Math.min(s.b, cut.a) }, { a: Math.max(s.a, cut.b), b: s.b }]
      .filter((piece) => duration(piece) > EPS);
  });
  return result;
}

// Intervals use source seconds. The camera log must already have been directed.
export function motionIntervals(segment, log, cfg = {}, unstable = []) {
  const { a, b, name } = segment;
  const plus = log.find(([ms, label]) => label === `+${name}` && ms / 1000 >= a - EPS && ms / 1000 <= b + EPS)?.[0] / 1000;
  const minus = log.find(([ms, label]) => label === `-${name}` && ms / 1000 >= a - EPS && ms / 1000 <= b + EPS)?.[0] / 1000;
  const holds = [];
  let opened = null;
  for (const [ms, label, data] of log) {
    const t = ms / 1000;
    if (t < a - EPS || t > b + EPS) continue;
    if (label === 'hold' && data?.beat === name) opened = t;
    if (label === 'holdend' && opened !== null) { holds.push({ a: opened, b: t }); opened = null; }
  }
  if (opened !== null) holds.push({ a: opened, b: b });
  const margins = [];
  if (Number.isFinite(plus)) margins.push({ a, b: plus });
  if (Number.isFinite(minus)) margins.push({ a: minus, b });
  const eases = log.filter(([ms, label]) => (label === 'focus' || label === 'unfocus') && ms / 1000 < b && ms / 1000 + .75 > a)
    .map(([ms]) => ({ a: Math.max(a, ms / 1000), b: Math.min(b, ms / 1000 + .75) }));
  const still = subtract(merge([...holds, ...margins].map((s) => ({ a: Math.max(a, s.a), b: Math.min(b, s.b) }))), [...eases, ...unstable]);
  const moving = subtract([{ a, b }], still);
  // The viewer reads the show target in the beat's last hold, framed or not, so its first still
  // stretch keeps at least the reading time. (The runtime waits out the framing ease before the
  // hold starts, so an ease need not fall inside it.)
  const lastHold = holds.at(-1);
  const post = lastHold && still.find((s) => s.a >= lastHold.a - EPS && s.a < lastHold.b - EPS);
  return { still: still.map((s) => ({ ...s, keep: s === post ? Math.max(.3, direction(cfg).minHold) : .3,
    postFraming: s === post })), moving };
}

export function fitSegment({ a, b, still = [], moving, target, cfg = {}, reading = 0 }) {
  if (!(b > a) || !(target > 0)) throw new Error('fitSegment needs a source interval and positive target');
  const policy = direction(cfg), natural = b - a;
  const candidates = still.map((s) => ({ ...s, keep: Math.max(.3, s.keep ?? .3, s.postFraming ? policy.minHold : 0,
    s.postFraming ? reading : 0) }));
  const motion = moving ?? subtract([{ a, b }], candidates);
  const pieces = [];
  let removed = 0, speed = 1, overrun = 0, shortfall = 0;
  const cuts = new Map();
  if (natural > target + EPS) {
    let excess = natural - target;
    const ordered = candidates.map((s, i) => ({ i, removable: Math.max(0, duration(s) - s.keep) }))
      .sort((x, y) => y.removable - x.removable || x.i - y.i);
    for (const { i, removable } of ordered) {
      const amount = Math.min(excess, removable);
      if (amount <= EPS) continue;
      const s = candidates[i], center = (s.a + s.b) / 2;
      cuts.set(i, { a: center - amount / 2, b: center + amount / 2 });
      excess -= amount; removed += amount;
    }
    if (excess > EPS) {
      const movingTime = motion.reduce((sum, s) => sum + duration(s), 0);
      if (movingTime > EPS) speed = Math.min(policy.maxSpeed, movingTime / Math.max(EPS, movingTime - excess));
    }
  } else if (natural < target - EPS && !candidates.length) shortfall = target - natural;
  const stretch = natural < target - EPS && candidates.length
    ? (candidates.find((s) => s.postFraming) ?? candidates.reduce((best, s) => duration(s) > duration(best) ? s : best)) : null;
  const all = [
    ...candidates.flatMap((s, i) => {
      const gap = cuts.get(i), rate = s === stretch ? duration(s) / (duration(s) + target - natural) : 1;
      return (gap ? [{ a: s.a, b: gap.a }, { a: gap.b, b: s.b }] : [{ a: s.a, b: s.b }])
        .filter((p) => duration(p) > EPS).map((p) => ({ ...p, speed: rate, kind: 'still' }));
    }),
    ...motion.map((s) => ({ ...s, speed, kind: 'move' })),
  ].sort((x, y) => x.a - y.a);
  for (const p of all) {
    const prev = pieces.at(-1);
    if (prev && Math.abs(prev.speed - p.speed) < EPS && Math.abs(prev.b - p.a) < EPS) {
      prev.b = p.b;
      // A merged piece containing any motion is classified as moving.
      if (prev.kind !== p.kind) prev.kind = 'move';
    }
    else pieces.push(p);
  }
  const output = pieces.reduce((sum, p) => sum + duration(p) / p.speed, 0);
  overrun = Math.max(0, output - target);
  if (natural < target && !candidates.length) overrun = 0;
  return { pieces, natural, output, target, removed, speed, overrun, shortfall };
}

export function fitTargets(root, take, log, cfg = {}) {
  const targets = {}, readings = {};
  if (take !== 'storyboard' || !fs.existsSync(path.join(root, 'product.md'))) return { targets, readings };
  const file = path.join(root, 'storyboard.yaml');
  if (!fs.existsSync(file)) return { targets, readings };
  const story = parseYaml(fs.readFileSync(file, 'utf8'), 'storyboard.yaml').data;
  const policy = direction(cfg), wps = cfg.voiceover?.wordsPerSecond ?? 2.5;
  for (const beat of story?.beats ?? []) if (beat?.id) targets[beat.id] = Math.max(words(beat.say) / wps + .6, policy.minBeat);
  for (const id of Object.keys(targets)) {
    const start = log.findIndex((e) => e[1] === `+${id}`);
    const end = log.findIndex((e, i) => i > start && e[1] === `-${id}`);
    if (start < 0 || end < 0) continue;
    const show = log.slice(start, end + 1).filter((e) => e[1] === 'show').at(-1);
    if (show) readings[id] = readingSeconds(show[2]?.text, cfg);
  }
  return { targets, readings };
}

export function directCamera(log, cfg, srcW, srcH, dpr) {
  if (!log.some((e) => e[1] === 'hold')) return log;
  const policy = direction(cfg), full = srcW / srcH;
  const gain = (event) => {
    if (event[1] !== 'focus') return 1;
    const r = event[2];
    const fill = cfg.zoom?.fill ?? .62, maxZoom = cfg.zoom?.max ?? Math.max(1.5, cfg.viewport?.dpr ?? 1.5);
    const w = Math.min(srcW, Math.max(r.w * dpr / fill, r.h * dpr / fill * full, srcW / (r.zoom ?? maxZoom)));
    return srcW / w;
  };
  const moves = log.map((event, index) => ({ event, index, t: event[0] / 1000, gain: gain(event) }))
    .filter((m) => m.event[1] === 'focus' || m.event[1] === 'unfocus');
  const dropped = new Set();
  for (const move of moves) if (move.event[1] === 'focus' && move.gain < policy.minZoomGain)
    dropped.add(move.index);
  let framed = false;
  for (const move of moves) {
    if (dropped.has(move.index)) continue;
    if (move.event[1] === 'focus') framed = true;
    else if (!framed) dropped.add(move.index);
    else framed = false;
  }
  const active = () => moves.filter((m) => !dropped.has(m.index));
  for (let i = 0, list = active(); i < list.length - 1; i++) {
    if (list[i].event[1] === 'unfocus' && list[i + 1].event[1] === 'focus' && list[i + 1].t - list[i].t <= .3 + EPS)
      dropped.add(list[i].index);
  }
  for (let changed = true; changed;) {
    changed = false;
    const list = active();
    for (let i = 0; i < list.length - 1; i++) {
      if (list[i].event[1] !== 'focus' || list[i + 1].t - list[i].t - .75 >= policy.minHold - EPS) continue;
      const next = list[i + 1];
      const later = list[i + 2];
      const nextHold = later ? later.t - next.t - .75 : Infinity;
      dropped.add(next.event[1] === 'unfocus' || nextHold < next.t - list[i].t - .75
        ? next.index : list[i].index);
      changed = true; break;
    }
  }
  for (;;) {
    const list = active();
    const crowded = list.find((m, i) => list.filter((n) => n.t >= m.t && n.t < m.t + 60).length > policy.movesPerMinute);
    if (!crowded) break;
    const window = list.filter((m) => m.t >= crowded.t && m.t < crowded.t + 60);
    const focus = window.filter((m) => m.event[1] === 'focus').sort((a, b) => a.gain - b.gain || a.t - b.t)[0];
    const victim = focus ?? window[0];
    dropped.add(victim.index);
    const next = list[list.indexOf(victim) + 1];
    if (focus && next?.event[1] === 'unfocus') dropped.add(next.index);
  }
  return log.filter((_, i) => !dropped.has(i));
}

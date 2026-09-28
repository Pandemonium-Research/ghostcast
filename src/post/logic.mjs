export function smooth(k) {
  k = Math.max(0, Math.min(1, k));
  return k * k * k * (k * (k * 6 - 15) + 10);
}

export function segments(log) {
  const opened = new Map(), out = [];
  for (const [ms, label] of log) {
    const t = ms / 1000;
    if (label.startsWith('+')) opened.set(label.slice(1), t);
    else if (label.startsWith('-') && opened.has(label.slice(1))) {
      const name = label.slice(1), a = opened.get(name) - .20, b = t + .35;
      opened.delete(name);
      const fixed = name.match(/@(\d+(?:\.\d+)?)x$/), fit = name.match(/@fit(\d+(?:\.\d+)?)$/);
      const speed = fixed ? Number(fixed[1]) : fit ? Math.max(1, (b - a) / Number(fit[1])) : 1;
      out.push({ name, a, b, speed });
    }
  }
  return out.sort((a, b) => a.a - b.a);
}

export function view_track(log, srcW, srcH, dpr, cfg = {}) {
  const full = [0, 0, srcW, srcH], aspect = srcW / srcH;
  const keys = [[-1e18, full]];
  const fill = cfg.zoom?.fill ?? .62, maxZoom = cfg.zoom?.max ?? Math.max(1.5, cfg.viewport?.dpr ?? 1.5);
  for (const [ms, label, r] of log) {
    const t = ms / 1000;
    if (label === 'focus') {
      const cx = (r.x + r.w / 2) * dpr, cy = (r.y + r.h / 2) * dpr;
      const w = Math.min(srcW, Math.max(r.w * dpr / fill, r.h * dpr / fill * aspect, srcW / (r.zoom ?? maxZoom)));
      const h = w / aspect;
      keys.push([t, [Math.min(Math.max(cx - w / 2, 0), srcW - w), Math.min(Math.max(cy - h / 2, 0), srcH - h), w, h]]);
    } else if (label === 'unfocus') keys.push([t, full]);
  }
  return keys;
}

export function box_at(keys, t) {
  let shown = keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [tk, target] = keys[i];
    if (t < tk) break;
    const k = smooth((t - tk) / .75);
    shown = shown.map((s, j) => s + (target[j] - s) * k);
  }
  return shown;
}

export const speed_tag = (speed) => `${Number(speed).toFixed(1).replace(/\.0$/, '')}×`;

function roundEven(n) {
  const lower = Math.floor(n), fraction = n - lower;
  if (Math.abs(fraction - .5) < 1e-12) return lower % 2 === 0 ? lower : lower + 1;
  return Math.round(n);
}

export function windows(item, meta) {
  const segs = new Map(meta.segments.map((s) => [s.segment, s])), out = [];
  for (const c of item.captions ?? []) {
    let base = 0, end = meta.duration;
    if (c.from) {
      if (!segs.has(c.from)) throw new Error(`${item.take}: caption "${c.text}" names segment ${c.from}, which the take does not have (${[...segs.keys()].join(', ')})`);
      const s = segs.get(c.from); base = s.start; end = s.end;
    }
    const a = base + (c.at ?? 0), b = (c.until ?? 'end') === 'end' ? end : base + c.until;
    out.push([c.text, a, Math.min(b, meta.duration), c.pos ?? 'bottom']);
  }
  for (const s of meta.segments) if ((s.speed ?? 1) >= 1.5) out.push([speed_tag(s.speed), s.start, s.end, 'corner']);
  return out;
}

export function captionPieces(caps, beat) {
  return caps.filter(([, a, b]) => a < beat.end - .0005 && b > beat.start + .0005).map(([text, a, b, pos]) => ({
    text, pos, a: Math.max(0, a - beat.start), b: Math.min(beat.end - beat.start, b - beat.start),
    fadeIn: a >= beat.start - .001, fadeOut: b <= beat.end + .001,
  }));
}

export function beat_plan(log, frames, cfg, srcW, srcH) {
  const vp = log.find((e) => e[1] === 'viewport')?.[2];
  const keys = view_track(log, srcW, srcH, vp ? srcW / vp.w : 1, cfg);
  const fps = cfg.output.fps, times = frames.map((f) => f[0]);
  const beats = [], meta = [], trims = cfg.trims ?? {}, speeds = cfg.speeds ?? {};
  let pos = 0;
  for (const s of segments(log)) {
    const speed = s.speed * (speeds[s.name] ?? 1);
    const dur = Math.min((s.b - s.a) / speed, trims[s.name] ?? Infinity);
    const n = Math.max(1, roundEven(dur * fps));
    const ticks = [];
    for (let i = 0; i < n; i++) {
      const t = s.a + i / fps * speed;
      let lo = 0, hi = times.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] <= t) lo = mid + 1; else hi = mid; }
      const j = Math.max(0, lo - 1);
      ticks.push({ file: frames[j][1], stamp: frames[j][0], box: box_at(keys, t), sourceTime: t });
    }
    const start = Math.round(pos * 1000) / 1000, end = Math.round((pos + n / fps) * 1000) / 1000;
    meta.push({ segment: s.name, start, end, speed });
    beats.push({ segment: s.name, a: s.a, b: s.b, speed, start: pos, end: pos + n / fps, ticks });
    pos += n / fps;
  }
  return { beats, keys, meta: { duration: Math.round(pos * 1000) / 1000, segments: meta } };
}

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { ffmpeg } from './render.mjs';
import { loadProject } from '../project.mjs';

const json = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const exists = (p) => fs.existsSync(p);
const roundEven = (x) => { const n = Math.floor(x), part = x - n; return part < .5 ? n : part > .5 ? n + 1 : n % 2 === 0 ? n : n + 1; };
const clipMeta = (root, take) => json(path.join(root, 'clips', `${take}.json`));
const segmentAt = (segments, t) => {
  let label = '';
  for (const [start, name] of segments) if (start <= t + 1e-6) label = name;
  return label;
};
const labelAt = (segments, t) => `${t.toFixed(1).padStart(6)}s  ${segmentAt(segments, t)}`;

function duration(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return Number(r.stdout.trim());
}

async function sheet(root, cfg, entries, title, dest) {
  const browser = await chromium.launch({ channel: cfg.browser?.channel ?? 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    const images = entries.map(([file, label]) => [`data:image/${path.extname(file).slice(1) === 'jpg' ? 'jpeg' : 'png'};base64,${fs.readFileSync(file).toString('base64')}`, label]);
    const png = await page.evaluate(async ({ images, title }) => {
      const loaded = await Promise.all(images.map(([src, label]) => new Promise((resolve, reject) => {
        const img = new Image(); img.onload = () => resolve([img, label]); img.onerror = reject; img.src = src;
      })));
      const tw = 480, cols = 4, gap = 8, th = Math.round(tw * loaded[0][0].height / loaded[0][0].width);
      const c = document.createElement('canvas'); c.width = cols * tw + (cols + 1) * gap;
      c.height = 44 + Math.ceil(loaded.length / cols) * (th + 28 + gap) + gap;
      const g = c.getContext('2d'); g.fillStyle = '#202024'; g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = '#f0f0f0'; g.font = '600 22px Arial'; g.fillText(title, 10, 30);
      g.font = '18px Arial';
      loaded.forEach(([img, label], i) => {
        const x = gap + i % cols * (tw + gap), y = 44 + Math.floor(i / cols) * (th + 28 + gap);
        g.drawImage(img, x, y, tw, th); g.fillStyle = '#dcdcdc'; g.fillText(label, x + 2, y + th + 21);
      });
      return c.toDataURL('image/png').split(',')[1];
    }, { images, title });
    fs.writeFileSync(dest, Buffer.from(png, 'base64'));
    console.log(dest);
  } finally { await browser.close(); }
}

export async function review(root, args) {
  const target = args[0];
  if (!target) throw new Error('usage: ghostcast review <take|final> [--raw] [--at seconds] [--every seconds]');
  const cfg = loadProject(root).config;
  const out = path.join(root, 'out', 'review'); fs.mkdirSync(out, { recursive: true });
  if (args.includes('--raw')) {
    const raw = path.join(root, 'raw', target), frames = json(path.join(raw, 'frames.json'));
    const logFile = path.join(raw, 'log.json'), log = exists(logFile) ? json(logFile) : [];
    const t0 = frames[0][0];
    const segments = log.filter((e) => /^[+-]/.test(e[1])).map((e) =>
      [e[0] / 1000 - t0, e[1][0] === '+' ? e[1].slice(1) : `(cut: after ${e[1].slice(1)})`])
      .sort((a, b) => a[0] - b[0]);
    const picks = frames.length > 16 ? Array.from({ length: 16 }, (_, k) => frames[roundEven(k * (frames.length - 1) / 15)]) : frames;
    const entries = picks.map(([t, file]) => [path.join(raw, 'frames', file), labelAt(segments, t - t0)]);
    await sheet(root, cfg, entries, `raw/${target} · ${frames.length} frames · ${(frames.at(-1)[0] - t0).toFixed(1)}s captured`, path.join(out, `${target}.raw.png`));
    return;
  }
  let video, segments;
  if (target === 'final') {
    video = path.join(root, 'out', `${cfg.name ?? 'screencast'}.mp4`);
    if (!exists(video)) video = path.join(root, 'out', `${cfg.name ?? 'screencast'}-silent.mp4`);
    let start = 0; segments = [];
    for (const item of json(path.join(root, 'timeline.json')).items) {
      const file = path.join(root, 'clips', `${item.take}.json`);
      if (!exists(file)) continue;
      const meta = json(file);
      for (const s of meta.segments) segments.push([start + s.start, `${item.take} · ${s.segment}`]);
      start += meta.duration;
    }
  } else {
    video = path.join(root, 'clips', `${target}.mp4`);
    segments = clipMeta(root, target).segments.map((s) => [s.start, s.segment]);
  }
  segments.sort((a, b) => a[0] - b[0]);
  if (!exists(video)) throw new Error(`no ${path.relative(root, video)}`);
  const ats = args.flatMap((v, i) => v === '--at' ? [Number(args[i + 1])] : []);
  const times = ats.length ? ats : (() => { const d = duration(video), step = args.includes('--every') ? Number(args[args.indexOf('--every') + 1]) : Math.max(.5, d / 16); const a = []; for (let t = 0; t < d - .05; t += step) a.push(t); return a; })();
  const entries = [];
  for (let i = 0; i < times.length; i++) {
    const t = times[i], dest = ats.length ? path.join(out, `${target}@${t}.png`) : path.join(out, `.${target}-${i}.png`);
    await ffmpeg(['-ss', t.toFixed(3), '-i', video, '-frames:v', '1', '-y', dest]);
    if (ats.length) console.log(`${dest}  (${segmentAt(segments, t)})`); else entries.push([dest, labelAt(segments, t)]);
  }
  if (!ats.length) {
    try { await sheet(root, cfg, entries, `${path.basename(video)} · ${duration(video).toFixed(1)}s`, path.join(out, `${target}.png`)); }
    finally { for (const [file] of entries) { try { fs.unlinkSync(file); } catch {} } }
  }
}

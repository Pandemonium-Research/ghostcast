import fs from 'node:fs';
import path from 'node:path';
import { ffmpeg, ffmpegStderr } from './render.mjs';
import { loadProject } from '../project.mjs';

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const say = (s) => process.stdout.write(`${s}\n`);
const roundEven = (x) => { const n = Math.floor(x), part = x - n; return part < .5 ? n : part > .5 ? n + 1 : n % 2 === 0 ? n : n + 1; };
function fixed(value, digits) {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const negative = bits >> 63n === 1n;
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const mantissa = (bits & ((1n << 52n) - 1n)) + (exponent ? 1n << 52n : 0n);
  const shift = (exponent || 1) - 1023 - 52;
  let scaled = mantissa * 10n ** BigInt(digits), rounded;
  if (shift >= 0) rounded = scaled << BigInt(shift);
  else {
    const divisor = 1n << BigInt(-shift), quotient = scaled / divisor, remainder = scaled % divisor;
    rounded = quotient + (remainder * 2n > divisor || remainder * 2n === divisor && quotient % 2n === 1n ? 1n : 0n);
  }
  const s = rounded.toString().padStart(digits + 1, '0');
  return `${negative ? '-' : ''}${digits ? `${s.slice(0, -digits)}.${s.slice(-digits)}` : s}`;
}
const mmss = (t) => `${Math.floor(t / 60)}:${fixed(t % 60, 2).padStart(5, '0')}`;
const cfg = (root) => loadProject(root).config;
const timeline = (root) => readJson(path.join(root, 'timeline.json'));
const meta = (root, take) => readJson(path.join(root, 'clips', `${take}.json`));

function takeStarts(root, tl) {
  const starts = {}, missing = [];
  let total = 0;
  for (const item of tl.items) {
    const file = path.join(root, 'clips', `${item.take}.json`);
    if (!fs.existsSync(file)) { missing.push(item.take); continue; }
    const duration = readJson(file).duration;
    starts[item.take] = [total, total + duration];
    total += duration;
  }
  return { starts, total, missing };
}

export function fit(words, wps, room) {
  const need = words / wps;
  return { need, flag: need <= room - 0.5 ? 'fits' : `**${fixed(Math.max(0.1, need - room + 0.5), 1)}s too long: trim the text or lengthen the take**` };
}

export function voScript(root) {
  const tl = timeline(root), blocks = tl.narration ?? [];
  if (!blocks.length) throw new Error('timeline.json has no "narration" blocks');
  const { starts, total } = takeStarts(root, tl);
  const order = tl.items.map((i) => i.take);
  const wps = cfg(root).voiceover?.wordsPerSecond ?? 2.5;
  const out = [`# Voice-over script\n\nFor the silent cut (${mmss(total)}). Start each block when its time comes up; ` +
    `a block may run into the next take by a second or two, but not past it. Estimates assume ` +
    `${fixed(wps * 60, 0)} words a minute.\n`];
  for (const [index, block] of blocks.entries()) {
    const k = index + 1, takes = block.takes;
    const absent = takes.filter((take) => !(take in starts));
    if (absent.length) {
      out.push(`\n## Block ${k} · ${takes.join(', ')}\n\n> ${block.text}\n\nNot timed: no clip yet for ${absent.join(', ')}.\n`);
      continue;
    }
    const indexes = takes.map((take) => order.indexOf(take));
    if (indexes.some((idx, i) => idx !== indexes[0] + i))
      throw new Error(`block ${k}: takes ${JSON.stringify(takes).replaceAll('"', "'").replaceAll(',', ', ')} are not consecutive in the timeline`);
    const a = starts[takes[0]][0], room = starts[takes.at(-1)][1] - a;
    const words = block.text.trim().split(/\s+/).filter(Boolean).length;
    const { need, flag } = fit(words, wps, room);
    out.push(`\n## Block ${k} · ${mmss(a)} → ${mmss(a + room)} · ${fixed(room, 1)}s · ${takes.join(', ')}\n\n` +
      `> ${block.text}\n\n${words} words ≈ ${fixed(need, 1)}s · ${flag}\n`);
  }
  const body = out.join(''), file = path.join(root, 'out', 'voiceover-script.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
  process.stdout.write(`${body}\n${file}\n`);
}

export function merge(spans, gap = 0.08) {
  const merged = [];
  for (const [a, b] of spans) {
    if (merged.length && a - merged.at(-1)[1] < gap) merged.at(-1)[1] = b;
    else merged.push([a, b]);
  }
  return merged;
}

export async function pauses(args) {
  const option = (key, fallback) => args.includes(key) ? Number(args[args.indexOf(key) + 1]) : fallback;
  const noise = option('--noise', -30), min = option('--min', 0.15);
  const used = new Set(['--noise', '--min'].filter((key) => args.includes(key)).map((key) => args[args.indexOf(key) + 1]));
  const paths = args.filter((a) => !a.startsWith('--') && !used.has(a));
  if (!paths.length) throw new Error('usage: ghostcast pauses <audio> [...] [--noise -30] [--min 0.15]');
  for (const p of paths) {
    const err = await ffmpegStderr(['-i', p, '-af', `silencedetect=noise=${noise}dB:d=${min}`, '-f', 'null', '-']);
    const dur = /Duration: (\d+):(\d+):([\d.]+)/.exec(err);
    const total = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : null;
    const starts = [...err.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
    const ends = [...err.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
    const spans = merge(starts.map((a, i) => [a, ends[i] ?? total]));
    const lead = spans.length && spans[0][0] <= 0.05 ? spans[0][1] : 0;
    const tail = spans.length && total && spans.at(-1)[1] >= total - 0.05 ? spans.at(-1)[0] : total;
    const inner = spans.filter(([a, b]) => a > 0.05 && (total === null || b < total - 0.05));
    say(`${p}: ${fixed(total, 2)}s, speech ${fixed(lead, 2)} → ${fixed(tail, 2)}`);
    for (const [a, b] of inner) {
      const mark = b - a >= 0.3 ? '  ← sentence?' : '';
      say(`  pause ${fixed(a, 2).padStart(6)} – ${fixed(b, 2).padStart(6)}  (${fixed(b - a, 2)}s)  cut at ${fixed((a + b) / 2, 2)}${mark}`);
    }
    if (!inner.length) say('  no pauses; try a higher --noise (e.g. -25) or a lower --min');
  }
}

export function place(pieces, takes, total) {
  const placed = [], problems = [];
  let prevEnd = 0;
  for (const p of pieces) {
    const where = `piece ${p.clip} [${p.from}–${p.to}]`;
    if (!(p.take in takes)) throw new Error(`${where}: no take ${p.take} in timeline.json`);
    const tk = takes[p.take];
    if (p.segment && !(p.segment in tk.segments))
      throw new Error(`${where}: take ${p.take} has no segment ${p.segment} (${Object.keys(tk.segments).join(', ')})`);
    const anchor = tk.start + (p.segment ? tk.segments[p.segment] : 0) + (p.offset ?? 0);
    const start = placed.length ? Math.max(anchor, prevEnd + 0.25) : anchor;
    const end = start + (p.to - p.from);
    placed.push({ ...p, anchor, start, end });
    prevEnd = end;
    if (end > tk.end + (p.spill ?? 1.5)) problems.push(`${where} ends ${fixed(end - tk.end, 1)}s after take ${p.take}`);
  }
  if (!placed.length) throw new Error('the plan has no pieces');
  if (prevEnd > total) problems.push(`voice-over ends at ${fixed(prevEnd, 2)}s, after the video (${fixed(total, 2)}s)`);
  return [placed, problems];
}

export const resolveVoiceClip = (planFile, clip) => path.resolve(path.dirname(planFile), clip);

export async function voMix(root, args = []) {
  const planFile = args.includes('--plan') ? args[args.indexOf('--plan') + 1] : 'voiceover/plan.json';
  const resolvedPlan = path.resolve(root, planFile);
  const plan = readJson(resolvedPlan);
  const name = cfg(root).name ?? 'screencast';
  const silent = path.join(root, 'out', `${name}-silent.mp4`);
  if (!fs.existsSync(silent)) throw new Error(`no out/${path.basename(silent)} (run: ghostcast assemble)`);
  const tl = timeline(root), { starts, total, missing } = takeStarts(root, tl);
  if (missing.length) throw new Error(`takes without clips: ${missing.join(', ')} (cut them and assemble first)`);
  const takes = Object.fromEntries(Object.entries(starts).map(([take, [start, end]]) =>
    [take, { start, end, segments: Object.fromEntries(meta(root, take).segments.map((s) => [s.segment, s.start])) }]));
  const [placed, problems] = place(plan.pieces, takes, total);
  const inputs = ['-i', silent], chains = [];
  for (const [k, p] of placed.entries()) {
    const clip = resolveVoiceClip(resolvedPlan, p.clip);
    if (!fs.existsSync(clip)) throw new Error(`no clip ${clip}`);
    inputs.push('-i', clip);
    const length = p.end - p.start;
    chains.push(`[${k + 1}:a]atrim=start=${fixed(p.from, 3)}:end=${fixed(p.to, 3)},asetpts=PTS-STARTPTS,aresample=48000,` +
      `afade=t=in:d=0.015,afade=t=out:st=${fixed(Math.max(0, length - 0.015), 3)}:d=0.015,` +
      `adelay=delays=${roundEven(p.start * 1000)}:all=1[p${k}]`);
  }
  const graph = chains.join(';') + `;${placed.map((_, k) => `[p${k}]`).join('')}amix=inputs=${placed.length}:normalize=0,apad,atrim=0:${fixed(total, 3)},pan=stereo|c0=c0|c1=c0[aout]`;
  const voice = path.join(root, 'out', 'tmp', `${name}.voice.wav`);
  fs.mkdirSync(path.dirname(voice), { recursive: true });
  await ffmpeg([...inputs, '-filter_complex', graph, '-map', '[aout]', '-c:a', 'pcm_s16le', '-y', voice]);
  const target = `I=${cfg(root).voiceover?.lufs ?? -16}:TP=-1.5:LRA=11`;
  const probe = await ffmpegStderr(['-i', voice, '-af', `loudnorm=${target}:print_format=json`, '-f', 'null', '-']);
  const m = JSON.parse(probe.slice(probe.lastIndexOf('{'), probe.lastIndexOf('}') + 1));
  const norm = `loudnorm=${target}:linear=true:measured_I=${m.input_i}:measured_TP=${m.input_tp}:` +
    `measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}`;
  const out = path.join(root, 'out', `${name}.mp4`);
  await ffmpeg(['-i', silent, '-i', voice, '-filter_complex', `[1:a]${norm},aresample=48000,apad[aout]`,
    '-map', '0:v', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
    '-t', fixed(total, 3), '-movflags', '+faststart', '-y', out]);
  const lines = [`# Voice-over placement — ${path.basename(out)} (${mmss(total)})\n`,
    '| Starts | Ends | Beat | Clip | Text |', '|---|---|---|---|---|'];
  for (const p of placed) {
    const late = p.start - p.anchor > 0.05 ? ` (+${fixed(p.start - p.anchor, 1)}s)` : '';
    const beat = p.take + (p.segment ? ` · ${p.segment}` : '');
    lines.push(`| ${mmss(p.start)}${late} | ${mmss(p.end)} | ${beat} | ${p.clip} ${p.from}–${p.to} | ${p.text ?? ''} |`);
  }
  lines.push('', `Problems: ${problems.length ? problems.join('; ') : 'none'}`);
  fs.writeFileSync(path.join(root, 'out', `${name}.placement.md`), `${lines.join('\n')}\n`, 'utf8');
  say(lines.join('\n'));
  say(out);
}

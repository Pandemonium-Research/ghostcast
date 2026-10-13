import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from '../studio/schema.mjs';
import { storyboardHash } from '../studio/approve.mjs';
import { estimateBeat } from '../studio/lint.mjs';
import { cacheKey, readCache, writeCache } from './cache.mjs';
import { kokoro, kokoroStatus, KOKORO_MODEL } from './kokoro.mjs';
import { elevenlabs, readKey, keySource, ELEVENLABS_MODEL } from './elevenlabs.mjs';

export function voiceDoctor(root, { dir, env = process.env } = {}) {
  const speech = kokoroStatus(dir), source = keySource(root, env);
  return ['opt   Kokoro: ' + (speech.installed ? 'installed' : 'not installed') + ' (runtime about 400 MB); q8 model ' +
    (speech.modelCached ? 'cached' : 'not cached') + ' (86 MB); ghostcast voice --install',
  'opt   ElevenLabs key: ' + (source ? 'found in ' + source : 'not found (ELEVENLABS_API_KEY or studio secrets.env)')];
}

export function readAudio(root) {
  const file = path.join(root, 'audio.yaml');
  if (!fs.existsSync(file)) return { provider: 'none' };
  const parsed = parseYaml(fs.readFileSync(file, 'utf8'), 'audio.yaml');
  if (parsed.problems.length) throw new Error('audio.yaml: invalid YAML');
  const audio = parsed.data;
  if (!audio || !['none', 'clips', 'kokoro', 'elevenlabs'].includes(audio.provider)) throw new Error('audio.yaml: choose provider none, clips, kokoro or elevenlabs');
  if (!['kokoro', 'elevenlabs'].includes(audio.provider)) return audio;
  if (typeof audio.voice !== 'string' || !audio.voice.trim()) throw new Error('audio.yaml: voice is required');
  const model = audio.model ?? (audio.provider === 'kokoro' ? KOKORO_MODEL : ELEVENLABS_MODEL);
  const speed = audio.speed ?? 1;
  if (typeof model !== 'string' || !model.trim()) throw new Error('audio.yaml: model must be a nonempty string');
  if (!Number.isFinite(speed) || speed <= 0) throw new Error('audio.yaml: speed must be positive');
  if (audio.provider === 'kokoro' && model !== KOKORO_MODEL) throw new Error('audio.yaml: Kokoro model must be ' + KOKORO_MODEL);
  return { ...audio, model, speed };
}
function voiceLines(root, audio) {
  const parsed = parseYaml(fs.readFileSync(path.join(root, 'storyboard.yaml'), 'utf8'), 'storyboard.yaml');
  if (parsed.problems.length || !Array.isArray(parsed.data?.beats)) throw new Error('storyboard.yaml: expected beats');
  const ids = new Set();
  return parsed.data.beats.filter((beat) => typeof beat?.say === 'string' && beat.say.trim()).map((beat) => {
    if (typeof beat.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(beat.id) || ids.has(beat.id)) throw new Error('storyboard.yaml: narration beats need unique, safe ids');
    ids.add(beat.id);
    const request = { provider: audio.provider, voice: audio.voice, model: audio.model, speed: audio.speed, text: beat.say };
    return { beat, request, key: cacheKey(request), clip: readCache(root, request) };
  });
}
export function voicePending(root, audio = readAudio(root)) {
  const pending = new Map();
  for (const line of voiceLines(root, audio)) if (!line.clip) pending.set(line.key, line);
  return { lines: pending.size, characters: [...pending.values()].reduce((sum, line) => sum + line.request.text.length, 0) };
}
export function voiceCommand(root, audio = readAudio(root)) {
  const pending = voicePending(root, audio);
  if (!pending.lines) return 'ghostcast voice';
  if (audio.provider === 'elevenlabs') return 'ghostcast voice --approve';
  const status = kokoroStatus(undefined, audio.voice);
  return 'ghostcast voice' + (!status.installed || !status.modelCached || !status.voiceCached ? ' --install' : '');
}
// A generated plan counts only for the storyboard and the voice it was spoken from: after audio.yaml
// switches provider (or to none) or voice, a leftover plan would time the cut to speech it lacks.
export function generatedPlan(root) {
  try {
    const plan = JSON.parse(fs.readFileSync(path.join(root, 'voiceover', 'plan.json'), 'utf8'));
    const audio = readAudio(root);
    return plan.generated?.storyboardHash === storyboardHash(root) && plan.generated.provider === audio.provider
      && plan.generated.voice === audio.voice && Array.isArray(plan.pieces) ? plan : null;
  } catch { return null; }
}

export async function voice(root, { install = false, approve = false, provider, fetch, env = process.env, log = console.log, kokoroOptions = {} } = {}) {
  const audio = readAudio(root);
  if (!['kokoro', 'elevenlabs'].includes(audio.provider)) {
    log(audio.provider === 'clips' ? 'Use your clips: write voiceover/plan.json, then run ghostcast vo-mix.' : 'Audio is none: the silent cut is ready; choose kokoro or elevenlabs in audio.yaml to generate speech.');
    return null;
  }
  const planFile = path.join(root, 'voiceover', 'plan.json');
  if (fs.existsSync(planFile)) {
    let previous;
    try { previous = JSON.parse(fs.readFileSync(planFile, 'utf8')); } catch { throw new Error('voiceover/plan.json is unreadable; preserve it before generating speech'); }
    if (!previous?.generated) throw new Error('voiceover/plan.json is a hand-written plan; move it aside before running ghostcast voice');
  }
  const hash = storyboardHash(root), lines = voiceLines(root, audio);
  const pending = new Map(lines.filter((line) => !line.clip).map((line) => [line.key, line]));
  if (audio.provider === 'elevenlabs') {
    const count = [...pending.values()].reduce((sum, line) => sum + line.request.text.length, 0);
    log('ElevenLabs: ' + count + ' characters in ' + pending.size + ' lines (about ' + count + ' credits)');
    if (pending.size && !approve) throw new Error('Approve this cost with ghostcast voice --approve');
  }
  if (pending.size || install && audio.provider === 'kokoro') {
    provider ??= audio.provider === 'kokoro' ? await kokoro({ ...kokoroOptions, install }) : elevenlabs({ key: readKey(root, env), fetch });
  }
  let wps = 2.5;
  const configFile = path.join(root, 'project.json');
  if (fs.existsSync(configFile)) wps = JSON.parse(fs.readFileSync(configFile, 'utf8')).voiceover?.wordsPerSecond ?? wps;
  const pieces = [];
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  for (const line of lines) {
    const clip = line.clip || readCache(root, line.request) || await provider.generate(line.request);
    if (!line.clip) writeCache(root, line.request, clip);
    const name = line.beat.id + '.wav';
    fs.writeFileSync(path.join(root, 'voiceover', name), clip.wav);
    pieces.push({ clip: name, from: 0, to: clip.seconds, take: 'storyboard', segment: line.beat.id, offset: .3, text: line.beat.say });
    const estimate = estimateBeat(line.beat, wps).seconds;
    log(line.beat.id + ': ' + clip.seconds.toFixed(2) + 's clip, ' + estimate.toFixed(2) + 's lint estimate' + (clip.seconds > estimate ? ' — longer than estimate' : ''));
  }
  const plan = { generated: { provider: audio.provider, voice: audio.voice, storyboardHash: hash }, pieces };
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 2) + '\n');
  return plan;
}

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { cacheDir } from '../world.mjs';
import { joinSentences, splitSentences } from './audio.mjs';

export const KOKORO_VERSION = '1.2.1';
export const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
export const kokoroDir = () => path.join(cacheDir(), 'kokoro');
const installHint = 'Kokoro needs kokoro-js and its runtime (about 400 MB), plus an 86 MB q8 model. Run ghostcast voice --install to download them.';

export function kokoroStatus(dir = kokoroDir(), voice) {
  const installed = fs.existsSync(path.join(dir, 'node_modules', 'kokoro-js', 'package.json'));
  const walk = (folder, matches) => {
    try {
      return fs.readdirSync(folder, { withFileTypes: true }).some((entry) => entry.isDirectory()
        ? walk(path.join(folder, entry.name), matches)
        : matches(entry.name) && fs.statSync(path.join(folder, entry.name)).size > 0);
    } catch { return false; }
  };
  const models = path.join(dir, 'models');
  return { installed, modelCached: walk(models, (name) => /(?:quantized|q8)\.onnx$/.test(name)), dir,
    ...(voice ? { voiceCached: walk(models, (name) => name === voice + '.bin') } : {}) };
}
function installRuntime(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const command = fs.existsSync(npmCli) ? process.execPath : 'npm';
  const args = [...(command === process.execPath ? [npmCli] : []), 'install', '--prefix', dir, 'kokoro-js@' + KOKORO_VERSION];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', () => reject(new Error('Kokoro: npm could not start; install Node with npm, then run ghostcast voice --install')));
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error('Kokoro: npm install failed (exit ' + code + ')')));
  });
}
function importEntry(folder) {
  const pkg = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8'));
  const select = (value) => typeof value === 'string' ? value : value && select(value.node ?? value.import ?? value.default ?? value['.']);
  const entry = select(pkg.exports?.['.'] ?? pkg.exports) ?? pkg.module ?? pkg.main;
  if (!entry) throw new Error('Kokoro: installed package has no entry point; run ghostcast voice --install');
  return pathToFileURL(path.resolve(folder, entry)).href;
}
async function loadRuntime(url, dir) {
  const runtime = await import(url);
  const candidates = [path.join(dir, 'node_modules', '@huggingface', 'transformers'),
    path.join(dir, 'node_modules', 'kokoro-js', 'node_modules', '@huggingface', 'transformers')];
  const folder = candidates.find((candidate) => fs.existsSync(path.join(candidate, 'package.json')));
  if (!folder) throw new Error('Kokoro: transformers runtime is missing; run ghostcast voice --install');
  const { env } = await import(importEntry(folder));
  return { ...runtime, env };
}
export async function kokoro({ install = false, dir = kokoroDir(), runInstall = installRuntime, load = loadRuntime, tts } = {}) {
  if (!tts) {
    let status = kokoroStatus(dir);
    if (!status.installed) {
      if (!install) throw new Error(installHint);
      await runInstall(dir);
      status = kokoroStatus(dir);
    }
    if (!status.modelCached && !install) throw new Error(installHint);
    const { KokoroTTS, env } = await load(importEntry(path.join(dir, 'node_modules', 'kokoro-js')), dir);
    if (env) {
      // Voice embeddings are fetched lazily too, and must obey the same explicit consent.
      env.cacheDir = path.join(dir, 'models');
      env.allowRemoteModels = install;
    }
    try {
      tts = await KokoroTTS.from_pretrained(KOKORO_MODEL, { dtype: 'q8', device: 'cpu',
        cache_dir: path.join(dir, 'models'), local_files_only: !install });
    } catch { throw new Error('Kokoro: model could not load. ' + installHint); }
  }
  return { async generate({ text, voice, model = KOKORO_MODEL, speed = 1 }) {
    if (model !== KOKORO_MODEL) throw new Error('Kokoro: model must be ' + KOKORO_MODEL);
    const voices = Object.keys(tts.voices || {});
    if (!voices.includes(voice)) throw new Error('Kokoro: unknown voice ' + voice + '; try ' + (voices.slice(0, 5).join(', ') || 'af_heart, am_michael, bf_emma'));
    const parts = [];
    let sampleRate;
    for (const sentence of splitSentences(text)) {
      let audio;
      try { audio = await tts.generate(sentence, { voice, speed }); }
      catch { throw new Error('Kokoro: sentence or voice data could not load. ' + installHint); }
      const rate = audio.sampling_rate;
      if (!Number.isFinite(rate) || rate <= 0 || (sampleRate && sampleRate !== rate)) throw new Error('Kokoro: invalid sample rate');
      sampleRate = rate;
      parts.push({ text: sentence, audio: audio.audio });
    }
    return joinSentences(parts, sampleRate || 24000);
  } };
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { splitSentences, joinSentences, pcmWav } from '../src/voice/audio.mjs';
import { cacheKey, readCache } from '../src/voice/cache.mjs';
import { voice, voicePending, voiceCommand, voiceDoctor, readAudio, generatedPlan } from '../src/voice/index.mjs';
import { elevenlabs, readKey, keySource, alignmentSentences, ELEVENLABS_MODEL } from '../src/voice/elevenlabs.mjs';
import { kokoro, kokoroStatus, KOKORO_MODEL, KOKORO_VERSION } from '../src/voice/kokoro.mjs';
import { fitTargets } from '../src/post/fit.mjs';
import { place, resolveVoiceClip } from '../src/post/voice.mjs';
import { storyboardHash } from '../src/studio/approve.mjs';
import { next } from '../src/studio/next.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'ghostcast.mjs');
const json = (dir, file, value) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), JSON.stringify(value));
};
const story = () => ({ video: 'demo', weight: 'standard', type: 'how-to', cap: 120, beats: [
  { id: 'first', surface: 'web', show: 'text "Ready"', say: 'First line.' },
  { id: 'last', surface: 'web', show: 'text "Done"', say: 'Last line.' },
  { id: 'quiet', surface: 'web', show: 'text "Quiet"' },
] });
function fixture(t, provider = 'kokoro') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostcast-voice-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  fs.writeFileSync(path.join(dir, 'product.md'), 'studio');
  fs.writeFileSync(path.join(dir, 'audio.yaml'), YAML.stringify({ provider, ...(['kokoro', 'elevenlabs'].includes(provider) ? { voice: provider === 'kokoro' ? 'af_heart' : 'voice/id' } : {}) }));
  fs.writeFileSync(path.join(dir, 'storyboard.yaml'), YAML.stringify(story()));
  return dir;
}
function fake(seconds = 4) {
  const calls = [];
  return { calls, async generate(request) {
    calls.push(request);
    return { wav: pcmWav(Buffer.alloc(seconds * 48000)), seconds,
      sentences: [{ text: request.text, start: 0, end: seconds }] };
  } };
}
const silentLog = () => {};
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const cli = (dir, ...args) => spawnSync(process.execPath, [CLI, ...args, '--project', dir], { cwd: dir, encoding: 'utf8' });
const alignment = (text) => ({ characters: [...text], character_start_times_seconds: [...text].map((_, i) => i / 10),
  character_end_times_seconds: [...text].map((_, i) => (i + 1) / 10) });
const response = (text) => ({ ok: true, async json() { return { audio_base64: Buffer.alloc(text.length * 4800).toString('base64'), alignment: alignment(text) }; } });

test('sentence splitting keeps abbreviations and trailing punctuation intact', () => {
  assert.deepEqual(splitSentences('Dr. Smith uses e.g. a CLI. Does it work? Yes!'), ['Dr. Smith uses e.g. a CLI.', 'Does it work?', 'Yes!']);
  assert.deepEqual(splitSentences('Try i.e. one thing. U.S. users agree. Tail without punctuation'), ['Try i.e. one thing.', 'U.S. users agree.', 'Tail without punctuation']);
  assert.deepEqual(splitSentences('  One!  Two?\nThree. '), ['One!', 'Two?', 'Three.']);
  assert.deepEqual(splitSentences(''), []);
});

test('joined sentences have PCM WAV samples, a quarter-second gap and exact timing', () => {
  const clip = joinSentences([{ text: 'One.', audio: new Float32Array([1, -1, 0, .5]) },
    { text: 'Two.', audio: new Float32Array([.25, 0]) }], 4);
  assert.deepEqual(clip.sentences, [{ text: 'One.', start: 0, end: 1 }, { text: 'Two.', start: 1.25, end: 1.75 }]);
  assert.equal(clip.seconds, 1.75);
  assert.equal(clip.wav.readUInt32LE(24), 4);
  assert.equal(clip.wav.readUInt32LE(40), 14);
  assert.equal(clip.wav.readInt16LE(44), 32767);
  assert.equal(clip.wav.readInt16LE(46), -32768);
  assert.equal(clip.wav.readInt16LE(52), 0, 'silence between sentences');
});

test('cache keys include only provider, voice, model, speed and text in a stable order', () => {
  const request = { provider: 'kokoro', voice: 'af_heart', model: KOKORO_MODEL, speed: 1, text: 'Hello.' };
  const key = cacheKey(request);
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(cacheKey({ ...request, key: 'synthetic credential', extra: true }), key);
  assert.equal(cacheKey(Object.fromEntries(Object.entries(request).reverse())), key);
  for (const field of Object.keys(request)) assert.notEqual(cacheKey({ ...request, [field]: 'changed' }), key, field);
});

test('second run costs no provider calls; changing one line regenerates exactly one', async (t) => {
  const dir = fixture(t), provider = fake();
  await voice(dir, { provider, log: silentLog });
  assert.equal(provider.calls.length, 2);
  const cached = readCache(dir, provider.calls[0]);
  assert.equal(cached.seconds, 4);
  assert.deepEqual(cached.sentences, [{ text: 'First line.', start: 0, end: 4 }]);
  assert.equal(voicePending(dir).lines, 0);
  // No runtime import/install is needed on a cache hit.
  await voice(dir, { log: silentLog });
  assert.equal(provider.calls.length, 2);
  const changed = story(); changed.beats[1].say = 'An edited line.';
  fs.writeFileSync(path.join(dir, 'storyboard.yaml'), YAML.stringify(changed));
  await voice(dir, { provider, log: silentLog });
  assert.equal(provider.calls.length, 3);
  assert.equal(provider.calls[2].text, 'An edited line.');
});

test('duplicate lines generate and count cost once, while preserving both beat pieces', async (t) => {
  const dir = fixture(t, 'elevenlabs'), provider = fake(), changed = story();
  changed.beats[1].say = changed.beats[0].say;
  fs.writeFileSync(path.join(dir, 'storyboard.yaml'), YAML.stringify(changed));
  assert.deepEqual(voicePending(dir), { lines: 1, characters: 11 });
  const plan = await voice(dir, { approve: true, provider, log: silentLog });
  assert.equal(provider.calls.length, 1);
  assert.equal(plan.pieces.length, 2);
});

test('plan pieces, generated hash, WAV outputs and lint estimates describe each narration beat', async (t) => {
  const dir = fixture(t), provider = fake(), logs = [];
  const plan = await voice(dir, { provider, log: (line) => logs.push(line) });
  assert.deepEqual(plan.generated, { provider: 'kokoro', voice: 'af_heart', storyboardHash: storyboardHash(dir) });
  assert.deepEqual(plan.pieces, story().beats.slice(0, 2).map((beat) => ({ clip: beat.id + '.wav', from: 0, to: 4,
    take: 'storyboard', segment: beat.id, offset: .3, text: beat.say })));
  for (const piece of plan.pieces) assert.deepEqual(fs.readFileSync(path.join(dir, 'voiceover', piece.clip)), pcmWav(Buffer.alloc(192000)));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'voiceover/plan.json'))), plan);
  assert.match(logs[0], /first: 4.00s clip, 2.00s lint estimate.*longer than estimate/);
  assert.equal(logs.length, 2);
});

test('hand-written and unreadable plans are preserved before any request or install', async (t) => {
  const dir = fixture(t), provider = fake();
  json(dir, 'voiceover/plan.json', { pieces: [] });
  const before = fs.readFileSync(path.join(dir, 'voiceover/plan.json'));
  await assert.rejects(voice(dir, { provider, install: true, log: silentLog }), /hand-written plan/);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'voiceover/plan.json')), before);
  assert.equal(provider.calls.length, 0);
  fs.writeFileSync(path.join(dir, 'voiceover/plan.json'), '{invalid');
  await assert.rejects(voice(dir, { provider, log: silentLog }), /unreadable/);
  assert.equal(provider.calls.length, 0);
});

test('fitTargets uses current generated clips, honors minBeat, and falls back for stale or manual plans', async (t) => {
  const dir = fixture(t);
  await voice(dir, { provider: fake(), log: silentLog });
  assert.equal(fitTargets(dir, 'storyboard', []).targets.first, 4.7);
  assert.equal(fitTargets(dir, 'storyboard', [], { direction: { minBeat: 6 } }).targets.first, 6);
  assert.equal(fitTargets(dir, 'storyboard', []).targets.quiet, 2);
  assert.deepEqual(fitTargets(dir, 'other', []).targets, {});
  const plan = generatedPlan(dir);
  // Switching audio.yaml to another provider, or to none, leaves the plan behind: it no longer counts.
  const audioFile = path.join(dir, 'audio.yaml'), audio = fs.readFileSync(audioFile, 'utf8');
  fs.writeFileSync(audioFile, 'provider: none\n');
  assert.equal(generatedPlan(dir), null);
  assert.equal(fitTargets(dir, 'storyboard', []).targets.first, 2);
  fs.writeFileSync(audioFile, audio.replace(/voice: .*/, 'voice: another_voice'));
  assert.equal(generatedPlan(dir), null, 'a plan spoken in another voice is stale');
  fs.writeFileSync(audioFile, audio);
  assert.equal(fitTargets(dir, 'storyboard', []).targets.first, 4.7);
  json(dir, 'voiceover/plan.json', { ...plan, generated: { ...plan.generated, storyboardHash: 'stale' } });
  assert.equal(fitTargets(dir, 'storyboard', []).targets.first, 2);
  json(dir, 'voiceover/plan.json', { pieces: plan.pieces });
  assert.equal(fitTargets(dir, 'storyboard', []).targets.first, 2);
  fs.rmSync(path.join(dir, 'voiceover/plan.json'));
  assert.equal(fitTargets(dir, 'storyboard', []).targets.first, 2);
  const changed = story(); changed.beats[0].say = Array(10).fill('word').join(' ');
  fs.writeFileSync(path.join(dir, 'storyboard.yaml'), YAML.stringify(changed));
  json(dir, 'voiceover/plan.json', plan);
  assert.equal(fitTargets(dir, 'storyboard', []).targets.first, 4.6, 'stale plan uses the new word estimate');
});

test('actual clip targets leave placement room before the next beat', async (t) => {
  const dir = fixture(t), plan = await voice(dir, { provider: fake(), log: silentLog });
  const targets = fitTargets(dir, 'storyboard', []).targets;
  const takes = { storyboard: { start: 0, end: targets.first + targets.last,
    segments: { first: 0, last: targets.first } } };
  const [placed, problems] = place(plan.pieces, takes, takes.storyboard.end);
  assert.ok(placed[0].end < takes.storyboard.segments.last);
  assert.equal(placed[1].start, targets.first + .3);
  assert.deepEqual(problems, []);
});

test('vo-mix resolves clips relative to any plan folder, including the existing voiceover folder', () => {
  assert.equal(resolveVoiceClip(path.join(ROOT, 'voiceover/plan.json'), 'first.wav'), path.join(ROOT, 'voiceover/first.wav'));
  assert.equal(resolveVoiceClip(path.join(ROOT, 'custom/plan.json'), 'first.wav'), path.join(ROOT, 'custom/first.wav'));
});

test('ElevenLabs request uses timestamp endpoint, user key, model and PCM WAV output', async () => {
  const text = 'One. Two!', calls = [];
  const provider = elevenlabs({ key: 'synthetic-test-value', fetch: async (url, options) => { calls.push({ url, options }); return response(text); } });
  const clip = await provider.generate({ text, voice: 'voice/id', model: 'custom_model', speed: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.elevenlabs.io/v1/text-to-speech/voice%2Fid/with-timestamps?output_format=pcm_24000');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(calls[0].options.headers, { 'xi-api-key': 'synthetic-test-value', 'Content-Type': 'application/json' });
  assert.deepEqual(JSON.parse(calls[0].options.body), { text, model_id: 'custom_model' });
  assert.equal(clip.wav.readUInt32LE(24), 24000);
  assert.equal(clip.seconds, .9);
  assert.deepEqual(clip.sentences, [{ text: 'One.', start: 0, end: .4 }, { text: 'Two!', start: .5, end: .9 }]);
});

test('ElevenLabs default model and abbreviation timing derive from exact character alignment', async () => {
  const text = 'Use e.g. this. Done.';
  const provider = elevenlabs({ key: 'synthetic', fetch: async (_url, options) => {
    assert.equal(JSON.parse(options.body).model_id, ELEVENLABS_MODEL); return response(text);
  } });
  assert.deepEqual((await provider.generate({ text, voice: 'voice' })).sentences, [
    { text: 'Use e.g. this.', start: 0, end: 1.4 }, { text: 'Done.', start: 1.5, end: 2 },
  ]);
  assert.throws(() => alignmentSentences('Different', alignment(text)), /invalid character alignment/);
});

test('ElevenLabs prints uncached character cost and stops before fetch without approval', async (t) => {
  const dir = fixture(t, 'elevenlabs'), logs = [];
  let calls = 0;
  const fetch = async (_url, options) => { calls++; return response(JSON.parse(options.body).text); };
  await assert.rejects(voice(dir, { fetch, log: (line) => logs.push(line), env: { ELEVENLABS_API_KEY: 'synthetic' } }), /ghostcast voice --approve/);
  assert.equal(calls, 0);
  assert.deepEqual(logs, ['ElevenLabs: 21 characters in 2 lines (about 21 credits)']);
  assert.ok(!fs.existsSync(path.join(dir, 'voiceover/plan.json')));
  await voice(dir, { approve: true, fetch, log: silentLog, env: { ELEVENLABS_API_KEY: 'synthetic' } });
  assert.equal(calls, 2);
  await voice(dir, { fetch: () => { throw Error('cache must avoid fetch'); }, env: {}, log: (line) => logs.push(line) });
  assert.ok(logs.includes('ElevenLabs: 0 characters in 0 lines (about 0 credits)'));
  const changed = story(); changed.beats[1].say = 'Changed.';
  fs.writeFileSync(path.join(dir, 'storyboard.yaml'), YAML.stringify(changed));
  logs.length = 0;
  await assert.rejects(voice(dir, { fetch, log: (line) => logs.push(line) }), /--approve/);
  assert.equal(logs[0], 'ElevenLabs: 8 characters in 1 lines (about 8 credits)');
  assert.equal(calls, 2);
});

test('ElevenLabs reports 401, rate limits and quota without reflecting credentials or response bodies', async () => {
  for (const status of [401, 429, 402, 403, 500]) {
    const provider = elevenlabs({ key: 'synthetic-secret', fetch: async () => ({ ok: false, status,
      async text() { throw Error('must not read error body'); } }) });
    await assert.rejects(provider.generate({ text: 'Hello.', voice: 'voice' }), (error) => {
      assert.match(error.message, new RegExp('HTTP ' + status)); assert.ok(!error.message.includes('synthetic-secret')); return true;
    });
  }
  await assert.rejects(elevenlabs({ key: 'synthetic', fetch: async () => { throw Error('synthetic'); } })
    .generate({ text: 'Hello.', voice: 'voice' }), /request failed; check your connection/);
});

test('ElevenLabs reads secrets.env, supports quotes and environment precedence, and reports only the source', async (t) => {
  const dir = fixture(t, 'elevenlabs');
  assert.equal(readKey(dir, {}), null); assert.equal(keySource(dir, {}), null);
  fs.writeFileSync(path.join(dir, 'secrets.env'), '# local configuration\nELEVENLABS_API_KEY="synthetic-file-value"\n');
  assert.equal(readKey(dir, {}), 'synthetic-file-value'); assert.equal(keySource(dir, {}), 'secrets.env');
  assert.equal(readKey(dir, { ELEVENLABS_API_KEY: 'synthetic-env-value' }), 'synthetic-env-value');
  assert.equal(keySource(dir, { ELEVENLABS_API_KEY: 'synthetic-env-value' }), 'environment');
  await voice(dir, { approve: true, env: {}, log: silentLog, fetch: async (_url, options) => {
    assert.equal(options.headers['xi-api-key'], 'synthetic-file-value'); return response(JSON.parse(options.body).text);
  } });
  assert.ok(!fs.readFileSync(path.join(dir, 'voiceover/plan.json'), 'utf8').includes('synthetic-file-value'));
});

test('Kokoro missing install names sizes and --install, and downloads nothing', async (t) => {
  const dir = fixture(t); let downloads = 0;
  const opts = { dir: path.join(dir, 'runtime'), runInstall: async () => { downloads++; }, load: async () => { downloads++; } };
  await assert.rejects(kokoro(opts), (error) => {
    assert.match(error.message, /ghostcast voice --install/); assert.match(error.message, /400 MB/); assert.match(error.message, /86 MB/); return true;
  });
  assert.equal(downloads, 0); assert.ok(!fs.existsSync(opts.dir));
  assert.deepEqual(kokoroStatus(opts.dir), { installed: false, modelCached: false, dir: opts.dir });
  await assert.rejects(voice(dir, { log: silentLog, kokoroOptions: opts }), /ghostcast voice --install/);
  assert.equal(downloads, 0);
});

test('Kokoro installed runtime also requires explicit consent to fetch a missing model', async (t) => {
  const dir = fixture(t), runtime = path.join(dir, 'runtime'); let loads = 0;
  json(runtime, 'node_modules/kokoro-js/package.json', { exports: { node: { import: './dist/kokoro.js' } } });
  await assert.rejects(kokoro({ dir: runtime, load: async () => { loads++; } }), /--install/);
  assert.equal(loads, 0);
});

test('Kokoro explicit installation loads absolute entry, fixed q8 CPU model and caches locally', async (t) => {
  const dir = fixture(t), runtime = path.join(dir, 'runtime'), installs = [], loads = [];
  const provider = await kokoro({ dir: runtime, install: true, runInstall: async (destination) => {
    installs.push(destination); json(destination, 'node_modules/kokoro-js/package.json', { exports: { node: { import: './dist/kokoro.js' } } });
  }, load: async (url) => {
    loads.push(url);
    return { KokoroTTS: { async from_pretrained(model, options) {
      assert.equal(model, KOKORO_MODEL); assert.deepEqual(options, { dtype: 'q8', device: 'cpu', cache_dir: path.join(runtime, 'models'), local_files_only: false });
      return { voices: { af_heart: {} }, async generate() { return { audio: new Float32Array(24000), sampling_rate: 24000 }; } };
    } } };
  } });
  assert.match(KOKORO_VERSION, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(installs, [runtime]); assert.match(loads[0], /^file:\/\//);
  assert.match(loads[0], /node_modules\/kokoro-js\/dist\/kokoro.js$/);
  assert.equal((await provider.generate({ text: 'Hello.', voice: 'af_heart' })).seconds, 1);
});

test('Kokoro speaks sentences separately, propagates speed and rejects unknown voice/model', async () => {
  const calls = [], provider = await kokoro({ tts: { voices: { af_heart: {}, am_michael: {}, bf_emma: {} },
    async generate(text, options) { calls.push({ text, options }); return { audio: new Float32Array(24000), sampling_rate: 24000 }; } } });
  const clip = await provider.generate({ text: 'Use e.g. this. Done!', voice: 'af_heart', speed: 1.2 });
  assert.deepEqual(calls, [{ text: 'Use e.g. this.', options: { voice: 'af_heart', speed: 1.2 } }, { text: 'Done!', options: { voice: 'af_heart', speed: 1.2 } }]);
  assert.deepEqual(clip.sentences, [{ text: 'Use e.g. this.', start: 0, end: 1 }, { text: 'Done!', start: 1.25, end: 2.25 }]);
  await assert.rejects(provider.generate({ text: 'Hello.', voice: 'unknown' }), /unknown voice.*af_heart.*am_michael.*bf_emma/);
  await assert.rejects(provider.generate({ text: 'Hello.', voice: 'af_heart', model: 'wrong' }), /model must be/);
});

test('none and clips give guidance and exit successfully without generating', async (t) => {
  for (const audio of ['none', 'clips']) {
    const dir = fixture(t, audio), logs = [], provider = fake();
    assert.equal(await voice(dir, { provider, log: (line) => logs.push(line) }), null);
    assert.equal(provider.calls.length, 0); assert.ok(!fs.existsSync(path.join(dir, 'voiceover')));
    assert.match(logs[0], audio === 'none' ? /silent cut/ : /ghostcast vo-mix/);
    const output = cli(dir, 'voice'); assert.equal(output.status, 0, output.stderr);
  }
});

test('audio reads optional model/speed without requiring a schema change and rejects unsafe beat ids', async (t) => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'audio.yaml'), YAML.stringify({ provider: 'kokoro', voice: 'af_heart', model: KOKORO_MODEL, speed: 1.2 }));
  const provider = fake(); await voice(dir, { provider, log: silentLog });
  assert.equal(provider.calls[0].speed, 1.2); assert.equal(readAudio(dir).model, KOKORO_MODEL);
  fs.writeFileSync(path.join(dir, 'audio.yaml'), 'provider: kokoro\nvoice: af_heart\nspeed: 0\n');
  assert.throws(() => readAudio(dir), /speed must be positive/);
  fs.writeFileSync(path.join(dir, 'audio.yaml'), 'provider: kokoro\nvoice: af_heart\n');
  const unsafe = story(); unsafe.beats[0].id = '../escape';
  fs.writeFileSync(path.join(dir, 'storyboard.yaml'), YAML.stringify(unsafe));
  await assert.rejects(voice(dir, { provider, log: silentLog }), /safe ids/);
});

test('all refuses unapproved paid cost before compile, recording or world preparation', (t) => {
  const dir = fixture(t, 'elevenlabs'), output = cli(dir, 'all');
  assert.equal(output.status, 1); assert.match(output.stdout, /21 characters in 2 lines/);
  assert.match(output.stderr, /ghostcast voice --approve/);
  for (const file of ['raw', 'timeline.json', 'cache/storyboard.mjs']) assert.ok(!fs.existsSync(path.join(dir, file)), file);
});

function confirmedCut(dir, provider) {
  fs.writeFileSync(path.join(dir, 'product.md'), '## What it is\nA demo.\n## How to run it\nRun npm start.\n## Seed data\nnone\n## Signing in\nnone\n## Flows worth showing\n- Open the app.\n## Off limits\nPrivate accounts.\n');
  fs.writeFileSync(path.join(dir, 'brief.md'), '---\naudience: Developers\ngoal: Show a result\nweight: standard\ntype: how-to\ncap: 120\ndestinations: [docs]\naudio: ' + provider + '\npanel_share: 0.2\n---\n');
  fs.writeFileSync(path.join(dir, 'world.yaml'), 'source: ..\nmode: snapshot\n');
  const cutStory = story(); cutStory.beats = cutStory.beats.slice(0, 1); cutStory.beats[0].open = '/demo';
  fs.writeFileSync(path.join(dir, 'storyboard.yaml'), YAML.stringify(cutStory));
  const storyboard = storyboardHash(dir);
  json(dir, 'approvals.json', { storyboard: { sha256: storyboard } });
  json(dir, 'cache/rehearsal.json', { storyboardHash: storyboard, runs: 3, beats: [{ id: 'first', status: 'pass', passes: 3, reached: 3 }] });
  json(dir, 'raw/storyboard/source.json', { storyboardHash: storyboard });
  json(dir, 'raw/storyboard/log.json', [[0, '+first'], [100, 'show', { text: 'Ready' }], [200, '-first']]);
  json(dir, 'clips/storyboard.json', { duration: 5, segments: [{ segment: 'first', start: 0, end: 5 }] });
  fs.writeFileSync(path.join(dir, 'clips/storyboard.mp4'), 'clip');
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'out/demo-silent.mp4'), 'silent');
  const newer = new Date(Date.now() + 3000);
  for (const file of ['clips/storyboard.json', 'clips/storyboard.mp4', 'out/demo-silent.mp4']) fs.utimesSync(path.join(dir, file), newer, newer);
  json(dir, 'cache/checks.json', { errors: 0, warnings: 0, problems: [], cut: { storyboard: hash(path.join(dir, 'clips/storyboard.json')) } });
  json(dir, 'confirmations.json', { 'storyboard/first': { take: hash(path.join(dir, 'raw/storyboard/log.json')) } });
}

test('next voice stage preserves JSON shape, suggests cost approval, and requires newer output and clean placement', async (t) => {
  const dir = fixture(t, 'elevenlabs'); confirmedCut(dir, 'elevenlabs');
  let report = next(dir); assert.equal(report.stage, 'voice', JSON.stringify(report));
  assert.deepEqual(Object.keys(report).sort(), ['stage', 'state', 'problems', 'next', 'warnings'].sort());
  assert.match(report.next, /ghostcast voice --approve.*ghostcast vo-mix/);
  await voice(dir, { approve: true, provider: fake(), log: silentLog });
  assert.equal(voiceCommand(dir), 'ghostcast voice');
  report = next(dir); assert.match(report.next, /ghostcast voice`, then/);
  fs.writeFileSync(path.join(dir, 'out/demo.mp4'), 'voiced');
  fs.writeFileSync(path.join(dir, 'out/demo.placement.md'), 'Problems: none\n');
  assert.equal(next(dir).stage, 'voice', 'output older than silent cut');
  const newer = new Date(Date.now() + 6000); fs.utimesSync(path.join(dir, 'out/demo.mp4'), newer, newer);
  fs.writeFileSync(path.join(dir, 'out/demo.placement.md'), 'Problems: overlap\n');
  assert.equal(next(dir).stage, 'voice');
  fs.writeFileSync(path.join(dir, 'out/demo.placement.md'), 'Problems: none\n');
  report = next(dir); assert.equal(report.stage, 'done'); assert.equal(report.next, 'out/demo.mp4');
});

test('next suggests Kokoro installation only for misses; none keeps the silent done stage', async (t) => {
  const dir = fixture(t), prior = process.env.GHOSTCAST_CACHE;
  process.env.GHOSTCAST_CACHE = path.join(dir, 'runtime');
  t.after(() => { if (prior === undefined) delete process.env.GHOSTCAST_CACHE; else process.env.GHOSTCAST_CACHE = prior; });
  confirmedCut(dir, 'kokoro');
  assert.match(next(dir).next, /ghostcast voice --install/);
  await voice(dir, { provider: fake(), log: silentLog });
  assert.equal(voiceCommand(dir), 'ghostcast voice');
  const silent = fixture(t, 'none'); confirmedCut(silent, 'none');
  assert.equal(next(silent).stage, 'done'); assert.equal(next(silent).next, 'out/demo-silent.mp4');
});

test('cached Kokoro loads with local-only options and disables remote lazy voice downloads', async (t) => {
  const dir = fixture(t), runtime = path.join(dir, 'runtime'), env = {};
  json(runtime, 'node_modules/kokoro-js/package.json', { exports: './dist/kokoro.js' });
  fs.mkdirSync(path.join(runtime, 'models', 'onnx-community', 'Kokoro-82M-v1.0-ONNX', 'onnx'), { recursive: true });
  fs.writeFileSync(path.join(runtime, 'models', 'onnx-community', 'Kokoro-82M-v1.0-ONNX', 'onnx', 'model_quantized.onnx'), 'cached-model');
  const provider = await kokoro({ dir: runtime, load: async () => ({ env, KokoroTTS: { async from_pretrained(_model, options) {
    assert.equal(options.local_files_only, true);
    return { voices: { af_heart: {} }, async generate() {
      assert.equal(env.allowRemoteModels, false); assert.equal(env.cacheDir, path.join(runtime, 'models'));
      throw Error('missing voice embedding');
    } };
  } } }) });
  assert.equal(kokoroStatus(runtime).modelCached, true);
  assert.equal(kokoroStatus(runtime, 'af_heart').voiceCached, false);
  await assert.rejects(provider.generate({ text: 'Hello.', voice: 'af_heart' }), /ghostcast voice --install/);
});

test('doctor speech checks are optional and reveal only installation, model sizes and key source', (t) => {
  const dir = fixture(t), runtime = path.join(dir, 'runtime');
  let lines = voiceDoctor(dir, { dir: runtime, env: {} });
  assert.equal(lines.length, 2); assert.ok(lines.every((line) => line.startsWith('opt   ')));
  assert.match(lines[0], /not installed.*400 MB.*not cached.*86 MB/);
  assert.match(lines[1], /not found/);
  fs.writeFileSync(path.join(dir, 'secrets.env'), 'ELEVENLABS_API_KEY=synthetic-doctor-value\n');
  lines = voiceDoctor(dir, { dir: runtime, env: {} });
  assert.match(lines[1], /found in secrets.env/); assert.ok(!lines.join(' ').includes('synthetic-doctor-value'));
  lines = voiceDoctor(dir, { dir: runtime, env: { ELEVENLABS_API_KEY: 'synthetic-environment' } });
  assert.match(lines[1], /found in environment/); assert.ok(!lines.join(' ').includes('synthetic-environment'));
});

test('Kokoro imports provider and shared transformers environment from its own data folder', async (t) => {
  const dir = fixture(t), runtime = path.join(dir, 'runtime');
  json(runtime, 'node_modules/@huggingface/transformers/package.json', { type: 'module', exports: { '.': { node: { import: './index.mjs' } } } });
  fs.writeFileSync(path.join(runtime, 'node_modules/@huggingface/transformers/index.mjs'), 'export const env = {};\n');
  json(runtime, 'node_modules/kokoro-js/package.json', { type: 'module', exports: { '.': { node: { import: './index.mjs' } } } });
  fs.writeFileSync(path.join(runtime, 'node_modules/kokoro-js/index.mjs'),
    'import { env } from "@huggingface/transformers";\n' +
    'export class KokoroTTS { static async from_pretrained(model, options) {\n' +
    'if (env.allowRemoteModels !== false || env.cacheDir !== options.cache_dir || !options.local_files_only) throw Error("offline settings missing");\n' +
    'return { voices: { af_heart: {} }, async generate() { return { sampling_rate: 24000, audio: new Float32Array(24000) }; } }; } }\n');
  fs.mkdirSync(path.join(runtime, 'models'), { recursive: true });
  fs.writeFileSync(path.join(runtime, 'models/model_quantized.onnx'), 'cached');
  const provider = await kokoro({ dir: runtime });
  assert.equal((await provider.generate({ text: 'Hello.', voice: 'af_heart' })).seconds, 1);
});

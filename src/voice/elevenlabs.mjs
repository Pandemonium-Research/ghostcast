import fs from 'node:fs';
import path from 'node:path';
import { pcmWav, sentenceSpans } from './audio.mjs';

export const ELEVENLABS_MODEL = 'eleven_multilingual_v2';
export function keySource(root, env = process.env) {
  if (env.ELEVENLABS_API_KEY?.trim()) return 'environment';
  return readKey(root, {}) ? 'secrets.env' : null;
}
export function readKey(root, env = process.env) {
  if (env.ELEVENLABS_API_KEY?.trim()) return env.ELEVENLABS_API_KEY.trim();
  let source;
  try { source = fs.readFileSync(path.join(root, 'secrets.env'), 'utf8'); } catch { return null; }
  const match = /^\s*(?:export\s+)?ELEVENLABS_API_KEY\s*=\s*(.*?)\s*$/m.exec(source);
  if (!match) return null;
  const value = match[1];
  if (/^['"]/.test(value)) return value.slice(1, value.indexOf(value[0], 1) < 0 ? value.length : value.indexOf(value[0], 1)).trim() || null;
  return value.replace(/\s+#.*$/, '').trim() || null;
}
export function alignmentSentences(text, alignment) {
  const characters = alignment?.characters;
  const starts = alignment?.character_start_times_seconds, ends = alignment?.character_end_times_seconds;
  if (!Array.isArray(characters) || characters.join('') !== text || starts?.length !== characters.length || ends?.length !== characters.length)
    throw new Error('ElevenLabs: missing or invalid character alignment');
  let index = 0;
  const ranges = characters.map((character, i) => { const start = index; index += character.length; return { start, end: index, i }; });
  return sentenceSpans(text).map((span) => {
    const first = ranges.find((range) => range.end > span.start)?.i;
    const last = ranges.findLast((range) => range.start < span.end)?.i;
    const start = starts[first], end = ends[last];
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start)
      throw new Error('ElevenLabs: invalid sentence timing');
    return { text: span.text, start, end };
  });
}
export function elevenlabs({ key, fetch: fetcher = globalThis.fetch } = {}) {
  return { async generate({ text, voice, model = ELEVENLABS_MODEL }) {
    if (!key) throw new Error('ElevenLabs: set ELEVENLABS_API_KEY in the environment or studio secrets.env');
    let response;
    try {
      response = await fetcher('https://api.elevenlabs.io/v1/text-to-speech/' + encodeURIComponent(voice) + '/with-timestamps?output_format=pcm_24000', {
        method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, model_id: model }),
      });
    } catch { throw new Error('ElevenLabs: request failed; check your connection'); }
    // Do not echo response bodies: services and fetch implementations can include credentials.
    if (!response.ok) {
      const hint = response.status === 401 ? 'unauthorized; check your API key'
        : response.status === 429 ? 'rate limit or quota exceeded; check your credits and retry later'
          : response.status === 402 || response.status === 403 ? 'access or quota denied; check your account and credits' : 'speech request failed';
      throw new Error('ElevenLabs: HTTP ' + response.status + ' (' + hint + ')');
    }
    let data;
    try { data = await response.json(); } catch { throw new Error('ElevenLabs: invalid JSON response'); }
    if (typeof data?.audio_base64 !== 'string' || !data.audio_base64) throw new Error('ElevenLabs: response has no PCM audio');
    const pcm = Buffer.from(data.audio_base64, 'base64');
    const sentences = alignmentSentences(text, data.alignment);
    return { wav: pcmWav(pcm), seconds: pcm.length / 48000, sentences };
  } };
}

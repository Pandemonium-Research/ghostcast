import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function cacheKey({ provider, voice, model, speed, text }) {
  return crypto.createHash('sha256').update(JSON.stringify({ provider, voice, model, speed, text })).digest('hex');
}
const files = (root, request) => {
  const base = path.join(root, 'cache', 'voice', cacheKey(request));
  return { wav: base + '.wav', json: base + '.json' };
};
export function readCache(root, request) {
  const file = files(root, request);
  try {
    const metadata = JSON.parse(fs.readFileSync(file.json, 'utf8'));
    if (!Number.isFinite(metadata.seconds) || !(metadata.seconds > 0) || !Array.isArray(metadata.sentences)) return null;
    const wav = fs.readFileSync(file.wav);
    if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return null;
    return { wav, seconds: metadata.seconds, sentences: metadata.sentences };
  } catch { return null; }
}
export function writeCache(root, request, clip) {
  if (!Buffer.isBuffer(clip.wav) || clip.wav.length < 44 || !Number.isFinite(clip.seconds) || !(clip.seconds > 0) || !Array.isArray(clip.sentences))
    throw new Error('speech provider returned an invalid WAV or timing');
  const file = files(root, request);
  fs.mkdirSync(path.dirname(file.wav), { recursive: true });
  // Publish metadata last: an interrupted write can never look like a complete cache entry.
  fs.writeFileSync(file.wav, clip.wav);
  fs.writeFileSync(file.json, JSON.stringify({ seconds: clip.seconds, sentences: clip.sentences }, null, 2) + '\n');
}

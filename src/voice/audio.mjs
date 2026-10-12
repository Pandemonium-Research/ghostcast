export const SENTENCE_GAP = .25;

export function sentenceSpans(text) {
  const protectedText = text.replace(/\b(?:e\.g\.|i\.e\.|Mr\.|Mrs\.|Ms\.|Dr\.|Prof\.|Sr\.|Jr\.|vs\.|etc\.)|\b(?:[A-Z]\.){2,}/gi,
    (part) => part.replaceAll('.', '∎'));
  const spans = [];
  for (const match of protectedText.matchAll(/[^]*?(?:[.!?]+(?=\s|$)|$)/g)) {
    const leading = match[0].length - match[0].trimStart().length;
    const start = match.index + leading, end = match.index + match[0].trimEnd().length;
    if (end > start) spans.push({ text: text.slice(start, end), start, end });
  }
  return spans;
}
export const splitSentences = (text) => sentenceSpans(text).map((span) => span.text);

export function pcmWav(pcm, sampleRate = 24000) {
  if (!Buffer.isBuffer(pcm) || pcm.length % 2) throw new Error('speech: expected 16-bit PCM samples');
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function joinSentences(parts, sampleRate = 24000, gap = SENTENCE_GAP) {
  const chunks = [], sentences = [];
  let samples = 0;
  for (const part of parts) {
    if (chunks.length) {
      const silence = Buffer.alloc(Math.round(gap * sampleRate) * 2);
      chunks.push(silence); samples += silence.length / 2;
    }
    const pcm = Buffer.alloc(part.audio.length * 2);
    for (const [i, value] of part.audio.entries()) {
      const clamped = Math.max(-1, Math.min(1, value));
      pcm.writeInt16LE(Math.round(clamped * (clamped < 0 ? 32768 : 32767)), i * 2);
    }
    const start = samples / sampleRate;
    chunks.push(pcm); samples += part.audio.length;
    sentences.push({ text: part.text, start, end: samples / sampleRate });
  }
  return { wav: pcmWav(Buffer.concat(chunks), sampleRate), seconds: samples / sampleRate, sentences };
}

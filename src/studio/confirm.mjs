import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const json = (file, fallback) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
const normalize = (text) => String(text).toLocaleLowerCase().replace(/\s+/g, ' ').trim();
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

export function quotedPhrases(text) {
  return [...String(text).matchAll(/"([^"]+)"|“([^”]+)”|`([^`]+)`/g)]
    .map((match) => match[1] || match[2] || match[3]).filter(Boolean);
}

export function confirmationStatus(root, beat, sees) {
  let takes;
  if (fs.existsSync(path.join(root, 'product.md')) || path.basename(root) === '.ghostcast') takes = ['storyboard'];
  else {
    try { takes = (json(path.join(root, 'timeline.json'), { items: [] }).items || []).map((item) => item.take); } catch { takes = []; }
    if (!takes.length) { try { takes = fs.readdirSync(path.join(root, 'raw')).filter((name) => fs.statSync(path.join(root, 'raw', name)).isDirectory()); } catch {} }
  }
  let found = null;
  for (const take of takes) {
    const logFile = path.join(root, 'raw', take, 'log.json');
    if (!fs.existsSync(logFile)) continue;
    const logBytes = fs.readFileSync(logFile), log = JSON.parse(logBytes.toString('utf8'));
    const start = log.filter((event) => event[1] === `+${beat}`).at(-1)?.[0];
    const end = log.find((event) => event[1] === `-${beat}` && event[0] > start)?.[0];
    if (start == null || end == null) continue;
    const events = log.filter((event) => event[0] >= start && event[0] <= end);
    const facts = events.filter((event) => event[1] === 'facts' && event[2]);
    if (!facts.length) continue;
    found = { take, logBytes, events, facts };
    break;
  }
  if (!found) return { ok: false, message: `confirmation refused: beat ${beat} has no logged page facts, so its text cannot be checked` };
  const { take, logBytes, events, facts } = found;
  const pageText = normalize([...facts.map((event) => event[2].text || ''), ...events.filter((event) => event[1] === 'show').map((event) => event[2]?.text || '')].join(' '));
  const showText = normalize(events.filter((event) => event[1] === 'show').map((event) => event[2]?.text || '').join(' '));
  const phrases = quotedPhrases(sees);
  if (!phrases.length) return { ok: false, message: 'confirmation rejected: quote at least one phrase from what you see' };
  // A phrase of a letter or two is on every page and proves nothing was read.
  const short = phrases.find((phrase) => normalize(phrase).replace(/\s/g, '').length < 3);
  if (short !== undefined) return { ok: false, message: `confirmation rejected: “${short}” is too short to show the page was read; quote at least three characters` };
  for (const phrase of phrases) if (!pageText.includes(normalize(phrase)))
    return { ok: false, message: `confirmation rejected: phrase “${phrase}” was not found in page text for beat ${beat}; look at the sheet again` };
  if (events.some((event) => event[1] === 'show')) {
    // One phrase must come from the show target itself: six characters of it, or all of a shorter one.
    const enough = (phrase) => { const p = normalize(phrase); return showText.includes(p) && (p.length >= 6 || p === showText); };
    if (!phrases.some(enough)) {
      const inTarget = phrases.find((phrase) => showText.includes(normalize(phrase)));
      return { ok: false, message: inTarget
        ? `confirmation rejected: “${inTarget}” is too little of the show target for beat ${beat}; quote at least six characters of what it shows`
        : `confirmation rejected: no quoted phrase was found in the show target's text for beat ${beat}; look at the sheet again` };
    }
  }
  return { ok: true, take, hash: hash(logBytes), phrases };
}

export function confirmBeat(root, beat, sees, { studio = null } = {}) {
  const result = confirmationStatus(root, beat, sees);
  if (!result.ok) throw new Error(result.message);
  const logFile = path.join(root, 'raw', result.take, 'log.json');
  const target = studio || root;
  const file = path.join(target, 'confirmations.json');
  const confirmations = json(file, {});
  confirmations[`${result.take}/${beat}`] = { sees, at: new Date().toISOString(), take: result.hash };
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(confirmations, null, 2)}\n`);
  return { file, logFile, message: `confirmed ${beat}: ${sees}` };
}

export function currentConfirmation(root, take, beat) {
  const target = root;
  const entry = json(path.join(target, 'confirmations.json'), {})[`${take}/${beat}`];
  const log = path.join(root, 'raw', take, 'log.json');
  return !!entry && fs.existsSync(log) && entry.take === hash(fs.readFileSync(log));
}

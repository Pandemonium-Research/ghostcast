// flags.yaml is the source of truth: the flags as the repository keeps them. A small reader and
// writer for its one shape, and the bucketing that decides who sees a flag.
import fs from 'node:fs';

const file = new URL('./flags.yaml', import.meta.url);
const historyFile = new URL('./history.json', import.meta.url);
const HEADER = '# Feature flags for the Roastery shop.\n# flagpole reads and writes this file; commit it like code.\n';

export function load() {
  const flags = [];
  let flag = null;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const name = /^([a-z0-9-]+):\s*$/.exec(line);
    const field = /^ {2}([a-z]+):\s*(.*)$/.exec(line);
    if (name) flags.push(flag = { name: name[1], description: '', rollout: 0 });
    else if (field && flag) flag[field[1]] = field[1] === 'rollout' ? Number.parseFloat(field[2]) || 0 : field[2];
  }
  return flags;
}

export function save(flags) {
  const blocks = flags.map((f) => `${f.name}:\n  description: ${f.description}\n  rollout: ${f.rollout}%\n`);
  fs.writeFileSync(file, `${HEADER}\n${blocks.join('\n')}`);
}

export const history = () => (fs.existsSync(historyFile) ? JSON.parse(fs.readFileSync(historyFile, 'utf8')) : []);
export function record(flag, rollout) {
  const events = history();
  events.push({ flag, rollout, at: Date.now() });
  fs.writeFileSync(historyFile, JSON.stringify(events));
}

// The same visitor always lands in the same bucket for a flag, so raising a rollout only adds
// people: whoever saw the new checkout at 20% still sees it at 50%.
export function bucket(flag, visitor) {
  let h = 0x811c9dc5;
  for (const ch of `${flag}:${visitor}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return h % 100;
}
export const enabled = (flag, visitor) => bucket(flag.name, visitor) < flag.rollout;

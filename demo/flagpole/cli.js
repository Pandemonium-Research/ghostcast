// flagpole [list] | rollout <flag> <percent> | off <flag>
import { load, record, save } from './flags.js';

const c = { dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', cyan: '\x1b[36m', reset: '\x1b[0m' };
const usage = 'usage: flagpole [list] | rollout <flag> <percent> | off <flag>';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bar = (pct, width = 30) => `${c.green}${'█'.repeat(Math.round(pct / 100 * width))}${c.dim}${'░'.repeat(width - Math.round(pct / 100 * width))}${c.reset}`;

const [command = 'list', name, value] = process.argv.slice(2);
const flags = load();
const flag = name && flags.find((f) => f.name === name);
if ((command === 'rollout' || command === 'off') && !flag) {
  console.error(name ? `no flag ${name} (flags: ${flags.map((f) => f.name).join(', ')})` : usage);
  process.exit(1);
}

if (command === 'rollout') {
  const target = Number.parseFloat(value);
  if (!(target >= 0 && target <= 100)) { console.error(usage); process.exit(1); }
  console.log(`${c.bold}flagpole${c.reset} ${c.dim}·${c.reset} rolling out ${c.cyan}${flag.name}${c.reset} to ${target}%\n`);
  // In steps, so a bad change shows up on the dashboard before everyone has it.
  const steps = 5, from = flag.rollout;
  for (let i = 1; i <= steps; i++) {
    flag.rollout = Math.round(from + (target - from) * i / steps);
    save(flags);
    record(flag.name, flag.rollout);
    process.stdout.write(`\r  ${bar(flag.rollout)}  ${String(flag.rollout).padStart(3)}%`);
    await sleep(450);
  }
  console.log(`\n\n${c.green}✓${c.reset} ${flag.name} is live for ${target}% of users`);
  console.log(`${c.dim}  flags.yaml updated · the dashboard shows it now${c.reset}`);
} else if (command === 'off') {
  flag.rollout = 0;
  save(flags);
  record(flag.name, 0);
  console.log(`${c.green}✓${c.reset} ${flag.name} is off`);
} else if (command === 'list') {
  for (const f of flags) console.log(`  ${f.name.padEnd(14)} ${bar(f.rollout, 20)} ${String(f.rollout).padStart(3)}%  ${c.dim}${f.description}${c.reset}`);
} else {
  console.error(usage);
  process.exit(1);
}

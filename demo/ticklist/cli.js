// ticklist [list] | add "<title>" | done <id>
import { add, load, save } from './store.js';

const usage = 'usage: ticklist [list] | add "<title>" | done <id>';
const [command = 'list', ...args] = process.argv.slice(2);
const tasks = load();

if (command === 'add') {
  const title = args.join(' ').trim();
  if (!title) { console.error(usage); process.exit(1); }
  const task = add(tasks, title);
  save(tasks);
  console.log(`+ Added: ${task.title}\n`);
} else if (command === 'done') {
  const task = tasks.find((t) => t.id === Number(args[0]));
  if (!task) { console.error(`no task ${args[0] ?? ''}`.trim()); process.exit(1); }
  task.done = true;
  save(tasks);
  console.log(`✓ Done: ${task.title}\n`);
} else if (command !== 'list') {
  console.error(usage);
  process.exit(1);
}

for (const task of tasks) console.log(`  ${task.done ? '✓' : '○'}  ${task.id}  ${task.title}`);
console.log(`\n${tasks.length} tasks, ${tasks.filter((t) => !t.done).length} open`);

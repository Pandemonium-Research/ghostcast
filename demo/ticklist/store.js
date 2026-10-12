// The task list both the web app and the CLI read and write.
import fs from 'node:fs';

const file = new URL('./tasks.json', import.meta.url);

export const load = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []);

// One task per line, so the file reads well in an editor and in a diff.
const line = (task) => `{ ${Object.entries(task).map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(', ')} }`;
export const save = (tasks) => fs.writeFileSync(file, `[\n${tasks.map((task) => `  ${line(task)}`).join(',\n')}\n]\n`);

export function add(tasks, title) {
  const task = { id: Math.max(0, ...tasks.map((t) => t.id)) + 1, title, done: false };
  tasks.push(task);
  return task;
}

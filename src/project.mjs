// A project's settings, for the recorder and for post-production alike. A classic project has its
// own project.json. A studio folder (.ghostcast/, marked by product.md) takes the template's
// defaults, an optional project.json over them, its world from world.yaml and its name from the
// storyboard.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml, validateWorld } from './studio/schema.mjs';

const DEFAULTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'project', 'project.json');

function merge(base, add) {
  for (const [key, value] of Object.entries(add)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) merge(base[key], value);
    else base[key] = value;
  }
  return base;
}

export function loadProject(dir) {
  const root = path.resolve(dir);
  const file = path.join(root, 'project.json');
  if (fs.existsSync(path.join(root, 'product.md')) && (path.basename(root) === '.ghostcast' || !fs.existsSync(file))) {
    const config = merge(JSON.parse(fs.readFileSync(DEFAULTS, 'utf8')), fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {});
    // A studio shoot always runs in a copy: of the repository around .ghostcast/ unless world.yaml
    // says otherwise. A broken world.yaml stops here rather than falling back to no copy at all.
    const worldFile = path.join(root, 'world.yaml');
    config.world = { source: '..', mode: 'snapshot' };
    if (fs.existsSync(worldFile)) {
      const source = fs.readFileSync(worldFile, 'utf8');
      const problems = validateWorld(source);
      if (problems.length) throw new Error(`world.yaml: ${problems.map((p) => `${p.path || '(file)'}${p.line ? ` (line ${p.line})` : ''}: ${p.message}`).join('; ')}`);
      config.world = parseYaml(source, 'world.yaml').data;
    }
    const storyboardFile = path.join(root, 'storyboard.yaml');
    const video = fs.existsSync(storyboardFile) ? parseYaml(fs.readFileSync(storyboardFile, 'utf8'), 'storyboard.yaml').data?.video : null;
    config.name = video || path.basename(path.dirname(root));
    return { root, config };
  }
  if (!fs.existsSync(file)) throw new Error(`no project.json in ${root} (run: ghostcast init <dir>)`);
  return { root, config: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

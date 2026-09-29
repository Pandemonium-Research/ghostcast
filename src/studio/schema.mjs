import YAML, { LineCounter } from 'yaml';
import { parseTarget } from './target.mjs';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.trim().length > 0;
// Commands and code legitimately hold "<" and ">" (redirection, HTML) and words like TODO, so for
// those only a value that is nothing but a placeholder counts.
const LITERAL = new Set(['run', 'cmd', 'code']);
const placeholderText = (value, key) => typeof value !== 'string' ? null : LITERAL.has(key)
  ? /^\s*(<[^<>]+>|TODO)\s*$/i.exec(value)?.[1] || null
  : /<[^<>]+>|\bTODO\b/i.exec(value)?.[0] || null;
export const placeholder = (value, key) => placeholderText(value, key) !== null;
export function hasPlaceholder(value, key, seen = new WeakSet()) {
  if (placeholder(value, key)) return true;
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  return Object.entries(value).some(([k, item]) => hasPlaceholder(item, Array.isArray(value) ? key : k, seen));
}
const seconds = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const list = (value) => Array.isArray(value);
const pathName = (parts) => parts.reduce((name, part) => typeof part === 'number' ? `${name}[${part}]` : name ? `${name}.${part}` : part, '');

export function parseYaml(source, file, lineOffset = 0) {
  if (typeof source !== 'string') return { data: null, doc: null, problems: [{ file, path: '', message: 'provide YAML text' }], line: () => undefined };
  const lineCounter = new LineCounter();
  let doc;
  try { doc = YAML.parseDocument(source, { lineCounter, uniqueKeys: true }); }
  catch (error) { return { data: null, doc: null, problems: [{ file, path: '', message: `invalid YAML: ${error.message}` }], line: () => undefined }; }
  const line = (parts = []) => {
    const node = parts.length ? doc.getIn(parts, true) : doc.contents;
    const pos = node?.range?.[0];
    return pos === undefined ? undefined : lineCounter.linePos(pos).line + lineOffset;
  };
  const problems = doc.errors.map((error) => ({ file, path: '', line: error.pos?.[0] === undefined ? undefined : lineCounter.linePos(error.pos[0]).line + lineOffset, message: `invalid YAML: ${error.message}` }));
  let data = null;
  try { data = doc.toJS(); } catch (error) { problems.push({ file, path: '', message: `invalid YAML: ${error.message}` }); }
  return { data, doc, problems, line };
}

function checker(file, parsed) {
  const problems = [...parsed.problems];
  const add = (parts, message) => problems.push({ file, path: pathName(parts), ...(parsed.line(parts) ? { line: parsed.line(parts) } : {}), message });
  const known = (value, allowed, parts = []) => {
    if (!object(value)) { add(parts, 'must be a map'); return false; }
    for (const key of Object.keys(value)) if (!allowed.includes(key)) add([...parts, key], `unknown key "${key}"; allowed: ${allowed.join(', ')}`);
    return true;
  };
  const required = (value, parts, description = 'non-empty text') => {
    if (!text(value)) add(parts, `required; use ${description}`);
  };
  const enumValue = (value, choices, parts, optional = false) => {
    if (optional && value === undefined) return;
    if (!choices.includes(value)) add(parts, `choose one of: ${choices.join(', ')}`);
  };
  const seen = new WeakSet();
  const scan = (value, parts = []) => {
    const offending = placeholderText(value, parts.findLast((part) => typeof part === 'string'));
    if (offending) add(parts, `replace the placeholder ${JSON.stringify(offending)} with real text`);
    else if (value && typeof value === 'object' && !seen.has(value)) {
      seen.add(value);
      if (list(value)) value.forEach((item, i) => scan(item, [...parts, i]));
      else if (object(value)) Object.entries(value).forEach(([key, item]) => scan(item, [...parts, key]));
    }
  };
  // A field still holding a placeholder gets one problem, the placeholder, not also "choose one of".
  const done = () => {
    const holes = problems.filter((p) => p.message.startsWith('replace the placeholder')).map((p) => p.path);
    const inside = (p, hole) => p === hole || p.startsWith(`${hole}.`) || p.startsWith(`${hole}[`);
    return problems.filter((p) => p.message.startsWith('replace the placeholder') || !holes.some((hole) => inside(p.path, hole)));
  };
  return { problems, add, known, required, enumValue, scan, done };
}

export function readBrief(source) {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!match) return { data: null, doc: null, line: () => undefined, problems: [{ file: 'brief.md', path: '', message: 'add YAML front matter between --- lines' }] };
  return parseYaml(match[1], 'brief.md', 1);
}

export function validateBrief(source) {
  const parsed = readBrief(source);
  const c = checker('brief.md', parsed);
  const data = parsed.data;
  if (!c.known(data, ['audience', 'goal', 'weight', 'type', 'cap', 'destinations', 'audio', 'panel_share'])) return c.done();
  for (const key of ['audience', 'goal']) c.required(data[key], [key]);
  c.enumValue(data.weight, ['quick', 'standard', 'production'], ['weight']);
  c.enumValue(data.type, ['launch', 'how-to', 'feature', 'receipt'], ['type']);
  if (!seconds(data.cap) || data.cap < 10 || data.cap > 600) c.add(['cap'], 'set a cap from 10 to 600 seconds');
  if (!list(data.destinations) || !data.destinations.length) c.add(['destinations'], 'list at least one destination');
  else data.destinations.forEach((item, i) => c.enumValue(item, ['readme', 'docs', 'social', 'talk', 'pr'], ['destinations', i]));
  c.enumValue(data.audio, ['kokoro', 'elevenlabs', 'clips', 'none'], ['audio']);
  if (data.panel_share !== undefined && (typeof data.panel_share !== 'number' || data.panel_share < 0 || data.panel_share > 1)) c.add(['panel_share'], 'set a number from 0 to 1');
  c.scan(data);
  return c.done();
}

export function validateProduct(source) {
  const file = 'product.md';
  const problems = [];
  if (typeof source !== 'string') return [{ file, path: '', message: 'provide Markdown text' }];
  const headings = ['What it is', 'How to run it', 'Seed data', 'Signing in', 'Flows worth showing', 'Off limits'];
  const lines = source.split(/\r?\n/);
  const sections = new Map();
  let heading = null;
  let documentFence = null;
  for (let i = 0; i < lines.length; i++) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i])?.[1];
    if (documentFence) {
      if (marker?.[0] === documentFence[0] && marker.length >= documentFence.length && /^[ \t]*(`+|~+)[ \t]*$/.test(lines[i])) documentFence = null;
      if (heading) sections.get(heading).body += lines[i] + '\n';
      continue;
    }
    if (marker) {
      documentFence = marker;
      if (heading) sections.get(heading).body += lines[i] + '\n';
      continue;
    }
    const match = /^##\s+(.+?)\s*$/.exec(lines[i]);
    if (match) { heading = match[1]; sections.set(heading, { line: i + 1, body: '' }); }
    else if (heading) sections.get(heading).body += lines[i] + '\n';
  }
  for (const name of headings) {
    const section = sections.get(name);
    const path = name;
    if (!section) { problems.push({ file, path, message: `add a ## ${name} heading` }); continue; }
    const body = section.body.replace(/<!--[\s\S]*?-->/g, '').trim();
    let fence = null;
    const prose = body.split(/\r?\n/).map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence) {
        if (marker?.[0] === fence[0] && marker.length >= fence.length && /^[ \t]*(`+|~+)[ \t]*$/.test(line)) fence = null;
        return '';
      }
      if (marker) { fence = marker; return ''; }
      return line;
    }).join('\n').replace(/(`+)[\s\S]*?\1/g, '');
    const offending = placeholderText(prose);
    if (!body) problems.push({ file, path, line: section.line, message: 'replace the guidance with real text; "none needed" is valid' });
    else if (offending) problems.push({ file, path, line: section.line, message: `replace the placeholder ${JSON.stringify(offending)} with real text` });
    if (name === 'Flows worth showing' && body && !/^\s*[-*+]\s+\S/m.test(body)) problems.push({ file, path, line: section.line, message: 'add at least one bullet for a flow worth showing' });
  }
  return problems;
}

const beatKeys = ['id', 'surface', 'claim', 'open', 'do', 'show', 'say', 'panel', 'camera', 'seconds', 'script'];
const verbs = ['click', 'fill', 'press', 'run', 'wait', 'code'];
const target = (value) => { try { parseTarget(value); return true; } catch { return false; } };

export function validateStoryboard(source, brief = {}) {
  brief ||= {};
  const parsed = parseYaml(source, 'storyboard.yaml');
  const c = checker('storyboard.yaml', parsed);
  const data = parsed.data;
  if (!c.known(data, ['video', 'weight', 'type', 'cap', 'beats'])) return c.done();
  if (!text(data.video) || !/^[a-z][a-z0-9_-]*$/.test(data.video)) c.add(['video'], 'use a video slug starting with a letter');
  c.enumValue(data.weight ?? brief.weight, ['quick', 'standard', 'production'], ['weight']);
  c.enumValue(data.type ?? brief.type, ['launch', 'how-to', 'feature', 'receipt'], ['type']);
  const cap = data.cap ?? brief.cap;
  if (!seconds(cap) || cap < 10 || cap > 600) c.add(['cap'], 'set a cap from 10 to 600 seconds');
  if (!list(data.beats) || !data.beats.length) { c.add(['beats'], 'add at least one beat'); return c.done(); }
  const ids = new Set();
  data.beats.forEach((beat, i) => {
    const root = ['beats', i];
    if (!c.known(beat, beatKeys, root)) return;
    if (!text(beat.id) || !/^[a-z][a-z0-9_-]*$/.test(beat.id)) c.add([...root, 'id'], 'use an id starting with a letter, then letters, numbers, _ or -');
    else if (ids.has(beat.id)) c.add([...root, 'id'], `duplicate beat id "${beat.id}"; use a unique id`);
    ids.add(beat.id);
    c.enumValue(beat.surface, ['web', 'terminal', 'editor', 'panel'], [...root, 'surface']);
    for (const key of ['claim', 'open', 'say', 'camera']) if (beat[key] !== undefined && !text(beat[key])) c.add([...root, key], 'use non-empty text');
    if (beat.seconds !== undefined && !seconds(beat.seconds)) c.add([...root, 'seconds'], 'set non-negative seconds');
    if (beat.show !== undefined && !target(beat.show)) c.add([...root, 'show'], 'use text "…", row "…", line "…", role <role> "…", label "…", or css <selector>');
    if (beat.script !== undefined) {
      if (!text(beat.script) || !/^scenes\/[a-zA-Z0-9_./-]+$/.test(beat.script) || beat.script.split('/').includes('..')) c.add([...root, 'script'], 'use a path under scenes/');
      if (beat.open !== undefined || beat.do !== undefined) c.add([...root, 'script'], 'a script beat cannot also have open or do');
    }
    if (beat.do !== undefined) {
      if (!list(beat.do)) c.add([...root, 'do'], 'use a list of actions');
      else beat.do.forEach((action, j) => {
        const where = [...root, 'do', j];
        if (!object(action) || Object.keys(action).length !== 1 || !verbs.includes(Object.keys(action)[0])) { c.add(where, `use exactly one action verb: ${verbs.join(', ')}`); return; }
        const [verb] = Object.keys(action), value = action[verb], at = [...where, verb];
        if (['click', 'press', 'code'].includes(verb) && !text(value)) c.add(at, 'use non-empty text');
        if (verb === 'fill' && (!object(value) || !Object.keys(value).length || Object.entries(value).some(([label, field]) => !text(label) || !text(field)))) c.add(at, 'use a map of labels to text values');
        if (verb === 'run' && !(text(value) || (object(value) && Object.keys(value).every((key) => ['cmd', 'expect'].includes(key)) && text(value.cmd) && (value.expect === undefined || seconds(value.expect))))) c.add(at, 'use a command string or { cmd, expect } with non-negative seconds');
        if (verb === 'wait' && !(text(value) || seconds(value))) c.add(at, 'use seconds or a target');
        else if (verb === 'wait' && typeof value === 'string' && !target(value)) c.add(at, 'use seconds or a target');
      });
    }
    if (beat.surface === 'panel') {
      if (!object(beat.panel)) c.add([...root, 'panel'], 'add a panel map');
    } else if (beat.panel !== undefined) c.add([...root, 'panel'], 'panel is only allowed on a panel beat');
    if (object(beat.panel)) {
      const panel = beat.panel, keys = panel.use !== undefined ? ['use', 'title', 'subtitle', 'foot'] : ['html', 'data'];
      c.known(panel, keys, [...root, 'panel']);
      if (panel.use !== undefined) { c.enumValue(panel.use, ['title', 'chapter', 'cta'], [...root, 'panel', 'use']); c.required(panel.title, [...root, 'panel', 'title']); }
      else {
        if (!text(panel.html) || !/^panels\/[a-zA-Z0-9_./-]+\.html$/.test(panel.html) || panel.html.split('/').includes('..')) c.add([...root, 'panel', 'html'], 'use an HTML path under panels/');
        if (panel.data !== undefined && !object(panel.data)) c.add([...root, 'panel', 'data'], 'use a data map');
      }
      for (const key of ['subtitle', 'foot']) if (panel[key] !== undefined && !text(panel[key])) c.add([...root, 'panel', key], 'use non-empty text');
    }
    c.scan(beat, root);
  });
  return c.done();
}

export function validateWorld(source) {
  const parsed = parseYaml(source, 'world.yaml');
  const c = checker('world.yaml', parsed), world = parsed.data;
  if (!c.known(world, ['source', 'mode', 'ref', 'copy', 'link', 'setup', 'services'])) return c.done();
  c.required(world.source, ['source'], 'a path to the source repository');
  c.enumValue(world.mode, ['snapshot', 'commit'], ['mode'], true);
  if (world.ref !== undefined && !text(world.ref)) c.add(['ref'], 'use a git ref');
  for (const key of ['copy', 'link', 'setup']) if (world[key] !== undefined) {
    if (!list(world[key]) || world[key].some((v) => !text(v))) c.add([key], 'use a list of non-empty strings');
  }
  if (world.services !== undefined) {
    if (!list(world.services)) c.add(['services'], 'use a list of services');
    else world.services.forEach((service, i) => {
      const at = ['services', i];
      if (!c.known(service, ['name', 'cmd', 'port', 'ready', 'env', 'cwd'], at)) return;
      c.required(service.name, [...at, 'name']);
      c.required(service.cmd, [...at, 'cmd']);
      if (service.port !== undefined && typeof service.port !== 'boolean') c.add([...at, 'port'], 'use true or false');
      if (service.cwd !== undefined && !text(service.cwd)) c.add([...at, 'cwd'], 'use a relative directory');
      if (service.env !== undefined && (!object(service.env) || Object.values(service.env).some((v) => !text(v)))) c.add([...at, 'env'], 'use a map of environment variable strings');
      if (service.ready !== undefined && c.known(service.ready, ['url', 'log', 'port', 'timeout'], [...at, 'ready'])) {
        if (service.ready.url !== undefined && !text(service.ready.url)) c.add([...at, 'ready', 'url'], 'use a URL');
        if (service.ready.log !== undefined && !text(service.ready.log)) c.add([...at, 'ready', 'log'], 'use a log pattern');
        if (service.ready.port !== undefined && typeof service.ready.port !== 'boolean' && !seconds(service.ready.port)) c.add([...at, 'ready', 'port'], 'use true, false or a port number');
        if (service.ready.timeout !== undefined && !seconds(service.ready.timeout)) c.add([...at, 'ready', 'timeout'], 'use non-negative milliseconds');
      }
    });
  }
  c.scan(world);
  return c.done();
}

export function validateAudio(source) {
  const parsed = parseYaml(source, 'audio.yaml');
  const c = checker('audio.yaml', parsed), audio = parsed.data;
  if (!c.known(audio, ['provider', 'voice', 'dir'])) return c.done();
  c.enumValue(audio.provider, ['kokoro', 'elevenlabs', 'clips', 'none'], ['provider']);
  if (['kokoro', 'elevenlabs'].includes(audio.provider)) c.required(audio.voice, ['voice'], 'a voice name');
  else if (audio.voice !== undefined && !text(audio.voice)) c.add(['voice'], 'use a voice name');
  if (audio.provider === 'clips') c.required(audio.dir, ['dir'], 'a clips directory');
  else if (audio.dir !== undefined && !text(audio.dir)) c.add(['dir'], 'use a clips directory');
  c.scan(audio);
  return c.done();
}

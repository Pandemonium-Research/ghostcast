import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';
import { loadProject } from '../src/recorder.mjs';
import { lint } from '../src/studio/lint.mjs';
import { validateAudio, validateBrief, validateProduct, validateStoryboard, validateWorld } from '../src/studio/schema.mjs';
import { compile } from '../src/studio/compile.mjs';
import { parseTarget } from '../src/studio/target.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'ghostcast.mjs');
const studioTemplate = (name) => fs.readFileSync(path.join(ROOT, 'templates', 'studio', name), 'utf8');
const sampleProduct = `## What it is\nA demo app.\n\n## How to run it\nRun npm start.\n\n## Seed data\nnone needed\n\n## Signing in\nnone needed\n\n## Flows worth showing\n- Open the app and see a result.\n\n## Off limits\nPrivate accounts.\n`;
const sampleBrief = `---\naudience: Developers\ngoal: Show a successful result\nweight: standard\ntype: how-to\ncap: 120\ndestinations: [docs]\naudio: kokoro\npanel_share: 0.2\n---\n\n# Notes\n`;
const sampleStory = {
  video: 'demo', weight: 'quick', type: 'how-to', cap: 120,
  beats: [{ id: 'result', surface: 'web', open: '/demo', show: 'text "Ready"', claim: 'The page works.', say: 'The result is ready.' }],
};

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostcast-studio-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

function cli(cwd, ...args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: ROOT },
  });
}

function init(t) {
  const dir = fixture(t);
  const result = cli(dir, 'init');
  assert.equal(result.status, 0, result.stderr);
  const studio = path.join(dir, '.ghostcast');
  fs.writeFileSync(path.join(studio, 'brief.md'), sampleBrief);
  fs.writeFileSync(path.join(studio, 'product.md'), sampleProduct);
  return { dir, studio };
}

function writeStory(studio, story) {
  fs.writeFileSync(path.join(studio, 'storyboard.yaml'), YAML.stringify(story));
}

function rules(studio, level = 'errors') {
  return lint(studio)[level].map((problem) => problem.rule);
}

test('init adds the studio, keeps files, fills gaps, and warns outside git', (t) => {
  const dir = fixture(t);
  const first = cli(dir, 'init');
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout + first.stderr, /not a git repository/);
  const studio = path.join(dir, '.ghostcast');
  for (const name of ['brief.md', 'product.md', 'world.yaml', 'audio.yaml', '.gitignore']) assert.ok(fs.existsSync(path.join(studio, name)), name);
  for (const name of ['panels', 'scenes']) assert.deepEqual(fs.readdirSync(path.join(studio, name)), []);
  assert.match(fs.readFileSync(path.join(studio, 'world.yaml'), 'utf8'), /source: \.\./);
  fs.writeFileSync(path.join(studio, 'brief.md'), 'my custom brief\n');
  fs.rmSync(path.join(studio, 'audio.yaml'));
  const second = cli(dir, 'init');
  assert.equal(second.status, 0, second.stderr);
  assert.equal(fs.readFileSync(path.join(studio, 'brief.md'), 'utf8'), 'my custom brief\n');
  assert.ok(fs.existsSync(path.join(studio, 'audio.yaml')));
  assert.match(second.stdout, /kept \.ghostcast[\\/]brief\.md/);
  assert.match(second.stdout, /created \.ghostcast[\\/]audio\.yaml/);
  const sample = path.join(dir, 'sample');
  assert.equal(cli(dir, 'init', sample).status, 0);
  assert.ok(fs.existsSync(path.join(sample, 'project.json')));
});

test('project resolution uses the studio folder, classic project, and explicit --project', (t) => {
  const { dir, studio } = init(t);
  writeStory(studio, sampleStory);
  const current = cli(dir, 'lint', '--json');
  assert.equal(current.status, 0, current.stderr);
  assert.equal(JSON.parse(current.stdout).estimate.beats[0].id, 'result');
  const other = path.join(dir, 'other');
  fs.mkdirSync(other);
  assert.equal(cli(other, 'init').status, 0);
  const otherStudio = path.join(other, '.ghostcast');
  fs.writeFileSync(path.join(otherStudio, 'brief.md'), sampleBrief);
  fs.writeFileSync(path.join(otherStudio, 'product.md'), sampleProduct);
  writeStory(otherStudio, { ...sampleStory, beats: [{ ...sampleStory.beats[0], id: 'other' }] });
  const explicit = cli(dir, 'lint', '--json', '--project', other);
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(JSON.parse(explicit.stdout).estimate.beats[0].id, 'other');

  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ name: 'classic', voiceover: { wordsPerSecond: 2.5 } }));
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify({ items: [], narration: [] }));
  // vo-script reads projectDir itself and requires project.json, revealing which root the CLI chose.
  const classic = cli(dir, 'vo-script');
  assert.equal(classic.status, 1, classic.stderr);
  assert.match(classic.stderr, /timeline\.json has no "narration" blocks/);
  assert.equal(loadProject(dir).config.name, 'classic');
});

test('loadProject deep-merges studio defaults, loads world, and takes the storyboard name', (t) => {
  const { dir, studio } = init(t);
  writeStory(studio, sampleStory);
  fs.writeFileSync(path.join(studio, 'project.json'), JSON.stringify({ viewport: { width: 800 }, voiceover: { lufs: -14 } }));
  const project = loadProject(studio);
  assert.equal(project.root, studio);
  assert.equal(project.config.viewport.width, 800);
  assert.equal(project.config.viewport.height, 810);
  assert.equal(project.config.voiceover.wordsPerSecond, 2.5);
  assert.equal(project.config.voiceover.lufs, -14);
  assert.deepEqual(project.config.world, { source: '..', mode: 'snapshot' });
  assert.equal(project.config.name, 'demo');
  fs.rmSync(path.join(studio, 'storyboard.yaml'));
  assert.equal(loadProject(studio).config.name, path.basename(dir));
});

test('brief and product schemas report valid, missing, enum, unknown, and placeholder paths', () => {
  assert.deepEqual(validateBrief(sampleBrief), []);
  assert.deepEqual(validateProduct(sampleProduct), []);
  for (const [source, pathName] of [
    [sampleBrief.replace('weight: standard', 'weight: epic'), 'weight'],
    [sampleBrief.replace('goal: Show a successful result\n', ''), 'goal'],
    [sampleBrief.replace('audience: Developers', 'audience: <People>'), 'audience'],
    [sampleBrief.replace('audio: kokoro', 'audio: kokoro\nextra: value'), 'extra'],
  ]) assert.ok(validateBrief(source).some((p) => p.path === pathName), pathName);
  assert.ok(validateProduct(sampleProduct.replace('## Off limits', '## Other')).some((p) => p.path === 'Off limits'));
  assert.ok(validateProduct(studioTemplate('product.md')).some((p) => p.path === 'What it is'));
  assert.ok(validateProduct(sampleProduct.replace('- Open the app and see a result.', 'Open the app.')).some((p) => p.path === 'Flows worth showing'));
});

test('storyboard schema validates structure, actions, panels, scripts and placeholders with paths', () => {
  assert.deepEqual(validateStoryboard(YAML.stringify(sampleStory), { cap: 120 }), []);
  const check = (change, expected) => {
    const value = structuredClone(sampleStory);
    change(value);
    assert.ok(validateStoryboard(YAML.stringify(value), { cap: 120 }).some((p) => p.path === expected), expected);
  };
  check((s) => { s.other = true; }, 'other');
  check((s) => { s.beats[0].shows = 'text "Ready"'; }, 'beats[0].shows');
  check((s) => { s.beats[0].surface = 'desktop'; }, 'beats[0].surface');
  check((s) => { delete s.beats[0].id; }, 'beats[0].id');
  check((s) => { s.beats[0].say = '<Narration>'; }, 'beats[0].say');
  check((s) => { s.beats[0].do = [{ click: 'Start', press: 'Enter' }]; }, 'beats[0].do[0]');
  check((s) => { s.beats[0].do = [{ run: { cmd: 'npm test', expect: 'soon' } }]; }, 'beats[0].do[0].run');
  check((s) => { s.beats[0].panel = { use: 'title', title: 'Title' }; }, 'beats[0].panel');
  check((s) => { s.beats[0].script = 'scenes/demo.mjs'; }, 'beats[0].script');
  check((s) => { s.beats[0].surface = 'panel'; delete s.beats[0].show; }, 'beats[0].panel');
  check((s) => { s.beats.push({ ...s.beats[0] }); }, 'beats[1].id');
  assert.ok(validateStoryboard(YAML.stringify({ ...sampleStory, cap: undefined }), { cap: 120 }).every((p) => p.path !== 'cap'));
});

test('world and audio schemas cover known keys, types, required fields and placeholders', () => {
  assert.deepEqual(validateWorld('source: ..\nmode: snapshot\nservices:\n  - name: web\n    cmd: npm run dev\n    port: true\n    ready: { port: true, timeout: 30000 }\n'), []);
  assert.deepEqual(validateAudio('provider: kokoro\nvoice: af_heart\n'), []);
  for (const [source, expected] of [
    ['source: ..\nmode: other\n', 'mode'],
    ['mode: snapshot\n', 'source'],
    ['source: <repository>\n', 'source'],
    ['source: ..\nunknown: true\n', 'unknown'],
    ['source: ..\nservices: [{ name: web, cmd: dev, unknown: true }]\n', 'services[0].unknown'],
  ]) assert.ok(validateWorld(source).some((p) => p.path === expected), expected);
  for (const [source, expected] of [
    ['provider: unknown\n', 'provider'],
    ['voice: af_heart\n', 'provider'],
    ['provider: clips\n', 'dir'],
    ['provider: kokoro\nvoice: <voice>\n', 'voice'],
    ['provider: kokoro\n', 'voice'],
    ['provider: kokoro\nkey: secret\n', 'key'],
  ]) assert.ok(validateAudio(source).some((p) => p.path === expected), expected);
  for (const validator of [validateBrief, validateProduct, validateStoryboard, validateWorld, validateAudio]) assert.doesNotThrow(() => validator(null));
});

test('each CLI storyboard template has only placeholder errors and can be filled to lint cleanly', (t) => {
  for (const type of ['launch', 'how-to', 'feature', 'receipt']) {
    const { dir, studio } = init(t);
    const generated = cli(dir, 'template', type);
    assert.equal(generated.status, 0, `${type}: ${generated.stderr}`);
    const raw = fs.readFileSync(path.join(studio, 'storyboard.yaml'), 'utf8');
    assert.match(raw.split('\n')[0], /^# Frame:/);
    const story = YAML.parse(raw);
    assert.equal(story.video, path.basename(dir).toLowerCase());
    assert.equal(story.cap, 120);
    assert.equal(story.type, type);
    const placeholderReport = lint(studio);
    assert.ok(placeholderReport.errors.length > 0, type);
    assert.ok(placeholderReport.errors.every((p) => p.rule === 'schema' && /placeholder/.test(p.message)), `${type}: ${JSON.stringify(placeholderReport.errors)}`);
    assert.deepEqual(placeholderReport.warnings, [], type);
    const refused = cli(dir, 'template', type);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /--force/);
    assert.equal(cli(dir, 'template', type, '--force').status, 0);
    for (const beat of story.beats) {
      beat.claim = 'This action proves the result.';
      beat.say = beat.surface === 'panel' ? 'See the result now.'
        : 'The product completes the action and shows the expected result clearly for every viewer following the demonstration today.';
      if (beat.open) beat.open = '/demo';
      if (beat.show) beat.show = beat.surface === 'terminal' ? 'row "Ready"' : 'text "Ready"';
      if (beat.panel) beat.panel.title = 'A clear result';
      if (beat.do) beat.do = beat.do.map((action) => action.run ? { run: 'echo ready' } : { click: 'Open' });
    }
    writeStory(studio, story);
    const clean = lint(studio);
    assert.deepEqual(clean.errors, [], `${type}: ${JSON.stringify(clean.errors)}`);
    assert.deepEqual(clean.warnings, [], `${type}: ${JSON.stringify(clean.warnings)}`);
  }
});

test('lint catches every rule and emits the documented JSON shape', (t) => {
  const { dir, studio } = init(t);
  const check = (change, rule, level = 'errors') => {
    const story = structuredClone(sampleStory);
    change(story);
    writeStory(studio, story);
    assert.ok(rules(studio, level).includes(rule), `${rule}: ${JSON.stringify(lint(studio)[level])}`);
  };
  check((s) => { s.beats[0].claim = 'One result works. Another result works.'; }, 'one-claim');
  check((s) => { s.beats[0].say = 'First. Second. Third.'; }, 'one-claim');
  check((s) => { delete s.beats[0].claim; s.beats[0].say = 'First. Second.'; }, 'one-claim', 'warnings');
  check((s) => { s.beats[0].say = Array(40).fill('word').join(' '); }, 'word-budget');
  check((s) => { s.beats[0].do = [{ wait: 12 }]; }, 'pacing', 'warnings');
  check((s) => { s.weight = 'standard'; delete s.beats[0].say; }, 'silent', 'warnings');
  check((s) => { delete s.beats[0].show; s.beats[0].do = [{ click: 'Go' }]; }, 'wait-after-action', 'warnings');
  check((s) => { s.beats[0].show = 'row "Ready"'; }, 'show-surface');
  check((s) => { s.beats[0].show = 'line "Ready"'; }, 'show-surface');
  for (const target of ['text "Ready"', 'role button "Ready"', 'label "Ready"', 'css .ready'])
    check((s) => { s.beats[0].surface = 'terminal'; s.beats[0].show = target; }, 'show-surface');
  check((s) => { s.beats.push({ id: 'card', surface: 'panel', panel: { use: 'title', title: 'Hello' }, say: 'Hello.' }); }, 'panel-share');
  check((s) => { s.cap = 10; s.beats.push({ id: 'script', surface: 'web', script: 'scenes/custom.mjs', seconds: 30 }); }, 'cap');
  writeStory(studio, sampleStory);
  fs.writeFileSync(path.join(studio, 'secret.txt'), 'token: ghp_12345678901234567890\n');
  assert.ok(rules(studio).includes('secrets'));
  for (const value of ['sk-12345678901234567890', 'AKIA1234567890123456', 'xoxb-12345678901234567890', '9f86d081884c7d659a2feaa0c55ad015']) {
    fs.writeFileSync(path.join(studio, 'secret.txt'), `token: ${value}\n`);
    assert.ok(rules(studio).includes('secrets'), value);
  }
  fs.rmSync(path.join(studio, 'secret.txt'));
  const output = cli(dir, 'lint', '--json');
  assert.equal(output.status, 0, output.stderr);
  const json = JSON.parse(output.stdout);
  assert.deepEqual(Object.keys(json), ['errors', 'warnings', 'estimate']);
  assert.deepEqual(Object.keys(json.estimate), ['total', 'cap', 'beats']);
  assert.deepEqual(Object.keys(json.estimate.beats[0]), ['id', 'seconds', 'narration', 'actions']);
  assert.equal(json.errors.length, 0);
  assert.equal(json.warnings.length, 0);
  const long = structuredClone(sampleStory);
  long.beats[0].say = Array(40).fill('word').join(' ');
  writeStory(studio, long);
  const bad = cli(dir, 'lint', '--json');
  assert.equal(bad.status, 1);
  assert.ok(JSON.parse(bad.stdout).errors.some((p) => p.rule === 'word-budget' && p.line > 0));
});

test('sentence counting preserves decimals, versions, file names and abbreviations; word budget uses project speed', (t) => {
  const { studio } = init(t);
  const story = structuredClone(sampleStory);
  story.beats[0].claim = 'Version v1.2 loads index.js, e.g. in the demo.';
  story.beats[0].say = 'Version v1.2 loads index.js, i.e. the app is ready.';
  writeStory(studio, story);
  assert.ok(!rules(studio).includes('one-claim'));
  fs.writeFileSync(path.join(studio, 'project.json'), JSON.stringify({ voiceover: { wordsPerSecond: 1 } }));
  story.beats[0].say = Array(20).fill('word').join(' ');
  writeStory(studio, story);
  assert.ok(rules(studio).includes('word-budget'));
  const scripted = { ...story, beats: [{ id: 'custom', surface: 'web', script: 'scenes/custom.mjs', seconds: 18, say: 'Ready.' }] };
  writeStory(studio, scripted);
  assert.equal(lint(studio).estimate.beats[0].seconds, 18);
  assert.ok(!rules(studio, 'warnings').includes('pacing'));
});

test('commands and code may hold angle brackets and TODO; a CSS target may hold spaces', () => {
  const story = {
    video: 'demo', weight: 'standard', type: 'how-to', cap: 60,
    beats: [{
      id: 'sort', surface: 'terminal', say: 'Sort the names.',
      do: [{ run: 'sort < names.txt > sorted.txt' }, { run: { cmd: 'grep -rn TODO src', expect: 1 } }, { code: "await page.setContent('<p>hi</p>')" }],
      show: 'row "sorted"',
    }, { id: 'card', surface: 'web', say: 'The card shows it.', show: 'css .card h2' }],
  };
  assert.deepEqual(validateStoryboard(YAML.stringify(story)), []);
  story.beats[0].do = [{ run: '<Check prerequisite>' }];
  assert.deepEqual(validateStoryboard(YAML.stringify(story)).map((p) => p.path), ['beats[0].do[0].run']);
});

test('the secrets scan reads the plan files and text under panels/ and scenes/ only', (t) => {
  const { studio } = init(t);
  writeStory(studio, { ...sampleStory, beats: [{ ...sampleStory.beats[0], say: 'Open scripts/generateInvoices/fixtures/northwind to see it.' }] });
  const token = 'sk-' + 'Abc123'.repeat(4);
  for (const dir of ['raw/take/frames', 'out', '.ghostcast/chrome-profile']) {
    fs.mkdirSync(path.join(studio, dir), { recursive: true });
    fs.writeFileSync(path.join(studio, dir, 'data.json'), JSON.stringify({ token }));
  }
  assert.ok(!rules(studio).includes('secrets'), 'footage, renders and the browser profile are not scanned; a long path is not a key');
  fs.writeFileSync(path.join(studio, 'scenes', 'custom.mjs'), `const key = '${token}';\n`);
  fs.appendFileSync(path.join(studio, 'world.yaml'), `# ${'9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'}\n`);
  const found = lint(studio).errors.filter((p) => p.rule === 'secrets').map((p) => p.file).sort();
  assert.deepEqual(found, ['scenes/custom.mjs', 'world.yaml']);
});

test('a studio folder always gets a world: the parent repository by default, never none', (t) => {
  const { studio } = init(t);
  fs.rmSync(path.join(studio, 'world.yaml'));
  assert.deepEqual(loadProject(studio).config.world, { source: '..', mode: 'snapshot' });
  fs.writeFileSync(path.join(studio, 'world.yaml'), 'source: ..\nmode: sideways\n');
  assert.throws(() => loadProject(studio), /world\.yaml: mode.*choose one of: snapshot, commit/);
});

test('compile writes an importable scene and a one-take timeline', async (t) => {
  const { dir, studio } = init(t);
  const story = { ...sampleStory, beats: [
    { id: 'intro', surface: 'panel', panel: { use: 'title', title: 'Hello' }, say: 'Hello.' },
    { id: 'result', surface: 'web', open: 'page.html', do: [{ code: 'await page.title();' }], show: 'text "Ready"', say: 'Ready.' },
  ] };
  writeStory(studio, story);
  const result = cli(dir, 'compile');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(studio, 'timeline.json'), 'utf8')),
    { items: [{ take: 'storyboard', scene: 'cache/storyboard.mjs' }] });
  const generated = fs.readFileSync(path.join(studio, 'cache', 'storyboard.mjs'), 'utf8');
  assert.match(generated, /Generated by `ghostcast compile`/);
  assert.match(generated, /const code =/);
  const scene = await import(pathToFileURL(path.join(studio, 'cache', 'storyboard.mjs')).href);
  assert.deepEqual(scene.beats.map((beat) => beat.id), ['intro', 'result']);
  assert.equal(typeof scene.setup, 'function');
  assert.equal(typeof scene.default, 'function');
});

test('compile errors name invalid code actions and web beats without a service', (t) => {
  const { studio } = init(t);
  const story = { ...sampleStory, beats: [{ ...sampleStory.beats[0], open: 'page.html', do: [{ code: 'await (' }] }] };
  writeStory(studio, story);
  assert.throws(() => compile(loadProject(studio)), /result: code action 0/);
  story.beats[0].do = [];
  story.beats[0].open = '/demo';
  writeStory(studio, story);
  assert.throws(() => compile(loadProject(studio)), /result: open \/demo/);
});

test('target parser accepts every form and rejects junk', () => {
  for (const [source, kind, value] of [
    ['text "Done"', 'text', 'Done'], ['row "ready"', 'row', 'ready'],
    ['line "const answer"', 'line', 'const answer'], ['role button "Save"', 'role', 'Save'],
    ['label "Customer"', 'label', 'Customer'], ['css .card h2', 'css', '.card h2'],
  ]) {
    const parsed = parseTarget(source);
    assert.equal(parsed.kind, kind);
    assert.equal(parsed.value, value);
  }
  for (const source of ['', 'Done', 'text Done', 'row ""', 'role "Save"', 'css  ', 'css'])
    assert.throws(() => parseTarget(source));
  const story = { ...sampleStory, beats: [{ ...sampleStory.beats[0], open: 'page.html', show: 'text Done' }] };
  assert.ok(validateStoryboard(YAML.stringify(story)).some((p) => p.path === 'beats[0].show'));
  story.beats[0].show = 'text "Done"';
  story.beats[0].do = [{ wait: 'text Done' }];
  assert.ok(validateStoryboard(YAML.stringify(story)).some((p) => p.path === 'beats[0].do[0].wait'));
});

test('a web beat after another surface, or first, needs open; compile refuses it', (t) => {
  const { studio } = init(t);
  const story = {
    video: 'demo', weight: 'standard', type: 'how-to', cap: 60,
    beats: [
      { id: 'intro', surface: 'panel', panel: { use: 'title', title: 'Demo' }, say: 'A demo.' },
      { id: 'page', surface: 'web', show: 'text "Ready"', say: 'The page is ready.' },
      { id: 'more', surface: 'web', show: 'text "More"', say: 'And more.' },
    ],
  };
  writeStory(studio, story);
  const errors = lint(studio).errors.filter((p) => p.rule === 'surface-change');
  assert.deepEqual(errors.map((p) => p.id), ['page']);
  assert.match(errors[0].message, /beat before is panel: add open:/);
  const r = cli(path.dirname(studio), 'compile');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /surface-change/);
  story.beats[1].open = 'index.html';
  writeStory(studio, story);
  assert.equal(cli(path.dirname(studio), 'compile').status, 0);
});

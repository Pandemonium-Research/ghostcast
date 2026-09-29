import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareWorld, fingerprint, assertOutsideSource } from '../src/world.mjs';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/ghostcast.mjs');

function git(dir, ...args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
function fixture(t, worldOptions = {}, { nested = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostcast-world-test-'));
  const priorCache = process.env.GHOSTCAST_CACHE;
  process.env.GHOSTCAST_CACHE = path.join(tmp, 'cache');
  t.after(() => {
    if (priorCache === undefined) delete process.env.GHOSTCAST_CACHE;
    else process.env.GHOSTCAST_CACHE = priorCache;
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const source = path.join(tmp, 'source');
  const root = nested ? path.join(source, '.ghostcast') : path.join(tmp, 'film');
  fs.mkdirSync(source);
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(source, '.gitignore'), '.env\nnode_modules/\n');
  fs.writeFileSync(path.join(source, 'app.txt'), 'committed\n');
  fs.writeFileSync(path.join(source, 'service.mjs'), "import http from 'node:http'; http.createServer((req, res) => res.end(String(process.env.PORT))).listen(Number(process.env.PORT), '127.0.0.1');\n");
  git(source, 'init');
  git(source, 'config', 'user.email', 'test@example.invalid');
  git(source, 'config', 'user.name', 'World Test');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'seed');
  fs.writeFileSync(path.join(source, 'app.txt'), 'uncommitted\n');
  fs.writeFileSync(path.join(source, 'extra.txt'), 'untracked\n');
  fs.writeFileSync(path.join(source, '.env'), 'SECRET=test\n');
  fs.mkdirSync(path.join(source, 'node_modules'));
  fs.writeFileSync(path.join(source, 'node_modules', 'marker'), 'untouched dependency\n');
  const config = {
    viewport: { width: 320, height: 240, dpr: 1 },
    world: {
      source,
      copy: ['.env'],
      link: ['node_modules'],
      services: [],
      ...worldOptions,
    },
  };
  fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify(config));
  return { source, root, config, cache: process.env.GHOSTCAST_CACHE, project: { root, config } };
}

function recordScene(f, body) {
  fs.mkdirSync(path.join(f.root, 'scenes'), { recursive: true });
  fs.writeFileSync(path.join(f.root, 'scenes', 'take.mjs'), body);
  const r = spawnSync(process.execPath, [CLI, 'record', 'take', '--project', f.root], {
    encoding: 'utf8', timeout: 60000, env: { ...process.env, GHOSTCAST_CACHE: f.cache },
  });
  assert.equal(r.error, undefined, r.error?.message);
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

test('snapshot copies edits and untracked files; reset and git commands stay in the copy', async (t) => {
  const f = fixture(t);
  const before = fingerprint(f.source);
  const index = fs.readFileSync(path.join(f.source, '.git', 'index'));
  const world = await prepareWorld(f.project);
  try {
    assert.equal(fs.readFileSync(path.join(world.dir, 'app.txt'), 'utf8'), 'uncommitted\n');
    assert.equal(fs.readFileSync(path.join(world.dir, 'extra.txt'), 'utf8'), 'untracked\n');
    assert.equal(fs.readFileSync(path.join(world.dir, '.env'), 'utf8'), 'SECRET=test\n');
    assert.ok(fs.lstatSync(path.join(world.dir, 'node_modules')).isSymbolicLink());
    git(world.dir, 'reset', '--hard');
    git(world.dir, 'clean', '-fdx');
    fs.writeFileSync(path.join(world.dir, 'app.txt'), 'scene edit\n');
    world.reset();
    assert.equal(fs.readFileSync(path.join(world.dir, 'app.txt'), 'utf8'), 'uncommitted\n');
    assert.equal(fs.readFileSync(path.join(f.source, 'node_modules', 'marker'), 'utf8'), 'untouched dependency\n');
    assert.throws(() => assertOutsideSource(path.join(f.source, 'app.txt'), f.source), /refuses/);
  } finally {
    assert.equal(await world.dispose(), true);
  }
  assert.deepEqual(fingerprint(f.source), before);
  assert.deepEqual(fs.readFileSync(path.join(f.source, '.git', 'index')), index);
  assert.equal(fs.readFileSync(path.join(f.source, '.env'), 'utf8'), 'SECRET=test\n');
  assert.equal(fs.readFileSync(path.join(f.source, 'node_modules', 'marker'), 'utf8'), 'untouched dependency\n');
  assert.equal(fs.existsSync(world.dir), false);
});

test('a concurrent source edit survives and is reported without failing', async (t) => {
  const f = fixture(t);
  const world = await prepareWorld(f.project);
  const lines = [];
  fs.writeFileSync(path.join(f.source, 'app.txt'), 'user edit during shoot\n');
  const original = console.log;
  console.log = (s) => lines.push(s);
  try { assert.equal(await world.dispose(), true); } finally { console.log = original; }
  assert.match(lines.join('\n'), /changed during the shoot: app\.txt/);
  assert.equal(fs.readFileSync(path.join(f.source, 'app.txt'), 'utf8'), 'user edit during shoot\n');
});

test('commit mode uses the chosen revision; a non-git source is copied', async (t) => {
  const f = fixture(t, { mode: 'commit', ref: 'HEAD', link: [], copy: [] });
  const commitWorld = await prepareWorld(f.project);
  try {
    assert.equal(fs.readFileSync(path.join(commitWorld.dir, 'app.txt'), 'utf8').trim(), 'committed');
    assert.equal(fs.existsSync(path.join(commitWorld.dir, 'extra.txt')), false);
    git(commitWorld.dir, 'log', '-1', '--oneline');
  } finally { assert.equal(await commitWorld.dispose(), true); }
  const plain = path.join(path.dirname(f.source), 'plain');
  fs.mkdirSync(plain);
  fs.writeFileSync(path.join(plain, 'data.txt'), 'plain tree\n');
  f.config.world = { source: plain };
  const plainWorld = await prepareWorld(f.project);
  try {
    assert.equal(fs.readFileSync(path.join(plainWorld.dir, 'data.txt'), 'utf8'), 'plain tree\n');
    fs.writeFileSync(path.join(plainWorld.dir, 'data.txt'), 'scene change\n');
    plainWorld.reset();
    assert.equal(fs.readFileSync(path.join(plainWorld.dir, 'data.txt'), 'utf8'), 'plain tree\n');
  } finally { assert.equal(await plainWorld.dispose(), true); }
});

test('matching source and copy content is a leaked write and fails', async (t) => {
  const f = fixture(t);
  const world = await prepareWorld(f.project);
  fs.writeFileSync(path.join(world.dir, 'app.txt'), 'leaked\n');
  fs.writeFileSync(path.join(f.source, 'app.txt'), 'leaked\n');
  assert.equal(await world.dispose(), false);
  assert.equal(fs.readFileSync(path.join(f.source, 'app.txt'), 'utf8'), 'leaked\n');
});

test('source ref changes fail the untouched check', async (t) => {
  const f = fixture(t);
  const world = await prepareWorld(f.project);
  git(f.source, 'branch', 'new-branch');
  assert.equal(await world.dispose(), false);
});

test('services get distinct ports and copies; stop and remove after shooting', async (t) => {
  const f = fixture(t);
  f.config.world.services = [{ name: 'web', cmd: `"${process.execPath}" service.mjs`, port: true, ready: { port: true, timeout: 15000 } }];
  const [a, b] = await Promise.all([prepareWorld(f.project), prepareWorld(f.project)]);
  const ports = [a.port('web'), b.port('web')];
  try {
    assert.notEqual(a.dir, b.dir);
    assert.notEqual(...ports);
    assert.equal(await (await fetch(a.url('web'))).text(), String(ports[0]));
    assert.equal(await (await fetch(b.url('web'))).text(), String(ports[1]));
    assert.ok(fs.readdirSync(path.join(f.root, 'logs')).some((name) => name.endsWith('-web.log')));
  } finally {
    assert.equal(await a.dispose(), true);
    assert.equal(await b.dispose(), true);
  }
  assert.equal(fs.existsSync(a.dir), false);
  assert.equal(fs.existsSync(b.dir), false);
  for (const port of ports) await assert.rejects(fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) }));
});

test('keep-world retains the copy and baseline', async (t) => {
  const f = fixture(t);
  const world = await prepareWorld(f.project, { keep: true });
  assert.equal(await world.dispose(), true);
  assert.ok(fs.existsSync(world.dir));
  assert.ok(fs.existsSync(`${world.dir}.snapshot`));
  t.after(() => { fs.rmSync(world.dir, { recursive: true, force: true }); fs.rmSync(`${world.dir}.snapshot`, { recursive: true, force: true }); fs.rmSync(`${world.dir}.json`, { force: true }); });
});

test('record fails when a scene writes through world.link', (t) => {
  const f = fixture(t);
  const r = recordScene(f, "import fs from 'node:fs'; import path from 'node:path'; export default async function (h) { fs.writeFileSync(path.join(h.world.dir, 'node_modules', 'leak.txt'), 'leaked'); }\n");
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /wrote through world\.link node_modules: .*leak\.txt/);
  assert.doesNotMatch(r.out, /source untouched during the shoot/);
  assert.equal(fs.readFileSync(path.join(f.source, 'node_modules', 'leak.txt'), 'utf8'), 'leaked');
});

test('record can reset and clean the copy without touching linked dependencies', (t) => {
  const f = fixture(t);
  const r = recordScene(f, `import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
export default async function (h) {
  for (const args of [['reset', '--hard'], ['clean', '-fdx']]) {
    const result = spawnSync('git', args, { cwd: h.world.dir, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
  }
  fs.writeFileSync(path.join(h.world.dir, 'app.txt'), 'edited in copy\\n');
}
`);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /source untouched during the shoot/);
  assert.equal(fs.readFileSync(path.join(f.source, 'node_modules', 'marker'), 'utf8'), 'untouched dependency\n');
  assert.equal(fs.readFileSync(path.join(f.source, 'app.txt'), 'utf8'), 'uncommitted\n');
});

test('record excludes a ghostcast project nested in the source', (t) => {
  const f = fixture(t, {}, { nested: true });
  git(f.source, 'add', '.ghostcast/project.json');
  git(f.source, 'commit', '-m', 'track project config');
  const r = recordScene(f, "import fs from 'node:fs'; import path from 'node:path'; export default async function (h) { if (fs.existsSync(path.join(h.world.dir, '.ghostcast'))) throw new Error('project copied into world'); fs.writeFileSync(path.join(h.project.root, 'shoot-log.txt'), 'project output'); }\n");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /source untouched during the shoot/);
  assert.doesNotMatch(r.out, /changed during the shoot:.*\.ghostcast/);
  assert.equal(fs.existsSync(path.join(f.root, 'shoot-log.txt')), true);
});

test('a port lock from an exited process is reused', async (t) => {
  const f = fixture(t);
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const dead = spawnSync(process.execPath, ['-p', 'process.pid'], { encoding: 'utf8' });
  assert.equal(dead.status, 0, dead.stderr);
  const lockDir = path.join(f.cache, 'worlds', 'port-locks');
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, String(port)), dead.stdout.trim());
  f.config.world.services = [{ name: 'web', cmd: `"${process.execPath}" service.mjs`, port: true, ready: { port: true, timeout: 15000 } }];
  const world = await prepareWorld(f.project);
  try { assert.equal(world.port('web'), port); }
  finally { assert.equal(await world.dispose(), true); }
  assert.equal(fs.existsSync(path.join(lockDir, String(port))), false);
});

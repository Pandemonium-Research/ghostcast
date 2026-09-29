import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ghostcast.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostcast-shoot-'));
const repo = path.join(tmp, 'repo');
const cache = path.join(tmp, 'cache');
let failed = false;

function run(bin, args, cwd = repo) {
  const r = spawnSync(bin, args, { cwd, encoding: 'utf8', timeout: 10 * 60_000,
    env: { ...process.env, GHOSTCAST_CACHE: cache }, maxBuffer: 8 * 1024 * 1024 });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, error: r.error };
}
function good(r) { assert.equal(r.code, 0, `${r.error?.message || ''}\n${r.out}`); }
function fingerprint() {
  const status = run('git', ['status', '--porcelain=v2', '--untracked-files=all']).out;
  const refs = run('git', ['for-each-ref', '--format=%(refname) %(objectname)']).out;
  const data = ['README.md', 'page.html'].map((name) => crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, name))).digest('hex'));
  return { status, refs, data };
}
function outputs(name) {
  const mp4 = path.join(tmp, `${name}.mp4`), gif = path.join(tmp, `${name}.gif`);
  assert.ok(fs.existsSync(mp4), `missing ${mp4}`);
  assert.ok(fs.existsSync(gif), `missing ${gif}`);
  assert.ok(fs.statSync(gif).size < 10_000_000, `GIF exceeds 10 MB: ${fs.statSync(gif).size}`);
  const probe = run('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height,r_frame_rate:format=duration', '-of', 'json', mp4], tmp);
  good(probe);
  const info = JSON.parse(probe.out);
  assert.deepEqual([info.streams[0].width, info.streams[0].height, info.streams[0].r_frame_rate], [1920, 1080, '30/1']);
  assert.ok(Number(info.format.duration) > 2 && Number(info.format.duration) < 60, `bad duration: ${info.format.duration}`);
  assert.deepEqual(fs.readdirSync(path.join(cache, 'shoots')), [], 'throwaway project remained');
  console.log(`${name}: MP4 ${fs.statSync(mp4).size} bytes, GIF ${fs.statSync(gif).size} bytes, ${info.format.duration}s`);
}

fs.mkdirSync(repo);
fs.writeFileSync(path.join(repo, 'README.md'), 'A tiny repository\n');
fs.writeFileSync(path.join(repo, 'page.html'), '<!doctype html><title>Page</title><main><h1>Hello from a page</h1><p>Local page</p></main>\n');
good(run('git', ['init', '-q']));
good(run('git', ['-c', 'user.name=Ghostcast Test', '-c', 'user.email=test@example.invalid', 'add', '.']));
good(run('git', ['-c', 'user.name=Ghostcast Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial']));
const before = fingerprint();

after(() => {
  if (failed) console.log(`shoot test kept at ${tmp}`);
  else fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});
const step = (name, fn) => test(name, () => { try { fn(); } catch (e) { failed = true; throw e; } });

step('command shoot writes 1080p MP4 and compact GIF without touching source', () => {
  // Run from the source itself, the usual case: the outputs land there once the source is checked.
  const r = run(process.execPath, [CLI, 'shoot', 'echo hello && ls']);
  good(r);
  assert.match(r.out, /command exit code: 0/);
  assert.match(r.out, /source untouched/);
  for (const ext of ['mp4', 'gif']) fs.renameSync(path.join(repo, `echo-hello-ls.${ext}`), path.join(tmp, `echo-hello-ls.${ext}`));
  outputs('echo-hello-ls');
  assert.deepEqual(fingerprint(), before);
});

step('file URL shoot frames a local page and cleans up', () => {
  const r = run(process.execPath, [CLI, 'shoot', pathToFileURL(path.join(repo, 'page.html')).href, '--out', 'page-shot.mp4'], tmp);
  good(r);
  outputs('page-shot');
  assert.deepEqual(fingerprint(), before);
});

step('a command with a non-zero exit is filmed and its status is reported', () => {
  const r = run(process.execPath, [CLI, 'shoot', 'echo failing && exit 7', '--in', repo, '--out', 'failed-command.mp4'], tmp);
  good(r);
  assert.match(r.out, /command exit code: 7/);
  outputs('failed-command');
  assert.deepEqual(fingerprint(), before);
});

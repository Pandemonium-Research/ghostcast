#!/usr/bin/env node
// ghostcast: record, cut, caption and voice a screencast from scripted scenes.
// Run `ghostcast help` for the commands; SKILL.md has the workflow.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitBash } from '../src/shell.mjs';
import { cacheDir, worldsDir, prepareWorld, openWorld } from '../src/world.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');

const HELP = `ghostcast — a recording studio for coding agents

  ghostcast shoot <command|url> [--in <dir>] [--out <file>] [--timeout <seconds>] [--keep]
                                        quick MP4 + README GIF, no project needed
  ghostcast init                        add .ghostcast/ to this repository
  ghostcast init <dir>                  create a sample project
  ghostcast template <type> [--force]   write a launch, how-to, feature or receipt storyboard
  ghostcast lint [--json]               check the studio plan and its timing
  ghostcast approve storyboard          record approval of the lint-clean storyboard
  ghostcast next [--json]               report the first unfinished studio stage and next action
  ghostcast compile                     generate cache/storyboard.mjs and timeline.json
  ghostcast rehearse [beat ids...] [--runs 3] [--headed]
                                        dry run beats without capture and report flakiness
  ghostcast doctor                      check Chrome, ffmpeg and editor tools
  ghostcast vscode [--port 8765] --accept-server-license-terms
                                        serve VS Code in the browser for editor scenes
                                        (runs until stopped; start it in the background, and
                                        record once it prints "VS Code is ready")

  ghostcast record <take> [--headed] [--keep-world]
                                        run the take in an isolated world
  ghostcast cut <take> [...]            raw/<take>/ → clips/<take>.mp4 (segments, speed, zoom)
  ghostcast all [<take> ...] [--keep-world]
                                        record + cut each take (one retry), then assemble
  ghostcast assemble                    clips + captions → out/<name>-silent.mp4 + cue sheet
  ghostcast review <take|final> [--raw] [--at <s>] [--every <s>]
                                        contact sheets and stills under out/review/

  ghostcast vo-script                   narration blocks timed against the cut → out/voiceover-script.md
  ghostcast pauses <audio> [...]        silences in voice-over clips: where to cut them into pieces
  ghostcast vo-mix [--plan <file>]      lay the voice-over → out/<name>.mp4 + placement report

Options: --project <dir> (default: the current directory).`;

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); if (i < 0) return false; argv.splice(i, 1); return true; };
const opt = (name, dflt) => { const i = argv.indexOf(name); if (i < 0) return dflt; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const die = (msg) => { console.error(msg); process.exit(1); };

const explicitProject = opt('--project', null);
const current = process.cwd();
const projectDir = path.resolve(explicitProject || (fs.existsSync(path.join(current, '.ghostcast', 'product.md'))
  && !fs.existsSync(path.join(current, 'project.json')) ? path.join(current, '.ghostcast') : current));
const cmd = argv.shift();

function timeline() {
  const f = path.join(projectDir, 'timeline.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { items: [] };
}

function sceneFor(take) {
  const item = timeline().items.find((i) => i.take === take);
  const rel = item?.scene || `scenes/${take}.mjs`;
  if (!fs.existsSync(path.join(projectDir, rel))) throw new Error(`${take}: no scene (${rel}); add it, or set "scene" on the take in timeline.json`);
  return rel;
}

async function record(take, headed, world) {
  const { loadProject, record: rec } = await import('../src/recorder.mjs');
  return rec(loadProject(projectDir), sceneFor(take), take, { headed, world });
}

// Each take records in a child process: a scene that hangs or crashes Chrome takes only itself down.
function recordChild(take, headed, world) {
  return new Promise((resolve) => {
    const args = [fileURLToPath(import.meta.url), 'record', take, '--project', projectDir,
      ...(headed ? ['--headed'] : []), ...(world ? ['--world-dir', world.dir] : [])];
    const p = spawn(process.execPath, args, { stdio: 'inherit' });
    p.on('error', (e) => { console.error(e); resolve(false); });
    p.on('exit', (code) => resolve(code === 0));
  });
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name === 'gitignore' ? '.gitignore' : e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (!fs.existsSync(d)) fs.copyFileSync(s, d);
  }
}

function studioDir() {
  return path.basename(projectDir) === '.ghostcast' ? projectDir : path.join(projectDir, '.ghostcast');
}

// A studio folder's scene and timeline are generated, so a shoot compiles first: it films what the
// storyboard says now, not what it said at the last compile.
async function compileStudio() {
  if (!fs.existsSync(path.join(projectDir, 'product.md')) || !fs.existsSync(path.join(projectDir, 'storyboard.yaml'))) return;
  const { compile } = await import('../src/studio/compile.mjs');
  try { compile(projectDir); } catch (e) { die(e.message); }
}

function slug(name) {
  const clean = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'video';
  return /^[a-z]/.test(clean) ? clean : `video-${clean}`;
}

function which(bin) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
}

// Files ghostcast keeps once per machine rather than per project: GHOSTCAST_CACHE, or the platform's
// cache folder.
// The VS Code server that `code serve-web` downloads (about 600 MB a build) lives in the cache, shared
// by every project: the download takes minutes, and from inside a deep project folder its files pass
// Windows' 260-character path limit (the terminal then fails with "Cannot find conpty.dll").
const vscodeCliDir = () => path.join(cacheDir(), 'vscode-cli');
// The deepest file in a server build is about 166 characters below that folder (VS Code 1.138).
const SERVER_DEPTH = 175;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getText = (url) => new Promise((resolve, reject) => {
  http.get(url, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve(body));
  }).on('error', reject);
});

// serve-web downloads its server on the first page load, and a scene started before the download ends
// fails. Load the page from here, so the download starts now, and say when VS Code is ready.
async function announceReady(port, token, server) {
  let told = false;
  while (server.exitCode === null) {
    try {
      const body = await getText(`http://127.0.0.1:${port}/?tkn=${token}`);
      if (!/is downloading/.test(body)) {
        console.log(`ghostcast: VS Code is ready on http://127.0.0.1:${port}`);
        return;
      }
      if (!told) {
        console.log('ghostcast: downloading the VS Code server; this happens once per VS Code version and can take a few minutes');
        told = true;
      }
    } catch {}   // not listening yet
    await sleep(2000);
  }
}

// The workbench reads user settings from the browser's storage, not from disk; settings on disk
// reach it only at machine scope. The project's settings are written there, with a terminal
// profile that starts bash on the project's clean rc file.
function writeMachineSettings(dataDir) {
  const own = path.join(projectDir, 'vscode', 'settings.json');
  const settings = fs.existsSync(own) ? JSON.parse(fs.readFileSync(own, 'utf8')) : {};
  const rc = path.join(projectDir, 'vscode', 'shell.bashrc').replace(/\\/g, '/');
  if (fs.existsSync(rc)) {
    const key = { win32: 'windows', darwin: 'osx' }[process.platform] || 'linux';
    const bash = process.platform === 'win32' ? gitBash() : '/bin/bash';
    if (!bash) console.warn('warning: Git Bash not found; the terminal will use the default shell and not shell.bashrc');
    else if (!settings[`terminal.integrated.defaultProfile.${key}`]) {
      settings[`terminal.integrated.profiles.${key}`] = { 'Ghostcast Bash': { path: bash, args: ['--rcfile', rc, '-i'] } };
      settings[`terminal.integrated.defaultProfile.${key}`] = 'Ghostcast Bash';
    }
  }
  const dir = path.join(dataDir, 'data', 'Machine');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 2));
}

const commands = {
  help() { console.log(HELP); },

  async shoot() { const { shoot } = await import('../src/shoot.mjs'); try { await shoot(argv); } catch (e) { die(e.message); } },

  init() {
    if (argv[0]) {
      const dir = path.resolve(argv[0]);
      copyDir(path.join(PKG, 'templates', 'project'), dir);
      const pj = path.join(dir, 'project.json');
      const cfg = JSON.parse(fs.readFileSync(pj, 'utf8'));
      if (cfg.name === 'screencast') { cfg.name = path.basename(dir).toLowerCase().replace(/[^a-z0-9-]+/g, '-'); fs.writeFileSync(pj, JSON.stringify(cfg, null, 2) + '\n'); }
      console.log(`project at ${dir}\nnext: edit timeline.json and scenes/, then \`ghostcast record <take>\` from there (or pass --project).`);
      return;
    }
    const dir = studioDir();
    fs.mkdirSync(dir, { recursive: true });
    for (const entry of fs.readdirSync(path.join(PKG, 'templates', 'studio'), { withFileTypes: true })) {
      const target = path.join(dir, entry.name === 'gitignore' ? '.gitignore' : entry.name);
      const label = path.relative(process.cwd(), target).replace(/\\/g, '/') + (entry.isDirectory() ? '/' : '');
      if (fs.existsSync(target)) { console.log(`kept ${label}`); continue; }
      if (entry.isDirectory()) fs.mkdirSync(target);
      else fs.copyFileSync(path.join(PKG, 'templates', 'studio', entry.name), target);
      console.log(`created ${label}`);
    }
    const git = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: path.dirname(dir), encoding: 'utf8' });
    if (git.status !== 0 || git.stdout.trim() !== 'true') console.warn('warning: this directory is not a git repository');
  },

  async template() {
    const force = flag('--force');
    const type = argv[0];
    if (!['launch', 'how-to', 'feature', 'receipt'].includes(type)) die('usage: ghostcast template <launch|how-to|feature|receipt> [--force]');
    const dir = studioDir();
    const target = path.join(dir, 'storyboard.yaml');
    if (!fs.existsSync(path.join(dir, 'brief.md'))) die(`no brief.md in ${dir}; run ghostcast init first`);
    if (fs.existsSync(target) && !force) die(`${target} exists; pass --force to replace it`);
    const { validateBrief } = await import('../src/studio/schema.mjs');
    const problems = validateBrief(fs.readFileSync(path.join(dir, 'brief.md'), 'utf8'));
    if (problems.length) die(`complete brief.md before writing a template:\n${problems.map((problem) => `  ${problem.path || 'brief.md'}: ${problem.message}`).join('\n')}`);
    const source = fs.readFileSync(path.join(PKG, 'templates', 'storyboards', `${type}.yaml`), 'utf8');
    fs.writeFileSync(target, source.replace('__VIDEO__', slug(path.basename(path.dirname(dir)))));
    console.log(`wrote ${target}`);
  },

  async lint() {
    const json = flag('--json');
    const { lint, formatLint } = await import('../src/studio/lint.mjs');
    const report = lint(studioDir());
    console.log(json ? JSON.stringify(report, null, 2) : formatLint(report));
    if (report.errors.length) process.exitCode = 1;
  },

  async approve() {
    if (argv.length !== 1 || argv[0] !== 'storyboard') die('usage: ghostcast approve storyboard');
    const { approveStoryboard } = await import('../src/studio/approve.mjs');
    const { next } = await import('../src/studio/next.mjs');
    try {
      const dir = studioDir();
      const hash = approveStoryboard(dir);
      console.log(`approved storyboard (${hash.slice(0, 8)}) · next: ${next(dir).next}`);
    } catch (error) { die(error.message); }
  },

  async next() {
    const json = flag('--json');
    if (argv.length) die('usage: ghostcast next [--json]');
    const { next, formatNext } = await import('../src/studio/next.mjs');
    const report = next(studioDir());
    console.log(json ? JSON.stringify(report, null, 2) : formatNext(report));
  },

  async compile() {
    const { compile } = await import('../src/studio/compile.mjs');
    try { compile(studioDir()); console.log(`compiled ${path.join(studioDir(), 'cache', 'storyboard.mjs')} and timeline.json`); }
    catch (e) { die(e.message); }
  },

  async rehearse() {
    const headed = flag('--headed');
    const runs = Number(opt('--runs', '3'));
    const { loadProject } = await import('../src/recorder.mjs');
    const { rehearse } = await import('../src/studio/rehearse.mjs');
    try { process.exitCode = await rehearse(loadProject(studioDir()), { ids: argv, runs, headed }); }
    catch (e) { die(e.message); }
  },

  async doctor() {
    let bad = 0;
    // An optional tool is reported but does not fail the check: quick shoots never need it.
    const check = (name, ok, hint, { optional = false } = {}) => { console.log(`${ok ? 'ok  ' : optional ? 'opt ' : 'MISS'}  ${name}${ok && typeof ok === 'string' ? `  (${ok})` : ''}${ok ? '' : `  — ${hint}`}`); if (!ok && !optional) bad++; };
    check('node >= 20', Number(process.versions.node.split('.')[0]) >= 20 && process.version, 'install Node 20+ (Playwright needs it)');
    // Dependencies are found the way Node finds them, wherever npm put them (npx hoists them).
    const need = createRequire(import.meta.url);
    let pw = null;
    try { pw = JSON.parse(fs.readFileSync(need.resolve('playwright/package.json'), 'utf8')).version; } catch {}
    check('playwright', pw, 'npm install (in the ghostcast package)');
    let pty = null;
    try { await import('@lydell/node-pty'); pty = `${process.platform}-${process.arch}`; } catch {}
    check('terminal pty (prebuilt)', pty, 'no prebuilt pty for this platform: terminal scenes need Windows, macOS or glibc Linux, on x64 or ARM64');
    const chrome = {
      win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe')],
      darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
      linux: ['/opt/google/chrome/chrome', '/usr/bin/google-chrome'],
    }[process.platform] || [];
    check('Google Chrome', chrome.find((c) => fs.existsSync(c)), 'install Chrome, or set browser.channel in project.json (e.g. "msedge"), or run `npx playwright install chromium` and set it to "chromium"');
    check('ffmpeg', which('ffmpeg'), 'install ffmpeg and put it on PATH');
    check('ffprobe', which('ffprobe'), 'comes with ffmpeg');
    check('VS Code CLI (only for editor scenes)', which('code'), 'install VS Code and its `code` command', { optional: true });
    if (process.platform === 'win32') check('Git Bash (terminal scenes on Windows)', gitBash(), 'install Git for Windows');
    const cli = vscodeCliDir();
    let builds = [];
    try { builds = fs.readdirSync(path.join(cli, 'serve-web')).filter((d) => /^[0-9a-f]{40}$/.test(d)); } catch {}
    console.log(`info  VS Code server cache: ${cli}\n      ${builds.length
      ? `${builds.length} build(s) downloaded`
      : 'empty: the first `ghostcast vscode` downloads a build (about 600 MB), which can take a few minutes'}`);
    console.log(`info  isolated worlds: ${worldsDir()}`);
    if (process.platform === 'win32') {
      check('VS Code server cache path short enough for Windows', cli.length + SERVER_DEPTH <= 259,
        `the server's files would pass Windows' 260-character path limit; set GHOSTCAST_CACHE to a folder at most ${259 - SERVER_DEPTH - '\\vscode-cli'.length} characters long`);
      if (worldsDir().length + 13 + 120 > 259) console.warn('warn  World path may be too long for nested files on Windows; set GHOSTCAST_CACHE to a shorter folder');
    }
    process.exit(bad ? 1 : 0);
  },

  vscode() {
    const port = opt('--port', '8765');
    if (!flag('--accept-server-license-terms')) {
      die('`code serve-web` runs under the VS Code Server license (https://aka.ms/vscode-server-license).\n'
        + 'Read it; if you accept it, run again with --accept-server-license-terms.');
    }
    if (!which('code')) die('no `code` command on PATH');
    const v = path.join(projectDir, 'vscode');
    const token = path.join(v, 'token');
    if (!fs.existsSync(token)) fs.writeFileSync(token, crypto.randomBytes(16).toString('hex'));
    const serverData = path.join(v, 'server-data');
    writeMachineSettings(serverData);
    const cli = vscodeCliDir();
    fs.mkdirSync(cli, { recursive: true });
    const args = ['serve-web', '--host', '127.0.0.1', '--port', port, '--connection-token-file', token,
      '--accept-server-license-terms', '--server-data-dir', serverData, '--cli-data-dir', cli];
    console.log(`VS Code on http://127.0.0.1:${port} (token in vscode/token; server files in ${cli}); stop with Ctrl+C.\n`
      + 'Record once "VS Code is ready" is printed.');
    // On Windows `code` is a .cmd script, which needs a shell; the shell needs paths quoted.
    const win = process.platform === 'win32';
    const p = spawn('code', win ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args, { stdio: 'inherit', shell: win });
    p.on('exit', (code) => process.exit(code ?? 0));
    announceReady(port, fs.readFileSync(token, 'utf8').trim(), p);
  },

  async record() {
    const headed = flag('--headed');
    const keep = flag('--keep-world');
    const existing = opt('--world-dir', null);
    const take = argv[0] || die('usage: ghostcast record <take> [--headed]');
    if (!existing) await compileStudio();
    let world = null, ok = false, untouched = true;
    try {
      world = existing ? openWorld(existing) : await prepareWorld((await import('../src/recorder.mjs')).loadProject(projectDir), { keep });
      ok = await record(take, headed, world);
    } catch (e) { console.error(e.stack || e.message); }
    finally { if (world?.dispose) untouched = await world.dispose(); }
    process.exit(ok && untouched ? 0 : 1);
  },

  async cut() { if (!argv.length) die('usage: ghostcast cut <take> [...]'); const { cut } = await import('../src/post/render.mjs'); for (const take of argv) await cut(projectDir, take); },
  async assemble() { const { assemble } = await import('../src/post/render.mjs'); await assemble(projectDir); },
  async review() {
    const { review } = await import('../src/post/review.mjs');
    try { await review(projectDir, argv); } catch (e) { die(e.message); }
  },
  async 'vo-script'() { const { voScript } = await import('../src/post/voice.mjs'); try { voScript(projectDir); } catch (e) { die(e.message); } },
  async pauses() { const { pauses } = await import('../src/post/voice.mjs'); try { await pauses(argv); } catch (e) { die(e.message); } },
  async 'vo-mix'() { const { voMix } = await import('../src/post/voice.mjs'); try { await voMix(projectDir, argv); } catch (e) { die(e.message); } },

  async all() {
    const headed = flag('--headed');
    const keep = flag('--keep-world');
    await compileStudio();
    const takes = argv.length ? argv : timeline().items.map((i) => i.take);
    const failed = [];
    let world = null, untouched = true, code = 0;
    try {
      world = await prepareWorld((await import('../src/recorder.mjs')).loadProject(projectDir), { keep });
      for (const take of takes) {
        console.log(`=== ${take}`);
        let ok = false;
        for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
          ok = await recordChild(take, headed, world);
          if (!ok) console.log(`${take}: take failed (attempt ${attempt})`);
        }
        // A failed take leaves partial footage in raw/; it is never cut as if it were a good one.
        if (ok) { try { const { cut } = await import('../src/post/render.mjs'); await cut(projectDir, take); } catch (e) { console.error(e); failed.push(take); } } else { console.log(`${take}: NOT CUT (failed twice); see \`ghostcast review ${take} --raw\``); failed.push(take); }
      }
      try { const { assemble } = await import('../src/post/render.mjs'); await assemble(projectDir); } catch (e) { console.error(e); code = 1; }
    } catch (e) { console.error(e.stack || e.message); code = 1; }
    finally { if (world) untouched = await world.dispose(); }
    if (failed.length) { console.error(`failed: ${failed.join(', ')}`); code = 1; }
    process.exit(code || !untouched ? 1 : 0);
  },
};

if (!cmd || cmd === '--help' || cmd === '-h') commands.help();
else if (!commands[cmd]) die(`unknown command: ${cmd}\n\n${HELP}`);
else await commands[cmd]();

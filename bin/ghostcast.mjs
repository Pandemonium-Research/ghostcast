#!/usr/bin/env node
// ghostcast: record, cut, caption and voice a screencast from scripted scenes.
// Run `ghostcast help` for the commands; SKILL.md has the workflow.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');
const PY = path.join(PKG, 'py');

const HELP = `ghostcast — a recording studio for coding agents

  ghostcast init <dir>                  new project from the template
  ghostcast doctor                      check Chrome, ffmpeg, Python + Pillow, VS Code
  ghostcast vscode [--port 8765] --accept-server-license-terms
                                        serve VS Code in the browser for terminal/editor scenes
                                        (runs until stopped; start it in the background, and
                                        record once it prints "VS Code is ready")

  ghostcast record <take> [--headed]    run the take's scene and capture it to raw/<take>/
  ghostcast cut <take> [...]            raw/<take>/ → clips/<take>.mp4 (segments, speed, zoom)
  ghostcast all [<take> ...]            record + cut each take (one retry), then assemble
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

const projectDir = path.resolve(opt('--project', process.cwd()));
const cmd = argv.shift();

function python() {
  if (process.env.GHOSTCAST_PYTHON) return process.env.GHOSTCAST_PYTHON;
  for (const p of process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python']) {
    if (spawnSync(p, ['--version'], { stdio: 'ignore' }).status === 0) return p;
  }
  die('no Python found (set GHOSTCAST_PYTHON)');
}

function py(script, args) {
  const r = spawnSync(python(), [path.join(PY, script), ...args], {
    stdio: 'inherit', env: { ...process.env, GHOSTCAST_PROJECT: projectDir, PYTHONUTF8: '1' },
  });
  return r.status ?? 1;
}

function timeline() {
  const f = path.join(projectDir, 'timeline.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { items: [] };
}

function sceneFor(take) {
  const item = timeline().items.find((i) => i.take === take);
  const rel = item?.scene || `scenes/${take}.mjs`;
  if (!fs.existsSync(path.join(projectDir, rel))) die(`${take}: no scene (${rel}); add it, or set "scene" on the take in timeline.json`);
  return rel;
}

async function record(take, headed) {
  const { loadProject, record: rec } = await import('../src/recorder.mjs');
  return rec(loadProject(projectDir), sceneFor(take), take, { headed });
}

// Each take records in a child process: a scene that hangs or crashes Chrome takes only itself down.
function recordChild(take, headed) {
  return new Promise((resolve) => {
    const args = [fileURLToPath(import.meta.url), 'record', take, '--project', projectDir, ...(headed ? ['--headed'] : [])];
    const p = spawn(process.execPath, args, { stdio: 'inherit' });
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

function which(bin) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
}

// Files ghostcast keeps once per machine rather than per project: GHOSTCAST_CACHE, or the platform's
// cache folder.
function cacheDir() {
  if (process.env.GHOSTCAST_CACHE) return path.resolve(process.env.GHOSTCAST_CACHE);
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ghostcast');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'ghostcast');
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ghostcast');
}

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

function gitBash() {
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Git', 'bin', 'bash.exe'),
  ];
  return candidates.find((c) => fs.existsSync(c)) || null;
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

  init() {
    const dir = argv[0] ? path.resolve(argv[0]) : die('usage: ghostcast init <dir>');
    copyDir(path.join(PKG, 'templates', 'project'), dir);
    const pj = path.join(dir, 'project.json');
    const cfg = JSON.parse(fs.readFileSync(pj, 'utf8'));
    if (cfg.name === 'screencast') { cfg.name = path.basename(dir).toLowerCase().replace(/[^a-z0-9-]+/g, '-'); fs.writeFileSync(pj, JSON.stringify(cfg, null, 2) + '\n'); }
    console.log(`project at ${dir}\nnext: edit timeline.json and scenes/, then \`ghostcast record <take>\` from there (or pass --project).`);
  },

  doctor() {
    let bad = 0;
    const check = (name, ok, hint) => { console.log(`${ok ? 'ok  ' : 'MISS'}  ${name}${ok && typeof ok === 'string' ? `  (${ok})` : ''}${ok ? '' : `  — ${hint}`}`); if (!ok) bad++; };
    check('node >= 18', Number(process.versions.node.split('.')[0]) >= 18 && process.version, 'install Node 18+');
    let pw = null;
    try { pw = JSON.parse(fs.readFileSync(path.join(PKG, 'node_modules', 'playwright', 'package.json'), 'utf8')).version; } catch {}
    check('playwright', pw, 'npm install (in the ghostcast package)');
    const chrome = {
      win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe')],
      darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
      linux: ['/opt/google/chrome/chrome', '/usr/bin/google-chrome'],
    }[process.platform] || [];
    check('Google Chrome', chrome.find((c) => fs.existsSync(c)), 'install Chrome, or set browser.channel in project.json (e.g. "msedge"), or run `npx playwright install chromium` and set it to "chromium"');
    check('ffmpeg', which('ffmpeg'), 'install ffmpeg and put it on PATH');
    check('ffprobe', which('ffprobe'), 'comes with ffmpeg');
    const p = python();
    const pil = spawnSync(p, ['-c', 'import PIL; print(PIL.__version__)'], { encoding: 'utf8' });
    check(`Python + Pillow (${p})`, pil.status === 0 && `Pillow ${pil.stdout.trim()}`, `${p} -m pip install pillow`);
    check('VS Code CLI (only for terminal/editor scenes)', which('code'), 'install VS Code and its `code` command');
    if (process.platform === 'win32') check('Git Bash (terminal scenes on Windows)', gitBash(), 'install Git for Windows');
    const cli = vscodeCliDir();
    let builds = [];
    try { builds = fs.readdirSync(path.join(cli, 'serve-web')).filter((d) => /^[0-9a-f]{40}$/.test(d)); } catch {}
    console.log(`info  VS Code server cache: ${cli}\n      ${builds.length
      ? `${builds.length} build(s) downloaded`
      : 'empty: the first `ghostcast vscode` downloads a build (about 600 MB), which can take a few minutes'}`);
    if (process.platform === 'win32') {
      check('VS Code server cache path short enough for Windows', cli.length + SERVER_DEPTH <= 259,
        `the server's files would pass Windows' 260-character path limit; set GHOSTCAST_CACHE to a folder at most ${259 - SERVER_DEPTH - '\\vscode-cli'.length} characters long`);
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
    const take = argv[0] || die('usage: ghostcast record <take> [--headed]');
    const ok = await record(take, headed).catch((e) => { console.error(e.stack || e.message); return false; });
    process.exit(ok ? 0 : 1);
  },

  cut() { process.exit(argv.length ? py('cut.py', argv) : die('usage: ghostcast cut <take> [...]')); },
  assemble() { process.exit(py('assemble.py', argv)); },
  review() { process.exit(py('review.py', argv)); },
  'vo-script'() { process.exit(py('vo_script.py', argv)); },
  pauses() { process.exit(py('pauses.py', argv)); },
  'vo-mix'() { process.exit(py('vo_mix.py', argv)); },

  async all() {
    const headed = flag('--headed');
    const takes = argv.length ? argv : timeline().items.map((i) => i.take);
    const failed = [];
    for (const take of takes) {
      console.log(`=== ${take}`);
      let ok = false;
      for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
        ok = await recordChild(take, headed);
        if (!ok) console.log(`${take}: take failed (attempt ${attempt})`);
      }
      // A failed take leaves partial footage in raw/; it is never cut as if it were a good one.
      if (ok) { if (py('cut.py', [take]) !== 0) failed.push(take); } else { console.log(`${take}: NOT CUT (failed twice); see \`ghostcast review ${take} --raw\``); failed.push(take); }
    }
    const code = py('assemble.py', []);
    if (failed.length) die(`failed: ${failed.join(', ')}`);
    process.exit(code);
  },
};

if (!cmd || cmd === '--help' || cmd === '-h') commands.help();
else if (!commands[cmd]) die(`unknown command: ${cmd}\n\n${HELP}`);
else await commands[cmd]();

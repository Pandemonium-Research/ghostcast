// A one-shot project in the short cache path. The source checkout is only ever read by world.mjs.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cacheDir, isGit, prepareWorld } from './world.mjs';
import { loadProject, record } from './recorder.mjs';
import { cut, assemble, ffmpeg } from './post/render.mjs';

const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'project');
const MAX_GIF = 10_000_000;
// A command runs in a copy of its directory. Outside git the copy is everything in it, so a home
// folder or a whole drive is refused rather than copied.
const MAX_LOOSE_FILES = 20_000;

function tooManyFiles(dir) {
  let count = 0;
  const pending = [dir];
  while (pending.length) {
    let entries;
    try { entries = fs.readdirSync(pending.pop(), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name === '.git') continue;
      if (e.isDirectory() && !e.isSymbolicLink()) pending.push(path.join(e.parentPath ?? e.path, e.name));
      else if (++count > MAX_LOOSE_FILES) return true;
    }
  }
  return false;
}

function options(args) {
  const parsed = { source: process.cwd(), timeout: 60, keep: false, out: null, target: null };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--keep') parsed.keep = true;
    else if (['--in', '--out', '--timeout'].includes(arg)) {
      if (!args[i + 1]) throw new Error(`${arg} needs a value`);
      parsed[{ '--in': 'source', '--out': 'out', '--timeout': 'timeout' }[arg]] = args[++i];
    } else if (arg.startsWith('--') || parsed.target !== null) throw new Error(`unexpected shoot argument: ${arg}`);
    else parsed.target = arg;
  }
  if (!parsed.target) throw new Error('usage: ghostcast shoot <command|url> [--in <dir>] [--out <file>] [--timeout <seconds>] [--keep]');
  parsed.source = path.resolve(parsed.source);
  if (!fs.statSync(parsed.source, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`shoot source is not a directory: ${parsed.source}`);
  parsed.timeout = Number(parsed.timeout);
  if (!Number.isFinite(parsed.timeout) || parsed.timeout <= 0) throw new Error('--timeout must be a positive number of seconds');
  return parsed;
}

function pageTarget(target) {
  try {
    const url = new URL(target);
    return ['http:', 'https:', 'file:'].includes(url.protocol) ? url : null;
  } catch { return null; }
}

function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48).replace(/-$/g, '') || 'shoot';
}

function sceneCode(target, url, timeout, statusFile, resultFile) {
  if (!url) return `import fs from 'node:fs';
export async function setup(h) { await h.terminal.open(); }
export default async function (h) {
  const command = ${JSON.stringify(target)};
  // Close on the prompt row, wide enough for the whole command, while it is typed; pull back
  // for the run. The pull-back finishes here, at normal speed, before the wait is sped up.
  await h.seg('shoot_type', async () => {
    await h.focus(await h.page.evaluate((length) => {
      const term = window.__ghostcastTerminal, screen = document.querySelector('.xterm-screen').getBoundingClientRect();
      const cell = { w: screen.width / term.cols, h: screen.height / term.rows };
      return { x: screen.x, y: screen.y + term.buffer.active.cursorY * cell.h, w: Math.min(screen.width, (length + 3) * cell.w), h: cell.h };
    }, command.length));
    await h.sleep(900);
    await h.typeCommand(command);
    await h.sleep(400);
    await h.press('Enter');
    h.unfocus();
    await h.sleep(900);
  });
  let timedOut = false;
  await h.seg('shoot_wait', async () => {
    try { await h.prompt({ timeout: ${Math.round(timeout * 1000)} }); }
    catch (error) {
      if (/terminal exited with code/.test(error.message)) return;
      if (!/did not return within/.test(error.message)) throw error;
      timedOut = true;
      await h.press('Control+C');
      await h.prompt({ timeout: 10000 });
    }
  }, { fitAfterMs: 8000, fitSeconds: 4 });
  const status = h.terminalExitCode ?? Number(fs.readFileSync(${JSON.stringify(statusFile)}, 'utf8').trim());
  fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ exitCode: status, timedOut }));
  await h.seg('shoot_output', async () => {
    await h.focus(await h.terminalLastRect(command, { rows: 6 }));
    await h.sleep(2400);
    h.unfocus();
    await h.sleep(1000);
  });
}
`;
  return `export async function setup(h) { await h.goto(${JSON.stringify(url.href)}, { cursor: false, waitUntil: 'domcontentloaded' }); }
export default async function (h) {
  await h.seg('shoot_page', async () => {
    await h.sleep(950);
    const heading = h.page.getByRole('heading', { level: 1 }).first();
    if (await heading.count()) {
      const box = await heading.boundingBox();
      if (box && box.width < h.config.viewport.width * 0.8) {
        await h.focus(heading, { zoom: 1.6 });
        await h.sleep(1800);
        h.unfocus();
        await h.sleep(800);
      }
    }
  });
  await h.seg('shoot_scroll', async () => {
    const dy = await h.page.evaluate(() => Math.min(document.scrollingElement.scrollHeight - innerHeight, innerHeight * 2));
    if (dy > 0) await h.scroll(dy, { ms: 1700 });
    await h.sleep(1900);
  });
}
`;
}

function duration(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffprobe failed: ${r.stderr}`);
  return Number(r.stdout.trim());
}

async function gif(mp4, output) {
  const total = duration(mp4);
  for (const [width, fps, seconds] of [[800, 12, 12], [640, 10, 10], [480, 8, 8]]) {
    const length = Math.min(total, seconds);
    const start = Math.max(0, total - length);
    const filter = `[0:v]fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5[v]`;
    await ffmpeg(['-ss', String(start), '-t', String(length), '-i', mp4, '-filter_complex', filter, '-map', '[v]', '-loop', '0', '-y', output]);
    if (fs.statSync(output).size < MAX_GIF) return;
  }
  throw new Error(`GIF could not be kept under 10 MB: ${output}`);
}

export async function shoot(args) {
  const started = Date.now();
  const opts = options(args);
  const url = pageTarget(opts.target);
  if (url?.protocol === 'file:' && !fs.statSync(fileURLToPath(url), { throwIfNoEntry: false })?.isFile())
    throw new Error(`page does not exist: ${fileURLToPath(url)}`);
  const name = slug(url ? url.protocol === 'file:' ? path.basename(url.pathname) : `${url.hostname}-${url.pathname}` : opts.target);
  const base = opts.out ? path.resolve(opts.out).replace(/\.(mp4|gif)$/i, '') : path.join(process.cwd(), name);
  const gitSource = !url && isGit(opts.source);
  if (!url && !gitSource && tooManyFiles(opts.source))
    throw new Error(`${opts.source} is not a git repository and holds over ${MAX_LOOSE_FILES} files; run shoot from your project, or pass --in <dir>`);
  const projectRoot = path.join(cacheDir(), 'shoots', crypto.randomBytes(5).toString('hex'));
  fs.mkdirSync(path.join(projectRoot, 'scenes'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'vscode'), { recursive: true });
  let world, untouched = true;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(TEMPLATE, 'project.json'), 'utf8'));
    cfg.name = 'shoot';
    const statusFile = path.join(projectRoot, 'status.txt');
    const resultFile = path.join(projectRoot, 'result.json');
    // A page is only read, so it needs no copy. A command gets one, with node_modules copied
    // rather than linked so that tools writing caches there cannot reach the real one.
    if (!url) {
      cfg.world = { source: opts.source, mode: 'snapshot', ...(gitSource && fs.existsSync(path.join(opts.source, 'node_modules')) ? { copy: ['node_modules'] } : {}) };
      cfg.shoot = { statusFile };
    }
    fs.writeFileSync(path.join(projectRoot, 'project.json'), JSON.stringify(cfg, null, 2) + '\n');
    fs.writeFileSync(path.join(projectRoot, 'timeline.json'), JSON.stringify({ items: [{ take: 'shoot' }] }, null, 2) + '\n');
    fs.copyFileSync(path.join(TEMPLATE, 'vscode', 'shell.bashrc'), path.join(projectRoot, 'vscode', 'shell.bashrc'));
    fs.writeFileSync(path.join(projectRoot, 'scenes', 'shoot.mjs'), sceneCode(opts.target, url, opts.timeout, statusFile, resultFile));
    const project = loadProject(projectRoot);
    world = await prepareWorld(project);
    await record(project, 'scenes/shoot.mjs', 'shoot', { world });
    await cut(projectRoot, 'shoot');
    await assemble(projectRoot);
    // Checked before the outputs land, since they are usually written into the source itself.
    if (world) { untouched = await world.dispose(); world = null; }
    if (!untouched) throw new Error(`the shoot reached ${opts.source}; see the messages above`);
    fs.mkdirSync(path.dirname(base), { recursive: true });
    const mp4 = `${base}.mp4`, loop = `${base}.gif`;
    fs.copyFileSync(path.join(projectRoot, 'out', 'shoot-silent.mp4'), mp4);
    await gif(mp4, loop);
    const result = !url ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : null;
    console.log(`MP4: ${mp4} (${(fs.statSync(mp4).size / 1048576).toFixed(2)} MiB)`);
    console.log(`GIF: ${loop} (${(fs.statSync(loop).size / 1048576).toFixed(2)} MiB)`);
    if (result) console.log(result.timedOut ? `command timed out after ${opts.timeout}s (exit code ${result.exitCode})` : `command exit code: ${result.exitCode}`);
    console.log(`shoot took ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } finally {
    if (world) await world.dispose();
    if (opts.keep) console.log(`shoot project kept: ${projectRoot}`);
    else fs.rmSync(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

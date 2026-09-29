// A shoot's disposable checkout. No git command here writes to the source repository.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { runShell, stopTree } from './shell.mjs';

export function cacheDir() {
  if (process.env.GHOSTCAST_CACHE) return path.resolve(process.env.GHOSTCAST_CACHE);
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ghostcast');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'ghostcast');
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ghostcast');
}
export const worldsDir = () => path.join(cacheDir(), 'worlds');

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args[0]}: ${r.stderr?.trim() || r.error?.message || 'failed'}`);
  return r.stdout;
}
export function isGit(dir) {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  return r.status === 0 && fs.realpathSync(r.stdout.trim()) === fs.realpathSync(dir);
}
function inside(file, dir) {
  const rel = path.relative(dir, file);
  return !rel || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
function physicalPath(file) {
  let parent = path.resolve(file);
  const rest = [];
  while (!fs.existsSync(parent)) {
    rest.unshift(path.basename(parent));
    const next = path.dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  return path.resolve(fs.realpathSync(parent), ...rest);
}
function safeRelative(rel) {
  const normalized = typeof rel === 'string' ? rel.replace(/\\/g, '/') : '';
  if (typeof rel !== 'string' || !rel || rel === '.' || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..') || normalized === '.git' || normalized.startsWith('.git/'))
    throw new Error(`world: unsafe relative path: ${rel}`);
  return rel;
}
function remove(file) {
  if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(file);
  else fs.rmSync(file, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
function copyEntry(src, dst, exclude) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true, dereference: false, verbatimSymlinks: true, force: true,
    filter: exclude ? (file) => !inside(file, exclude) : undefined });
}
function sourceFiles(source, exclude) {
  return git(source, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .split('\0').filter(Boolean).filter((rel) => !exclude || !inside(path.join(source, rel), exclude))
    .filter((rel) => !!fs.lstatSync(path.join(source, rel), { throwIfNoEntry: false }));
}
function walk(dir, prefix = '', exclude) {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    const rel = path.join(prefix, e.name);
    if (exclude && inside(path.join(dir, rel), exclude)) continue;
    if (e.name === '.git' && !prefix) continue;
    if (e.isDirectory() && !e.isSymbolicLink()) out.push(...walk(dir, rel, exclude));
    else out.push(rel);
  }
  return out;
}
function validateSnapshotLinks(snapshot) {
  for (const rel of walk(snapshot)) {
    const file = path.join(snapshot, rel);
    if (!fs.lstatSync(file).isSymbolicLink()) continue;
    const target = fs.readlinkSync(file);
    if (path.isAbsolute(target) || !inside(path.resolve(path.dirname(file), target), snapshot))
      throw new Error(`world snapshot contains a link outside the copy: ${rel}`);
  }
}
function hash(file) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  if (stat.isSymbolicLink()) return `link:${fs.readlinkSync(file)}`;
  if (!stat.isFile()) return `type:${stat.mode}`;
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function linkedEntries(dir) {
  const entries = {};
  const visit = (folder, prefix = '') => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const rel = path.join(prefix, entry.name);
      const file = path.join(folder, entry.name);
      const stat = fs.lstatSync(file);
      entries[rel.replace(/\\/g, '/')] = `${stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'link' : 'other'}:${stat.size}:${stat.mtimeMs}`;
      if (stat.isDirectory()) visit(file, rel);
    }
  };
  const stat = fs.statSync(dir, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) return { '.': 'missing' };
  visit(dir);
  return entries;
}
export function fingerprint(source, { links = [], exclude = null } = {}) {
  const gitSource = isGit(source);
  const names = gitSource ? sourceFiles(source, exclude) : walk(source, '', exclude);
  const files = Object.fromEntries(names.map((rel) => [rel.replace(/\\/g, '/'), hash(path.join(source, rel))]));
  const excluded = exclude && path.relative(source, exclude).replace(/\\/g, '/');
  return {
    files,
    linked: Object.fromEntries(links.map((rel) => [rel, linkedEntries(path.join(source, rel))])),
    exclude: excluded,
    status: gitSource ? git(source, ['status', '--porcelain=v2', '--untracked-files=all', ...(excluded ? ['--', '.', `:(exclude,literal)${excluded}`] : [])]) : '',
    refs: gitSource ? git(source, ['for-each-ref', '--format=%(refname) %(objectname)']) : '',
    stash: gitSource ? git(source, ['stash', 'list', '--format=%H %gd']) : '',
    worktrees: gitSource ? git(source, ['worktree', 'list', '--porcelain']) : '',
  };
}
export function checkUntouched(source, before, dir, report = console) {
  const after = fingerprint(source, { links: Object.keys(before.linked || {}), exclude: before.exclude ? path.join(source, before.exclude) : null });
  const changed = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])]
    .filter((p) => before.files[p] !== after.files[p]).sort();
  const linked = Object.fromEntries(Object.keys(before.linked || {}).map((link) => [link,
    [...new Set([...Object.keys(before.linked[link]), ...Object.keys(after.linked[link])])]
      .filter((rel) => before.linked[link][rel] !== after.linked[link][rel]).sort()]));
  const linkedChanged = Object.entries(linked).filter(([, files]) => files.length);
  if (changed.length) report.log(`changed during the shoot: ${changed.join(', ')}`);
  else if (!linkedChanged.length && before.status === after.status && before.refs === after.refs && before.stash === after.stash && before.worktrees === after.worktrees)
    report.log('source untouched during the shoot');
  else if (before.status !== after.status) report.log('source index/status changed during the shoot');
  const leaks = changed.filter((rel) => after.files[rel] !== null && after.files[rel] === hash(path.join(dir, rel)));
  const metadata = ['refs', 'stash', 'worktrees'].filter((key) => before[key] !== after[key]);
  if (metadata.length) report.error(`source ${metadata.join(', ')} changed during the shoot`);
  for (const [link, files] of linkedChanged) report.error(`wrote through world.link ${link}: ${files.join(', ')}`);
  if (leaks.length) report.error(`write leaked out of the copy: ${leaks.join(', ')}`);
  return { changed, leaks, metadata, linked, ok: !leaks.length && !metadata.length && !linkedChanged.length };
}

function candidatePort(requested = 0) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(requested, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}
async function freePort(locks) {
  const lockDir = path.join(worldsDir(), 'port-locks');
  fs.mkdirSync(lockDir, { recursive: true });
  const stale = [];
  for (const name of fs.readdirSync(lockDir)) {
    if (!/^\d+$/.test(name)) continue;
    const port = Number(name);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const lock = path.join(lockDir, name);
    let pid;
    try { pid = Number(fs.readFileSync(lock, 'utf8').trim()); }
    catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    try { if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid, 0); else stale.push(port); }
    catch (e) { if (e.code === 'ESRCH') stale.push(port); else if (e.code !== 'EPERM') throw e; }
  }
  for (const port of stale) {
    const lock = path.join(lockDir, String(port));
    try { await candidatePort(port); }
    catch (e) { if (e.code === 'EADDRINUSE' || e.code === 'EACCES') continue; throw e; }
    try { fs.rmSync(lock); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); locks.push(lock); return port; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = await candidatePort();
    const lock = path.join(lockDir, String(port));
    try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); locks.push(lock); return port; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let pid;
      try { pid = Number(fs.readFileSync(lock, 'utf8').trim()); }
      catch (readError) { if (readError.code === 'ENOENT') continue; throw readError; }
      try { if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid, 0); else pid = null; }
      catch (probeError) { if (probeError.code === 'ESRCH') pid = null; else if (probeError.code !== 'EPERM') throw probeError; }
      if (pid === null) {
        try { fs.rmSync(lock); fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); locks.push(lock); return port; }
        catch (retryError) { if (retryError.code !== 'EEXIST' && retryError.code !== 'ENOENT') throw retryError; }
      }
    }
  }
  throw new Error('could not reserve a distinct service port');
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function serviceName(name) { return String(name).toUpperCase().replace(/[^A-Z0-9]/g, '_'); }
function resolveIn(dir, rel) {
  if (rel === '.') return dir;
  const file = path.resolve(dir, safeRelative(rel));
  if (!inside(file, dir)) throw new Error(`world path escapes copy: ${rel}`);
  return file;
}
async function ready(service, proc, port, logFile) {
  const spec = service.ready || (port ? { port: true } : null);
  if (!spec) return;
  const deadline = Date.now() + (spec.timeout || 30000);
  let last = '';
  while (Date.now() < deadline) {
    if (proc.worldError) throw proc.worldError;
    if (proc.exitCode !== null) throw new Error(`service ${service.name} exited before ready (see ${logFile})`);
    try {
      if (spec.log && new RegExp(spec.log).test(fs.readFileSync(logFile, 'utf8'))) return;
      if (spec.url) {
        const url = (spec.url.startsWith('/') ? `http://127.0.0.1:${port}${spec.url}` : spec.url).replace(/\$\{PORT\}/g, String(port));
        const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
        if (res.ok) return;
      }
      if (spec.port) {
        const target = typeof spec.port === 'number' ? spec.port : port;
        await new Promise((resolve, reject) => { const s = net.connect(target, '127.0.0.1', resolve); s.once('error', reject); s.setTimeout(1000, () => s.destroy(new Error('timeout'))); s.once('connect', () => s.end()); });
        return;
      }
    } catch (e) { last = e.message; }
    await sleep(100);
  }
  throw new Error(`service ${service.name} not ready (${last}; see ${logFile})`);
}

export function openWorld(dir) {
  const id = path.basename(dir);
  if (!/^[0-9a-f]{12}$/.test(id) || path.resolve(path.dirname(dir)) !== path.resolve(worldsDir())) throw new Error(`invalid world directory: ${dir}`);
  const meta = JSON.parse(fs.readFileSync(`${dir}.json`, 'utf8'));
  const { source, links, ports } = meta;
  const profile = path.join(meta.projectRoot, '.ghostcast', 'world-profiles', id);
  const reset = () => {
    // Unlink first: neither git clean nor recursive removal may traverse a user-owned target.
    for (const rel of links) remove(resolveIn(dir, rel));
    if (meta.git) {
      git(dir, ['reset', '--hard', meta.baseRef]);
      git(dir, ['clean', '-fdx']);
    }
    for (const entry of fs.readdirSync(dir)) if (entry !== '.git') remove(path.join(dir, entry));
    for (const rel of walk(`${dir}.snapshot`)) copyEntry(path.join(`${dir}.snapshot`, rel), path.join(dir, rel));
    for (const rel of links) {
      const target = resolveIn(dir, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.symlinkSync(path.join(source, rel), target, process.platform === 'win32' ? 'junction' : 'dir');
    }
  };
  return {
    dir, source, profile, reset,
    port(name) { if (!(name in ports)) throw new Error(`unknown world service: ${name}`); return ports[name]; },
    url(name, pathname = '/') { return `http://127.0.0.1:${this.port(name)}${pathname.startsWith('/') ? pathname : '/' + pathname}`; },
  };
}

export async function prepareWorld(project, { keep = false } = {}) {
  const cfg = project.config.world;
  if (!cfg) return null;
  if (!cfg.source) throw new Error('world.source is required');
  const projectRoot = fs.realpathSync(project.root);
  const source = fs.realpathSync(path.resolve(project.root, cfg.source));
  if (!fs.statSync(source).isDirectory()) throw new Error(`world source is not a directory: ${source}`);
  if (inside(source, projectRoot)) throw new Error('world source must not be inside the ghostcast project');
  const excluded = inside(projectRoot, source) ? projectRoot : null;
  if (!['snapshot', 'commit'].includes(cfg.mode || 'snapshot')) throw new Error(`unknown world mode: ${cfg.mode}`);
  const gitSource = isGit(source);
  if (cfg.mode === 'commit' && (!gitSource || !cfg.ref)) throw new Error('world commit mode requires a git source and ref');
  const dir = path.join(worldsDir(), crypto.randomBytes(6).toString('hex'));
  const physicalDir = physicalPath(dir);
  if (inside(physicalDir, source) || inside(source, physicalDir) || inside(physicalDir, projectRoot))
    throw new Error('world cache must be outside the source and ghostcast project');
  const links = (cfg.link || []).map(safeRelative);
  const copies = (cfg.copy || []).map(safeRelative);
  for (const rel of links) if (!fs.statSync(path.join(source, rel)).isDirectory()) throw new Error(`world.link is not a directory: ${rel}`);
  if (excluded && links.some((rel) => inside(excluded, path.join(source, rel)) || inside(path.join(source, rel), excluded)))
    throw new Error('world.link overlaps the ghostcast project');
  for (const rel of copies) if (links.some((link) => rel === link || rel.startsWith(link + '/'))) throw new Error(`world.copy overlaps world.link: ${rel}`);
  const before = fingerprint(source, { links, exclude: excluded });
  const linked = (rel) => links.some((link) => {
    const item = rel.replace(/\\/g, '/'), target = link.replace(/\\/g, '/');
    return item === target || item.startsWith(target + '/');
  });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.mkdirSync(dir);
  const ports = {};
  const serviceNames = new Set();
  const profile = path.join(projectRoot, '.ghostcast', 'world-profiles', path.basename(dir));
  const locks = [];
  const children = [];
  let checked = false;
  let disposing;
  const onInterrupt = () => { void dispose().finally(() => process.exit(130)); };
  const onTerminate = () => { void dispose().finally(() => process.exit(143)); };
  const dispose = () => disposing ||= (async () => {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
    for (const child of children.reverse()) await stopTree(child);
    try {
      const result = checkUntouched(source, before, dir);
      checked = true;
      return result.ok;
    } finally {
      for (const lock of locks) remove(lock);
      if (!keep) { remove(dir); remove(`${dir}.snapshot`); remove(`${dir}.json`); remove(profile); }
      else console.log(`world kept: ${dir}`);
    }
  })();
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  try {
    let baseRef = null;
    if (gitSource) {
      git(project.root, ['clone', '--shared', '--no-checkout', '--', source, dir]);
      baseRef = cfg.mode === 'commit' ? git(source, ['rev-parse', '--verify', `${cfg.ref}^{commit}`]).trim() : git(source, ['rev-parse', 'HEAD']).trim();
      git(dir, ['checkout', '--force', '--detach', baseRef]);
    }
    const snapshot = `${dir}.snapshot`;
    fs.mkdirSync(snapshot);
    const names = cfg.mode === 'commit' ? [] : gitSource ? sourceFiles(source, excluded) : walk(source, '', excluded);
    for (const rel of names) {
      if (linked(rel)) continue;
      copyEntry(path.join(source, rel), path.join(snapshot, rel), excluded);
    }
    for (const rel of copies) {
      const entry = resolveIn(source, rel);
      if (excluded && inside(entry, excluded)) continue;
      copyEntry(entry, path.join(snapshot, rel), excluded);
    }
    // In commit mode the committed files, rather than the source working tree, form the baseline.
    if (cfg.mode === 'commit') for (const rel of walk(dir, '', excluded && path.join(dir, path.relative(source, excluded)))) copyEntry(path.join(dir, rel), path.join(snapshot, rel));
    validateSnapshotLinks(snapshot);
    fs.writeFileSync(`${dir}.json`, JSON.stringify({ source, projectRoot, git: gitSource, baseRef, links, ports }));
    const world = openWorld(dir);
    world.reset();
    for (const cmd of cfg.setup || []) await runShell(cmd, { cwd: dir });
    // Setup is part of the baseline that take-level resets restore.
    remove(snapshot);
    fs.mkdirSync(snapshot);
    for (const rel of walk(dir, '', excluded && path.join(dir, path.relative(source, excluded)))) {
      if (linked(rel)) continue;
      copyEntry(path.join(dir, rel), path.join(snapshot, rel));
    }
    validateSnapshotLinks(snapshot);
    for (const service of cfg.services || []) {
      if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(service.name || '') || !service.cmd || serviceNames.has(service.name))
        throw new Error('world services need unique simple names and commands');
      serviceNames.add(service.name);
      const port = service.port ? await freePort(locks) : undefined;
      if (port) ports[service.name] = port;
      fs.writeFileSync(`${dir}.json`, JSON.stringify({ source, projectRoot, git: gitSource, baseRef, links, ports }));
      const logFile = path.join(project.root, 'logs', `world-${path.basename(dir)}-${service.name}.log`);
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      const output = fs.openSync(logFile, 'a');
      const env = { ...process.env, ...service.env, ...(port ? { PORT: String(port), [`GHOSTCAST_PORT_${serviceName(service.name)}`]: String(port) } : {}) };
      const cwd = service.cwd ? resolveIn(dir, service.cwd) : dir;
      assertOutsideSource(cwd, source);
      const child = spawn(service.cmd, { cwd, env, shell: true, detached: process.platform !== 'win32', stdio: ['ignore', output, output] });
      child.on('error', (e) => { child.worldError = e; });
      fs.closeSync(output);
      children.push(child);
      await ready(service, child, port, logFile);
    }
    return { ...openWorld(dir), dispose, keep };
  } catch (e) {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
    for (const child of children.reverse()) await stopTree(child);
    try { if (!checked) checkUntouched(source, before, dir); }
    finally {
      for (const lock of locks) remove(lock);
      if (!keep) { remove(dir); remove(`${dir}.snapshot`); remove(`${dir}.json`); remove(profile); }
    }
    throw e;
  }
}

export function assertOutsideSource(file, source) {
  if (!source) return;
  const target = path.resolve(file);
  if (inside(target, source)) throw new Error(`file helper refuses world source path: ${target}`);
  let parent = target;
  while (!fs.existsSync(parent)) parent = path.dirname(parent);
  if (inside(fs.realpathSync(parent), source)) throw new Error(`file helper refuses world source path: ${target}`);
}

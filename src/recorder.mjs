// Headless recorder: run a scene in an off-screen Chrome and keep every frame it paints.
//
// A scene is an ES module exporting an optional `async setup(h)`, run before capture starts, and a
// default `async (h) => {}`, the captured part. `h` carries everything a scene needs (see
// makeHelpers): typing, terminal and editor helpers, zoom focus, highlight marks, segments, and the
// VS Code helpers under `h.vscode`.
//
// Frames come from Chrome's screencast as JPEGs stamped with the browser's clock; the event log is
// kept here, in Node, stamped with the same machine clock — so a take may navigate between pages
// and origins without losing its log. Output, under <project>/raw/<take>/:
//   frames/NNNNNN.jpg   every frame Chrome painted
//   frames.json         [[epoch_seconds, "NNNNNN.jpg"], ...]
//   log.json            [[epoch_ms, label, data?], ...]: +name/-name segments, focus/unfocus, viewport
import { chromium } from 'playwright';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pty from '@lydell/node-pty';
import { gitBash } from './shell.mjs';
import { assertOutsideSource } from './world.mjs';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const DRIVER = fs.readFileSync(path.join(SRC, 'driver.js'), 'utf8');
// xterm is found the way Node finds any dependency, so it loads wherever npm put it: an install
// through npx or as a dependency hoists it out of ghostcast's own folder.
const XTERM = path.resolve(path.dirname(createRequire(import.meta.url).resolve('@xterm/xterm')), '..');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => ms * (0.55 + Math.random() * 0.9);

export function loadProject(dir) {
  const root = path.resolve(dir);
  const file = path.join(root, 'project.json');
  if (!fs.existsSync(file)) throw new Error(`no project.json in ${root} (run: ghostcast init <dir>)`);
  return { root, config: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

export async function launch(project, { headed = false, world = null } = {}) {
  const { width, height, dpr } = project.config.viewport;
  const ctx = await chromium.launchPersistentContext(world ? world.profile : path.join(project.root, '.ghostcast', 'chrome-profile'), {
    channel: project.config.browser?.channel ?? 'chrome',
    headless: !headed,
    viewport: { width, height },
    deviceScaleFactor: dpr,
    // The screencast sends frames at the page's CSS size unless Chrome itself runs at the device
    // scale: deviceScaleFactor alone gives the page a devicePixelRatio but no extra pixels. With the
    // flag, frames are dpr × the viewport, and zooms up to dpr stay sharp.
    // An off-screen Chrome counts as hidden, and throttles hidden pages: timers slow, rendering
    // stops, and the screencast goes quiet. The rest keep it rendering as if it were in front.
    args: [
      '--hide-scrollbars', '--force-color-profile=srgb', `--force-device-scale-factor=${dpr}`,
      '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding', '--disable-background-media-suspend',
      '--disable-features=Translate,MediaRouter,CalculateNativeWinOcclusion,IntensiveWakeUpThrottling',
    ],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  return { ctx, page };
}

// The driver needs a built document, so it is evaluated after navigation rather than as an init
// script. It is idempotent; every navigation needs it again (h.goto and h.vscode.open do this).
// cursor:false hides the drawn cursor in the same step, so it never shows for a frame.
export const inject = (page, { cursor = true } = {}) =>
  page.evaluate(([src, c]) => { const r = eval(src); if (!c) window.__rec.hide(); return r; }, [DRIVER, cursor]);

export async function startCapture(project, page, dir, { quality = 92, everyNthFrame = 2 } = {}) {
  const framesDir = path.join(dir, 'frames');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });
  const { width, height, dpr } = project.config.viewport;
  const cdp = await page.context().newCDPSession(page);
  const index = [];
  let n = 0;
  cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
    const name = String(n++).padStart(6, '0') + '.jpg';
    fs.writeFileSync(path.join(framesDir, name), Buffer.from(data, 'base64'));
    index.push([metadata.timestamp, name]);
    try { await cdp.send('Page.screencastFrameAck', { sessionId }); } catch {}
  });
  await cdp.send('Page.startScreencast', {
    format: 'jpeg', quality, everyNthFrame,
    maxWidth: Math.round(width * dpr), maxHeight: Math.round(height * dpr),
  });
  return async () => {
    await cdp.send('Page.stopScreencast');
    await sleep(300);
    fs.writeFileSync(path.join(dir, 'frames.json'), JSON.stringify(index));
    return index.length;
  };
}

// Everything a scene gets. Keystrokes go through Playwright, so they are trusted events — xterm.js
// (VS Code's terminal) ignores synthetic ones.
export function makeHelpers(project, page, log, world = null) {
  const ev = (fn, arg) => page.evaluate(fn, arg);
  // A Playwright locator can't be passed into the page, so it becomes its on-screen rectangle here,
  // padded the way the page pads an element. Other targets go to the page as they are.
  const resolve = async (target, pad) => {
    if (!target || typeof target.boundingBox !== 'function') return target;
    const b = await target.first().boundingBox({ timeout: 10000 });
    if (!b) throw new Error('target not visible');
    return { x: b.x - pad, y: b.y - pad, w: b.width + 2 * pad, h: b.height + 2 * pad };
  };
  const rectOf = async (target, pad = 6) => ev(([t, p]) => window.__rec.rectOf(t, p), [await resolve(target, pad), pad]);
  const guarded = new Map();
  const sceneFolder = (folder) => {
    const target = path.resolve(world?.dir || project.root, folder || '.');
    assertOutsideSource(target, world?.source);
    return target;
  };
  let terminalPty = null;
  let terminalData = null;
  let terminalOutput = Promise.resolve();
  let terminalBindings = false;

  const closeTerminal = () => {
    terminalData?.dispose();
    terminalData = null;
    if (terminalPty) {
      try { terminalPty.kill(); } catch {}
      terminalPty = null;
    }
  };

  const h = {
    page, project, config: project.config, world, sleep,
    log(label, data) { log.push(data === undefined ? [Date.now(), label] : [Date.now(), label, data]); },

    // cut.py keeps a little footage either side of a segment; the pauses keep off-camera work (a
    // palette opening, a layout change) out of that margin. A name ending "@4x" plays sped up;
    // "@fit3" plays in 3 seconds whatever its real length (for model calls, installs, clones).
    async seg(name, fn) {
      await sleep(450);
      h.log('+' + name);
      try { return await fn(); } finally { h.log('-' + name); await sleep(550); }
    },

    async type(text, { cps = 17 } = {}) {
      for (const ch of text) {
        if (ch === '\n') await page.keyboard.press('Enter');
        else await page.keyboard.type(ch);
        await sleep(jitter(1000 / cps));
      }
    },
    press: (key) => page.keyboard.press(key),

    // Navigate, in setup or mid-take: the driver is re-injected and frames keep coming.
    async goto(url, { waitUntil = 'networkidle', cursor = true } = {}) {
      await page.goto(url, { waitUntil, timeout: 60000 });
      await inject(page, { cursor });
      await page.evaluate(() => window.__rec.heartbeat(true));
    },

    // ---- terminal (the active pane; see useTerm) ----
    prompt: (opts = {}) => ev((o) => window.__rec.term.prompt(o), opts),
    termText: () => ev(() => window.__rec.term.text()),
    termRect: (match, opts = {}) => ev(([m, o]) => window.__rec.term.rect(m, o), [match, opts]),
    useTerm: (i) => ev((p) => window.__rec.term.use(p), i),
    async waitFor(re, timeout = 180000) {
      await page.waitForFunction((src) => new RegExp(src).test(window.__rec.term.text()), re.source, { timeout, polling: 200 });
    },
    // Type a command at a human pace, run it, and wait for the prompt to come back.
    async run(cmd, { cps, after = 900, ...opts } = {}) {
      // The first key after focus moves into the terminal is sometimes dropped, so it is sent on its
      // own and confirmed on screen (and resent once) before the rest follows.
      const lastRow = () => ev(() => window.__rec.term.rows().filter((s) => s.trim()).slice(-1)[0] || '');
      const before = (await lastRow()).trimEnd();
      for (let attempt = 0; attempt < 2; attempt++) {
        await page.keyboard.type(cmd[0]);
        let ok = false;
        for (let t0 = Date.now(); Date.now() - t0 < 700; await sleep(60)) {
          const now = (await lastRow()).trimEnd();
          if (now.length > before.length && now.endsWith(cmd[0])) { ok = true; break; }
        }
        if (ok) break;
      }
      await sleep(jitter(1000 / (cps || 17)));
      await h.type(cmd.slice(1), { cps });
      // The command must be on screen before Enter; if focus slipped, fail rather than record a take
      // in which nothing happens. Long commands wrap, so only their tail is checked.
      const want = cmd.length <= 80 ? cmd : cmd.slice(-40);
      let tail = '';
      for (let t0 = Date.now(); Date.now() - t0 < 2000; await sleep(80)) {
        tail = await lastRow();
        if (tail.includes(want)) break;
      }
      if (!tail.includes(want)) throw new Error(`run: "${cmd}" did not reach the terminal (last row: "${tail.trim()}")`);
      await sleep(jitter(280));
      await page.keyboard.press('Enter');
      const out = await h.prompt(opts);
      await sleep(after);
      return out;
    },

    // ---- editor (Monaco) ----
    editorRect: (match, opts = {}) => ev(([m, o]) => window.__rec.editor.rect(m, o), [match, opts]),

    // ---- zoom and highlight ----
    // Zoom (in post) to a locator, a rectangle, a CSS selector or text=..., until unfocus().
    // opts.zoom caps it.
    async focus(target, opts = {}) {
      const r = await rectOf(target);
      h.log('focus', opts.zoom ? { ...r, zoom: opts.zoom } : r);
      return r;
    },
    async focusTerm(match, opts = {}) { return h.focus(await h.termRect(match, opts), opts); },
    unfocus() { h.log('unfocus'); },
    // A box drawn on the page itself (captured, and zoomed with the content).
    // opts: a padding, or {pad, shape: 'rect' | 'circle' | 'pill', glow: true | 'bare'}.
    async mark(target, color = '#d4380d', opts = 8) {
      const t = await resolve(target, typeof opts === 'number' ? opts : opts?.pad ?? 8);
      await ev(([x, c, o]) => { window.__rec.mark(x, c, o); }, [t, color, opts]);
    },
    unmark: () => ev(() => window.__rec.unmark()),
    // ---- pointer (the drawn cursor; headless Chrome draws none of its own) ----
    cursor: (on) => ev((o) => (o ? window.__rec.show() : window.__rec.hide()), on),
    // Glide the cursor onto a target: a Playwright locator, a CSS selector, "text=…", or [x, y].
    async point(target, ms = 900) {
      let t = target;
      if (target && typeof target.boundingBox === 'function') {
        const b = await target.first().boundingBox({ timeout: 10000 });
        if (!b) throw new Error('point: target not visible');
        t = [b.x + b.width / 2, b.y + b.height / 2];
      }
      await ev(([x, m]) => window.__rec.move(x, m), [t, ms]);
    },
    // Point at a target, then click it with a real (trusted) click, and show the ripple.
    async tap(target, { ms = 900, after = 500 } = {}) {
      const loc = typeof target === 'string' ? page.locator(target).first() : target.first();
      await h.point(loc, ms);
      await sleep(170);
      await ev(() => window.__rec.ripple());
      await loc.click();
      await sleep(after);
    },
    // Eased scroll of the page (or of an element, by selector) by dy CSS px.
    scroll: (dy, { target = 'window', ms = 1400 } = {}) => ev(([t, d, m]) => window.__rec.scroll(t, d, m), [target, dy, ms]),
    // A file in the project as a URL, for h.goto: h.fileUrl('panels/card.html', {title: 'Hello'}).
    fileUrl(rel, params = {}) {
      const u = pathToFileURL(path.resolve(project.root, rel));
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      return u.href;
    },

    // ---- files, off camera ----
    // Paths are relative to the project. Snapshot files now; they are restored when the take ends,
    // however it ends.
    guardFiles(...files) {
      for (const f of files.flat().map(sceneFolder)) if (!guarded.has(f)) guarded.set(f, fs.readFileSync(f));
    },
    restoreFiles() { for (const [f, b] of guarded) fs.writeFileSync(f, b); },
    closeTerminal,
    // Replace exact strings in a file, keeping its line endings.
    editFile(rel, pairs) {
      const file = sceneFolder(rel);
      let b = fs.readFileSync(file, 'utf8');
      const crlf = b.includes('\r\n');
      for (const [from, to] of pairs) {
        const f = crlf ? from.replace(/\r?\n/g, '\r\n') : from;
        const t = crlf ? to.replace(/\r?\n/g, '\r\n') : to;
        if (b.split(f).length !== 2) throw new Error(`editFile: "${from}" must occur exactly once in ${file}`);
        b = b.replace(f, () => t);   // a function, so "$&" and the like in `to` stay literal
      }
      fs.writeFileSync(file, b);
    },
  };
  h.vscode = vscodeHelpers(h);
  h.terminal = {
    async open(folder, { fontSize = 24, padding = 30 } = {}) {
      closeTerminal();
      const cwd = sceneFolder(folder);
      if (!fs.statSync(cwd).isDirectory()) throw new Error(`terminal.open: not a folder: ${cwd}`);
      const rc = path.join(project.root, 'vscode', 'shell.bashrc');
      if (!fs.existsSync(rc)) throw new Error(`terminal.open: missing ${rc}`);
      const shell = process.platform === 'win32' ? gitBash() : '/bin/bash';
      if (!shell || !fs.existsSync(shell)) throw new Error('terminal.open: bash not found (install Git Bash on Windows)');
      if (!terminalBindings) {
        await page.exposeBinding('__ghostcastTerminalInput', (_, data) => terminalPty?.write(data));
        terminalBindings = true;
      }
      await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body><main id="terminal"></main></body></html>');
      await page.addStyleTag({ path: path.join(XTERM, 'css', 'xterm.css') });
      await page.addStyleTag({ content: `
        html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #fff; }
        #terminal { box-sizing: border-box; width: 100vw; height: 100vh; padding: ${padding}px; }
        .xterm { height: 100%; }
      ` });
      await page.addScriptTag({ path: path.join(XTERM, 'lib', 'xterm.js') });
      const size = await page.evaluate(({ fontSize }) => {
        const host = document.getElementById('terminal');
        const probe = document.createElement('span');
        probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${fontSize}px 'Cascadia Mono',Consolas,Menlo,'DejaVu Sans Mono',monospace;`;
        probe.textContent = 'W'.repeat(100);
        host.appendChild(probe);
        const cellWidth = probe.getBoundingClientRect().width / 100;
        const cellHeight = fontSize * 1.25;
        probe.remove();
        const style = getComputedStyle(host);
        const cols = Math.max(2, Math.floor((host.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)) / cellWidth));
        const rows = Math.max(2, Math.floor((host.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / cellHeight));
        const term = new Terminal({
          cols, rows, fontSize, lineHeight: 1.25,
          fontFamily: "'Cascadia Mono', Consolas, Menlo, 'DejaVu Sans Mono', monospace",
          cursorBlink: false, scrollback: 1000,
          theme: { background: '#ffffff', foreground: '#24292f', cursor: '#555555', selectionBackground: '#c8ddf5' },
        });
        term.open(host);
        term.onData((data) => window.__ghostcastTerminalInput(data));
        term.focus();
        window.__ghostcastTerminal = term;
        return { cols, rows };
      }, { fontSize });
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        !/^(CLAUDE|ANTHROPIC|OPENAI|CODEX)/.test(key) && key !== 'PROMPT_COMMAND'));
      env.TERM = 'xterm-256color';
      terminalPty = pty.spawn(shell, ['--rcfile', rc.replace(/\\/g, '/'), '-i'], {
        name: 'xterm-256color', cols: size.cols, rows: size.rows, cwd, env,
      });
      terminalData = terminalPty.onData((data) => {
        terminalOutput = terminalOutput.then(() => page.evaluate((chunk) => window.__ghostcastTerminal?.write(chunk), data)).catch(() => {});
      });
      await inject(page, { cursor: false });   // a terminal take has no use for a pointer
      await page.evaluate(() => window.__rec.heartbeat(true));
      await h.prompt({ timeout: 30000 });
    },
  };
  return h;
}

// ---- VS Code in the browser (`code serve-web`; see `ghostcast vscode`) ----
function vscodeHelpers(h) {
  const { page } = h;
  const cfg = h.config.vscode || {};
  const v = {
    // Run a command through the palette (F1). Keybindings are unreliable here: with the terminal
    // focused, Ctrl+B and the like can go to the shell instead of the workbench.
    async command(name) {
      await page.keyboard.press('F1');
      await page.waitForSelector('.quick-input-widget input', { state: 'visible', timeout: 10000 });
      await page.keyboard.type(name);
      await sleep(400);
      await page.keyboard.press('Enter');
      await sleep(600);
    },
    panelMaximized: () => page.evaluate(() => {
      const p = document.querySelector('.part.panel')?.getBoundingClientRect();
      return !!p && p.height > innerHeight * 0.9;
    }),

    // Open a folder with a fresh, cleared terminal. sidebar:false hides both side bars so the
    // terminal gets the full width; maximize:true (default) gives the panel the whole window.
    async open(folder, { sidebar = true, maximize = true } = {}) {
      const tokenFile = path.resolve(h.project.root, cfg.tokenFile || 'vscode/token');
      if (!fs.existsSync(tokenFile)) throw new Error(`no ${tokenFile}: start VS Code first (ghostcast vscode)`);
      const token = fs.readFileSync(tokenFile, 'utf8').trim();
      // serve-web takes a Windows folder as /c:/Users/…
      const folderPath = path.resolve(h.world?.dir || h.project.root, folder || '.');
      assertOutsideSource(folderPath, h.world?.source);
      const abs = folderPath.replace(/\\/g, '/');
      const param = /^[A-Za-z]:\//.test(abs) ? '/' + abs[0].toLowerCase() + abs.slice(1) : abs;
      const url = `${cfg.url || 'http://127.0.0.1:8765'}/?tkn=${token}&folder=${encodeURIComponent(param)}`;
      // The workbench, or its first terminal, occasionally fails to come up: when takes run back to
      // back, and on a server's first start while it is still unpacking. One reload has always
      // been enough.
      for (let attempt = 1; ; attempt++) {
        try {
          await page.goto(url);
          await page.waitForSelector('.monaco-workbench', { timeout: 45000 });
          await inject(page);
          await sleep(2500);
          await page.keyboard.press('Control+Backquote');
          // Workspace trust is a user-scope setting the web client keeps in the browser profile, so
          // a new profile asks once; the persistent profile remembers the answer.
          const trust = page.getByRole('button', { name: 'Trust Folder & Continue' });
          if (await trust.isVisible({ timeout: 4000 }).catch(() => false)) await trust.click();
          await page.waitForSelector('.xterm-rows', { timeout: 30000 });
          await page.evaluate(() => window.__rec.term.prompt({ timeout: 30000 }));
          break;
        } catch (e) {
          if (attempt >= 2) throw e;
          console.error(`vscode.open: ${e.message.split('\n')[0]}; reloading once`);
        }
      }
      if (!sidebar) {
        // The profile remembers layout between runs, so act only on what is actually showing.
        const width = (sel) => page.evaluate((s) => document.querySelector(s)?.getBoundingClientRect().width || 0, sel);
        if (await width('.part.sidebar')) await v.command('View: Close Primary Side Bar');
        if (await width('.part.auxiliarybar')) await v.command('View: Hide Secondary Side Bar');
      }
      // Panel size is remembered too, so a take could start with whatever the last one left.
      if (maximize && !(await v.panelMaximized())) await v.command('View: Toggle Maximized Panel');
      await v.focusTerminal();
      await v.clearTerm();
      await page.evaluate(() => { window.__rec.hide(); window.__rec.heartbeat(true); });
    },

    // Keyboard focus into a terminal pane (0 = leftmost); the terminal helpers follow it.
    async focusTerminal(pane = 0) {
      const screens = page.locator('.xterm-screen');
      const boxes = [];
      for (let i = 0; i < await screens.count(); i++) {
        const b = await screens.nth(i).boundingBox();
        if (b && b.width > 0) boxes.push({ i, x: b.x });
      }
      boxes.sort((a, b) => a.x - b.x);
      await screens.nth(boxes[Math.min(pane, boxes.length - 1)].i).click({ position: { x: 40, y: 20 } });
      await h.useTerm(pane);
      // xterm takes focus a beat after the click; a key sent sooner is dropped.
      await page.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea'), null, { timeout: 5000 });
      await sleep(450);
    },
    // Through the palette: Ctrl+L reaches the shell only when the terminal has focus, and in an
    // editor it selects a line instead.
    async clearTerm() { await v.command('Terminal: Clear'); await sleep(300); },

    async openFile(rel) {
      await page.keyboard.press('Control+p');
      await page.waitForSelector('.quick-input-widget input', { state: 'visible', timeout: 10000 });
      await page.keyboard.type(rel);
      await sleep(700);
      await page.keyboard.press('Enter');
      await sleep(900);
    },
    // Keyboard focus into an editor, counted top to bottom, then left to right (by its on-screen
    // box — .view-lines moves with scrolling and cannot be used to order or click editors).
    async focusEditor(i = 0) {
      const box = await page.evaluate((k) => {
        const eds = [...document.querySelectorAll('.editor-group-container .monaco-editor')]
          .filter((e) => { const r = e.getBoundingClientRect(); return r.height > 0 && r.width > 0 && !e.closest('.quick-input-widget'); })
          .sort((a, b) => { const p = a.getBoundingClientRect(), q = b.getBoundingClientRect(); return p.top - q.top || p.left - q.left; });
        const r = eds[k]?.getBoundingClientRect();
        return r && { x: r.left + 140, y: r.top + 20 };
      }, i);
      if (!box) throw new Error('focusEditor: no editor ' + i);
      await page.mouse.click(box.x, box.y);
      await sleep(300);
    },
    // Go to Line (Ctrl+G) in an editor; spec is "line" or "line:column" (a large column = line end).
    async gotoLine(spec, { editor = 0 } = {}) {
      await v.focusEditor(editor);
      await page.keyboard.press('Control+g');
      await page.waitForSelector('.quick-input-widget input', { state: 'visible', timeout: 10000 });
      await page.keyboard.type(String(spec));
      await sleep(300);
      await page.keyboard.press('Enter');
      await sleep(400);
    },
    // Bottom panel height in CSS px, by dragging the sash across its top edge.
    async resizePanel(height) {
      const r = await page.evaluate(() => {
        const p = document.querySelector('.part.panel')?.getBoundingClientRect();
        if (!p) return null;
        const sash = [...document.querySelectorAll('.monaco-sash.horizontal')]
          .map((s) => s.getBoundingClientRect())
          .filter((s) => s.width > p.width * 0.5 && Math.abs(s.top + s.height / 2 - p.top) < 8)[0];
        return sash && { y: sash.top + sash.height / 2, x: sash.left + sash.width / 2, bottom: p.bottom };
      });
      if (!r) throw new Error('resizePanel: no panel sash');
      const target = r.bottom - height;
      await page.mouse.move(r.x, r.y);
      await sleep(200);
      await page.mouse.down();
      for (let k = 1; k <= 12; k++) { await page.mouse.move(r.x, r.y + ((target - r.y) * k) / 12); await sleep(16); }
      await page.mouse.up();
      await sleep(400);
    },
  };
  return v;
}

// Record one take: run the scene's setup, then capture its default export.
export async function record(project, sceneFile, take, { headed = false, world = null } = {}) {
  if (world) world.reset();
  const scene = await import(pathToFileURL(path.resolve(project.root, sceneFile)).href);
  const dir = path.join(project.root, 'raw', take);
  const log = [];
  const { ctx, page } = await launch(project, { headed, world });
  const h = makeHelpers(project, page, log, world);
  let ok = false;
  // When a take fails, the page as it stood is the fastest way to see why.
  const snap = async (name) => {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    await page.screenshot({ path: file }).then(() => console.error(`screenshot of the failure: ${file}`), () => {});
  };
  try {
    fs.rmSync(path.join(dir, 'setup-failed.png'), { force: true });
    if (scene.setup) await scene.setup(h).catch(async (e) => { await snap('setup-failed.png'); throw e; });
    await inject(page);
    log.length = 0;
    h.log('viewport', await page.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })));
    await page.evaluate(() => window.__rec.heartbeat(true));
    const stop = await startCapture(project, page, dir);
    await sleep(500);
    try {
      await scene.default(h);
      ok = true;
    } catch (e) {
      await snap('failed.png');
      throw e;
    } finally {
      await sleep(800);
      const frames = await stop();
      fs.writeFileSync(path.join(dir, 'log.json'), JSON.stringify(log, null, 1));
      const segs = log.filter((e) => /^[+-]/.test(e[1])).length / 2;
      console.log(`${take}: ${frames} frames, ${segs} segments${ok ? '' : ' (scene failed)'} -> ${dir}`);
    }
  } finally {
    h.closeTerminal();
    h.restoreFiles();
    if (scene.teardown) await scene.teardown(h).catch((e) => console.error('teardown:', e.message));
    await ctx.close();
  }
  return ok;
}

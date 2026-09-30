import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { words } from './lint.mjs';
import { parseTarget } from './target.mjs';

const QUOTED = /^(?:text|row|line|role|label|css)\s+/;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const firstVisible = async (locator) => {
  for (let i = 0; i < await locator.count(); i++) if (await locator.nth(i).isVisible().catch(() => false)) return locator.nth(i);
  return null;
};
const visible = async (locator, timeout) => {
  const start = Date.now();
  do {
    const found = await firstVisible(locator);
    if (found) return found;
    await delay(150);
  } while (Date.now() - start < timeout);
  throw new Error('target not visible');
};
const locator = (page, target) => {
  switch (target.kind) {
    case 'text': return page.getByText(target.value);
    case 'role': return page.getByRole(target.role, { name: target.value, exact: true });
    case 'label': return page.getByLabel(target.value, { exact: true });
    case 'css': return page.locator(target.value);
    default: return null;
  }
};
const rows = (value) => new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

export async function targetVisible(h, source, timeout = 15000) {
  const target = parseTarget(source);
  if (target.kind === 'row') {
    try {
      await h.waitFor(rows(target.value), timeout);
      return { target, rect: await h.termRect(target.value) };
    } catch { throw new Error(`show target ${source} never appeared on ${h.page.url()}`); }
  }
  if (target.kind === 'line') {
    const started = Date.now();
    let rect;
    while (Date.now() - started < timeout) {
      try { rect = await h.editorRect(target.value); if (rect) break; } catch {}
      await h.sleep(150);
    }
    if (!rect) throw new Error(`show target ${source} never appeared`);
    return { target, rect };
  }
  try { return { target, element: await visible(locator(h.page, target), timeout) }; }
  catch { throw new Error(`show target ${source} never appeared on ${h.page.url()}`); }
}

export async function enter(h, beat, previous) {
  if (beat.surface === 'web' && beat.open) {
    const open = beat.open;
    const url = /^(?:https?:|file:)/i.test(open) ? open : open.startsWith('/')
      ? h.world.url(h.config.world.services.find((item) => item.port).name, open)
      : pathToFileURL(path.resolve(h.world?.dir || h.project.root, open)).href;
    await h.goto(url);
  } else if (beat.surface === 'terminal' && (previous?.surface !== 'terminal' || beat.open !== undefined)) {
    await h.terminal.open(beat.open);
  } else if (beat.surface === 'editor' && (previous?.surface !== 'editor' || beat.open !== undefined)) {
    const root = h.world?.dir || h.project.root;
    const opened = beat.open && path.resolve(root, beat.open);
    const isFile = opened && fs.statSync(opened, { throwIfNoEntry: false })?.isFile();
    const relative = isFile ? path.relative(root, opened) : null;
    if (relative && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)))
      throw new Error(`editor file must be inside the world copy: ${beat.open}`);
    try {
      if (isFile) {
        await h.vscode.open('.', { sidebar: false, maximize: false });
        await h.vscode.openFile(relative.replace(/\\/g, '/'));
        await h.vscode.command('View: Close Panel');
      } else await h.vscode.open(beat.open);
    } catch (error) {
      throw new Error(`run ghostcast vscode --accept-server-license-terms from the project's root after reading the VS Code Server license: ${error.message}`);
    }
  } else if (beat.surface === 'panel') {
    const panel = beat.panel;
    if (panel.use) {
      const template = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../templates/project/panels/card.html');
      const u = pathToFileURL(template);
      for (const [key, value] of Object.entries({ title: panel.title, sub: panel.subtitle, foot: panel.foot, kind: panel.use, hold: 1 }))
        if (value !== undefined) u.searchParams.set(key, value);
      await h.goto(u.href, { cursor: false });
    } else await h.goto(h.fileUrl(panel.html, panel.data || {}), { cursor: false });
  }
}

async function clickTarget(h, source, timeout = 10000) {
  if (QUOTED.test(source)) {
    try {
      const found = await targetVisible(h, source, timeout);
      const element = found.element || h.page.locator(found.target.kind === 'row' ? '.xterm-rows > div' : '.view-line')
        .filter({ hasText: found.target.value }).last();
      return element;
    } catch { throw new Error(`click target ${source} never appeared on ${h.page.url()}`); }
  }
  const page = h.page;
  const candidates = [
    ...['button', 'link', 'menuitem', 'tab', 'option', 'checkbox', 'radio'].map((role) => page.getByRole(role, { name: source, exact: true })),
    page.getByLabel(source, { exact: true }), page.getByText(source, { exact: true }),
  ];
  const start = Date.now();
  do {
    for (const candidate of candidates) {
      const found = await firstVisible(candidate);
      if (found) return found;
    }
    await delay(150);
  } while (Date.now() - start < timeout);
  throw new Error(`click target "${source}" never appeared on ${page.url()}`);
}

async function fillTarget(h, name, timeout = 10000) {
  const page = h.page;
  const candidates = [page.getByLabel(name, { exact: true }), page.getByPlaceholder(name, { exact: true }), page.getByRole('textbox', { name, exact: true })];
  let found;
  const start = Date.now();
  do {
    for (const candidate of candidates) { found = await firstVisible(candidate); if (found) break; }
    if (found) break;
    await delay(150);
  } while (Date.now() - start < timeout);
  if (!found) throw new Error(`fill target "${name}" never appeared on ${page.url()}`);
  return found;
}

const inside = (outer, inner) => inner.x >= outer.x && inner.y >= outer.y
  && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
const overlap = (a, b) => {
  const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const intersection = w * h;
  return intersection / (a.w * a.h + b.w * b.h - intersection);
};

async function actionsInside(h, actions, frame) {
  for (const action of actions) {
    let elements;
    try {
      if (action.click) elements = [await clickTarget(h, action.click, 0)];
      else if (action.fill) elements = await Promise.all(Object.keys(action.fill).map((name) => fillTarget(h, name, 0)));
      else if (action.press || action.wait !== undefined) continue;
      else return false;
      for (const element of elements) if (!inside(frame, await h.rect(element))) return false;
    } catch { return false; }
  }
  return true;
}

async function frame(h, target) {
  const next = await h.rect(target);
  if (h.storyboardFrame && overlap(h.storyboardFrame, next) > 0.8) return h.storyboardFrame;
  h.storyboardFrame = await h.focus(target);
  await h.sleep(800);
  return h.storyboardFrame;
}

async function follow(h, target) {
  h.storyboardFrame = await h.focus(target);
  await h.sleep(800);
}

async function showText(h, found) {
  const { kind, value } = found.target;
  if (kind === 'row') return h.page.evaluate((match) => window.__rec.term.rows().filter((row) => row.includes(match)).at(-1) || '', value);
  if (kind === 'line') return h.page.evaluate((match) => {
    const editor = window.__rec.editor.list()[0];
    const box = editor?.getBoundingClientRect();
    const lines = [...(editor?.querySelectorAll('.view-lines .view-line') || [])]
      .filter((line) => { const rect = line.getBoundingClientRect(); return rect.bottom > box.top && rect.top < box.bottom; })
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    return lines.find((line) => line.textContent.replace(/\u00a0/g, ' ').includes(match))?.textContent.replace(/\u00a0/g, ' ') || '';
  }, value);
  return found.element.innerText();
}

export async function perform(h, beat, code = {}) {
  const actions = beat.do || [];
  if (h.storyboardFrame && (beat.camera === 'wide' || (actions.length && beat.camera !== 'follow'
    && !(await actionsInside(h, actions, h.storyboardFrame))))) {
    h.unfocus();
    h.storyboardFrame = null;
    await h.sleep(800);
  }
  if (beat.surface === 'panel') await h.page.evaluate(() => window.play?.());
  if (beat.script) {
    const script = await import(pathToFileURL(path.resolve(h.project.root, beat.script)).href);
    await script.default(h);
    await h.ensureDriver({ cursor: beat.surface === 'web' });
  }
  for (const [index, action] of actions.entries()) {
    if (action.click) {
      const element = await clickTarget(h, action.click);
      if (beat.camera === 'follow') await follow(h, element);
      await h.tap(element);
    } else if (action.fill) {
      for (const [name, value] of Object.entries(action.fill)) {
        const element = await fillTarget(h, name);
        if (beat.camera === 'follow') await follow(h, element);
        await h.tap(element);
        await h.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
        await h.type(value);
      }
    } else if (action.press) await h.press(action.press);
    else if (action.run) {
      const cmd = typeof action.run === 'string' ? action.run : action.run.cmd;
      const expect = typeof action.run === 'string' ? 0 : action.run.expect || 0;
      await h.run(cmd, { timeout: Math.max(60000, expect * 3000) });
    } else if (action.wait !== undefined) {
      if (typeof action.wait === 'number') await h.sleep(action.wait * 1000);
      else await targetVisible(h, action.wait);
    } else if (action.code) await code[`${beat.id}:${index}`](h, h.page);
    await h.ensureDriver({ cursor: beat.surface === 'web' });
  }
  let metric = null;
  let found = null;
  let show = null;
  if (beat.show) {
    found = await targetVisible(h, beat.show);
    const fontSize = found.element ? await found.element.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
      : await h.page.locator(found.target.kind === 'row' ? '.xterm-rows' : '.view-lines').first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize)).catch(() => null);
    show = { text: String(await showText(h, found)).trim().slice(0, 200), rect: await h.rect(found.element || found.rect) };
    metric = { visible: true, fontSize, rect: show.rect, focused: beat.camera !== 'wide' };
  }
  if (beat.camera !== 'wide') {
    const target = beat.camera && beat.camera !== 'follow' ? await targetVisible(h, beat.camera) : found;
    if (target) await frame(h, target.element || target.rect);
  }
  if (show) h.log('show', show);
  const policy = h.config.direction || {};
  const narration = words(beat.say) / (h.config.voiceover?.wordsPerSecond || 2.5);
  const reading = (policy.readingBase ?? 0.5) + words(show?.text) / (policy.readingWordsPerSecond ?? 3);
  const holdMs = h.rehearsal ? 300 : (Math.max(narration, reading, policy.minHold ?? 1.5) * (policy.captureHold ?? 1.5) + 1) * 1000;
  h.log('hold', { beat: beat.id });
  try { await h.sleep(holdMs); }
  finally { h.log('holdend'); }
  return metric;
}

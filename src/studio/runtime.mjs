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
    try { await h.vscode.open(beat.open); }
    catch (error) { throw new Error(`run ghostcast vscode first: ${error.message}`); }
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

async function click(h, source) {
  if (QUOTED.test(source)) {
    try {
      const found = await targetVisible(h, source, 10000);
      const element = found.element || h.page.locator(found.target.kind === 'row' ? '.xterm-rows > div' : '.view-line')
        .filter({ hasText: found.target.value }).last();
      await h.tap(element);
    } catch { throw new Error(`click target ${source} never appeared on ${h.page.url()}`); }
    return;
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
      if (found) { await h.tap(found); return; }
    }
    await delay(150);
  } while (Date.now() - start < 10000);
  throw new Error(`click target "${source}" never appeared on ${page.url()}`);
}

async function fill(h, fields) {
  for (const [name, value] of Object.entries(fields)) {
    const page = h.page;
    const candidates = [page.getByLabel(name, { exact: true }), page.getByPlaceholder(name, { exact: true }), page.getByRole('textbox', { name, exact: true })];
    let found;
    const start = Date.now();
    do {
      for (const candidate of candidates) { found = await firstVisible(candidate); if (found) break; }
      if (found) break;
      await delay(150);
    } while (Date.now() - start < 10000);
    if (!found) throw new Error(`fill target "${name}" never appeared on ${page.url()}`);
    await h.tap(found);
    await h.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await h.type(value);
  }
}

export async function perform(h, beat, code = {}) {
  const start = Date.now();
  if (beat.surface === 'panel') await h.page.evaluate(() => window.play?.());
  if (beat.script) {
    const script = await import(pathToFileURL(path.resolve(h.project.root, beat.script)).href);
    await script.default(h);
  }
  for (const [index, action] of (beat.do || []).entries()) {
    if (action.click) await click(h, action.click);
    else if (action.fill) await fill(h, action.fill);
    else if (action.press) await h.press(action.press);
    else if (action.run) {
      const cmd = typeof action.run === 'string' ? action.run : action.run.cmd;
      const expect = typeof action.run === 'string' ? 0 : action.run.expect || 0;
      await h.run(cmd, { timeout: Math.max(60000, expect * 3000) });
    } else if (action.wait !== undefined) {
      if (typeof action.wait === 'number') await h.sleep(action.wait * 1000);
      else await targetVisible(h, action.wait);
    } else if (action.code) await code[`${beat.id}:${index}`](h, h.page);
  }
  let metric = null;
  if (beat.show) {
    const found = await targetVisible(h, beat.show);
    const fontSize = found.element ? await found.element.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
      : await h.page.locator(found.target.kind === 'row' ? '.xterm-rows' : '.view-lines').first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize)).catch(() => null);
    const rect = beat.camera === 'wide' ? found.rect || await found.element.boundingBox() : await h.focus(found.element || found.rect);
    metric = { visible: true, fontSize, rect, focused: beat.camera !== 'wide' };
  }
  const wps = h.config.voiceover?.wordsPerSecond || 2.5;
  const hold = Math.max(words(beat.say) / wps * 1000 + 500 - (Date.now() - start), 1500);
  await h.sleep(hold);
  if (metric?.focused) h.unfocus();
  return metric;
}

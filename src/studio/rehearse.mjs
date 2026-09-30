import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareWorld } from '../world.mjs';
import { inject, launch, makeHelpers } from '../recorder.mjs';
import { view_track } from '../post/logic.mjs';
import { estimateBeat } from './lint.mjs';
import { compile } from './compile.mjs';
import { storyboardHash } from './approve.mjs';

const oneLine = (error) => (error?.message || String(error)).split('\n')[0];
const timeout = (work, ms) => {
  let timer;
  return Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`beat timed out after ${Math.ceil(ms / 1000)} s`)), ms); })])
    .finally(() => clearTimeout(timer));
};

function outputTextPx(metric, config) {
  if (!metric?.fontSize || !metric.rect) return null;
  const { width, height, dpr } = config.viewport;
  const zoom = metric.focused ? width * dpr / view_track([[0, 'focus', metric.rect]], width * dpr, height * dpr, dpr, config).at(-1)[1][2] : 1;
  return metric.fontSize * zoom * (config.output.width / width);
}

export async function rehearse(project, { ids = [], runs = 3, headed = false } = {}) {
  const { story } = compile(project);
  if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs must be a positive integer');
  for (const id of ids) if (!story.beats.some((beat) => beat.id === id)) throw new Error(`unknown beat id: ${id}`);
  const last = ids.length ? Math.max(...ids.map((id) => story.beats.findIndex((beat) => beat.id === id))) : story.beats.length - 1;
  const selected = story.beats.slice(0, last + 1);
  const scene = await import(pathToFileURL(path.join(project.root, 'cache', 'storyboard.mjs')).href + `?rehearse=${Date.now()}`);
  const hash = storyboardHash(project.root);
  const dir = path.join(project.root, 'cache', 'rehearsal');
  fs.mkdirSync(dir, { recursive: true });
  const entries = selected.map((beat) => ({ id: beat.id, status: 'unreached', passes: 0, reached: 0, errors: [], ms: Array(runs).fill(null), textPx: null, warnings: [], show: Array(runs).fill(null) }));
  let world, untouched = true, fatal = null;
  try {
    world = await prepareWorld(project);
    for (let run = 0; run < runs; run++) {
      world?.reset();
      let ctx, h, page;
      const log = [];
      try {
        ({ ctx, page } = await launch(project, { headed, world }));
        h = makeHelpers(project, page, log, world);
        h.rehearsal = true;
        for (let i = 0; i < selected.length; i++) {
          const entry = entries[i], beat = selected[i], start = Date.now();
          entry.reached++;
          try {
            const estimate = estimateBeat(beat, project.config.voiceover?.wordsPerSecond || 2.5).seconds;
            const metric = await timeout((async () => {
              if (i === 0) { await scene.setup(h); await inject(page); }
              else await scene.beats[i].enter(h, story.beats[i - 1]);
              return scene.beats[i].run(h);
            })(), Math.max(120000, estimate * 3000));
            entry.passes++;
            if (beat.show) entry.show[run] = { visible: !!metric?.visible, fontSize: metric?.fontSize ?? null, rect: metric?.rect ?? null };
            const px = outputTextPx(metric, project.config);
            if (px !== null) entry.textPx = entry.textPx === null ? px : Math.min(entry.textPx, px);
          } catch (error) {
            const message = oneLine(error);
            if (beat.show && /show target .* never appeared/.test(message)) entry.show[run] = { visible: false, fontSize: null, rect: null };
            if (!entry.errors.includes(message)) entry.errors.push(message);
            const shot = path.join(dir, `${run + 1}-${beat.id}.png`);
            await page.screenshot({ path: shot }).catch(() => {});
            entry.ms[run] = Date.now() - start;
            break;
          }
          entry.ms[run] = Date.now() - start;
        }
      } catch (error) {
        fatal = oneLine(error);
        const entry = entries[0];
        if (!entry.reached) entry.reached++;
        if (!entry.errors.includes(fatal)) entry.errors.push(fatal);
      } finally {
        try { h?.closeTerminal(); h?.restoreFiles(); }
        catch (error) { fatal ||= oneLine(error); }
        finally { if (ctx) await ctx.close().catch((error) => { fatal ||= oneLine(error); }); }
      }
    }
  } catch (error) { fatal = oneLine(error); }
  finally { if (world) untouched = await world.dispose(); }
  // A beat that passed every time it ran, but not in every run because an earlier beat stopped one,
  // is unconfirmed rather than flaky: the fault is upstream.
  for (const entry of entries) {
    entry.status = entry.reached === 0 ? 'unreached' : entry.passes === runs ? 'pass'
      : entry.passes === entry.reached ? 'unconfirmed' : entry.passes === 0 ? 'fail' : 'flaky';
    if (entry.textPx !== null && entry.textPx < 16) entry.warnings.push('small-text');
    if (entry.textPx !== null) entry.textPx = Math.round(entry.textPx * 10) / 10;
  }
  const report = { storyboardHash: hash, at: new Date().toISOString(), runs, partial: selected.length < story.beats.length,
    servicesRestarted: false, beats: entries };
  fs.writeFileSync(path.join(project.root, 'cache', 'rehearsal.json'), JSON.stringify(report, null, 2) + '\n');
  const passing = entries.filter((entry) => entry.status === 'pass').length;
  console.log(`rehearse · ${passing} of ${entries.length} beats pass (${runs} runs)`);
  console.log('  each run starts from a fresh copy of the source; services keep running between runs');
  for (const entry of entries) {
    if (entry.status === 'unconfirmed') console.log(`  ? ${entry.id.padEnd(8)} unconfirmed (reached in ${entry.reached} of ${runs}, passed each time)`);
    else if (entry.status !== 'pass') console.log(`  ✗ ${entry.id.padEnd(8)} ${entry.status} (${entry.passes} of ${runs})${entry.errors.length ? `: ${entry.errors.join('; ')}` : ''}`);
    if (entry.warnings.includes('small-text')) console.log(`  ! ${entry.id.padEnd(8)} small text: ${Math.round(entry.textPx)} px in the output`);
  }
  if (!untouched) console.error('source changed during rehearsal');
  if (fatal) console.error(fatal);
  return passing === entries.length && untouched && !fatal ? 0 : 1;
}

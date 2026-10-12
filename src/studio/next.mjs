import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { lint } from './lint.mjs';
import { storyboardHash } from './approve.mjs';
import { parseYaml, readBrief, validateBrief, validateProduct } from './schema.mjs';
import { currentConfirmation } from './confirm.mjs';

const result = (stage, state, next, problems = [], warnings = 0) => ({ stage, state, problems, next, warnings });
const read = (file) => fs.readFileSync(file, 'utf8');
const warningSuffix = (count) => count ? `, ${count} warning${count === 1 ? '' : 's'}` : '';
const issue = (problem) => ({ ...(problem.id ? { id: problem.id } : {}), message: `${problem.path ? `${problem.path}: ` : ''}${problem.message}` });
const fileHash = (file) => fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;

function postShoot(dir, story, currentHash, warnings, rehearsalProblems = []) {
  const take = 'storyboard', raw = path.join(dir, 'raw', take), log = path.join(raw, 'log.json');
  const source = path.join(raw, 'source.json'), clipMeta = path.join(dir, 'clips', `${take}.json`);
  const clipVideo = path.join(dir, 'clips', `${take}.mp4`);
  const silent = path.join(dir, 'out', `${story.video || 'screencast'}-silent.mp4`);
  let sourceHash;
  try { sourceHash = JSON.parse(read(source)).storyboardHash; } catch {}
  const rawMtime = fs.existsSync(log) ? fs.statSync(log).mtimeMs : Infinity;
  const fresh = (file) => fs.existsSync(file) && fs.statSync(file).mtimeMs > rawMtime;
  const shot = sourceHash === currentHash && fs.existsSync(log) && fs.existsSync(clipMeta) && fs.existsSync(clipVideo)
    && fresh(clipMeta) && fresh(clipVideo) && fresh(silent);
  if (!shot) return result('shoot', 'the approved storyboard has not been shot and assembled yet', 'shoot it with `ghostcast all`', rehearsalProblems, warnings);

  let checks;
  try { checks = JSON.parse(read(path.join(dir, 'cache', 'checks.json'))); } catch {}
  const timeline = (() => { try { return JSON.parse(read(path.join(dir, 'timeline.json'))); } catch { return { items: [{ take }] }; } })();
  const currentCut = Object.fromEntries((timeline.items || []).map((item) => [item.take, fileHash(path.join(dir, 'clips', `${item.take}.json`))]));
  const cutIsCurrent = isDeepStrictEqual(checks?.cut, currentCut) && checks?.cut?.[take] === fileHash(clipMeta);
  const checkWarnings = (checks?.problems || []).filter((problem) => problem.level === 'warning')
    .map((problem) => ({ id: problem.segment || problem.take, message: `warning: ${problem.check}: ${problem.message}` }));
  if (!cutIsCurrent || checks.errors > 0) {
    const errors = (checks?.problems || []).filter((problem) => problem.level === 'error');
    const problems = errors.slice(0, 8).map((problem) => ({ id: problem.segment || problem.take, message: `${problem.check}: ${problem.message}` }));
    if (errors.length > 8) problems.push({ message: `and ${errors.length - 8} more` });
    if (!cutIsCurrent && !errors.length) problems.push({ message: 'checks are missing or for an older cut' });
    return result('check', checks?.errors ? `${checks.errors} check error${checks.errors === 1 ? '' : 's'}${warningSuffix(checks.warnings || 0)}` : 'checks are missing or stale',
      checks?.errors ? 'fix these, shoot again, then run `ghostcast check`' : 'run `ghostcast check` for the current cut', [...problems, ...checkWarnings], checks?.warnings || warnings);
  }

  const beats = story.beats.map((beat) => beat.id).filter((id) => !currentConfirmation(dir, take, id));
  if (beats.length) return result('confirm', `${beats.length} beat${beats.length === 1 ? '' : 's'} need confirmation${warningSuffix(checks.warnings || 0)}`,
    'run ghostcast review beats, look at each sheet, and confirm what it shows: ' + beats.map((id) => 'ghostcast confirm ' + id + ' "…"').join(', '),
    [...beats.map((id) => ({ id, message: 'needs confirmation for the current take' })), ...checkWarnings], checks.warnings || warnings);
  return result('done', `the silent cut is ready; voice comes next${warningSuffix(checks.warnings || 0)}`, `out/${story.video || 'screencast'}-silent.mp4`, checkWarnings, checks.warnings || warnings);
}

function lintIssue(problem) {
  const location = `${problem.file}${problem.line ? `:${problem.line}` : ''}${problem.path ? ` ${problem.path}` : ''}${problem.id ? ` (${problem.id})` : ''}`;
  return { ...(problem.id ? { id: problem.id } : {}), message: `${problem.level.padEnd(7)}${problem.rule.padEnd(19)}${location}: ${problem.message}` };
}

function storyboardChanges(previous, current) {
  const oldStory = parseYaml(previous, 'storyboard.yaml').data;
  const newStory = parseYaml(current, 'storyboard.yaml').data;
  if (!Array.isArray(oldStory?.beats) || !Array.isArray(newStory?.beats)) return { problems: [{ message: 'storyboard changed since approval' }], mechanicsOnly: false };

  const oldBeats = new Map(oldStory.beats.map((beat) => [beat.id, beat]));
  const newBeats = new Map(newStory.beats.map((beat) => [beat.id, beat]));
  const oldShared = oldStory.beats.map((beat) => beat.id).filter((id) => newBeats.has(id));
  const newShared = newStory.beats.map((beat) => beat.id).filter((id) => oldBeats.has(id));
  const problems = [];
  let mechanicsOnly = true;
  for (const [id, beat] of oldBeats) if (!newBeats.has(id)) { problems.push({ id, message: 'removed beat' }); mechanicsOnly = false; }
  for (const [id, beat] of newBeats) {
    if (!oldBeats.has(id)) { problems.push({ id, message: 'added beat' }); mechanicsOnly = false; continue; }
    if (oldShared.indexOf(id) !== newShared.indexOf(id)) { problems.push({ id, message: 'reordered beat' }); mechanicsOnly = false; }
    const oldBeat = oldBeats.get(id);
    if (!isDeepStrictEqual(oldBeat, beat)) {
      problems.push({ id, message: 'changed beat' });
      const withoutMechanics = (value) => Object.fromEntries(Object.entries(value).filter(([key]) => !['do', 'open', 'wait', 'code', 'script', 'seconds'].includes(key)));
      if (!isDeepStrictEqual(withoutMechanics(oldBeat), withoutMechanics(beat))) mechanicsOnly = false;
    }
  }
  const withoutBeats = ({ beats, ...rest }) => rest;
  if (!isDeepStrictEqual(withoutBeats(oldStory), withoutBeats(newStory))) mechanicsOnly = false;
  if (!problems.length) { problems.push({ message: 'storyboard formatting or comments changed' }); mechanicsOnly = false; }
  if (mechanicsOnly) problems.push({ message: 'only how the beats are performed changed; approval should be quick to ask for' });
  return { problems, mechanicsOnly };
}

function rehearsalResult(report, beatIds, lintWarnings) {
  const entries = Array.isArray(report.beats) ? report.beats : [];
  const passing = entries.filter((beat) => beat.status === 'pass').length;
  const smallText = entries.filter((beat) => beat.warnings?.includes('small-text'));
  const warnings = lintWarnings + smallText.length;
  const state = `${passing} of ${beatIds.length} beats pass${warningSuffix(warnings)}`;
  const problems = entries.filter((beat) => beat.status !== 'pass').map((beat) => {
    let message;
    if (beat.status === 'unconfirmed') message = `unconfirmed (reached in ${beat.reached ?? 0} of ${report.runs ?? '?'}, passed each time)`;
    else if (beat.status === 'unreached') message = `unreached (0 of ${report.runs ?? '?'})`;
    else message = `${beat.status} (${beat.passes ?? 0} of ${report.runs ?? '?'})${beat.errors?.length ? `: ${beat.errors[0]}` : ''}`;
    return { id: beat.id, message };
  });
  for (const beat of smallText) problems.push({ id: beat.id, message: `warning: small text${beat.textPx == null ? '' : `: ${Math.round(beat.textPx)} px in the output`}` });
  if (report.partial) return result('rehearse', `partial rehearsal: ${state}`, 'run `ghostcast rehearse` to confirm every beat', problems, warnings);
  if (passing === beatIds.length && entries.length === beatIds.length && beatIds.every((id, i) => entries[i]?.id === id))
    return result('shoot', `storyboard approved and rehearsed${warningSuffix(warnings)}`, 'shoot it with `ghostcast all`', problems, warnings);
  const failures = entries.filter((beat) => ['fail', 'flaky'].includes(beat.status)).map((beat) => beat.id);
  if (!failures.length) return result('rehearse', state, 'run `ghostcast rehearse` to confirm every beat', problems, warnings);
  return result('rehearse', state, `fix those beats, then run \`ghostcast rehearse ${failures.join(' ')}\``, problems, warnings);
}

export function next(dir) {
  const productFile = path.join(dir, 'product.md');
  if (!fs.existsSync(productFile)) return result('init', 'studio not initialized', "run `ghostcast init` in the project's root");

  const productProblems = validateProduct(read(productFile));
  if (productProblems.length) {
    const missing = [...new Set(productProblems.map((problem) => problem.path || problem.message))];
    return result('understand', `${missing.length} product section${missing.length === 1 ? '' : 's'} need work`, `read the project (README, package scripts, routes, CLI help, changelog) and complete product.md: ${missing.join(', ')}`, productProblems.map(issue));
  }

  const briefFile = path.join(dir, 'brief.md');
  const briefProblems = fs.existsSync(briefFile) ? validateBrief(read(briefFile)) : [{ file: 'brief.md', path: '', message: 'create brief.md' }];
  if (briefProblems.length) {
    const missing = [...new Set(briefProblems.map((problem) => problem.path || problem.message))];
    return result('brief', `${briefProblems.length} missing or invalid field${briefProblems.length === 1 ? '' : 's'}`, `fill brief.md with the user: ${missing.join(', ')}`, briefProblems.map(issue));
  }
  const brief = readBrief(read(briefFile)).data;
  if (brief.weight === 'quick') return result('quick', 'a quick video needs no plan', 'run `ghostcast shoot "<command>"` or `ghostcast shoot <url>`');

  const storyboardFile = path.join(dir, 'storyboard.yaml');
  if (!fs.existsSync(storyboardFile)) return result('storyboard', 'storyboard missing', `run \`ghostcast template ${brief.type}\`, then write the beats`);

  const lintReport = lint(dir);
  const warnings = lintReport.warnings.length;
  const placeholders = lintReport.errors.filter((problem) => problem.file === 'storyboard.yaml' && /replace the placeholder/.test(problem.message));
  if (placeholders.length) {
    const problems = placeholders.slice(0, 8).map(lintIssue);
    if (placeholders.length > 8) problems.push({ message: `and ${placeholders.length - 8} more` });
    return result('storyboard', `${placeholders.length} placeholder${placeholders.length === 1 ? '' : 's'} left`,
      `replace every placeholder in storyboard.yaml with real beats (${placeholders.length} left), then run \`ghostcast lint\``, problems, warnings);
  }
  if (lintReport.errors.length) {
    const count = lintReport.errors.length;
    const problems = lintReport.errors.slice(0, 8).map(lintIssue);
    if (count > 8) problems.push({ message: `and ${count - 8} more` });
    return result('lint', `${count} error${count === 1 ? '' : 's'}${warningSuffix(warnings)}`, 'fix these, then run `ghostcast lint`', problems, warnings);
  }

  const currentHash = storyboardHash(dir);
  const rehearsalFile = path.join(dir, 'cache', 'rehearsal.json');
  let rehearsal;
  try { rehearsal = JSON.parse(read(rehearsalFile)); } catch {}
  if (!rehearsal || rehearsal.storyboardHash !== currentHash)
    return result('rehearse', `${rehearsal ? 'rehearsal is stale' : 'no rehearsal'}${warningSuffix(warnings)}`, 'run `ghostcast rehearse`', [], warnings);
  const story = parseYaml(read(storyboardFile), 'storyboard.yaml').data;
  const rehearsed = rehearsalResult(rehearsal, story.beats.map((beat) => beat.id), warnings);
  if (rehearsed.stage !== 'shoot') return rehearsed;

  const approvalFile = path.join(dir, 'approvals.json');
  let approvedHash;
  try { approvedHash = JSON.parse(read(approvalFile))?.storyboard?.sha256; } catch {}
  if (approvedHash === currentHash) return postShoot(dir, story, currentHash, rehearsed.warnings, rehearsed.problems);
  const approvedCopy = path.join(dir, 'cache', 'approved', 'storyboard.yaml');
  const changes = approvedHash && fs.existsSync(approvedCopy) ? storyboardChanges(read(approvedCopy), read(storyboardFile)) : { problems: [] };
  const estimate = lintReport.estimate;
  const runtime = `${estimate.total.toFixed(1)} s / ${estimate.cap ?? '?'} s cap`;
  return result('approve', `${approvedHash ? 'storyboard changed since approval' : 'storyboard awaits approval'}: ${runtime}${warningSuffix(rehearsed.warnings)}`,
    `show the user each beat (what it shows and says) and the estimated runtime (${runtime}); when they approve, run \`ghostcast approve storyboard\``, changes.problems, rehearsed.warnings);
}

export function formatNext(report) {
  const lines = [`${report.stage} \u00b7 ${report.state}`];
  for (const problem of report.problems) {
    if (problem.message.startsWith('and ') && !problem.id) { lines.push(`  ${problem.message}`); continue; }
    lines.push(`  ${problem.message.startsWith('warning:') ? '!' : '\u2717'} ${problem.id && !/^(?:error|warning)\s{2}/.test(problem.message) ? `${problem.id.padEnd(8)} ` : ''}${problem.message}`);
  }
  lines.push(`next: ${report.next}`);
  return lines.join('\n');
}

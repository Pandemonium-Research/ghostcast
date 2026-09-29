import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { lint } from './lint.mjs';
import { storyboardHash } from './approve.mjs';
import { parseYaml, readBrief, validateBrief, validateProduct } from './schema.mjs';

const result = (stage, state, next, problems = [], warnings = 0) => ({ stage, state, problems, next, warnings });
const read = (file) => fs.readFileSync(file, 'utf8');
const warningSuffix = (count) => count ? `, ${count} warning${count === 1 ? '' : 's'}` : '';
const issue = (problem) => ({ ...(problem.id ? { id: problem.id } : {}), message: `${problem.path ? `${problem.path}: ` : ''}${problem.message}` });

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
  if (lintReport.errors.length) {
    const count = lintReport.errors.length;
    const problems = lintReport.errors.slice(0, 8).map(lintIssue);
    if (count > 8) problems.push({ message: `and ${count - 8} more` });
    return result('lint', `${count} error${count === 1 ? '' : 's'}${warningSuffix(warnings)}`, 'fix these, then run `ghostcast lint`', problems, warnings);
  }

  const currentHash = storyboardHash(dir);
  const approvalFile = path.join(dir, 'approvals.json');
  let approvedHash;
  try { approvedHash = JSON.parse(read(approvalFile))?.storyboard?.sha256; } catch {}
  const estimate = lintReport.estimate;
  const runtime = `${estimate.total.toFixed(1)} s / ${estimate.cap ?? '?'} s cap`;
  const approve = (changes) => result('approve', `${approvedHash ? 'storyboard changed since approval' : 'storyboard awaits approval'}: ${runtime}${warningSuffix(warnings)}`,
    `show the user each beat (what it shows and says) and the estimated runtime (${runtime}); when they approve, run \`ghostcast approve storyboard\``, changes.problems, warnings);
  // Fixing how beats are performed, as rehearsal failures need, does not stop the next rehearsal;
  // the approval is still reopened, and asked for again before the shoot.
  let pending = null;
  if (approvedHash !== currentHash) {
    const approvedCopy = path.join(dir, 'cache', 'approved', 'storyboard.yaml');
    const changes = approvedHash && fs.existsSync(approvedCopy) ? storyboardChanges(read(approvedCopy), read(storyboardFile)) : { problems: [], mechanicsOnly: false };
    if (!changes.mechanicsOnly) return approve(changes);
    pending = changes;
  }

  const rehearsalFile = path.join(dir, 'cache', 'rehearsal.json');
  let rehearsal;
  try { rehearsal = JSON.parse(read(rehearsalFile)); } catch {}
  if (!rehearsal || rehearsal.storyboardHash !== currentHash)
    return result('rehearse', `${rehearsal ? 'rehearsal is stale' : 'no rehearsal'}${warningSuffix(warnings)}`, 'run `ghostcast rehearse`', [], warnings);
  const story = parseYaml(read(storyboardFile), 'storyboard.yaml').data;
  const rehearsed = rehearsalResult(rehearsal, story.beats.map((beat) => beat.id), warnings);
  return rehearsed.stage === 'shoot' && pending ? approve(pending) : rehearsed;
}

export function formatNext(report) {
  const lines = [`${report.stage} · ${report.state}`];
  for (const problem of report.problems) {
    if (problem.message.startsWith('and ') && !problem.id) { lines.push(`  ${problem.message}`); continue; }
    lines.push(`  ${problem.message.startsWith('warning:') ? '!' : '✗'} ${problem.id && !/^(?:error|warning)\s{2}/.test(problem.message) ? `${problem.id.padEnd(8)} ` : ''}${problem.message}`);
  }
  lines.push(`next: ${report.next}`);
  return lines.join('\n');
}

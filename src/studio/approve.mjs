import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { lint } from './lint.mjs';

// Approvals and rehearsals are keyed to the storyboard's text with line endings normalised: git on
// Windows may check the same file out with CRLF, which must not reopen an approval.
export function storyboardHash(dir) {
  const text = fs.readFileSync(path.join(dir, 'storyboard.yaml'), 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function approveStoryboard(dir) {
  const report = lint(dir);
  if (report.errors.length) throw new Error('fix the lint errors before asking for approval');

  const storyboard = fs.readFileSync(path.join(dir, 'storyboard.yaml'));
  const sha256 = storyboardHash(dir);
  const approvalsFile = path.join(dir, 'approvals.json');
  let approvals = {};
  if (fs.existsSync(approvalsFile)) {
    try { approvals = JSON.parse(fs.readFileSync(approvalsFile, 'utf8')); }
    catch (error) { throw new Error(`approvals.json: invalid JSON: ${error.message}`); }
    if (!approvals || typeof approvals !== 'object' || Array.isArray(approvals)) throw new Error('approvals.json: expected an object');
  }

  const approved = path.join(dir, 'cache', 'approved');
  fs.mkdirSync(approved, { recursive: true });
  fs.writeFileSync(path.join(approved, 'storyboard.yaml'), storyboard);
  approvals.storyboard = { sha256, at: new Date().toISOString() };
  fs.writeFileSync(approvalsFile, JSON.stringify(approvals, null, 2) + '\n');
  return sha256;
}

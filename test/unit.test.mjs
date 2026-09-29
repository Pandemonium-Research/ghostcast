import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fit, merge, place } from '../src/post/voice.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const vectors = (name) => JSON.parse(fs.readFileSync(path.join(here, 'vectors', `${name}.json`), 'utf8'));

for (const c of vectors('vo_mix').place) test(`place: ${c.name}`, () => {
  const [actual, problems] = place(c.pieces, c.takes, c.total);
  assert.equal(actual.length, c.expected.length);
  for (const [i, expected] of c.expected.entries())
    for (const key of ['anchor', 'start', 'end'])
      assert.ok(Math.abs(actual[i][key] - expected[key]) < 1e-9, `${key}: ${actual[i][key]} != ${expected[key]}`);
  assert.deepEqual(problems, c.problems);
});

for (const c of vectors('vo_mix').place_errors) test(`place error: ${c.name}`, () => {
  assert.throws(() => place(c.pieces, c.takes, c.total));
});

for (const c of vectors('pauses').merge) test(`merge: ${c.name}`, () => {
  const actual = merge(c.spans);
  assert.equal(actual.length, c.expected.length);
  for (const [i, expected] of c.expected.entries())
    for (const [j, value] of expected.entries())
      assert.ok(Math.abs(actual[i][j] - value) < 1e-9);
});

test('script fit keeps the half-second margin', () => {
  assert.deepEqual(fit(10, 2.5, 4.5), { need: 4, flag: 'fits' });
  assert.deepEqual(fit(10, 2.5, 4.49), { need: 4, flag: '**0.1s too long: trim the text or lengthen the take**' });
  assert.deepEqual(fit(20, 2.5, 4), { need: 8, flag: '**4.5s too long: trim the text or lengthen the take**' });
  assert.deepEqual(fit(5, 4, 0.5), { need: 1.25, flag: '**1.2s too long: trim the text or lengthen the take**' });
});

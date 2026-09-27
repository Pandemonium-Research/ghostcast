# Tests

```bash
npm test             # everything (about a minute and a half)
npm run test:unit    # the post-production functions only (under a second)
npm run test:smoke   # the end-to-end run only
```

## Unit tests and the vectors

`vectors/` holds the cases the post-production code must satisfy, as plain JSON: inputs and the
expected outputs, worked out from the rules rather than copied from the code. They cover:

- `cut.json`: segments from the event log (margins, `@4x`, `@fitN`), the ease, the zoom view
  track, and the eased box at a given time;
- `assemble.json`: caption windows and the on-screen speed tags;
- `vo_mix.json`: where voice-over pieces land, and which problems are reported;
- `pauses.json`: joining silences a click has split.

`config.json` is the project configuration the vectors assume.

Today the vectors run against the Python code (`py/test_*.py`, run by `unit.test.mjs`). When
post-production moves to Node ([PLAN.md](../PLAN.md), stage 1), the Node code must pass the same
vectors before the Python is removed. Add a case here whenever a rule changes or a bug is fixed.

## Smoke test

`smoke.test.mjs` makes a project from the template in the system temp directory, then runs the
CLI end to end:

1. record, cut and assemble the title and web takes;
2. review the cut;
3. time the narration;
4. find the pauses in a generated stand-in clip;
5. mix a voice-over, checking its loudness independently (−16 LUFS ± 1);
6. record a take that fails on purpose, checking it leaves a screenshot.

It needs what `ghostcast doctor` checks, except VS Code: the template's terminal take is left
out, because serving VS Code means accepting its license. The project is deleted afterwards,
unless a step failed; then its path is printed so you can look at what it produced.

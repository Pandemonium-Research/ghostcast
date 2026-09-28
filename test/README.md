# Tests

```bash
npm test             # everything (about a minute and a half)
npm run test:unit    # Node post functions and the remaining Python functions
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

`post.test.mjs` runs the unchanged `cut.json` and `assemble.json` vectors against Node and checks
that a caption edit invalidates only its covered beat. `unit.test.mjs` runs the voice-over and
pause vectors against the remaining Python code. Add a case here whenever a rule changes or a bug
is fixed.

## Smoke test

`smoke.test.mjs` makes a project from the template in the system temp directory, then runs the
CLI end to end:

1. record, cut and assemble the title, terminal and web takes;
2. review the cut;
3. time the narration;
4. find the pauses in a generated stand-in clip;
5. mix a voice-over, checking its loudness independently (−16 LUFS ± 1);
6. record a take that fails on purpose, checking it leaves a screenshot.

It needs Chrome and ffmpeg, plus Python for the remaining voice commands. The project is deleted
afterwards unless a step failed; then its path is printed for inspection.

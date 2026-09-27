# ghostcast — plan

*How ghostcast gets from version 0.1 to the product in [VISION.md](VISION.md), stage by stage.
September 2026.*

Each stage has a goal, what to build, what to decide, and a test for when it is done. Stages are
in build order; a stage can start once the stages it depends on are done. Update the status table
as work lands.

## Status

| Stage | Name | Depends on | Status |
|---|---|---|---|
| 0 | [Groundwork](#stage-0--groundwork) | — | Not started |
| 1 | [One-command install](#stage-1--one-command-install) | 0 | Not started |
| 2 | [Isolation](#stage-2--isolation) | 1 | Not started |
| 3 | [Quick shoots](#stage-3--quick-shoots) | 1, 2 | Not started |
| 4 | [Plan](#stage-4--plan) | 2 | Not started |
| 5 | [Direction](#stage-5--direction) | 4 | Not started |
| 6 | [Checks](#stage-6--checks) | 4, 5 | Not started |
| 7 | [Voice](#stage-7--voice) | 1, 4 | Not started |
| 8 | [Delivery](#stage-8--delivery) | 1, 7 | Not started |
| 9 | [Engine interface](#stage-9--engine-interface) | 5, 6 | Not started |
| 10 | [The Skilldex remake and version 1](#stage-10--the-skilldex-remake-and-version-1) | all | Not started |

## Milestones

| Milestone | Stages | What a user can do |
|---|---|---|
| **M1 · First clip in five minutes** | 0–3 | Install with one command and film a command or a page, in the background, without touching their checkout |
| **M2 · A video from a storyboard** | 4–6 | Have their agent plan, shoot and check a silent video, with no hand-placed sleeps or zooms |
| **M3 · Voiced and delivered** | 7–8 | Add Kokoro, ElevenLabs or their own voice, and export for GitHub, social feeds, YouTube or a submission |
| **M4 · Version 1** | 9–10 | Use ghostcast as an engine from another pipeline; see the Skilldex remake as proof |

The Skilldex remake is the running test case: its picture is remade at M2, voiced at M3, and
shipped as the showcase at M4.

## How we work

- **Every stage ends runnable**, with a short clip made by ghostcast of the thing the stage added.
  ghostcast films itself from the start.
- **Tests grow with the code.** Pure functions get unit tests; each stage adds a smoke scenario
  that runs headlessly end to end.
- **Windows, macOS and Linux** are all kept working from stage 1 on.
- **No LLM calls inside ghostcast.** Anything agent-facing is designed to be driven through
  `ghostcast next`.
- **Line endings are LF** (`.gitattributes`). On Windows, write files with `\n` explicitly; the
  template `shell.bashrc` breaks with CRLF.
- **Decisions are written down** in the stage that makes them, under "Decided".

---

## Stage 0 · Groundwork

**Goal:** a safety net for the rewrite, and a baseline to measure against.

Build:

- Unit tests for the pure functions as they are today. They become the reference the Node port
  must match in stage 1:
  - `py/cut.py`: `segments()`, `view_track()`, `box_at()`;
  - `py/vo_mix.py`: piece placement;
  - `py/assemble.py`: `windows()`.
- A smoke test: `init`, record the web take headlessly, cut, assemble.
- Exercise the helpers that were ported but never run, and fix or file what fails:
  - `h.vscode.openFile`, `gotoLine`, `focusEditor`, `resizePanel`, and `h.editorRect`;
  - split terminals (`useTerm`, `focusTerminal(i)`);
  - `h.waitFor` on an agent TUI;
  - `--headed`.
- Baselines:
  - render time per second of output, and CPU use during a capture while someone works on the
    same machine;
  - the bake-off: try aidemo, reelson and openvidstudio on Skilldex, and note what each can film
    of the Skilldex story, how long it takes, and how much attention it needs. Write the result
    to `docs/bakeoff.md`.

Done when:

- the tests and the smoke test pass on Windows;
- every unexercised helper works or has an issue filed;
- `docs/bakeoff.md` has the baselines.

## Stage 1 · One-command install

**Goal:** `npx ghostcast` is the whole install: no Python, no compiler, no VS Code required.

Build:

- **A compositor spike, then a choice.** It replaces Pillow for cropping, zooming and captions.
  Candidates:
  - sharp (libvips, prebuilt binaries, sub-pixel affine transforms);
  - canvas in the headless Chrome ghostcast already runs;
  - ffmpeg filters.

  The criteria:
  - zooms as smooth as today's sub-pixel crop;
  - speed;
  - low CPU at low priority;
  - nothing to compile.
- **Post-production ported to Node, per beat from the start.** Each segment renders to its own
  clip, cached by a hash of its inputs, and the video is the clips joined. Porting today's
  take-level structure first and restructuring later would do the work twice. The stage-0 tests
  run against the port; the Python code is deleted once they pass.
- **The lightweight terminal.** A local page with xterm.js (DOM renderer) connected to a real
  shell through a prebuilt-only node-pty build (`@lydell/node-pty`). Details:
  - it starts with a clean prompt (today's `shell.bashrc`);
  - the terminal helpers (`h.run`, `termRect`, prompt detection) work on it unchanged, since both
    it and VS Code use xterm.js;
  - VS Code stays available as the editor surface.
- **`ghostcast doctor`** finds Chrome and ffmpeg, and offers a fix when they are missing.
- **macOS and Linux** run the sample project end to end.

Decide:

- the compositor;
- whether ffmpeg stays a system requirement or can be fetched on first run;
- how the Windows terminal gets bash (Git Bash as today, or a fallback).

Done when:

- on a clean machine of each OS, `npx ghostcast doctor` and the sample project render with no
  Python installed;
- the stage-0 tests pass against the Node code;
- the terminal sample take runs without VS Code;
- changing one caption re-renders one beat.

## Stage 2 · Isolation

**Goal:** promise 2: a shoot never touches your work.

Build:

- **The isolated copy.** It can be:
  - a git worktree at a chosen commit;
  - a snapshot of the working tree as it is now, including uncommitted changes (for example
    `git stash create` applied in a fresh worktree), plus the ignored files `world.yaml` names,
    such as `.env`;
  - for projects not under git, a copy.
- **Its own ports.** Free ports are allocated and passed to services through environment
  variables.
- **Services** from `world.yaml`:
  - started in the copy;
  - waited on until a URL, port or log line says they're ready;
  - stopped afterwards;
  - their logs kept.
- **Seed data and database files** live in the copy.
- **The browser profile** moves under `.ghostcast/`, one per project.
- **The untouched check.** Before and after each shoot it compares a fingerprint of the checkout
  (status and hashes of tracked and untracked files) and the ports in use.

Decide:

- how the snapshot handles large or ignored directories (e.g. `node_modules`): link them, reinstall
  them, or declare them in `world.yaml`.

Done when:

- a shoot runs while the checkout is being edited, the edits survive, and the check passes;
- a scene that runs `git reset --hard` changes only the copy;
- two shoots run at once without colliding.

## Stage 3 · Quick shoots

**Goal:** M1. The first clip within five minutes of installing.

Build:

- `ghostcast shoot "<command>"` films a command in the lightweight terminal.
- `ghostcast shoot <url>` films a page.
- Neither needs plan files. Both run in the isolated copy, use a default camera (wide, then
  framing the output or the page's main content), and write an MP4 plus a short loop.
- The README's quick start leads with this.

Done when:

- from a clean install, the first clip takes under five minutes on each OS (timed);
- the clip passes the checks that exist by then.

## Stage 4 · Plan

**Goal:** the studio's spine. An agent can go from nothing to a rehearsed storyboard by
following `ghostcast next`.

Build:

- **`ghostcast init` inside an existing project**, creating `.ghostcast/` (VISION.md,
  "The project folder"). Today's `init <dir>` template becomes a sample.
- **Schemas** for the brief, `storyboard.yaml`, `world.yaml` and `audio.yaml`, plus the
  `product.md` questionnaire.
- **Templates for each video type** (launch, how-to, feature, receipt): a narrative frame and a
  beat skeleton for each.
- **The plan lint:**
  - one claim per beat;
  - each beat's narration within its word budget;
  - panels within their share of the runtime;
  - the total within the cap.
- **The compiler: storyboard to scene.** The verbs `open`, `click`, `fill`, `press`, `run` and
  `wait` map to Playwright and today's helpers. `code:` takes Playwright code, and `script:`
  points at a code scene.
- **Rehearsal:** three dry runs of every beat without capture, with a flakiness report.
- **`ghostcast next`:**
  - reads the folder, decides the current stage and prints the next action;
  - records approvals against a hash of the approved file, so editing an approved storyboard
    reopens its gate.
- **`SKILL.md` rewritten** around `ghostcast next` and the rules.

Done when:

- an agent in a fresh session, given only the skill, goes from `ghostcast init` in a sample
  repository to an approved, rehearsed storyboard;
- the lint catches a planted over-long line and a planted two-claim beat.

## Stage 5 · Direction

**Goal:** no sleeps, zoom calls or timestamps in a storyboard, and a camera nobody wants to turn
off.

Build:

- **The camera policy** (VISION.md, "Camera"):
  - framing only for `show`;
  - actions close together share a shot;
  - a minimum hold per framing;
  - a cap on moves per minute;
  - the `camera:` override per beat.
- **Holds shot long, then fitted without visible cuts.** During capture, each `show` hold runs
  to an upper bound. In post, each beat is fitted to the longer of its narration and the time
  needed to read the target (a minimum applies):
  1. still holds shorten first, since a frame where nothing moves can lose time unnoticed;
  2. then the parts that move (zooms easing, scrolls, typing) play faster;
  3. a move is never cut into. Trimming mid-move makes the picture jump, and that is what makes
     a cut look choppy.

  Speed-ups of 1.5× and more are tagged on screen, as today. Changing the voice then re-fits the
  video; it never needs a re-shoot.
- **Narration length:** a words-per-second estimate until stage 7 provides real audio.

Decide:

- the default reading speed, minimum hold and moves per minute. Start from the Skilldex cut and
  tune in stage 6.

Done when:

- the Skilldex story, rewritten as a storyboard, shoots with no hand-placed sleeps or zooms;
- shortening its narration re-fits the cut with no jump in any zoom or scroll;
- its stills are judged side by side with the hand-directed original.

## Stage 6 · Checks

**Goal:** no issue a machine can catch reaches a final cut, and no beat is approved unseen.

Build:

- **Page facts in the log.** At each beat's key frames the recorder logs:
  - the visible text;
  - the rectangles of the `show` target and of any caption;
  - the font sizes in the framed area.
- **The mechanical checks** in VISION.md ("Checks"), including:
  - the copy-drift check: narration quoting on-screen words the page no longer shows;
  - the untouched check from stage 2.
- **Per-beat sheets:** stills captioned with the beat's `show` claim.
- **Checkable confirmations.** The agent submits, for each beat, what it sees, including the text
  on screen. ghostcast matches that against the logged page text and rejects a confirmation that
  doesn't fit.
- **A report**, and `ghostcast next` gating on it.

Done when:

- the checks flag the known issues in the hand-made Skilldex cut:
  - a caption held 23.7 s across beats;
  - a caption over terminal output;
  - near-empty frames with small text;
  - a voice piece running 3.4 s past its take;
- a deliberately wrong confirmation is rejected;
- the M2 remake passes.

## Stage 7 · Voice

**Goal:** the same storyboard can be voiced by Kokoro, by ElevenLabs with your own key, or by you,
without changing the storyboard.

Build:

- **Kokoro by default.** Through kokoro-js on the CPU:
  - the q8 model is about 86 MB, downloaded on first use; `doctor` says so;
  - lines are generated one sentence at a time, so each line's timing is known.
- **ElevenLabs with your own key.**
  - The key comes from the environment or a git-ignored secrets file, never a committed file.
  - Its timestamped endpoint provides per-character timing.
  - The cost is estimated and approved before generating.
- **A cache** keyed on text, voice and provider, for every source.
- **The recording booth.** A local page ghostcast serves and you open yourself; it's the one
  window ghostcast ever shows, and only on request. It:
  - plays each beat's picture;
  - records the line in the browser;
  - allows a retake of any single line;
  - saves the clips to `.ghostcast/audio/`, already assigned to their beats.
- **Clips you already have:** aligned to the script by a local Whisper and split per line.
- **Placement by beat** (ported from `vo_mix`), with two-pass loudness normalisation to −16 LUFS.

Decide:

- the Whisper runtime in Node (a whisper.cpp binary or transformers.js);
- where BYOK keys are read from.

Done when:

- one storyboard renders with Kokoro, with ElevenLabs, and with booth-recorded lines, with no
  overruns in any;
- a re-render with unchanged lines calls no speech service.

## Stage 8 · Delivery

**Goal:** a file that fits where it's going, first time.

Build:

- **Presets:**
  - `github`: under 10 MB, strong first frame;
  - `social`: narration burned in as captions;
  - `youtube`: chapters from the beats;
  - `submission`: a length cap;
  - `docs`: a loop per beat.
- **Subtitles (SRT, VTT)** from the script and the audio timing.
- **Each preset checks its own constraint** (size, length) on every render.

Done when:

- every preset's output meets its constraint automatically on the Skilldex remake and the sample
  project.

## Stage 9 · Engine interface

**Goal:** another pipeline can call ghostcast for real footage and compose from the result.

Build:

- **`ghostcast shoot beats.yaml --json`**, returning a clip per beat plus a manifest:
  - beat timings and framed rectangles;
  - whether each `show` target was visible;
  - the page text at key frames;
  - the check results.
- **The manifest** as a versioned JSON Schema, documented in `docs/engine.md`, with stable exit
  codes.
- **Integration shape with OpenMontage and HyperFrames**, discussed with their maintainers before
  the schema is frozen.

Done when:

- a small external script builds a video from the manifest alone;
- the schema is versioned and documented.

## Stage 10 · The Skilldex remake and version 1

**Goal:** M4. Proof, and a release.

Build:

- **Remake the Skilldex video** from a brief through the studio.
  - Measure it against VISION.md's "Proof" criteria and against the stage-0 bake-off.
  - Write up what fell short, honestly.
- **ghostcast's own README video**, made by ghostcast.
- **Release:**
  - the GitHub repository (check the name there first);
  - the npm package (`ghostcast` was free on npm on 2026-09-23);
  - the agent skill packaged as a Claude Code plugin.

Done when:

- the proof criteria are met, or each shortfall is documented with a follow-up;
- version 1 is published.

---

## After version 1

Roughly in order:

1. **A local review page:** play the cut, leave a note on a beat, and the agent applies it.
2. **Polish:** a music bed with ducking (your track or CC0), an optional framed look, a keystroke
   overlay for how-tos.
3. **Integrations:** ghostcast as a capture tool in OpenMontage's Screen Demo pipeline;
   HyperFrames in both directions.
4. **More speech providers**, each with your own key.
5. **An MCP server** for agents without a shell.
6. **`ghostcast reshoot` in CI**, with a container image that pins Chrome and fonts so renders
   compare cleanly.
7. **Versions:** 9:16 re-shot at a phone viewport, per locale, per theme.
8. **Electron apps.**

## Small items from 0.1

These can go in whenever they're next to other work:

- **The `N×` tag position:** it can overlap VS Code's panel toolbar; make it configurable.
- **Prompt setting:** a project-level setting for the prompt `h.run` waits for, instead of per
  call.
- **The serve-web token** appears in serve-web's own log. The server is loopback-only, but logs
  shouldn't be shared as they are.

## Risks

| Risk | Where | Mitigation |
|---|---|---|
| node-pty needs a compiler on some platforms | 1 | A prebuilt-only build; fail with a clear message where no prebuild exists |
| The new compositor loses zoom smoothness | 1 | Choose it by side-by-side renders against today's output |
| VS Code web DOM changes break the editor helpers | 0, 1 | A pinned, tested VS Code version in the smoke test; the lightweight terminal for anything that doesn't need the editor |
| Capture stutters on a busy machine | 0, 5 | Measure in stage 0; offer shooting when idle; frame timestamps keep timing true |
| Automatic camera annoys more than it helps | 5 | A conservative policy, per-beat overrides, and judging it on the Skilldex remake |
| Agents rubber-stamp judgement checks | 6 | Confirmations matched against the logged page text |
| The Kokoro download slows the first voiced video | 7 | Stated up front by `doctor`; only needed once a video has narration |
| Other pipelines don't adopt the engine | 9 | Shape the manifest with their maintainers first; the studio stands on its own regardless |

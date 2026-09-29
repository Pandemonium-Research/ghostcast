# ghostcast — plan

*How ghostcast gets from version 0.1 to the product in [VISION.md](VISION.md), stage by stage.
September 2026.*

Each stage has a goal, what to build, what to decide, and a test for when it is done. Stages are
in build order; a stage can start once the stages it depends on are done. Update the status table
as work lands.

## Status

| Stage | Name | Depends on | Status |
|---|---|---|---|
| 0 | [Groundwork](#stage-0--groundwork) | — | Done: see [docs/bakeoff.md](docs/bakeoff.md) |
| 1 | [One-command install](#stage-1--one-command-install) | 0 | In progress: Node post-production done |
| 2 | [Isolation](#stage-2--isolation) | 1 | Done on Windows (Linux and macOS with stage 1) |
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

Progress:

- **Done:**
  - unit tests against shared JSON vectors in `test/vectors/`, which the stage-1 port must also
    pass; `vo_mix` placement and `pauses` merging were pulled out into pure functions for them;
  - the smoke test (`npm test`, about 80 s): init, record, cut, assemble, review, narration
    timing, pauses, voice-over mix with an independent loudness check, and a failing take.
- **Fixed along the way:**
  - the on-screen speed tag rounded to a whole number, so 3.6× showed as "4×" and 2.5× as "2×";
    it now shows one decimal, matching the cue sheet;
  - the template's title card was 0.03 s too short for its own narration, so a new project's
    first `vo-script` reported "too long".
- **Editor helpers verified** on a fresh VS Code server build: split terminals (`useTerm`,
  `focusTerminal(i)`), `openFile`, `resizePanel` from a maximized panel, `gotoLine`,
  `focusEditor`, `editorRect` across split editors, and `h.waitFor` on a full-screen terminal
  app with no prompt (a stand-in for an agent TUI). `--headed` was left out: it opens a window
  on the user's screen.
- **Found and fixed by the editor check:**
  - *The first editor take on a new project failed.* `code serve-web` downloads its server
    (about 600 MB) on the first page load; here that took about six minutes, and `vscode.open`
    gives up after two 45-second tries. `ghostcast vscode` now starts the download itself and
    prints "VS Code is ready" when it is over.
  - *Deep project paths broke the terminal on Windows.* The server lived in the project
    (`vscode/cli-data/…`), and its deepest files sit about 166 characters below that; from a deep
    folder the path to `conpty.dll` passed 260 characters and the terminal failed with "Cannot
    find conpty.dll". The server now lives once per machine in a short cache folder
    (`%LOCALAPPDATA%\ghostcast` on Windows; `GHOSTCAST_CACHE` overrides), which `doctor` checks.
    The same project that failed from a deep folder now records. Stage 2's isolated copies must
    keep their own paths short too.
- **Found, for later stages:** terminal-only frames are mostly empty (small text on a wide,
  empty terminal), as in the Skilldex cut. That's for the camera policy (stage 5) and the checks
  (stage 6).
- **The bake-off and the baselines** are in [docs/bakeoff.md](docs/bakeoff.md). In short:
  - aidemo, reelson and openvidstudio were given the same three-beat Skilldex story.
  - aidemo finished it on its fifth run, but its fitting cut the terminal beat's payoff, and its
    speed-ups aren't marked on screen.
  - reelson recorded it, but can't compose on Windows.
  - openvidstudio can't type, so it filmed the web beat only.
  - ghostcast 0.1 finished it on its second run, with the claim on screen when it's said.
  - Baselines: cutting takes 1.6–2.7 s per output second, and assembling averages 70% CPU on a
    16-thread machine.
  - What this changes is folded into stages 1, 4 and 7 below and into "Small items".

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
- **macOS and Linux** run the sample project end to end, and the smoke test runs on all three
  operating systems. Two of the three tools in the bake-off broke on Windows out of the box;
  keeping all three working is part of the product.
- **A legible default viewport:** 1440×810 CSS pixels at `dpr` 2. At 1920 CSS pixels a site's
  body text ends up about 14 px on screen (the bake-off used 1440 for every tool).
- **Speed and footprint:** the new post-production runs at low priority, and aims for at most
  0.5 s of work per second of output. The 0.1 baseline is 1.6–2.7 s for cutting, and assembling
  averages 70% of a 16-thread machine.

Progress (Windows; measured on the bake-off takes at a true 2880×1620):

- **Done:**
  - the lightweight terminal, `h.terminal.open` (xterm.js on a real shell through node-pty);
  - capture at the device scale, so frames really are 2× (they never were before);
  - the compositor decision: ffmpeg's `perspective` filter (docs/compositor-spike.md);
  - `cut` and `assemble` in Node, per beat and cached. Each beat is one ffmpeg run (perspective,
    Lanczos scale, captions and `N×` tag, x264 `veryfast` CRF 16) below normal priority; repeated
    frames are warped once; full-frame stretches skip the warp; beats render one at a time
    (`GHOSTCAST_JOBS` for more); assembly joins beats by stream copy.
  - `vo-script`, `pauses`, `vo-mix`, and every `review` mode in Node; the Python post-production
    directory removed.
- **Measured** (best of three, cold cache): registry 0.47 s and validate 0.36 s per output
  second, against Pillow's 4.5 and 3.0. SSIM against the Pillow reference: mean 0.9975 and
  0.9987, minimum 0.9937 and 0.9942. Peak 760 MiB per ffmpeg. The zoom expression grows
  linearly: 33,633 characters for 50 camera moves (review caught an exponential first version
  that failed past 12). The full suite runs in 82 s instead of 178 s.
- **Clean install checked** (Windows): `npm pack` gives a 51 kB package of 27 files; installed
  into an empty folder it takes 3 s and 37 MB (dependencies hoisted beside it), `doctor` passes,
  and `init` + `all` + `review` make the 28 s template video in 72 s. Running straight from
  `npx`'s cache (`npx --package=<tarball> ghostcast`) passes `doctor` and records a take too.
- **Left:** macOS and Linux. This machine's WSL Ubuntu lacks Node, ffmpeg and Chrome, and
  installing Chrome's system libraries needs `sudo`; CI on GitHub (Windows, macOS, Linux) is
  the lasting answer and needs the repository created first.

Decide:

- the compositor;
- whether ffmpeg stays a system requirement or can be fetched on first run;
- how the Windows terminal gets bash (Git Bash as today, or a fallback).

Done when:

- on a clean machine of each OS, `npx ghostcast doctor` and the sample project render with no
  Python installed;
- the stage-0 tests pass against the Node code;
- the terminal sample take runs without VS Code;
- changing one caption re-renders one beat;
- the bake-off's ghostcast cut renders at 0.5 s or less per output second.

## Stage 2 · Isolation

**Goal:** promise 2: a shoot never touches your work.

Progress (Windows):

- **Done:** `project.json` declares an optional `world`. Git sources are cloned under the short
  cache path (`git clone --shared --no-checkout`), then set to a snapshot of the working tree
  (uncommitted and untracked files included) or to a commit; other sources are copied. Ignored
  files can be copied and ignored directories linked; resets remove links before cleaning.
  Services get allocated ports, readiness checks, logs and process-tree teardown. `record` owns
  one world; `all` shares one and resets it before each take. A project inside the source (the
  future `.ghostcast/`) is left out of the copy and the checks.
- **The untouched check** compares the source's status, content hashes, refs, stash and
  worktrees, and walks every linked directory. It reports your own edits during a shoot without
  failing, and fails on a leaked write, on git metadata changes, and on any write through a
  link, naming the files.
- **Verified:** 11 isolation tests pass through the library and the real CLI (53 in the whole
  suite); an end-to-end scene running `git reset --hard && git clean -fdx` left the source
  byte-identical, and a scene writing into the linked `node_modules` failed the shoot.
- **Limit:** a link is detected, not prevented: a write through it lands in the source and fails
  the shoot. Links are for dependencies a scene only reads.

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
  - the total within the cap;
  - borrowing from aidemo's lint, which the bake-off showed works before anything is recorded:
    - predicted pacing per beat (actions against narration);
    - text too small for the viewport;
    - an action with nothing to wait on after it.
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
  - installed on demand, the first time a video has narration, never as a core dependency:
    kokoro-js pulls in about 400 MB (onnxruntime, sharp, transformers);
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
- **Locators everywhere:** `h.focus` and `h.mark` should accept a Playwright locator, as
  `h.point` and `h.tap` do; today a locator fails with a serialisation error (found in the
  bake-off).

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

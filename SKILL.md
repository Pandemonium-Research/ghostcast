---
name: ghostcast
description: Make a demo video or screencast of real software (terminal commands, web apps, VS Code, agent CLIs), filmed headlessly in an isolated copy of the project while the user keeps working. Use when asked to record a demo, screencast, how-to, launch or feature video, a README GIF, or a video for a pull request.
---

# ghostcast

A headless studio. It films real software in an off-screen Chrome, inside a disposable copy of
the project, so nothing on the user's screen is recorded and nothing in their checkout changes.
Then it cuts, zooms and speed-tags what it filmed.

The `ghostcast` command is `node <this package>/bin/ghostcast.mjs` (or `npx ghostcast`). Run
`ghostcast doctor` once to check Chrome, ffmpeg and bash.

## Pick the weight

- **Quick**: one command or one page, for a README loop or a pull request. No plan files:

  ```
  ghostcast shoot "npm test"
  ghostcast shoot http://localhost:3000/
  ```

  It writes `<name>.mp4` and `<name>.gif` in the current directory and prints the command's exit
  code. `--in <dir>`, `--out <file>`, `--timeout <seconds>`, `--keep`.
- **Standard** (a how-to, a feature) and **production** (a launch, a talk): the studio, below.

## The studio: follow `ghostcast next`

From the project's root:

```
ghostcast init        # once: adds .ghostcast/
ghostcast next        # says where the video stands and the one thing to do next
```

Do what `next` says, then run it again. Its stages, in order:

1. **Understand.** Read the project (README, package scripts, routes, CLI help, changelog) and
   answer every section of `.ghostcast/product.md`: what it is, how to run it, seed data,
   signing in, the flows worth showing, what must stay off screen. "none needed" is an answer.
2. **Brief.** Fill `.ghostcast/brief.md` **with the user**. Every field is theirs to choose:
   audience, goal, weight, type (launch, how-to, feature, receipt), the length cap in seconds,
   destinations, and audio (see [Audio](#audio)). Ask; don't invent. Optionally `panel_share`
   (default 0.2): the most of the runtime that panels may take.
3. **Storyboard.** `ghostcast template <type>` writes a skeleton with the type's narrative
   frame (it needs the brief first); replace every `<placeholder>` with real beats (reference
   below). Set up [the world](#the-world) when the product needs a server, seed data or ignored
   files.
4. **Lint.** `ghostcast lint` checks the files and estimates each beat against the brief's cap.
   Fix every error. Never raise the cap on your own: cut or tighten beats.
5. **Rehearse.** `ghostcast rehearse` runs every beat three times without filming, each run
   from the same prepared copy. Fix the beats it reports (a failing or flaky beat, a target that
   never appears, text too small), then `ghostcast rehearse <ids>` to retry just those, and a
   full `ghostcast rehearse` to confirm. The user then approves a plan known to work.
6. **Approve.** Show the user each beat (what it shows, what it says) and the estimated runtime.
   Only when **they** say yes, run `ghostcast approve storyboard`. Any later edit reopens the
   approval (after another rehearsal); `next` names the beats that changed.
7. **Shoot.** `ghostcast all` films the storyboard, cuts and assembles
   `.ghostcast/out/<video>-silent.mp4`, then runs the checks.
8. **Check.** Read `.ghostcast/out/check-report.md` (`ghostcast check` runs it again). Each
   problem gives its time in the video. Fix every error in the storyboard and shoot again: text
   too small once zoomed, a show target held too briefly, a near-empty frame, an email, token or
   home path on screen, narration longer than its beat. Warnings are yours to judge.
9. **Confirm.** `ghostcast review beats` writes a sheet of three stills per beat. **Open each
   sheet and look.** Is the right thing framed and legible? Is anything stuck, cut off or
   personal? Then say what you see, quoting text that is on screen:

   ```
   ghostcast confirm send 'The last row reads "Invoice INV-001 sent".'
   ```

   Every quoted phrase is matched against the page text recorded in that beat, and one must come
   from the beat's `show` target, so a confirmation written without looking is rejected. A
   re-shoot voids the confirmations of the old take. `ghostcast review final` gives a contact
   sheet of the whole cut, and `--at <seconds>` a full-size still.

Commit `.ghostcast/` with the project: the plan files, `approvals.json`, `confirmations.json`,
and your own `panels/` (HTML pages for panels) and `scenes/` (code scenes). `cache/`, `raw/`,
`clips/`, `out/`, `logs/` and `vscode/` are generated and git-ignored.

## The storyboard

```yaml
# .ghostcast/storyboard.yaml
video: first-invoice
type: how-to
beats:
  - id: intro
    surface: panel
    panel: { use: title, title: Send your first invoice }
    say: In two minutes, send an invoice from the app and from the CLI.

  - id: create
    surface: web
    open: /invoices
    claim: An invoice takes one form.
    do:
      - click: New invoice
      - fill: { Customer: Northwind Traders, Amount: "1,200" }
      - click: Save
    show: text "Invoice created"
    say: Click New invoice, pick a customer, and save.

  - id: send
    surface: terminal
    do:
      - run: acme invoices send --last
    show: row "sent"
    say: Or send it from the CLI.
```

- **One claim per beat.** `claim` is one sentence; `say` at most two, within the beat's word
  budget (12 s at 2.5 words a second unless `seconds` says otherwise).
- **surface**: `web`, `terminal`, `editor` or `panel`.
- **open**: for web, a URL, a path on the first world service (`/invoices`), or a file in the
  project; a web beat needs it when the beat before was on another surface. For terminal or
  editor, a folder in the project.
- **do** (in order): `click: <text>`, `fill: { <label>: <value> }`, `press: <key>`,
  `run: <command>` (or `{ cmd, expect: <usual seconds> }`), `wait: <seconds or target>`,
  `code: <Playwright code>` (with `h` and `page`).
- **show**: what the viewer must see, one target: `text "…"`, `role button "…"`, `label "…"`,
  `css <selector>` on web and panels; `row "…"` on terminal; `line "…"` in the editor. The camera
  frames it and holds while the line is said.
- **caption**: words on screen for the beat, as a lower-third: a few words (at most 10) that a
  silent viewer reads at a glance, not the `say` line. It stays until the beat ends.
- **transition**: `fade` dissolves the previous beat's last picture into this one; `cut` (the
  default) does not. Set it on a beat, or once at the top of the storyboard for every beat.
- **panel**: `{ use: title | chapter | cta, title, subtitle, foot }`, or `{ html: panels/x.html,
  data: {…} }`. Panels frame the story, at most a fifth of the runtime; they never mock the
  product.
- **camera**: the camera frames only `show`, keeps that framing into the next beat when it can,
  and eases back to wide before actions it would hide; a terminal command is typed with its
  prompt line framed. A target nearly as wide as the page gains nothing from a zoom, so it is
  highlighted instead (a `line "…"` in the editor covers the whole line, wrapped or not).
  Override per beat: `wide` never frames, `follow` frames each click and fill as it happens, and
  a target (`camera: css .chart`) frames that instead of `show`.
- **Timing**: write no sleeps or waits for pacing. Each beat is filmed with a long hold, then
  fitted to its line: still holds shorten first, then the moves play faster (tagged from 1.5×),
  and a cut never lands inside a move. Change a line and run `ghostcast cut storyboard` and
  `ghostcast assemble`: the cut re-fits without a re-shoot. `lint` warns when a line is so short
  that the actions would play at 2× or more.
- **script**: `scenes/x.mjs`, a code scene for a beat the storyboard can't express
  (see `docs/scene-api.md`).
- **cap**: comes from the brief. A storyboard may set a lower one, never a higher one.
- Never edit `cache/storyboard.mjs` or `timeline.json`: they are generated from the storyboard.

## The world

Shoots and rehearsals run in a copy of the repository, never in the checkout.
`.ghostcast/world.yaml` says how to make it:

```yaml
source: ..            # the repository around .ghostcast/
mode: snapshot        # the working tree as it is now, uncommitted and untracked files included,
                      # git-ignored files excluded; or `commit` with `ref: <branch or sha>`
copy: [.env]          # git-ignored files or folders to copy in as well
setup:                # bash commands run once in the new copy; every reset (each take, each
  - cp shelf.json.example shelf.json   # rehearsal run) returns to the state after them
services:             # started before, stopped after
  - name: web
    cmd: npm start
    port: true        # a free port, passed as PORT and as ${PORT} below
    ready: { url: "http://127.0.0.1:${PORT}/", timeout: 30000 }
```

`open: /path` in a web beat goes to the first service with `port: true`. `link: [folder]` links a
large read-only folder instead of copying it; a write through a link fails the shoot.

## Audio

The brief's `audio` and `.ghostcast/audio.yaml` say where the voice comes from. Today:

- **none**: a silent video. `say` lines are the script and the timing budget; put the words a
  viewer should read in `caption`.
- **kokoro**: local speech on the CPU (`voice: af_heart`, or another Kokoro voice). The first time,
  `ghostcast voice` stops and asks for `ghostcast voice --install`, a one-time download of about
  500 MB: ask the user before running it. After that, `ghostcast all` speaks every `say` line,
  cuts each beat at least as long as its line, and mixes `out/<video>.mp4`.
- **elevenlabs**: the user's own key, in `ELEVENLABS_API_KEY` or `.ghostcast/secrets.env` (never
  in a committed file, never printed). `ghostcast voice` prints the characters it would send and
  stops; show the user that number and run `ghostcast voice --approve` only after they agree.
- **clips**: the user records the lines; you place them. Put the clips in
  `.ghostcast/voiceover/`, run `ghostcast pauses voiceover/*` to find sentence breaks, write
  `voiceover/plan.json` with pieces anchored to `take: storyboard` and `segment: <beat id>`,
  then `ghostcast vo-mix` and fix everything under "Problems" in its report.

Generated lines are cached on their text and voice, so changing one line regenerates only that
line.

## Rules

- **Everything shown really runs.** Don't fake output, mock a terminal, or paste results in. If
  something on screen is staged (seeded data, a prepared repository), the narration says so.
- **Show time honestly.** Long waits play sped up and tagged `N×` on screen. Cutting a failure so
  a retry looks like a first success is not allowed.
- **No personal data or secrets on screen**: names, emails, identifying home paths, tokens, keys,
  private repositories, notifications. Keys live in environment variables, never in `.ghostcast/`.
  Check the stills.
- **Only the user approves.** Run `ghostcast approve storyboard` only after they have said yes.
- **Ask first** before anything outward-facing or costly: accepting licenses (`ghostcast vscode
  --accept-server-license-terms`), model or API calls that spend budget, pushing, publishing or
  uploading.
- **Never record the user's real screen or windows**, and never work in their checkout: shoots
  run in the isolated copy, and a write that reaches the checkout fails the shoot.

## Beyond the storyboard

`ghostcast init <dir>` makes a sample project of hand-written code scenes (`scenes/*.mjs`,
`timeline.json`), the engine the studio compiles to; `docs/scene-api.md` documents it. When
something misbehaves, read `docs/gotchas.md` before debugging from scratch.

---
name: ghostcast
description: Make a demo video or screencast of real software (terminal commands, web apps, VS Code, agent CLIs), filmed headlessly in an isolated copy of the project while the user keeps working. Use when asked to record a demo, screencast, how-to, launch or feature video, a README GIF, or a video for a pull request.
---

# ghostcast

A headless studio. It films real software in an off-screen Chrome, inside a disposable copy of
the project, so nothing on the user's screen is recorded and nothing in their checkout changes.
Then it cuts, zooms, captions and tags what it filmed.

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
2. **Brief.** Fill `.ghostcast/brief.md` **with the user**: audience, goal, weight, type
   (launch, how-to, feature, receipt), the length cap, destinations, audio. Ask; don't invent.
3. **Storyboard.** `ghostcast template <type>` writes a skeleton with the type's narrative
   frame; replace every `<placeholder>` with real beats (reference below). Set up the world in
   `.ghostcast/world.yaml` when the product needs a server, seed data or ignored files.
4. **Lint.** `ghostcast lint` checks the files and estimates each beat against the cap. Fix
   every error. Never raise the cap on your own: cut or tighten beats.
5. **Approve.** Show the user each beat (what it shows, what it says) and the estimated runtime.
   Only when **they** say yes, run `ghostcast approve storyboard`. Any later edit reopens the
   approval; `next` names the beats that changed.
6. **Rehearse.** `ghostcast rehearse` runs every beat three times without filming. Fix the beats
   it reports (a failing or flaky beat, a target that never appears, text too small), then
   `ghostcast rehearse <ids>` to retry just those, and a full `ghostcast rehearse` to confirm.
7. **Shoot.** `ghostcast all` films the storyboard, cuts and assembles
   `.ghostcast/out/<video>-silent.mp4`.
8. **Look.** `ghostcast review final` writes a contact sheet; `--at <seconds>` a full-size still.
   **Open the images and look.** Is the text legible? Is the right thing framed? Is anything
   stuck, cut off, or personal? Fix the storyboard and shoot again.

## The storyboard

```yaml
# .ghostcast/storyboard.yaml
video: first-invoice
type: how-to
cap: 90
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
- **panel**: `{ use: title | chapter | cta, title, subtitle, foot }`, or `{ html: panels/x.html,
  data: {…} }`. Panels frame the story, at most a fifth of the runtime; they never mock the
  product.
- **camera**: `wide` keeps the full frame for that beat.
- **script**: `scenes/x.mjs`, a code scene for a beat the storyboard can't express
  (see `docs/scene-api.md`).
- Never edit `cache/storyboard.mjs` or `timeline.json`: they are generated from the storyboard.

## Voice-over

Built-in speech comes later. Until then the user records clips; you place them. Put the clips in
`.ghostcast/voiceover/`, run `ghostcast pauses voiceover/*` to find sentence breaks, write
`voiceover/plan.json` with pieces anchored to `take: storyboard` and `segment: <beat id>`, then
`ghostcast vo-mix` and fix everything under "Problems" in its report.

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

# ghostcast — vision

*Where ghostcast is going, and why. September 2026.*

ghostcast films real software in the background: terminals, editors and web apps, directed from
intent and checked against the page itself. It works in two ways:

- **as a studio** for videos of developer tools, driven by the coding agent you already use, from
  plan to finished cut;
- **as an engine** that other video pipelines call when they need real footage of real software.

Either way, you are asked for decisions, never for your screen, and your own work is never
touched.

Version 0.1 is the recording engine: scripted scenes, headless capture of real terminals, editors
and web pages, cutting, zooms, captions and voice-over placement. This document describes what is
built on top of it. [What exists today](#today-version-1-and-after) is listed at the end.

## Who it's for

- **People building developer tools with coding agents**: CLIs, SDKs, MCP servers, editor
  extensions, agent tools. Their videos cross a terminal, an editor and a browser, and web-only
  tools can't film them. They get the studio.
- **Video pipelines and agents that need real footage**: production systems, HTML video
  compositions, custom scripts. They get the engine: clips of the real product, with the
  metadata to compose them.
- **Anyone making how-to videos of a product that runs locally** in a browser or a terminal,
  through either route. Developer tools come first; this follows.

## Promises

1. **It stays out of your way.** That is the ghost in the name. Everything is captured from a
   headless browser, so nothing on your screen is recorded and nothing on it is touched: no
   windows, no focus changes, no keystrokes into your apps. Heavy work runs at low priority. You
   are interrupted only at decision points.
2. **It never touches your work.** Every shoot runs in an isolated copy of the project, with its
   own ports, database and browser profile. Resets and seed data happen in the copy. Your working
   tree, your dev server and your data stay as they were, and a check confirms it after every
   shoot.
3. **Everything shown is real.** Product shots are the real product running. ghostcast never
   draws a fake terminal or rebuilds a UI in code. Slides and animations frame the story but never
   depict product behaviour. Sped-up time is tagged on screen. Staged or replayed content carries
   a label saying so.
4. **The agent writes intent; ghostcast directs.** A beat says what to do, what the viewer should
   see, and what is said. ghostcast decides the timing, the camera, the holds and the cursor
   path. Agents are good at intent and bad at timing they cannot feel.
5. **No model inside.** ghostcast makes no LLM calls. The host agent (Claude Code, Codex, or any
   other) does the thinking; ghostcast gives it structure, checkpoints, and material to review.
   Speech is generated locally by default. The only external call is to a speech service you
   bring your own key for, and it is cached and asked about first.
6. **Plug in, don't rebuild.** Planning frameworks, motion graphics, slides and speech models
   exist and are done well elsewhere. ghostcast builds only what nobody else does: real, headless
   footage, directed and checked.
7. **A video is a build output.** The plan and the live product are the source of truth. When
   the product changes, the video is re-shot, not re-edited. Generated narration is regenerated;
   a recorded line whose wording no longer matches the product is flagged for re-recording.

## Two ways to use it

### The studio

For developer-tool videos, ghostcast owns the whole path: understand, plan, prepare, rehearse,
shoot, check, voice, render (see [How a video gets made](#how-a-video-gets-made)). Planning and
speech stay thin (templates and one adapter) because that is not where videos are won. Filming,
direction and checks are where the effort goes.

### The engine

Other pipelines hand ghostcast beats (or a code scene) and get back real footage:

```
$ ghostcast shoot beats.yaml --json
```

The result is a clip per beat plus a manifest: each beat's timing, the rectangles the camera
framed, whether each `show` target was visible, the page text at key frames, and the check
results. A pipeline composes from that without re-analysing the video.

The engine's interface is a stable command line with JSON output first; an MCP server follows.
Two integrations are the goals:

- **OpenMontage**, whose Screen Demo pipeline draws terminals synthetically and records real apps
  through desktop or browser capture. ghostcast would be a capture tool it calls as a separate
  process, which also keeps the licenses apart (ghostcast is MIT, OpenMontage is AGPL-3.0).
- **HyperFrames**, in both directions: ghostcast clips as media inside HyperFrames compositions,
  and HyperFrames compositions as panels inside ghostcast videos.

## Three weights

Not every video deserves a production.

| Weight | For | What it takes |
|---|---|---|
| **Quick** | One command or one page: a README loop, a clip for a pull request | One command, no plan files, no approvals: `ghostcast shoot "npm test"` |
| **Standard** | A how-to, a feature update | A storyboard and the checks; you approve the storyboard and the cut |
| **Production** | A launch video, a submission, a talk | Every stage below, with voice and every approval |

The first video should come within five minutes of installing: a quick shoot, no configuration.

## How a video gets made

The plan lives in a `.ghostcast/` folder inside the project, next to the code it shows. Shoots
happen in the isolated copy.

| Stage | The agent | ghostcast | You |
|---|---|---|---|
| **Understand** | Reads the README, routes, CLI help and changelog; works out how to run, seed and sign in; writes `product.md` | Provides the questionnaire and checks it is complete | |
| **Plan** | Chooses the weight and video type; writes the brief and the storyboard: one beat per claim, each with what to do, show and say | Lints the plan: one claim per beat, narration fits its beat, panels within their share, total within the cap | Approve |
| **Prepare** | Declares services, seed data, sign-in, and panel content | Makes the isolated copy, allocates ports, starts services, seeds data, scans the page for personal data and secrets | |
| **Rehearse** | Fixes the steps that fail | Dry-runs every beat three times and flags flaky ones | |
| **Shoot** | | Records each beat under the camera policy (below), with holds sized to the narration and to reading time | |
| **Check** | Reviews each beat's stills against what the beat promised; fixes what's flagged | Runs the checks (below); writes the report and per-beat sheets | |
| **Voice** | Picks the pieces for each beat when your clips don't say | Generates speech, runs the recording booth, or aligns your clips; places audio by beat; normalises loudness | Choose the source; approve any paid generation |
| **Render** | | Renders each beat, joins them, and produces the delivery versions | Approve the cut |

The agent moves through the stages with one command:

```
$ ghostcast next
rehearse · 7 of 9 beats pass
  ✗ send     step 1 flaky (2 of 3 runs): the prompt did not return within 60 s
  ✗ install  show target "Installed" never appeared
next: fix those beats, then run `ghostcast rehearse send install`
```

The workflow lives in the tool, not in instructions the agent must remember. `SKILL.md` shrinks
to: run `ghostcast next`, do what it says, keep the rules.

### The project folder

```
.ghostcast/
  product.md        what the agent learned: how to run, seed and sign in; the flows worth showing
  brief.md          audience, goal, weight, video type, length cap, destinations, audio source
  storyboard.yaml   the beats
  world.yaml        services, seed data, sign-in, test keys, references to secrets
  panels/           panel instances: a template or any HTML, plus its data
  audio.yaml        speech provider and voice, or your own clips
  scenes/           code scenes, for beats the storyboard can't express
  cache/ raw/       captured takes and rendered beats (git-ignored)
  out/              the video, its delivery versions, subtitles, cue sheet, check report
```

### A beat

```yaml
# .ghostcast/storyboard.yaml
video: first-invoice
weight: standard
type: how-to                  # launch | how-to | feature | receipt
cap: 90
beats:
  - id: intro
    surface: panel
    panel: { use: title, title: Send your first invoice }
    say: In two minutes, send an invoice from the app and from the CLI.

  - id: create
    surface: web
    open: /invoices
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

No sleeps, zoom calls or timestamps. `show` is what the viewer must see: the camera goes there,
the hold lasts until the line is said and read, and the checks confirm it was visible.

Actions use a handful of verbs that map one to one onto Playwright (`open`, `click`, `fill`,
`press`, `run`, `wait`). Anything else is written as Playwright code, which agents already write
well, or as a code scene (`script: scenes/custom.mjs`) using today's scene API. There is no action
language to learn, and none will grow.

## The world

Most of the work in a real demo is the world it happens in. ghostcast makes it declared and
repeatable.

- **An isolated copy.** A git worktree at the chosen commit, or a copy of the working tree as it
  is now, including uncommitted changes. Resets happen here, never in your checkout.
- **Its own ports, database and browser profile**, so the demo never collides with the dev
  server you are running or the data you are using.
- **Services** declared in `world.yaml`, started before a shoot and stopped after it.
- **Local by default.** ghostcast films your product running on localhost. Third-party steps in
  the flow use their test modes or happen off camera:
  - sign-in: a test user or dev login, the provider's emulator or testing tokens, or a session you
    sign in once yourself in a visible window, which ghostcast then reuses;
  - CAPTCHAs: the test keys reCAPTCHA and Turnstile publish for exactly this;
  - payments: the provider's test mode.
- **Not the target:** videos mainly about someone else's live site. Bot protection blocks
  automated browsers there, and it isn't your product.
- **Shoot when idle.** Capture shares the CPU with whatever you're doing. Frames carry
  timestamps, so timing stays true, but on a busy machine motion can stutter. Shoots can wait
  for an idle machine.

## Surfaces

What ghostcast can film, all inside the same headless browser:

- **Web**: the product's local dev server, or any URL that allows it.
- **Terminal**: a lightweight terminal page (xterm.js over a real shell through node-pty), with no
  editor required. Agent TUIs such as Claude Code run in it for real.
- **Editor**: VS Code in the browser (`code serve-web`), for beats that need files and a terminal
  together. Opt-in, because it needs its license accepted.
- **Panel**: any HTML: title and chapter cards, slides, diagrams, animated code, motion graphics.
- **Later**: Electron apps, which Playwright has experimental support for. Native desktop and
  mobile apps are out of scope.

## Camera

Automatic zoom that fires on every click makes viewers seasick, and users of auto-zooming screen
recorders ask for ways to switch it off. ghostcast's camera follows a policy instead:

- it moves for a beat's `show` target, not for every action;
- actions close together share one shot;
- every framing holds for a minimum time, and camera moves per minute are capped;
- a beat can override: `camera: wide`, `camera: follow`, or a target of its own.

## Audio

The script is the contract; any source can fulfil it.

- **Generated speech.** Kokoro is the default: it runs locally and free, so no video needs an
  API key. For a more natural voice, bring your own ElevenLabs key; its API also returns
  per-character timing, which sharpens subtitles and word-exact cues. Other providers follow the
  same pattern. Clips are cached by text, voice and provider, so re-shoots don't pay twice.
- **The recording booth.** A local page plays each beat's picture while you read its line, and
  any line can be retaken on its own. Clips arrive already assigned and fitted to their beats,
  so there is nothing to align.
- **Clips you already have** are aligned to the script locally (Whisper) and split at pauses.
  Nothing is sent to a cloud service unless you opt in.
- **Scratch first.** Generated speech times the cut before anyone records; recorded lines then
  replace it beat by beat.

Audio is placed by beat, not by timestamp. When the picture is re-shot, the audio moves with its
beats; a beat that becomes too short for its line is reported.

When a beat's picture runs longer than its line, the picture is fitted without visible cuts.
Still holds shorten first, since a frame where nothing moves can lose time unnoticed. After
that, the parts that move (zooms, scrolls, typing) play faster rather than being cut into: a
trim inside a move makes the picture jump. Speed-ups of 1.5× and more are tagged on screen, like
any other.

## Panels

Panels are HTML pages recorded like any other surface, so anything that renders in a browser is
one: Slidev slides, Mermaid diagrams, Shiki Magic Move code, HyperFrames compositions. ghostcast
ships a few templates (title, chapter, call to action) driven by one brand file (colours, fonts,
logo), and no framework of its own.

Panels frame the story; the product carries the claims. By default panels fill at most about a
fifth of the runtime, and they never show mocked product UI.

## Checks

Because ghostcast records from the page itself, it knows what is on screen: every element's
position, its text and its font size. Checks can be exact instead of guessed from pixels.

Run on every shoot:

- text too small once zoomed (font size × zoom × output scale);
- frames that are mostly empty space with nothing framed;
- a caption that covers the framed content, stays up across several beats, or is too long to
  read in its time;
- a `show` target never visible, or visible too briefly to read;
- narration longer than its beat;
- narration that quotes on-screen words the page no longer shows (a renamed button, a changed
  message);
- a frozen picture beyond the planned hold;
- a cut inside a move (a zoom, scroll or typing still under way), which makes the picture jump;
- camera moves beyond the policy; cursor moves too fast;
- personal data or secrets in the page text (emails, tokens, identifying home paths);
- your working tree, ports or data touched outside the isolated copy;
- panels over their share of the runtime; a total over the cap.

Judgement checks are the agent's, and they are made checkable. For each beat the agent reports
what it sees in the stills, including the text on screen, and ghostcast compares that with the
page text it recorded at that moment. A confirmation that doesn't match is rejected, so a beat
can't be approved without being looked at. `ghostcast next` doesn't move on until the report is
clean.

## Rendering and delivery

Each beat is rendered on its own and cached; the video is the beats joined. Fixing one caption
re-renders one beat, which keeps the agent's loop fast.

Where a video goes decides its shape, so delivery versions are presets:

- **GitHub**: under 10 MB for repositories on free plans (100 MB on paid ones), with a strong
  first frame, since GitHub shows a player that doesn't autoplay.
- **Social feeds**: they autoplay muted, so the narration is burned in as captions.
- **YouTube**: chapters from the beats.
- **Submissions** (hackathons, conferences): their length cap, checked on every render.
- **Docs and READMEs**: a short loop per beat.

Subtitles (SRT, VTT) and the cue sheet come with every render.

When the product changes, `ghostcast reshoot` records again and compares each beat with the last
approved cut: steps that fail, beats whose length drifts, stills that changed, narration whose
wording no longer matches. You approve the differences; generated lines regenerate, recorded ones
that no longer match are listed for re-recording.

## Integrations

| Need | Tool | License | Role |
|---|---|---|---|
| Browser control and capture | Playwright, including its screencast API where it fits | Apache-2.0 | Core |
| Terminal surface | xterm.js, node-pty | MIT | Built in |
| Editor surface | VS Code `serve-web` | VS Code Server license | Opt-in; you accept the license |
| Speech | Kokoro through kokoro-js, locally (the default); ElevenLabs with your own key; others later | Apache-2.0; API | Adapters |
| Aligning your clips | faster-whisper or whisper.cpp, locally | MIT | Built in |
| Encoding | ffmpeg | LGPL/GPL | Required on the machine |
| Panels | Any HTML: HyperFrames, Slidev, Mermaid, Shiki Magic Move… | Their own | Recorded as pages; no plugins needed |
| Production pipelines | OpenMontage | AGPL-3.0 | Calls ghostcast as a separate process (goal) |
| Agents | `SKILL.md`, a Claude Code plugin; an MCP server later | | Distribution |

Two are deliberately not bundled:

- **Remotion** is free for individuals and small companies, but companies of four or more people
  need a paid license. ghostcast accepts Remotion renders as clips, and nothing more.
- **GSAP**, which HyperFrames compositions often use, is free but under a proprietary license with
  use restrictions. Users who want it bring it with HyperFrames.

## What ghostcast won't do

- Draw a fake terminal, rebuild a product UI in code, or generate footage.
- Compete with production systems on breadth: research, generated video, avatars, stock
  footage, music generation.
- Build its own motion-graphics, slide or speech framework.
- Call a language model itself.
- Capture a real desktop or screen.
- Make clickable interactive demos, or run as a hosted service.

## Where it stands

As of September 2026, agentic planning, approval gates, generated narration and per-beat
rendering are common in agent video tools. ghostcast doesn't claim them as its difference.

| Kind | Examples | Good at | How it films software |
|---|---|---|---|
| Agentic production systems | OpenMontage | Many video types, a staged workflow with approvals, many speech and footage providers | Terminals drawn synthetically; real apps through desktop capture or Playwright |
| Agent demo tools | openvidstudio, aidemo, reelson, agent-demo-video, screencli, playwright-recast | Web-app demos from a plan or test, narrated by generated speech; aidemo also has pre-recording lint, QA, variants and local speech | Browser capture. Pointed at VS Code in the browser, some can film a terminal and an editor, but with no help for either ([bake-off](docs/bakeoff.md)) |
| UI rebuilt as code | agentic-product-demo | Pixel-perfect motion from the product's code | Not filmed: the UI is recreated in Remotion |
| Record yourself, polished by AI | Screen Studio, OpenScreen, Clueso, Guidde, Trupeer | Auto-zoom and voice on a human performance | Your desktop, while you perform |
| Agent proof of work | Cursor cloud agents, Devin, Playwright's agent CLI | Showing a reviewer that a change works | Cloud machines, or raw browser recordings |
| Terminal as code | VHS, asciinema | Terminal recordings regenerated in CI | A real shell; no editor, browser, zoom or voice |

ghostcast's ground is narrower and specific:

1. real terminals, a real editor and real web apps, filmed as pixels, headlessly, and reliably:
   trust dialogs and layout handled, typing confirmed on screen, the prompt waited for;
2. nothing on your screen touched, and nothing in your working copy either;
3. a camera and checks driven by what's on the page;
4. everything shown is real, so anyone can re-run the demo, and fitting a video to its voice
   never cuts the moment a beat is about (the [bake-off](docs/bakeoff.md) shows what happens
   when it does);
5. your own voice, placed by beat, alongside generated speech.

## Proof

The reference is a real production: a 2½-minute demo of Skilldex, an open-source (MIT) tool, with
nine takes across terminals, stacked editors, an agent CLI on camera and a website, and a human
voice-over in seventeen placed pieces. It was directed by hand, and its hand work is what the
stages above absorb: separate demo repositories reset by script, services started by hand,
one-off panels, hand-tuned sleeps and zooms, clips placed one by one.

The test is to remake it from a brief through the studio, and to try the other tools on the same
product. ghostcast is on track when:

- a first clip comes within five minutes of installing;
- a fresh agent session goes from brief to a publishable production video in about an hour,
  with your attention measured in minutes: approvals and, if you choose, reading lines;
- no issue the checks can catch reaches the final cut;
- your working tree is never touched;
- a product change costs a re-shoot, an approval, and re-recording only the lines whose wording
  changed.

The launch showcase is that remake, and ghostcast's own README video, made by ghostcast.

## Today, version 1, and after

**Today (0.1)** has the engine's core: the scene API; headless capture that keeps frames coming;
typing into real terminals and VS Code, verified on screen; cutting to segments with honest speed
tags and eased zooms; captions, a length cap and a cue sheet; review sheets; and placing recorded
voice clips by beat. It is verified on Windows.

**Version 1** is clearly better at one thing: real developer-tool videos, made in the background.

1. **Install**: one command (`npx ghostcast`), post-production moved off Python, the lightweight
   terminal; macOS and Linux verified.
2. **Isolation**: the isolated copy, its own ports, database and profile; the check that your
   work is untouched.
3. **Plan, direction and checks** for terminal, editor and web: `.ghostcast/`, the storyboard,
   `ghostcast next`, the camera policy, holds, the checks and the report.
4. **Quick shoots**: `ghostcast shoot` with no plan files.
5. **Per-beat rendering** with a cache.
6. **Voice**: Kokoro by default, ElevenLabs with your own key, and the recording booth.
7. **Delivery**: the presets, with narration burned in as captions.
8. **The engine interface**: the command line with JSON output and the manifest.

The Skilldex remake runs alongside as the test case.

**After version 1**, roughly in order: a local review page (play the cut, leave notes per beat
for the agent); a music bed with ducking, an optional framed look, and a keystroke overlay for
how-tos; the OpenMontage and HyperFrames integrations; more speech adapters; the MCP server;
`ghostcast reshoot` in CI; 9:16, locale and theme versions; Electron apps.

## Open questions

- **Agent CLIs on camera.** Their output varies and every take costs money. Record until the
  checks pass, or replay a recorded session with a label saying so?
- **Post-production without Python.** Composite in the headless browser (canvas crops, HTML
  captions), or in ffmpeg filters?
- **The engine's contract.** What OpenMontage's Screen Demo pipeline and HyperFrames need from a
  clip and its manifest, settled with their maintainers before the format is fixed.
- **Uncommitted work in the isolated copy.** How to carry it over without touching the checkout
  (for example `git stash create` plus a worktree), including files git ignores.
- **Defaults for the checks and the camera.** Minimum text size, panel share, reading speed,
  camera moves per minute: they need tuning against real cuts.

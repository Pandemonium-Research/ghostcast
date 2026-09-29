# ghostcast

*Screencasts with nobody at the keyboard.* ghostcast films real software in the background
(terminals, editors and web apps) while your agent directs.

> **Status: 0.1, with Node post-production.** Everything below works today. [VISION.md](VISION.md)
> describes the product being built on it, and [PLAN.md](PLAN.md) the stages toward version 1.

An agent writes a scene per shot: open a clean terminal on a project, type a command, zoom onto the line
that answers it. ghostcast plays the scene in an off-screen Chrome and keeps every frame, so
nothing on your screen is recorded and nothing on it gets in the way. The frames become a
finished video:

- cut to the beats;
- eased into zooms on what matters;
- captioned;
- tagged wherever time is sped up;
- with recorded narration laid on the beats it describes.

Post-production is deterministic: a retake is one command, and the edit is data
(`timeline.json`, `voiceover/plan.json`), not a timeline in a video editor.

For a product checkout, add `world` to `project.json` with `source` pointing to it. Each shoot
uses a disposable copy under the ghostcast cache. Snapshot mode includes current uncommitted
edits and untracked files; commit mode checks out a chosen `ref`. The source is fingerprinted
before and after recording. See [the world example](templates/project/world.example.json) and
[scene API](docs/scene-api.md).

Recording real tools without a screen has sharp edges: frames that stop arriving, keystrokes
that vanish, terminals that ignore synthetic input. ghostcast handles them, and
[`docs/gotchas.md`](docs/gotchas.md) explains each one.

```
scene.mjs ──record──▶ raw/<take>/ frames + event log
                         │ cut: render cached beats with zooms, captions and speed tags
                         ▼
                      clips/<take>.mp4 ──assemble: stream copy, cap check────────▶ out/<name>-silent.mp4
                                                                                   │ + cue sheet
                      voiceover/*.m4a + plan.json ──vo-mix: place, fade, −16 LUFS──▶ out/<name>.mp4
```

## Why ghostcast

Plenty of tools make videos with agents now. Most film a web app and narrate it with generated
speech; some draw terminals instead of filming them, or rebuild the product's UI in code.
ghostcast is for videos of software as it really runs.

- **Real terminals, a real editor, real web apps, filmed as pixels.**
  - Terminal scenes use a local xterm page with a clean, real shell. Editor scenes can use VS Code
    in the browser (`code serve-web`).
  - Commands are typed at a human pace, checked on screen before Enter, and waited on until the
    prompt returns.
  - Agent CLIs (Claude Code, Codex) can run on camera.
  - Nothing is drawn or rebuilt.
- **In the background.** Everything is captured from a headless browser: nothing on your screen
  is recorded, and nothing on it is touched.
- **Framed from the page.** ghostcast knows what's on the page, so zoom rectangles fit the text of
  a terminal row or an editor line, not a guess from pixels.
- **Honest by design.**
  - Everything shown really runs.
  - Every sped-up stretch is tagged `N×` on screen.
  - A length cap is checked on every assemble, and a cue sheet gives every beat's start.
- **Your own voice, placed by beat.**
  - The narrator reads from a generated script that says whether each block fits.
  - Their clips are split at detected pauses, and each piece is anchored to the beat it describes.
  - The mix is normalised for broadcast loudness.
- **Agents review their own footage.** Contact sheets and stills are PNGs an agent can look at,
  and a failed take leaves a screenshot of where it stopped.

## Quick start

From the directory you want to film:

```bash
npx ghostcast shoot "npm test"
npx ghostcast shoot https://example.com
```

Each quick shoot writes a 1080p `<name>.mp4` and a looping `<name>.gif` in the current
directory. A command runs in a disposable copy of that directory; `--in <dir>` chooses another
source, `--out <file>` chooses the output name, `--timeout <seconds>` caps a command's wait,
and `--keep` retains the temporary project for inspection. A command's exit code is reported
even when it fails. No project files are needed.

Requirements:

- Node 20+ and Google Chrome (or Edge, via `browser.channel`).
- ffmpeg on `PATH`.
- On Windows, Git Bash for terminal scenes; on macOS and Linux, `/bin/bash`.
- The `code` CLI only for editor scenes.

`npx ghostcast doctor` checks them.

### A planned video

For a how-to, a feature or a launch, the plan lives in `.ghostcast/` next to the code it shows,
and `ghostcast next` says what to do at each step:

```bash
npx ghostcast init                # adds .ghostcast/: product.md, brief.md, world.yaml, audio.yaml
npx ghostcast next                # where the video stands, and the one next action
npx ghostcast template how-to     # a storyboard skeleton: launch, how-to, feature or receipt
npx ghostcast lint                # one claim per beat, word budgets, panel share, the cap
npx ghostcast rehearse            # every beat three times, without filming; flaky beats reported
npx ghostcast approve storyboard  # after the user has approved the rehearsed plan
npx ghostcast all                 # film the storyboard, cut and assemble
npx ghostcast review final        # contact sheet in .ghostcast/out/review/final.png
```

A storyboard is a list of beats, each with what to do (`click`, `fill`, `press`, `run`, `wait`,
or Playwright code), what the viewer must see (`show`) and what is said (`say`). There are no
sleeps, zoom calls or timestamps in it. [`SKILL.md`](SKILL.md) has the format.

Only editor scenes need `ghostcast vscode --accept-server-license-terms`. Read the VS Code Server
license before using that command. Its first run downloads the server; wait for "VS Code is ready"
before recording an editor scene.

`ghostcast init <dir>` makes a sample project of hand-written code scenes (a title card, a
terminal take and a web take, about 30 s): the engine the storyboard compiles to, documented in
[`docs/scene-api.md`](docs/scene-api.md).

**For agents:** load [`SKILL.md`](SKILL.md). It has the workflow and the rules (honest timing,
nothing faked, no personal data, only the user approves, ask before costly or outward-facing
steps).

## Commands

| | |
|---|---|
| `ghostcast shoot <command\|url> [--in dir] [--out file] [--timeout seconds] [--keep]` | Film one command or page into an MP4 and GIF, with no project |
| `ghostcast init` | Add `.ghostcast/` to this repository |
| `ghostcast next [--json]` | Where the video stands, and the one next action |
| `ghostcast template <type> [--force]` | Storyboard skeleton: launch, how-to, feature or receipt |
| `ghostcast lint [--json]` | Check the plan files and estimate each beat against the cap |
| `ghostcast approve storyboard` | Record the user's approval against the storyboard's hash |
| `ghostcast compile` | Storyboard → generated scene and timeline (record and all do this first) |
| `ghostcast rehearse [beat…] [--runs 3] [--headed]` | Dry-run beats without filming; flaky beats reported |
| `ghostcast init <dir>` | A sample project of hand-written code scenes |
| `ghostcast doctor` | Check the toolchain |
| `ghostcast vscode [--port]` | Serve VS Code for editor scenes, with its settings and clean shell |
| `ghostcast record <take> [--headed] [--keep-world]` | Run a scene and capture it in one isolated world |
| `ghostcast cut <take…>` | Frames → cached beats and captioned clip: segments, speed, zoom |
| `ghostcast all [take…] [--keep-world]` | Share one world across takes, reset each take, then assemble |
| `ghostcast assemble` | Cached beats → silent cut by stream copy + cue sheet |
| `ghostcast review <take\|final> [--raw] [--at s]` | Contact sheets and stills |
| `ghostcast vo-script` | Narration timed against the cut, with fit warnings |
| `ghostcast pauses <audio…>` | Where to split voice-over clips |
| `ghostcast vo-mix` | Lay the voice-over → final video + placement report |

## A scene

```js
// scenes/build.mjs
export async function setup(h) {
  await h.terminal.open(h.world?.dir || 'workspace');
}

export default async function (h) {
  await h.seg('build_run', async () => {
    await h.run('npm test');
    await h.focusTerm('passing', { rows: 2 });
    await h.sleep(2000);
    h.unfocus();
  });
  await h.seg('build_publish@fit3', () => h.run('npm pack'));
}
```

## Where it's going

ghostcast is growing into two things (details in [VISION.md](VISION.md)):

- **A studio for developer-tool videos.** Your agent plans a storyboard with you; ghostcast
  prepares, rehearses, shoots, checks and voices it in the background. It uses Kokoro speech by
  default, ElevenLabs with your own key, or your own voice through a recording booth.
- **An engine** that other video pipelines call when they need real footage of real software.

Planned for version 1 ([PLAN.md](PLAN.md)):

- one-command install (`npx ghostcast`);
- quick shoots with no configuration;
- storyboards instead of scripts, with automatic camera, holds and checks;
- voice from any source, placed by beat;
- output presets for GitHub, social feeds, YouTube and submissions;
- a JSON interface for other pipelines.

## Status

Version 0.1, with post-production in Node. Beats are rendered once and cached under
`cache/beats/`; assembly joins those beats without re-encoding. No Python is needed. CI runs
the whole suite, real headless shoots included, on Windows, macOS and Ubuntu with Node 22, and
times a first clip from a clean install on each (29 to 46 s).

`npm test` runs the unit tests and an end-to-end smoke test; see [`test/README.md`](test/README.md).

## License

MIT. See [LICENSE](LICENSE).

## Related tools

If your video is a different kind, one of these may fit better:

- **Many kinds of video from one agent-driven pipeline:**
  [OpenMontage](https://github.com/calesthio/OpenMontage), with a screen-demo pipeline among
  many others.
- **A web app, narrated by generated speech:**
  - [openvidstudio](https://github.com/AnayDhawan/openvidstudio)
  - [aidemo](https://aidemo.top/)
  - [reelson](https://github.com/reelson/reelson)
  - [agent-demo-video](https://github.com/OrionArchitekton/agent-demo-video)
  - [screencli](https://screencli.sh)
- **The product's UI rebuilt as animation:**
  [agentic-product-demo](https://github.com/Alexwtlf/agentic-product-demo).
- **Recording yourself, polished automatically:**
  [OpenScreen](https://github.com/getopenscreen/openscreen) and
  [Screen Studio](https://screen.studio).
- **Terminal only:** [VHS](https://github.com/charmbracelet/vhs).
- **Motion graphics written as code:**
  [HyperFrames](https://github.com/heygen-com/hyperframes) and
  [Remotion](https://www.remotion.dev).

# ghostcast

*Screencasts with nobody at the keyboard.* ghostcast films real software in the background
(terminals, editors and web apps) while your agent directs.

> **Status: 0.1, the recording engine.** Everything below works today. [VISION.md](VISION.md)
> describes the product being built on it, and [PLAN.md](PLAN.md) the stages toward version 1.

An agent writes a scene per shot: open VS Code on a project, type a command, zoom onto the line
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

Recording real tools without a screen has sharp edges: frames that stop arriving, keystrokes
that vanish, terminals that ignore synthetic input. ghostcast handles them, and
[`docs/gotchas.md`](docs/gotchas.md) explains each one.

```
scene.mjs ──record──▶ raw/<take>/ frames + event log
                         │ cut: keep segments, speed up @fitN waits, ease zooms
                         ▼
                      clips/<take>.mp4 ──assemble: captions, N× tags, cap check──▶ out/<name>-silent.mp4
                                                                                   │ + cue sheet
                      voiceover/*.m4a + plan.json ──vo-mix: place, fade, −16 LUFS──▶ out/<name>.mp4
```

## Why ghostcast

Plenty of tools make videos with agents now. Most film a web app and narrate it with generated
speech; some draw terminals instead of filming them, or rebuild the product's UI in code.
ghostcast is for videos of software as it really runs.

- **Real terminals, a real editor, real web apps, filmed as pixels.**
  - VS Code runs in the browser (`code serve-web`) with a clean shell.
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

Requirements:

- Node 18+ and Google Chrome (or Edge, via `browser.channel`).
- ffmpeg on `PATH`.
- Python 3 with Pillow.
- The `code` CLI, for terminal and editor scenes.
- On Windows, Git Bash.

```bash
git clone <this repo> ghostcast && cd ghostcast
npm install                       # Playwright only; it uses your installed Chrome
node bin/ghostcast.mjs doctor
node bin/ghostcast.mjs init ../my-demo && cd ../my-demo

# Terminal/editor takes need VS Code served (read the license first; this flag accepts it):
node ../ghostcast/bin/ghostcast.mjs vscode --accept-server-license-terms &

node ../ghostcast/bin/ghostcast.mjs all          # record + cut every take, then assemble
node ../ghostcast/bin/ghostcast.mjs review final # contact sheet in out/review/final.png
```

The template records a title card, a terminal take and a web take (about 30 s). For convenience,
`npm link` puts `ghostcast` on your `PATH`.

**For agents:** load [`SKILL.md`](SKILL.md). It has the workflow and the rules (honest timing,
nothing faked, no personal data, ask before costly or outward-facing steps). The helpers are in
[`docs/scene-api.md`](docs/scene-api.md).

## Commands

| | |
|---|---|
| `ghostcast init <dir>` | New project from the template |
| `ghostcast doctor` | Check the toolchain |
| `ghostcast vscode [--port]` | Serve VS Code for the project, with its settings and clean shell |
| `ghostcast record <take> [--headed]` | Run a scene and capture it |
| `ghostcast cut <take…>` | Frames → clip: segments, speed, zoom |
| `ghostcast all [take…]` | Record + cut (one retry per take), then assemble |
| `ghostcast assemble` | Clips + captions → silent cut + cue sheet |
| `ghostcast review <take\|final> [--raw] [--at s]` | Contact sheets and stills |
| `ghostcast vo-script` | Narration timed against the cut, with fit warnings |
| `ghostcast pauses <audio…>` | Where to split voice-over clips |
| `ghostcast vo-mix` | Lay the voice-over → final video + placement report |

## A scene

```js
// scenes/build.mjs
export async function setup(h) {
  await h.vscode.open('/path/to/project', { sidebar: false });
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
- every shoot in an isolated copy of your project, so your checkout is never touched;
- quick shoots with no configuration;
- storyboards instead of scripts, with automatic camera, holds and checks;
- voice from any source, placed by beat;
- output presets for GitHub, social feeds, YouTube and submissions;
- a JSON interface for other pipelines.

## Status

Version 0.1, tested on Windows 11 with Chrome, VS Code 1.138, ffmpeg 8 and Python 3.14. The code
paths for macOS and Linux exist (Chrome channel, bash profile, fonts) but are untested.

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

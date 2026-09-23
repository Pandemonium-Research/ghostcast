# agent-screencast

A recording studio for coding agents. Scripted, headless screencasts of **real** terminals,
editors and web pages. They are cut to the beats, eased into zooms, captioned, tagged wherever
time is sped up, and laid with a human voice-over.

An agent writes a scene per shot: open VS Code on a project, type a command, zoom onto the line
that answers it. `studio` then plays the scene in an off-screen Chrome and keeps every frame, so
nothing on your screen is recorded and nothing on it gets in the way. Post-production is
deterministic: a retake is one command, and the edit is data (`timeline.json`,
`voiceover/plan.json`), not a timeline in a video editor.

It was built while recording a 2½-minute systems-demo video for a paper submission, and
generalised afterwards. [`docs/gotchas.md`](docs/gotchas.md) records what that took.

```
scene.mjs ──record──▶ raw/<take>/ frames + event log
                         │ cut: keep segments, speed up @fitN waits, ease zooms
                         ▼
                      clips/<take>.mp4 ──assemble: captions, N× tags, cap check──▶ out/<name>-silent.mp4
                                                                                   │ + cue sheet
                      voiceover/*.m4a + plan.json ──vo-mix: place, fade, −16 LUFS──▶ out/<name>.mp4
```

## Why another one

Several tools make product videos with agents; see the list below. Most drive a **web app**
with Playwright and narrate it with **TTS**. This one is for demos those tools don't cover.

- **Real terminal and editor sessions.** VS Code runs in the browser (`code serve-web`) with a
  clean shell. Commands are typed at a human pace, checked on screen before Enter, and waited
  on until the prompt returns. Agent CLIs (Claude Code, Codex) can run on camera. Zoom
  rectangles fit the text of a terminal row or editor line.
- **A human voice.** The narrator reads a generated script that says whether each block fits
  its time. Their clips are split at detected pauses, each piece is anchored to the beat it
  describes, and the mix is normalised for broadcast loudness.
- **Submission constraints.** A length cap is checked on every assemble. A cue sheet gives
  every segment's start. Every sped-up stretch is tagged on screen automatically.
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
git clone <this repo> agent-screencast && cd agent-screencast
npm install                       # Playwright only; it uses your installed Chrome
node bin/studio.mjs doctor
node bin/studio.mjs init ../my-demo && cd ../my-demo

# Terminal/editor takes need VS Code served (read the license first; this flag accepts it):
node ../agent-screencast/bin/studio.mjs vscode --accept-server-license-terms &

node ../agent-screencast/bin/studio.mjs all          # record + cut every take, then assemble
node ../agent-screencast/bin/studio.mjs review final # contact sheet in out/review/final.png
```

The template records a title card, a terminal take and a web take (about 30 s). For convenience,
`npm link` puts `studio` on your `PATH`.

**For agents:** load [`SKILL.md`](SKILL.md). It has the workflow and the rules (honest timing,
nothing faked, no personal data, ask before costly or outward-facing steps). The helpers are in
[`docs/scene-api.md`](docs/scene-api.md).

## Commands

| | |
|---|---|
| `studio init <dir>` | New project from the template |
| `studio doctor` | Check the toolchain |
| `studio vscode [--port]` | Serve VS Code for the project, with its settings and clean shell |
| `studio record <take> [--headed]` | Run a scene and capture it |
| `studio cut <take…>` | Frames → clip: segments, speed, zoom |
| `studio all [take…]` | Record + cut (one retry per take), then assemble |
| `studio assemble` | Clips + captions → silent cut + cue sheet |
| `studio review <take\|final> [--raw] [--at s]` | Contact sheets and stills |
| `studio vo-script` | Narration timed against the cut, with fit warnings |
| `studio pauses <audio…>` | Where to split voice-over clips |
| `studio vo-mix` | Lay the voice-over → final video + placement report |

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

## Status

Version 0.1, tested on Windows 11 with Chrome, VS Code 1.138, ffmpeg 8 and Python 3.14. The code
paths for macOS and Linux exist (Chrome channel, bash profile, fonts) but are untested.

## Related tools

If your demo is a web app narrated by TTS, these may fit better:

- [reelson](https://github.com/reelson/reelson): agent skills plus a CLI for product videos
  from web apps. It has a screencast mode.
- [aidemo](https://aidemo.top/): turns a prompt into a narrated web-app demo video over MCP.
- [agent-demo-video](https://github.com/OrionArchitekton/agent-demo-video): Playwright
  recording plus TTS for agent demos.
- [Agent Demo Studio](https://glama.ai/mcp/servers/khajaaijaz26/agent-demo-studio) and
  [OpenVidStudio](https://glama.ai/mcp/servers/AnayDhawan/openvidstudio): MCP servers that
  record with Playwright and compose with Remotion.
- [Pagecast](https://www.claudedirectory.org/mcp-servers/mcpware-pagecast): an MCP server that
  records browser pages.
- [OpenScreen](https://github.com/getopenscreen/openscreen): desktop screen recording, with
  zooms described in JSON.
- [Claude-Code-Video-Toolkit](https://github.com/wilwaldon/Claude-Code-Video-Toolkit):
  Remotion-based video generation with Claude Code.

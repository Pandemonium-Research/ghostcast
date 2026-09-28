---
name: ghostcast
description: Make a demo video or screencast of real software — terminal commands, VS Code, agent CLIs, web pages — recorded headlessly from scripted scenes, then cut, zoomed, captioned, speed-tagged and laid with a human voice-over. Use when asked to record a demo, screencast, walkthrough or submission video.
---

# ghostcast

A recording studio you drive from files. Each shot is a **scene** (a small ES module) that
Chrome plays off screen while every frame is kept. Post-production turns the frames into clips.
It keeps the logged segments, eases the zoom onto what you focused, speeds up and tags long waits,
adds captions, and lays the narrator's recorded clips on their beats.

Nothing on the user's screen is recorded, and nothing on it gets in the way.

The `ghostcast` command is `node <this package>/bin/ghostcast.mjs`. Run it from the project directory,
or pass `--project <dir>`.

## Before anything: agree the script

A demo is a sequence of **beats**, one claim each, shown and not asserted. Write the script
(beats, commands, what the viewer should notice, narration) and get the user's agreement before
building anything. Then map it:

- **take**: one continuous recording (one scene file), usually one screen or place.
- **segment**: a beat inside a take, `h.seg('take_beat', …)`. Only segments reach the video.
- **caption**: a short on-screen label for a segment (timeline.json).
- **narration block**: the words spoken over one or more takes (timeline.json → `narration`).

## Workflow

1. **Set up.**
   - `npm install` in this package, then `ghostcast doctor`. It checks Chrome, ffmpeg, Python and
     Pillow, and the VS Code CLI.
   - `ghostcast init <dir>` makes a project from the template: three sample takes (title card,
     terminal, web page) you can record straight away to check the machine.
   - For terminal or editor takes, VS Code must be served:
     `ghostcast vscode --accept-server-license-terms`. Run it in the background. **Ask the user
     before passing that flag.** It accepts the VS Code Server license on their behalf.
2. **Prepare the world the demo happens in.**
   - Use real projects with real names, in ordinary places. Don't use `demo/` or `test123`.
   - Use a clean shell: `vscode/shell.bashrc` has a `$` prompt, no history and no personal
     config.
   - Put keys in `vscode/secrets.env` and never show them.
   - Send traffic to local services rather than production when the user asks for that.
   - Write a reset step for anything a take changes, so every retake starts identical. Use a
     scene `setup`, `h.guardFiles`, or `git reset` in setup.
3. **Write a scene per take** in `scenes/<take>.mjs`. See `docs/scene-api.md` for the helpers,
   and the template's scenes for the patterns.
4. **Record, then look.**
   - Run `ghostcast record <take>`, then `ghostcast cut <take>`, then `ghostcast review <take>`.
   - **Open the contact sheet PNG and look at it.** Is the text legible at the zoom? Is the
     right line in focus? Is anything stuck, cut off, or personal?
   - Use `ghostcast review <take> --at <s>` for a full-size still.
   - When a take fails, the recorder saves `raw/<take>/failed.png` (or `setup-failed.png`).
     `ghostcast review <take> --raw` shows how far it got.
5. **Assemble.**
   - Add captions to `timeline.json`, then run `ghostcast all`, or `ghostcast assemble` if the clips
     are current.
   - Check `out/<name>.cues.md` and `ghostcast review final`.
   - Keep to the user's length cap (`output.capSeconds`). To shorten, speed up waits
     (`@fitN`), trim holds (`trims`), speed up a segment that contains a move (`speeds`), or
     cut beats. Never raise the cap on your own.
6. **Voice-over.** The user records it; you place it.
   - `ghostcast vo-script` writes `out/voiceover-script.md`: each block, where it starts, and
     whether it fits. Fix any "too long" first. Then give the user the file to read from.
   - The user puts the clips in `voiceover/`. Ask which clip is which block if the names don't
     say. Don't guess, and don't transcribe their voice with a cloud service.
   - `ghostcast pauses voiceover/*` lists each clip's pauses. Split the clips at sentence pauses
     into pieces, and anchor each piece to the beat it describes in `voiceover/plan.json`
     (template: `plan.example.json`).
   - Run `ghostcast vo-mix` and read the placement report. Fix every item under "Problems".

## Rules

- **Everything shown really runs.** Don't fake output, mock a terminal, or paste results in.
  If something on screen is staged (a prepared repo, a seeded database), the narration or a
  caption says so. The video must hold up if a reviewer runs the same commands.
- **Show time honestly.**
  - Speed up only through segment names (`@4x`, `@fitN`). ghostcast then tags those stretches
    `N×` on screen.
  - Cutting dead air between segments is fine. Cutting a failure so that a retry looks like a
    first success is not.
- **No personal data or secrets on screen.** That covers names, emails, home paths that
  identify someone, tokens, API keys, private repos and notifications. Check the stills.
  Headless Chrome uses the project's own profile, not the user's browser.
- **Ask first** before anything outward-facing or costly:
  - accepting licenses;
  - model or API calls that spend budget (agent CLIs on camera, LLM-backed commands);
  - pushing, publishing, or uploading the video.
- **Never record the user's real screen or windows.** Everything is captured from the
  headless browser.
- A failed take is never cut. `ghostcast all` retries once, then reports it.

## Files

- `project.json`: viewport (`dpr` 1.5 oversamples for sharp zooms), output size and fps,
  `capSeconds`, the VS Code URL, zoom limits, caption style, voice-over settings, `trims`.
- `timeline.json`: takes in order, optionally with a `scene` path, plus `captions`, plus
  `narration` blocks.
- `raw/<take>/`: frames, `frames.json`, `log.json`. Large; git-ignored.
- `clips/<take>.mp4` and `.json`: cut clips and their segment positions.
- `out/`:
  - `<name>-silent.mp4`, `<name>.mp4` and `<name>.cues.md`;
  - `<name>.placement.md` and `voiceover-script.md`;
  - `review/`: contact sheets and stills.

When something misbehaves, read `docs/gotchas.md` before debugging from scratch. Most failure
modes of headless capture, VS Code in the browser, and agent CLIs on camera are written down
there.

# Scene API

A scene is an ES module in the project, `scenes/<take>.mjs` by default. A timeline item's `scene`
field can name another path.

```js
export async function setup(h) { … }      // optional; runs before capture starts
export default async function (h) { … }   // the captured part
export async function teardown(h) { … }   // optional; runs after, even when the take fails
```

Only what happens inside `h.seg(...)` reaches the video. Everything between segments is cut, so a
scene can do off-camera work, such as opening a file or changing the layout, between two segments.

Positions and rectangles are in CSS pixels of the viewport. With `viewport.dpr` 1.5, the capture
is 1.5× that and zooms up to 1.5× stay sharp.

## Segments

| Call | What it does |
|---|---|
| `await h.seg(name, async () => {…})` | Marks a beat. Pauses briefly on either side, so the cut's margins stay clean. |
| name ending `@4x` | Plays the segment at 4× (any factor); the video gets a `4×` tag. |
| name ending `@fit3` | Plays the segment in 3 s, however long it took (never slower than real time). Use it for installs, builds and model calls. |
| `project.json` → `trims: {name: seconds}` | Caps a segment's length in the clip, cutting the end of its closing hold. Right for a still hold; on a segment that is easing a zoom back out it cuts the move off part-way. |
| `project.json` → `speeds: {name: factor}` | Plays the whole segment faster without cutting anything out of it, so every move in it still completes. Use this where a trim would clip a zoom or a scroll. Factors of 1.5 and up are tagged on screen like any other speed-up. |

Name segments `<take>_<beat>`: captions and voice-over pieces refer to them by name.

## Pages and pointer

| Call | What it does |
|---|---|
| `await h.goto(url, {cursor, waitUntil})` | Navigates and re-injects the driver. Works in setup or mid-take. `cursor: false` loads with the cursor hidden. |
| `h.fileUrl('panels/card.html', {title: '…'})` | A project file as a URL, with query parameters. |
| `await h.point(target, ms)` | Glides the drawn cursor onto a target. A target is a Playwright locator (`h.page.getByRole(…)`), a CSS selector, `'text=Exact text'`, or `[x, y]`. |
| `await h.tap(target)` | Points, shows a ripple, then makes a real (trusted) click. |
| `await h.scroll(dy, {target, ms})` | Eased scroll of the page, or of an element by selector. |
| `await h.cursor(on)` | Shows or hides the drawn cursor. |
| `await h.type(text, {cps})` | Types at a human pace (about 17 characters a second, jittered) into whatever has focus. |
| `await h.press('Control+s')` | One key or chord (Playwright key names). |
| `h.page` | The Playwright page, for anything else. |

## Zoom and marks

| Call | What it does |
|---|---|
| `await h.focus(target, {zoom})` | From now on the view eases in on the target (applied in post). `zoom` caps the magnification. Returns the rectangle. |
| `await h.focusTerm('text', {rows, pad})` | Focuses the terminal row containing `text` (the last such row), plus `rows - 1` rows after it. |
| `h.unfocus()` | Eases back out to the full frame. |
| `await h.mark(target, color, opts)` | Draws a highlight on the page. It is part of the capture and zooms with the content. `opts` is a padding, or `{pad, shape, glow}`: `shape` is `'rect'` (default), `'circle'` or `'pill'`, and `glow` adds a halo (`'bare'` for the halo alone, no ring). `'circle'` squares the box to its longer side and centres it, so a round target — a graph node — gets a ring rather than an ellipse. |
| `await h.unmark()` | Fades every mark out. |
| `await h.termRect(text, opts)` / `await h.editorRect(text, {editor, rows})` | Rectangles around terminal rows or editor lines, fitted to the text. Pass them to `focus` or `mark`. |

A target narrower than the frame is needed for any zoom: a full-width block has nowhere to zoom
to. Focus the heading, the line, or the row.

## Terminal (VS Code in the browser)

| Call | What it does |
|---|---|
| `await h.vscode.open(folder, {sidebar, maximize})` | Loads VS Code on a folder (relative to the project, or absolute) and gives it a fresh, cleared terminal. `sidebar: false` hides both side bars. The panel is maximized by default. |
| `await h.run(cmd, {cps, after, timeout, ps})` | Types the command and checks it reached the terminal (fails the take if not), then presses Enter and waits for the bare `$` prompt. `timeout` is in ms (default 60 000). |
| `await h.waitFor(/regex/, timeout)` | Waits until the terminal's text matches, e.g. for a TUI (an agent CLI) that has no `$` prompt. |
| `await h.prompt({timeout, quiet, ps})` | Waits for the prompt without typing. |
| `await h.termText()` | The visible terminal text. |
| `await h.useTerm(i)` | Picks the terminal pane the helpers read, counted left to right. |
| `await h.vscode.focusTerminal(i)` | Moves keyboard focus into pane `i`, after a split (`h.vscode.command('Terminal: Split Terminal')`). |
| `await h.vscode.clearTerm()` | Clears the terminal (through the palette, which works whatever has focus). |

## Editor (VS Code)

| Call | What it does |
|---|---|
| `await h.vscode.command('View: Split Editor Down')` | Runs any command through the palette (F1). Prefer this to keybindings: with the terminal focused, many keys go to the shell. |
| `await h.vscode.openFile('src/app.ts')` | Quick Open (Ctrl+P). |
| `await h.vscode.gotoLine('42', {editor})` | Go to Line in an editor. Editors count top to bottom, then left to right. |
| `await h.vscode.focusEditor(i)` | Gives keyboard focus to editor `i`. |
| `await h.vscode.resizePanel(px)` | Sets the bottom panel's height (terminal below, editor above). |
| `await h.vscode.panelMaximized()` | Whether the panel fills the window. |

## Files, off camera

| Call | What it does |
|---|---|
| `h.guardFiles('path', …)` | Snapshots files, which are restored when the take ends, however it ends. |
| `h.editFile('path', [[from, to], …])` | Replaces exact strings (each must occur exactly once), keeping line endings. |

Paths are relative to the project. For repositories, prefer a reset in `setup`
(`git reset --hard && git clean -fd` through `child_process`), so every retake starts identical.

## Other

- `h.sleep(ms)` holds the frame, for the viewer to read.
- `h.log(label, data)` writes a raw log event.
- `h.project.root` and `h.config` give the project directory and `project.json`.

## Patterns

**An agent CLI on camera.** Launch it with `h.run`-style typing (`h.type` plus `h.press('Enter')`).
Wait on its own output with `h.waitFor(/done marker/)`, and speed up the wait with `@fitN`. Its
model calls cost money, so ask the user first. See `docs/gotchas.md` → *Agent CLIs*.

**Before and after, side by side.** Split the terminal (`Terminal: Split Terminal`), then
`h.vscode.focusTerminal(0)` / `(1)` and `h.useTerm(0)` / `(1)`. Run the two commands, then
`mark` both answers.

**A file and the command that reads it.** Open the file with `h.vscode.openFile`, then
`h.vscode.resizePanel(420)` so the editor shows above the terminal, then `h.editorRect` →
`h.focus`.

// Terminal take: a lightweight xterm page backed by bash, opened on the project's workspace/
// folder with the clean shell (vscode/shell.bashrc). No VS Code server is needed.
//
// h.run types a command at a human pace, checks it reached the terminal, presses Enter, and waits
// for the `$` prompt to come back. h.focusTerm zooms (in post) onto the row that contains a string.

// The rows the commands use. At full width a terminal holding a few lines is mostly empty page,
// which `ghostcast check` flags, so the take works framed on them.
const WORK = { x: 30, y: 30, w: 560, h: 320 };

export async function setup(h) {
  await h.terminal.open('workspace');
}

export default async function (h) {
  // Framed before the first beat, off camera: only segments reach the video.
  await h.focus(WORK);
  await h.sleep(800);

  await h.seg('terminal_list', async () => {
    await h.run('ls');
    // Long enough to read this beat's caption.
    await h.sleep(1400);
  });

  await h.seg('terminal_count', async () => {
    await h.run('grep -c TODO notes.md');
    // Zoom onto the answer, hold, and ease back to the working rows.
    await h.focusTerm('grep -c TODO', { rows: 2 });
    await h.sleep(2200);
    await h.focus(WORK);
    await h.sleep(900);
  });

  // A long wait (a build, a model call) played in 2 seconds; the video gets a "N×" tag for it.
  await h.seg('terminal_wait@fit2', async () => {
    await h.run('sleep 4 && echo done');
  });
}

// Terminal take: a lightweight xterm page backed by bash, opened on the project's workspace/
// folder with the clean shell (vscode/shell.bashrc). No VS Code server is needed.
//
// h.run types a command at a human pace, checks it reached the terminal, presses Enter, and waits
// for the `$` prompt to come back. h.focusTerm zooms (in post) onto the row that contains a string.

export async function setup(h) {
  await h.terminal.open('workspace');
}

export default async function (h) {
  await h.seg('terminal_list', async () => {
    await h.run('ls');
    await h.sleep(600);
  });

  await h.seg('terminal_count', async () => {
    await h.run('grep -c TODO notes.md');
    // Zoom onto the answer, hold, and ease back out.
    await h.focusTerm('grep -c TODO', { rows: 2 });
    await h.sleep(2200);
    h.unfocus();
    await h.sleep(900);
  });

  // A long wait (a build, a model call) played in 2 seconds; the video gets a "N×" tag for it.
  await h.seg('terminal_wait@fit2', async () => {
    await h.run('sleep 4 && echo done');
  });
}

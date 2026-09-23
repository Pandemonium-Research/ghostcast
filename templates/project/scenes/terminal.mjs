// Terminal take: VS Code in the browser (start it first: ghostcast vscode --accept-server-license-terms),
// opened on the project's workspace/ folder, with a clean shell (vscode/shell.bashrc).
//
// h.run types a command at a human pace, checks it reached the terminal, presses Enter, and waits
// for the `$` prompt to come back. h.focusTerm zooms (in post) onto the row that contains a string.

export async function setup(h) {
  // sidebar: false gives the terminal the full width; the panel is maximized by default.
  await h.vscode.open('workspace', { sidebar: false });
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

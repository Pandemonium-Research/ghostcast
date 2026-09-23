// Title card: a still page held for a few seconds. The same card makes an end card.
//
// A scene exports an optional `setup` (run before capture starts: open pages, prepare files) and a
// default function (the captured part). Only what happens inside h.seg(...) reaches the video.

export async function setup(h) {
  // Loaded off camera with its text held back (hold=1), so the take opens on the card, not on a
  // blank page waiting for it.
  await h.goto(h.fileUrl('panels/card.html', {
    title: 'Sample project',
    sub: 'Recorded headlessly, cut, captioned and voiced by agent-screencast',
    foot: 'studio init my-demo',
    hold: 1,
  }), { cursor: false });
}

export default async function (h) {
  await h.seg('title_card', async () => {
    await h.page.evaluate(() => window.play());
    await h.sleep(3500);
  });
}

// Web take: a page (here a local stand-in; any URL works) with the drawn cursor, an eased scroll,
// a drawn mark, a zoom, and a real click.
//
// Headless Chrome has no address bar; if the URL matters, put it in a caption.

export async function setup(h) {
  await h.goto(h.fileUrl('panels/site.html'));
}

export default async function (h) {
  const page = h.page;

  await h.seg('web_hero', async () => {
    await h.sleep(600);
    // Zoom needs a target narrower than the page: a full-width block has nowhere to zoom to.
    await h.focus(page.getByRole('heading', { level: 1 }), { zoom: 1.3 });
    await h.point(page.getByRole('link', { name: 'Get started' }));
    await h.sleep(1600);
    h.unfocus();
    await h.sleep(700);
  });

  await h.seg('web_install', async () => {
    await h.scroll(560);
    await h.sleep(500);
    await h.mark('#install pre');
    await h.focus('#install .row');
    await h.sleep(1000);
    await h.tap(page.getByRole('button', { name: 'Copy' }));
    await h.sleep(1400);
    await h.unmark();
    h.unfocus();
    await h.sleep(800);
  });
}

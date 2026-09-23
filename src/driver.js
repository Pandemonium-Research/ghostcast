// Page driver, evaluated in the page being recorded (by the recorder, after every navigation).
//
// Installs window.__rec: a drawn cursor with click ripples, eased moves and scrolls, drawn marks,
// rectangles for zoom focus (around elements, terminal rows, or editor lines), and the heartbeat
// that keeps headless Chrome's screencast sending frames. The event log lives in the recorder, not
// here, so it survives navigation.
//
// Terminal helpers assume VS Code's xterm.js with the DOM renderer
// (terminal.integrated.gpuAcceleration: "off"); with the canvas/WebGL renderer rows have no text.
(() => {
  if (window.__rec) return 'rec: already loaded';
  // The cursor position survives navigation within a tab, so a take that changes page does not
  // make the cursor jump back to the middle.
  const SS = 'rec.cursor';
  const saved = (() => { try { return JSON.parse(sessionStorage.getItem(SS)) || null; } catch { return null; } })();
  const state = saved || { x: innerWidth * 0.62, y: innerHeight * 0.55 };
  const save = () => { try { sessionStorage.setItem(SS, JSON.stringify({ x: state.x, y: state.y })); } catch {} };

  const st = document.createElement('style');
  st.textContent = `
#__rec_cursor{position:fixed;left:0;top:0;width:26px;height:26px;pointer-events:none;z-index:2147483647;will-change:transform;filter:drop-shadow(0 1.5px 2.5px rgba(0,0,0,.35))}
.__rec_rip{position:fixed;width:40px;height:40px;margin:-20px 0 0 -20px;border-radius:50%;border:2.5px solid rgba(201,100,18,.95);background:rgba(201,100,18,.16);pointer-events:none;z-index:2147483646;animation:__rec_rip .6s ease-out forwards}
@keyframes __rec_rip{from{transform:scale(.25);opacity:1}to{transform:scale(1.35);opacity:0}}
.__rec_mark{position:fixed;pointer-events:none;z-index:2147483645;border-radius:6px;border:3px solid var(--c);box-shadow:0 0 0 4px color-mix(in srgb,var(--c) 18%,transparent);opacity:0;transition:opacity .25s ease}
.__rec_mark.on{opacity:1}
::selection{background:transparent}`;
  document.documentElement.appendChild(st);

  const cur = document.createElement('div');
  cur.id = '__rec_cursor';
  cur.innerHTML = '<svg width="26" height="26" viewBox="0 0 26 26"><path d="M3 2 L3 20.5 L7.6 16.4 L10.7 23.3 L13.9 21.9 L10.9 15.1 L17.2 15.1 Z" fill="#fff" stroke="#1d1a16" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  document.documentElement.appendChild(cur);
  const place = () => { cur.style.transform = `translate(${state.x - 3}px, ${state.y - 2}px)`; };
  place();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const NBSP = / /g;

  // ---- pointer ---------------------------------------------------------------------------------
  // The drawn cursor fires real hover events on the way, so menus and tooltips react to it.
  let hoverEl = null;
  const fire = (el, type, x, y, extra = {}) => {
    if (!el) return;
    const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
    el.dispatchEvent(new Ctor(type, { bubbles: !['mouseenter', 'mouseleave', 'pointerenter', 'pointerleave'].includes(type), cancelable: true, composed: true, clientX: x, clientY: y, view: window, button: 0, buttons: extra.buttons ?? 0, pointerId: 1, pointerType: 'mouse', isPrimary: true, relatedTarget: extra.related ?? null }));
  };
  const hoverTo = (x, y, buttons = 0) => {
    const el = document.elementFromPoint(x, y);
    if (el !== hoverEl) {
      const prev = hoverEl;
      if (prev) { fire(prev, 'pointerout', x, y, { related: el }); fire(prev, 'mouseout', x, y, { related: el }); fire(prev, 'mouseleave', x, y, { related: el }); }
      if (el) { fire(el, 'pointerover', x, y, { related: prev }); fire(el, 'mouseover', x, y, { related: prev }); fire(el, 'mouseenter', x, y, { related: prev }); }
      hoverEl = el;
    }
    if (el) { fire(el, 'pointermove', x, y, { buttons }); fire(el, 'mousemove', x, y, { buttons }); }
    return el;
  };
  // A target is an element, a CSS selector, "text=Exact visible text", or [x, y].
  const q = (t) => { if (typeof t !== 'string') return t; if (t.startsWith('text=')) return findText(t.slice(5)); try { return document.querySelector(t) || findText(t); } catch { return findText(t); } };
  const findText = (want, sel = 'button,a,[role=button],[role=tab],[role=treeitem],label,h1,h2,h3,p,li,div,span') => {
    want = want.trim().toLowerCase();
    const c = [...document.querySelectorAll(sel)].filter((e) => {
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      return (e.getAttribute('aria-label') || e.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase() === want;
    });
    c.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
    return c[0] || null;
  };
  const center = (t) => {
    if (Array.isArray(t)) return { x: t[0], y: t[1] };
    const el = q(t);
    if (!el) throw new Error('rec: target not found: ' + t);
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, el };
  };

  // Bounding box of an element's visible characters, first to last non-blank. (Terminal rows and
  // editor lines span the full width; a box around the row would be mostly empty.)
  const textBox = (el) => {
    const nodes = [];
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) nodes.push(n);
    let a = null, b = null;
    for (const n of nodes) {
      const s = n.nodeValue;
      for (let k = 0; k < s.length; k++) if (/\S/.test(s[k]) && s[k] !== ' ') { if (!a) a = [n, k]; b = [n, k + 1]; }
    }
    if (!a) return null;
    const r = document.createRange();
    r.setStart(a[0], a[1]); r.setEnd(b[0], b[1]);
    return r.getBoundingClientRect();
  };

  // ---- terminal (xterm.js) ---------------------------------------------------------------------
  // With split terminals several are visible; `term.use(i)` picks one, counted left to right.
  let paneIndex = 0;
  const panes = () => [...document.querySelectorAll('.xterm')]
    .filter((e) => e.getBoundingClientRect().width > 0)
    .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
  const termRoot = () => { const p = panes(); return p[Math.min(paneIndex, p.length - 1)] || null; };
  const termRows = () => [...(termRoot()?.querySelectorAll('.xterm-rows > div') || [])];
  const rowText = (r) => r.textContent.replace(NBSP, ' ');

  const R = {
    sleep, q, findText, textBox,
    get pos() { return [state.x, state.y]; },
    async move(t, ms = 750) {
      const { x, y } = center(t);
      const x0 = state.x, y0 = state.y, dist = Math.hypot(x - x0, y - y0);
      ms = Math.max(220, Math.min(ms, 260 + dist * 0.9));
      const t0 = performance.now();
      for (;;) {
        const k = Math.min(1, (performance.now() - t0) / ms), e = ease(k);
        // A slight arc, as a hand would move.
        state.x = x0 + (x - x0) * e; state.y = y0 + (y - y0) * e + Math.sin(Math.PI * e) * Math.min(28, dist * 0.06);
        place(); hoverTo(state.x, state.y);
        if (k >= 1) break;
        await sleep(16);
      }
      state.x = x; state.y = y; place(); save();
      hoverTo(x, y);
    },
    ripple(x = state.x, y = state.y) {
      const r = document.createElement('div'); r.className = '__rec_rip';
      r.style.left = x + 'px'; r.style.top = y + 'px';
      document.documentElement.appendChild(r); setTimeout(() => r.remove(), 700);
    },
    // Move to the target, ripple, and click it with synthetic events. For controls that need a
    // trusted click, move with h.moveTo and click with Playwright instead.
    async click(t, { ms = 750, pause = 170, after = 350 } = {}) {
      const c = center(t);
      await R.move([c.x, c.y], ms);
      await sleep(pause);
      const el = document.elementFromPoint(c.x, c.y) || c.el;
      R.ripple();
      fire(el, 'pointerdown', c.x, c.y, { buttons: 1 }); fire(el, 'mousedown', c.x, c.y, { buttons: 1 });
      await sleep(70);
      fire(el, 'pointerup', c.x, c.y); fire(el, 'mouseup', c.x, c.y);
      if (typeof el.click === 'function') el.click(); else fire(el, 'click', c.x, c.y);
      await sleep(after);
    },
    async scroll(t, dy, ms = 1400) {
      const el = !t || t === 'window' ? document.scrollingElement : q(t);
      const y0 = el.scrollTop, y1 = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, y0 + dy));
      const t0 = performance.now();
      for (;;) {
        const k = Math.min(1, (performance.now() - t0) / ms);
        el.scrollTop = y0 + (y1 - y0) * ease(k);
        if (k >= 1) break;
        await sleep(16);
      }
      return el.scrollTop;
    },
    hide() { cur.style.display = 'none'; },
    show() { cur.style.display = ''; },

    term: {
      use(i) { paneIndex = i; return panes().length; },
      rows: () => termRows().map(rowText),
      text: () => termRows().map(rowText).join('\n').replace(/\s+$/, ''),
      // Resolve once the last non-blank row is a bare prompt and nothing has changed for `quiet` ms.
      async prompt({ timeout = 60000, quiet = 400, ps = '$' } = {}) {
        const t0 = Date.now();
        let last = null, since = Date.now();
        for (;;) {
          const rows = termRows().map(rowText).filter((s) => s.trim());
          const snap = rows.join('\n');
          if (snap !== last) { last = snap; since = Date.now(); }
          const tail = rows.length ? rows[rows.length - 1].trim() : '';
          if (tail === ps && Date.now() - since >= quiet) return snap;
          if (Date.now() - t0 > timeout) throw new Error(`rec: prompt "${ps}" did not return within ${timeout} ms (last row: "${tail}")`);
          await sleep(100);
        }
      },
      // Box around the text of the last row containing `match`, plus the `rows - 1` rows after it.
      rect(match, { rows = 1, pad = 6 } = {}) {
        const all = termRows();
        let i = -1;
        for (let k = all.length - 1; k >= 0; k--) if (rowText(all[k]).includes(match)) { i = k; break; }
        if (i < 0) throw new Error('rec: terminal row not found: ' + match);
        return R.union(all.slice(i, i + rows).map(textBox).filter(Boolean), pad);
      },
    },

    // ---- editor (Monaco) -------------------------------------------------------------------------
    editor: {
      // Visible editors, ordered by their on-screen box, top to bottom then left to right. (Not by
      // .view-lines, which is the whole scrolled content and moves with the scroll position.)
      list() {
        return [...document.querySelectorAll('.editor-group-container .monaco-editor')]
          .filter((e) => { const r = e.getBoundingClientRect(); return r.height > 0 && r.width > 0 && !e.closest('.quick-input-widget'); })
          .sort((a, b) => { const p = a.getBoundingClientRect(), q = b.getBoundingClientRect(); return p.top - q.top || p.left - q.left; });
      },
      // Box around the text of the first visible line containing `match`, plus the next `rows - 1`.
      rect(match, { editor = 0, rows = 1, pad = 6 } = {}) {
        const ed = R.editor.list()[editor];
        if (!ed) throw new Error('rec: no editor ' + editor);
        const box = ed.getBoundingClientRect();
        const lines = [...ed.querySelectorAll('.view-lines .view-line')]
          .filter((l) => { const r = l.getBoundingClientRect(); return r.bottom > box.top && r.top < box.bottom; })
          .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
        const i = lines.findIndex((l) => l.textContent.replace(NBSP, ' ').includes(match));
        if (i < 0) throw new Error('rec: editor line not found: ' + match);
        return R.union(lines.slice(i, i + rows).map(textBox).filter(Boolean), pad);
      },
    },

    // ---- regions ---------------------------------------------------------------------------------
    union(els, pad = 6) {
      const rs = els.map((e) => (e.getBoundingClientRect ? e.getBoundingClientRect() : e));
      const x0 = Math.min(...rs.map((r) => r.left)), y0 = Math.min(...rs.map((r) => r.top));
      const x1 = Math.max(...rs.map((r) => r.right)), y1 = Math.max(...rs.map((r) => r.bottom));
      return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
    },
    // A target's rectangle in CSS px: {x, y, w, h} passes through; anything q() accepts is measured.
    rectOf(t, pad = 6) {
      if (t && typeof t === 'object' && 'w' in t) return t;
      const el = q(t);
      if (!el) throw new Error('rec: target not found: ' + t);
      return R.union([el], pad);
    },
    // A box drawn on the page. `pad` applies to elements; a rectangle is drawn as given.
    mark(t, color = '#d4380d', pad = 8) {
      const r = R.rectOf(t, pad);
      const m = document.createElement('div');
      m.className = '__rec_mark';
      m.style.cssText += `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;--c:${color}`;
      document.documentElement.appendChild(m);
      requestAnimationFrame(() => m.classList.add('on'));
    },
    unmark() { document.querySelectorAll('.__rec_mark').forEach((m) => { m.classList.remove('on'); setTimeout(() => m.remove(), 300); }); },

    // Headless Chrome sends screencast frames only when something repaints, and can go quiet while a
    // page is visibly changing. A 2px corner pixel alternating between two colours one step apart
    // (it must be a real pixel change, or no frame is sent) keeps frames coming at the display rate.
    heartbeat(on = true) {
      document.getElementById('__rec_hb')?.remove();
      if (window.__rec_hb) cancelAnimationFrame(window.__rec_hb);
      if (!on) return 'heartbeat off';
      const px = document.createElement('div');
      px.id = '__rec_hb';
      px.style.cssText = 'position:fixed;right:0;bottom:0;width:2px;height:2px;pointer-events:none;z-index:2147483647';
      document.documentElement.appendChild(px);
      let k = 0;
      const tick = () => { px.style.background = k++ % 2 ? '#f7f7f7' : '#f8f8f8'; window.__rec_hb = requestAnimationFrame(tick); };
      tick();
      return 'heartbeat on';
    },
  };
  window.__rec = R;
  return 'rec: loaded';
})();

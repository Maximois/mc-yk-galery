/**
 * core/pdf-pages.js — vista fiel de las páginas de un PDF (solo navegador).
 *
 * Por qué: la vista de páginas pintaba solo 60 páginas, sin texto seleccionable ni enlaces,
 *   borrosa en pantallas HiDPI; un PDF largo "perdía" contenido original.
 * Qué: crea un contenedor por página (todas), las pinta al acercarse a la ventana
 *   (IntersectionObserver), a la densidad real de pantalla, con capa de texto
 *   (seleccionar/copiar/buscar) y enlaces del PDF clicables.
 * Cómo se verifica: test/document-pdf-pages.test.js (Chromium + pdf.js vendorizado).
 * Qué no se toca: el PDF original, el extractor de texto (pdf-text.js) ni la edición.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (typeof window !== 'undefined') { window.MCDoc = window.MCDoc || {}; window.MCDoc.pdfPages = mod; }
})(this, function () {
  'use strict';

  const MAX_DPR = 2;
  const ALLOWED_LINK = /^(https?:|mailto:)/i;

  function el(doc, tag, cls) { const e = doc.createElement(tag); if (cls) e.className = cls; return e; }

  /**
   * opts: { lib (pdf.js), pdf (PDFDocumentProxy), scroll (elemento con scroll), container,
   *         isCurrent():bool, openLink(url), onPage?(n) }
   * Devuelve { destroy() } y deja todas las páginas como contenedores .doc-page-wrap.
   */
  async function renderAll(opts) {
    const { lib, pdf, scroll, container } = opts;
    const doc = container.ownerDocument;
    const total = pdf.numPages;
    const first = await pdf.getPage(1);
    const avail = Math.max(200, (scroll.clientWidth || 800) - 60);
    const baseVp = first.getViewport({ scale: 1 });
    const scaleFor = (vp) => Math.min(avail / vp.width, 1.5) || 1;
    const wraps = [];
    const state = { destroyed: false };

    for (let i = 1; i <= total; i++) {
      const wrap = el(doc, 'div', 'doc-page-wrap');
      const s = scaleFor(baseVp);
      wrap.style.width = Math.floor(baseVp.width * s) + 'px';
      wrap.style.height = Math.floor(baseVp.height * s) + 'px';
      wrap.dataset.page = String(i);
      wrap.dataset.pw = String(baseVp.width);
      const no = el(doc, 'span', 'doc-page-no');
      no.textContent = i + ' / ' + total;
      wrap.appendChild(no);
      container.appendChild(wrap);
      wraps.push({ wrap, done: false, busy: false });
    }

    async function paint(entry, n) {
      if (entry.done || entry.busy || state.destroyed || !opts.isCurrent()) return;
      entry.busy = true;
      try {
        const page = n === 1 ? first : await pdf.getPage(n);
        if (state.destroyed || !opts.isCurrent()) return;
        const base = page.getViewport({ scale: 1 });
        const scale = scaleFor(base);
        const vp = page.getViewport({ scale });
        const dpr = Math.min(MAX_DPR, (doc.defaultView && doc.defaultView.devicePixelRatio) || 1);
        const wrap = entry.wrap;
        wrap.style.width = Math.floor(vp.width) + 'px';
        wrap.style.height = Math.floor(vp.height) + 'px';
        wrap.style.setProperty('--scale-factor', String(scale));
        wrap.dataset.pw = String(base.width);
        const canvas = el(doc, 'canvas');
        canvas.width = Math.floor(vp.width * dpr);
        canvas.height = Math.floor(vp.height * dpr);
        canvas.style.width = Math.floor(vp.width) + 'px';
        canvas.style.height = Math.floor(vp.height) + 'px';
        wrap.insertBefore(canvas, wrap.firstChild);
        await page.render({
          canvasContext: canvas.getContext('2d'),
          viewport: vp,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null
        }).promise;
        if (state.destroyed || !opts.isCurrent()) return;

        // Capa de texto: seleccionar, copiar y buscar con Ctrl+F.
        try {
          const textLayer = el(doc, 'div', 'textLayer');
          wrap.appendChild(textLayer);
          const textContent = await page.getTextContent();
          if (lib.renderTextLayer) {
            await lib.renderTextLayer({ textContentSource: textContent, container: textLayer, viewport: vp, textDivs: [] }).promise;
          }
        } catch (e) { /* sin capa de texto: la página sigue visible */ }

        // Enlaces del PDF (URI externos): recuadros clicables sobre la página.
        try {
          const annots = await page.getAnnotations({ intent: 'display' });
          for (const a of annots) {
            if (a.subtype !== 'Link' || !a.rect) continue;
            const url = a.url || a.unsafeUrl;
            if (!url || !ALLOWED_LINK.test(String(url))) continue;
            const r = lib.Util.normalizeRect(vp.convertToViewportRectangle(a.rect));
            const link = el(doc, 'a', 'doc-page-link');
            link.href = url;
            link.title = url;
            link.style.cssText = 'position:absolute;left:' + r[0] + 'px;top:' + r[1] + 'px;width:' + (r[2] - r[0]) + 'px;height:' + (r[3] - r[1]) + 'px;';
            link.addEventListener('click', (ev) => { ev.preventDefault(); if (opts.openLink) opts.openLink(url); });
            wrap.appendChild(link);
          }
        } catch (e) { /* sin anotaciones */ }
        entry.done = true;
        if (opts.onPage) opts.onPage(n);
      } catch (e) {
        entry.wrap.dataset.error = String(e && e.message || e);
      } finally {
        entry.busy = false;
      }
    }

    const hasIO = typeof doc.defaultView.IntersectionObserver === 'function';
    let io = null;
    if (hasIO) {
      io = new doc.defaultView.IntersectionObserver((list) => {
        for (const it of list) if (it.isIntersecting) paint(wraps[Number(it.target.dataset.page) - 1], Number(it.target.dataset.page));
      }, { root: scroll, rootMargin: '900px 0px' });
      wraps.forEach((w) => io.observe(w.wrap));
    } else {
      for (let i = 0; i < Math.min(total, 20); i++) await paint(wraps[i], i + 1);
    }
    return {
      total,
      wraps,
      paint: (n) => paint(wraps[n - 1], n),
      destroy() { state.destroyed = true; if (io) io.disconnect(); }
    };
  }


  // ---- anotaciones (resaltar, texto, trazo) -------------------------------
  // Se dibujan como capas encima de cada página; se guardan en fracciones (0..1,
  // origen arriba-izquierda) para que core/pdf-annotate.js las escriba al PDF.
  const NS = 'http://www.w3.org/2000/svg';
  const round4 = (n) => Math.round(n * 10000) / 10000;

  function createAnnotator(opts) {
    const { container, onChange } = opts;
    const doc = container.ownerDocument;
    const win = doc.defaultView;
    const list = [];
    let mode = 'none';
    let color = '#ffeb3b';
    let draft = null;
    const colorFor = (m) => (m === 'highlight' ? '#ffeb3b' : '#d32f2f');

    const wrapOf = (n) => { const e = n && (n.nodeType === 1 ? n : n.parentElement); return e && e.closest ? e.closest('.doc-page-wrap') : null; };
    const layerOf = (wrap) => {
      let l = wrap.querySelector(':scope > .anno-layer');
      if (!l) {
        l = el(doc, 'div', 'anno-layer');
        l.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;';
        wrap.appendChild(l);
      }
      return l;
    };
    const frac = (wrap, ev) => {
      const r = wrap.getBoundingClientRect();
      return { x: round4(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width))), y: round4(Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height))) };
    };
    const changed = () => { if (onChange) onChange(list.length); };

    function draw(a) {
      const wrap = container.querySelector('.doc-page-wrap[data-page="' + a.page + '"]');
      if (!wrap) return null;
      const layer = layerOf(wrap);
      let node;
      if (a.type === 'highlight') {
        node = el(doc, 'div');
        for (const r of a.rects) {
          const d = el(doc, 'div');
          d.style.cssText = 'position:absolute;mix-blend-mode:multiply;opacity:.45;left:' + r.x * 100 + '%;top:' + r.y * 100 + '%;width:' + r.w * 100 + '%;height:' + r.h * 100 + '%;background:' + a.color + ';';
          node.appendChild(d);
        }
      } else if (a.type === 'text') {
        node = el(doc, 'div');
        const pw = Number(wrap.dataset.pw) || 600;
        node.textContent = a.text;
        node.style.cssText = 'position:absolute;white-space:pre;line-height:1;font-family:Helvetica,Arial,sans-serif;color:' + a.color + ';left:' + a.x * 100 + '%;top:' + a.y * 100 + '%;font-size:' + (a.size / pw * wrap.clientWidth) + 'px;';
      } else {
        node = doc.createElementNS(NS, 'svg');
        node.setAttribute('viewBox', '0 0 1 1');
        node.setAttribute('preserveAspectRatio', 'none');
        node.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
        const pl = doc.createElementNS(NS, 'polyline');
        pl.setAttribute('points', a.points.map((q) => q.x + ',' + q.y).join(' '));
        pl.setAttribute('fill', 'none');
        pl.setAttribute('stroke', a.color);
        pl.setAttribute('stroke-width', String((a.width || 2) / (Number(wrap.dataset.pw) || 600)));
        pl.setAttribute('stroke-linecap', 'round');
        pl.setAttribute('stroke-linejoin', 'round');
        node.appendChild(pl);
      }
      layer.appendChild(node);
      return node;
    }
    function add(a) { a.__node = draw(a); list.push(a); changed(); }

    // Resaltar: se elige texto con el ratón y al soltar se marca.
    function onMouseUp() {
      if (mode !== 'highlight') return;
      const sel = win.getSelection && win.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      const wrap = wrapOf(range.commonAncestorContainer) || wrapOf(sel.anchorNode);
      if (!wrap) return;
      const wr = wrap.getBoundingClientRect();
      const rects = [];
      for (const r of Array.from(range.getClientRects())) {
        if (r.width < 2 || r.height < 2) continue;
        const x = Math.max(0, (r.left - wr.left) / wr.width), y = Math.max(0, (r.top - wr.top) / wr.height);
        const w = Math.min(1 - x, r.width / wr.width), h = Math.min(1 - y, r.height / wr.height);
        if (w > 0 && h > 0) rects.push({ x: round4(x), y: round4(y), w: round4(w), h: round4(h) });
      }
      if (!rects.length) return;
      sel.removeAllRanges();
      add({ type: 'highlight', page: Number(wrap.dataset.page), color, rects });
    }

    function onDown(ev) {
      if (ev.button !== 0) return;
      const wrap = wrapOf(ev.target);
      if (!wrap) return;
      if (mode === 'text') {
        if (ev.target.closest && ev.target.closest('.anno-input')) return;
        ev.preventDefault();
        const pos = frac(wrap, ev);
        const input = el(doc, 'input', 'anno-input');
        input.type = 'text';
        input.maxLength = 300;
        input.style.cssText = 'position:absolute;z-index:5;min-width:120px;font:12px Helvetica,Arial,sans-serif;color:' + color + ';left:' + pos.x * 100 + '%;top:' + pos.y * 100 + '%;';
        wrap.appendChild(input);
        let finished = false;
        const done = (commit) => {
          if (finished) return; finished = true;
          const text = input.value.trim();
          input.remove();
          if (commit && text) add({ type: 'text', page: Number(wrap.dataset.page), x: pos.x, y: pos.y, text, size: 12, color });
        };
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); else if (e.key === 'Escape') done(false); e.stopPropagation(); });
        input.addEventListener('blur', () => done(true));
        win.setTimeout(() => input.focus(), 0);
      } else if (mode === 'ink') {
        ev.preventDefault();
        const layer = layerOf(wrap);
        const svg = doc.createElementNS(NS, 'svg');
        svg.setAttribute('viewBox', '0 0 1 1'); svg.setAttribute('preserveAspectRatio', 'none');
        svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
        const pl = doc.createElementNS(NS, 'polyline');
        pl.setAttribute('fill', 'none'); pl.setAttribute('stroke', color); pl.setAttribute('stroke-linecap', 'round');
        pl.setAttribute('stroke-width', String(2 / (Number(wrap.dataset.pw) || 600)));
        svg.appendChild(pl); layer.appendChild(svg);
        draft = { wrap, svg, pl, points: [frac(wrap, ev)] };
        try { wrap.setPointerCapture && ev.pointerId != null && wrap.setPointerCapture(ev.pointerId); } catch (e) { /* sin captura */ }
      }
    }
    function onMove(ev) {
      if (!draft) return;
      const p = frac(draft.wrap, ev);
      const last = draft.points[draft.points.length - 1];
      if (Math.abs(p.x - last.x) + Math.abs(p.y - last.y) < 0.0015) return;
      draft.points.push(p);
      draft.pl.setAttribute('points', draft.points.map((q) => q.x + ',' + q.y).join(' '));
    }
    function onUp() {
      if (!draft) return;
      const d = draft; draft = null;
      d.svg.remove();
      if (d.points.length >= 2) add({ type: 'ink', page: Number(d.wrap.dataset.page), color, width: 2, points: d.points });
    }

    container.addEventListener('pointerdown', onDown);
    container.addEventListener('pointermove', onMove);
    container.addEventListener('pointerup', onUp);
    container.addEventListener('pointercancel', onUp);
    doc.addEventListener('mouseup', onMouseUp);

    const apply = () => {
      container.classList.remove('anno-highlight', 'anno-text', 'anno-ink');
      if (mode !== 'none') container.classList.add('anno-' + mode);
    };
    return {
      setMode(m) { mode = ['highlight', 'text', 'ink'].includes(m) ? m : 'none'; color = colorFor(mode === 'none' ? 'ink' : mode); apply(); },
      getMode: () => mode,
      setColor(c) { if (HEXC.test(c)) color = c; },
      undo() { const a = list.pop(); if (a && a.__node) a.__node.remove(); changed(); return !!a; },
      clear() { while (list.length) { const a = list.pop(); if (a.__node) a.__node.remove(); } changed(); },
      load(arr) { for (const a of Array.isArray(arr) ? arr : []) add(Object.assign({}, a)); },
      count: () => list.length,
      /** Lista limpia (sin nodos DOM) para enviar al guardado. */
      export: () => list.map((a) => { const o = Object.assign({}, a); delete o.__node; return o; }),
      destroy() {
        container.removeEventListener('pointerdown', onDown); container.removeEventListener('pointermove', onMove);
        container.removeEventListener('pointerup', onUp); container.removeEventListener('pointercancel', onUp);
        doc.removeEventListener('mouseup', onMouseUp);
      }
    };
  }
  const HEXC = /^#[0-9a-f]{6}$/i;

  const CSS = [
    '.textLayer{position:absolute;inset:0;overflow:hidden;line-height:1;opacity:1;-webkit-user-select:text;user-select:text;}',
    '.textLayer span,.textLayer br{color:transparent;position:absolute;white-space:pre;cursor:text;transform-origin:0% 0%;}',
    '.textLayer ::selection{background:rgba(0,90,255,.3);}',
    '.doc-page-link{display:block;cursor:pointer;}',
    '.doc-page-link:hover{background:rgba(0,90,255,.12);}'
  ].join('');

  return { renderAll, createAnnotator, CSS };
});

// Visor de PDF fiel a la página: cada página se dibuja en un canvas con pdf.js (maquetación, fuentes,
// imágenes y tablas tal cual el original) y encima va la capa de texto invisible de pdf.js para
// seleccionar y copiar. Mismo contrato que reflow-viewer.js, así reader-view.js los usa igual.
//
// Técnica tomada de mcbro-refact (core/pdf-pages.js), con cambios pensados para el celular:
//   - cada página tiene su propio tamaño (los PDF con páginas de distinto tamaño no desplazan el contenido);
//   - las páginas lejanas liberan su canvas (un PDF de cientos de páginas no agota la memoria);
//   - zoom, y las anotaciones son rectángulos en fracciones de la página (ver pdf-geometry.js).
// Limitaciones: no hay enlaces internos ni externos del PDF, formularios ni anotaciones del archivo.
import { pageHasText } from '../ocr/ocr-words.js';
import { pinchFactor, pinchMetrics } from './pinch.js';
import { clampPage, cleanQuote, fitPageScale, fitScale, fractionRects, isPdfAnchor, makePdfAnchor, pageAt, pageGesture, pagedRatio, rectStyle, resolveMode } from './pdf-geometry.js';

const MARGIN = 8; // px a cada lado de la página
const GAP = 10; // px entre páginas
const MAX_DPR = 2;
const MAX_CANVAS_SIDE = 4096; // límite de píxeles por lado: evita canvas gigantes al hacer zoom
const THROTTLE_MS = 200;
const TURN_MS = 440; // duración de pasar la hoja
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 4;

const STYLE_ID = 'pdf-viewer-style';
const CSS = `
.reader-host.pdf-mode{background:#3a3a3a;touch-action:pan-x pan-y}
.pdf-pages{display:flex;flex-direction:column;gap:${GAP}px;padding:${GAP}px ${MARGIN}px;min-width:min-content}
.pdf-page{position:relative;flex:none;margin:0 auto;background:#fff;box-shadow:0 1px 8px rgba(0,0,0,.45);overflow:hidden}
.pdf-page>canvas{position:absolute;left:0;top:0;display:block}
.pdf-page .pdf-no{position:absolute;right:6px;bottom:4px;font:11px sans-serif;color:#999;pointer-events:none}
.pdf-page .pdf-anno{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.pdf-page .pdf-anno>div{position:absolute;mix-blend-mode:multiply;background:rgba(255,214,10,.6)}
.pdf-page .pdf-anno>div.underline{background:none;box-shadow:0 2px 0 #e8590c}
.pdf-page .pdf-anno>div.note{background:rgba(0,212,170,.5)}
.pdf-page .textLayer{position:absolute;inset:0;overflow:hidden;line-height:1;-webkit-user-select:text;user-select:text}
.pdf-page .textLayer span,.pdf-page .textLayer br{color:transparent;position:absolute;white-space:pre;cursor:text;transform-origin:0% 0%}
.pdf-page .textLayer span.reader-search-hit{background:rgba(255,154,40,.65);border-radius:2px}
.pdf-page .textLayer span.reader-search-hit-active{outline:2px solid rgba(255,154,40,.9)}
.pdf-page .textLayer.ocr .ocr-line{position:static}
/* Hoja a hoja: una sola página visible, centrada; la actual (.cur) y sus vecinas ya dibujadas (.pre, ocultas) */
.reader-host.pdf-mode.paged{overscroll-behavior:contain}
.pdf-pages.paged{position:relative;display:block;padding:0;min-width:0;perspective:2400px}
.pdf-pages.paged .pdf-page{position:absolute;margin:0;display:none;backface-visibility:hidden}
.pdf-pages.paged .pdf-page.cur{display:block}
.pdf-pages.paged .pdf-page.pre{display:block;visibility:hidden}
.pdf-pages .turn-shade{position:absolute;pointer-events:none;background:linear-gradient(90deg,rgba(0,0,0,.45),rgba(0,0,0,0) 65%)}
.pdf-page .textLayer ::selection{background:rgba(30,144,255,.35)}
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

const div = (cls) => { const e = document.createElement('div'); if (cls) e.className = cls; return e; };

export function indexPdfPageText(items, query) {
  const needle = query.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  if (!needle) return [];
  let raw = '';
  const owners = [];
  let textItemIndex = 0;
  items.forEach((item) => {
    if (typeof item.str !== 'string') return;
    const index = textItemIndex++;
    if (raw) {
      raw += ' ';
      owners.push(-1);
    }
    for (let i = 0; i < item.str.length; i++) {
      raw += item.str[i];
      owners.push(index);
    }
  });

  let text = '';
  const normalizedOwners = [];
  let inWhitespace = false;
  for (let i = 0; i < raw.length; i++) {
    if (/\s/.test(raw[i])) {
      if (text && !inWhitespace) {
        text += ' ';
        normalizedOwners.push(-1);
      }
      inWhitespace = true;
    } else {
      text += raw[i].toLocaleLowerCase();
      normalizedOwners.push(owners[i]);
      inWhitespace = false;
    }
  }
  if (text.endsWith(' ')) {
    text = text.slice(0, -1);
    normalizedOwners.pop();
  }

  const matches = [];
  let from = 0;
  while ((from = text.indexOf(needle, from)) !== -1) {
    const itemIndexes = new Set(normalizedOwners.slice(from, from + needle.length).filter((index) => index >= 0));
    matches.push([...itemIndexes]);
    from += Math.max(1, needle.length);
  }
  return matches;
}

export function createPdfViewer({ host, onSelectionChange, onProgress, onZoom }) {
  let pdf = null;
  let lib = null;
  let total = 0;
  let zoom = 1;
  let mode = 'scroll'; // 'scroll' (todas las páginas en una columna) | 'paged' (una hoja a la vez)
  let cur = 0; // página visible en modo hoja a hoja (0-based)
  let turning = false;
  let queuedGo = null;
  let turnTarget = -1; // destino de la vuelta en curso (para encadenar toques rápidos)
  let lastW = 0;
  let lastH = 0;
  let resizeTimer = 0;
  let pagesEl = null;
  let entries = []; // { n, wrap, w1, h1 (tamaño a escala 1), anno, canvas, text, task, painted, busy }
  let io = null;
  let destroyed = false;
  let scrollTimer = 0;
  let selTimer = 0;
  let mountToken = 0;
  let searchQuery = '';
  let searchMatches = [];
  let searchIndex = -1;
  let searchGeneration = 0;
  let searchBuild = null;
  let activeSearchMatch = null;
  const ocr = new Map(); // página -> líneas reconocidas por OCR (solo se usan en páginas sin texto propio)
  const items = new Map(); // id -> anotación guardada (para repintar al cambiar el zoom)
  const listeners = [];

  const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); listeners.push(() => target.removeEventListener(type, fn, opts)); };
  const availWidth = () => Math.max(160, host.clientWidth - 2 * MARGIN);
  const availHeight = () => Math.max(160, host.clientHeight - 2 * MARGIN);
  const scaleOf = (e) => (mode === 'paged' ? fitPageScale(availWidth(), availHeight(), e.w1, e.h1, zoom) : fitScale(availWidth(), e.w1, zoom));
  const near = (e) => Math.abs(e.n - 1 - cur) <= 1;
  const clearSel = () => { const sel = window.getSelection && window.getSelection(); if (sel) sel.removeAllRanges(); };

  function sizeEntry(e) {
    const s = scaleOf(e);
    e.wrap.style.width = Math.floor(e.w1 * s) + 'px';
    e.wrap.style.height = Math.floor(e.h1 * s) + 'px';
    e.wrap.style.setProperty('--scale-factor', String(s));
  }

  function drawAnno(e, item) {
    const rects = (item.anchor.rects || []).filter((r) => r.p === e.n);
    for (const r of rects) {
      const d = document.createElement('div');
      d.dataset.hl = item.id;
      if (item.type === 'note' || item.type === 'underline') d.className = item.type;
      d.style.cssText = rectStyle(r);
      e.anno.appendChild(d);
    }
    return rects.length;
  }

  function addHighlight(item) {
    if (!isPdfAnchor(item.anchor, total)) return false;
    items.set(item.id, item);
    let drawn = 0;
    const pages = new Set(item.anchor.rects.map((r) => r.p));
    for (const n of pages) if (entries[n - 1]) drawn += drawAnno(entries[n - 1], item);
    return drawn > 0;
  }

  function unpaint(e) {
    if (e.task) { try { e.task.cancel(); } catch { /* ya terminó */ } e.task = null; }
    if (e.canvas) { e.canvas.width = 0; e.canvas.height = 0; e.canvas.remove(); e.canvas = null; } // libera la memoria del bitmap
    if (e.text) { e.text.remove(); e.text = null; }
    e.searchSpans = [];
    e.painted = false;
  }

  function clearSearchHighlights() {
    activeSearchMatch = null;
    entries.forEach((e) => e.searchSpans?.forEach((span) => {
      span.classList.remove('reader-search-hit', 'reader-search-hit-active');
    }));
  }

  function applySearchHighlight(e) {
    if (!activeSearchMatch || activeSearchMatch.page !== e.n || !e.searchSpans) return;
    activeSearchMatch.itemIndexes.forEach((index) => {
      const span = e.searchSpans[index];
      if (span) span.classList.add('reader-search-hit', 'reader-search-hit-active');
    });
  }

  /**
   * Capa de texto invisible a partir del OCR: una palabra = un <span> con la caja que ocupa en la página
   * (en %, vale a cualquier zoom). Una línea = un <div>, para que al copiar salgan saltos de línea.
   */
  function renderOcrLayer(layer, lines, pageHeightPx) {
    layer.classList.add('ocr');
    const fitted = []; // [span, ancho objetivo en fracción de la página]
    for (const line of lines) {
      const row = div('ocr-line');
      line.words.forEach((w, i) => {
        const span = document.createElement('span');
        // El espacio va DENTRO del span (white-space:pre): un nodo de texto suelto entre spans absolutos
        // no se incluye al copiar y las palabras saldrían pegadas.
        span.textContent = i < line.words.length - 1 ? w.t + ' ' : w.t;
        span.style.cssText = 'left:' + w.x * 100 + '%;top:' + w.y * 100 + '%;width:' + w.w * 100 + '%;height:' + w.h * 100 +
          '%;font-size:' + Math.max(4, w.h * pageHeightPx) + 'px';
        row.appendChild(span);
        fitted.push([span, w.w]);
      });
      layer.appendChild(row);
    }
    // La selección y el subrayado siguen el ancho del TEXTO, no el de la caja del span; con una tipografía
    // distinta a la del escaneo quedarían cortos o largos. Se mide cada palabra (todas juntas: una sola
    // maquetación) y se estira en horizontal para que ocupe exactamente la caja que midió el OCR.
    const pageW = layer.getBoundingClientRect().width;
    if (!(pageW > 0)) return;
    const natural = fitted.map(([span]) => {
      const t = span.firstChild;
      const r = document.createRange();
      r.setStart(t, 0);
      r.setEnd(t, t.length > 1 && /\s$/.test(t.data) ? t.length - 1 : t.length); // sin el espacio final
      return r.getBoundingClientRect().width;
    });
    fitted.forEach(([span, frac], i) => {
      if (natural[i] > 0) span.style.transform = 'scaleX(' + Math.max(0.3, Math.min(3, (frac * pageW) / natural[i])) + ')';
    });
  }

  async function paint(e) {
    if (e.painted || e.busy || destroyed) return;
    e.busy = true;
    const token = mountToken;
    try {
      const page = await pdf.getPage(e.n);
      if (destroyed || token !== mountToken || e.painted || e.stale) return;
      const scale = scaleOf(e);
      const vp = page.getViewport({ scale });
      const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1, MAX_CANVAS_SIDE / Math.max(vp.width, vp.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(vp.width * dpr));
      canvas.height = Math.max(1, Math.floor(vp.height * dpr));
      canvas.style.width = Math.floor(vp.width) + 'px';
      canvas.style.height = Math.floor(vp.height) + 'px';
      e.wrap.insertBefore(canvas, e.wrap.firstChild);
      e.canvas = canvas;
      e.task = page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null });
      await e.task.promise;
      e.task = null;
      if (destroyed || token !== mountToken || e.stale) return; // cambió el tamaño mientras se dibujaba: se repinta

      // Capa de texto: permite seleccionar y copiar. Si falla (o el PDF es una imagen), la página sigue visible.
      try {
        const layer = div('textLayer');
        layer.style.setProperty('--scale-factor', String(scale)); // pdf.js lo exige en el propio contenedor
        e.wrap.appendChild(layer);
        e.text = layer;
        const content = await page.getTextContent();
        if (!pageHasText(content.items) && ocr.has(e.n)) {
          renderOcrLayer(layer, ocr.get(e.n), vp.height);
        } else if (lib.renderTextLayer) {
          e.searchSpans = [];
          await lib.renderTextLayer({ textContentSource: content, container: layer, viewport: vp, textDivs: e.searchSpans }).promise;
          applySearchHighlight(e);
        }
      } catch { /* sin texto seleccionable en esta página */ }
      if (!e.stale) e.painted = true;
    } catch (err) {
      if (!(err && err.name === 'RenderingCancelledException')) {
        e.wrap.dataset.error = String((err && err.message) || err);
        if (e.canvas) { e.canvas.remove(); e.canvas = null; }
      }
    } finally {
      e.busy = false;
      if (e.stale && !destroyed) { e.stale = false; unpaint(e); retrigger(e); }
    }
  }

  /** Descarta lo pintado de una página cuyo tamaño cambió; si está pintándose, lo hará de nuevo al terminar. */
  function invalidate(e) {
    if (e.busy) { e.stale = true; return; }
    if (e.painted || e.canvas) unpaint(e);
  }

  /** observe() dispara el callback inicial: si la página está a la vista, se vuelve a pintar. */
  function retrigger(e) {
    if (mode === 'paged') { if (near(e)) paint(e); return; } // sin observador: se pinta la actual y sus vecinas
    if (!io) return;
    io.unobserve(e.wrap);
    io.observe(e.wrap);
  }

  function observeAll() {
    if (io) io.disconnect();
    io = new IntersectionObserver((list) => {
      for (const it of list) {
        const e = entries[Number(it.target.dataset.page) - 1];
        if (!e) continue;
        if (it.isIntersecting) paint(e); else if (e.painted || e.canvas) unpaint(e);
      }
    }, { root: host, rootMargin: '1200px 0px' });
    entries.forEach((e) => io.observe(e.wrap)); // observe() dispara el callback inicial: repinta lo visible
  }

  function progress() {
    if (mode === 'paged') return { ratio: pagedRatio(cur, total), block: cur, page: cur + 1, pages: total };
    const max = Math.max(1, host.scrollHeight - host.clientHeight);
    const ratio = Math.min(1, Math.max(0, host.scrollTop / max));
    const probe = host.scrollTop - pagesEl.offsetTop + host.clientHeight * 0.3;
    const idx = pageAt(entries.map((e) => e.wrap.offsetTop - pagesEl.offsetTop), probe);
    return { ratio, block: idx, page: idx + 1, pages: total };
  }

  function boxes() {
    return entries
      .filter((e) => e.wrap.isConnected && (mode !== 'paged' || e.wrap.classList.contains('cur'))) // las vecinas ocultas se superponen a la actual
      .map((e) => { const r = e.wrap.getBoundingClientRect(); return { page: e.n, left: r.left, top: r.top, width: r.width, height: r.height }; })
      .filter((b) => b.width > 0 && b.height > 0); // en hoja a hoja las demás páginas no ocupan lugar
  }

  function selectionInside() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const el = node.nodeType === 1 ? node : node.parentElement;
    return el && host.contains(el) ? { sel, range } : null;
  }

  function captureSelection() {
    const hit = selectionInside();
    if (!hit) return null;
    const rects = fractionRects(Array.from(hit.range.getClientRects()), boxes());
    const text = cleanQuote(hit.sel.toString());
    const anchor = makePdfAnchor(rects, text);
    return anchor ? { anchor, text } : null;
  }

  /** Reubica la vista en una página y una fracción de su alto, conservando lo que se estaba leyendo al cambiar el zoom. */
  function scrollToPage(idx, frac = 0) {
    if (mode === 'paged') return goTo(idx, { animate: false }); // devuelve una promesa: findText la espera
    const e = entries[Math.max(0, Math.min(total - 1, idx))];
    if (e) host.scrollTop = e.wrap.offsetTop - pagesEl.offsetTop + frac * e.wrap.offsetHeight;
  }

  async function findText(query, direction = 1) {
    const needle = query.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
    if (!needle) {
      searchGeneration++;
      searchQuery = '';
      searchMatches = [];
      searchIndex = -1;
      searchBuild = null;
      clearSearchHighlights();
      return null;
    }

    if (needle !== searchQuery) {
      searchQuery = needle;
      searchMatches = [];
      searchIndex = -1;
      clearSearchHighlights();
      const generation = ++searchGeneration;
      searchBuild = (async () => {
        for (let pageNumber = 1; pageNumber <= total; pageNumber++) {
          if (destroyed || generation !== searchGeneration) return;
          const page = await pdf.getPage(pageNumber);
          const content = await page.getTextContent();
          const pageMatches = indexPdfPageText(content.items, needle);
          pageMatches.forEach((itemIndexes) => searchMatches.push({ page: pageNumber, itemIndexes }));
          if (pageNumber % 12 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
        }
      })();
    }

    if (searchBuild) {
      const build = searchBuild;
      try {
        await build;
      } finally {
        if (searchBuild === build) searchBuild = null;
      }
    }

    if (destroyed || needle !== searchQuery || !searchMatches.length) {
      clearSearchHighlights();
      return null;
    }

    searchIndex = searchIndex < 0
      ? (direction > 0 ? 0 : searchMatches.length - 1)
      : (searchIndex + direction + searchMatches.length) % searchMatches.length;
    activeSearchMatch = searchMatches[searchIndex];
    clearSearchHighlights();
    activeSearchMatch = searchMatches[searchIndex];
    await scrollToPage(activeSearchMatch.page - 1);
    const entry = entries[activeSearchMatch.page - 1];
    if (entry) {
      await paint(entry);
      applySearchHighlight(entry);
    }
    if (onProgress) onProgress(progress());
    return { index: searchIndex + 1, total: searchMatches.length, page: activeSearchMatch.page };
  }

  /** Tamaños reales de cada página, en segundo plano. Hasta entonces se usa el de la primera. */
  async function loadSizes(token) {
    for (let n = 2; n <= total; n++) {
      if (destroyed || token !== mountToken) return;
      const e = entries[n - 1];
      try {
        const vp = (await pdf.getPage(n)).getViewport({ scale: 1 });
        if (Math.abs(vp.width - e.w1) > 0.5 || Math.abs(vp.height - e.h1) > 0.5) {
          const before = e.wrap.offsetHeight;
          const aboveViewport = mode === 'scroll' && e.wrap.offsetTop + before <= host.scrollTop;
          e.w1 = vp.width;
          e.h1 = vp.height;
          sizeEntry(e);
          if (e.painted || e.busy) { invalidate(e); retrigger(e); } // ya estaba dibujada con el tamaño provisional
          if (aboveViewport) host.scrollTop += e.wrap.offsetHeight - before; // no mover lo que se está leyendo
          if (mode === 'paged' && near(e)) layoutPaged();
        }
      } catch { /* esa página usa el tamaño de la primera */ }
      if (n % 25 === 0) await new Promise((r) => setTimeout(r, 0)); // cede el hilo para no congelar la UI
    }
  }

  // ------------------------------------------------------------------ hoja a hoja

  const reducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const pxOf = (v) => parseFloat(v) || 0;

  /** Coloca cada página visible (o vecina) centrada en el "escenario", que es al menos tan grande como el visor. */
  function layoutPaged() {
    const e = entries[cur];
    if (!e || !pagesEl) return;
    const w = pxOf(e.wrap.style.width);
    const h = pxOf(e.wrap.style.height);
    const stageW = Math.max(host.clientWidth, w + 2 * MARGIN);
    const stageH = Math.max(host.clientHeight, h + 2 * MARGIN);
    pagesEl.style.width = stageW + 'px';
    pagesEl.style.height = stageH + 'px';
    for (const x of entries) {
      const isCur = x === e;
      const isPre = !isCur && near(x);
      x.wrap.classList.toggle('cur', isCur);
      x.wrap.classList.toggle('pre', isPre);
      if (isCur || isPre) {
        x.wrap.style.left = Math.round((stageW - pxOf(x.wrap.style.width)) / 2) + 'px';
        x.wrap.style.top = Math.round((stageH - pxOf(x.wrap.style.height)) / 2) + 'px';
      }
    }
  }

  /** Libera lo que ya no hace falta (solo se mantienen la actual y las vecinas) y adelanta las vecinas. */
  function settlePaged() {
    entries.forEach((x) => { if (!near(x) && (x.painted || x.canvas || x.busy)) invalidate(x); });
    entries.forEach((x) => { if (near(x)) paint(x); });
  }

  /** Vuelve al origen de la página nueva: con zoom, arriba y centrada. */
  function resetScrollPaged() {
    host.scrollTop = 0;
    host.scrollLeft = Math.max(0, (host.scrollWidth - host.clientWidth) / 2);
  }

  function showPage(idx) {
    cur = idx;
    layoutPaged();
    resetScrollPaged();
    settlePaged();
    if (onProgress) onProgress(progress());
  }

  /**
   * Pasa a la página `idx`. Si es la contigua y no hay "reducir movimiento", la hoja gira sobre el lomo
   * (borde izquierdo): hacia adelante la actual se va y deja ver la siguiente; hacia atrás la anterior
   * vuelve a cubrir la actual. Espera a que la de destino esté dibujada para no mostrar una hoja en blanco.
   */
  async function goTo(idx, { animate = true } = {}) {
    if (!pagesEl || mode !== 'paged' || destroyed) return;
    idx = clampPage(idx, total);
    if (turning) { queuedGo = { idx, animate }; return; }
    turnTarget = idx;
    if (idx === cur) return;
    turning = true;
    const token = mountToken;
    try {
      clearSel();
      const from = entries[cur];
      const to = entries[idx];
      // La página de destino se coloca oculta (.pre) y se pinta antes de mostrarla.
      to.wrap.classList.add('pre');
      layoutPaged();
      to.wrap.style.left = from.wrap.style.left;
      to.wrap.style.top = from.wrap.style.top;
      await paint(to);
      if (destroyed || token !== mountToken) return;
      const adjacent = Math.abs(idx - cur) === 1;
      if (animate && adjacent && !reducedMotion() && from.wrap.animate) {
        await turnLeaf(from, to, idx > cur ? 1 : -1);
        if (destroyed || token !== mountToken) return;
      }
      showPage(idx);
    } finally {
      turning = false;
      turnTarget = -1;
      const q = queuedGo;
      queuedGo = null;
      if (q && !destroyed) goTo(q.idx, { animate: q.animate });
    }
  }

  async function turnLeaf(from, to, dir) {
    const under = dir > 0 ? to : from; // la que queda abajo y se descubre / queda cubierta
    const leaf = dir > 0 ? from : to; // la que gira
    const shade = div('turn-shade');
    shade.style.cssText = 'left:' + under.wrap.style.left + ';top:' + under.wrap.style.top + ';width:' + under.wrap.style.width + ';height:' + under.wrap.style.height + ';z-index:2';
    pagesEl.appendChild(shade);
    under.wrap.style.zIndex = '1';
    under.wrap.style.visibility = 'visible';
    leaf.wrap.style.zIndex = '3';
    leaf.wrap.style.visibility = 'visible';
    leaf.wrap.style.transformOrigin = 'left center';
    const away = 'rotateY(-105deg)';
    const opts = { duration: TURN_MS, easing: 'cubic-bezier(.45,.05,.35,1)', fill: 'forwards' };
    const frames = dir > 0 ? [{ transform: 'rotateY(0deg)' }, { transform: away }] : [{ transform: away }, { transform: 'rotateY(0deg)' }];
    const shadeFrames = dir > 0 ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 0 }, { opacity: 1 }];
    try {
      leaf.wrap.style.transform = frames[0].transform; // posición inicial antes de arrancar (evita un parpadeo)
      await Promise.all([leaf.wrap.animate(frames, opts).finished, shade.animate(shadeFrames, opts).finished]);
    } catch { /* animación cancelada (se cerró el lector): se limpia igual */ }
    for (const w of [leaf.wrap, under.wrap]) {
      w.getAnimations && w.getAnimations().forEach((a) => a.cancel());
      w.style.zIndex = w.style.visibility = w.style.transform = w.style.transformOrigin = '';
    }
    shade.remove();
  }

  // Toques seguidos se encadenan: cada uno parte del destino pendiente, no de la página que aún se ve.
  const basePage = () => (queuedGo ? queuedGo.idx : turning && turnTarget >= 0 ? turnTarget : cur);
  const next = () => goTo(basePage() + 1);
  const prev = () => goTo(basePage() - 1);

  function bindPagedInput() {
    let g = null;
    on(host, 'touchstart', (ev) => {
      const t = ev.touches[0];
      g = mode === 'paged' && ev.touches.length === 1 ? { x: t.clientX, y: t.clientY, at: Date.now(), moved: false } : null;
    }, { passive: true });
    on(host, 'touchmove', (ev) => {
      if (!g) return;
      const t = ev.touches[0];
      if (ev.touches.length !== 1) g = null;
      else if (Math.hypot(t.clientX - g.x, t.clientY - g.y) > 10) g.moved = true;
    }, { passive: true });
    on(host, 'touchend', (ev) => {
      const s0 = g;
      g = null;
      if (!s0 || mode !== 'paged' || selectionInside()) return; // con texto seleccionado no se pasa de hoja
      const t = ev.changedTouches[0];
      const r = host.getBoundingClientRect();
      const act = pageGesture({ dx: t.clientX - s0.x, dy: t.clientY - s0.y, dt: Date.now() - s0.at, moved: s0.moved, relX: (t.clientX - r.left) / r.width, fit: zoom <= 1.02 });
      if (act === 'next') next(); else if (act === 'prev') prev();
    }, { passive: true });
    on(document, 'keydown', (ev) => {
      if (mode !== 'paged' || ev.ctrlKey || ev.metaKey || ev.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test((ev.target && ev.target.tagName) || '')) return;
      if (ev.key === 'ArrowRight' || ev.key === 'PageDown') { ev.preventDefault(); next(); }
      else if (ev.key === 'ArrowLeft' || ev.key === 'PageUp') { ev.preventDefault(); prev(); }
    });
  }

  /** Cambia entre columna con scroll y hoja a hoja, conservando la página que se estaba leyendo. */
  function applyMode(next) {
    if (!pagesEl || next === mode) return mode;
    const page = progress().block;
    mode = next;
    clearSel();
    if (io) { io.disconnect(); io = null; }
    entries.forEach((e) => {
      e.wrap.classList.remove('cur', 'pre');
      e.wrap.style.left = e.wrap.style.top = '';
      sizeEntry(e);
      invalidate(e);
    });
    pagesEl.classList.toggle('paged', mode === 'paged');
    host.classList.toggle('paged', mode === 'paged');
    pagesEl.style.width = pagesEl.style.height = '';
    cur = clampPage(page, total);
    if (mode === 'paged') { layoutPaged(); resetScrollPaged(); settlePaged(); }
    else { observeAll(); scrollToPage(cur); }
    if (onProgress) onProgress(progress());
    return mode;
  }

  /** Cambios de tamaño del visor (girar el teléfono): se vuelve a ajustar y dibujar todo. */
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (destroyed || !pagesEl) return;
      const w = host.clientWidth;
      const h = host.clientHeight;
      // El teclado del buscador cambia solo el alto: en columna eso no obliga a redibujar nada.
      if (Math.abs(w - lastW) < 2 && (mode === 'scroll' || Math.abs(h - lastH) < 2)) return;
      lastW = w; lastH = h;
      entries.forEach((e) => { sizeEntry(e); invalidate(e); });
      if (mode === 'paged') { layoutPaged(); resetScrollPaged(); settlePaged(); } else observeAll();
    }, 150);
  }

  /**
   * Zoom con dos dedos. Mientras los dedos se mueven solo se escala con CSS (transform) alrededor del
   * punto medio, que es barato y se ve al instante; al soltar se vuelve a maquetar y dibujar nítido
   * (applyZoom) dejando fijo el punto que estaba bajo los dedos. Se usan eventos táctiles y no de puntero:
   * con touch-action el navegador cancela los punteros cuando toma el gesto, y acá se quiere el gesto propio.
   */
  function bindPinch() {
    let g = null; // { dist0, zoom0, factor, cx, cy } mientras hay gesto
    const pts = (ev) => {
      const r = host.getBoundingClientRect();
      const a = ev.touches[0], b = ev.touches[1];
      return pinchMetrics({ x: a.clientX - r.left, y: a.clientY - r.top }, { x: b.clientX - r.left, y: b.clientY - r.top });
    };
    on(host, 'touchstart', (ev) => {
      if (ev.touches.length !== 2 || !pagesEl) return;
      const m = pts(ev);
      g = { dist0: m.dist, zoom0: zoom, factor: 1, cx: m.cx, cy: m.cy };
      // Origen del escalado en coordenadas de pagesEl: el punto del documento que está entre los dedos.
      pagesEl.style.transformOrigin = (host.scrollLeft + m.cx - pagesEl.offsetLeft) + 'px ' + (host.scrollTop + m.cy - pagesEl.offsetTop) + 'px';
      pagesEl.style.willChange = 'transform';
      window.getSelection && window.getSelection().removeAllRanges(); // los dos dedos no deben dejar una selección a medias
    }, { passive: true });
    on(host, 'touchmove', (ev) => {
      if (!g) return;
      if (ev.touches.length !== 2) return;
      ev.preventDefault(); // sin esto el navegador desplaza la página mientras se pellizca
      const m = pts(ev);
      g.factor = pinchFactor(g.dist0, m.dist, g.zoom0, ZOOM_MIN, ZOOM_MAX);
      g.cx = m.cx; g.cy = m.cy;
      pagesEl.style.transform = 'scale(' + g.factor + ')';
      if (onZoom) onZoom(Math.round(g.zoom0 * g.factor * 100) / 100);
    }, { passive: false });
    const end = (ev) => {
      if (!g || ev.touches.length >= 2) return;
      const done = g;
      g = null;
      pagesEl.style.transform = '';
      pagesEl.style.transformOrigin = '';
      pagesEl.style.willChange = '';
      applyZoom(done.zoom0 * done.factor, { x: done.cx, y: done.cy });
    };
    on(host, 'touchend', end, { passive: true });
    on(host, 'touchcancel', end, { passive: true });
  }

  /**
   * Cambia el zoom dejando quieto el punto del documento que está en `focal` (coordenadas del visor;
   * sin focal, el borde superior). El punto se guarda como página + fracción de su alto, no como
   * píxeles, porque el espacio entre páginas no escala y en un PDF largo los píxeles se desfasarían.
   */
  function applyZoom(z, focal) {
    const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(z * 100) / 100));
    if (!pagesEl || next === zoom) { if (onZoom) onZoom(zoom); return zoom; }
    const fx = focal ? focal.x : 0;
    const fy = focal ? focal.y : 0;
    if (mode === 'paged') return applyZoomPaged(next, fx, fy, !!focal);
    const y = host.scrollTop + fy - pagesEl.offsetTop;
    const idx = pageAt(entries.map((e) => e.wrap.offsetTop - pagesEl.offsetTop), y);
    const e0 = entries[idx];
    const top0 = e0 ? e0.wrap.offsetTop - pagesEl.offsetTop : 0;
    const frac = e0 ? (y - top0) / Math.max(1, e0.wrap.offsetHeight) : 0;
    const ratio = next / zoom;
    const x = host.scrollLeft + fx;
    zoom = next;
    entries.forEach((e) => { sizeEntry(e); invalidate(e); });
    if (e0) host.scrollTop = e0.wrap.offsetTop + frac * e0.wrap.offsetHeight - fy;
    host.scrollLeft = x * ratio - fx;
    observeAll();
    if (onProgress) onProgress(progress());
    if (onZoom) onZoom(zoom);
    return zoom;
  }

  /** Zoom en hoja a hoja: deja fijo el punto de la página que está bajo los dedos (o el centro). */
  function applyZoomPaged(next, fx, fy, hasFocal) {
    const e = entries[cur];
    const left = pxOf(e.wrap.style.left);
    const top = pxOf(e.wrap.style.top);
    const w = Math.max(1, pxOf(e.wrap.style.width));
    const h = Math.max(1, pxOf(e.wrap.style.height));
    const px = hasFocal ? fx : host.clientWidth / 2;
    const py = hasFocal ? fy : host.clientHeight / 2;
    const rx = (host.scrollLeft + px - left) / w; // punto de la página, en fracciones
    const ry = (host.scrollTop + py - top) / h;
    zoom = next;
    entries.forEach((x) => { sizeEntry(x); invalidate(x); });
    layoutPaged();
    const nl = pxOf(e.wrap.style.left);
    const nt = pxOf(e.wrap.style.top);
    host.scrollLeft = nl + rx * pxOf(e.wrap.style.width) - px;
    host.scrollTop = nt + ry * pxOf(e.wrap.style.height) - py;
    settlePaged();
    if (onProgress) onProgress(progress());
    if (onZoom) onZoom(zoom);
    return zoom;
  }

  function bindEvents() {
    on(host, 'scroll', () => {
      if (scrollTimer) return;
      scrollTimer = setTimeout(() => { scrollTimer = 0; if (!destroyed && onProgress) onProgress(progress()); }, THROTTLE_MS);
    }, { passive: true });
    bindPinch();
    bindPagedInput();
    on(window, 'resize', onResize);
    // En el celular no hay mouseup confiable: selectionchange cubre el arrastre de los manijas.
    on(document, 'selectionchange', () => {
      clearTimeout(selTimer);
      selTimer = setTimeout(() => { if (!destroyed && onSelectionChange) onSelectionChange(selectionInside() ? captureSelection() : null); }, 150);
    });
  }

  return {
    /** content: { kind:'pdf', pdf, lib }. Devuelve las anotaciones que no se pudieron ubicar. */
    async mount(content, { highlights = [], startBlock = 0, ocr: ocrPages = null, mode: modePref = 'auto' } = {}) {
      this.destroy();
      destroyed = false;
      mountToken++;
      ensureStyle();
      pdf = content.pdf;
      lib = content.lib;
      ocr.clear();
      if (ocrPages) for (const k of Object.keys(ocrPages)) ocr.set(Number(k), ocrPages[k]);
      total = pdf.numPages;
      host.classList.add('pdf-mode');
      host.innerHTML = '';
      mode = resolveMode(modePref, total);
      cur = clampPage(startBlock, total);
      lastW = host.clientWidth;
      lastH = host.clientHeight;
      pagesEl = div('pdf-pages');
      pagesEl.classList.toggle('paged', mode === 'paged');
      host.classList.toggle('paged', mode === 'paged');
      host.appendChild(pagesEl);

      const first = (await pdf.getPage(1)).getViewport({ scale: 1 });
      for (let n = 1; n <= total; n++) {
        const wrap = div('pdf-page');
        wrap.dataset.page = String(n);
        const anno = div('pdf-anno');
        const no = document.createElement('span');
        no.className = 'pdf-no';
        no.textContent = n + ' / ' + total;
        wrap.append(anno, no);
        pagesEl.appendChild(wrap);
        const e = { n, wrap, w1: first.width, h1: first.height, anno, canvas: null, text: null, task: null, painted: false, busy: false, stale: false };
        entries.push(e);
        sizeEntry(e);
      }

      const orphans = highlights.filter((h) => h.anchor && !addHighlight(h));
      bindEvents();
      if (mode === 'paged') { layoutPaged(); settlePaged(); } else { observeAll(); if (startBlock > 0) scrollToPage(startBlock); }
      if (onProgress) onProgress(progress());
      loadSizes(mountToken);
      return orphans;
    },
    addHighlight,
    /** Llega el OCR de una página: se guarda y, si ya estaba dibujada, se vuelve a dibujar con la nueva capa. */
    setOcrPage(n, lines) {
      ocr.set(n, lines);
      const e = entries[n - 1];
      if (e && (e.painted || e.busy)) { invalidate(e); retrigger(e); }
    },
    captureSelection,
    findText,
    clearFind() {
      searchGeneration++;
      searchQuery = '';
      searchMatches = [];
      searchIndex = -1;
      searchBuild = null;
      clearSearchHighlights();
    },
    clearSelection() { const s = window.getSelection(); if (s) s.removeAllRanges(); },
    setProgress(ratio) {
      if (mode === 'paged') { goTo(Math.round(ratio * Math.max(0, total - 1)), { animate: false }); return; }
      host.scrollTop = ratio * Math.max(0, host.scrollHeight - host.clientHeight);
    },
    progress: () => (pagesEl ? progress() : { ratio: 0, block: 0, page: 1, pages: 0 }),
    blockCount: () => total,
    hasText: () => true, // no se sabe hasta pintar cada página; un PDF escaneado simplemente no deja seleccionar
    getZoom: () => zoom,
    getMode: () => mode,
    /** 'scroll' | 'paged'. Devuelve el modo resultante. */
    setMode: (m) => applyMode(m === 'paged' ? 'paged' : 'scroll'),
    next,
    prev,
    /** Cambia el zoom (1 = ajustado al ancho) manteniendo la posición de lectura. */
    setZoom(z) { return applyZoom(z, null); },
    destroy() {
      destroyed = true;
      mountToken++;
      clearTimeout(scrollTimer);
      clearTimeout(selTimer);
      clearTimeout(resizeTimer);
      scrollTimer = selTimer = resizeTimer = 0;
      listeners.splice(0).forEach((off) => off());
      if (io) { io.disconnect(); io = null; }
      entries.forEach(unpaint);
      entries = [];
      items.clear();
      ocr.clear();
      host.classList.remove('pdf-mode', 'paged');
      if (pagesEl) { pagesEl.remove(); pagesEl = null; }
      if (pdf) { try { pdf.destroy(); } catch { /* ya liberado */ } pdf = null; }
      total = 0;
      zoom = 1;
      mode = 'scroll';
      cur = 0;
      turning = false;
      turnTarget = -1;
      queuedGo = null;
      searchGeneration++;
      searchQuery = '';
      searchMatches = [];
      searchIndex = -1;
      searchBuild = null;
      activeSearchMatch = null;
    }
  };
}

// Visor de PDF fiel a la página: cada página se dibuja en un canvas con pdf.js (maquetación, fuentes,
// imágenes y tablas tal cual el original) y encima va la capa de texto invisible de pdf.js para
// seleccionar y copiar. Mismo contrato que reflow-viewer.js, así reader-view.js los usa igual.
//
// Técnica tomada de mcbro-refact (core/pdf-pages.js), con cambios pensados para el celular:
//   - cada página tiene su propio tamaño (los PDF con páginas de distinto tamaño no desplazan el contenido);
//   - las páginas lejanas liberan su canvas (un PDF de cientos de páginas no agota la memoria);
//   - zoom, y las anotaciones son rectángulos en fracciones de la página (ver pdf-geometry.js).
// Limitaciones: no hay enlaces internos ni externos del PDF, formularios ni anotaciones del archivo.
import { cleanQuote, fitScale, fractionRects, isPdfAnchor, makePdfAnchor, pageAt, rectStyle } from './pdf-geometry.js';

const MARGIN = 8; // px a cada lado de la página
const GAP = 10; // px entre páginas
const MAX_DPR = 2;
const MAX_CANVAS_SIDE = 4096; // límite de píxeles por lado: evita canvas gigantes al hacer zoom
const THROTTLE_MS = 200;
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
.pdf-page .pdf-anno>div.note{background:rgba(0,212,170,.5)}
.pdf-page .textLayer{position:absolute;inset:0;overflow:hidden;line-height:1;-webkit-user-select:text;user-select:text}
.pdf-page .textLayer span,.pdf-page .textLayer br{color:transparent;position:absolute;white-space:pre;cursor:text;transform-origin:0% 0%}
.pdf-page .textLayer span.reader-search-hit{background:rgba(255,154,40,.65);border-radius:2px}
.pdf-page .textLayer span.reader-search-hit-active{outline:2px solid rgba(255,154,40,.9)}
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

export function createPdfViewer({ host, onSelectionChange, onProgress }) {
  let pdf = null;
  let lib = null;
  let total = 0;
  let zoom = 1;
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
  const items = new Map(); // id -> anotación guardada (para repintar al cambiar el zoom)
  const listeners = [];

  const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); listeners.push(() => target.removeEventListener(type, fn, opts)); };
  const availWidth = () => Math.max(160, host.clientWidth - 2 * MARGIN);
  const scaleOf = (e) => fitScale(availWidth(), e.w1, zoom);

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
      if (item.type === 'note') d.className = 'note';
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

  async function paint(e) {
    if (e.painted || e.busy || destroyed) return;
    e.busy = true;
    const token = mountToken;
    try {
      const page = await pdf.getPage(e.n);
      if (destroyed || token !== mountToken || e.painted) return;
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
      if (destroyed || token !== mountToken) return;

      // Capa de texto: permite seleccionar y copiar. Si falla (o el PDF es una imagen), la página sigue visible.
      try {
        const layer = div('textLayer');
        e.wrap.appendChild(layer);
        e.text = layer;
        const content = await page.getTextContent();
        if (lib.renderTextLayer) {
          e.searchSpans = [];
          await lib.renderTextLayer({ textContentSource: content, container: layer, viewport: vp, textDivs: e.searchSpans }).promise;
          applySearchHighlight(e);
        }
      } catch { /* sin texto seleccionable en esta página */ }
      e.painted = true;
    } catch (err) {
      if (!(err && err.name === 'RenderingCancelledException')) {
        e.wrap.dataset.error = String((err && err.message) || err);
        if (e.canvas) { e.canvas.remove(); e.canvas = null; }
      }
    } finally {
      e.busy = false;
    }
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
    const max = Math.max(1, host.scrollHeight - host.clientHeight);
    const ratio = Math.min(1, Math.max(0, host.scrollTop / max));
    const probe = host.scrollTop - pagesEl.offsetTop + host.clientHeight * 0.3;
    const idx = pageAt(entries.map((e) => e.wrap.offsetTop - pagesEl.offsetTop), probe);
    return { ratio, block: idx, page: idx + 1, pages: total };
  }

  function boxes() {
    return entries
      .filter((e) => e.wrap.isConnected)
      .map((e) => { const r = e.wrap.getBoundingClientRect(); return { page: e.n, left: r.left, top: r.top, width: r.width, height: r.height }; });
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
    scrollToPage(activeSearchMatch.page - 1);
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
          const aboveViewport = e.wrap.offsetTop + before <= host.scrollTop;
          e.w1 = vp.width;
          e.h1 = vp.height;
          sizeEntry(e);
          if (aboveViewport) host.scrollTop += e.wrap.offsetHeight - before; // no mover lo que se está leyendo
        }
      } catch { /* esa página usa el tamaño de la primera */ }
      if (n % 25 === 0) await new Promise((r) => setTimeout(r, 0)); // cede el hilo para no congelar la UI
    }
  }

  function bindEvents() {
    on(host, 'scroll', () => {
      if (scrollTimer) return;
      scrollTimer = setTimeout(() => { scrollTimer = 0; if (!destroyed && onProgress) onProgress(progress()); }, THROTTLE_MS);
    }, { passive: true });
    // En el celular no hay mouseup confiable: selectionchange cubre el arrastre de los manijas.
    on(document, 'selectionchange', () => {
      clearTimeout(selTimer);
      selTimer = setTimeout(() => { if (!destroyed && onSelectionChange) onSelectionChange(selectionInside() ? captureSelection() : null); }, 150);
    });
  }

  return {
    /** content: { kind:'pdf', pdf, lib }. Devuelve las anotaciones que no se pudieron ubicar. */
    async mount(content, { highlights = [], startBlock = 0 } = {}) {
      this.destroy();
      destroyed = false;
      mountToken++;
      ensureStyle();
      pdf = content.pdf;
      lib = content.lib;
      total = pdf.numPages;
      host.classList.add('pdf-mode');
      host.innerHTML = '';
      pagesEl = div('pdf-pages');
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
        const e = { n, wrap, w1: first.width, h1: first.height, anno, canvas: null, text: null, task: null, painted: false, busy: false };
        entries.push(e);
        sizeEntry(e);
      }

      const orphans = highlights.filter((h) => h.anchor && !addHighlight(h));
      bindEvents();
      observeAll();
      if (startBlock > 0) scrollToPage(startBlock);
      if (onProgress) onProgress(progress());
      loadSizes(mountToken);
      return orphans;
    },
    addHighlight,
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
    setProgress(ratio) { host.scrollTop = ratio * Math.max(0, host.scrollHeight - host.clientHeight); },
    progress: () => (pagesEl ? progress() : { ratio: 0, block: 0, page: 1, pages: 0 }),
    blockCount: () => total,
    hasText: () => true, // no se sabe hasta pintar cada página; un PDF escaneado simplemente no deja seleccionar
    getZoom: () => zoom,
    /** Cambia el zoom (1 = ajustado al ancho) manteniendo la posición de lectura. */
    setZoom(z) {
      const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(z * 100) / 100));
      if (!pagesEl || next === zoom) return zoom;
      const p = progress();
      const e0 = entries[p.block];
      const frac = e0 ? Math.max(0, (host.scrollTop - (e0.wrap.offsetTop - pagesEl.offsetTop)) / Math.max(1, e0.wrap.offsetHeight)) : 0;
      zoom = next;
      entries.forEach((e) => { unpaint(e); sizeEntry(e); });
      scrollToPage(p.block, frac);
      observeAll();
      if (onProgress) onProgress(progress());
      return zoom;
    },
    destroy() {
      destroyed = true;
      mountToken++;
      clearTimeout(scrollTimer);
      clearTimeout(selTimer);
      scrollTimer = selTimer = 0;
      listeners.splice(0).forEach((off) => off());
      if (io) { io.disconnect(); io = null; }
      entries.forEach(unpaint);
      entries = [];
      items.clear();
      host.classList.remove('pdf-mode');
      if (pagesEl) { pagesEl.remove(); pagesEl = null; }
      if (pdf) { try { pdf.destroy(); } catch { /* ya liberado */ } pdf = null; }
      total = 0;
      zoom = 1;
      searchGeneration++;
      searchQuery = '';
      searchMatches = [];
      searchIndex = -1;
      searchBuild = null;
      activeSearchMatch = null;
    }
  };
}

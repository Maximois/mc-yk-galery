// Visor de contenido reflowable. Muestra los bloques en un iframe aislado (sin scripts), traduce
// selecciones de texto a anclas, pinta resaltados y reporta el progreso de lectura.
//
// Por qué un iframe: el CSS que genera el núcleo para el documento (márgenes, tablas, fuentes) no
// debe pisar los estilos de la app. `sandbox="allow-same-origin"` sin `allow-scripts` impide que un
// documento ejecute código y aun así deja a la app leer la selección desde afuera.
import { flatten, makeAnchor, resolveAnchor, splitByBlocks, trimRange } from './anchors.js';

const READER_CSS = `
html{-webkit-text-size-adjust:100%;background:#1a1a1a}
body{background:#fff;color:#111;font-size:17px;line-height:1.65;-webkit-user-select:text;user-select:text;overflow-wrap:anywhere}
#doc{max-width:760px;margin:0 auto;padding:20px 16px 96px;background:#fff;min-height:100vh}
.blk{overflow-x:auto}
img,svg,video{max-width:100%;height:auto}
table{max-width:100%}
a{color:#0b6bcb}
::selection{background:rgba(30,144,255,.35)}
mark.hl{background:rgba(255,214,10,.55);color:inherit;border-radius:2px}
mark.hl-note{background:rgba(0,212,170,.38);box-shadow:inset 0 -2px 0 #00a884}
mark.reader-search-hit{background:rgba(255,154,40,.7);color:inherit;outline:2px solid rgba(255,154,40,.4);border-radius:2px}
`;

const THROTTLE_MS = 250;

/** HTML completo del documento que se muestra en el iframe (también lo usan las pruebas). */
export function pageHtml(content) {
  const body = content.blocks.map((b, i) => '<div class="blk" data-b="' + i + '">' + b.html + '</div>').join('');
  return '<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>' + content.css + '</style><style>' + READER_CSS + '</style></head>' +
    '<body><main id="doc">' + body + '</main></body></html>';
}

export function createReflowViewer({ host, onSelectionChange, onProgress }) {
  let iframe = null;
  let doc = null;
  let win = null;
  let blocks = []; // elementos .blk, en orden
  let flat = { text: '', starts: [] };
  let texts = [];
  let searchQuery = '';
  let searchMatches = [];
  let searchIndex = -1;
  let searchMarks = [];
  let scrollTimer = 0;
  let selTimer = 0;

  const textNodesOf = (el) => {
    const out = [];
    const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n);
    return out;
  };

  /** (nodo, offset) del DOM -> offset global en el texto aplanado. */
  function toGlobal(container, offset, edge) {
    const el = container.nodeType === 1 ? container : container.parentElement;
    const blk = el && el.closest && el.closest('.blk');
    if (blk) {
      const b = Number(blk.dataset.b);
      const r = doc.createRange();
      r.setStart(blk, 0);
      r.setEnd(container, offset);
      return flat.starts[b] + r.toString().length;
    }
    // Selección que empieza o termina entre bloques (en #doc o en body): se ajusta al borde más cercano.
    if (container.id === 'doc' && blocks.length) {
      if (edge === 'start') return flat.starts[Math.min(offset, blocks.length - 1)];
      const b = Math.max(0, Math.min(offset - 1, blocks.length - 1));
      return flat.starts[b] + texts[b].length;
    }
    return edge === 'start' ? 0 : flat.text.length;
  }

  /** Selección actual -> { anchor, text } o null si no hay nada seleccionado. */
  function captureSelection() {
    if (!win) return null;
    const sel = win.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    const raw = {
      s: toGlobal(range.startContainer, range.startOffset, 'start'),
      e: toGlobal(range.endContainer, range.endOffset, 'end')
    };
    const { s, e } = trimRange(flat.text, Math.min(raw.s, raw.e), Math.max(raw.s, raw.e));
    if (e <= s) return null;
    return { anchor: makeAnchor(flat.text, s, e), text: flat.text.slice(s, e).replace(/\n+/g, ' ') };
  }

  /** Envuelve en <mark> el tramo [from, to) del texto de un bloque, nodo de texto por nodo de texto. */
  function wrapInBlock(blockEl, from, to, item) {
    let pos = 0;
    const marks = [];
    for (const node of textNodesOf(blockEl)) {
      const start = pos;
      const end = pos + node.data.length;
      pos = end;
      if (end <= from || start >= to) continue;
      const a = Math.max(from, start) - start;
      const b = Math.min(to, end) - start;
      let target = node;
      if (b < node.data.length) target.splitText(b);
      if (a > 0) target = target.splitText(a);
      const mark = doc.createElement('mark');
      mark.className = item.className || ('hl hl-' + item.type);
      mark.dataset.hl = item.id;
      target.parentNode.insertBefore(mark, target);
      mark.appendChild(target);
      marks.push(mark);
    }
    return marks;
  }

  function clearSearchMarks() {
    searchMarks.forEach((mark) => {
      if (mark.isConnected) mark.replaceWith(...mark.childNodes);
    });
    searchMarks = [];
    blocks.forEach((block) => block.normalize());
  }

  function findText(query, direction = 1) {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) {
      clearSearchMarks();
      searchQuery = '';
      searchMatches = [];
      searchIndex = -1;
      return null;
    }

    if (needle !== searchQuery) {
      clearSearchMarks();
      searchQuery = needle;
      searchMatches = [];
      searchIndex = -1;
      const text = flat.text.toLocaleLowerCase();
      let from = 0;
      while ((from = text.indexOf(needle, from)) !== -1) {
        searchMatches.push({ start: from, end: from + needle.length });
        from += Math.max(1, needle.length);
      }
    }

    if (!searchMatches.length) return null;
    searchIndex = searchIndex < 0
      ? (direction > 0 ? 0 : searchMatches.length - 1)
      : (searchIndex + direction + searchMatches.length) % searchMatches.length;
    clearSearchMarks();
    const match = searchMatches[searchIndex];
    const segments = splitByBlocks(flat.starts, texts, match.start, match.end);
    for (const segment of segments) {
      const mark = wrapInBlock(blocks[segment.b], segment.from, segment.to, {
        id: 'reader-search',
        type: 'search',
        className: 'reader-search-hit'
      });
      if (mark) searchMarks.push(...mark);
    }
    const firstBlock = blocks[segments[0]?.b];
    if (firstBlock && firstBlock.scrollIntoView) firstBlock.scrollIntoView({ block: 'center' });
    onProgress && onProgress(progress());
    return {
      index: searchIndex + 1,
      total: searchMatches.length,
      block: segments[0]?.b || 0
    };
  }

  /** Pinta una anotación. Devuelve false si ya no se puede ubicar en el texto (huérfana). */
  function addHighlight(item) {
    const pos = resolveAnchor(item.anchor, flat.text);
    if (!pos) return false;
    for (const seg of splitByBlocks(flat.starts, texts, pos.s, pos.e)) {
      wrapInBlock(blocks[seg.b], seg.from, seg.to, item);
    }
    return true;
  }

  function progress() {
    const root = doc.scrollingElement || doc.documentElement;
    const max = Math.max(1, root.scrollHeight - root.clientHeight);
    const ratio = Math.min(1, Math.max(0, root.scrollTop / max));
    // Primer bloque cuyo borde inferior todavía está en pantalla.
    let lo = 0;
    let hi = blocks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (blocks[mid].offsetTop + blocks[mid].offsetHeight > root.scrollTop) hi = mid; else lo = mid + 1;
    }
    return { ratio, block: blocks.length ? lo : 0 };
  }

  function bindEvents() {
    win.addEventListener('scroll', () => {
      if (scrollTimer) return;
      scrollTimer = setTimeout(() => { scrollTimer = 0; onProgress && onProgress(progress()); }, THROTTLE_MS);
    }, { passive: true });

    // En el celular no hay mouseup confiable: selectionchange cubre el arrastre de los manijas.
    doc.addEventListener('selectionchange', () => {
      clearTimeout(selTimer);
      selTimer = setTimeout(() => onSelectionChange && onSelectionChange(captureSelection()), 150);
    });

    // Los enlaces del documento no deben navegar el iframe; los internos (#ancla) sí se siguen.
    doc.addEventListener('click', (ev) => {
      const a = ev.target.closest && ev.target.closest('a[href]');
      if (!a) return;
      ev.preventDefault();
      const href = a.getAttribute('href') || '';
      if (href.startsWith('#')) {
        const target = doc.getElementById(decodeURIComponent(href.slice(1)));
        if (target) target.scrollIntoView();
      }
    });
  }

  return {
    /** content: ReflowContent. highlights: anotaciones con ancla. Devuelve las que no se pudieron ubicar. */
    async mount(content, { highlights = [], startBlock = 0 } = {}) {
      this.destroy();
      iframe = document.createElement('iframe');
      iframe.className = 'reader-frame';
      iframe.setAttribute('sandbox', 'allow-same-origin');
      iframe.style.cssText = 'width:100%;height:100%;border:0;display:block;background:#1a1a1a';
      const loaded = new Promise((resolve) => iframe.addEventListener('load', resolve, { once: true }));
      iframe.srcdoc = pageHtml(content);
      host.appendChild(iframe);
      await loaded;
      return this.attach(iframe.contentDocument, iframe.contentWindow, { highlights, startBlock });
    },
    /**
     * Engancha el visor a un documento ya cargado (el del iframe). Está separado de `mount` para poder
     * probar la selección y los resaltados con un DOM de prueba, que no implementa iframe.srcdoc.
     */
    attach(frameDoc, frameWin, { highlights = [], startBlock = 0 } = {}) {
      doc = frameDoc;
      win = frameWin;
      blocks = Array.from(doc.querySelectorAll('.blk'));
      texts = blocks.map((el) => el.textContent);
      flat = flatten(texts);

      const orphans = highlights.filter((h) => h.anchor && !addHighlight(h));
      bindEvents();
      if (startBlock > 0 && blocks[startBlock]) blocks[startBlock].scrollIntoView();
      onProgress && onProgress(progress());
      return orphans;
    },
    addHighlight,
    captureSelection,
    findText,
    clearFind() {
      clearSearchMarks();
      searchQuery = '';
      searchMatches = [];
      searchIndex = -1;
    },
    clearSelection() { if (win) win.getSelection().removeAllRanges(); },
    setProgress(ratio) {
      if (!doc) return;
      const root = doc.scrollingElement || doc.documentElement;
      root.scrollTop = ratio * Math.max(0, root.scrollHeight - root.clientHeight);
    },
    progress: () => (doc ? progress() : { ratio: 0, block: 0 }),
    blockCount: () => blocks.length,
    hasText: () => flat.text.trim().length > 0,
    destroy() {
      clearTimeout(scrollTimer);
      clearTimeout(selTimer);
      scrollTimer = 0;
      selTimer = 0;
      if (iframe) iframe.remove();
      iframe = doc = win = null;
      blocks = [];
      texts = [];
      flat = { text: '', starts: [] };
      searchQuery = '';
      searchMatches = [];
      searchIndex = -1;
      searchMarks = [];
    }
  };
}

'use strict';
/**
 * MC Browser -- modulo document-editor / core/paste.js
 *
 * Pegado con formato: convierte el HTML del portapapeles (Word, Google Docs,
 * una pagina web) en bloques del modelo. Solo se conserva lo que el modelo
 * representa: titulos, parrafos, listas, citas, codigo, tablas e imagenes
 * data:, con formato de tramo (negrita, cursiva, subrayado, tachado, color,
 * resaltado, fuente, tamano, enlace). Scripts, estilos, clases y el resto del
 * marcado se descartan.
 *
 * No toca `window` ni `document`: recibe el elemento raiz ya parseado (el
 * renderer usa DOMParser; los tests, jsdom).
 */
(function (root, factory) {
  const isNode = typeof require === 'function' && typeof module === 'object';
  const mod = factory({
    model: isNode ? require('./model.js') : (root.MCDoc && root.MCDoc.model),
    domRuns: isNode ? require('./dom-runs.js') : (root.MCDoc && root.MCDoc.domRuns),
    runs: isNode ? require('./runs.js') : (root.MCDoc && root.MCDoc.runs)
  });
  if (isNode && module.exports) module.exports = mod;
  if (typeof window !== 'undefined') {
    window.MCDoc = window.MCDoc || {};
    window.MCDoc.paste = mod;
  }
})(this, function (deps) {
  const { model, domRuns, runs: runsLib } = deps;

  const SKIP = new Set(['script', 'style', 'head', 'meta', 'link', 'title', 'noscript', 'template', 'o:p', 'xml', 'svg', 'iframe', 'object', 'embed']);
  const TEXT_BLOCKS = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'figure', 'figcaption', 'address']);
  const MAX_BLOCKS = 500;

  const tagOf = (n) => String(n.tagName || '').toLowerCase();
  const styleOf = (n) => String((n.getAttribute && n.getAttribute('style')) || '');

  // Valores que Word y los navegadores escriben en CADA tramo aunque nadie los
  // haya elegido: se descartan para no llenar el documento de formato falso.
  function cleanRuns(list) {
    const out = (list || []).map((r) => {
      const c = Object.assign({}, r);
      if (c.size === 11) delete c.size;
      if (c.font && /^calibri$/i.test(c.font)) delete c.font;
      if (c.color && /^#(000|000000)$/i.test(c.color)) delete c.color;
      if (c.highlight && /^#(fff|ffffff)$/i.test(c.highlight)) delete c.highlight;
      for (const k of ['bold', 'italic', 'underline', 'strike']) if (c[k] === false) delete c[k];
      return c;
    });
    return runsLib.normalize(out);
  }

  function trimRuns(list) {
    const out = list.map((r) => Object.assign({}, r));
    while (out.length && !out[0].text.replace(/^\s+/, '')) out.shift();
    if (out.length) out[0].text = out[0].text.replace(/^[ \t\r\n]+/, '');
    while (out.length && !out[out.length - 1].text.replace(/\s+$/, '')) out.pop();
    if (out.length) out[out.length - 1].text = out[out.length - 1].text.replace(/[ \t\r\n]+$/, '');
    return out;
  }

  function alignOf(el) {
    const m = /text-align\s*:\s*(left|center|right|justify)/i.exec(styleOf(el)) || (el.getAttribute && /^(left|center|right|justify)$/i.exec(el.getAttribute('align') || ''));
    return m ? m[1].toLowerCase() : null;
  }

  // Word pega los items de lista como <p style="mso-list:l0 level1 lfo1"> con el
  // simbolo dentro de un <span style="mso-list:Ignore">: se quita el simbolo.
  function isWordListItem(el) {
    return /mso-list\s*:\s*(?!none)/i.test(styleOf(el)) && !/mso-list\s*:\s*ignore/i.test(styleOf(el));
  }
  function wordListOrdered(el) {
    // El simbolo ("1.", "a)", "·") vive en el span que Word marca como Ignore.
    let sym = '';
    (function walk(n) {
      for (const c of Array.from(n.childNodes || [])) {
        if (c.nodeType !== 1) continue;
        if (/mso-list\s*:\s*ignore/i.test(styleOf(c))) sym += c.textContent; else walk(c);
      }
    })(el);
    return /^\s*(\d+|[a-zA-Z]|[ivxIVX]+)[.)]/.test(sym);
  }
  function textWithoutIgnored(el) {
    let s = '';
    (function walk(n) {
      for (const c of Array.from(n.childNodes || [])) {
        if (c.nodeType === 3) s += c.nodeValue;
        else if (c.nodeType === 1 && !/mso-list\s*:\s*ignore/i.test(styleOf(c)) && !SKIP.has(tagOf(c))) walk(c);
      }
    })(el);
    return s;
  }
  function stripIgnored(el) {
    const copy = el.cloneNode(true);
    const kill = [];
    (function find(n) {
      for (const c of Array.from(n.childNodes || [])) {
        if (c.nodeType === 1) { if (/mso-list\s*:\s*ignore/i.test(styleOf(c))) kill.push(c); else find(c); }
      }
    })(copy);
    kill.forEach((k) => k.remove());
    return copy;
  }

  const plain = (el) => String(el.textContent || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

  function runBlock(type, el, extra) {
    const list = trimRuns(cleanRuns(domRuns.read(el)));
    if (!list.length || !runsLib.toPlain(list).trim()) return null;
    const block = Object.assign({ type }, extra || {});
    const align = alignOf(el);
    if (align && align !== 'left') block.align = align;
    if (runsLib.hasFormatting(list)) block.runs = list; else block.text = runsLib.toPlain(list);
    return block;
  }

  // Texto en una linea (espacios colapsados) con sus tramos de formato; null
  // en `runs` si no hay formato. Sirve para items de lista y celdas.
  function inlineCell(el) {
    let list = trimRuns(cleanRuns(domRuns.read(el)));
    list = list.map((r) => Object.assign({}, r, { text: String(r.text).replace(/[\s\u00a0]+/g, ' ') }));
    list = runsLib.normalize(list);
    list = trimRuns(list);
    const text = runsLib.toPlain(list);
    if (!text) return { text: '', runs: null };
    return { text, runs: runsLib.hasFormatting(list) ? list : null };
  }

  function listItems(el, out) {
    for (const li of Array.from(el.children || [])) {
      const t = tagOf(li);
      if (t === 'li') {
        const copy = li.cloneNode(true);
        Array.from(copy.querySelectorAll('ul,ol')).forEach((n) => n.remove());
        const cell = inlineCell(copy);
        if (cell.text) out.push(cell);
        Array.from(li.children || []).filter((c) => /^(ul|ol)$/.test(tagOf(c))).forEach((n) => listItems(n, out));
      } else if (t === 'ul' || t === 'ol') listItems(li, out);
    }
    return out;
  }

  function tableBlock(el) {
    const cells = Array.from(el.querySelectorAll('tr')).map((tr) =>
      Array.from(tr.children).filter((c) => /^(td|th)$/.test(tagOf(c))).map(inlineCell)).filter((r) => r.length);
    if (!cells.length) return null;
    const hasHead = !!el.querySelector('th');
    const block = { type: 'table', rows: cells.map((r) => r.map((c) => c.text)), header: hasHead };
    const cellRuns = {};
    cells.forEach((r, i) => r.forEach((c, j) => { if (c.runs) cellRuns[i + ',' + j] = c.runs; }));
    if (Object.keys(cellRuns).length) block.cellRuns = cellRuns;
    return block;
  }

  // listItems devuelve {text, runs}; aqui se arma el bloque lista.
  function listBlock(cells, ordered) {
    const block = { type: 'list', items: cells.map((c) => c.text), ordered };
    if (cells.some((c) => c.runs)) block.itemRuns = cells.map((c) => c.runs || null);
    return block;
  }

  /**
   * blocksFromHtml(rootElement) -> bloques del modelo (sin ids).
   * `rootElement` es el body (o cualquier contenedor) del HTML pegado.
   */
  function blocksFromHtml(rootEl) {
    const blocks = [];
    let inline = [];         // nodos sueltos que forman un parrafo
    let wordList = null;     // lista que se va armando con parrafos de Word

    const flushInline = () => {
      if (!inline.length) return;
      const holder = rootEl.ownerDocument.createElement('div');
      inline.forEach((n) => holder.appendChild(n.cloneNode(true)));
      inline = [];
      const b = runBlock('paragraph', holder);
      if (b) blocks.push(b);
    };
    const flushList = () => {
      if (wordList && wordList.items.length) {
        if (!wordList.itemRuns.some(Boolean)) delete wordList.itemRuns;
        blocks.push(wordList);
      }
      wordList = null;
    };
    const push = (b) => { if (b) { flushInline(); flushList(); blocks.push(b); } };

    const visit = (node) => {
      for (const n of Array.from(node.childNodes || [])) {
        if (blocks.length >= MAX_BLOCKS) return;
        if (n.nodeType === 3) { if ((n.nodeValue || '').trim() || inline.length) inline.push(n); continue; }
        if (n.nodeType !== 1) continue;
        const t = tagOf(n);
        if (SKIP.has(t)) continue;
        if (/^h[1-6]$/.test(t)) { push(runBlock('heading', n, { level: Math.min(3, Number(t[1])) })); continue; }
        if (t === 'ul' || t === 'ol') {
          const items = listItems(n, []);
          if (items.length) push(listBlock(items, t === 'ol'));
          continue;
        }
        if (t === 'blockquote') { push(runBlock('quote', n)); continue; }
        if (t === 'pre') {
          const text = String(n.textContent || '').replace(/ /g, ' ').replace(/\s+$/, '');
          if (text.trim()) push({ type: 'code', text });
          continue;
        }
        if (t === 'table') { push(tableBlock(n)); continue; }
        if (t === 'hr') { push({ type: 'hr' }); continue; }
        if (t === 'img') {
          const src = n.getAttribute('src') || '';
          if (model.isSafeImageSrc(src)) push({ type: 'image', src, alt: n.getAttribute('alt') || '' });
          continue;
        }
        if (t === 'p' && isWordListItem(n)) {
          const clean = stripIgnored(n);
          const cell = inlineCell(clean);
          if (!cell.text) continue;
          flushInline();
          const ordered = wordListOrdered(n);
          if (wordList && wordList.ordered !== ordered) flushList();
          if (!wordList) wordList = { type: 'list', items: [], itemRuns: [], ordered };
          wordList.items.push(cell.text);
          wordList.itemRuns.push(cell.runs || null);
          continue;
        }
        if (TEXT_BLOCKS.has(t)) {
          // Un contenedor con bloques adentro se recorre; uno de texto es un parrafo.
          const hasBlocks = Array.from(n.children).some((c) => /^(p|div|h[1-6]|ul|ol|table|blockquote|pre|hr|img)$/.test(tagOf(c)));
          if (hasBlocks) { flushInline(); flushList(); visit(n); } else push(runBlock('paragraph', n));
          continue;
        }
        // Inline suelto (span, b, a, font...): se agrupa en un parrafo.
        inline.push(n);
      }
    };
    visit(rootEl);
    flushInline();
    flushList();
    return blocks.slice(0, MAX_BLOCKS).filter(Boolean);
  }

  /** true si pegar estos bloques aporta algo que el texto plano no tiene. */
  function isRich(blocks) {
    if (!blocks.length) return false;
    if (blocks.length > 1) return true;
    const b = blocks[0];
    return b.type !== 'paragraph' || !!b.runs || !!b.align;
  }

  return { blocksFromHtml, isRich, cleanRuns };
});

'use strict';
/**
 * MC Browser -- modulo document-editor / core/dom-blocks.js
 *
 * Superficie continua -> modelo. El documento se edita en UN solo
 * contenteditable (como Google Docs o Word): el navegador maneja la seleccion,
 * Enter, Retroceso, Supr, pegar y arrastrar entre parrafos. Este modulo lee ese
 * DOM y devuelve la lista de bloques del modelo; el renderer compara contra el
 * documento y manda solo lo que cambio.
 *
 * Cada bloque pintado lleva `data-id`. Cuando el navegador parte un parrafo
 * (Enter) copia los atributos al nuevo, asi que un id repetido o ausente
 * significa "bloque nuevo": aqui solo se informa, el renderer decide.
 *
 * No toca `window` ni `document`: recibe el elemento raiz ya parseado (el
 * renderer usa el DOM vivo; los tests, jsdom).
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
    window.MCDoc.domBlocks = mod;
  }
})(this, function (deps) {
  const { model, domRuns, runs: runsLib } = deps;

  const MAX_BLOCKS = 5000;
  const tagOf = (n) => String((n && n.tagName) || '').toLowerCase();
  const attr = (n, k) => (n && n.getAttribute ? n.getAttribute(k) : null);
  const BLOCKISH = /^(p|div|h[1-6]|ul|ol|table|blockquote|pre|hr|figure|section|article)$/;
  const SKIP = new Set(['script', 'style', 'template']);

  // ---- formato del bloque (el que va en style="" del elemento) -------------
  function blockProps(el) {
    const out = {};
    const st = domRuns.parseStyle(attr(el, 'style'));
    const al = String(st['text-align'] || attr(el, 'align') || '').toLowerCase();
    if (al === 'center' || al === 'right' || al === 'justify') out.align = al;
    const size = st['font-size'] ? domRuns.parsePt(st['font-size']) : null;
    if (size) out.size = size;
    const color = st.color ? domRuns.parseColor(st.color) : null;
    if (color) out.color = color;
    const fw = String(st['font-weight'] || '').toLowerCase();
    if (fw === 'bold' || fw === 'bolder' || parseInt(fw, 10) >= 600) out.bold = true;
    if (/italic|oblique/i.test(st['font-style'] || '')) out.italic = true;
    if (/underline/i.test(st['text-decoration'] || st['text-decoration-line'] || '')) out.underline = true;
    const lh = parseFloat(st['line-height']);
    if (isFinite(lh) && lh > 0 && lh < 10) out.lineHeight = lh;
    const mt = st['margin-top'] ? domRuns.parsePt(st['margin-top']) : null;
    if (mt != null && mt >= 0 && st['margin-top']) out.spaceBefore = mt;
    const mb = st['margin-bottom'] ? domRuns.parsePt(st['margin-bottom']) : null;
    if (mb != null && mb >= 0 && st['margin-bottom']) out.spaceAfter = mb;
    const cap = attr(el, 'data-caption');
    if (cap === 'figure' || cap === 'table') out.caption = cap;
    const co = attr(el, 'data-callout');
    if (co && ['info', 'warn', 'ok', 'error'].includes(co)) out.callout = co;
    const bs = attr(el, 'data-box');
    if (bs && ['rect', 'round', 'ellipse'].includes(bs)) {
      out.box = { shape: bs, w: parseInt(attr(el, 'data-box-w'), 10) || 40, float: attr(el, 'data-box-float') || 'center', fill: attr(el, 'data-box-fill') || '#FFFFFF', border: attr(el, 'data-box-border') || '#555555' };
    }
    const hg = parseFloat(attr(el, 'data-hanging'));
    if (hg > 0) { out.hanging = Math.min(144, hg); delete out.firstLine; }
    const ind = parseInt(attr(el, 'data-indent'), 10);
    if (ind > 0) out.indent = Math.min(8, ind);
    const ti = st['text-indent'] ? domRuns.parsePt(st['text-indent']) : null;
    if (ti && ti > 0) out.firstLine = ti;
    return out;
  }

  // ---- texto en linea -------------------------------------------------------
  // Un <br> final no es un salto: es el marcador que el navegador deja para que
  // la linea exista ("abc<br>" es "abc"; "abc<br><br>" es "abc" + linea vacia).
  function lastIsBr(el) {
    for (let i = el.childNodes.length - 1; i >= 0; i--) {
      const n = el.childNodes[i];
      if (n.nodeType === 3 && !String(n.nodeValue || '').length) continue;
      return n.nodeType === 1 && tagOf(n) === 'br';
    }
    return false;
  }

  function dropTrailingBreak(list) {
    const out = list.map((r) => Object.assign({}, r));
    const last = out[out.length - 1];
    if (last && /\n$/.test(last.text)) {
      last.text = last.text.slice(0, -1);
      if (!last.text) out.pop();
    }
    return out;
  }

  /** Tramos de un elemento; los hijos-bloque (div/p dentro de una celda) separan lineas con \n. */
  function inlineRuns(el) {
    const kids = Array.from(el.childNodes || []);
    const hasBlocks = kids.some((c) => c.nodeType === 1 && BLOCKISH.test(tagOf(c)) && tagOf(c) !== 'table');
    let list;
    if (!hasBlocks) {
      list = domRuns.read(el);
      if (lastIsBr(el)) list = dropTrailingBreak(list);
    } else {
      list = [];
      let first = true;
      const push = (rr) => {
        if (!first) list.push({ text: '\n' });
        first = false;
        rr.forEach((r) => list.push(r));
      };
      let loose = [];
      const flushLoose = () => {
        if (!loose.length) return;
        const holder = el.ownerDocument.createElement('div');
        loose.forEach((n) => holder.appendChild(n.cloneNode(true)));
        loose = [];
        const rr = domRuns.read(holder);
        if (rr.length) push(rr);
      };
      kids.forEach((c) => {
        if (c.nodeType === 1 && BLOCKISH.test(tagOf(c))) {
          flushLoose();
          let rr = domRuns.read(c);
          if (lastIsBr(c)) rr = dropTrailingBreak(rr);
          push(rr);
        } else loose.push(c);
      });
      flushLoose();
      list = runsLib.normalize(list);
    }
    return list;
  }

  // Todo lo que Chromium deja como espacio duro; un bloque solo de espacios esta vacio.
  function cleanText(list) {
    const out = list.map((r) => Object.assign({}, r, { text: String(r.text).replace(/ /g, ' ') }));
    return runsLib.normalize(out);
  }

  function textBlock(type, el, extra) {
    let list = cleanText(inlineRuns(el));
    const plain = runsLib.toPlain(list);
    if (!plain.trim()) list = [];
    const block = Object.assign({ type }, extra || {}, blockProps(el));
    // Un titulo es negrita por naturaleza: no cuenta como formato propio.
    const clean = runsLib.compact(list, runsLib.defaultsOf(block));
    if (runsLib.hasFormatting(clean)) block.runs = clean;
    else block.text = plain.trim() ? runsLib.toPlain(clean) : '';
    return block;
  }

  function codeBlock(el) {
    let text = String(el.textContent || '').replace(/ /g, ' ');
    text = text.replace(/\r?\n$/, '');
    return Object.assign({ type: 'code', text }, blockProps(el));
  }

  // ---- listas ---------------------------------------------------------------
  function collectItems(list, out, depth, levels) {
    const d = depth || 0;
    for (const li of Array.from(list.children || [])) {
      const t = tagOf(li);
      if (t === 'li') {
        const copy = li.cloneNode(true);
        Array.from(copy.querySelectorAll('ul,ol')).forEach((n) => n.remove());
        let rr = cleanText(inlineRuns(copy));
        if (!runsLib.toPlain(rr).trim()) rr = [];
        out.push(rr);
        // Nivel: el declarado (data-lvl, lista plana del editor) o la profundidad de anidado.
        const declared = parseInt(attr(li, 'data-lvl'), 10);
        if (levels) levels.push(declared > 0 ? Math.min(2, declared) : Math.min(2, d));
        Array.from(li.children || []).filter((c) => /^(ul|ol)$/.test(tagOf(c))).forEach((n) => collectItems(n, out, d + 1, levels));
      } else if (t === 'ul' || t === 'ol') collectItems(li, out, d + 1, levels);
    }
    return out;
  }

  function listBlock(el) {
    const levels = [];
    const items = collectItems(el, [], 0, levels);
    if (!items.length) { items.push([]); levels.push(0); }
    const block = Object.assign({ type: 'list', ordered: tagOf(el) === 'ol' }, blockProps(el));
    block.items = items.map((rr) => runsLib.toPlain(rr));
    const itemRuns = items.map((rr) => (runsLib.hasFormatting(rr) ? rr : null));
    if (itemRuns.some(Boolean)) block.itemRuns = itemRuns;
    if (levels.some((l) => l > 0)) block.itemLevels = levels;
    const level = parseInt(attr(el, 'data-level'), 10);
    if (level > 0) block.level = Math.min(3, level);
    return block;
  }

  // ---- tablas ---------------------------------------------------------------
  function tableBlock(el) {
    const trs = Array.from(el.querySelectorAll('tr'));
    const grid = [];          // grid[r][c] = { text, runs, anchor }
    const merges = [];
    trs.forEach((tr, r) => {
      grid[r] = grid[r] || [];
      let c = 0;
      Array.from(tr.children).filter((x) => /^(td|th)$/.test(tagOf(x))).forEach((cell) => {
        while (grid[r][c]) c++;
        const cs = Math.max(1, Math.min(20, parseInt(attr(cell, 'colspan'), 10) || 1));
        const rs = Math.max(1, Math.min(100, parseInt(attr(cell, 'rowspan'), 10) || 1));
        let rr = cleanText(inlineRuns(cell));
        if (!runsLib.toPlain(rr).trim()) rr = [];
        const cst = domRuns.parseStyle(attr(cell, 'style'));
        const fill = domRuns.parseColor(cst.background || cst['background-color'] || '');
        const bsides = ['top', 'right', 'bottom', 'left'].map((n) => cst['border-' + n]);
        let bspec = null;
        if (bsides.some((v) => v != null)) {
          const on = bsides.map((v) => v != null && !/^\s*(none|0|hidden)/i.test(v) && !/transparent/i.test(v));
          bspec = on.every(Boolean) ? 'trbl' : on.some(Boolean) ? ['t', 'r', 'b', 'l'].filter((_, i) => on[i]).join('') : 'none';
        }
        for (let i = 0; i < rs; i++) for (let j = 0; j < cs; j++) {
          grid[r + i] = grid[r + i] || [];
          grid[r + i][c + j] = (i === 0 && j === 0) ? { rr, fill, bspec } : { rr: [], covered: true };
        }
        if (rs > 1 || cs > 1) merges.push({ r, c, rows: rs, cols: cs });
        c += cs;
      });
    });
    const height = grid.length;
    const width = Math.max(1, ...grid.map((g) => (g ? g.length : 0)));
    const rows = [];
    const cellRuns = {};
    const cellFill = {};
    const cellBorders = {};
    for (let r = 0; r < height; r++) {
      const row = [];
      for (let c = 0; c < width; c++) {
        const cell = grid[r] && grid[r][c];
        row.push(cell ? runsLib.toPlain(cell.rr) : '');
        if (cell && cell.fill) cellFill[r + ',' + c] = cell.fill;
        if (cell && cell.bspec) cellBorders[r + ',' + c] = cell.bspec;
        if (cell && runsLib.hasFormatting(cell.rr)) cellRuns[r + ',' + c] = cell.rr;
      }
      rows.push(row);
    }
    if (!rows.length) return null;
    const block = Object.assign({ type: 'table', rows, header: !!(trs[0] && trs[0].querySelector('th')) }, blockProps(el));
    if (Object.keys(cellRuns).length) block.cellRuns = cellRuns;
    if (Object.keys(cellFill).length) block.cellFill = cellFill;
    if (Object.keys(cellBorders).length) block.cellBorders = cellBorders;
    if (merges.length) block.merges = merges;
    const cols = Array.from(el.querySelectorAll('colgroup > col'));
    if (cols.length === width) {
      const w = cols.map((cc) => parseFloat(domRuns.parseStyle(attr(cc, 'style')).width));
      if (w.every((x) => isFinite(x) && x > 0)) block.colWidths = w;
    }
    const bd = attr(el, 'data-borders');
    if (bd === 'none' || bd === 'horizontal' || bd === 'outer') block.borders = bd;
    return block;
  }

  // ---- recorrido ------------------------------------------------------------
  /**
   * blocksFromSurface(root) -> [{ el, id, block, keep, width }]
   *   id:    data-id del elemento (puede repetirse o faltar)
   *   block: bloque del modelo sin id, o null si `keep`
   *   keep:  true para imagenes, saltos y lineas (no se editan escribiendo: se
   *          conserva el bloque anterior; `width` trae el ancho si cambio)
   */
  function blocksFromSurface(rootEl) {
    const out = [];
    let loose = [];

    const flushLoose = () => {
      if (!loose.length) return;
      const holder = rootEl.ownerDocument.createElement('p');
      loose.forEach((n) => holder.appendChild(n.cloneNode(true)));
      loose = [];
      const b = textBlock('paragraph', holder);
      out.push({ el: null, id: null, block: b, keep: false });
    };

    // Un parrafo partido entre hojas son varios elementos con el mismo data-id; los
    // que llevan data-cont continuan al anterior y se leen como un solo bloque.
    // El indice de contenido tambien se parte (por renglones, ver
    // splitTocToFit en el renderer) y tiene que leerse como UN bloque toc: si no,
    // guardarlo crearia un segundo indice y el editor dira que ya hay uno.
    const fragSkip = new Set();
    const fragOf = new Map();
    if (rootEl.querySelector && rootEl.querySelector('[data-cont]')) {
      // Elementos de bloque en orden (lo recien pegado aun no trae la clase doc-b).
      const pages = Array.from(rootEl.querySelectorAll('.doc-paper-content'));
      const tops = pages.length ? [].concat(...pages.map((c) => Array.from(c.children))) : Array.from(rootEl.children);
      const headOf = new Map();
      tops.forEach((e, i) => {
        if (!i || !e.hasAttribute('data-cont')) return;
        const prev = tops[i - 1];
        const head = headOf.get(prev) || prev;
        // Un parrafo recien pegado aun no tiene id: sus trozos tampoco, y cuentan igual.
        if ((attr(e, 'data-id') || '') !== (attr(head, 'data-id') || '') ||
            !(/^(p|blockquote)$/.test(tagOf(head)) || attr(head, 'data-type') === 'toc')) return;
        headOf.set(e, head);
        fragSkip.add(e);
        if (!fragOf.has(head)) fragOf.set(head, []);
        fragOf.get(head).push(e);
      });
    }
    const joined = (n) => {
      const fr = fragOf.get(n);
      if (!fr) return n;
      const m = n.cloneNode(true);
      fr.forEach((f) => Array.from(f.childNodes).forEach((c) => m.appendChild(c.cloneNode(true))));
      return m;
    };

    const add = (el, block, keep, extra) => {
      flushLoose();
      out.push(Object.assign({ el, id: attr(el, 'data-id') || null, block, keep: !!keep }, extra || {}));
    };

    const visit = (node) => {
      for (const n of Array.from(node.childNodes || [])) {
        if (out.length >= MAX_BLOCKS) return;
        if (n.nodeType === 3) { if (String(n.nodeValue || '').replace(/[\s ]+/g, '').length || loose.length) loose.push(n); continue; }
        if (n.nodeType !== 1) continue;
        const t = tagOf(n);
        if (SKIP.has(t) || n.hasAttribute('data-skip')) continue;
        if (fragSkip.has(n)) continue;
        if (n.classList && (n.classList.contains('doc-paper') || n.classList.contains('doc-paper-content') || n.classList.contains('doc-paper-stack'))) {
          flushLoose(); visit(n); continue;
        }
        const type = attr(n, 'data-type');
        if (type === 'pagebreak') { add(n, { type: 'pagebreak' }, true); continue; }
        if (t === 'hr' || type === 'hr') { add(n, { type: 'hr' }, true); continue; }
        if (type === 'toc') { add(n, { type: 'toc' }, true); continue; }
        if (type === 'image' || t === 'figure' || (n.classList && n.classList.contains('doc-img-wrap')) || t === 'img') {
          const wrap = n;
          const img = t === 'img' ? n : wrap.querySelector('img');
          const sizer = (wrap.classList && wrap.classList.contains('doc-img-wrap')) ? wrap : (wrap.querySelector && wrap.querySelector('.doc-img-wrap')) || wrap;
          let width = null;
          const st = domRuns.parseStyle(attr(sizer, 'style'));
          const w = parseFloat(st.width);
          if (isFinite(w) && w > 0) width = Math.round(w);
          add(n, null, true, { image: true, width, src: img ? img.getAttribute('src') : null });
          continue;
        }
        if (/^h[1-6]$/.test(t)) { add(n, textBlock('heading', n, { level: Math.min(3, Number(t[1])) })); continue; }
        if (t === 'ul' || t === 'ol') { add(n, listBlock(n)); continue; }
        if (t === 'blockquote') { add(n, textBlock('quote', joined(n))); continue; }
        if (t === 'pre') { add(n, codeBlock(n)); continue; }
        if (t === 'table') { const b = tableBlock(n); if (b) add(n, b); continue; }
        if (t === 'p') { add(n, textBlock('paragraph', joined(n))); continue; }
        if (t === 'div' || t === 'section' || t === 'article') {
          const hasBlocks = Array.from(n.children).some((c) => BLOCKISH.test(tagOf(c)) || (c.classList && c.classList.contains('doc-img-wrap')));
          if (hasBlocks) { flushLoose(); visit(n); } else add(n, textBlock('paragraph', n));
          continue;
        }
        loose.push(n);        // span, b, a, br...: texto suelto de un parrafo
      }
    };
    visit(rootEl);
    flushLoose();
    return out;
  }

  // ---- comparacion ----------------------------------------------------------
  function stable(v) {
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    if (v && typeof v === 'object') {
      return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
    }
    return JSON.stringify(v);
  }

  const EXTRAS = ['page', 'lang'];

  /** El bloque leido, ya normalizado como lo guarda el modelo, con lo que el DOM no expresa heredado del anterior. */
  function finalize(block, prev) {
    const raw = Object.assign({}, block);
    if (prev && prev.type === raw.type) for (const k of EXTRAS) if (prev[k] != null && raw[k] == null) raw[k] = prev[k];
    return model.normalizeBlock(raw);
  }

  function sameBlock(a, b) {
    if (!a || !b) return false;
    const x = Object.assign({}, a); const y = Object.assign({}, b);
    delete x.id; delete y.id;
    return stable(x) === stable(y);
  }

  /**
   * diffSurface(rootEl, prevBlocks) -> {
   *   blocks:  [{ el, id|null, block, changed, isNew }]   (en orden de pantalla)
   *   removed: [id]                                       (estaban y ya no)
   * }
   * Un id que ya aparecio antes en el recorrido (Enter copia los atributos) o que
   * no existe en el documento cuenta como bloque nuevo.
   */
  function diffSurface(rootEl, prevBlocks) {
    const prevById = new Map((prevBlocks || []).map((b) => [b.id, b]));
    const seen = new Set();
    const list = [];
    for (const item of blocksFromSurface(rootEl)) {
      const known = item.id && prevById.has(item.id) && !seen.has(item.id);
      const prev = known ? prevById.get(item.id) : null;
      let block;
      let skip = false;
      if (item.keep) {
        if (item.image) {
          if (!prev || prev.type !== 'image') {
            // Una imagen que llego por pegado del navegador: solo vale si es data:.
            if (item.src && model.isSafeImageSrc(item.src)) block = model.normalizeBlock({ type: 'image', src: item.src, width: item.width });
            else skip = true;
          } else {
            block = Object.assign({}, prev);
            if (item.width && item.width !== prev.width) block.width = item.width;
          }
        } else if (prev && prev.type === item.block.type) block = Object.assign({}, prev);
        else block = model.normalizeBlock(item.block);
      } else block = finalize(item.block, prev);
      if (skip || !block) continue;
      if (known) seen.add(item.id);
      list.push({ el: item.el, id: known ? item.id : null, block, changed: !known || !sameBlock(block, prev), isNew: !known });
    }
    const keepIds = new Set(list.filter((x) => x.id).map((x) => x.id));
    const removed = (prevBlocks || []).filter((b) => !keepIds.has(b.id)).map((b) => b.id);
    return { blocks: list, removed };
  }

  // ---- estadisticas ---------------------------------------------------------
  /** Palabras y caracteres de un texto (letras/numeros con apostrofes y guiones internos). */
  function countText(text) {
    const t = String(text == null ? '' : text).replace(/\u00a0/g, ' ');
    const m = t.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu);
    const flat = t.replace(/[\r\n]/g, '');
    return { words: m ? m.length : 0, chars: flat.length, charsNoSpaces: flat.replace(/\s/g, '').length };
  }

  /** Texto plano de la hoja continua (sin encabezados, pies ni objetos no editables). */
  function surfaceText(rootEl) {
    const out = [];
    const tops = Array.from(rootEl.querySelectorAll('.doc-b')).filter((e) => !(e.parentElement && e.parentElement.closest('.doc-b')));
    tops.forEach((e) => {
      if (attr(e, 'contenteditable') === 'false') return;
      const t = tagOf(e);
      let txt;
      if (t === 'table') txt = Array.from(e.querySelectorAll('td,th')).map((c) => c.textContent).join('\n');
      else if (t === 'ul' || t === 'ol') txt = Array.from(e.querySelectorAll('li')).map((c) => c.textContent).join('\n');
      else txt = e.textContent;
      if (e.hasAttribute('data-cont') && out.length) out[out.length - 1] += txt;
      else out.push(txt);
    });
    return out.join('\n');
  }

  return { blocksFromSurface, diffSurface, blockProps, sameBlock, countText, surfaceText };
});

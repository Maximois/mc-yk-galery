'use strict';
/**
 * MC Browser -- modulo document-editor / core/dom-runs.js
 *
 * Lee un nodo del DOM (o un DocumentFragment) y devuelve sus tramos con
 * formato. Es el puente entre la superficie editable (contenteditable) y el
 * modelo: el DOM es la verdad MIENTRAS se escribe y esto lo traduce a runs.
 *
 * No toca `window` ni `document`: recibe los nodos y solo usa su API de
 * lectura (childNodes, tagName, getAttribute), asi se prueba con jsdom.
 *
 * Se interpreta el MARCADO, no el estilo calculado: las etiquetas semanticas
 * (b, strong, i, em, u, s...) y el atributo style en linea, que es lo que
 * generan tanto core/html.js como execCommand con styleWithCSS. Estilos que
 * vienen de la hoja de estilos (un titulo en negrita por CSS) no cuentan:
 * son del bloque, no del tramo.
 */

(function (root, factory) {
  const mod = factory({
    model: (typeof require === 'function' && typeof module === 'object') ? require('./model.js') : (root.MCDoc && root.MCDoc.model),
    runs: (typeof require === 'function' && typeof module === 'object') ? require('./runs.js') : (root.MCDoc && root.MCDoc.runs)
  });
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (typeof window !== 'undefined') {
    window.MCDoc = window.MCDoc || {};
    window.MCDoc.domRuns = mod;
  }
})(this, function (deps) {
  const runs = deps.runs;
  const model = deps.model;

  // Tamanos de la escala <font size> y de las palabras clave de CSS, en puntos.
  const FONT_TAG_PT = { 1: 7.5, 2: 10, 3: 12, 4: 13.5, 5: 18, 6: 24, 7: 36 };
  const KEYWORD_PT = {
    'xx-small': 7, 'x-small': 7.5, small: 10, medium: 12, large: 13.5,
    'x-large': 18, 'xx-large': 24, 'xxx-large': 36
  };
  const BLOCK_TAGS = new Set(['div', 'p', 'li', 'h1', 'h2', 'h3', 'blockquote', 'pre']);

  function hex2(n) { return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0'); }

  /** #rgb, #rrggbb(aa), rgb()/rgba() -> #rrggbb, o null si es transparente o ilegible. */
  function parseColor(value) {
    const v = String(value || '').trim().toLowerCase();
    if (!v || v === 'transparent' || v === 'inherit' || v === 'initial' || v === 'currentcolor') return null;
    let m = v.match(/^#([0-9a-f]{3})$/);
    if (m) return '#' + m[1].split('').map((c) => c + c).join('');
    m = v.match(/^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/);
    if (m) return '#' + m[1];
    m = v.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/);
    if (m) {
      if (m[4] !== undefined) {
        const a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
        if (a === 0) return null;
      }
      return '#' + hex2(m[1]) + hex2(m[2]) + hex2(m[3]);
    }
    return null;
  }

  /** font-size -> puntos (multiplos de 0.5), o null si es relativo/ilegible. */
  function parsePt(value) {
    const v = String(value || '').trim().toLowerCase();
    if (KEYWORD_PT[v] != null) return KEYWORD_PT[v];
    const m = v.match(/^([\d.]+)(pt|px)$/);
    if (!m) return null;
    const n = m[2] === 'px' ? parseFloat(m[1]) * 0.75 : parseFloat(m[1]);
    if (!isFinite(n) || n <= 0) return null;
    return Math.round(n * 2) / 2;
  }

  function parseFamily(value) {
    const first = String(value || '').split(',')[0].trim().replace(/^["']|["']$/g, '').trim();
    if (!first || /^(inherit|initial)$/i.test(first)) return null;
    return first.slice(0, 60);
  }

  /** "a: b; c: d" -> { a: 'b', c: 'd' } (nombres en minusculas). */
  function parseStyle(attr) {
    const out = {};
    String(attr || '').split(';').forEach((part) => {
      const i = part.indexOf(':');
      if (i < 1) return;
      out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
    });
    return out;
  }

  function propsOfElement(el, tag) {
    const p = {};
    if (tag === 'b' || tag === 'strong') p.bold = true;
    if (tag === 'i' || tag === 'em') p.italic = true;
    if (tag === 'u' || tag === 'ins') p.underline = true;
    if (tag === 's' || tag === 'strike' || tag === 'del') p.strike = true;
    if (tag === 'a') {
      const href = String(el.getAttribute('href') || '').trim();
      if (model.isSafeLink(href)) p.link = href;
    }
    if (el.getAttribute) {
      const note = el.getAttribute('data-note');
      if (note) p.note = note;
      const comment = el.getAttribute('data-comment');
      if (comment) p.comment = comment;
      const ins = el.getAttribute('data-ins');
      if (ins) p.ins = ins;
      const del = el.getAttribute('data-del');
      if (del) p.del = del;
    }
    if (tag === 'font') {
      const color = parseColor(el.getAttribute('color'));
      if (color) p.color = color;
      const face = parseFamily(el.getAttribute('face'));
      if (face) p.font = face;
      const size = FONT_TAG_PT[parseInt(el.getAttribute('size'), 10)];
      if (size) p.size = size;
    }
    const st = parseStyle(el.getAttribute('style'));
    if (st['font-weight']) {
      const w = st['font-weight'].toLowerCase();
      if (w === 'bold' || w === 'bolder' || parseInt(w, 10) >= 600) p.bold = true;
      else if (w === 'normal' || w === 'lighter' || parseInt(w, 10) < 600) p.bold = false;
    }
    if (st['font-style']) {
      const s = st['font-style'].toLowerCase();
      if (s === 'italic' || s === 'oblique') p.italic = true;
      else if (s === 'normal') p.italic = false;
    }
    const deco = (st['text-decoration-line'] || st['text-decoration'] || '').toLowerCase();
    if (deco) {
      if (deco.includes('underline')) p.underline = true;
      if (deco.includes('line-through')) p.strike = true;
      // `none` solo se registra para el subrayado: un tachado explicito en falso
      // nunca hace falta (ningun bloque lo trae por defecto).
      if (deco.trim() === 'none') p.underline = false;
    }
    if (st.color) { const c = parseColor(st.color); if (c) p.color = c; }
    const bg = parseColor(st['background-color'] || st.background);
    if (bg) p.highlight = bg;
    if (st['font-family']) { const f = parseFamily(st['font-family']); if (f) p.font = f; }
    if (st['font-size']) { const s = parsePt(st['font-size']); if (s) p.size = s; }
    return p;
  }

  function walk(node, inherited, out) {
    const kids = node.childNodes || [];
    for (let i = 0; i < kids.length; i++) {
      const n = kids[i];
      if (n.nodeType === 3) {
        const text = String(n.nodeValue || '').replace(/\u00a0/g, ' ');
        if (text) out.push(Object.assign({ text }, inherited));
      } else if (n.nodeType === 1) {
        const tag = String(n.tagName || '').toLowerCase();
        if (tag === 'br') { out.push(Object.assign({ text: '\n' }, inherited)); continue; }
        if (tag === 'script' || tag === 'style') continue;
        walk(n, Object.assign({}, inherited, propsOfElement(n, tag)), out);
        // Un bloque anidado (lo que pega o arrastra el navegador) separa lineas.
        if (BLOCK_TAGS.has(tag) && i < kids.length - 1) out.push(Object.assign({ text: '\n' }, inherited));
      }
    }
  }

  /** Tramos de un elemento o fragmento, ya normalizados. */
  function read(root) {
    const out = [];
    if (root) walk(root, {}, out);
    return runs.normalize(out);
  }

  return { read, parseColor, parsePt, parseStyle, propsOfElement };
});

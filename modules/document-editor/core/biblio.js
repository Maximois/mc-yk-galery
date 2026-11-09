'use strict';
/**
 * MC Browser -- modulo document-editor / core/biblio.js
 *
 * Citas y bibliografia: formatea una fuente en APA 7 o ISO 690 (numerica),
 * genera la cita en el texto y ordena/renumera la lista de referencias.
 * Funciones puras (sin DOM ni Electron).
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else { root.MCDoc = root.MCDoc || {}; root.MCDoc.biblio = mod; }
})(typeof self !== 'undefined' ? self : this, function () {
  const STYLES = ['apa', 'iso'];

  // "Garcia Lopez, Ana; Perez, Juan" -> [{ last, first }]
  function parseAuthors(s) {
    return String(s || '').split(/\s*;\s*|\s+y\s+(?=[^,]+,)/i).map((x) => x.trim()).filter(Boolean).map((x) => {
      const i = x.indexOf(',');
      return i < 0 ? { last: x, first: '' } : { last: x.slice(0, i).trim(), first: x.slice(i + 1).trim() };
    });
  }

  function initials(first) {
    return String(first || '').split(/[\s-]+/).filter(Boolean).map((n) => n[0].toUpperCase() + '.').join(' ');
  }

  function clean(src) {
    const t = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n || 300);
    return { authors: t(src.authors), year: t(src.year, 12), title: t(src.title), publisher: t(src.publisher), place: t(src.place), url: t(src.url, 500) };
  }

  /** Cita en el texto. APA: (Apellido, 2020); ISO: [n]. */
  function cite(src, style, n) {
    const s = clean(src);
    if (style === 'iso') return '[' + (n || 1) + ']';
    const a = parseAuthors(s.authors);
    const year = s.year || 's. f.';
    if (!a.length) return '(' + (s.title.split(' ').slice(0, 4).join(' ') || 'Anónimo') + ', ' + year + ')';
    const who = a.length === 1 ? a[0].last : a.length === 2 ? a[0].last + ' y ' + a[1].last : a[0].last + ' et al.';
    return '(' + who + ', ' + year + ')';
  }

  /** Entrada de la lista como tramos [{ text, italic? }]. */
  function reference(src, style, n) {
    const s = clean(src);
    const a = parseAuthors(s.authors);
    const out = [];
    const push = (text, italic) => { if (text) out.push(italic ? { text, italic: true } : { text }); };
    if (style === 'iso') {
      push('[' + (n || 1) + '] ');
      push(a.map((x) => x.last.toUpperCase() + (x.first ? ', ' + x.first : '')).join('; '));
      if (a.length) push('. ');
      push(s.title, true);
      push('. ');
      const pub = [s.place, s.publisher].filter(Boolean).join(': ');
      push([pub, s.year].filter(Boolean).join(', '));
      push('.');
      if (s.url) push(' Disponible en: ' + s.url);
      return out;
    }
    const names = a.map((x) => x.last + (x.first ? ', ' + initials(x.first) : ''));
    const who = names.length > 1 ? names.slice(0, -1).join(', ') + ', & ' + names[names.length - 1] : names[0] || '';
    if (who) push(who + ' ');
    push('(' + (s.year || 's. f.') + '). ');
    push(s.title, true);
    push('. ');
    if (s.publisher) push(s.publisher + '.');
    if (s.url) push((s.publisher ? ' ' : '') + s.url);
    if (out.length && /\s$/.test(out[out.length - 1].text)) out[out.length - 1].text = out[out.length - 1].text.trimEnd();
    return out;
  }

  const plain = (runs) => runs.map((r) => r.text).join('');
  const isIso = (text) => /^\[\d+\]\s/.test(text);

  /**
   * Ordena la lista de referencias (APA: alfabetica) o la renumera (ISO: en
   * orden de aparicion). `entries`: [{ text, runs }]. Devuelve el nuevo orden
   * como [{ text, runs }] con los numeros ISO corregidos.
   */
  function arrange(entries) {
    const list = entries.slice();
    if (list.length && list.every((e) => isIso(e.text))) {
      return list.map((e, i) => {
        const fix = (t) => t.replace(/^\[\d+\]/, '[' + (i + 1) + ']');
        const runs = (e.runs || []).map((r, k) => (k === 0 ? Object.assign({}, r, { text: fix(r.text) }) : r));
        return { text: fix(e.text), runs };
      });
    }
    return list.sort((x, y) => x.text.localeCompare(y.text, 'es', { sensitivity: 'base' }));
  }

  return { STYLES, parseAuthors, cite, reference, arrange, plain, isIso };
});

'use strict';
/**
 * MC Browser -- modulo document-editor / core/merge.js
 *
 * Combinar correspondencia: una plantilla con campos {{columna}} y una tabla
 * CSV generan una copia de la plantilla por fila, separadas por salto de
 * pagina. Funciones puras (sin DOM ni Electron).
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else { root.MCDoc = root.MCDoc || {}; root.MCDoc.merge = mod; }
})(typeof self !== 'undefined' ? self : this, function () {
  const MAX_ROWS = 500;
  const FIELD_RE = /\{\{\s*([^{}]{1,60}?)\s*\}\}/g;

  /** CSV con comillas; separador coma, punto y coma o tabulador (se detecta). */
  function parseCsv(text) {
    let s = String(text == null ? '' : text).replace(/^﻿/, '');
    const first = s.split(/\r?\n/, 1)[0] || '';
    const sep = [';', '\t', ','].map((c) => [c, first.split(c).length]).sort((a, b) => b[1] - a[1])[0][0];
    const rows = [];
    let row = [], cur = '', q = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) {
        if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
      } else if (c === '"') q = true;
      else if (c === sep) { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && s[i + 1] === '\n') i++;
        row.push(cur); cur = '';
        if (row.some((x) => x.trim() !== '')) rows.push(row);
        row = [];
      } else cur += c;
    }
    row.push(cur);
    if (row.some((x) => x.trim() !== '')) rows.push(row);
    if (!rows.length) return { headers: [], rows: [] };
    const headers = rows[0].map((h) => h.trim());
    return { headers, rows: rows.slice(1, MAX_ROWS + 1).map((r) => headers.map((_, i) => (r[i] == null ? '' : r[i].trim()))) };
  }

  /** Campos {{x}} usados por una lista de bloques. */
  function fieldsOf(blocks) {
    const found = new Set();
    const scan = (t) => { String(t == null ? '' : t).replace(FIELD_RE, (m, k) => { found.add(k); return m; }); };
    walk(blocks, scan);
    return Array.from(found);
  }

  // Aplica fn a cada cadena de texto del contenido de los bloques.
  function walk(blocks, fn) {
    const runs = (rr) => (rr || []).forEach((r) => { if (r && r.text) fn(r.text); });
    for (const b of blocks || []) {
      if (!b) continue;
      fn(b.text);
      runs(b.runs);
      (b.items || []).forEach((i) => fn(typeof i === 'object' && i ? i.text : i));
      (b.itemRuns || []).forEach(runs);
      (b.rows || []).forEach((r) => (r || []).forEach((c) => fn(typeof c === 'object' && c ? c.text : c)));
      Object.keys(b.cellRuns || {}).forEach((k) => runs(b.cellRuns[k]));
    }
  }

  function fill(str, values) {
    return String(str == null ? '' : str).replace(FIELD_RE, (m, k) => (Object.prototype.hasOwnProperty.call(values, k) ? values[k] : m));
  }

  function cloneFilled(block, values) {
    const b = JSON.parse(JSON.stringify(block));
    delete b.id;
    if (b.text != null) b.text = fill(b.text, values);
    const runs = (rr) => (rr || []).forEach((r) => { if (r && r.text) r.text = fill(r.text, values); });
    runs(b.runs);
    if (b.items) b.items = b.items.map((i) => (typeof i === 'object' && i ? Object.assign({}, i, { text: fill(i.text, values) }) : fill(i, values)));
    (b.itemRuns || []).forEach(runs);
    if (b.rows) b.rows = b.rows.map((r) => (r || []).map((c) => (typeof c === 'object' && c ? Object.assign({}, c, { text: fill(c.text, values) }) : fill(c, values))));
    Object.keys(b.cellRuns || {}).forEach((k) => runs(b.cellRuns[k]));
    return b;
  }

  /** Una copia de la plantilla por fila, con salto de pagina entre copias. */
  function mergeBlocks(template, headers, rows) {
    const out = [];
    (rows || []).forEach((row, n) => {
      const values = {};
      (headers || []).forEach((h, i) => { if (h) values[h] = row[i] == null ? '' : row[i]; });
      if (n > 0) out.push({ type: 'pagebreak' });
      for (const b of template || []) {
        if (b && (b.type === 'toc')) continue;
        out.push(cloneFilled(b, values));
      }
    });
    return out;
  }

  return { MAX_ROWS, parseCsv, fieldsOf, mergeBlocks, fill };
});

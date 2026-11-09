'use strict';
/**
 * MC Browser -- modulo document-editor / core/diff.js
 *
 * Comparacion de dos documentos por bloques (LCS sobre una firma de cada
 * bloque). Devuelve filas {kind:'same'|'add'|'del'|'chg', type, text, before}.
 * Funcion pura: sin DOM ni Electron.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.MCDocDiff = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  function textOf(b) {
    if (!b) return '';
    if (Array.isArray(b.runs) && b.runs.length) return b.runs.map((r) => (r && r.text) || '').join('');
    if (Array.isArray(b.items)) return b.items.map((i) => (i && typeof i === 'object' ? i.text || '' : String(i))).join('\n');
    if (Array.isArray(b.rows)) return b.rows.map((r) => (r || []).map((c) => (c && typeof c === 'object' ? c.text || '' : String(c == null ? '' : c))).join(' | ')).join('\n');
    return b.text == null ? '' : String(b.text);
  }
  const sig = (b) => (b && b.type) + '\u0001' + (b && b.level || '') + '\u0001' + textOf(b);

  /** Filas de diferencias de a -> b (a = version anterior, b = actual). */
  function diffBlocks(a, b) {
    a = a || []; b = b || [];
    const n = a.length, m = b.length;
    const sa = a.map(sig), sb = b.map(sig);
    const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      L[i][j] = sa[i] === sb[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
    const out = [];
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && sa[i] === sb[j]) { out.push({ kind: 'same', type: b[j].type, text: textOf(b[j]) }); i++; j++; }
      else if (j < m && (i >= n || L[i][j + 1] > L[i + 1][j])) { out.push({ kind: 'add', type: b[j].type, text: textOf(b[j]) }); j++; }
      else { out.push({ kind: 'del', type: a[i].type, text: textOf(a[i]) }); i++; }
    }
    // Un borrado seguido de un alta del mismo tipo se muestra como "cambiado".
    const rows = [];
    for (let k = 0; k < out.length; k++) {
      const x = out[k], y = out[k + 1];
      if (x.kind === 'del' && y && y.kind === 'add' && x.type === y.type) {
        rows.push({ kind: 'chg', type: y.type, text: y.text, before: x.text }); k++;
      } else rows.push(x);
    }
    return rows;
  }

  function summary(rows) {
    const s = { add: 0, del: 0, chg: 0, same: 0 };
    rows.forEach((r) => { s[r.kind]++; });
    return s;
  }

  return { diffBlocks, summary, textOf };
});

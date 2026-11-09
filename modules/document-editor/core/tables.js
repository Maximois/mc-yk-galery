'use strict';
/**
 * MC Browser -- modulo document-editor / core/tables.js
 *
 * Operaciones puras sobre bloques `table` e `image`. Sin DOM ni Electron:
 * las usan igual el renderer (botones), el main (parches de la IA) y los tests.
 * Todas devuelven un bloque NUEVO; nunca mutan el de entrada. Si la operacion
 * no es valida devuelven null.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else { root.MCDoc = root.MCDoc || {}; root.MCDoc.tables = mod; }
})(typeof self !== 'undefined' ? self : this, function () {
  const MAX_ROWS = 100;
  const MAX_COLS = 20;
  const MIN_IMG = 16;
  const MAX_IMG = 2000;

  function int(v, lo, hi, def) {
    const n = Math.round(Number(v));
    if (!isFinite(n)) return def;
    return Math.min(hi, Math.max(lo, n));
  }

  function cols(block) {
    return Math.max(0, ...(block.rows || []).map(r => (Array.isArray(r) ? r.length : 0)));
  }

  /** Iguala el ancho de todas las filas (rellena con ''). */
  function rectangular(rows) {
    const n = Math.max(1, ...rows.map(r => r.length));
    return rows.map(r => { const c = r.slice(); while (c.length < n) c.push(''); return c; });
  }

  function create(nRows, nCols, header) {
    const r = int(nRows, 1, MAX_ROWS, 2);
    const c = int(nCols, 1, MAX_COLS, 2);
    const rows = [];
    for (let i = 0; i < r; i++) rows.push(new Array(c).fill(''));
    const block = { type: 'table', rows };
    block.header = header !== false;
    return block;
  }

  // El formato de las celdas (cellRuns, clave "fila,col") acompana a su celda
  // cuando se insertan o quitan filas y columnas.
  function remap(b, fn) {
    for (const prop of ['cellRuns', 'cellFill', 'cellBorders']) {
      if (!b[prop]) continue;
      const out = {};
      for (const key of Object.keys(b[prop])) {
        const [r, c] = key.split(',').map(Number);
        const to = fn(r, c);
        if (to) out[to[0] + ',' + to[1]] = b[prop][key];
      }
      if (Object.keys(out).length) b[prop] = out; else delete b[prop];
    }
  }

  function normWidths(w) {
    const sum = w.reduce((a, x) => a + x, 0) || 1;
    return w.map(x => Math.round(x / sum * 1000) / 10);
  }

  function clone(block) {
    if (!block || block.type !== 'table' || !Array.isArray(block.rows) || !block.rows.length) return null;
    const b = Object.assign({}, block, { rows: rectangular(block.rows.map(r => (Array.isArray(r) ? r.map(String) : []))) });
    if (b.cellRuns) b.cellRuns = Object.assign({}, b.cellRuns);
    if (b.cellFill) b.cellFill = Object.assign({}, b.cellFill);
    if (b.cellBorders) b.cellBorders = Object.assign({}, b.cellBorders);
    if (Array.isArray(b.colWidths)) b.colWidths = b.colWidths.slice();
    if (Array.isArray(b.merges)) b.merges = b.merges.map(m => Object.assign({}, m));
    return b;
  }

  // ---- celdas combinadas: merges = [{r, c, rows, cols}] (celda ancla arriba-izquierda).
  // Las celdas cubiertas guardan '' y no se muestran.
  function mergeAt(b, r, c) {
    return (b.merges || []).find(m => r >= m.r && r < m.r + m.rows && c >= m.c && c < m.c + m.cols) || null;
  }
  function isCovered(block, r, c) {
    const m = mergeAt(block, r, c);
    return !!m && !(m.r === r && m.c === c);
  }
  function dropEmptyMerges(b) {
    if (!b.merges) return;
    b.merges = b.merges.filter(m => m.rows >= 1 && m.cols >= 1 && (m.rows > 1 || m.cols > 1));
    if (!b.merges.length) delete b.merges;
  }
  // Filas/columnas insertadas o quitadas: las combinaciones se desplazan, crecen o encogen.
  function shiftMerges(b, axis, at, delta, removed) {
    if (!b.merges) return;
    const pos = axis === 'row' ? 'r' : 'c';
    const len = axis === 'row' ? 'rows' : 'cols';
    b.merges = b.merges.map(m => {
      const n = Object.assign({}, m);
      if (!removed) {
        if (n[pos] >= at) n[pos] += 1;
        else if (at < n[pos] + n[len]) n[len] += 1;
      } else if (at < n[pos]) n[pos] -= 1;
      else if (at < n[pos] + n[len]) n[len] -= 1;
      return n;
    });
    dropEmptyMerges(b);
  }

  /**
   * Combina el rectangulo (r1,c1)-(r2,c2). Si toca otras combinaciones el
   * rectangulo crece para incluirlas enteras. El texto de las celdas se junta
   * en la ancla (separado por espacio); el formato en linea solo se conserva
   * si el texto lo aportaba unicamente la ancla.
   */
  function mergeCells(block, r1, c1, r2, c2) {
    const b = clone(block);
    if (!b) return null;
    let top = Math.min(r1, r2), bottom = Math.max(r1, r2), left = Math.min(c1, c2), right = Math.max(c1, c2);
    if (![top, bottom, left, right].every(Number.isInteger) || top < 0 || left < 0 || bottom >= b.rows.length || right >= cols(b)) return null;
    for (let grow = true; grow;) {
      grow = false;
      for (const m of b.merges || []) {
        const hit = m.r <= bottom && m.r + m.rows - 1 >= top && m.c <= right && m.c + m.cols - 1 >= left;
        if (!hit) continue;
        const t = Math.min(top, m.r), bt = Math.max(bottom, m.r + m.rows - 1), l = Math.min(left, m.c), rt = Math.max(right, m.c + m.cols - 1);
        if (t !== top || bt !== bottom || l !== left || rt !== right) { top = t; bottom = bt; left = l; right = rt; grow = true; }
      }
    }
    if (top === bottom && left === right) return null;
    b.merges = (b.merges || []).filter(m => !(m.r >= top && m.r <= bottom && m.c >= left && m.c <= right));
    const parts = [];
    let others = false;
    for (let r = top; r <= bottom; r++) for (let c = left; c <= right; c++) {
      const t = b.rows[r][c];
      if (t && t.trim()) { parts.push(t); if (!(r === top && c === left)) others = true; }
    }
    const key = (r, c) => r + ',' + c;
    const anchorRuns = b.cellRuns && b.cellRuns[key(top, left)];
    for (let r = top; r <= bottom; r++) for (let c = left; c <= right; c++) {
      if (b.cellRuns) delete b.cellRuns[key(r, c)];
      if (b.cellFill && !(r === top && c === left)) delete b.cellFill[key(r, c)];
      if (b.cellBorders && !(r === top && c === left)) delete b.cellBorders[key(r, c)];
      if (!(r === top && c === left)) b.rows[r][c] = '';
    }
    b.rows[top][left] = parts.join(' ');
    if (anchorRuns && !others) { b.cellRuns = b.cellRuns || {}; b.cellRuns[key(top, left)] = anchorRuns; }
    if (b.cellRuns && !Object.keys(b.cellRuns).length) delete b.cellRuns;
    if (b.cellFill && !Object.keys(b.cellFill).length) delete b.cellFill;
    if (b.cellBorders && !Object.keys(b.cellBorders).length) delete b.cellBorders;
    b.merges.push({ r: top, c: left, rows: bottom - top + 1, cols: right - left + 1 });
    b.merges.sort((x, y) => x.r - y.r || x.c - y.c);
    return b;
  }

  /** Separa la combinacion que contiene la celda (row, col). */
  function unmergeCell(block, row, col) {
    const b = clone(block);
    if (!b) return null;
    const m = mergeAt(b, Number(row), Number(col));
    if (!m) return null;
    b.merges = b.merges.filter(x => x !== m);
    if (!b.merges.length) delete b.merges;
    return b;
  }

  /** at = indice de la fila de referencia; where 'before' | 'after' (def. after). */
  function addRow(block, at, where) {
    const b = clone(block);
    if (!b || b.rows.length >= MAX_ROWS) return null;
    const i = int(at, 0, b.rows.length - 1, b.rows.length - 1);
    const at2 = where === 'before' ? i : i + 1;
    b.rows.splice(at2, 0, new Array(cols(b)).fill(''));
    remap(b, (r, c) => [r >= at2 ? r + 1 : r, c]);
    shiftMerges(b, 'row', at2, 1, false);
    return b;
  }

  function deleteRow(block, at) {
    const b = clone(block);
    if (!b || b.rows.length <= 1) return null; // una tabla sin filas no existe
    const i = int(at, 0, b.rows.length - 1, -1);
    if (i < 0) return null;
    b.rows.splice(i, 1);
    remap(b, (r, c) => (r === i ? null : [r > i ? r - 1 : r, c]));
    shiftMerges(b, 'row', i, -1, true);
    return b;
  }

  function addCol(block, at, where) {
    const b = clone(block);
    if (!b || cols(b) >= MAX_COLS) return null;
    const i = int(at, 0, cols(b) - 1, cols(b) - 1);
    const at2 = where === 'before' ? i : i + 1;
    b.rows.forEach(r => r.splice(at2, 0, ''));
    remap(b, (r, c) => [r, c >= at2 ? c + 1 : c]);
    shiftMerges(b, 'col', at2, 1, false);
    if (b.colWidths && b.colWidths.length === cols(b) - 1) {
      const n = b.colWidths.length;
      const w = b.colWidths.map(x => x * n / (n + 1));
      w.splice(at2, 0, 100 / (n + 1));
      b.colWidths = normWidths(w);
    } else delete b.colWidths;
    return b;
  }

  function deleteCol(block, at) {
    const b = clone(block);
    if (!b || cols(b) <= 1) return null;
    const i = int(at, 0, cols(b) - 1, -1);
    if (i < 0) return null;
    b.rows.forEach(r => r.splice(i, 1));
    remap(b, (r, c) => (c === i ? null : [r, c > i ? c - 1 : c]));
    shiftMerges(b, 'col', i, -1, true);
    if (b.colWidths && b.colWidths.length === cols(b) + 1) {
      const w = b.colWidths.slice();
      w.splice(i, 1);
      b.colWidths = normWidths(w);
    } else delete b.colWidths;
    return b;
  }

  /** Ancho de cada columna en porcentaje (se normaliza a 100; minimo 3% cada una). */
  function setColWidths(block, widths) {
    const b = clone(block);
    if (!b || !Array.isArray(widths) || widths.length !== cols(b)) return null;
    const w = widths.map(Number);
    if (!w.every(x => isFinite(x) && x > 0)) return null;
    b.colWidths = normWidths(normWidths(w).map(x => Math.max(3, x)));
    return b;
  }

  /** Relleno del rectangulo de celdas; color null/'' lo quita. */
  function setFill(block, r1, c1, r2, c2, color) {
    const b = clone(block);
    if (!b) return null;
    const top = Math.min(r1, r2), bottom = Math.max(r1, r2), left = Math.min(c1, c2), right = Math.max(c1, c2);
    if (![top, bottom, left, right].every(Number.isInteger) || top < 0 || left < 0 || bottom >= b.rows.length || right >= cols(b)) return null;
    const col = color == null || color === '' ? null : String(color).trim().toLowerCase();
    if (col && !/^#[0-9a-f]{6}$/.test(col)) return null;
    for (let r = top; r <= bottom; r++) for (let c = left; c <= right; c++) {
      if (isCovered(b, r, c)) continue;
      b.cellFill = b.cellFill || {};
      if (col) b.cellFill[r + ',' + c] = col; else delete b.cellFill[r + ',' + c];
    }
    if (b.cellFill && !Object.keys(b.cellFill).length) delete b.cellFill;
    return b;
  }

  /**
   * Bordes propios de un rectangulo de celdas. `mode`: all | none | outer | inner |
   * top | bottom | left | right (solo ese lado) | clear (vuelve a lo de la tabla).
   */
  function setCellBorders(block, r1, c1, r2, c2, mode) {
    const b = clone(block);
    if (!b) return null;
    const top = Math.min(r1, r2), bottom = Math.max(r1, r2), left = Math.min(c1, c2), right = Math.max(c1, c2);
    if (![top, bottom, left, right].every(Number.isInteger) || top < 0 || left < 0 || bottom >= b.rows.length || right >= cols(b)) return null;
    if (!['all', 'none', 'outer', 'inner', 'top', 'bottom', 'left', 'right', 'clear'].includes(mode)) return null;
    for (let r = top; r <= bottom; r++) for (let c = left; c <= right; c++) {
      if (isCovered(b, r, c)) continue;
      const k = r + ',' + c;
      let spec = '';
      if (mode === 'all') spec = 'trbl';
      else if (mode === 'none') spec = 'none';
      else if (mode === 'outer') spec = (r === top ? 't' : '') + (c === right ? 'r' : '') + (r === bottom ? 'b' : '') + (c === left ? 'l' : '');
      else if (mode === 'inner') spec = (r !== top ? 't' : '') + (c !== right ? 'r' : '') + (r !== bottom ? 'b' : '') + (c !== left ? 'l' : '');
      else if (mode === 'top') spec = 't'; else if (mode === 'bottom') spec = 'b';
      else if (mode === 'left') spec = 'l'; else if (mode === 'right') spec = 'r';
      b.cellBorders = b.cellBorders || {};
      if (mode === 'clear') delete b.cellBorders[k]; else b.cellBorders[k] = spec || 'none';
    }
    if (b.cellBorders && !Object.keys(b.cellBorders).length) delete b.cellBorders;
    return b;
  }

  /** Ordena las filas (sin la de encabezado) por una columna; no admite celdas combinadas. */
  function sortRows(block, col, dir) {
    const b = clone(block);
    if (!b || !Number.isInteger(col) || col < 0 || col >= cols(b)) return null;
    if (Array.isArray(b.merges) && b.merges.length) return null;
    const start = b.header === false ? 0 : 1;
    if (b.rows.length - start < 2) return b;
    const idx = b.rows.map((_, i) => i).slice(start);
    const val = (i) => String(b.rows[i][col] == null ? '' : b.rows[i][col]).trim();
    const num = (s) => (s !== '' && isFinite(Number(s.replace(',', '.'))) ? Number(s.replace(',', '.')) : null);
    const cmp = (x, y) => {
      const a = val(x), z = val(y), na = num(a), nz = num(z);
      if (na != null && nz != null) return na - nz;
      return a.localeCompare(z, 'es', { sensitivity: 'base', numeric: true });
    };
    idx.sort((x, y) => (dir === 'desc' ? -cmp(x, y) : cmp(x, y)) || x - y);
    const map = new Map(idx.map((from, to) => [from, to + start]));
    const rows = b.rows.slice();
    idx.forEach((from) => { rows[map.get(from)] = b.rows[from]; });
    b.rows = rows;
    for (const prop of ['cellRuns', 'cellFill', 'cellBorders']) {
      if (!b[prop]) continue;
      const out = {};
      for (const key of Object.keys(b[prop])) {
        const [r, c] = key.split(',').map(Number);
        out[(map.has(r) ? map.get(r) : r) + ',' + c] = b[prop][key];
      }
      b[prop] = out;
    }
    return b;
  }

  /** Bordes de toda la tabla: 'all' (por defecto), 'none', 'horizontal' u 'outer'. */
  function setBorders(block, mode) {
    const b = clone(block);
    if (!b) return null;
    if (mode === 'all' || mode == null || mode === '') delete b.borders;
    else if (['none', 'horizontal', 'outer'].includes(mode)) b.borders = mode;
    else return null;
    return b;
  }

  function setCell(block, row, col, text) {
    const b = clone(block);
    if (!b) return null;
    const r = Number(row), c = Number(col);
    if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || c < 0 || r >= b.rows.length || c >= cols(b)) return null;
    if (isCovered(b, r, c)) return null;
    b.rows[r][c] = String(text == null ? '' : text);
    remap(b, (rr, cc) => (rr === r && cc === c ? null : [rr, cc]));
    return b;
  }

  function setHeader(block, on) {
    const b = clone(block);
    if (!b) return null;
    b.header = !!on;
    return b;
  }

  /**
   * Tamano de imagen. Con solo uno de width/height el otro sale de la
   * proporcion natural (nat = {width, height}) o de la que ya tiene el bloque.
   */
  function resizeImage(block, size, nat) {
    if (!block || block.type !== 'image') return null;
    const ref = nat && nat.width && nat.height ? nat
      : (block.width && block.height ? { width: block.width, height: block.height } : null);
    let w = size && size.width != null ? Number(size.width) : null;
    let h = size && size.height != null ? Number(size.height) : null;
    if (w != null && !isFinite(w)) return null;
    if (h != null && !isFinite(h)) return null;
    if (w == null && h == null) return null;
    if (ref) {
      const ratio = ref.width / ref.height;
      if (w != null && h == null) h = w / ratio;
      else if (h != null && w == null) w = h * ratio;
    }
    const next = Object.assign({}, block);
    if (w != null) next.width = int(w, MIN_IMG, MAX_IMG, null);
    if (h != null) next.height = int(h, MIN_IMG, MAX_IMG, null);
    // Si al limitar un lado se rompio la proporcion, el otro lo sigue.
    if (ref && w != null && h != null) {
      const ratio = ref.width / ref.height;
      if (Math.abs(next.width / next.height - ratio) / ratio > 0.02 && !(size.width != null && size.height != null)) {
        next.height = int(next.width / ratio, MIN_IMG, MAX_IMG, next.height);
      }
    }
    return next;
  }

  /** Reduce unas dimensiones naturales para que quepan en maxWidth px. */
  function fitWidth(nat, maxWidth) {
    const w = Math.max(1, Number(nat && nat.width) || 1);
    const h = Math.max(1, Number(nat && nat.height) || 1);
    const max = Math.max(MIN_IMG, Number(maxWidth) || 600);
    if (w <= max) return { width: int(w, MIN_IMG, MAX_IMG, w), height: int(h, MIN_IMG, MAX_IMG, h) };
    return { width: int(max, MIN_IMG, MAX_IMG, max), height: int(h * max / w, MIN_IMG, MAX_IMG, h) };
  }

  function setAlt(block, alt) {
    if (!block || block.type !== 'image') return null;
    const next = Object.assign({}, block);
    const a = String(alt == null ? '' : alt).slice(0, 300);
    if (a) next.alt = a; else delete next.alt;
    return next;
  }

  return { MAX_ROWS, MAX_COLS, MIN_IMG, MAX_IMG, cols, create, addRow, deleteRow, addCol, deleteCol,
    setHeader, setCell, mergeCells, unmergeCell, setColWidths, setFill, setBorders, setCellBorders, sortRows, mergeAt, isCovered, resizeImage, fitWidth, setAlt };
});

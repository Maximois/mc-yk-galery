'use strict';
/**
 * MC Browser -- modulo document-editor / core/runs.js
 *
 * Algebra de tramos (runs): el formato dentro de un parrafo. Un run es
 * { text, bold, italic, underline, strike, color, highlight, font, size }.
 * Todas las funciones son puras y no dependen de Electron, del DOM ni de Node:
 * se usan igual en el main (parches de la IA), en el renderer (edicion sobre
 * la seleccion) y en los tests.
 *
 * Decisiones que conviene no romper:
 *  - bold/italic/underline/strike admiten `false` explicito: significa "este
 *    tramo NO lleva negrita aunque el bloque la traiga por defecto" (un titulo
 *    es negrita; poder quitarsela a una palabra exige representar el falso).
 *    `compact()` descarta los falsos redundantes.
 *  - color/highlight son #rrggbb, font es un nombre de familia y size va en
 *    puntos. Un valor ausente significa "el del bloque".
 *  - Los indices son de caracteres del texto plano del bloque.
 */

(function (root, factory) {
  const mod = factory({
    model: (typeof require === 'function' && typeof module === 'object') ? require('./model.js') : (root.MCDoc && root.MCDoc.model)
  });
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (typeof window !== 'undefined') {
    window.MCDoc = window.MCDoc || {};
    window.MCDoc.runs = mod;
  }
})(this, function (deps) {
  const model = deps.model;

  const BOOL_KEYS = ['bold', 'italic', 'underline', 'strike'];
  const VALUE_KEYS = ['color', 'highlight', 'font', 'size', 'link', 'note', 'comment', 'ins', 'del'];
  const PROP_KEYS = BOOL_KEYS.concat(VALUE_KEYS);

  const present = (v) => v !== undefined && v !== null;
  const sameProps = (a, b) => PROP_KEYS.every((k) => (present(a[k]) ? a[k] : null) === (present(b[k]) ? b[k] : null));

  /** Limpia, valida y fusiona tramos contiguos con el mismo formato. */
  function normalize(runs) {
    const out = [];
    for (const raw of Array.isArray(runs) ? runs : []) {
      const run = model.normalizeRun(raw);
      if (!run) continue;
      const last = out[out.length - 1];
      if (last && sameProps(last, run)) last.text += run.text;
      else out.push(run);
    }
    return out;
  }

  const length = (runs) => (runs || []).reduce((n, r) => n + String((r && r.text) || '').length, 0);
  const toPlain = (runs) => (runs || []).map((r) => String((r && r.text) || '')).join('');

  /** Tramos de un bloque: sus runs o, si no tiene, un tramo con su texto. */
  function ofBlock(block) {
    if (block && Array.isArray(block.runs) && block.runs.length) return normalize(block.runs);
    const text = block ? model.blockText(block) : '';
    return text ? [{ text }] : [];
  }

  /** Subconjunto [start, end) conservando el formato. */
  function slice(runs, start, end) {
    const out = [];
    let at = 0;
    for (const r of runs || []) {
      const t = String(r.text || '');
      const s = Math.max(start - at, 0);
      const e = Math.min(end - at, t.length);
      if (e > s) out.push(Object.assign({}, r, { text: t.slice(s, e) }));
      at += t.length;
      if (at >= end) break;
    }
    return out;
  }

  /** Parte en dos en la posicion `pos`. */
  function split(runs, pos) {
    const total = length(runs);
    const p = Math.min(Math.max(0, pos), total);
    return [normalize(slice(runs, 0, p)), normalize(slice(runs, p, total))];
  }

  const concat = (a, b) => normalize((a || []).concat(b || []));

  /**
   * Aplica `patch` a [start, end). Un valor null/undefined quita esa propiedad
   * (vuelve al valor del bloque); true/false en las booleanas es explicito.
   */
  function applyStyle(runs, start, end, patch) {
    const total = length(runs);
    const s = Math.min(Math.max(0, start), total);
    const e = Math.min(Math.max(0, end), total);
    if (e <= s) return normalize(runs);
    const mid = slice(runs, s, e).map((r) => {
      const next = Object.assign({}, r);
      for (const key of Object.keys(patch || {})) {
        if (!PROP_KEYS.includes(key)) continue;
        if (present(patch[key])) next[key] = patch[key];
        else delete next[key];
      }
      return next;
    });
    return normalize(slice(runs, 0, s).concat(mid, slice(runs, e, total)));
  }

  /**
   * Formato del rango: para cada propiedad el valor comun, o 'mixed' si los
   * tramos no coinciden. Una propiedad ausente en todos se omite.
   */
  function styleOf(runs, start, end) {
    const part = slice(runs, start, end);
    const out = {};
    for (const key of PROP_KEYS) {
      let first;
      let seen = false;
      let mixed = false;
      for (const r of part) {
        const v = present(r[key]) ? r[key] : null;
        if (!seen) { first = v; seen = true; } else if (v !== first) mixed = true;
      }
      if (mixed) out[key] = 'mixed';
      else if (seen && first !== null) out[key] = first;
    }
    return out;
  }

  /** Alterna una booleana: si todo el rango la tiene, se quita; si no, se pone. */
  function toggle(runs, start, end, key) {
    const state = styleOf(runs, start, end)[key];
    return applyStyle(runs, start, end, { [key]: state === true ? false : true });
  }

  /**
   * Quita los `false` que no hacen falta: un falso solo importa si el bloque
   * trae esa propiedad por defecto (titulos en negrita, bloque con cursiva...).
   */
  function compact(runs, defaults) {
    const d = defaults || {};
    return normalize((runs || []).map((r) => {
      const next = Object.assign({}, r);
      for (const k of BOOL_KEYS) if (next[k] === false && !d[k]) delete next[k];
      return next;
    }));
  }

  /** Valores por defecto de formato de un bloque, para `compact`. */
  function defaultsOf(block) {
    const b = block || {};
    return {
      bold: b.type === 'heading' || b.bold === true,
      italic: b.italic === true,
      underline: b.underline === true,
      strike: false
    };
  }

  const hasFormatting = (runs) => (runs || []).some((r) => PROP_KEYS.some((k) => present(r[k])));
  const equal = (a, b) => JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));

  return {
    BOOL_KEYS, VALUE_KEYS, PROP_KEYS,
    normalize, length, toPlain, ofBlock, slice, split, concat,
    applyStyle, styleOf, toggle, compact, defaultsOf, hasFormatting, equal
  };
});

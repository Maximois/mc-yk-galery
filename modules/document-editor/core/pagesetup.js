'use strict';
/**
 * MC Browser -- modulo document-editor / core/pagesetup.js
 *
 * Configuracion de pagina, pura (sin DOM ni Electron): papel, orientacion,
 * margenes, encabezado, pie y numeracion. Devuelve una pagina NUEVA; nunca
 * muta la de entrada. Las usan el renderer (panel Pagina), el main (parches
 * de la IA, op "page") y los tests.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else { root.MCDoc = root.MCDoc || {}; root.MCDoc.pagesetup = mod; }
})(typeof self !== 'undefined' ? self : this, function () {
  const PAPERS = {
    A4: { width: 595.28, height: 841.89 },
    LETTER: { width: 612, height: 792 },
    LEGAL: { width: 612, height: 1008 },
    A5: { width: 419.53, height: 595.28 },
    // Formatos de libro / novela (medida de tapa). El tamano de hoja se elige
    // segun el libro para que la caja de texto no quede ni vacia ni desbordada.
    A6: { width: 297.64, height: 419.53 },        // 10.5 x 14.8 cm
    B6: { width: 354.33, height: 498.90 },        // 12.5 x 17.6 cm
    B5: { width: 498.90, height: 708.66 },        // 17.6 x 25 cm
    LIB_13X18: { width: 368.50, height: 510.24 }, // 13 x 18 cm (tascable)
    LIB_17X22: { width: 481.89, height: 623.62 }  // 17 x 22 cm (novela)
  };
  // Margenes en puntos (1 cm = 28.35 pt).
  const MARGIN_PRESETS = { normal: 56.7, narrow: 36, wide: 85, none: 0 };
  const SIDES = ['marginTop', 'marginRight', 'marginBottom', 'marginLeft'];
  const ALIGNS = ['left', 'center', 'right'];

  const num = (v) => { const n = Number(v); return isFinite(n) ? n : null; };
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const r2 = (n) => Math.round(n * 100) / 100;

  function orientationOf(page) {
    // Un documento puede traer la orientacion explicita (viene de w:orient al
    // abrir un DOCX). Si no, se deduce de las medidas, que es como siempre se
    // hizo: en este editor width/height son la verdad y no hay campo que mande
    // sobre ellas.
    const declared = String(page && page.orientation || '').toLowerCase();
    if (declared === 'landscape' || declared === 'portrait') return declared;
    return Number(page && page.width) > Number(page && page.height) ? 'landscape' : 'portrait';
  }

  function paperOf(page) {
    const w = Number(page && page.width), h = Number(page && page.height);
    const lo = Math.min(w, h), hi = Math.max(w, h);
    for (const k of Object.keys(PAPERS)) {
      if (Math.abs(PAPERS[k].width - lo) < 1.5 && Math.abs(PAPERS[k].height - hi) < 1.5) return k;
    }
    return 'custom';
  }

  function setOrientation(page, orientation) {
    if (orientation !== 'portrait' && orientation !== 'landscape') return null;
    const p = Object.assign({}, page);
    const w = Number(p.width), h = Number(p.height);
    const lo = Math.min(w, h), hi = Math.max(w, h);
    const portrait = orientation === 'portrait';
    p.width = portrait ? lo : hi;
    p.height = portrait ? hi : lo;
    return p;
  }

  function setPaper(page, paper) {
    const spec = PAPERS[String(paper || '').toUpperCase()];
    if (!spec) return null;
    const land = orientationOf(page) === 'landscape';
    return Object.assign({}, page, {
      width: land ? spec.height : spec.width,
      height: land ? spec.width : spec.height
    });
  }

  /**
   * margins: { all?, top?, right?, bottom?, left? } en puntos, o un nombre de
   * preset ('normal'|'narrow'|'wide'|'none'). Limite: 0-300 pt y que quede
   * al menos 72 pt de area util en cada eje.
   */
  function setMargins(page, margins) {
    let m = margins;
    if (typeof m === 'string') {
      if (!(m in MARGIN_PRESETS)) return null;
      m = { all: MARGIN_PRESETS[m] };
    }
    if (!m || typeof m !== 'object') return null;
    const p = Object.assign({}, page);
    if (m.all != null) {
      const a = num(m.all);
      if (a == null) return null;
      p.margin = r2(clamp(a, 0, 300));
      for (const s of SIDES) delete p[s];
    }
    const map = { top: 'marginTop', right: 'marginRight', bottom: 'marginBottom', left: 'marginLeft' };
    for (const k of Object.keys(map)) {
      if (m[k] == null) continue;
      const v = num(m[k]);
      if (v == null) return null;
      p[map[k]] = r2(clamp(v, 0, 300));
    }
    const eff = (side) => (p[side] != null ? p[side] : p.margin);
    if (Number(p.width) - eff('marginLeft') - eff('marginRight') < 72 ||
        Number(p.height) - eff('marginTop') - eff('marginBottom') < 72) return null;
    return p;
  }

  function setHeaderFooter(page, opts) {
    const o = opts || {};
    const p = Object.assign({}, page);
    for (const k of ['header', 'footer']) {
      if (o[k] === undefined) continue;
      const v = String(o[k] == null ? '' : o[k]).slice(0, 200);
      if (v.trim()) p[k] = v; else delete p[k];
    }
    if (o.pageNumbers !== undefined) {
      if (o.pageNumbers === false || o.pageNumbers === null || o.pageNumbers === 'none' || o.pageNumbers === '') delete p.pageNumbers;
      else if (ALIGNS.includes(o.pageNumbers)) p.pageNumbers = o.pageNumbers;
      else return null;
    }
    return p;
  }

  /** Marca de agua, primera pagina distinta y numero inicial. */
  function setExtras(page, o) {
    const p = Object.assign({}, page);
    if (o.watermark !== undefined) {
      const v = String(o.watermark == null || o.watermark === false ? '' : o.watermark).trim().slice(0, 40);
      if (v) p.watermark = v; else delete p.watermark;
    }
    if (o.columns !== undefined) {
      const n = Math.round(Number(o.columns));
      if (!isFinite(n) || n < 1 || n > 3) return null;
      if (n === 1) delete p.columns; else p.columns = n;
    }
    if (o.endnotes !== undefined) { if (o.endnotes) p.endnotes = true; else delete p.endnotes; }
    if (o.titlePage !== undefined) { if (o.titlePage) p.titlePage = true; else delete p.titlePage; }
    if (o.pageStart !== undefined) {
      const n = Math.round(Number(o.pageStart));
      if (!isFinite(n) || n < 1 || n > 9999) { if (o.pageStart === null || o.pageStart === '' || o.pageStart === false) delete p.pageStart; else return null; }
      else if (n === 1) delete p.pageStart; else p.pageStart = n;
    }
    return p;
  }

  /** Aplica de una vez un objeto de cambios (lo que manda la IA o el panel). */
  function apply(page, change) {
    const c = change || {};
    let p = Object.assign({}, page);
    if (c.paper != null) { p = setPaper(p, c.paper); if (!p) return null; }
    if (c.orientation != null) { p = setOrientation(p, c.orientation); if (!p) return null; }
    if (typeof c.margin === 'string') {
      p = setMargins(p, c.margin);
      if (!p) return null;
    } else {
      const m = {};
      if (c.margin != null) m.all = c.margin;
      if (c.marginTop != null) m.top = c.marginTop;
      if (c.marginRight != null) m.right = c.marginRight;
      if (c.marginBottom != null) m.bottom = c.marginBottom;
      if (c.marginLeft != null) m.left = c.marginLeft;
      if (Object.keys(m).length) { p = setMargins(p, m); if (!p) return null; }
    }
    if (c.header !== undefined || c.footer !== undefined || c.pageNumbers !== undefined) {
      p = setHeaderFooter(p, { header: c.header, footer: c.footer, pageNumbers: c.pageNumbers });
      if (!p) return null;
    }
    if (c.watermark !== undefined || c.titlePage !== undefined || c.pageStart !== undefined || c.endnotes !== undefined || c.columns !== undefined) {
      p = setExtras(p, c);
      if (!p) return null;
    }
    return p;
  }

  return { setExtras, PAPERS, MARGIN_PRESETS, orientationOf, paperOf, setOrientation, setPaper, setMargins, setHeaderFooter, apply };
});

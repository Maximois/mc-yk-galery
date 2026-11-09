'use strict';
/**
 * MC Browser -- modulo document-editor / core/a11y.js
 *
 * Revision de accesibilidad del documento: imagenes sin texto alternativo,
 * saltos de nivel de titulo, titulos vacios, tablas sin fila de encabezado,
 * enlaces poco descriptivos y texto con poco contraste. Funciones puras.
 */
(function (root, factory) {
  const mod = factory(typeof require === 'function' && typeof module === 'object' ? { model: require('./model') } : { model: root.MCDoc.model });
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else { root.MCDoc = root.MCDoc || {}; root.MCDoc.a11y = mod; }
})(typeof self !== 'undefined' ? self : this, function (deps) {
  const { model } = deps;

  function lum(hex) {
    const h = String(hex).replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6);
    const ch = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }
  /** Relacion de contraste WCAG entre dos colores #rgb / #rrggbb. */
  function contrast(a, b) {
    const x = lum(a), y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }

  const VAGUE = /^(aqu[ií]|click aqu[ií]|haz clic aqu[ií]|ver m[aá]s|m[aá]s|enlace|link|here|click here|read more)$/i;
  const HEX = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;

  /** check(doc) -> [{ id, kind, level:'error'|'warn', message }] */
  function check(doc) {
    const out = [];
    const add = (b, kind, level, message) => out.push({ id: b.id, kind, level, message });
    let prevLevel = 0;
    for (const b of doc.blocks || []) {
      const text = model.blockText(b).trim();
      if (b.type === 'image' && !String(b.alt || '').trim()) add(b, 'image-alt', 'error', 'Imagen sin texto alternativo');
      if (b.type === 'heading') {
        const lv = Math.min(3, Math.max(1, Number(b.level) || 1));
        if (!text) add(b, 'heading-empty', 'warn', 'Título vacío');
        if (prevLevel && lv > prevLevel + 1) add(b, 'heading-skip', 'warn', 'Salta de título ' + prevLevel + ' a título ' + lv + (text ? ': «' + text.slice(0, 40) + '»' : ''));
        prevLevel = lv;
      }
      if (b.type === 'table' && b.header === false && (b.rows || []).length > 1) add(b, 'table-header', 'warn', 'Tabla sin fila de encabezado');
      const groups = [b.runs].concat(b.itemRuns || [], Object.keys(b.cellRuns || {}).map((k) => b.cellRuns[k]));
      for (const rr of groups) {
        for (const r of rr || []) {
          if (!r || !r.text) continue;
          if (r.link && (VAGUE.test(r.text.trim()) || /^https?:\/\//i.test(r.text.trim()))) add(b, 'link-text', 'warn', 'Enlace poco descriptivo: «' + r.text.trim().slice(0, 40) + '»');
          if (r.color && HEX.test(r.color) && r.text.trim()) {
            const bg = r.highlight && HEX.test(r.highlight) ? r.highlight : '#ffffff';
            const c = contrast(r.color, bg);
            if (c < 4.5) add(b, 'contrast', 'warn', 'Poco contraste (' + c.toFixed(1) + ':1): «' + r.text.trim().slice(0, 30) + '»');
          }
        }
      }
      if (b.color && HEX.test(b.color) && text && contrast(b.color, '#ffffff') < 4.5) add(b, 'contrast', 'warn', 'Poco contraste (' + contrast(b.color, '#ffffff').toFixed(1) + ':1): «' + text.slice(0, 30) + '»');
    }
    return out;
  }

  return { check, contrast };
});

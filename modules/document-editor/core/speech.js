'use strict';
/**
 * MC Browser -- modulo document-editor / core/speech.js
 *
 * Lectura en voz alta más natural (funciones puras, sin DOM ni Electron).
 * El motor de voz del sistema lee "tal cual" lo que recibe: abreviaturas, símbolos, cifras con puntos y párrafos largos suenan robóticos.
 * Aquí se prepara el texto para que suene como lo diría una persona (humanize), se parte en frases con pausa y entonación
 * propias (prepare: títulos más lentos y graves, preguntas con tono ascendente, citas más pausadas, pausas entre frases/bloques) y se
 * elige la mejor voz disponible (rankVoices: las "naturales/neurales" primero, en el idioma del documento).
 * Idioma: español (es). Lo que no se reconoce se deja como está.
 * Cómo se verifica: test/document-speech.test.js y test/document-editor-renderer.test.js.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else { root.MCDoc = root.MCDoc || {}; root.MCDoc.speech = mod; }
})(typeof self !== 'undefined' ? self : this, function () {
  const ABBR = [
    [/\bEE\.\s?UU\./g, 'Estados Unidos'], [/\bp\.\s?ej\./gi, 'por ejemplo'], [/\betc\./gi, 'etcétera'], [/\bvs\.?(?=\s)/gi, 'versus'],
    [/\bDra\./g, 'doctora'], [/\bDr\./g, 'doctor'], [/\bSra\./g, 'señora'], [/\bSrta\./g, 'señorita'], [/\bSr\./g, 'señor'],
    [/\bUds\./g, 'ustedes'], [/\bUd\./g, 'usted'], [/\bLic\./g, 'licenciado'], [/\bIng\./g, 'ingeniero'], [/\bProf\./g, 'profesor'],
    [/\bAv\./g, 'avenida'], [/\bpágs\./gi, 'páginas'], [/\bpág\./gi, 'página'], [/\bcap\./gi, 'capítulo'], [/\bfig\./gi, 'figura'],
    [/\bnúm\./gi, 'número'], [/\bn\.º/gi, 'número'], [/\bnº/gi, 'número'], [/\baprox\./gi, 'aproximadamente'], [/\btel\./gi, 'teléfono'],
    [/\bj\.\s?c\./gi, 'jota ce'], [/\bS\.\s?A\./g, 'sociedad anónima'], [/\bS\.\s?L\./g, 'sociedad limitada'], [/\bUS\$/g, 'dólares ']
  ];
  const ORD_M = ['', 'primero', 'segundo', 'tercero', 'cuarto', 'quinto', 'sexto', 'séptimo', 'octavo', 'noveno', 'décimo'];
  const ORD_F = ['', 'primera', 'segunda', 'tercera', 'cuarta', 'quinta', 'sexta', 'séptima', 'octava', 'novena', 'décima'];
  const ROMAN = { I: 1, V: 5, X: 10, L: 50, C: 100 };
  function romanToInt(s) {
    let t = 0; for (let i = 0; i < s.length; i++) { const v = ROMAN[s[i]], n = ROMAN[s[i + 1]]; if (!v) return 0; t += n && n > v ? -v : v; }
    return t;
  }

  /** Texto tal como lo diría una persona. */
  function humanize(text) {
    let s = String(text == null ? '' : text);
    s = s.replace(/https?:\/\/\S+/gi, 'enlace').replace(/\bwww\.\S+/gi, 'enlace');
    s = s.replace(/([\w.+-]+)@([\w-]+(?:\.[\w-]+)+)/g, (m, u, d) => u + ' arroba ' + d.replace(/\./g, ' punto '));
    for (const [re, rep] of ABBR) s = s.replace(re, rep);
    s = s.replace(/\b(\d{1,2})\.([ºª])/g, (m, n, g) => { const k = Number(n); const t = g === 'ª' ? ORD_F : ORD_M; return t[k] || m; });
    s = s.replace(/\b(siglo|capítulo|tomo|libro|parte|fase|tipo|clase|nivel)\s+([IVXLC]{1,6})\b/gi, (m, w, r) => { const n = romanToInt(r.toUpperCase()); return n ? w + ' ' + n : m; });
    s = s.replace(/\b\d{1,3}(?:\.\d{3})+\b(?!,\d)/g, (m) => m.replace(/\./g, ''));
    s = s.replace(/\b(\d+),(\d+)\b/g, '$1 coma $2');
    s = s.replace(/\b(\d{4})\s?[-–—]\s?(\d{4})\b/g, '$1 a $2');
    s = s.replace(/(\d)\s?%/g, '$1 por ciento').replace(/(\d)\s?°\s?C\b/g, '$1 grados centígrados').replace(/(\d)\s?€/g, '$1 euros');
    s = s.replace(/\s&\s/g, ' y ').replace(/\s→\s/g, ' lleva a ').replace(/\s≥\s/g, ' mayor o igual que ').replace(/\s≤\s/g, ' menor o igual que ').replace(/\s≠\s/g, ' distinto de ')
      .replace(/(\d)\s?[×x]\s?(\d)/g, '$1 por $2').replace(/(\d)\s?\+\s?(\d)/g, '$1 más $2').replace(/\s=\s/g, ' igual a ');
    s = s.replace(/\s*\(([^()]{1,160})\)/g, ', $1,').replace(/\s*\[\d+(?:[,–-]\s?\d+)*\]/g, '');   // paréntesis → inciso con pausas; citas numéricas [3] se omiten
    s = s.replace(/[«»"“”]/g, '').replace(/\*+/g, '').replace(/_{2,}/g, ' ').replace(/\s*[|]\s*/g, ', ');
    s = s.replace(/\.{3,}/g, '…').replace(/([,;:])\1+/g, '$1').replace(/,\s*([.!?])/g, '$1').replace(/,\s*,/g, ',').replace(/\s+/g, ' ').trim();
    return s;
  }

  /** Parte en frases (sin cortar abreviaturas ya expandidas) y las muy largas en incisos de ≤ max caracteres. */
  function sentences(text, max) {
    max = max || 200;
    const raw = String(text).split(/(?<=[.!?…])\s+(?=[A-ZÁÉÍÓÚÑ¿¡"«(\d])/).map((x) => x.trim()).filter(Boolean);
    const out = [];
    for (const s of raw) {
      if (s.length <= max) { out.push({ text: s, cut: false }); continue; }
      let rest = s;
      while (rest.length > max) {
        let at = Math.max(rest.lastIndexOf(', ', max), rest.lastIndexOf('; ', max), rest.lastIndexOf(': ', max), rest.lastIndexOf(' y ', max) - 1, rest.lastIndexOf(' que ', max) - 1);
        if (at < max * 0.4) at = rest.lastIndexOf(' ', max);
        if (at <= 0) at = max;
        out.push({ text: rest.slice(0, at + 1).trim(), cut: true }); rest = rest.slice(at + 1).trim();
      }
      if (rest) out.push({ text: rest, cut: false });
    }
    return out;
  }

  /**
   * Une los párrafos que son continuación del anterior (texto pegado de un PDF o con saltos de línea duros):
   * el anterior no cierra la frase (termina en letra, coma o guion) y el siguiente sigue en minúscula.
   * Sin esto se leía "línea, pausa, línea" aunque la frase continuara. Devuelve items nuevos; cada uno conserva el
   * índice `block` del primero (para resaltar y reanudar). Títulos, listas y tablas no se unen.
   */
  function mergeContinuations(items, maxChars) {
    const max = maxChars || 0; const out = [];
    const joinable = (t) => t === 'paragraph' || t === 'quote';
    (items || []).forEach((it, i) => {
      const text = String(it.text || '').replace(/\s+/g, ' ').trim();
      const prev = out[out.length - 1];
      const type = it.type || 'paragraph';
      if (prev && joinable(prev.type) && prev.type === type && text) {
        const pt = prev.text;
        const open = /[\p{L}\p{N},;\-–—]$/u.test(pt) && !/[.!?…:]$/.test(pt);
        const cont = /^\p{Ll}/u.test(text);
        if (open && cont && (!max || pt.length + text.length < max)) {
          prev.text = /\p{L}-$/u.test(pt) ? pt.slice(0, -1) + text : pt + ' ' + text;
          return;
        }
      }
      out.push(Object.assign({}, it, { text, block: it.block != null ? it.block : i }));
    });
    return out;
  }

  /**
   * items: [{ text, type: 'heading'|'paragraph'|'quote'|'list'|'table', level? }]  →  trozos para hablar.
   * Cada trozo: { text, block (índice del item), first (primer trozo del item), pause (ms después), pitch, rate (multiplicador) }.
   * natural=false devuelve un trozo por item, sin pausas ni entonación (lectura literal).
   */
  function prepare(items, opts) {
    const natural = !opts || opts.natural !== false; const out = [];
    mergeContinuations(items, natural ? 0 : 600).forEach((it) => {
      const bi = it.block;
      if (!natural) { const t = String(it.text || '').replace(/\s+/g, ' ').trim(); if (t) out.push({ text: t, block: bi, first: true, pause: 0, pitch: 1, rate: 1 }); return; }
      const clean = humanize(it.text); if (!clean) return;
      const type = it.type || 'paragraph';
      const parts = type === 'heading' ? [{ text: clean.replace(/[.!?…]+$/, ''), cut: false }] : sentences(clean);
      parts.forEach((p, k) => {
        const last = k === parts.length - 1; const q = /\?$/.test(p.text), ex = /!$/.test(p.text);
        let pitch = 1, rate = 1, pause = p.cut ? 140 : 260;
        if (type === 'heading') { pitch = 0.92; rate = 0.92; pause = it.level && it.level <= 1 ? 900 : 700; }
        else if (type === 'quote') { pitch = 0.96; rate = 0.96; }
        else if (type === 'list' || type === 'table') { pause = p.cut ? 140 : 320; }
        if (q) pitch *= 1.07; else if (ex) { pitch *= 1.05; rate *= 1.04; }
        if (last && type !== 'heading') pause = Math.max(pause, type === 'list' || type === 'table' ? 380 : 520);
        out.push({ text: p.text, block: bi, first: k === 0, pause, pitch: Math.round(pitch * 100) / 100, rate: Math.round(rate * 100) / 100 });
      });
    });
    return out;
  }

  /** Voces ordenadas de mejor a peor para el idioma: naturales/neurales/en línea primero, luego Google, luego las locales. */
  function rankVoices(voices, lang) {
    lang = String(lang || 'es').toLowerCase(); const base = lang.slice(0, 2);
    const score = (v) => {
      const vl = String(v.lang || '').toLowerCase().replace('_', '-'); let s = 0;
      if (vl === lang) s += 120; else if (vl.slice(0, 2) === base) s += 100; else return -1;
      if (/natural|neural|online/i.test(v.name || '')) s += 60;
      if (/google/i.test(v.name || '')) s += 25;
      if (/premium|enhanced|siri/i.test(v.name || '')) s += 30;
      if (/espeak|compact|default/i.test(v.name || '')) s -= 20;
      return s;
    };
    return (voices || []).map((v) => [v, score(v)]).filter((x) => x[1] >= 0).sort((a, b) => b[1] - a[1]).map((x) => x[0]);
  }
  function bestVoice(voices, preferredName, lang) {
    const list = voices || []; const pick = list.find((v) => v.name === preferredName);
    return pick || rankVoices(list, lang)[0] || null;
  }
  return { humanize, sentences, mergeContinuations, prepare, rankVoices, bestVoice };
});

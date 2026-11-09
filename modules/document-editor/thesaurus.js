'use strict';
/**
 * MC Browser -- modulo document-editor / thesaurus.js
 *
 * Tesauro de sinonimos en espanol sin conexion. Datos: OpenThesaurus-es
 * (LGPL 2.1, formato MyThes) en vendor/thesaurus/. Se lee la primera vez que
 * se usa y queda en memoria. Sin Electron: se puede probar con node.
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'vendor', 'thesaurus', 'th_es_v2.dat');
let index = null;

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** Analiza texto MyThes (ya decodificado) -> Map palabra -> [[sinonimos], ...]. */
function parse(text) {
  const map = new Map();
  const lines = text.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const head = /^(.+)\|(\d+)$/.exec(lines[i]);
    if (!head) continue;
    const n = Number(head[2]);
    const senses = [];
    for (let k = 0; k < n && i + 1 < lines.length; k++) {
      const parts = lines[++i].split('|').slice(1).map((x) => x.replace(/^\([^)]*\)\s*/, '').trim()).filter(Boolean);
      if (parts.length) senses.push(parts);
    }
    const key = head[1].trim().toLowerCase();
    if (senses.length) map.set(key, (map.get(key) || []).concat(senses));
  }
  return map;
}

function load() {
  if (index) return index;
  try { index = parse(fs.readFileSync(FILE).toString('latin1')); } catch (e) { index = new Map(); }
  return index;
}

// Formas a probar para una palabra: tal cual, sin tildes y sin terminaciones comunes.
function candidates(word) {
  const w = String(word || '').trim().toLowerCase();
  const out = [w];
  if (w.endsWith('es')) out.push(w.slice(0, -2));
  if (w.endsWith('s')) out.push(w.slice(0, -1));
  if (/[ao]s?$/.test(w)) out.push(w.replace(/[ao]s?$/, 'o'), w.replace(/[ao]s?$/, 'a'));
  if (/ces$/.test(w)) out.push(w.replace(/ces$/, 'z'));
  if (/(ando|iendo|yendo)$/.test(w)) out.push(w.replace(/(ando)$/, 'ar').replace(/(iendo|yendo)$/, 'er'), w.replace(/iendo$/, 'ir'));
  if (/(aba|aban|ó|aron|ado|ada|ados|adas)$/.test(w)) out.push(w.replace(/(aba|aban|ó|aron|ado|ada|ados|adas)$/, 'ar'));
  if (/(ía|ían|ió|ieron|ido|ida|idos|idas)$/.test(w)) out.push(w.replace(/(ía|ían|ió|ieron|ido|ida|idos|idas)$/, 'er'), w.replace(/(ía|ían|ió|ieron|ido|ida|idos|idas)$/, 'ir'));
  return Array.from(new Set(out));
}

/** lookup(palabra) -> { word, senses: [[...]] } (senses vacio si no hay). */
function lookup(word) {
  const idx = load();
  const w = String(word || '').trim();
  if (!w || w.length > 60) return { word: w, senses: [] };
  for (const c of candidates(w)) {
    const hit = idx.get(c);
    if (hit) return { word: w, base: c, senses: hit.slice(0, 6).map((s) => s.slice(0, 12)) };
  }
  // Sin tildes (el usuario puede escribir "dia" por "día").
  const f = fold(w);
  for (const [k, v] of idx) if (fold(k) === f) return { word: w, base: k, senses: v.slice(0, 6).map((s) => s.slice(0, 12)) };
  return { word: w, senses: [] };
}

module.exports = { lookup, parse, candidates, fold, _reset() { index = null; } };

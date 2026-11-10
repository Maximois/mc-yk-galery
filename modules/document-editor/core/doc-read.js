'use strict';
/**
 * MC Browser -- modulo document-editor / core/doc-read.js
 *
 * .doc (Word 97-2003, binario OLE2) -> modelo. El DOCX moderno es un ZIP con
 * XML (lo lee docx-read.js); el .doc viejo es un "Compound File" (OLE2) con el
 * texto guardado en el stream `WordDocument` y su reparto en una tabla de
 * piezas (`CLX`) dentro del stream `0Table`/`1Table`.
 *
 * Que se conserva: solo el texto, como parrafos. El formato .doc binario
 * guarda los estilos de una forma (FIB + Grpprl) que este modulo NO reproduce:
 * un .doc abierto aqui es contenido, no diseno. Tampoco se puede volver a
 * escribir en .doc; al guardar se ofrece DOCX (ver modules/document-editor/main.js).
 *
 * No usa dependencias: implementa lo minimo de MS-CFB (compound file binary) y
 * del FIB de MS-DOC para llegar al texto. Corre en main, en el worker y en
 * Node (tests). No toca `Buffer` para poder compartirse con el renderer.
 */

(function (root, factory) {
  const mod = factory({
    model: (typeof require === 'function' && typeof module === 'object') ? require('./model.js') : (root.MCDoc && root.MCDoc.model),
    docBinary: (typeof require === 'function' && typeof module === 'object') ? require('./doc-binary.js') : (root.MCDoc && root.MCDoc.docBinary),
    rtfRead: (typeof require === 'function' && typeof module === 'object') ? require('./rtf-read.js') : (root.MCDoc && root.MCDoc.rtfRead)
  });
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (typeof window !== 'undefined') {
    window.MCDoc = window.MCDoc || {};
    window.MCDoc.docRead = mod;
  }
})(this, function (deps) {
  const model = deps.model;
  const rtfRead = deps.rtfRead;
  const docBinary = deps.docBinary;

  const SIG = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
  const FREESECT = 0xFFFFFFFF;
  const ENDOFCHAIN = 0xFFFFFFFE;
  const FATSECT = 0xFFFFFFFD;
  const DIFSECT = 0xFFFFFFFC;

  function u16(b, o) { return (b[o] | (b[o + 1] << 8)) & 0xFFFF; }
  function u32(b, o) {
    return ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0);
  }
  function toU8(input) {
    if (input instanceof Uint8Array) return input;
    if (input && input.buffer) return new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength || input.length);
    return new Uint8Array(input || []);
  }

  // ── MS-CFB: lectura minima de un compound file ─────────────────────────
  // Devuelve un objeto con .get(nombre) -> Uint8Array del stream (o null) y
  // .names() con la lista de streams. Lanza si no es OLE2.
  function parseCFB(input) {
    const bytes = toU8(input);
    for (let i = 0; i < 8; i++) {
      if (bytes[i] !== SIG[i]) throw new Error('no es un archivo OLE2 (no parece un .doc binario)');
    }
    const sectorShift = u16(bytes, 0x1E);
    const miniShift = u16(bytes, 0x20);
    const sectorSize = 1 << sectorShift;
    const miniSize = 1 << miniShift;
    if (sectorSize < 128 || sectorSize > 65536 || miniSize < 16 || miniSize > sectorSize) {
      throw new Error('tamano de sector invalido en el compound file');
    }

    const numFatSectors = u32(bytes, 0x2C);
    const firstDirSector = u32(bytes, 0x30);
    const miniCutoff = u32(bytes, 0x38) || 4096;
    const firstMiniFatSector = u32(bytes, 0x3C);
    const numMiniFatSectors = u32(bytes, 0x40);
    const firstDifatSector = u32(bytes, 0x44);
    const numDifatSectors = u32(bytes, 0x48);

    const sectorOff = (s) => (s + 1) * sectorSize;
    const hasSector = (s) => s >= 0 && s !== FREESECT && s !== ENDOFCHAIN && sectorOff(s) + sectorSize <= bytes.length;
    const readSector = (s) => bytes.subarray(sectorOff(s), sectorOff(s) + sectorSize);

    // DIFAT: primeros 109 punteros en el header, el resto en sectores DIFAT.
    const fatSectors = [];
    for (let i = 0; i < 109; i++) {
      const s = u32(bytes, 0x4C + i * 4);
      if (s !== FREESECT && s !== ENDOFCHAIN) fatSectors.push(s);
    }
    let dif = numDifatSectors ? firstDifatSector : ENDOFCHAIN;
    let guardD = 0;
    while (dif !== ENDOFCHAIN && dif !== FREESECT && guardD++ < numDifatSectors + 4) {
      if (!hasSector(dif)) break;
      const sec = readSector(dif);
      const per = sectorSize / 4 - 1;
      for (let i = 0; i < per; i++) {
        const s = u32(sec, i * 4);
        if (s !== FREESECT && s !== ENDOFCHAIN) fatSectors.push(s);
      }
      dif = u32(sec, sectorSize - 4);
    }

    // FAT completa.
    const fat = [];
    for (const fs of fatSectors) {
      if (!hasSector(fs)) continue;
      const sec = readSector(fs);
      for (let o = 0; o + 4 <= sec.length; o += 4) fat.push(u32(sec, o));
    }

    const readChain = (start, size) => {
      const parts = [];
      let total = 0;
      let s = start;
      let guard = 0;
      while (s !== ENDOFCHAIN && s !== FREESECT && guard++ < 1e7) {
        if (!hasSector(s)) break;
        const sec = readSector(s);
        parts.push(sec);
        total += sec.length;
        if (size && total >= size) break;
        s = fat[s];
        if (s === undefined) break;
      }
      const out = new Uint8Array(total);
      let off = 0;
      for (const p of parts) { out.set(p, off); off += p.length; }
      return size ? out.subarray(0, Math.min(size, out.length)) : out;
    };

    // Directorio: sectores encadenados desde firstDirSector.
    const dirData = readChain(firstDirSector, 0);
    const entries = [];
    for (let o = 0; o + 128 <= dirData.length; o += 128) {
      const nameLen = u16(dirData, o + 0x40);
      const type = dirData[o + 0x42];
      let name = '';
      if (type !== 0 && nameLen >= 2 && nameLen <= 64 && o + nameLen - 2 <= dirData.length) {
        const nb = dirData.subarray(o, o + nameLen - 2);
        name = utf16leToStr(nb);
      }
      entries.push({ name, type, start: u32(dirData, o + 0x74), size: u32(dirData, o + 0x78) });
    }

    const root = entries.find((e) => e.type === 5) || null;

    // Mini FAT + mini stream (los streams chicos viven ahi).
    const miniFat = [];
    if (numMiniFatSectors && firstMiniFatSector !== ENDOFCHAIN && hasSector(firstMiniFatSector)) {
      const mf = readChain(firstMiniFatSector, numMiniFatSectors * sectorSize);
      for (let o = 0; o + 4 <= mf.length; o += 4) miniFat.push(u32(mf, o));
    }
    const miniStream = (root && root.size && root.start !== ENDOFCHAIN) ? readChain(root.start, root.size) : new Uint8Array(0);

    const readMiniChain = (start, size) => {
      const parts = [];
      let s = start;
      let total = 0;
      let guard = 0;
      while (s !== ENDOFCHAIN && s !== FREESECT && guard++ < 1e7) {
        const off = s * miniSize;
        if (off + miniSize > miniStream.length) break;
        parts.push(miniStream.subarray(off, off + miniSize));
        total += miniSize;
        if (total >= size) break;
        s = miniFat[s];
        if (s === undefined) break;
      }
      const out = new Uint8Array(total);
      let o = 0;
      for (const p of parts) { out.set(p, o); o += p.length; }
      return out.subarray(0, Math.min(size, out.length));
    };

    const byName = new Map();
    for (const e of entries) {
      if (e.type === 2 && e.name) byName.set(e.name.toUpperCase(), e);
    }

    function get(name) {
      const e = byName.get(String(name).toUpperCase());
      if (!e) return null;
      if (e.size === 0) return new Uint8Array(0);
      if (e.size < miniCutoff) return readMiniChain(e.start, e.size);
      return readChain(e.start, e.size);
    }

    return {
      names: () => Array.from(byName.keys()),
      get
    };
  }

  // ── Decodificacion de texto ────────────────────────────────────────────
  function utf16leToStr(u8) {
    let out = '';
    const n = u8.length & ~1;
    for (let i = 0; i < n; i += 2) out += String.fromCharCode(u8[i] | (u8[i + 1] << 8));
    return out;
  }

  // CP1252: identico a latin1 salvo 0x80-0x9F, que en Windows tiene letras.
  const CP1252 = {
    0x80: '\u20AC', 0x82: '\u201A', 0x83: '\u0192', 0x84: '\u201E', 0x85: '\u2026',
    0x86: '\u2020', 0x87: '\u2021', 0x88: '\u02C6', 0x89: '\u2030', 0x8A: '\u0160',
    0x8B: '\u2039', 0x8C: '\u0152', 0x8E: '\u017D', 0x91: '\u2018', 0x92: '\u2019',
    0x93: '\u201C', 0x94: '\u201D', 0x95: '\u2022', 0x96: '\u2013', 0x97: '\u2014',
    0x98: '\u02DC', 0x99: '\u2122', 0x9A: '\u0161', 0x9B: '\u203A', 0x9C: '\u0153',
    0x9E: '\u017E', 0x9F: '\u0178'
  };
  function cp1252ToStr(u8) {
    let out = '';
    for (let i = 0; i < u8.length; i++) {
      const c = u8[i];
      if (c >= 0x80 && c <= 0x9F) out += (CP1252[c] !== undefined ? CP1252[c] : '\uFFFD');
      else out += String.fromCharCode(c);
    }
    return out;
  }

  // ── MS-DOC: FIB + tabla de piezas (CLX) ────────────────────────────────
  function readPieceTableText(table, wd, fcClx, lcbClx, ccpText) {
    let p = fcClx;
    const end = Math.min(fcClx + lcbClx, table.length);
    // El CLX empieza con cero o mas Prc (byte 0x01, largo int16, datos).
    let guard = 0;
    while (p + 3 <= end && table[p] === 0x01 && guard++ < 1e6) {
      const cb = (table[p + 1] | (table[p + 2] << 8));
      p += 3 + cb;
    }
    if (p + 5 > end || table[p] !== 0x02) return '';
    const lcb = u32(table, p + 1);            // tamano del PlcPcd
    const plc = p + 5;
    if (lcb < 4 || plc + lcb > table.length) return '';
    const n = Math.floor((lcb - 4) / 12);     // 4 = un CP extra; cada PCD son 8 + un CP de 4
    if (n <= 0) return '';

    const cpAt = (i) => u32(table, plc + i * 4);
    const pcdAt = (i) => plc + (n + 1) * 4 + i * 8;
    const parts = [];
    let total = 0;
    for (let i = 0; i < n; i++) {
      if (ccpText && total >= ccpText) break;
      let chars = cpAt(i + 1) - cpAt(i);
      if (chars <= 0) continue;
      if (ccpText && total + chars > ccpText) chars = ccpText - total;
      const fcRaw = u32(table, pcdAt(i) + 2);
      if (fcRaw & 0x40000000) {
        // Comprimido (8 bits, CP1252); el offset real es fc/2.
        const fc = (fcRaw & 0x3FFFFFFF) >> 1;
        if (fc + chars <= wd.length) { parts.push(cp1252ToStr(wd.subarray(fc, fc + chars))); total += chars; }
      } else {
        const fc = fcRaw & 0x3FFFFFFF;
        const blen = chars * 2;
        if (fc + blen <= wd.length) { parts.push(utf16leToStr(wd.subarray(fc, fc + blen))); total += chars; }
      }
    }
    return parts.join('');
  }

  // Convierte las marcas de control de Word en saltos de linea y quita lo que
  // no es texto visible (instrucciones de campo, imagenes, notas).
  function cleanDocText(text) {
    let out = '';
    let inInstr = false;
    for (const ch of String(text)) {
      const c = ch.charCodeAt(0);
      if (c === 0x13) { inInstr = true; continue; }   // comienzo de campo
      if (c === 0x14 || c === 0x15) { inInstr = false; continue; } // separador / fin
      if (inInstr) continue;
      if (c === 0x0D || c === 0x07 || c === 0x0B || c === 0x0C) { out += '\n'; continue; }
      if (c === 0x0A || c === 0x09) { out += ch; continue; } // salto/tab ya en texto (RTF, HTML, plano)
      if (c < 0x20) continue; // 0x01 imagen, 0x02 nota, 0x08 dibujo, 0x00, etc.
      out += ch;
    }
    return out;
  }

  function textToBlocks(text) {
    const blocks = [];
    for (const raw of String(text).split('\n')) {
      const line = raw.replace(/\u00A0/g, ' ').replace(/[ \t]+$/, '');
      if (line.trim()) blocks.push({ type: 'paragraph', text: line });
    }
    return blocks;
  }

  function baseName(p) {
    const b = String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
    return b.replace(/\.[^.\\/]+$/, '') || b;
  }

  // ── Formatos que se llaman ".doc" pero no son OLE2 ─────────────────────
  // Muchos programas guardan como .doc algo que en realidad es RTF, HTML o
  // texto plano. En vez de fallar, se detecta aqui y se extrae el texto.
  function isOLE2(b) {
    if (b.length < 8) return false;
    for (let i = 0; i < 8; i++) if (b[i] !== SIG[i]) return false;
    return true;
  }
  function asciiHead(bytes, n) {
    let s = '';
    for (let i = 0; i < Math.min(n, bytes.length); i++) s += String.fromCharCode(bytes[i]);
    return s;
  }
  function safeUtf8(u8) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); } catch (e) { return null; }
  }
  function decodeText(bytes) {
    if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) return utf16leToStr(bytes.subarray(2));
    if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
      let out = '';
      for (let i = 2; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
      return out;
    }
    const body = (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) ? bytes.subarray(3) : bytes;
    return safeUtf8(body) || cp1252ToStr(body);
  }
  function printableRatio(s) {
    if (!s.length) return 0;
    let ok = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 9 || c === 10 || c === 13 || c >= 32) ok++;
    }
    return ok / s.length;
  }

  // RTF -> texto. Minimalista: entiende grupos, destinos ignorables, control
  // words basicos (par/line/tab/u) y los escapes \'hh.
  const RTF_DEST = new Set([
    'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'nonshppict', 'shppict',
    'header', 'headerl', 'headerr', 'headerf', 'footer', 'footerl', 'footerr', 'footerf',
    'footnote', 'annotation', 'object', 'themedata', 'colorschememapping', 'latentstyles',
    'datastore', 'xmlnstbl', 'listtable', 'listoverridetable', 'rsidtbl', 'generator',
    'filetbl', 'revtbl', 'upr', 'fldinst'
  ]);
  function rtfToText(src) {
    let out = '';
    const stack = [];
    let ignore = false;
    let i = 0;
    const n = src.length;
    while (i < n) {
      const c = src[i];
      if (c === '{') { stack.push(ignore); i++; continue; }
      if (c === '}') { ignore = stack.length ? stack.pop() : false; i++; continue; }
      if (c === '\\') {
        const next = src[i + 1];
        if (next === '\\' || next === '{' || next === '}') { if (!ignore) out += next; i += 2; continue; }
        if (next === "'") {
          const hex = src.substr(i + 2, 2);
          i += 4;
          if (!ignore) out += cp1252ToStr(new Uint8Array([parseInt(hex, 16) & 0xFF]));
          continue;
        }
        if (next === '~') { if (!ignore) out += '\u00A0'; i += 2; continue; }
        if (next === '-' || next === '_') { i += 2; continue; }
        if (next === '*') { ignore = true; i += 2; continue; }
        let j = i + 1;
        let word = '';
        while (j < n && /[a-zA-Z]/.test(src[j])) { word += src[j]; j++; }
        let param = '';
        while (j < n && /[-0-9]/.test(src[j])) { param += src[j]; j++; }
        if (src[j] === ' ') j++;
        i = j;
        if (word === 'par' || word === 'line' || word === 'sect') { if (!ignore) out += '\n'; continue; }
        if (word === 'tab') { if (!ignore) out += '\t'; continue; }
        if (word === 'u') {
          let code = parseInt(param, 10) || 0;
          if (code < 0) code += 65536;
          if (!ignore) out += String.fromCharCode(code);
          const fb = src[i];
          if (fb && fb !== '\\' && fb !== '{' && fb !== '}') i++; // caracter de respaldo
          continue;
        }
        if (RTF_DEST.has(word)) { ignore = true; continue; }
        continue;
      }
      if (c === '\r' || c === '\n') { i++; continue; }
      if (!ignore) out += c;
      i++;
    }
    return out;
  }

  // Tabla de colores: `{\colortbl;\redR\greenG\blueB;...}`. El indice 0 es
  // "auto" (sin color). `\cfN` referencia el indice N.
  function parseColorTable(src) {
    const at = src.indexOf('\\colortbl');
    if (at === -1) return [];
    const body = src.slice(at + '\\colortbl'.length);
    let depth = 0;
    let end = body.length;
    for (let p = 0; p < body.length; p++) {
      if (body[p] === '{') depth++;
      else if (body[p] === '}') { if (depth === 0) { end = p; break; } depth--; }
    }
    const hex = (x) => Math.max(0, Math.min(255, parseInt(x, 10) || 0)).toString(16).padStart(2, '0');
    return body.slice(0, end).split(';').map((part) => {
      const m = /\\red(\d+)\s*\\green(\d+)\s*\\blue(\d+)/.exec(part);
      return m ? '#' + hex(m[1]) + hex(m[2]) + hex(m[3]) : null;
    });
  }

  // RTF -> bloques del modelo conservando la estructura que si es fiable:
  // parrafos, negrita/cursiva/subrayado por tramo, tamanos y color, saltos de
  // pagina, y titulos (un parrafo entero en negrita con un tamano mayor que el
  // cuerpo). No inventa: si no hay estilo, el parrafo va como texto plano.
  function rtfToBlocks(src) {
    const colors = parseColorTable(src);
    const blocks = [];
    const stack = [];
    const state = { bold: false, italic: false, underline: false, size: null, color: null };
    const sizeCount = new Map();
    let runs = [];
    let ignore = false;

    const keyOf = () => (state.bold ? 'b' : '') + (state.italic ? 'i' : '') + (state.underline ? 'u' : '')
      + '|' + (state.size == null ? '' : state.size) + '|' + (state.color || '');

    const pushText = (t) => {
      if (!t) return;
      const w = (state.size == null ? 0 : state.size);
      sizeCount.set(w, (sizeCount.get(w) || 0) + t.length);
      const last = runs[runs.length - 1];
      const k = keyOf();
      if (last && last._k === k) { last.text += t; return; }
      runs.push({ text: t, _k: k, bold: state.bold, italic: state.italic, underline: state.underline, size: state.size, color: state.color });
    };
    const flush = () => {
      if (!runs.length) { runs = []; return; }
      const text = runs.map((r) => r.text).join('');
      if (text.trim()) blocks.push({ _runs: runs, text });
      runs = [];
    };
    // Convierte el texto y evita caracteres de control que no representan nada.
    const pushChar = (c) => { if (!ignore) pushText(c); };

    let i = 0;
    const n = src.length;
    while (i < n) {
      const c = src[i];
      if (c === '{') { stack.push({ ignore, state: Object.assign({}, state) }); i++; continue; }
      if (c === '}') { const prev = stack.pop(); if (prev) { ignore = prev.ignore; Object.assign(state, prev.state); } i++; continue; }
      if (c === '\\') {
        const next = src[i + 1];
        if (next === '\\' || next === '{' || next === '}') { pushChar(next); i += 2; continue; }
        if (next === "'") {
          const hexByte = src.substr(i + 2, 2);
          i += 4;
          pushChar(cp1252ToStr(new Uint8Array([parseInt(hexByte, 16) & 0xFF])));
          continue;
        }
        if (next === '~') { pushChar('\u00A0'); i += 2; continue; }
        if (next === '-' || next === '_') { i += 2; continue; }
        if (next === '*') { ignore = true; i += 2; continue; }
        let j = i + 1;
        let word = '';
        while (j < n && /[a-zA-Z]/.test(src[j])) { word += src[j]; j++; }
        let param = '';
        while (j < n && /[-0-9]/.test(src[j])) { param += src[j]; j++; }
        if (src[j] === ' ') j++;
        i = j;
        if (ignore) continue;
        if (word === 'par' || word === 'sect') { flush(); continue; }
        if (word === 'line') { pushText('\n'); continue; }
        if (word === 'page') { flush(); blocks.push({ _page: true }); continue; }
        if (word === 'tab') { pushText('\t'); continue; }
        if (word === 'u') {
          let code = parseInt(param, 10) || 0;
          if (code < 0) code += 65536;
          pushText(String.fromCharCode(code));
          const fb = src[i];
          if (fb && fb !== '\\' && fb !== '{' && fb !== '}') i++; // caracter de respaldo
          continue;
        }
        if (word === 'b') { state.bold = param !== '0'; continue; }
        if (word === 'i') { state.italic = param !== '0'; continue; }
        if (word === 'ul') { state.underline = param !== '0'; continue; }
        if (word === 'ulnone') { state.underline = false; continue; }
        if (word === 'fs') { state.size = param ? Math.round(parseInt(param, 10) / 2) : null; continue; }
        if (word === 'cf') { const idx = parseInt(param, 10) || 0; state.color = colors[idx] || null; continue; }
        if (word === 'plain') { state.bold = false; state.italic = false; state.underline = false; continue; }
        if (RTF_DEST.has(word)) { ignore = true; continue; }
        continue;
      }
      if (c === '\r' || c === '\n') { i++; continue; }
      pushChar(c);
      i++;
    }
    flush();

    // Cuerpo = tamano mas frecuente por cantidad de texto.
    let bodySize = 0;
    let best = -1;
    for (const [s, w] of sizeCount) { if (w > best) { best = w; bodySize = s; } }

    const isPlainRun = (r) => !r.bold && !r.italic && !r.underline && !r.color;
    const headingSizes = [];
    for (const b of blocks) {
      if (b._page || !b._runs) continue;
      const nonSpace = b._runs.filter((r) => r.text.trim());
      if (!nonSpace.length) continue;
      const allBold = nonSpace.every((r) => r.bold);
      const maxSize = Math.max.apply(null, nonSpace.map((r) => r.size || 0));
      if (allBold && b.text.trim().length <= 160 && bodySize && maxSize >= bodySize + 3) {
        if (headingSizes.indexOf(maxSize) === -1) headingSizes.push(maxSize);
      }
    }
    headingSizes.sort((a, b) => b - a);

    const out = [];
    for (const b of blocks) {
      if (b._page) { out.push({ type: 'pagebreak' }); continue; }
      const nonSpace = b._runs.filter((r) => r.text.trim());
      if (!nonSpace.length) continue;
      const allBold = nonSpace.every((r) => r.bold);
      const maxSize = Math.max.apply(null, nonSpace.map((r) => r.size || 0));
      const plain = b._runs.every(isPlainRun);
      if (allBold && b.text.trim().length <= 160 && bodySize && maxSize >= bodySize + 3) {
        const level = Math.min(3, Math.max(1, headingSizes.indexOf(maxSize) + 1));
        const heading = { type: 'heading', level, text: b.text.replace(/[ \t]+$/, '') };
        const col = nonSpace[0].color;
        if (col && nonSpace.every((r) => r.color === col)) heading.color = col;
        out.push(heading);
        continue;
      }
      if (plain) { out.push({ type: 'paragraph', text: b.text.replace(/[ \t]+$/, '') }); continue; }
      const runsOut = b._runs.map((r) => {
        const c = { text: r.text };
        if (r.bold) c.bold = true;
        if (r.italic) c.italic = true;
        if (r.underline) c.underline = true;
        if (r.color) c.color = r.color;
        if (r.size != null && r.size !== bodySize) c.size = r.size;
        return c;
      }).filter((r) => r.text.length);
      out.push({ type: 'paragraph', runs: runsOut });
    }
    return out;
  }

  function htmlToText(html) {
    let s = String(html);
    s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
    s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<\/(p|div|tr|li|h[1-6]|table|section|article)>/gi, '\n');
    s = s.replace(/<[^>]+>/g, '');
    s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
    s = s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
    s = s.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
    return s;
  }

  // Devuelve { text, kind }. Si se pasa `kind` se usa ese lector sin adivinar
  // RTF: lector completo (tablas, imágenes, listas…); si fallara, el simple de siempre.
  function rtfResult(s, w) {
    try {
      const r = rtfRead.readRtf(s);
      if (r.blocks.length) { for (const m of r.warnings) w.push(m); return { text: s, kind: 'rtf', blocks: r.blocks, page: r.page, meta: r.meta, title: r.title }; }
    } catch (e) { w.push('lector RTF completo falló (' + e.message + '); uso el simple'); }
    return { text: s, kind: 'rtf', blocks: rtfToBlocks(s) };
  }

  // (kind: 'doc' | 'rtf' | 'html' | 'text'); sin `kind` autodetecta el .doc.
  function readAnyDoc(input, warnings, kind) {
    const w = warnings || [];
    const bytes = toU8(input);
    if (kind === 'rtf') {
      const s = decodeText(bytes);
      return rtfResult(s, w);
    }
    if (kind === 'html') return { text: htmlToText(decodeText(bytes)), kind: 'html' };
    if (kind === 'text') return { text: decodeText(bytes), kind: 'text' };
    if (kind && kind !== 'doc') throw new Error('formato de documento no soportado: ' + kind);
    if (isOLE2(bytes)) {
      // .doc binario: primero el lector con formato (tablas, listas, imágenes…); si falla, el texto plano de siempre.
      try {
        const cfb = parseCFB(bytes); const wd = cfb.get('WordDocument');
        if (wd && wd.length > 0x200 && u16(wd, 0) === 0xA5EC) {
          const table = cfb.get((u16(wd, 0x0A) & 0x0200) ? '1Table' : '0Table');
          const r = table ? docBinary.readDocBinary(wd, table, cfb.get('Data'), { cp1252ToStr, utf16leToStr }) : null;
          if (r && r.blocks.length) { for (const m of r.warnings) w.push(m); return { text: '', kind: 'ole2', blocks: r.blocks, page: r.page }; }
        }
      } catch (e) { w.push('lector .doc con formato falló (' + e.message + '); uso solo el texto'); }
      return { text: extractWordText(bytes, w), kind: 'ole2' };
    }
    const head = asciiHead(bytes, 16);
    if (/^\s*\{\\rtf/i.test(head)) {
      w.push('el .doc no es el formato binario de Word sino RTF; lo abri como texto');
      // Igual que la rama explicita: hay exportadores (PDF -> RTF) que escriben el
      // cuerpo en UTF-8 aunque digan \ansi; leerlo como CP1252 deja "Ã¡" y "â€”".
      const s = decodeText(bytes);
      return rtfResult(s, w);
    }
    const text = decodeText(bytes);
    if (/^\s*<(?:!doctype|html|head|body|meta|div|p|table)\b/i.test(text) || /<html[\s>]/i.test(text.slice(0, 4000))) {
      w.push('el .doc es en realidad HTML; lo abri como texto');
      return { text: htmlToText(text), kind: 'html' };
    }
    if (printableRatio(text) < 0.8) {
      throw new Error('el archivo no es un .doc de Word ni texto reconocible (formato no soportado)');
    }
    return { text, kind: 'text' };
  }

  // ── Entrada principal ──────────────────────────────────────────────────
  function extractWordText(input, warnings) {
    const w = warnings || [];
    const cfb = parseCFB(input);
    const wd = cfb.get('WordDocument');
    if (!wd || wd.length < 0x20) throw new Error('el archivo no tiene el stream WordDocument');

    if (u16(wd, 0) !== 0xA5EC) w.push('la cabecera de Word no es la esperada; pruebo igual');

    const flags = u16(wd, 0x0A);
    const fWhichTblStm = !!(flags & 0x0200);
    const fExtChar = !!(flags & 0x1000);
    const ccpText = u32(wd, 0x4C);
    const fcMin = u32(wd, 0x18);
    const fcMac = u32(wd, 0x1C);
    const fcClx = u32(wd, 0x01A2);
    const lcbClx = u32(wd, 0x01A6);

    let text = '';
    const table = cfb.get(fWhichTblStm ? '1Table' : '0Table');
    if (table && lcbClx > 0 && fcClx + lcbClx <= table.length) {
      try { text = readPieceTableText(table, wd, fcClx, lcbClx, ccpText); }
      catch (e) { w.push('no pude leer la tabla de piezas: ' + e.message); }
    }

    if (!text) {
      // Respaldo: algunos .doc simples guardan el texto entre fcMin y fcMac.
      const end = Math.min(fcMac, wd.length);
      if (fcMac > fcMin && end > fcMin) {
        const slice = wd.subarray(fcMin, end);
        text = fExtChar ? utf16leToStr(slice) : cp1252ToStr(slice);
        if (ccpText && text.length > ccpText) text = text.slice(0, ccpText);
      }
    }
    return text;
  }

  function docBytesToDoc(input, opts) {
    const o = opts || {};
    const warnings = [];
    const kind = o.kind || 'doc';
    const res = readAnyDoc(input, warnings, kind);
    const blocks = res.blocks ? res.blocks : textToBlocks(cleanDocText(res.text));
    const doc = model.createDoc({
      title: o.title || res.title || (o.sourcePath ? baseName(o.sourcePath) : 'Documento'),
      meta: Object.assign({}, res.meta || {}, { source: o.format || (kind === 'ole2' ? 'doc' : kind), sourcePath: o.sourcePath || '' }),
      page: res.page,
      blocks,
      warnings
    });
    if (!blocks.length) {
      warnings.push('el documento no tiene texto reconocible (puede tener solo imagenes o estar danado)');
    }
    if (!doc.title || doc.title === 'Documento') {
      doc.title = model.deriveTitle(doc);
      doc.hash = model.hashDoc(doc);
    }
    return { doc, warnings };
  }

  return {
    docBytesToDoc,
    _internal: {
      parseCFB, extractWordText, readPieceTableText, cleanDocText, textToBlocks,
      cp1252ToStr, utf16leToStr, readAnyDoc, rtfToText, rtfToBlocks, parseColorTable,
      htmlToText, decodeText, printableRatio, isOLE2
    }
  };
});

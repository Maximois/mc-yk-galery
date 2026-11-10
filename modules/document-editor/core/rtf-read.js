'use strict';
/**
 * document-editor / core/rtf-read.js — RTF → bloques del modelo, con la mayor fidelidad que el modelo permite.
 *
 * Lee: párrafos, negrita/cursiva/subrayado/tachado, fuente, tamaño, color y resaltado por tramo, alineación,
 * sangría de primera línea, espacio antes/después e interlineado, títulos (estilo «heading N» o negrita grande),
 * listas con viñetas y numeradas, tablas (celdas combinadas en horizontal y vertical, relleno, anchos, encabezado),
 * imágenes PNG/JPEG incrustadas, hipervínculos, notas al pie, encabezado y pie, tamaño y márgenes de página,
 * propiedades del documento, saltos de página, páginas de códigos (\ansicpg) y Unicode (\uN con \ucN).
 * Lo que el modelo no tiene (metarchivos EMF/WMF, formas dibujadas) se avisa en `warnings`
 * en vez de perderse en silencio.
 * UMD puro (sin DOM).
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else { root.MCDoc = root.MCDoc || {}; root.MCDoc.rtfRead = mod; }
})(typeof self !== 'undefined' ? self : this, function () {
  const SKIP = new Set(['fonttbl', 'colortbl', 'latentstyles', 'datastore', 'themedata', 'colorschememapping', 'xmlnstbl', 'rsidtbl',
    'listtable', 'listoverridetable', 'generator', 'filetbl', 'revtbl', 'upr', 'listtext', 'pntext', 'pntxta', 'pntxtb', 'nonshppict',
    'shpinst', 'object', 'objdata', 'bkmkstart', 'bkmkend', 'xe', 'tc', 'private', 'template', 'wgrffmtfilter', 'mmathPr', 'pgptbl', 'protusertbl']);
  const HEADER = new Set(['header', 'headerl', 'headerr', 'headerf']);
  const FOOTER = new Set(['footer', 'footerl', 'footerr', 'footerf']);
  const UL = new Set(['ul', 'uld', 'uldb', 'ulw', 'ulth', 'ulwave', 'uldash', 'uldashd', 'uldashdd', 'ulhair', 'ulldash', 'ulthd', 'ulthdash']);
  const CP_LABEL = { 874: 'windows-874', 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 1250: 'windows-1250', 1251: 'windows-1251', 1252: 'windows-1252', 1253: 'windows-1253', 1254: 'windows-1254', 1255: 'windows-1255', 1256: 'windows-1256', 1257: 'windows-1257', 1258: 'windows-1258', 10000: 'macintosh', 65001: 'utf-8' };
  const hex2 = (n) => Math.max(0, Math.min(255, n | 0)).toString(16).padStart(2, '0');

  function decoderFor(cp) {
    try { return new TextDecoder(CP_LABEL[cp] || 'windows-1252'); } catch { return new TextDecoder('windows-1252'); }
  }

  function readRtf(src) {
    const warnings = []; const meta = {}; const page = {};
    const colors = [null]; const fonts = Object.create(null); const styles = Object.create(null);
    const listDefs = Object.create(null); const listOver = Object.create(null);     // listid → nfc ; ls → listid
    let defFont = null; let dec = decoderFor(1252); let cpNum = 1252; let uc = 1;
    let sawSup = false; let sawMeta = 0;

    // Destinos con contenido propio (notas, encabezados…) usan un «sumidero» de párrafos aparte.
    const newSink = () => ({ paras: [], cur: null });
    let sink = newSink(); const mainSink = sink;
    const entries = []; let st; const stack = [];
    let tbl = null; let rowDef = null; let cellDefs = []; let cell = null;
    let pendingLink = null; let hexBuf = []; let skip = 0; let pictBuf = null; let textBuf = null;

    const baseState = () => ({ b: false, i: false, ul: false, strike: false, vert: null, fs: null, cf: 0, hl: 0, f: null, hidden: false, link: null,
      align: null, li: 0, fi: 0, sb: null, sa: null, sl: null, slmult: 0, ls: null, ilvl: 0, intbl: false, pagebb: false, style: null, pnb: null,
      dest: null, ignore: false, own: null, uc });
    st = baseState();

    // ── párrafo en curso ──
    const para = () => { if (!sink.cur) sink.cur = { runs: [], props: null }; return sink.cur; };
    const flushHex = () => {
      if (!hexBuf.length) return;
      const bytes = new Uint8Array(hexBuf); hexBuf = [];
      addText(dec.decode(bytes), true);
    };
    function addText(t, fromHex) {
      if (!t) return;
      if (st.ignore || st.hidden) return;
      if (textBuf) { textBuf.s += t; return; }
      if (st.dest === 'info' || st.dest === 'infoitem' || st.dest === 'stylesheet' || st.dest === 'fonttbl' || st.dest === 'colortbl') return;
      if (skip > 0 && !fromHex) { const cut = Math.min(skip, t.length); t = t.slice(cut); skip -= cut; if (!t) return; }
      if (pictBuf) return;
      const p = para();
      if (!p.props) p.props = snapshotProps();
      const last = p.runs[p.runs.length - 1];
      const run = { text: t, bold: st.b, italic: st.i, underline: st.ul, strike: st.strike, vert: st.vert, size: st.fs, color: st.cf ? colors[st.cf] || null : null, highlight: st.hl ? colors[st.hl] || null : null, font: st.f != null ? fonts[st.f] || null : null, link: st.link };
      const same = last && !last.note && ['bold', 'italic', 'underline', 'strike', 'vert', 'size', 'color', 'highlight', 'font', 'link'].every((k) => last[k] === run[k]);
      if (same) last.text += t; else p.runs.push(run);
    }
    const snapshotProps = () => ({ align: st.align, li: st.li, fi: st.fi, sb: st.sb, sa: st.sa, sl: st.sl, slmult: st.slmult, ls: st.ls, ilvl: st.ilvl, intbl: st.intbl, pagebb: st.pagebb, style: st.style, pnb: st.pnb });
    function endPara() {
      flushHex();
      if (st.dest === 'info-text' || textBuf) return;
      if (tbl && !st.intbl && sink === mainSink && !(cell)) closeTable();
      if (st.intbl && sink === mainSink) { // dentro de una celda: el salto de párrafo es un salto de línea
        const p = para(); if (!p.props) p.props = snapshotProps();
        if (p.runs.length) p.runs.push({ text: '\n', bold: false, italic: false, underline: false, strike: false, size: null, color: null, highlight: null, font: null, link: null, cellBreak: true });
        return;
      }
      const p = sink.cur || { runs: [], props: snapshotProps() }; if (!p.props) p.props = snapshotProps();
      sink.paras.push(p); sink.cur = null;
      if (sink === mainSink) { entries.push({ kind: 'para', p }); }
    }
    function closeTable() {
      if (!tbl) return; const t = tbl; tbl = null; rowDef = null; cellDefs = []; cell = null;
      if (t.rows.length) entries.push({ kind: 'table', t });
    }

    // ── tablas ──
    const ensureTable = () => { if (!tbl) tbl = { rows: [], cur: [], header: false }; };
    function endCell() {
      flushHex(); ensureTable();
      const p = sink.cur; sink.cur = null;
      let runs = p ? p.runs.slice() : []; while (runs.length && runs[runs.length - 1].cellBreak) runs.pop();
      runs = runs.map((r) => { if (r.cellBreak) { const c = Object.assign({}, r); delete c.cellBreak; return c; } return r; });
      tbl.cur.push({ runs, def: null }); cell = null;
    }
    function endRow() {
      if (!tbl) return; if (sink.cur && sink.cur.runs.length) endCell();
      cellDefs.forEach((d, i) => { if (tbl.cur[i]) tbl.cur[i].def = d; });
      tbl.rows.push({ cells: tbl.cur, trhdr: rowDef && rowDef.trhdr }); tbl.cur = [];
      if (tbl.rows.length === 1 && rowDef && rowDef.trhdr) tbl.header = true;
      cellDefs = []; rowDef = null;
    }
    const curDef = () => (rowDef ? (rowDef.pending = rowDef.pending || {}) : {});

    // ── lectura ──
    const n = src.length; let i = 0;
    const enter = () => { flushHex(); stack.push({ st, sink, own: null }); st = Object.assign({}, st, { own: null }); };
    const leave = () => {
      flushHex();
      const top = stack.pop(); if (!top) return;
      const closing = st;
      if (closing.own) finishOwn(closing.own);
      st = top.st; sink = top.sink;
    };
    function textOfSink(s) { return s.paras.concat(s.cur ? [s.cur] : []).map((p) => p.runs.map((r) => r.text).join('')).join('\n').trim(); }
    function finishOwn(own) {
      if (own.type === 'pict') { finishPict(own); return; }
      if (own.type === 'note') {
        const txt = textOfSink(own.sink); const host = own.prev; const p = host.cur || (host.cur = { runs: [], props: null });
        const last = p.runs[p.runs.length - 1]; if (txt) { if (last && !last.note) last.note = txt; else p.runs.push({ text: '​', bold: false, italic: false, underline: false, strike: false, size: null, color: null, highlight: null, font: null, link: null, note: txt }); }
        return;
      }
      if (own.type === 'header') { const t = textOfSink(own.sink); if (t && !page.header) page.header = t; return; }
      if (own.type === 'footer') { const t = textOfSink(own.sink); if (t && !page.footer) page.footer = t; return; }
      if (own.type === 'fldinst') { const m = /HYPERLINK\s+"([^"]+)"/i.exec(textBuf ? textBuf.s : ''); pendingLink = m ? m[1] : null; textBuf = null; return; }
      if (own.type === 'meta') { const v = textBuf ? textBuf.s.trim() : ''; if (v) meta[own.key] = v; textBuf = null; return; }
      if (own.type === 'style') { if (own.num != null) { const nm = (textBuf ? textBuf.s : '').replace(/;.*$/, '').trim(); if (nm) styles[own.num] = nm; } textBuf = null; }
      if (own.type === 'fontname') { if (own.num != null) { const nm = (textBuf ? textBuf.s : '').replace(/;.*$/, '').trim(); if (nm) fonts[own.num] = nm; } textBuf = null; }
    }
    function finishPict(own) {
      const b = pictBuf; pictBuf = null; if (!b) return;
      if (!b.type) { warnings.push('una imagen en un formato que no se puede mostrar (metarchivo) se omitió'); return; }
      const hex = b.hex.replace(/[^0-9a-fA-F]/g, ''); if (hex.length < 20) return;
      const bytes = Buffer.from(hex.length % 2 ? hex.slice(0, -1) : hex, 'hex');
      const w = b.goalw ? Math.round(b.goalw / 15) : (b.w ? Math.round(b.w / 15) : null); const h = b.goalh ? Math.round(b.goalh / 15) : (b.h ? Math.round(b.h / 15) : null);
      const e = { kind: 'image', src: `data:image/${b.type};base64,${bytes.toString('base64')}`, width: w, height: h };
      if (own.inCell) { warnings.push('una imagen dentro de una tabla se omitió'); return; }
      if (sink.cur && sink.cur.runs.length) endPara();
      entries.push(e);
    }

    while (i < n) {
      const c = src[i];
      if (c === '{') { enter(); i++; continue; }
      if (c === '}') { leave(); i++; continue; }
      if (c === '\r' || c === '\n') { if (!pictBuf) { /* los saltos de línea del archivo no cuentan */ } i++; continue; }
      if (pictBuf && st.own && st.own.type === 'pict' && c !== '\\') {
        let j = i; while (j < n && src[j] !== '\\' && src[j] !== '{' && src[j] !== '}') j++;
        pictBuf.hex += src.slice(i, j); i = j; continue;
      }
      if (c !== '\\') {
        let j = i; while (j < n && src[j] !== '\\' && src[j] !== '{' && src[j] !== '}' && src[j] !== '\r' && src[j] !== '\n') j++;
        flushHex(); addText(src.slice(i, j), false); i = j; continue;
      }
      // control
      const next = src[i + 1];
      if (next === '\\' || next === '{' || next === '}') { flushHex(); addText(next, false); i += 2; continue; }
      if (next === "'") {
        const v = parseInt(src.substr(i + 2, 2), 16); i += 4; if (isNaN(v)) continue;
        if (skip > 0) { skip--; continue; }
        if (st.ignore || st.hidden) continue;
        if (cpNum === 932 || cpNum === 936 || cpNum === 949 || cpNum === 950) hexBuf.push(v);
        else { flushHex(); hexBuf.push(v); flushHex(); }
        continue;
      }
      if (next === '~') { flushHex(); addText(' ', false); i += 2; continue; }
      if (next === '_') { flushHex(); addText('‑', false); i += 2; continue; }
      if (next === '-') { i += 2; continue; }
      if (next === '\r' || next === '\n') { flushHex(); endPara(); i += 2; continue; }
      if (next === '*') { flushHex(); if (!st.ignore) st.ignore = 'star'; i += 2; continue; }
      let j = i + 1; let word = '';
      while (j < n && /[a-zA-Z]/.test(src[j])) { word += src[j]; j++; }
      let param = ''; if (src[j] === '-') { param = '-'; j++; }
      while (j < n && /[0-9]/.test(src[j])) { param += src[j]; j++; }
      if (src[j] === ' ') j++;
      i = j;
      const num = param === '' || param === '-' ? null : parseInt(param, 10);
      const on = num !== 0;

      // palabras que se leen aunque el grupo sea «\*» (viñetas antiguas)
      if (word === 'pnlvlblt') { st.pnb = 'bullet'; continue; }
      if (word === 'pndec' || word === 'pnlvlbody' || word === 'pnucrm' || word === 'pnlcrm' || word === 'pnucltr' || word === 'pnlcltr') { if (st.pnb !== 'bullet') st.pnb = 'num'; continue; }

      // ── destinos ──
      if (!st.dest || st.dest === 'star') {
        if (SKIP.has(word) && !(word === 'listtext' || word === 'pntext') || (word === 'listtext' || word === 'pntext')) {
          if (word === 'fonttbl') { st.dest = 'fonttbl'; continue; }
          if (word === 'colortbl') { st.dest = 'colortbl'; const at = i; let k = at; let depth = 0; while (k < n) { if (src[k] === '{') depth++; else if (src[k] === '}') { if (depth === 0) break; depth--; } k++; }
            let curc = null; const body = src.slice(at, k); colors.length = 1; let ci = 0;
            for (const part of body.split(';')) { const m = /\\red(\d+)\s*\\green(\d+)\s*\\blue(\d+)/.exec(part); if (ci === 0 && !m) { ci++; continue; } if (m) colors.push('#' + hex2(+m[1]) + hex2(+m[2]) + hex2(+m[3])); else if (ci > 0) colors.push(null); ci++; }
            void curc; st.ignore = 'skip'; continue; }
          if (word === 'listtable') { st.ignore = 'skip'; parseLists(src, i, listDefs); continue; }
          if (word === 'listoverridetable') { st.ignore = 'skip'; parseOverrides(src, i, listOver); continue; }
          st.ignore = 'skip'; continue;
        }
        if (word === 'stylesheet') { st.dest = 'stylesheet'; continue; }
        if (word === 'info') { st.dest = 'info'; continue; }
        if (HEADER.has(word)) { const o = { type: 'header', sink: newSink() }; st.own = o; st.dest = 'sub'; sink = o.sink; continue; }
        if (FOOTER.has(word)) { const o = { type: 'footer', sink: newSink() }; st.own = o; st.dest = 'sub'; sink = o.sink; continue; }
        if (word === 'footnote' || word === 'annotation') { const o = { type: 'note', sink: newSink(), prev: sink }; st.own = o; st.dest = 'sub'; sink = o.sink; st.intbl = false; continue; }
        if (word === 'pict') { pictBuf = { hex: '', type: null }; st.own = { type: 'pict', inCell: st.intbl }; st.dest = 'pict'; continue; }
        if (word === 'field') { continue; }
        if (word === 'fldinst') { textBuf = { s: '' }; st.own = { type: 'fldinst' }; st.dest = 'fld'; st.ignore = false; continue; }
        if (word === 'fldrslt') { st.link = pendingLink; continue; }
        if (st.dest === 'info' || st.dest === 'infoitem') { /* abajo */ }
      }
      if (st.dest === 'info' && ['title', 'author', 'subject', 'keywords', 'company'].includes(word)) { st.dest = 'infoitem'; textBuf = { s: '' }; st.own = { type: 'meta', key: word }; sawMeta++; continue; }
      if (st.dest === 'stylesheet' && (word === 's') && num != null && !st.own) { st.own = { type: 'style', num }; textBuf = { s: '' }; continue; }
      if (st.dest === 'stylesheet' && !st.own && (word === 'cs' || word === 'ds' || word === 'ts')) { st.own = { type: 'style', num: null }; textBuf = { s: '' }; continue; }
      if (st.dest === 'fonttbl') {
        if (word === 'f' && num != null) { st.own = { type: 'fontname', num }; textBuf = { s: '' }; }
        continue;
      }
      if (st.dest === 'pict') {
        if (word === 'pngblip') pictBuf.type = 'png'; else if (word === 'jpegblip') pictBuf.type = 'jpeg';
        else if (word === 'picwgoal') pictBuf.goalw = num; else if (word === 'pichgoal') pictBuf.goalh = num;
        else if (word === 'picw') pictBuf.w = num; else if (word === 'pich') pictBuf.h = num;
        continue;
      }
      if (st.ignore) continue;

      // ── documento ──
      switch (word) {
        case 'ansicpg': if (num) { cpNum = num; dec = decoderFor(num); } continue;
        case 'deff': defFont = num; continue;
        case 'uc': st.uc = num == null ? 1 : num; uc = st.uc; continue;
        case 'paperw': if (num) page.width = num / 20; continue;
        case 'paperh': if (num) page.height = num / 20; continue;
        case 'margl': page.marginLeft = num / 20; continue;
        case 'margr': page.marginRight = num / 20; continue;
        case 'margt': page.marginTop = num / 20; continue;
        case 'margb': page.marginBottom = num / 20; continue;
        case 'landscape': page.orientation = 'landscape'; continue;
        case 'titlepg': page.titlePage = true; continue;
        case 'cols': if (num > 1) page.columns = Math.min(3, num); continue;
        // formato de carácter
        case 'plain': st.b = false; st.i = false; st.ul = false; st.strike = false; st.vert = null; st.fs = null; st.cf = 0; st.hl = 0; st.f = null; st.hidden = false; continue;
        case 'b': st.b = on; continue; case 'i': st.i = on; continue;
        case 'strike': case 'striked': st.strike = on; continue;
        case 'ulnone': st.ul = false; continue;
        case 'fs': st.fs = num ? Math.max(4, Math.round(num / 2)) : null; continue;
        case 'cf': st.cf = num || 0; continue;
        case 'highlight': case 'chcbpat': st.hl = num || 0; continue;
        case 'f': st.f = num; continue;
        case 'v': st.hidden = on; continue;
        case 'super': st.vert = on ? 'sup' : null; continue;
        case 'sub': st.vert = on ? 'sub' : null; continue;
        case 'up': case 'dn': if (on) sawSup = true; continue;
        case 'nosupersub': st.vert = null; continue;
        // párrafo
        case 'pard': Object.assign(st, { align: null, li: 0, fi: 0, sb: null, sa: null, sl: null, slmult: 0, ls: null, ilvl: 0, intbl: false, pagebb: false, style: null, pnb: null }); continue;
        case 'qc': st.align = 'center'; continue; case 'qr': st.align = 'right'; continue; case 'ql': st.align = 'left'; continue; case 'qj': st.align = 'justify'; continue;
        case 'li': st.li = num || 0; continue; case 'fi': st.fi = num || 0; continue;
        case 'sb': st.sb = num; continue; case 'sa': st.sa = num; continue;
        case 'sl': st.sl = num; continue; case 'slmult': st.slmult = num == null ? 1 : num; continue;
        case 'ls': st.ls = num; continue; case 'ilvl': st.ilvl = num || 0; continue;
        case 's': st.style = num; continue;
        case 'pagebb': st.pagebb = true; continue;
        case 'intbl': st.intbl = true; ensureTable(); continue;
        case 'par': case 'sect': endPara(); continue;
        case 'line': addText('\n', false); continue;
        case 'tab': addText('\t', false); continue;
        case 'emdash': addText('—', false); continue; case 'endash': addText('–', false); continue;
        case 'bullet': addText('•', false); continue; case 'lquote': addText('‘', false); continue; case 'rquote': addText('’', false); continue;
        case 'ldblquote': addText('“', false); continue; case 'rdblquote': addText('”', false); continue;
        case 'page': flushHex(); if (sink.cur && sink.cur.runs.length) endPara(); entries.push({ kind: 'pagebreak' }); continue;
        case 'u': {
          let code = num || 0; if (code < 0) code += 65536; flushHex(); addText(String.fromCharCode(code), true); skip = st.uc; continue;
        }
        // tablas
        case 'trowd': ensureTable(); if (sink.cur && !st.intbl && sink.cur.runs.length) endPara(); rowDef = { trhdr: false }; cellDefs = []; st.intbl = true; continue;
        case 'trhdr': if (rowDef) rowDef.trhdr = true; continue;
        case 'clmgf': curDef().h = 'first'; continue; case 'clmrg': curDef().h = 'cont'; continue;
        case 'clvmgf': curDef().v = 'first'; continue; case 'clvmrg': curDef().v = 'cont'; continue;
        case 'clcbpat': curDef().fill = num; continue;
        case 'cellx': { const d = curDef(); d.x = num; if (rowDef) { cellDefs.push(d); rowDef.pending = null; } continue; }
        case 'cell': endCell(); continue;
        case 'row': endRow(); continue;
        default: continue;
      }
    }
    flushHex(); if (sink.cur) endPara(); closeTable();

    const blocks = entriesToBlocks(entries, {
      colors, defFontName: defFont != null ? fonts[defFont] || null : null,
      styleName: (n) => styles[n] || null,
      listKind: (props) => {
        if (props.pnb) return props.pnb === 'bullet' ? 'bullet' : 'num';
        if (props.ls == null || props.ls < 0) return null;
        const lid = listOver[props.ls]; if (lid == null && listDefs[lid] === undefined) return null;
        const nfc = listDefs[lid] != null ? listDefs[lid] : 23;
        return nfc !== 23 && nfc !== 255 ? 'num' : 'bullet';
      }
    });
    if (sawSup) warnings.push('el documento tiene texto elevado/descendido con \\up/\\dn; se muestra en línea con el resto');
    if (page.width && page.height) { /* tamaño y márgenes */ if (page.marginLeft != null) page.margin = page.marginTop != null ? page.marginTop : page.marginLeft; }
    return { blocks, page: Object.keys(page).length ? page : undefined, meta, title: meta.title || '', warnings };
  }

  /** Entradas (párrafos, tablas, imágenes, saltos) → bloques del modelo. Compartido con el lector de .doc binario. */
  function entriesToBlocks(entries, env) {
    const bodySize = (() => { const w = new Map(); for (const e of entries) if (e.kind === 'para') for (const r of e.p.runs) { const s = r.size == null ? 0 : r.size; w.set(s, (w.get(s) || 0) + r.text.length); } let best = -1; let sz = 0; for (const [s, c] of w) if (c > best) { best = c; sz = s; } return sz; })();
    const defFontName = env.defFontName || null;
    const toRuns = (runs) => runs.map((r) => {
      const o = { text: r.text };
      if (r.bold) o.bold = true; if (r.italic) o.italic = true; if (r.underline) o.underline = true; if (r.strike) o.strike = true; if (r.vert) o.vert = r.vert;
      if (r.color) o.color = r.color; if (r.highlight) o.highlight = r.highlight;
      if (r.font && r.font !== defFontName) o.font = r.font;
      if (r.size != null && r.size !== bodySize) o.size = r.size;
      if (r.link) o.link = r.link; if (r.note) o.note = r.note;
      return o;
    }).filter((r) => r.text.length);
    const isPlain = (r) => !r.bold && !r.italic && !r.underline && !r.strike && !r.vert && !r.color && !r.highlight && !r.font && !r.link && !r.note && (r.size === undefined);
    const headingLevelOf = (p, nonSpace) => {
      const nm = p.props.style != null ? env.styleName(p.props.style) : null;
      if (nm) { const m = /^(?:heading|t[ií]tulo)\s*(\d)/i.exec(nm); if (m) return Math.min(3, Math.max(1, +m[1])); if (/^title$|^t[ií]tulo$/i.test(nm)) return 1; }
      return 0;
    };
    const sizes = []; for (const e of entries) if (e.kind === 'para') { const ns = e.p.runs.filter((r) => r.text.trim()); if (ns.length && ns.every((r) => r.bold) && ns.map((r) => r.text).join('').trim().length <= 160 && bodySize) { const mx = Math.max(...ns.map((r) => r.size || 0)); if (mx >= bodySize + 3 && !sizes.includes(mx)) sizes.push(mx); } }
    sizes.sort((a, b) => b - a);

    const blocks = []; let emptyRun = 0;
    const applyProps = (b, pr) => {
      if (pr.align && pr.align !== 'left') b.align = pr.align;
      if (pr.fi > 0) b.firstLine = Math.round(pr.fi / 20 * 2) / 2; else if (pr.fi < 0) b.hanging = Math.round(-pr.fi / 20 * 2) / 2;
      if (pr.sb) b.spaceBefore = Math.min(72, Math.round(pr.sb / 20 * 2) / 2);
      if (pr.sa) b.spaceAfter = Math.min(72, Math.round(pr.sa / 20 * 2) / 2);
      if (pr.sl && pr.slmult) b.lineHeight = Math.min(3, Math.max(0.8, Math.round(pr.sl / 240 * 100) / 100));
      return b;
    };
    let list = null; const flushList = () => { if (list) { blocks.push(list); list = null; } };
    for (const e of entries) {
      if (e.kind === 'pagebreak') { flushList(); blocks.push({ type: 'pagebreak' }); continue; }
      if (e.kind === 'image') { flushList(); const b = { type: 'image', src: e.src }; if (e.width) b.width = e.width; if (e.height) b.height = e.height; blocks.push(b); continue; }
      if (e.kind === 'table') { flushList(); blocks.push(tableBlock(e.t, env.colors || [])); continue; }
      const p = e.p; const props = p.props || {}; const runs = p.runs.filter((r) => r.text !== '');
      const text = runs.map((r) => r.text).join('');
      if (props.pagebb) { flushList(); blocks.push({ type: 'pagebreak' }); }
      const kind = env.listKind(props);
      if (kind && text.trim()) {
        const ordered = kind === 'num';
        if (!list || list.ordered !== ordered) { flushList(); list = { type: 'list', ordered, items: [], itemRuns: [], itemLevels: [] }; }
        list.items.push(text.trim()); const rr = toRuns(runs); list.itemRuns.push(rr.some((r) => !isPlain(r)) ? rr : null); list.itemLevels.push(Math.min(2, props.ilvl || 0));
        continue;
      }
      flushList();
      if (!text.trim()) { if (emptyRun++ < 3) blocks.push({ type: 'paragraph', text: '' }); continue; }
      emptyRun = 0;
      const ns = runs.filter((r) => r.text.trim());
      const lvlByStyle = headingLevelOf(p, ns);
      const allBold = ns.length && ns.every((r) => r.bold); const mx = Math.max(0, ...ns.map((r) => r.size || 0));
      let level = lvlByStyle;
      if (!level && allBold && text.trim().length <= 160 && bodySize && mx >= bodySize + 3) level = Math.min(3, Math.max(1, sizes.indexOf(mx) + 1));
      const rr = toRuns(runs); const plain = rr.every(isPlain);
      if (level) { const h = { type: 'heading', level, text: text.replace(/[ \t]+$/, '') }; const col = ns[0].color; if (col && ns.every((r) => r.color === col)) h.color = col; blocks.push(applyProps(h, props)); continue; }
      const sizeOnly = !plain && rr.every((r) => Object.keys(r).every((k) => k === 'text' || k === 'size') && r.size === rr[0].size);
      if (sizeOnly) { blocks.push(applyProps({ type: 'paragraph', text: text.replace(/[ \t]+$/, ''), size: rr[0].size }, props)); continue; }
      blocks.push(applyProps(plain ? { type: 'paragraph', text: text.replace(/[ \t]+$/, '') } : { type: 'paragraph', runs: rr }, props));
    }
    flushList();
    while (blocks.length && blocks[blocks.length - 1].type === 'paragraph' && blocks[blocks.length - 1].text === '') blocks.pop();
    return blocks;
  }

  function tableBlock(t, colors) {
    // Rejilla común: todas las posiciones \cellx de todas las filas. Una celda que cubre varias columnas
    // de la rejilla (celda combinada que Word/LibreOffice escriben como UNA celda ancha) se expande.
    const xs = new Set(); let allX = true;
    for (const row of t.rows) for (const c of row.cells) { if (c.def && c.def.x) xs.add(c.def.x); else allX = false; }
    const grid = allX ? [...xs].sort((p, q) => p - q) : null;
    const rowsG = t.rows.map((row) => {
      if (!grid) return row.cells.map((c) => ({ cell: c, span: 1 }));
      const out = []; let prev = 0;
      for (const c of row.cells) { const end = grid.indexOf(c.def.x); const from = grid.findIndex((g) => g > prev); const span = Math.max(1, end - from + 1); out.push({ cell: c, span }); prev = c.def.x; }
      return out;
    });
    const rows = []; const cellRuns = {}; const cellFill = {}; const merges = []; const grids = [];
    rowsG.forEach((row, r) => {
      const texts = []; const cells = [];
      row.forEach(({ cell, span }) => {
        const c = texts.length; const text = cell.runs.map((x) => x.text).join('');
        if (cell.runs.some((x) => x.bold || x.italic || x.underline || x.strike || x.vert || x.color || x.highlight || x.font || x.link)) cellRuns[r + ',' + c] = cell.runs.map((x) => { const o = { text: x.text }; if (x.bold) o.bold = true; if (x.italic) o.italic = true; if (x.underline) o.underline = true; if (x.strike) o.strike = true; if (x.vert) o.vert = x.vert; if (x.color) o.color = x.color; if (x.highlight) o.highlight = x.highlight; if (x.font) o.font = x.font; if (x.link) o.link = x.link; return o; });
        const d = cell.def; const fc = d && (d.fillHex || (d.fill && colors[d.fill])); if (fc) cellFill[r + ',' + c] = fc;
        texts.push(text); cells.push(cell);
        if (span > 1) { merges.push({ r, c, rows: 1, cols: span }); for (let k = 1; k < span; k++) { texts.push(''); cells.push({ runs: [], def: {} }); } }
      });
      rows.push(texts); grids.push(cells);
    });
    // combinadas con \clmgf/\clmrg y \clvmgf/\clvmrg (una celda por columna de la rejilla)
    grids.forEach((cells, r) => cells.forEach((cell, c) => {
      const d = cell.def || {}; let cols = 1; let nrows = 1;
      if (d.h === 'first') { let k = c + 1; while (cells[k] && cells[k].def && cells[k].def.h === 'cont') { cols++; k++; } }
      if (d.v === 'first') { let k = r + 1; while (grids[k] && grids[k][c] && grids[k][c].def && grids[k][c].def.v === 'cont') { nrows++; k++; } }
      if (cols > 1 || nrows > 1) { const m = merges.find((x) => x.r === r && x.c === c); if (m) { m.rows = Math.max(m.rows, nrows); m.cols = Math.max(m.cols, cols); } else merges.push({ r, c, rows: nrows, cols }); }
    }));
    const out = { type: 'table', rows, header: !!t.header };
    if (merges.length) out.merges = merges;
    if (Object.keys(cellRuns).length) out.cellRuns = cellRuns;
    if (Object.keys(cellFill).length) out.cellFill = cellFill;
    if (grid && rows.every((x) => x.length === grid.length)) { const w = []; let prev = 0; for (const x of grid) { w.push(Math.max(1, x - prev)); prev = x; } out.colWidths = w; }
    return out;
  }

  // \listtable: {\list ... {\listlevel\levelnfc23 ...} ... \listid1001 }
  function parseLists(src, from, out) {
    let depth = 0; let k = from; let end = src.length;
    for (; k < src.length; k++) { if (src[k] === '{') depth++; else if (src[k] === '}') { if (depth === 0) { end = k; break; } depth--; } }
    const body = src.slice(from, end);
    const re = /\\list\b[\s\S]*?\\listid(-?\d+)/g; let m;
    // cada \list: el primer \levelnfc es el del nivel 0
    const parts = body.split(/\{\\list(?![a-z])/).slice(1);
    for (const p of parts) { const id = /\\listid(-?\d+)/.exec(p); const nfc = /\\levelnfc(\d+)/.exec(p); if (id) out[id[1]] = nfc ? +nfc[1] : 0; }
    void re; void m;
  }
  function parseOverrides(src, from, out) {
    let depth = 0; let end = src.length;
    for (let k = from; k < src.length; k++) { if (src[k] === '{') depth++; else if (src[k] === '}') { if (depth === 0) { end = k; break; } depth--; } }
    const body = src.slice(from, end);
    for (const p of body.split(/\{\\listoverride(?![a-z])/).slice(1)) { const id = /\\listid(-?\d+)/.exec(p); const ls = /\\ls(\d+)/.exec(p); if (id && ls) out[ls[1]] = id[1]; }
  }

  return { readRtf, entriesToBlocks, tableBlock };
});

'use strict';
/**
 * document-editor / core/doc-binary.js — Word 97-2003 (.doc binario) → bloques del modelo, con formato.
 *
 * Antes el .doc se leía solo como texto plano (cada párrafo suelto, sin formato, tablas partidas celda por celda,
 * sin viñetas ni imágenes). Aquí se leen, además del texto (tabla de piezas):
 *   · formato por tramo (CHPX): negrita, cursiva, subrayado, tachado, tamaño, color, resaltado, fuente, oculto
 *   · formato de párrafo (PAPX): alineación, sangría de primera línea, espacios, interlineado, salto de página antes
 *   · estilos (STSH): títulos 1-3 por el tipo estándar del estilo
 *   · listas (PlfLst/PlfLfo): viñetas y numeradas
 *   · tablas (marcas de celda/fila + TDefTable): anchos, celdas combinadas, relleno
 *   · imágenes PNG/JPEG de OfficeArt (flujo Data), hipervínculos (campos HYPERLINK), notas al pie
 *   · encabezado y pie (primer sección), tamaño y márgenes de página
 * Si algo falla, quien llama cae al texto plano de siempre. UMD puro.
 */
(function (root, factory) {
  const rtf = (typeof require === 'function' && typeof module === 'object') ? require('./rtf-read.js') : (root.MCDoc && root.MCDoc.rtfRead);
  const mod = factory(rtf);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else { root.MCDoc = root.MCDoc || {}; root.MCDoc.docBinary = mod; }
})(typeof self !== 'undefined' ? self : this, function (rtf) {
  const u16 = (b, o) => (b[o] | (b[o + 1] << 8)) >>> 0;
  const i16 = (b, o) => { const v = u16(b, o); return v & 0x8000 ? v - 0x10000 : v; };
  const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const ICO = [null, '#000000', '#0000FF', '#00FFFF', '#00FF00', '#FF00FF', '#FF0000', '#FFFF00', '#FFFFFF', '#000080', '#008080', '#008000', '#800080', '#800000', '#808000', '#808080', '#C0C0C0'];
  const hex = (n) => n.toString(16).padStart(2, '0');
  const rgb = (b, o) => '#' + hex(b[o]) + hex(b[o + 1]) + hex(b[o + 2]);

  // ── sprms ──────────────────────────────────────────────────────────────
  function sprms(buf) {
    const out = []; let p = 0;
    while (p + 2 <= buf.length) {
      const op = u16(buf, p); const spra = op >> 13; p += 2; let len;
      if (spra === 0 || spra === 1) len = 1; else if (spra === 2 || spra === 4 || spra === 5) len = 2; else if (spra === 3) len = 4; else if (spra === 7) len = 3;
      else { // variable
        if (op === 0xD608) { if (p + 2 > buf.length) break; len = u16(buf, p) + 1; } else { if (p >= buf.length) break; len = buf[p] + 1; if (op === 0xC615 && buf[p] === 255) len = 1; }
      }
      if (p + len > buf.length) break;
      out.push({ op, v: buf.subarray(p, p + len) }); p += len;
    }
    return out;
  }
  const flag = (v) => v[0] === 1 || v[0] === 0x81;

  function readDocBinary(wd, table, data, h) {
    const warnings = [];
    const flagsw = u16(wd, 0x0A);
    const csw = u16(wd, 32); let p = 34 + csw * 2; const cslw = u16(wd, p); const lwBase = p + 2; p = lwBase + cslw * 4; const cb = u16(wd, p); const pb = p + 2;
    const pair = (k) => (k < cb ? { fc: u32(wd, pb + k * 8), lcb: u32(wd, pb + k * 8 + 4) } : { fc: 0, lcb: 0 });
    const ccp = (k) => u32(wd, lwBase + k * 4);
    const ccpText = ccp(3); const ccpFtn = ccp(4);
    if (!ccpText) return null;

    // piezas
    const clx = pair(33); let q = clx.fc; const end = Math.min(clx.fc + clx.lcb, table.length);
    while (q + 3 <= end && table[q] === 0x01) q += 3 + u16(table, q + 1);
    if (table[q] !== 0x02) return null;
    const plcLen = u32(table, q + 1); const plc = q + 5; const np = Math.floor((plcLen - 4) / 12); if (np <= 0) return null;
    const pieces = []; let totalCp = 0;
    for (let i = 0; i < np; i++) {
      const cp0 = u32(table, plc + i * 4), cp1 = u32(table, plc + (i + 1) * 4); const fcRaw = u32(table, plc + (np + 1) * 4 + i * 8 + 2);
      const comp = !!(fcRaw & 0x40000000); const fcByte = comp ? (fcRaw & 0x3FFFFFFF) >> 1 : (fcRaw & 0x3FFFFFFF);
      pieces.push({ cp0, cp1, fcByte, comp }); totalCp = Math.max(totalCp, cp1);
    }
    // texto completo (todas las historias) como cadena indexada por CP
    const chars = new Array(totalCp).fill('\u0000');
    for (const pc of pieces) {
      const n = pc.cp1 - pc.cp0; if (n <= 0) continue;
      const bytes = wd.subarray(pc.fcByte, pc.fcByte + n * (pc.comp ? 1 : 2));
      const s = pc.comp ? h.cp1252ToStr(bytes) : h.utf16leToStr(bytes);
      for (let k = 0; k < n && k < s.length; k++) chars[pc.cp0 + k] = s[k];
    }
    const text = chars.join('');
    const fcToCp = (fc) => { for (const pc of pieces) { const n = pc.cp1 - pc.cp0; const sz = pc.comp ? 1 : 2; if (fc >= pc.fcByte && fc <= pc.fcByte + n * sz) return pc.cp0 + Math.floor((fc - pc.fcByte) / sz); } return -1; };

    // FKP de formato de carácter y de párrafo
    const bte = (pr) => { const out = []; if (!pr.lcb) return out; const n = Math.floor((pr.lcb - 4) / 8); for (let i = 0; i < n; i++) out.push(u32(table, pr.fc + (n + 1) * 4 + i * 4)); return out; };
    const chpRuns = []; const papRuns = [];
    for (const pn of bte(pair(12))) {
      const pg = pn * 512; if (pg + 512 > wd.length) continue; const crun = wd[pg + 511];
      for (let i = 0; i < crun; i++) {
        const f0 = u32(wd, pg + i * 4), f1 = u32(wd, pg + (i + 1) * 4); const bx = wd[pg + (crun + 1) * 4 + i]; if (!bx) continue;
        const off = pg + bx * 2; const n = wd[off]; const c0 = fcToCp(f0), c1 = fcToCp(f1); if (c0 < 0 || c1 < 0) continue;
        chpRuns.push({ c0, c1, sp: sprms(wd.subarray(off + 1, off + 1 + n)) });
      }
    }
    for (const pn of bte(pair(13))) {
      const pg = pn * 512; if (pg + 512 > wd.length) continue; const crun = wd[pg + 511];
      for (let i = 0; i < crun; i++) {
        const f0 = u32(wd, pg + i * 4), f1 = u32(wd, pg + (i + 1) * 4); const bx = wd[pg + (crun + 1) * 4 + i * 13]; const c0 = fcToCp(f0), c1 = fcToCp(f1); if (c0 < 0 || c1 < 0) continue;
        let istd = 0; let sp = [];
        if (bx) { const off = pg + bx * 2; let n = wd[off]; let st; if (n === 0) { n = wd[off + 1] * 2; st = off + 2; } else { n = n * 2 - 1; st = off + 1; } if (n >= 2) { istd = u16(wd, st); sp = sprms(wd.subarray(st + 2, st + n)); } }
        papRuns.push({ c0, c1, istd, sp });
      }
    }
    chpRuns.sort((a, b) => a.c0 - b.c0); papRuns.sort((a, b) => a.c0 - b.c0);
    const find = (arr, cp) => { let lo = 0, hi = arr.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m].c1 <= cp) lo = m + 1; else if (arr[m].c0 > cp) hi = m - 1; else return arr[m]; } return null; };

    // fuentes
    const fonts = [];
    try {
      const ff = pair(15); if (ff.lcb) { let o = ff.fc + 4; const lim = ff.fc + ff.lcb; while (o < lim) { const sz = table[o]; if (sz === undefined) break; const nameAt = o + 1 + 39; let nm = ''; for (let k = nameAt; k + 1 < o + 1 + sz + 1 && k + 1 < table.length; k += 2) { const c = u16(table, k); if (!c) break; nm += String.fromCharCode(c); } fonts.push(nm); o += sz + 1; } }
    } catch { /* sin fuentes */ }
    // estilos: sti por istd
    const sti = [];
    try {
      const sh = pair(1); if (sh.lcb) {
        const cbS = u16(table, sh.fc); const cstd = u16(table, sh.fc + 2); const cbBase = u16(table, sh.fc + 4); let o = sh.fc + 2 + cbS;
        for (let i = 0; i < cstd; i++) { const n = u16(table, o); o += 2; if (n) { const s0 = u16(table, o) & 0x0FFF; let nm = ''; const nc = u16(table, o + cbBase); for (let k = 0; k < nc; k++) nm += String.fromCharCode(u16(table, o + cbBase + 2 + k * 2)); sti[i] = { sti: s0, name: nm }; } else sti[i] = null; o += n + (n & 1 ? 0 : 0); }
      }
    } catch { /* sin estilos */ }
    // listas
    const lstNfc = Object.create(null); const lfoLsid = [];
    try {
      const lst = pair(73); if (lst.lcb) {
        const cLst = i16(table, lst.fc); let o = lst.fc + 2; const heads = [];
        for (let i = 0; i < cLst; i++) { heads.push({ lsid: u32(table, o), simple: !!(table[o + 26] & 1) }); o += 28; }
        for (const hd of heads) { const nl = hd.simple ? 1 : 9; const lv = []; for (let l = 0; l < nl; l++) { lv.push(table[o + 4]); const cbCh = table[o + 24], cbPa = table[o + 25]; o += 28 + cbPa + cbCh; const nc = u16(table, o); o += 2 + nc * 2; } lstNfc[hd.lsid] = lv; }
      }
      const lfo = pair(74); if (lfo.lcb) { const n = u32(table, lfo.fc); for (let i = 0; i < n; i++) lfoLsid.push(u32(table, lfo.fc + 4 + i * 16)); }
    } catch { /* sin listas */ }
    const listKind = (props) => {
      if (!props.ilfo) return null; const lsid = lfoLsid[props.ilfo - 1]; const lv = lstNfc[lsid]; if (!lv) return 'bullet';
      const nfc = lv[Math.min(props.ilvl || 0, lv.length - 1)]; return nfc === 23 || nfc === 255 ? 'bullet' : 'num';
    };
    // notas al pie
    const notes = new Map();
    try {
      const fr = pair(2), ft = pair(3);
      if (fr.lcb && ft.lcb) { const n = Math.floor((fr.lcb - 4) / 6); for (let i = 0; i < n; i++) { const refCp = u32(table, fr.fc + i * 4); const t0 = u32(table, ft.fc + i * 4), t1 = u32(table, ft.fc + (i + 1) * 4); notes.set(refCp, text.slice(ccpText + t0, ccpText + t1).replace(/[\u0000-\u0008\u000B-\u001F]/g, '').replace(/\r/g, ' ').trim()); } }
    } catch { /* sin notas */ }
    // página (primera sección) y encabezado/pie
    const page = {};
    try {
      const sed = pair(6); if (sed.lcb) { const nSec = Math.floor((sed.lcb - 4) / 16); const fcSepx = i32(wd, 0, table, sed.fc + (nSec + 1) * 4 + 2); if (fcSepx > 0 && fcSepx + 2 < wd.length) { const nn = u16(wd, fcSepx); for (const s of sprms(wd.subarray(fcSepx + 2, fcSepx + 2 + nn))) {
        if (s.op === 0xB01F) page.width = u16(s.v, 0) / 20; else if (s.op === 0xB020) page.height = u16(s.v, 0) / 20; else if (s.op === 0xB021) page.marginLeft = u16(s.v, 0) / 20; else if (s.op === 0xB022) page.marginRight = u16(s.v, 0) / 20;
        else if (s.op === 0x9023) page.marginTop = i16(s.v, 0) / 20; else if (s.op === 0x9024) page.marginBottom = i16(s.v, 0) / 20; else if (s.op === 0x301D && s.v[0] === 2) page.orientation = 'landscape'; else if (s.op === 0x500B && u16(s.v, 0) >= 1) page.columns = Math.min(3, u16(s.v, 0) + 1);
      } } }
      const hd = pair(11); if (hd.lcb && ccpFtn >= 0) {
        const n = Math.floor(hd.lcb / 4) - 1; const base = ccpText + ccpFtn; const story = (k) => { if (k + 1 > n) return ''; const a = u32(table, hd.fc + k * 4), b = u32(table, hd.fc + (k + 1) * 4); return text.slice(base + a, base + b).replace(/\u0013[^\u0014\u0015]*\u0014?/g, '').replace(/[\u0000-\u0008\u000B-\u001F]/g, ' ').replace(/\s+/g, ' ').trim(); };
        const hh = story(7) || story(10); const ff2 = story(9) || story(11); if (hh) page.header = hh; if (ff2) page.footer = ff2;
      }
    } catch { /* página por defecto */ }
    if (page.width && page.marginTop != null) page.margin = page.marginTop;

    // ── recorrido del texto principal ──
    const entries = []; const imgs = []; let tbl = null; let rowCells = []; let cellRuns = null; let sawSup = false;
    const fieldStack = []; let curLink = null;
    const bodyCp = ccpText;
    const colorOf = (sp) => { let c = null; for (const s of sp) { if (s.op === 0x2A42 && s.v[0] >= 1 && s.v[0] <= 16) c = ICO[s.v[0]]; else if (s.op === 0x6870 && s.v[3] !== 0xFF) c = rgb(s.v, 0); } return c; };
    const readPic = (loc) => {
      if (!data || loc + 68 > data.length) return null; const lcb = u32(data, loc); const cbH = u16(data, loc + 4); const dxa = i16(data, loc + 28), dya = i16(data, loc + 30); const mx = u16(data, loc + 32), my = u16(data, loc + 34);
      let o = loc + cbH; const lim = Math.min(data.length, loc + lcb);
      const scan = (from, to) => {
        let a = from;
        while (a + 8 <= to) {
          const verInst = u16(data, a), type = u16(data, a + 2), len = u32(data, a + 4); const ver = verInst & 0xF, inst = verInst >> 4;
          if (ver === 0xF) { const r = scan(a + 8, Math.min(to, a + 8 + len)); if (r) return r; }
          else if (type === 0xF01E || type === 0xF01D || type === 0xF02A) {
            let d = a + 8 + 16; const two = (type === 0xF01E && inst === 0x6E1) || (type !== 0xF01E && (inst === 0x46B || inst === 0x6E3)); if (two) d += 16; d += 1;
            const png = type === 0xF01E; return { mime: png ? 'png' : 'jpeg', bytes: data.subarray(d, a + 8 + len) };
          } else if (type === 0xF004 || type === 0xF000 || type === 0xF003) { /* contenedor ya recorrido */ }
          else if (type === 0xF007) { /* BSE: dentro viene el blip tras 36 bytes */ const r = scan(a + 8 + 36, Math.min(to, a + 8 + len)); if (r) return r; }
          a += 8 + len;
        }
        return null;
      };
      const r = scan(o, lim); if (!r || !r.bytes.length) return null;
      const w = dxa > 0 ? Math.round(dxa * (mx || 1000) / 1000 / 15) : null; const hh = dya > 0 ? Math.round(dya * (my || 1000) / 1000 / 15) : null;
      return { src: `data:image/${r.mime};base64,${Buffer.from(r.bytes).toString('base64')}`, width: w, height: hh };
    };
    function chpProps(cp) {
      const r = find(chpRuns, cp); const o = { b: false, i: false, ul: false, strike: false, vert: null, size: null, color: null, hl: null, font: null, spec: false, pic: null, vanish: false };
      if (!r) return o;
      for (const s of r.sp) {
        switch (s.op) {
          case 0x0835: o.b = flag(s.v); break; case 0x0836: o.i = flag(s.v); break; case 0x0837: o.strike = flag(s.v); break;
          case 0x2A3E: o.ul = s.v[0] !== 0; break; case 0x4A43: o.size = Math.round(u16(s.v, 0) / 2); break;
          case 0x2A0C: o.hl = ICO[s.v[0]] || null; break; case 0x4A4F: o.font = fonts[u16(s.v, 0)] || null; break;
          case 0x0855: o.spec = flag(s.v); break; case 0x6A03: o.pic = u32(s.v, 0); break; case 0x083C: o.vanish = flag(s.v); break;
          case 0x2A48: o.vert = s.v[0] === 1 ? 'sup' : s.v[0] === 2 ? 'sub' : null; break; default: break;
        }
      }
      o.color = colorOf(r.sp); return o;
    }
    function papProps(cp) {
      const r = find(papRuns, cp); const o = { style: 0, align: null, fi: 0, sb: null, sa: null, sl: null, slmult: 0, ilfo: 0, ilvl: 0, intbl: false, ttp: false, pagebb: false, tdef: null, shd: null };
      if (!r) return o; o.style = r.istd;
      for (const s of r.sp) {
        switch (s.op) {
          case 0x2461: case 0x2403: o.align = ['left', 'center', 'right', 'justify', 'justify'][s.v[0]] || null; break;
          case 0x2416: o.intbl = s.v[0] === 1; break; case 0x2417: o.ttp = s.v[0] === 1; break;
          case 0x460B: o.ilfo = u16(s.v, 0); break; case 0x260A: o.ilvl = s.v[0]; break; case 0x2407: o.pagebb = s.v[0] === 1; break;
          case 0x8411: case 0x8460: o.fi = i16(s.v, 0); break;
          case 0xA413: o.sb = u16(s.v, 0); break; case 0xA414: o.sa = u16(s.v, 0); break;
          case 0x6412: o.sl = i16(s.v, 0); o.slmult = u16(s.v, 2); break;
          case 0xD608: o.tdef = s.v; break;
          case 0xD609: case 0xD612: case 0xD62C: if (!o.shd || s.op === 0xD612) o.shd = { op: s.op, v: s.v }; break;
          default: break;
        }
      }
      return o;
    }
    function parseTdef(v) {
      const n = v[2]; if (!n || 3 + (n + 1) * 2 + n * 20 > v.length + 1) return null;
      const xs = []; for (let i = 0; i <= n; i++) xs.push(i16(v, 3 + i * 2)); const tcs = []; let o = 3 + (n + 1) * 2;
      for (let i = 0; i < n; i++) { const g = u16(v, o); tcs.push({ h: g & 3, v: (g >> 5) & 3 }); o += 20; }
      return { n, xs, tcs };
    }
    function shadeColors(shd, n) {
      if (!shd) return [];
      const out = []; const v = shd.v;
      if (shd.op === 0xD609) { const cnt = (v[0]) / 2; for (let i = 0; i < Math.min(n, cnt); i++) { const w = u16(v, 1 + i * 2); const back = (w >> 5) & 0x1F; const pat = w >> 10; out.push(back && pat ? ICO[back] : null); } }
      else if (shd.op === 0xD612 || shd.op === 0xD62C) { const cnt = Math.floor((v[0]) / 10); for (let i = 0; i < Math.min(n, cnt); i++) { const o = 1 + i * 10; const back = v[o + 7] !== 0xFF ? rgb(v, o + 4) : null; out.push(back && back !== '#FFFFFF' ? back : null); } }
      return out;
    }

    let runs = []; let pStart = 0; let blockRuns = runs;
    const pushRun = (txt, c) => {
      if (!txt) return; const last = blockRuns[blockRuns.length - 1];
      const run = { text: txt, bold: c.b, italic: c.i, underline: c.ul, strike: c.strike, vert: c.vert, size: c.size, color: c.color, highlight: c.hl, font: c.font, link: curLink };
      if (last && !last.note && ['bold', 'italic', 'underline', 'strike', 'vert', 'size', 'color', 'highlight', 'font', 'link'].every((k) => last[k] === run[k])) last.text += txt; else blockRuns.push(run);
    };
    let ps = 0;
    for (let cp = 0; cp < bodyCp; cp++) {
      const ch = text[cp];
      const code = ch.charCodeAt(0);
      if (code === 0x0D || code === 0x07) {
        const pp = papProps(cp);
        const isCell = code === 0x07 && pp.intbl;
        if (pp.ttp && code === 0x07) { // fin de fila
          const td = pp.tdef ? parseTdef(pp.tdef) : null; const fills = td ? shadeColors(pp.shd, td.n) : [];
          if (!tbl) tbl = { rows: [], header: false };
          const cells = rowCells.map((rc, i) => ({ runs: rc, def: td ? { x: td.xs[i + 1] * 1, h: td.tcs[i] && td.tcs[i].h === 1 ? 'first' : td.tcs[i] && td.tcs[i].h === 2 ? 'cont' : null, v: td.tcs[i] && td.tcs[i].v === 2 ? 'first' : td.tcs[i] && td.tcs[i].v === 1 ? 'cont' : null, fillHex: fills[i] || null } : { x: (i + 1) * 1000 } }));
          if (td) { /* posiciones relativas: se normalizan al ancho */ const x0 = td.xs[0]; cells.forEach((c, i) => { c.def.x = td.xs[i + 1] - x0; }); }
          tbl.rows.push({ cells, trhdr: false }); rowCells = []; blockRuns = runs = []; ps = cp + 1; continue;
        }
        if (isCell) {
          rowCells.push(blockRuns.filter((r) => r.text !== '\u0001').map((r) => r)); blockRuns = runs = []; ps = cp + 1; if (!tbl) tbl = { rows: [], header: false }; continue;
        }
        if (pp.intbl) { // otro párrafo dentro de la misma celda
          if (blockRuns.length) blockRuns.push({ text: '\n', bold: false, italic: false, underline: false, strike: false, size: null, color: null, highlight: null, font: null, link: null });
          ps = cp + 1; continue;
        }
        if (tbl) { entries.push({ kind: 'table', t: tbl }); tbl = null; rowCells = []; }
        const props = { align: pp.align, li: 0, fi: pp.fi, sb: pp.sb, sa: pp.sa, sl: pp.sl, slmult: pp.slmult, ls: null, ilvl: pp.ilvl, ilfo: pp.ilfo, intbl: false, pagebb: pp.pagebb, style: pp.style };
        entries.push({ kind: 'para', p: { runs, props } }); blockRuns = runs = []; ps = cp + 1; continue;
      }
      if (code === 0x13) { fieldStack.push({ instr: '', phase: 'i' }); continue; }
      if (code === 0x14) { const f = fieldStack[fieldStack.length - 1]; if (f) { f.phase = 'r'; const m = /HYPERLINK\s+"([^"]+)"/i.exec(f.instr); f.link = m ? m[1] : null; if (f.link) curLink = f.link; } continue; }
      if (code === 0x15) { const f = fieldStack.pop(); if (f && f.link) curLink = null; continue; }
      const f = fieldStack[fieldStack.length - 1];
      if (f && f.phase === 'i') { f.instr += ch; continue; }
      if (tbl && rowCells.length === 0 && !blockRuns.length && !papProps(cp).intbl) { entries.push({ kind: 'table', t: tbl }); tbl = null; }
      const c = chpProps(cp);
      if (c.vanish) continue;
      if (code === 0x01 && c.spec && c.pic != null) { const im = readPic(c.pic); if (im) { if (!tbl && blockRuns.length) { /* imagen en medio de párrafo: se corta el párrafo */ entries.push({ kind: 'para', p: { runs, props: { ilvl: 0, style: 0 } } }); blockRuns = runs = []; } if (!tbl) entries.push({ kind: 'image', src: im.src, width: im.width, height: im.height }); else warnings.push('una imagen dentro de una tabla se omitió'); } continue; }
      if (code === 0x02) { const nt = notes.get(cp); if (nt) { const last = blockRuns[blockRuns.length - 1]; if (last && !last.note) last.note = nt; else blockRuns.push({ text: '​', bold: false, italic: false, underline: false, strike: false, size: null, color: null, highlight: null, font: null, link: null, note: nt }); } continue; }
      if (code === 0x0B) { pushRun('\n', c); continue; }
      if (code === 0x0C) { if (blockRuns.length) { entries.push({ kind: 'para', p: { runs, props: { ilvl: 0, style: 0 } } }); blockRuns = runs = []; } entries.push({ kind: 'pagebreak' }); continue; }
      if (code === 0x1E) { pushRun('-', c); continue; } if (code === 0x1F) continue; if (code === 0x09) { pushRun('\t', c); continue; }
      if (code < 0x20 || code === 0x00) continue;
      pushRun(ch, c);
    }
    if (blockRuns.length) entries.push({ kind: 'para', p: { runs, props: { ilvl: 0, style: 0 } } });
    if (tbl) entries.push({ kind: 'table', t: tbl });
    void ps; void pStart; void imgs;

    const blocks = rtf.entriesToBlocks(entries, {
      colors: [], defFontName: null,
      styleName: (n) => { const s = sti[n]; if (!s) return null; if (s.sti >= 1 && s.sti <= 9) return 'heading ' + s.sti; if (s.sti === 62 || /^(title|t[ií]tulo)$/i.test(s.name)) return 'title'; return s.name; },
      listKind: (props) => listKind(props)
    });
    return { blocks, page: Object.keys(page).length ? page : undefined, warnings };
  }
  // fcSepx del primer Sed: entero con signo de 32 bits en la tabla (offset 2 del Sed)
  function i32(wd, _z, table, o) { return (table[o] | (table[o + 1] << 8) | (table[o + 2] << 16) | (table[o + 3] << 24)) | 0; }

  return { readDocBinary, _sprms: sprms };
});

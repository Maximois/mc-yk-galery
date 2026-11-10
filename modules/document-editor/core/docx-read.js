'use strict';
const CALLOUT_FILLS = { info: 'EAF2FF', warn: 'FFF6DD', ok: 'E7F7EC', error: 'FDECEC' };
/**
 * MC Browser -- modulo document-editor / core/docx-read.js
 *
 * .docx -> modelo. Lectura de WordprocessingML con el parser propio (xml.js)
 * porque este archivo corre en el proceso main, en un worker, y en el
 * renderer, y `DOMParser` solo existe en el ultimo.
 *
 * Que se conserva: texto, titulos, listas (con su numeracion real), citas,
 * tablas, alineacion, negrita/cursiva/subrayado, color y tamano de caracter,
 * imagenes embebidas y saltos de pagina, mas los metadatos de docProps.
 *
 * Que NO se conserva, y es importante decirlo: estilos por nombre
 * (WordHeading2Custom), secciones multiples, columnas, notas al pie,
 * referencias, campos, control de cambios, formulas y objetos incrustados.
 * El round-trip es "contenido y formato basico", no "identico". Un .docx
 * guardado por este modulo es un documento nuevo, no una edicion del
 * original: por eso el exportador nunca sobrescribe el archivo del usuario
 * sin guardar una copia antes (ver modules/document-editor/main.js).
 */

(function (root, factory) {
  const mod = factory({
    model: (typeof require === 'function' && typeof module === 'object') ? require('./model.js') : (root.MCDoc && root.MCDoc.model),
    xml: (typeof require === 'function' && typeof module === 'object') ? require('./xml.js') : (root.MCDoc && root.MCDoc.xml),
    zip: (typeof require === 'function' && typeof module === 'object') ? require('./zip.js') : (root.MCDoc && root.MCDoc.zip)
  });
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (typeof window !== 'undefined') {
    window.MCDoc = window.MCDoc || {};
    window.MCDoc.docxRead = mod;
  }
})(this, function (deps) {
  const model = deps.model;
  const xml = deps.xml;
  const zip = deps.zip;

  // Elementos cuyo texto nunca es parte del contenido visible.
  const SKIP_TEXT = new Set([
    'instrText', 'delText', 'proofErr', 'bookmarkStart', 'bookmarkEnd',
    'commentReference', 'commentRangeStart', 'commentRangeEnd', 'footnoteReference',
    'endnoteReference', 'del', 'moveFrom', 'lastRenderedPageBreak', 'fldChar',
    'rPrChange', 'pPrChange', 'tblPrChange', 'trPrChange', 'tcPrChange', 'sectPrChange'
  ]);

  const MIME_BY_EXT = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    bmp: 'image/bmp', tiff: 'image/tiff', emf: 'image/x-emf', wmf: 'image/x-wmf',
    webp: 'image/webp', svg: 'image/svg+xml'
  };

  // ------------------------------------------------------- relaciones/media

  function parseRels(entries) {
    const out = Object.create(null);
    const raw = entries['word/_rels/document.xml.rels'];
    if (!raw) return out;
    let tree;
    try { tree = xml.parse(zip.toStr(raw)); } catch { return out; }
    for (const rel of xml.findAll(tree, 'Relationship')) {
      const id = xml.attr(rel, 'Id');
      const target = xml.attr(rel, 'Target');
      if (id) out[id] = target;
    }
    return out;
  }

  // Encabezado/pie: texto de sus parrafos (sin el campo PAGE) y, si el campo
  // PAGE esta, la alineacion del parrafo que lo lleva.
  function tokenText(p) {
    let out = '';
    let skipping = false;
    const fieldToken = (instr) => (/\bNUMPAGES\b/.test(instr) ? '{total}' : /\bPAGE\b/.test(instr) ? '{n}' : '');
    const walk = (node) => {
      for (const c of node.children || []) {
        if (!xml.isElement(c)) continue;
        if (c.local === 'fldSimple') { out += fieldToken(xml.attr(c, 'instr') || ''); continue; }
        if (c.local === 'fldChar') {
          const t = xml.attr(c, 'fldCharType');
          if (t === 'end') skipping = false;
          continue;
        }
        if (c.local === 'instrText') { const tk = fieldToken(xml.textOf(c)); if (tk) { out += tk; skipping = true; } continue; }
        if (c.local === 't') { if (!skipping) out += xml.textOf(c); continue; }
        if (c.local === 'pPr' || c.local === 'rPr') continue;
        walk(c);
      }
    };
    walk(p);
    return out;
  }

  function headerFooterOf(entries, rels, rid) {
    const target = rels && rels[rid];
    if (!target) return null;
    const name = 'word/' + String(target).replace(/^\.\.\//, '').replace(/^\//, '').replace(/^word\//, '');
    const raw = entries[name];
    if (!raw) return null;
    let tree;
    try { tree = xml.parse(zip.toStr(raw)); } catch { return null; }
    const texts = [];
    let pageAlign = null;
    for (const p of xml.findAll(tree, 'p')) {
      const hasPage = xml.findAll(p, 'fldSimple').some(f => /\bPAGE\b/.test(xml.attr(f, 'instr') || '')) ||
        xml.findAll(p, 'instrText').some(i => /\bPAGE\b/.test(xml.textOf(i)));
      const jc = xml.attr(xml.find(xml.find(p, 'pPr') || p, 'jc'), 'val');
      const align = jc === 'center' || jc === 'right' ? jc : 'left';
      // Texto con campos de pagina: se reconstruye con {n} / {total}.
      const tokened = tokenText(p);
      if (tokened && /\{(n|total)\}/.test(tokened) && tokened.replace(/\{(n|total)\}/g, '').trim()) { texts.push(tokened.replace(/\s+/g, ' ').trim()); continue; }
      if (hasPage) { pageAlign = pageAlign || align; continue; }
      const t = xml.textOf(p).replace(/\s+/g, ' ').trim();
      if (t) texts.push(t);
    }
    const wmm = /<v:textpath[^>]*\sstring="([^"]*)"/.exec(zip.toStr(raw));
    const watermark = wmm ? wmm[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : '';
    return { text: texts.join(' ').slice(0, 200), pageAlign, watermark };
  }

  function dataUrl(target, entries) {
    if (!target) return null;
    const clean = target.replace(/^\.\.\//, '').replace(/^\//, '');
    const name = clean.startsWith('word/') ? clean : `word/${clean}`;
    const data = entries[name];
    if (!data || !data.length) return null;
    const ext = (name.split('.').pop() || '').toLowerCase();
    const mime = MIME_BY_EXT[ext] || 'application/octet-stream';
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < data.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, data.subarray(i, i + CHUNK));
    }
    const b64 = (typeof btoa === 'function')
      ? btoa(bin)
      : Buffer.from(data).toString('base64');
    return `data:${mime};base64,${b64}`;
  }

  // -------------------------------------------------------------- runs

  // w:highlight solo admite estos nombres de la paleta de Word.
  const HIGHLIGHT_COLORS = {
    yellow: '#FFFF00', green: '#00FF00', cyan: '#00FFFF', magenta: '#FF00FF', blue: '#0000FF',
    red: '#FF0000', darkblue: '#000080', darkcyan: '#008080', darkgreen: '#008000',
    darkmagenta: '#800080', darkred: '#800000', darkyellow: '#808000', darkgray: '#808080',
    lightgray: '#C0C0C0', black: '#000000'
  };

  function runPropsOf(run) {
    const rPr = xml.find(run, 'rPr');
    const props = {};
    if (!rPr) return props;
    const b = xml.find(rPr, 'b');
    if (b) props.bold = xml.attr(b, 'val') !== '0' && xml.attr(b, 'val') !== 'false';
    const i = xml.find(rPr, 'i');
    if (i) props.italic = xml.attr(i, 'val') !== '0' && xml.attr(i, 'val') !== 'false';
    const u = xml.find(rPr, 'u');
    if (u) {
      const val = xml.attr(u, 'val');
      if (val && val !== 'none') props.underline = true;
    }
    const color = xml.find(rPr, 'color');
    if (color) {
      const v = xml.attr(color, 'val');
      if (v && /^[0-9a-fA-F]{6}$/.test(v) && v.toUpperCase() !== 'AUTO') props.color = `#${v}`;
    }
    const sz = xml.find(rPr, 'sz');
    if (sz) {
      const v = parseInt(xml.attr(sz, 'val'), 10);
      if (isFinite(v) && v > 0) props.size = Math.round((v / 2) * 10) / 10;
    }
    const strike = xml.find(rPr, 'strike');
    if (strike) props.strike = xml.attr(strike, 'val') !== '0' && xml.attr(strike, 'val') !== 'false';
    const va = xml.find(rPr, 'vertAlign');
    if (va) {
      const v = xml.attr(va, 'val');
      if (v === 'superscript') props.vert = 'sup'; else if (v === 'subscript') props.vert = 'sub';
    }
    // Resaltado: w:shd con relleno, o w:highlight (paleta fija de Word).
    const shd = xml.find(rPr, 'shd');
    const fill = shd && xml.attr(shd, 'fill');
    if (fill && /^[0-9a-fA-F]{6}$/.test(fill)) props.highlight = `#${fill}`;
    else {
      const hl = xml.find(rPr, 'highlight');
      const named = hl && HIGHLIGHT_COLORS[String(xml.attr(hl, 'val') || '').toLowerCase()];
      if (named) props.highlight = named;
    }
    // Fuente: solo si el run la declara directamente (no la heredada del estilo).
    const fonts = xml.find(rPr, 'rFonts');
    const face = fonts && (xml.attr(fonts, 'ascii') || xml.attr(fonts, 'hAnsi'));
    // Calibri es la fuente que el escritor pone por defecto en cada tramo (y la
    // de Word): no es una eleccion del usuario y guardarla en todos los runs
    // cambiaria el documento sin que nadie lo haya tocado.
    if (face && !/^calibri$/i.test(face) && /^[\p{L}\p{N} ._-]{1,60}$/u.test(face)) props.font = face;
    return props;
  }

  function propsKey(p) {
    const flag = (v, c) => (v === true ? c : v === false ? '-' + c : '');
    return [flag(p.bold, 'b'), flag(p.italic, 'i'), flag(p.underline, 'u'), p.strike ? 's' : '', p.color || '', p.highlight || '', p.font || '', p.size || '', p.vert || '', p.link || '', p.note || '', p.comment || '', p.ins || '', p.del || ''].join('|');
  }

  /**
   * Recorre el contenido de un parrafo y devuelve una lista de runs
   * { text, bold, italic, ... } con los saltos de linea ya incorporados.
   */
  function runsOfParagraph(p, ctx) {
    const runs = [];
    let current = null;

    const push = (text, props) => {
      if (!text) return;
      const key = propsKey(props);
      if (current && current.key === key) { current.text += text; return; }
      current = { key, text, props };
      runs.push(current);
    };

    const walk = (node) => {
      for (const child of node.children) {
        if (!xml.isElement(child)) continue;
        const name = child.local;
        if (name === 'commentRangeStart') { ctx.curComment = (ctx.comments && ctx.comments[xml.attr(child, 'id')]) || null; continue; }
        if (name === 'commentRangeEnd') { ctx.curComment = null; continue; }
        if (name === 'ins' || name === 'del') {
          const who = (xml.attr(child, 'author') || 'Autor') + '|' + (xml.attr(child, 'date') || '');
          const prevI = ctx.curIns, prevD = ctx.curDel;
          if (name === 'ins') ctx.curIns = who; else ctx.curDel = who;
          walk(child);
          ctx.curIns = prevI; ctx.curDel = prevD;
          continue;
        }
        if (SKIP_TEXT.has(name)) continue;
        if (name === 'AlternateContent') {
          // mc:AlternateContent: se toma la primera rama y se ignora el
          // respaldo, para no duplicar el texto.
          const choice = xml.childNodes(child, 'Choice')[0] || xml.childNodes(child, 'Fallback')[0];
          if (choice) walk(choice);
          continue;
        }
        if (name === 'pPr' || name === 'sdtPr' || name === 'rPr' || name === 'tblPr' || name === 'trPr' || name === 'tcPr') continue;
        if (name === 'hyperlink') {
          const target = ctx.rels && ctx.rels[xml.attr(child, 'id')];
          const prevLink = ctx.curLink;
          if (target && model.isSafeLink(target)) ctx.curLink = String(target).trim();
          const anc = xml.attr(child, 'anchor');
          if (!target && anc && model.isSafeLink('#' + anc)) ctx.curLink = '#' + anc;
          walk(child);
          ctx.curLink = prevLink;
          continue;
        }
        if (name === 'commentRangeStart') {
          const t = ctx.comments && ctx.comments[xml.attr(child, 'id')];
          ctx.curComment = t || null;
          continue;
        }
        if (name === 'commentRangeEnd') { ctx.curComment = null; continue; }
        if (name === 'r') {
          const props = runPropsOf(child);
          if (ctx.curLink) props.link = ctx.curLink;
          if (ctx.curComment) props.comment = ctx.curComment;
          if (ctx.curIns) props.ins = ctx.curIns;
          if (ctx.curDel) props.del = ctx.curDel;
          const ref = xml.find(child, 'footnoteReference');
          const eref = !ref && xml.find(child, 'endnoteReference');
          if (eref) ctx.sawEndnote = true;
          const noteText = (ref && ctx.footnotes && ctx.footnotes[xml.attr(ref, 'id')]) || (eref && ctx.endnotes && ctx.endnotes[xml.attr(eref, 'id')]);
          if (noteText && current && current.text) {
            // La nota cuelga de la ultima palabra anterior a la marca.
            const m = /(\S+\s*)$/.exec(current.text);
            if (m && m.index > 0) {
              const head = current.text.slice(0, m.index);
              const tail = m[1];
              const base = current.props;
              current.text = head;
              const np = Object.assign({}, base, { note: noteText });
              current = { key: propsKey(np), text: tail, props: np };
              runs.push(current);
            } else { current.props = Object.assign({}, current.props, { note: noteText }); current.key = propsKey(current.props); }
            current = null;
          }
          for (const piece of runTokens(child, ctx)) {
            if (piece.image) { runs.push({ image: piece.image, meta: piece.meta }); current = null; continue; }
            push(piece.text, Object.assign({}, props, piece.props || {}));
          }
          continue;
        }
        if (name === 'br') {
          const type = xml.attr(child, 'type');
          if (type === 'page') { ctx.pageBreak = true; continue; }
          push('\n', {});
          continue;
        }
        if (name === 'drawing' || name === 'pict' || name === 'object') {
          const src = imageFromDrawing(child, ctx);
          if (src) {
            runs.push({ image: src, meta: ctx.imgMeta });
            current = null;
          }
          continue;
        }
        if (name === 'sdt') {
          const content = xml.find(child, 'sdtContent');
          if (content) walk(content);
          continue;
        }
        if (name === 'AlternateContent') continue;
        walk(child);
      }
    };

    walk(p);
    return runs.filter(r => r.image || (r.text && r.text.length));
  }

  function runTokens(run, ctx) {
    const out = [];
    let text = '';
    const flush = () => { if (text) { out.push({ text }); text = ''; } };
    for (const child of run.children) {
      if (!xml.isElement(child)) continue;
      const name = child.local;
      if (name === 't' || (name === 'delText' && ctx.curDel)) { text += xml.textOf(child); continue; }
      if (name === 'tab') { text += '\t'; continue; }
      if (name === 'noBreakHyphen') { text += '-'; continue; }
      if (name === 'softHyphen') continue;
      if (name === 'br') {
        const type = xml.attr(child, 'type');
        if (type === 'page') { flush(); ctx.pageBreak = true; continue; }
        text += '\n';
        continue;
      }
      if (name === 'cr') { text += '\n'; continue; }
      if (SKIP_TEXT.has(name)) continue;
      // Un run puede contener otro run (raro) o un dibujo.
      if (name === 'drawing' || name === 'pict') {
        const src = imageFromDrawing(child, ctx);
        if (src) { flush(); out.push({ image: src, meta: ctx.imgMeta }); }
        continue;
      }
    }
    flush();
    return out;
  }

  // Tamano, recorte y ajuste del dibujo; queda en ctx.imgMeta para quien arma el bloque.
  function imageMeta(node, ctx) {
    const meta = {};
    const anchor = xml.findAll(node, 'anchor')[0];
    const ext = xml.findAll(node, 'extent')[0];
    if (ext) {
      const cx = parseInt(xml.attr(ext, 'cx'), 10);
      const cy = parseInt(xml.attr(ext, 'cy'), 10);
      if (cx > 0) meta.width = Math.round(cx / 9525);
      if (cy > 0) meta.height = Math.round(cy / 9525);
    }
    const rect = xml.findAll(node, 'srcRect')[0];
    if (rect) {
      const g = (k) => Math.round((parseInt(xml.attr(rect, k), 10) || 0) / 1000);
      const c = { t: g('t'), r: g('r'), b: g('b'), l: g('l') };
      if (c.t || c.r || c.b || c.l) meta.crop = c;
    }
    if (anchor && xml.findAll(anchor, 'wrapSquare')[0]) {
      const posH = xml.findAll(anchor, 'positionH')[0];
      const align = posH && xml.findAll(posH, 'align')[0];
      const off = posH && xml.findAll(posH, 'posOffset')[0];
      let side = align ? String(xml.textOf(align)).trim() : '';
      if (side !== 'left' && side !== 'right') {
        const o = off ? parseInt(xml.textOf(off), 10) : 0;
        side = o > (ctx.contentEmu || 3000000) / 2 ? 'right' : 'left';
      }
      meta.wrap = side;
    }
    ctx.imgMeta = meta;
  }

  function imageFromDrawing(node, ctx) {
    if (!ctx.rels) return null;
    imageMeta(node, ctx);
    const blips = xml.findAll(node, 'blip');
    for (const blip of blips) {
      const rid = xml.attr(blip, 'embed') || xml.attr(blip, 'link');
      if (!rid) continue;
      const target = ctx.rels[rid];
      const src = dataUrl(target, ctx.entries);
      if (src) return src;
    }
    // VML: <v:imagedata r:id="..."/>
    const imagedata = xml.findAll(node, 'imagedata');
    for (const node2 of imagedata) {
      const rid = xml.attr(node2, 'id');
      const src = dataUrl(ctx.rels[rid], ctx.entries);
      if (src) return src;
    }
    return null;
  }

  // --------------------------------------------------------- párrafos

  function paraInfo(p, ctx) {
    const pPr = xml.find(p, 'pPr');
    const info = { pPr };
    if (!pPr) return info;

    const pStyle = xml.find(pPr, 'pStyle');
    info.style = xml.attr(pStyle, 'val') || '';
    // "Heading2", "heading 2", "Ttulo2": el id que el estilo de titulo
    // normalizado, para poder buscar su cadena de estilos aunque el parrafo
    // no declare tamano propio.
    const hm = /^(?:Heading|Ttulo|Título)[ _]?([1-3])$/i.exec(String(info.style).replace(/\s+/g, ''));
    if (hm) info.styleHeading = 'Heading' + hm[1];

    const numPr = xml.find(pPr, 'numPr');
    if (numPr) {
      const ilvl = xml.find(numPr, 'ilvl');
      const numId = xml.find(numPr, 'numId');
      info.list = true;
      info.level = parseInt(xml.attr(ilvl, 'val') || '0', 10) || 0;
      info.numId = xml.attr(numId, 'val') || '';
    }

    const jc = xml.find(pPr, 'jc');
    if (jc) {
      const v = xml.attr(jc, 'val');
      if (v === 'center' || v === 'right' || v === 'both' || v === 'left') {
        info.align = v === 'both' ? 'justify' : v;
      }
    }

    const pShd = xml.find(pPr, 'shd');
    const pFill = pShd ? String(xml.attr(pShd, 'fill') || '').toUpperCase() : '';
    if (pFill && pFill !== 'AUTO') {
      for (const k of Object.keys(CALLOUT_FILLS)) if (CALLOUT_FILLS[k] === pFill) info.callout = k;
    }
    const fp = xml.find(pPr, 'framePr');
    if (fp) {
      const bd = xml.find(xml.find(pPr, 'pBdr') || pPr, 'top');
      const bc = bd ? String(xml.attr(bd, 'color') || '') : '';
      const xa = xml.attr(fp, 'xAlign');
      const fw = parseInt(xml.attr(fp, 'w') || '0', 10);
      info.callout = undefined;
      info.box = {
        shape: 'rect',
        w: fw ? Math.round((fw / 9000) * 100) : 40,
        float: xa === 'left' || xa === 'right' ? xa : 'center',
        fill: pFill && pFill !== 'AUTO' ? '#' + pFill : '#FFFFFF',
        border: /^[0-9a-fA-F]{6}$/.test(bc) ? '#' + bc.toUpperCase() : '#555555'
      };
    }
    const ind = xml.find(pPr, 'ind');
    if (ind) {
      const left = parseInt(xml.attr(ind, 'left') || xml.attr(ind, 'start') || '0', 10);
      const hang = parseInt(xml.attr(ind, 'hanging') || '0', 10);
      if (hang > 0) {
        info.hanging = Math.round(hang / 20 * 2) / 2;
        const rest = left - hang;
        if (rest >= 180) info.indent = Math.max(1, Math.round(rest / 360));
      } else {
        if (left > 0) info.indent = Math.max(1, Math.round(left / 360));
        const fl = parseInt(xml.attr(ind, 'firstLine') || '0', 10);
        if (fl > 0) info.firstLine = Math.round(fl / 20 * 2) / 2;
      }
    }

    const spacing = xml.find(pPr, 'spacing');
    if (spacing) {
      const before = parseInt(xml.attr(spacing, 'before') || '0', 10);
      if (before > 0) info.spaceBefore = Math.round(before / 20 * 2) / 2;
      const after = xml.attr(spacing, 'after');
      // 6 pt (120) es lo que escribe este editor por defecto: no es una eleccion.
      if (after != null && parseInt(after, 10) !== 120 && parseInt(after, 10) >= 0) info.spaceAfter = Math.round(parseInt(after, 10) / 20 * 2) / 2;
      const line = parseInt(xml.attr(spacing, 'line') || '0', 10);
      const rule = xml.attr(spacing, 'lineRule');
      if (line > 0 && (!rule || rule === 'auto')) {
        const lh = Math.round(line / 240 * 100) / 100;
        if (lh >= 0.8 && lh <= 3) info.lineHeight = lh;
      }
    }

    const outline = xml.find(pPr, 'outlineLvl');
    if (outline) {
      const v = parseInt(xml.attr(outline, 'val'), 10);
      if (isFinite(v) && v >= 0 && v <= 2) info.outline = v + 1;
    }

    // Un borde inferior sin texto es un separador horizontal.
    const pBdr = xml.find(pPr, 'pBdr');
    if (pBdr && xml.find(pBdr, 'bottom') && !info.box) info.horizontalRule = true;

    return info;
  }

function blockFromRuns(runs, info) {
      const blocks = [];
// (el formato heredado del estilo se resuelve mas abajo, en `tp`)

    for (const run of runs) {
      if (run.image) blocks.push(Object.assign({ type: 'image', src: run.image, alt: info.caption || '' }, run.meta || {}));
    }
    // Un Heading1 sin tamano propio (porque "Heading1" esta basado en Normal y
    // el tamano vive en el estilo padre) no es 11pt: es 17pt. Si solo se mira
    // el estilo del parrafo, todos los titulos caen al tamano del cuerpo y el
    // documento se ve plano. Un heading toma su tamano efectivo de la cadena
    // del estilo aunque el que lo nombra no lo declare.
    let tp = typedProps(styleOf(info.style, info.sheet));
    if (info.styleHeading) {
      const hs = styleOf(info.styleHeading, info.sheet);
      if (hs && hs.size != null) tp = Object.assign({}, tp, { size: hs.size });
    }

    const texts = runs.filter(r => r.text);
    if (!texts.length) return blocks;

    // Los espacios entre runs son datos, no basura: se recortan solo en los
    // bordes del parrafo. Recortar cada run pegaria "Un fragmentoen negrita".
const merged = texts.map(t => {
      const clean = String(t.text).replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
      // El formato directo del run gana sobre el heredado del estilo.
      return Object.assign({}, tp, t.props || {}, { text: clean });
    }).filter(m => m.text.length);

    if (!merged.length) return blocks;
    // Recorte de los bordes.
    merged[0].text = merged[0].text.replace(/^[ \t]+/, '');
    merged[merged.length - 1].text = merged[merged.length - 1].text.replace(/[ \t\n]+$/, '');
    const usable = merged.filter(m => m.text.length);
    if (!usable.length) return blocks;

    let capKind = '';
    if (/^Caption$/i.test(info.style || '')) {
      const cm = /^(Figura|Figure|Imagen|Image|Tabla|Table)\s+\d+\s*[.:\-–]?\s*/i.exec(usable[0].text);
      if (cm) { capKind = /^(tabla|table)/i.test(cm[1]) ? 'table' : 'figure'; usable[0].text = usable[0].text.slice(cm[0].length); }
    }
    const base = { caption: capKind || undefined, callout: info.callout, box: info.box, align: info.align, indent: info.indent, firstLine: info.firstLine, hanging: info.hanging, lineHeight: info.lineHeight, spaceBefore: info.spaceBefore, spaceAfter: info.spaceAfter };
    const distinct = new Set(usable.map(propsKey));
    // Tachado, resaltado y fuente solo existen como formato de tramo: un
    // parrafo uniforme que los lleve tambien se guarda como runs.
    const first = usable[0];
    const needsRuns = distinct.size > 1 || first.strike || first.highlight || first.vert || first.font || first.link || first.note || first.comment || first.ins || first.del;
    if (needsRuns) {
      blocks.push(Object.assign({}, base, {
        type: 'paragraph',
        runs: usable.map(m => {
          const run = { text: m.text };
          for (const key of ['bold', 'italic', 'underline']) {
            if (m[key] === true) run[key] = true;
            else if (m[key] === false) run[key] = false;
          }
          if (m.strike) run.strike = true;
          if (m.vert) run.vert = m.vert;
          if (m.color) run.color = m.color;
          if (m.highlight) run.highlight = m.highlight;
          if (m.font) run.font = m.font;
          if (m.size) run.size = m.size;
          if (m.note) run.note = m.note;
          if (m.comment) run.comment = m.comment;
          if (m.ins) run.ins = m.ins;
          if (m.del) run.del = m.del;
          if (m.link) {
            run.link = m.link;
            // El escritor pinta los enlaces de azul y subrayados; eso es
            // presentacion del enlace, no una eleccion del autor.
            if (String(run.color).toLowerCase() === '#0563c1') delete run.color;
            if (run.underline === true) delete run.underline;
          }
          return run;
        })
      }));
      return blocks;
    }
    const m = usable[0];
    blocks.push(Object.assign({}, base, {
      type: 'paragraph',
      text: usable.map(x => x.text).join(''),
      bold: m.bold || undefined,
      italic: m.italic || undefined,
      underline: m.underline || undefined,
      color: m.color || undefined,
      // 11 pt es el tamano base del cuerpo: guardarlo en cada parrafo no aporta
      // y cambiaria el hash del documento al reabrirlo.
      size: (m.size && m.size !== 11) ? m.size : undefined
    }));
    return blocks;
  }

  // Runs de un item de lista o una celda: solo se conservan si llevan formato.
  function inlineModelRuns(runs) {
    const texts = (runs || []).filter(r => r.text).map(r => {
      const m = r.props || {};
      const run = { text: String(r.text).replace(/\u00a0/g, ' ').replace(/\n+/g, ' ') };
      for (const key of ['bold', 'italic', 'underline']) if (m[key] === true) run[key] = true;
      if (m.strike) run.strike = true;
      if (m.vert) run.vert = m.vert;
      if (m.color) run.color = m.color;
      if (m.highlight) run.highlight = m.highlight;
      if (m.font) run.font = m.font;
      if (m.size && m.size !== 11) run.size = m.size;
      if (m.note) run.note = m.note;
      if (m.comment) run.comment = m.comment;
      if (m.ins) run.ins = m.ins;
      if (m.del) run.del = m.del;
      if (m.link) {
        run.link = m.link;
        if (String(run.color).toLowerCase() === '#0563c1') delete run.color;
        if (run.underline === true) delete run.underline;
      }
      return run;
    });
    return texts.some(r => r.bold || r.italic || r.underline || r.strike || r.vert || r.color || r.highlight || r.font || r.size || r.link || r.note || r.comment || r.ins || r.del) ? texts : null;
  }

  function tableBlocks(tbl, ctx) {
    const rows = [];
    const cellRuns = {};
    const cellFill = {};
    const cellBorders = {};
    const merges = [];
    let ri = 0;
    for (const tr of xml.childNodes(tbl, 'tr')) {
      const cells = [];
      for (const tc of xml.childNodes(tr, 'tc')) {
        const tcPr = xml.find(tc, 'tcPr');
        const spanN = Math.max(1, Math.min(20, parseInt(xml.attr(xml.find(tcPr || tc, 'gridSpan'), 'val'), 10) || 1));
        const vmNode = tcPr && xml.find(tcPr, 'vMerge');
        const vm = vmNode ? (xml.attr(vmNode, 'val') === 'restart' ? 'restart' : 'continue') : null;
        const gridCol = cells.length;
        const tcb = tcPr && xml.find(tcPr, 'tcBorders');
        if (tcb) {
          const vis = (n) => { const e = xml.find(tcb, n); const v = e ? xml.attr(e, 'val') : null; return !!v && v !== 'nil' && v !== 'none'; };
          const set = [['t', 'top'], ['r', 'right'], ['b', 'bottom'], ['l', 'left']].filter(([, n]) => vis(n)).map(([k]) => k).join('');
          cellBorders[ri + ',' + gridCol] = set.length === 4 ? 'trbl' : set || 'none';
        }
        const shd = tcPr && xml.find(tcPr, 'shd');
        const fillHex = shd ? String(xml.attr(shd, 'fill') || '') : '';
        if (/^[0-9a-f]{6}$/i.test(fillHex) && fillHex.toUpperCase() !== 'EEEEEE') cellFill[ri + ',' + gridCol] = '#' + fillHex.toLowerCase();
        const texts = [];
        let all = [];
        for (const p of xml.childNodes(tc, 'p')) {
          const t = xml.textOf(p).replace(/\s+/g, ' ').trim();
          if (!t) continue;
          texts.push(t);
          if (ctx) {
            const rr = inlineModelRuns(runsOfParagraph(p, ctx)) || runsOfParagraph(p, ctx).filter(r => r.text).map(r => ({ text: String(r.text).replace(/\n+/g, ' ') }));
            if (all.length) all.push({ text: ' ' });
            all = all.concat(rr);
          }
        }
        if (ctx && all.length && inlineModelRuns(all.map(r => ({ text: r.text, props: r })))) cellRuns[ri + ',' + cells.length] = all.map(r => Object.assign({}, r, { text: r.text.replace(/\s+/g, ' ') }));
        cells.push(texts.join(' '));
        for (let k = 1; k < spanN; k++) cells.push('');
        if (vm === 'continue') {
          // Continuacion vertical: extiende la combinacion de arriba (misma columna).
          const up = merges.find(m => m.c === gridCol && m.r + m.rows === ri);
          if (up) up.rows += 1;
          cells[gridCol] = '';
          if (cellRuns[ri + ',' + gridCol]) delete cellRuns[ri + ',' + gridCol];
        } else if (vm === 'restart' || spanN > 1) {
          merges.push({ r: ri, c: gridCol, rows: 1, cols: spanN });
        }
      }
      if (cells.length) { rows.push(cells); ri++; }
    }
    if (!rows.length) return [];
    const b = { type: 'table', rows, header: true };
    if (Object.keys(cellRuns).length) b.cellRuns = cellRuns;
    if (Object.keys(cellFill).length) b.cellFill = cellFill;
    if (Object.keys(cellBorders).length) b.cellBorders = cellBorders;
    // Ancho de columnas: tblGrid (solo si hay distintos anchos) y bordes de la tabla.
    const grid = xml.find(tbl, 'tblGrid');
    const gw = grid ? xml.childNodes(grid, 'gridCol').map(g => parseInt(xml.attr(g, 'w'), 10)) : [];
    const ncols = Math.max(...rows.map(r => r.length));
    if (gw.length === ncols && gw.every(n => n > 0) && Math.max(...gw) - Math.min(...gw) > 40) {
      const sum = gw.reduce((a, n) => a + n, 0);
      b.colWidths = gw.map(n => Math.round(n / sum * 1000) / 10);
    }
    const tblPr = xml.find(tbl, 'tblPr');
    const tb = tblPr && xml.find(tblPr, 'tblBorders');
    if (tb) {
      const isLine = (n) => { const e = xml.find(tb, n); const v = e ? xml.attr(e, 'val') : null; return !!v && v !== 'nil' && v !== 'none'; };
      const outerOn = ['top', 'left', 'bottom', 'right'].some(isLine);
      const insideH = isLine('insideH');
      const insideV = isLine('insideV');
      const sidesLR = isLine('left') || isLine('right');
      if (!outerOn && !insideH && !insideV) b.borders = 'none';
      else if (outerOn && !insideH && !insideV) b.borders = 'outer';
      else if (insideH && !insideV && !sidesLR) b.borders = 'horizontal';
    }
    const real = merges.filter(m => m.rows > 1 || m.cols > 1);
    if (real.length) b.merges = real;
    return [b];
  }

  // --------------------------------------------------------- numeracion

  // Texto de cada nota al pie / comentario: { id: texto }.
  function textsOfPart(entries, name, tag) {
    const out = Object.create(null);
    const raw = entries[name];
    if (!raw) return out;
    let tree;
    try { tree = xml.parse(zip.toStr(raw)); } catch { return out; }
    for (const el of xml.findAll(tree, tag)) {
      if (xml.attr(el, 'type')) continue;
      const parts = [];
      const grab = (n) => {
        for (const c of n.children || []) {
          if (!xml.isElement(c)) continue;
          if (c.local === 't') parts.push(xml.textOf(c));
          else if (c.local === 'p' && parts.length) { parts.push(' '); grab(c); }
          else grab(c);
        }
      };
      grab(el);
      let text = parts.join('').replace(/\s+/g, ' ').trim();
      if (text && tag === 'comment' && !/^\[[^|\]]*\|[^\]]*\]/.test(text)) {
        const who = xml.attr(el, 'author');
        if (who && who !== 'Autor') text = ('[' + who + '|' + String(xml.attr(el, 'date') || '').slice(0, 16) + '] ' + text).slice(0, 500);
      }
      if (text) out[xml.attr(el, 'id')] = text;
    }
    return out;
  }

  function numberingFormats(entries) {
    const map = Object.create(null);
    const raw = entries['word/numbering.xml'];
    if (!raw) return map;
    let tree;
    try { tree = xml.parse(zip.toStr(raw)); } catch { return map; }
    for (const abs of xml.findAll(tree, 'abstractNum')) {
      const id = xml.attr(abs, 'abstractNumId');
      const lvl0 = xml.childNodes(abs, 'lvl')[0];
      const fmt = lvl0 ? xml.attr(xml.find(lvl0, 'numFmt') || { attrs: {} }, 'val') : '';
      map[id] = fmt;
    }
    const numMap = Object.create(null);
    for (const num of xml.findAll(tree, 'num')) {
      const numId = xml.attr(num, 'numId');
      const abs = xml.find(num, 'abstractNumId');
      numMap[numId] = map[xml.attr(abs, 'val')] || '';
    }
    return numMap;
  }

  // ------------------------------------------------------------- entrada

  /**
   * docxBytesToDoc(bytes, opts) -> { doc, warnings }
   * `bytes` puede ser el .docx entero o el mapa de entradas del ZIP.
   */
  async function docxBytesToDoc(input, opts) {
    const o = opts || {};
    const warnings = [];
    // Ojo: `Uint8Array.prototype.entries` es un metodo, asi que un duck-typing
    // con truthiness confundiria un ArrayBuffer con el mapa de entradas.
    let entries = input;
    if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
      entries = (await zip.readZip(input)).entries;
    } else if (!input || typeof input !== 'object') {
      throw new Error('docx: entrada invalida (se esperaba un .docx o un mapa de entradas)');
    }

    const raw = entries['word/document.xml'];
    if (!raw) {
      throw new Error('docx: falta word/document.xml (no parece un documento de Word)');
    }
    const tree = xml.parse(zip.toStr(raw));
    const body = xml.findDeep(tree, 'body');
    if (!body) throw new Error('docx: no se encontro w:body');

    const rels = parseRels(entries);
    const numFormats = numberingFormats(entries);
    const ctx = {
      entries, rels, pageBreak: false, styles: styleSheet(entries),
      footnotes: textsOfPart(entries, 'word/footnotes.xml', 'footnote'),
      endnotes: textsOfPart(entries, 'word/endnotes.xml', 'endnote'),
      comments: textsOfPart(entries, 'word/comments.xml', 'comment')
    };

    const blocks = [];
    let listBuffer = null;
    // Origen de cada bloque: rango de hijos de w:body de donde salió (para guardar parchando el original).
    const ranges = []; let childIdx = -1; let curChild = -1; let tocRange = null;
    const pushB = (b, a, bb) => { blocks.push(b); const r = { a, b: bb }; ranges.push(r); return r; };

    const flushList = () => {
      if (listBuffer && listBuffer.items.length) {
        const { items, itemRuns, itemLevels, ordered, level, a: srcA, b: srcB, ...rest } = listBuffer;
        const extra = itemRuns.some(Boolean) ? { itemRuns } : {};
        if (itemLevels && itemLevels.some((l) => l > 0)) extra.itemLevels = itemLevels;
        pushB(Object.assign({ type: 'list', items, ordered, level }, extra, rest), srcA, srcB);
      }
      listBuffer = null;
    };

    const emit = (list) => {
      for (const b of list) {
        if (b.type === 'pagebreak') { flushList(); pushB(b, curChild, curChild); continue; }
        pushB(b, curChild, curChild);
      }
    };

    const walkBody = (node, top) => {
      for (const child of node.children) {
        if (!xml.isElement(child)) continue;
        if (top) curChild = ++childIdx;
        const name = child.local;
        if (name === 'p') {
          // Campo TOC: se lee como un bloque 'toc' y se saltan sus entradas.
          const instr = xml.findAll(child, 'instrText').map((i) => xml.textOf(i)).concat(xml.findAll(child, 'fldSimple').map((f) => xml.attr(f, 'instr') || '')).join(' ');
          const fldEnds = xml.findAll(child, 'fldChar').filter((f) => xml.attr(f, 'fldCharType') === 'end').length;
          const fldBegins = xml.findAll(child, 'fldChar').filter((f) => xml.attr(f, 'fldCharType') === 'begin').length;
          if (!ctx.tocSkip && /\bTOC\b/.test(instr) && !/\bTOF\b/.test(instr)) {
            flushList();
            const lv = /\\o\s+"?\d-(\d)/.exec(instr);
            const cap = /\\c\s+"?(Figura|Figure|Tabla|Table)"?/i.exec(instr);
            tocRange = pushB(cap ? { type: 'toc', levels: 3, kind: /^(tabla|table)/i.test(cap[1]) ? 'table' : 'figure' } : { type: 'toc', levels: lv ? Number(lv[1]) : 3 }, curChild, curChild);
            ctx.tocDepth = fldBegins - fldEnds;
            ctx.tocSkip = ctx.tocDepth > 0;
            continue;
          }
          if (ctx.tocSkip) {
            ctx.tocDepth += fldBegins - fldEnds; if (tocRange) tocRange.b = curChild;
            if (ctx.tocDepth <= 0) ctx.tocSkip = false;
            continue;
          }
          const info = paraInfo(child, ctx);
          info.sheet = ctx.styles;
          const pageBreakBefore = ctx.pageBreak;
          ctx.pageBreak = false;
          const runs = runsOfParagraph(child, ctx);
          const pageBreakAfter = ctx.pageBreak;
          ctx.pageBreak = false;

          let out = [];
          if (pageBreakBefore) out.push({ type: 'pagebreak' });

if (info.list) {
          const text = runs.map(r => (r.text || '')).join('').trim();
          const ordered = numFormats[info.numId] ? !/bullet/i.test(numFormats[info.numId]) : true;
          if (!listBuffer || listBuffer.ordered !== ordered) {
            flushList();
            // Los items son cadenas planas: el formato del estilo se guarda a
            // nivel de bloque, que es lo unico que el modelo puede representar.
            listBuffer = { items: [], itemRuns: [], itemLevels: [], ordered, level: info.level || 0, a: curChild, b: curChild };
            Object.assign(listBuffer, typedProps(styleOf(info.style, ctx.styles)));
            if (info.align) listBuffer.align = info.align;
          }
            listBuffer.b = curChild;
            if (text) { listBuffer.items.push(text); listBuffer.itemRuns.push(inlineModelRuns(runs)); listBuffer.itemLevels.push(Math.max(0, Math.min(2, (info.level || 0) - (listBuffer.level || 0)))); }
            if (pageBreakAfter) flushList();
            continue;
          }
          flushList();

          const kind = headingLevelOf(info);
          const text = runs.map(r => (r.text || '')).join('').trim();
          // La tipografia del estilo se aplica como formato del bloque, no como
          // run: asi el modelo lo guarda y el exportador lo vuelve a escribir.
          const tp = typedProps(styleOf(info.styleHeading || info.style, ctx.styles));
          const base2 = Object.assign(info.align ? { align: info.align } : {}, info.spaceBefore != null ? { spaceBefore: info.spaceBefore } : {}, info.spaceAfter != null ? { spaceAfter: info.spaceAfter } : {}, info.lineHeight ? { lineHeight: info.lineHeight } : {});
          if (kind) {
            if (kind.kind === 'hr') out.push({ type: 'hr' });
            else if (kind.kind === 'quote' && text) out.push(Object.assign({ type: 'quote', text }, tp, base2));
            else if (kind.kind === 'code' && text) out.push({ type: 'code', text });
            else if (text) out.push(Object.assign({ type: 'heading', level: kind.level, text }, tp, base2));
            else out = out.concat(blockFromRuns(runs, info));
          } else {
            out = out.concat(blockFromRuns(runs, info));
          }
          if (pageBreakAfter) out.push({ type: 'pagebreak' });
          emit(out);
          continue;
        }
        if (name === 'tbl') {
          flushList();
          emit(tableBlocks(child, ctx));
          continue;
        }
        if (name === 'sdt') {
          const content = xml.find(child, 'sdtContent');
          if (content) walkBody(content);
          continue;
        }
        if (name === 'sectPr') {
          const pgSz = xml.find(child, 'pgSz');
          if (pgSz) {
            const w = parseInt(xml.attr(pgSz, 'w') || '0', 10);
            const h = parseInt(xml.attr(pgSz, 'h') || '0', 10);
            if (w > 0 && h > 0) { o.pageWidth = w / 20; o.pageHeight = h / 20; }
            // w:orient es la unica fuente fiable de la orientacion: las medidas
            // pueden venir ya intercambiadas o no, segun quien escribio el
            // archivo. Sin leerla, un documento horizontal se guardaba como
            // vertical en la siguiente pulsacion de guardar.
            const orient = String(xml.attr(pgSz, 'orient') || '').toLowerCase();
            if (orient === 'landscape' || orient === 'portrait') o.orientation = orient;
          }
          const pgMar = xml.find(child, 'pgMar');
          if (pgMar) {
            const side = (n) => { const v = parseInt(xml.attr(pgMar, n) || '', 10); return v >= 0 ? v / 20 : null; };
            const top = side('top'), right = side('right'), bottom = side('bottom'), left = side('left');
            const lados = [top, right, bottom, left].filter(v => v != null);
            if (lados.length) {
              // `margin` es el general del que salen los lados. Antes se ponia
              // siempre igual al superior, asi que un documento con margenes
              // distintos se guardaba despues con todos iguales al superior.
              const cuenta = {};
              for (const v of lados) cuenta[v] = (cuenta[v] || 0) + 1;
              let general = top;
              for (const v of lados) if (cuenta[v] > cuenta[general]) general = v;
              o.margin = general;
            }
            o.marginTop = top; o.marginRight = right; o.marginBottom = bottom; o.marginLeft = left;
          }
          const pgNum = xml.find(child, 'pgNumType');
          const pgStart = pgNum ? parseInt(xml.attr(pgNum, 'start') || '0', 10) : 0;
          if (pgStart > 1) o.pageStart = pgStart;
          if (xml.find(child, 'titlePg')) o.titlePage = true;
          const colsEl = xml.find(child, 'cols');
          const colsN = colsEl ? parseInt(xml.attr(colsEl, 'num') || '1', 10) : 1;
          if (colsN > 1 && colsN <= 3) o.columns = colsN;
          for (const ref of xml.childNodes(child, 'headerReference').concat(xml.childNodes(child, 'footerReference'))) {
            if (xml.attr(ref, 'type') && xml.attr(ref, 'type') !== 'default') continue;
            const part = headerFooterOf(entries, rels, xml.attr(ref, 'id'));
            if (!part) continue;
            if (ref.local === 'headerReference') { if (part.text) o.header = part.text; if (part.watermark) o.watermark = part.watermark; }
            else {
              if (part.text) o.footer = part.text;
              if (part.pageAlign) o.pageNumbers = part.pageAlign;
            }
          }
          continue;
        }
        if (name === 'bookmarkStart' || name === 'bookmarkEnd' || name === 'proofErr' || name === 'AlternateContent') continue;
      }
    };

    walkBody(body, true);
    flushList();
    const srcMap = Object.create(null);
    blocks.forEach((b, i) => { if (!b.id) b.id = 'dx' + i; srcMap[b.id] = ranges[i]; });

    const meta = readCoreProps(entries);
    const doc = model.createDoc({
      title: meta.title || o.title || 'Documento',
      meta: {
        author: meta.author, subject: meta.subject, keywords: meta.keywords,
        created: meta.created, modified: meta.modified,
        source: 'docx', sourcePath: o.sourcePath || ''
      },
      page: o.pageWidth ? {
        width: o.pageWidth, height: o.pageHeight, margin: o.margin,
        marginTop: o.marginTop, marginRight: o.marginRight, marginBottom: o.marginBottom, marginLeft: o.marginLeft,
        orientation: o.orientation,
        header: o.header, footer: o.footer, pageNumbers: o.pageNumbers,
        watermark: o.watermark, titlePage: o.titlePage, pageStart: o.pageStart, columns: o.columns, endnotes: ctx.sawEndnote || undefined
      } : undefined,
      blocks,
      warnings
    });

    if (!blocks.length) warnings.push('el documento no tiene texto reconocible');
    if (!doc.title || doc.title === 'Documento') {
      doc.title = model.deriveTitle(doc);
      doc.hash = model.hashDoc(doc);
    }
    return { doc, warnings, srcMap, childCount: childIdx + 1, pageSrc: JSON.parse(JSON.stringify(doc.page || null)) };
  }

  // ------------------------------------------------------------- estilos
    // Word guarda la tipografia en word/styles.xml, no en el parrafo. Lo
    // normal en un .docx real es que no traiga ni un <w:sz> directo: el tamano
    // de cada titulo vive en el estilo que el parrafo referencia con
    // <w:pStyle>. Sin resolver esa cadena, importar un documento de verdad
    // pierde la fuente y el tamano de todo el texto, que es justo lo que se ve
    // como "el documento se deforma".
    function readStyleProps(node) {
      const rPr = node ? xml.find(node, 'rPr') : null;
      if (!rPr) return null;
      const out = {};
      // w:sz va en medios puntos: 34 = 17pt.
      const sz = xml.attr(xml.find(rPr, 'sz'), 'val');
      if (sz != null) {
        const pt = parseInt(sz, 10) / 2;
        if (isFinite(pt) && pt >= 4 && pt <= 96) out.size = Math.round(pt * 10) / 10;
      }
      const color = xml.attr(xml.find(rPr, 'color'), 'val');
      if (color && /^[0-9a-fA-F]{6}$/.test(color) && color.toLowerCase() !== 'auto') out.color = '#' + color;
      const b = xml.find(rPr, 'b');
      if (b) out.bold = xml.attr(b, 'val') !== '0' && xml.attr(b, 'val') !== 'false';
      return Object.keys(out).length ? out : null;
    }

    function styleSheet(entries) {
      const byId = Object.create(null);
      let defaults = null;
      const raw = entries['word/styles.xml'];
      if (!raw) return { byId, defaults };
      let tree;
      try { tree = xml.parse(zip.toStr(raw)); } catch { return { byId, defaults }; }

      const dd = xml.findDeep(tree, 'docDefaults');
      if (dd) {
        const rPrDefault = xml.findDeep(dd, 'rPrDefault');
        if (rPrDefault) defaults = readStyleProps(xml.find(rPrDefault, 'rPr') ? rPrDefault : rPrDefault);
      }

      for (const st of xml.findAll(tree, 'style')) {
        const id = xml.attr(st, 'styleId');
        if (!id) continue;
        const props = readStyleProps(st) || {};
        props.basedOn = xml.attr(xml.find(st, 'basedOn'), 'val') || '';
        byId[id] = props;
      }
      return { byId, defaults };
    }

    // Resuelve styleId -> tamano/color/negrita, siguiendo basedOn y cayendo en
    // docDefaults. El mas cercano al parrafo gana.
    function styleOf(styleId, sheet) {
      if (!sheet) return null;
      // De la hoja a la raiz, que es como se recorre el basedOn.
      const leafToRoot = [];
      const seen = Object.create(null);
      let cur = styleId;
      while (cur && sheet.byId[cur] && !seen[cur]) {
        seen[cur] = true;
        leafToRoot.push(sheet.byId[cur]);
        cur = sheet.byId[cur].basedOn;
      }
      // docDefaults es la base de todo: va primero, para que cualquier
      // sobreescritura posterior lo pise. Sin esto el cuerpo del texto (11pt)
      // le ganaba al tamano del estilo de cada titulo.
      const chain = sheet.defaults ? [sheet.defaults].concat(leafToRoot) : leafToRoot;
      const out = {};
      for (const p of chain) {
        if (p.size != null) out.size = p.size;
        if (p.color) out.color = p.color;
        if (p.bold != null) out.bold = p.bold;
      }
      return Object.keys(out).length ? out : null;
    }

    // Solo las claves que el modelo acepta, para no filtrar basura del estilo.
    function typedProps(styled) {
      const out = {};
      if (styled && styled.size != null) out.size = styled.size;
      if (styled && styled.color) out.color = styled.color;
      if (styled && styled.bold) out.bold = true;
      return out;
    }

    function headingLevelOf(info) {
    const style = (info.style || '').replace(/\s+/g, '');
    if (/^Quote$/i.test(style) || /^IntenseQuote$/i.test(style)) return { kind: 'quote' };
    if (/^(Subtitle)$/i.test(style)) return { kind: 'heading', level: 2 };
    if (/^(HTMLPreformatted|Code|SourceCode|Preformatted)$/i.test(style)) return { kind: 'code' };
    if (/^Heading[1-3]$/i.test(style)) return { kind: 'heading', level: parseInt(style.slice(7), 10) };
    if (/^Ttulo[1-3]$/i.test(style) || /^Title$/i.test(style)) return { kind: 'heading', level: 1 };
    if (info.horizontalRule) return { kind: 'hr' };
    if (info.outline) return { kind: 'heading', level: info.outline };
    return null;
  }

  function readCoreProps(entries) {
    const out = {};
    const raw = entries['docProps/core.xml'];
    if (!raw) return out;
    let tree;
    try { tree = xml.parse(zip.toStr(raw)); } catch { return out; }
    // findDeep: los hijos de cp:coreProperties cuelgan de un unico elemento
    // raiz, asi que no son hijos directos del nodo de documento.
    const pick = (name) => {
      const node = xml.findDeep(tree, name);
      return node ? xml.textOf(node).trim() : '';
    };
    out.title = pick('title');
    out.author = pick('creator');
    out.subject = pick('subject');
    out.keywords = pick('keywords');
    out.created = pick('created');
    out.modified = pick('modified');
    return out;
  }

  return { docxBytesToDoc, parseRels, runsOfParagraph, tableBlocks, numberingFormats };
});

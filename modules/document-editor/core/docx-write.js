'use strict';
const CALLOUT_COLORS = { info: ['#EAF2FF', '#3B82F6'], warn: ['#FFF6DD', '#F59E0B'], ok: ['#E7F7EC', '#22A559'], error: ['#FDECEC', '#E5484D'] };
/**
 * MC Browser -- modulo document-editor / core/docx-write.js
 *
 * Modelo -> partes OOXML de un .docx. No se usa la libreria `docx` a
 * proposito: el modelo ya es pequeno y controlado, y generar el paquete a
 * mano evita 1 MB de dependencia y un arbol de objetos que habria que mapear
 * bloque por bloque igual.
 *
 * Lo que se emite es WordprocessingML minimo pero correcto: partes
 * obligatorias ([Content_Types].xml, _rels, document.xml), estilos basicos
 * para que los titulos sean titulos de verdad, numeracion real para las
 * listas y formato de caracter directo para el resto.
 *
 * El orden de los elementos dentro de <w:pPr> y <w:rPr> NO es libre: lo fija
 * el esquema XSD y Word rechaza el archivo si se altera. Por eso los
 * emisores de abajo arman las propiedades en el orden de la especificacion y
 * no "en el orden que queda comodo".
 */

(function (root, factory) {
  const mod = factory({
    model: (typeof require === 'function' && typeof module === 'object') ? require('./model.js') : (root.MCDoc && root.MCDoc.model)
  });
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (typeof window !== 'undefined') {
    window.MCDoc = window.MCDoc || {};
    window.MCDoc.docxWrite = mod;
  }
})(this, function (deps) {
  const model = deps.model;
  const X = (s) => escapeXml(s);

  function escapeXml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
      // Caracteres de control que Word no acepta en XML.
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  }

  const NS = [
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"',
    'xmlns:v="urn:schemas-microsoft-com:vml"',
    'xmlns:o="urn:schemas-microsoft-com:office:office"',
    'xmlns:w10="urn:schemas-microsoft-com:office:word"'
  ].join(' ');

  const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
  const PT_TO_TWIP = 20;          // 1 pt = 20 twips
  const PT_TO_EMU = 12700;        // 1 pt = 12700 EMU
  const PX_TO_EMU = 9525;         // 1 px @96dpi = 9525 EMU

  function halfPoints(pt) {
    const n = Math.round(Number(pt) * 2);
    return Math.min(96, Math.max(8, n || 22));
  }

  // ------------------------------------------------------------ propiedades

  /**
   * <w:rPr> en el orden que exige el esquema:
   * rFonts, b, bCs, i, iCs, strike, color, sz, szCs, u, shd.
   * Los `false` explicitos se escriben con w:val="0" para anular el estilo.
   */
  function runProps(props) {
    if (!props) return '';
    let out = '<w:rPr>';
    // Sin fuente propia no se escribe rFonts: asi manda el estilo del documento
    // (Normal / Heading) y, por defecto, Calibri de docDefaults.
    if (props.font) {
      const family = X(String(props.font));
      out += `<w:rFonts w:ascii="${family}" w:hAnsi="${family}" w:cs="${family}"/>`;
    }
    if (props.bold === true) out += '<w:b/><w:bCs/>';
    else if (props.bold === false) out += '<w:b w:val="0"/><w:bCs w:val="0"/>';
    if (props.italic === true) out += '<w:i/><w:iCs/>';
    else if (props.italic === false) out += '<w:i w:val="0"/><w:iCs w:val="0"/>';
    if (props.strike === true) out += '<w:strike/>';
    if (props.color) out += `<w:color w:val="${X(String(props.color).replace('#', '').slice(0, 6).toUpperCase())}"/>`;
    if (props.size) {
      const hp = halfPoints(props.size);
      out += `<w:sz w:val="${hp}"/><w:szCs w:val="${hp}"/>`;
    }
    if (props.underline === true) out += '<w:u w:val="single"/>';
    else if (props.underline === false) out += '<w:u w:val="none"/>';
    if (props.highlight) out += `<w:shd w:val="clear" w:color="auto" w:fill="${X(String(props.highlight).replace('#', '').slice(0, 6).toUpperCase())}"/>`;
    out += '</w:rPr>';
    return out;
  }

  /**
   * <w:pPr> en el orden del esquema: pStyle, numPr, pBdr, spacing, ind, jc, rPr.
   */
  function paraProps(block, opts) {
    const o = opts || {};
    let out = '<w:pPr>';

    if (block.type === 'heading') {
      out += `<w:pStyle w:val="Heading${Math.min(3, Math.max(1, block.level || 1))}"/>`;
    } else if (block.type === 'paragraph' && block.caption) {
      out += '<w:pStyle w:val="Caption"/>';
    } else if (block.type === 'quote') {
      out += `<w:pStyle w:val="Quote"/>`;
    } else if (block.type === 'code') {
      out += '<w:spacing w:before="60" w:after="60"/><w:ind w:left="360"/>';
    } else if (block.type === 'list') {
      out += `<w:pStyle w:val="ListParagraph"/>`;
      out += `<w:numPr><w:ilvl w:val="${Math.min(2, Number(block.level) || 0)}"/><w:numId w:val="${block.ordered ? 2 : 1}"/></w:numPr>`;
    } else if (block.type === 'hr') {
      out += '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BFBFBF"/></w:pBdr><w:spacing w:before="80" w:after="80"/>';
    } else {
      out += '<w:spacing w:after="120"/>';
    }

    if (block.box) {
      const bx = block.box;
      const col = String(bx.border || '#555555').slice(1);
      const wTw = Math.round(((Number(bx.w) || 40) / 100) * 9000);
      const xa = bx.float === 'left' ? 'left' : bx.float === 'right' ? 'right' : 'center';
      const sides = ['top', 'left', 'bottom', 'right'].map((s) => `<w:${s} w:val="single" w:sz="12" w:space="4" w:color="${col}"/>`).join('');
      const cx = `<w:framePr w:w="${wTw}" w:hSpace="180" w:vSpace="80" w:wrap="around" w:vAnchor="text" w:hAnchor="margin" w:xAlign="${xa}" w:y="1"${bx.shape === 'ellipse' ? ' w:hRule="auto"' : ''}/><w:pBdr>${sides}</w:pBdr><w:shd w:val="clear" w:color="auto" w:fill="${String(bx.fill || '#FFFFFF').slice(1)}"/>`;
      out = /^<w:pPr><w:pStyle [^>]*\/>/.test(out) ? out.replace(/^(<w:pPr><w:pStyle [^>]*\/>)/, '$1' + cx) : out.replace('<w:pPr>', '<w:pPr>' + cx);
    } else if (block.callout && CALLOUT_COLORS[block.callout]) {
      const [fill, bar] = CALLOUT_COLORS[block.callout];
      const cx = `<w:pBdr><w:left w:val="single" w:sz="24" w:space="6" w:color="${bar.slice(1)}"/></w:pBdr><w:shd w:val="clear" w:color="auto" w:fill="${fill.slice(1)}"/>`;
      out = /^<w:pPr><w:pStyle [^>]*\/>/.test(out) ? out.replace(/^(<w:pPr><w:pStyle [^>]*\/>)/, '$1' + cx) : out.replace('<w:pPr>', '<w:pPr>' + cx);
    }
    if (block.lineHeight) {
      const line = Math.round(Number(block.lineHeight) * 240);
      if (out.includes('<w:spacing ')) out = out.replace('<w:spacing ', `<w:spacing w:line="${line}" w:lineRule="auto" `);
      else out += `<w:spacing w:line="${line}" w:lineRule="auto"/>`;
    }
    if (block.spaceBefore != null || block.spaceAfter != null) {
      const sb = block.spaceBefore != null ? ` w:before="${Math.round(Number(block.spaceBefore) * 20)}"` : '';
      const sa = block.spaceAfter != null ? ` w:after="${Math.round(Number(block.spaceAfter) * 20)}"` : '';
      if (out.includes('<w:spacing ')) {
        out = out.replace(/<w:spacing ([^>]*?)\/>/, (m, attrs) => {
          let a = attrs;
          if (sb) a = a.replace(/w:before="\d+"\s*/, '') + sb;
          if (sa) a = a.replace(/w:after="\d+"\s*/, '') + sa;
          return `<w:spacing ${a.trim()}/>`;
        });
      } else out += `<w:spacing${sb}${sa}/>`;
    }
    if (block.hanging) {
      out += `<w:ind w:left="${Number(block.indent || 0) * 360 + Math.round(Number(block.hanging) * 20)}" w:hanging="${Math.round(Number(block.hanging) * 20)}"/>`;
    } else if (block.indent || block.firstLine) {
      out += '<w:ind' + (block.indent ? ` w:left="${Number(block.indent) * 360}"` : '') +
        (block.firstLine ? ` w:firstLine="${Math.round(Number(block.firstLine) * 20)}"` : '') + '/>';
    }
    if (block.align && block.align !== 'left') {
      const jc = { center: 'center', right: 'right', justify: 'both' }[block.align];
      if (jc) out += `<w:jc w:val="${jc}"/>`;
    }

    // Formato de caracter a nivel de parrafo (afecta a las marcas de parrafo).
    const blockRun = {};
    if (block.bold) blockRun.bold = true;
    if (block.italic) blockRun.italic = true;
    if (block.underline) blockRun.underline = true;
    if (block.color) blockRun.color = block.color;
    if (block.size) blockRun.size = block.size;
    if (Object.keys(blockRun).length) out += runProps(blockRun);

    out += '</w:pPr>';
    void o;
    return out;
  }

  function textRun(text, props) {
    if (text == null || text === '') return '';
    if (props && props.link && !props.color) props = Object.assign({}, props, { color: '0563C1', underline: props.underline === false ? false : true });
    const parts = String(text).split('\n');
    let out = '';
    parts.forEach((part, i) => {
      if (i) out += '<w:r><w:br/></w:r>';
      if (!part) return;
      out += `<w:r>${runProps(props)}<w:t xml:space="preserve">${X(part)}</w:t></w:r>`;
    });
    return out;
  }

  // Tramos con formato -> XML de runs (con enlaces); `base` es el formato del
  // contenedor (negrita de un encabezado de tabla, por ejemplo).
  function runsXml(runs, base, ctx) {
    let out = '';
    const special = (r) => (Boolean(r.note || r.comment) && ctx && ctx.addNote) || Boolean(r.ins || r.del);
    for (let i = 0; i < runs.length;) {
      if (special(runs[i])) {
        const r = runs[i];
        let chunk = textRun(r.text, Object.assign({}, base, r));
        if (r.ins || r.del) {
          const [who, when] = String(r.del || r.ins).split('|');
          if (ctx) ctx.trackId = (ctx.trackId || 0) + 1;
          const attrs = ` w:id="${900 + (ctx ? ctx.trackId : 1)}" w:author="${X(who || 'Autor')}" w:date="${X(when || '2026-01-01T00:00:00Z')}"`;
          if (r.del) chunk = chunk.replace(/<w:t( [^>]*)?>/g, '<w:delText$1>').replace(/<\/w:t>/g, '</w:delText>');
          chunk = `<w:${r.del ? 'del' : 'ins'}${attrs}>${chunk}</w:${r.del ? 'del' : 'ins'}>`;
        }
        if (r.link && ctx && ctx.addLink) chunk = linkWrap(r.link, chunk, ctx);
        if (r.comment && ctx && ctx.addComment) {
          const id = ctx.addComment(r.comment);
          chunk = `<w:commentRangeStart w:id="${id}"/>${chunk}<w:commentRangeEnd w:id="${id}"/>` +
            `<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${id}"/></w:r>`;
        }
        if (r.note && ctx && ctx.addNote) {
          const id = ctx.addNote(r.note);
          chunk += `<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:${ctx.endnotes ? 'endnote' : 'footnote'}Reference w:id="${id}"/></w:r>`;
        }
        out += chunk;
        i++;
        continue;
      }
      const link = runs[i].link;
      let j = i;
      let chunk = '';
      while (j < runs.length && runs[j].link === link && !special(runs[j])) {
        chunk += textRun(runs[j].text, Object.assign({}, base, runs[j]));
        j++;
      }
      out += link && ctx && ctx.addLink ? linkWrap(link, chunk, ctx) : chunk;
      i = j;
    }
    return out;
  }

  function runsOf(block, blockProps, ctx) {
    const base = {};
    if (blockProps.bold) base.bold = true;
    if (blockProps.italic) base.italic = true;
    if (blockProps.underline) base.underline = true;
    if (blockProps.color) base.color = blockProps.color;
    if (blockProps.size) base.size = blockProps.size;

    if (Array.isArray(block.runs) && block.runs.length) return runsXml(block.runs, base, ctx);
    return textRun(model.blockText(block), base);
  }

  // ------------------------------------------------------------- bloques

  // Enlace de un tramo: externo (relacion) o interno a un titulo (ancla).
  function linkWrap(url, chunk, ctx) {
    if (/^#/.test(url)) return `<w:hyperlink w:anchor="${X(url.slice(1))}" w:history="1">${chunk}</w:hyperlink>`;
    return `<w:hyperlink r:id="${ctx.addLink(url)}" w:history="1">${chunk}</w:hyperlink>`;
  }

  function emitParagraph(block, ctx) {
    if (block.type === 'pagebreak') {
      return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
    }
    let prefix = '';
    if (block.type === 'paragraph' && block.caption) {
      ctx.captions = ctx.captions || { figure: 0, table: 0 };
      const n = ++ctx.captions[block.caption];
      const word = block.caption === 'table' ? 'Tabla' : 'Figura';
      prefix = `<w:r><w:t xml:space="preserve">${word} </w:t></w:r><w:fldSimple w:instr=" SEQ ${word} \\* ARABIC "><w:r><w:t>${n}</w:t></w:r></w:fldSimple><w:r><w:t xml:space="preserve">. </w:t></w:r>`;
    }
    let inner = runsOf(block, block, ctx);
    const slug = block.type === 'heading' && ctx.slugs && ctx.slugs[block.id];
    if (slug) {
      ctx.bmId = (ctx.bmId || 0) + 1;
      inner = `<w:bookmarkStart w:id="${ctx.bmId}" w:name="${X(slug)}"/>${inner}<w:bookmarkEnd w:id="${ctx.bmId}"/>`;
    }
    return `<w:p>${paraProps(block, ctx)}${prefix}${inner}</w:p>`;
  }

  function emitList(block, ctx) {
    const items = block.items || [];
    return items.map((item, i) => {
      // Cada item es un parrafo con numeracion, que es como Word modela
      // una lista: permite seguir editandola con los controles de Word.
      const base = {
        bold: block.bold, italic: block.italic, underline: block.underline,
        color: block.color, size: block.size
      };
      const rr = block.itemRuns && block.itemRuns[i];
      const lvl = block.itemLevels && block.itemLevels[i] ? block.itemLevels[i] : 0;
      const pb = lvl ? Object.assign({}, block, { level: Math.min(2, (Number(block.level) || 0) + lvl) }) : block;
      return `<w:p>${paraProps(pb, ctx)}${rr ? runsXml(rr, base, ctx) : textRun(item, base)}</w:p>`;
    }).join('');
  }

  function fillOf(block, r, c, isHead) {
    const f = block.cellFill && block.cellFill[r + ',' + c];
    if (f && /^#[0-9a-f]{6}$/i.test(f)) return f.slice(1).toUpperCase();
    return isHead ? 'EEEEEE' : '';
  }

  function tblBorders(mode) {
    const line = (n, color) => `<w:${n} w:val="single" w:sz="4" w:space="0" w:color="${color}"/>`;
    const none = (n) => `<w:${n} w:val="nil"/>`;
    const sides = ['top', 'left', 'bottom', 'right'].map((n) => {
      if (mode === 'none') return none(n);
      if (mode === 'horizontal' && (n === 'left' || n === 'right')) return none(n);
      return line(n, '9E9E9E');
    }).join('');
    const insideH = mode === 'none' || mode === 'outer' ? none('insideH') : line('insideH', 'C8C8C8');
    const insideV = mode === 'none' || mode === 'outer' || mode === 'horizontal' ? none('insideV') : line('insideV', 'C8C8C8');
    return '<w:tblBorders>' + sides + insideH + insideV + '</w:tblBorders>';
  }

  function tcBorders(spec) {
    const sp = model.borderSpec(spec);
    if (!sp) return '';
    const on = sp === 'none' ? '' : sp;
    return '<w:tcBorders>' + [['t', 'top'], ['l', 'left'], ['b', 'bottom'], ['r', 'right']].map(([k, n]) =>
      on.includes(k) ? `<w:${n} w:val="single" w:sz="4" w:space="0" w:color="9E9E9E"/>` : `<w:${n} w:val="nil"/>`).join('') + '</w:tcBorders>';
  }

  function emitTable(block, ctx) {
    const rows = block.rows || [];
    const cols = rows.reduce((max, r) => Math.max(max, r.length), 1);
    const total = Math.round((ctx.contentWidth * PT_TO_TWIP) / cols);
    const fullW = Math.round(ctx.contentWidth * PT_TO_TWIP);
    const widths = Array.isArray(block.colWidths) && block.colWidths.length === cols
      ? block.colWidths.map(p => Math.max(1, Math.round(fullW * p / 100))) : new Array(cols).fill(total);
    const grid = widths.map(w => `<w:gridCol w:w="${w}"/>`).join('');

    const body = rows.map((row, r) => {
      const isHead = block.header !== false && r === 0;
      const cells = [];
      for (let c = 0; c < cols;) {
        const m = (block.merges || []).find(x => r >= x.r && r < x.r + x.rows && c >= x.c && c < x.c + x.cols);
        const span = m ? m.cols : 1;
        const text = row[c] == null ? '' : String(row[c]);
        const covered = !!m && m.r !== r;     // fila de continuacion de una combinacion vertical
        const rr = block.cellRuns && block.cellRuns[r + ',' + c];
        const runs = covered ? '' : (rr ? runsXml(rr, { bold: isHead }, ctx) : textRun(text, { bold: isHead }));
        const vm = m && m.rows > 1 ? (m.r === r ? '<w:vMerge w:val="restart"/>' : '<w:vMerge/>') : '';
        cells.push(
          `<w:tc><w:tcPr><w:tcW w:w="${widths.slice(c, c + span).reduce((a, x) => a + x, 0)}" w:type="dxa"/>` +
          (span > 1 ? `<w:gridSpan w:val="${span}"/>` : '') + vm +
          (block.cellBorders && block.cellBorders[r + ',' + c] ? tcBorders(block.cellBorders[r + ',' + c]) : '') +
          (fillOf(block, r, c, isHead) ? `<w:shd w:val="clear" w:color="auto" w:fill="${fillOf(block, r, c, isHead)}"/>` : '') +
          `</w:tcPr><w:p>${paraProps({ type: 'paragraph' }, ctx)}${runs}</w:p></w:tc>`
        );
        c += span;
      }
      return `<w:tr>${cells.join('')}</w:tr>`;
    }).join('');

    return (
      '<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/>' +
      tblBorders(block.borders) +
      (block.colWidths ? '<w:tblLayout w:type="fixed"/>' : '') + '</w:tblPr>' +
      `<w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl>` +
      // Word exige un parrafo despues de una tabla.
      '<w:p><w:pPr><w:spacing w:after="0"/></w:pPr></w:p>'
    );
  }

  // Medidas naturales (px) de PNG, GIF y JPEG; null si no se reconoce.
  function imageSize(b) {
    try {
      if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) return { w: ((b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19]) >>> 0, h: ((b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23]) >>> 0 };
      if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49) return { w: b[6] | (b[7] << 8), h: b[8] | (b[9] << 8) };
      if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
        let i = 2;
        while (i + 9 < b.length) {
          if (b[i] !== 0xff) { i++; continue; }
          const m = b[i + 1];
          if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
          i += 2 + ((b[i + 2] << 8) | b[i + 3]);
        }
      }
    } catch (e) { /* sin medidas */ }
    return null;
  }

  // Tabla de contenido: campo TOC de Word con las entradas ya escritas (Word las
  // renumera al actualizar el campo; aca no se conocen los numeros de pagina).
  function emitToc(block, doc) {
    if (block.kind) {
      const word = block.kind === 'table' ? 'Tabla' : 'Figura';
      const title = block.kind === 'table' ? 'Índice de tablas' : 'Índice de figuras';
      const items = model.captionList(doc.blocks, block.kind);
      const begin = `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\h \\z \\c "${word}" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>`;
      const head = `<w:p><w:pPr><w:spacing w:before="120" w:after="120"/></w:pPr>${begin}<w:r><w:rPr><w:b/><w:sz w:val="28"/></w:rPr><w:t>${title}</w:t></w:r></w:p>`;
      const lines = items.length ? items : [{ n: 0, text: '(Sin rótulos)' }];
      return head + lines.map((c, i) =>
        `<w:p><w:pPr><w:spacing w:after="60"/></w:pPr><w:r><w:t xml:space="preserve">${c.n ? `${word} ${c.n}. ` : ''}${X(c.text)}</w:t></w:r>${i === lines.length - 1 ? '<w:r><w:fldChar w:fldCharType="end"/></w:r>' : ''}</w:p>`).join('');
    }
    const max = Math.min(3, Math.max(1, block.levels || 3));
    const entries = model.outline(doc).filter((h) => h.level <= max && h.text.trim());

    const lines = entries.length ? entries : [{ level: 1, text: '(Sin títulos)' }];
    const begin = `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-${max}" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>`;
    const title = `<w:p><w:pPr><w:spacing w:before="120" w:after="120"/></w:pPr>${begin}<w:r><w:rPr><w:b/><w:sz w:val="28"/></w:rPr><w:t>Contenido</w:t></w:r></w:p>`;
    const body = lines.map((h, i) => {
      const ind = (h.level - 1) * 360;
      return `<w:p><w:pPr><w:spacing w:after="60"/>${ind ? `<w:ind w:left="${ind}"/>` : ''}</w:pPr>` +
        `<w:r><w:t xml:space="preserve">${X(h.text)}</w:t></w:r>${i === lines.length - 1 ? '<w:r><w:fldChar w:fldCharType="end"/></w:r>' : ''}</w:p>`;
    }).join('');
    return title + body;
  }

  function emitImage(block, ctx) {
    if (!model.isSafeImageSrc(block.src)) return '';
    const media = ctx.addMedia(block.src);
    if (!media) return '';
    const maxW = Math.round(ctx.contentWidth * PT_TO_EMU);
    const maxH = Math.round(ctx.contentHeight * PT_TO_EMU);
    const nat = imageSize(media.bytes);
    const crop = block.crop || null;
    const vis = nat && nat.w > 0 && nat.h > 0
      ? (nat.h * (1 - (crop ? (crop.t + crop.b) / 100 : 0))) / (nat.w * (1 - (crop ? (crop.l + crop.r) / 100 : 0))) : null;
    let cx = block.width ? Number(block.width) * PX_TO_EMU : (nat && nat.w ? Math.min(maxW, nat.w * PX_TO_EMU) : maxW);
    let cy = block.height ? Number(block.height) * PX_TO_EMU : (vis ? cx * vis : Math.round(maxH * 0.6));
    const scale = Math.min(1, maxW / cx, maxH / cy);
    cx = Math.round(cx * scale);
    cy = Math.round(cy * scale);
    ctx.imageSeq++;
    const id = ctx.imageSeq;
    const name = `Imagen ${id}`;
    const wrap = block.wrap === 'left' || block.wrap === 'right' ? block.wrap : null;
    const head = wrap
      ? '<wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="251658240" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="0">' +
        '<wp:simplePos x="0" y="0"/>' +
        `<wp:positionH relativeFrom="margin"><wp:align>${wrap}</wp:align></wp:positionH>` +
        '<wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV>' +
        `<wp:extent cx="${cx}" cy="${cy}"/>` +
        '<wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapSquare wrapText="bothSides"/>'
      : '<wp:inline distT="0" distB="0" distL="0" distR="0">' +
        `<wp:extent cx="${cx}" cy="${cy}"/>` +
        '<wp:effectExtent l="0" t="0" r="0" b="0"/>';
    const srcRect = crop ? `<a:srcRect l="${crop.l * 1000}" t="${crop.t * 1000}" r="${crop.r * 1000}" b="${crop.b * 1000}"/>` : '';
    return (
      `<w:p><w:pPr>${wrap ? '' : '<w:jc w:val="center"/>'}<w:spacing w:after="120"/></w:pPr><w:r><w:drawing>` +
      head +
      `<wp:docPr id="${id}" name="${X(name)}" descr="${X(block.alt || '')}"/>` +
      '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
      '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      '<pic:pic><pic:nvPicPr>' +
      `<pic:cNvPr id="${id}" name="${X(media.file)}" descr="${X(block.alt || '')}"/><pic:cNvPicPr/>` +
      '</pic:nvPicPr>' +
      `<pic:blipFill><a:blip r:embed="${media.rid}"/>${srcRect}<a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
      '</pic:pic></a:graphicData></a:graphic>' + (wrap ? '</wp:anchor>' : '</wp:inline>') + '</w:drawing></w:r></w:p>' +
      (block.alt ? `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="120"/></w:pPr>` +
        `<w:r>${runProps({ italic: true, color: '666666', size: 9 })}<w:t xml:space="preserve">${X(block.alt)}</w:t></w:r></w:p>` : '')
    );
  }

  // ------------------------------------------------------------- partes

  /**
   * theme1.xml: el tema de Office estandar. No se copia el del original (eso
   * obligaria a arrastrar sus relaciones y el paquete se rompe si algo no
   * cuadra), sino uno propio y valido. Sirve para que las referencias de tema
   * que Word pone por defecto tengan contra que resolverse, y para que el
   * documento no salga como "sin tema" al abrirlo en otro programa.
   */
  function theme() {
    const CLR = (tag, val, sys) => `<a:${tag}><a:sysClr val="windowText" lastClr="000000"/></a:${tag}>`;
    const colors = [
      ['dk1', 'sysClr', 'windowText', '000000'], ['lt1', 'sysClr', 'window', 'FFFFFF'],
      ['dk2', 'srgbClr', '44546A', null], ['lt2', 'srgbClr', 'E7E6E6', null],
      ['accent1', 'srgbClr', '4472C4', null], ['accent2', 'srgbClr', 'ED7D31', null],
      ['accent3', 'srgbClr', 'A5A5A5', null], ['accent4', 'srgbClr', 'FFC000', null],
      ['accent5', 'srgbClr', '5B9BD5', null], ['accent6', 'srgbClr', '70AD47', null],
      ['hlink', 'srgbClr', '0563C1', null], ['folHlink', 'srgbClr', '954F72', null]
    ];
    const clrXml = colors.map(([tag, kind, val]) =>
      `<a:${tag}><a:${kind} val="${val}"/></a:${tag}>`).join('');
    const font = (tag, latin) =>
      `<a:${tag}><a:latin typeface="${latin}"/><a:ea typeface=""/><a:cs typeface=""/></a:${tag}>`;
    const fillStyle = (n) =>
      `<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>` +
      `<a:gradFill rotWithShape="1"><a:gsLst>` +
      [0, 50000, 100000].map(p => `<a:gs pos="${p}"><a:schemeClr val="phClr"><a:tint val="50000"/><a:satMod val="300000"/></a:schemeClr></a:gs>`).join('') +
      `</a:gsLst><a:lin ang="16200000" scaled="0"/></a:gradFill>` +
      `<a:gradFill rotWithShape="1"><a:gsLst>` +
      [0, 50000, 100000].map(p => `<a:gs pos="${p}"><a:schemeClr val="phClr"><a:shade val="30000"/><a:satMod val="200000"/></a:schemeClr></a:gs>`).join('') +
      `</a:gsLst><a:lin ang="16200000" scaled="0"/></a:gradFill>` +
      `</a:fillStyleLst>`;
    const lineStyle = '<a:lnStyleLst>' +
      [6350, 12700, 19050].map(w => `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>`).join('') +
      '</a:lnStyleLst>';
    const effectStyle = '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle>' +
      '<a:effectStyle><a:effectLst/></a:effectStyle>' +
      '<a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>';
    const bgFillStyle = '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
      '<a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/><a:satMod val="170000"/></a:schemeClr></a:solidFill>' +
      '<a:solidFill><a:schemeClr val="phClr"><a:shade val="80000"/><a:satMod val="130000"/></a:schemeClr></a:solidFill></a:bgFillStyleLst>';

    return XML_HEAD +
      '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office">' +
      '<a:themeElements>' +
      `<a:clrScheme name="Office">${clrXml}</a:clrScheme>` +
      `<a:fontScheme name="Office">${font('majorFont', 'Calibri Light')}${font('minorFont', 'Calibri')}</a:fontScheme>` +
      `<a:fmtScheme name="Office">${fillStyle()}${lineStyle}${effectStyle}${bgFillStyle}</a:fmtScheme>` +
      '</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>';
  }

  /**
   * fontTable.xml: declara las fuentes que el documento usa de verdad. Se
   * recorren bloques y tramos para no declarar fuentes que no aparecen, que es
   * lo que hacia Word al abrir el archivo.
   */
  function fontTable(doc) {
    const vistos = Object.create(null);
    const add = (name) => {
      const v = String(name || '').trim();
      if (!v || vistos[v]) return;
      if (!/^[A-Za-z0-9 \-_',.()]+$/.test(v)) return;
      vistos[v] = true;
    };
    const guardar = (props) => {
      if (!props) return;
      add(props.font || props.fontFamily);
    };
    const st = doc.styles || {};
    for (const k of Object.keys(st)) guardar(st[k]);
    for (const b of (doc.blocks || [])) {
      guardar(b);
      if (Array.isArray(b.runs)) for (const r of b.runs) guardar(r);
      if (Array.isArray(b.cellRuns)) for (const r of b.cellRuns) guardar(r);
    }
    // Calibri y Calibri Light siempre: son las que declara el tema.
    add('Calibri');
    add('Calibri Light');
    const nombres = Object.keys(vistos).sort();
    const fonts = nombres.map(n => `<w:font w:name="${X(n)}"><w:charset w:val="00"/><w:family w:val="swiss"/><w:pitch w:val="variable"/></w:font>`).join('');
    return XML_HEAD +
      '<w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
      `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${fonts}</w:fonts>`;
  }

  function contentTypes(ctx) {
    const defaults = [
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
      '<Default Extension="xml" ContentType="application/xml"/>'
    ];
    for (const ext of Object.keys(ctx.mediaByExt)) {
      defaults.push(`<Default Extension="${ext}" ContentType="${ctx.mediaByExt[ext]}"/>`);
    }
    const overrides = [
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
      '<Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>',
      '<Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/>',
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
    ];
    if (ctx.hasLists) {
      overrides.push('<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>');
    }
    if (ctx.notes && ctx.notes.length) overrides.push(ctx.endnotes ? '<Override PartName="/word/endnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml"/>' : '<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>');
    if (ctx.comments && ctx.comments.length) overrides.push('<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>');
    if (ctx.headerFooter && ctx.headerFooter.header) {
      overrides.push('<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>');
    }
    if (ctx.headerFooter && ctx.headerFooter.footer) {
      overrides.push('<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>');
    }
    return XML_HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      defaults.join('') + overrides.join('') + '</Types>';
  }

  function rootRels() {
    return XML_HEAD +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
      '</Relationships>';
  }

  function coreProps(doc) {
    const iso = (v) => (v ? new Date(v).toISOString().replace(/\.\d+Z$/, 'Z') : new Date().toISOString().replace(/\.\d+Z$/, 'Z'));
    return XML_HEAD +
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
      'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      `<dc:title>${X(doc.title)}</dc:title>` +
      (doc.meta.author ? `<dc:creator>${X(doc.meta.author)}</dc:creator>` : '') +
      (doc.meta.subject ? `<dc:subject>${X(doc.meta.subject)}</dc:subject>` : '') +
      (doc.meta.keywords ? `<cp:keywords>${X(doc.meta.keywords)}</cp:keywords>` : '') +
      `<dcterms:created xsi:type="dcterms:W3CDTF">${iso(doc.meta.created)}</dcterms:created>` +
      `<dcterms:modified xsi:type="dcterms:W3CDTF">${iso(doc.meta.modified)}</dcterms:modified>` +
      '</cp:coreProperties>';
  }

  function appProps(doc) {
    const s = model.stats(doc);
    return XML_HEAD +
      '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
      'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
      '<Application>MC Browser</Application><DocSecurity>0</DocSecurity>' +
      `<Paragraphs>${s.blocks}</Paragraphs><Words>${s.words}</Words><Characters>${s.chars}</Characters>` +
      `<Lines>${s.blocks}</Lines><Pages>${s.pages}</Pages>` +
      '<Company></Company><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc>' +
      '<HyperlinksChanged>false</HyperlinksChanged><ScaleCrop>false</ScaleCrop>' +
      '</Properties>';
  }

  function documentRels(ctx) {
    const rels = [
      '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
      '<Relationship Id="rIdTheme" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>',
      '<Relationship Id="rIdFonts" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable" Target="fontTable.xml"/>'
    ];
    if (ctx.hasLists) {
      rels.push('<Relationship Id="rIdNum" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>');
    }
    for (const m of ctx.media) {
      rels.push(`<Relationship Id="${m.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${m.target}"/>`);
    }
    for (const l of ctx.links || []) {
      rels.push(`<Relationship Id="${l.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${X(l.url)}" TargetMode="External"/>`);
    }
    if (ctx.notes && ctx.notes.length) rels.push(ctx.endnotes ? '<Relationship Id="rIdNotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes" Target="endnotes.xml"/>' : '<Relationship Id="rIdNotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>');
    if (ctx.comments && ctx.comments.length) rels.push('<Relationship Id="rIdComments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>');
    if (ctx.headerFooter && ctx.headerFooter.header) {
      rels.push('<Relationship Id="rIdHeader1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>');
    }
    if (ctx.headerFooter && ctx.headerFooter.footer) {
      rels.push('<Relationship Id="rIdFooter1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>');
    }
    return XML_HEAD +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      rels.join('') + '</Relationships>';
  }

  // rPr/pPr de un estilo del documento sobre el estilo base de Word.
  function styleOverride(st, base) {
    if (!st) return base;
    const b = Object.assign({}, base, st);
    let ppr = base.pPr || '';
    if (st.lineHeight) {
      const line = Math.round(Number(st.lineHeight) * 240);
      ppr = /<w:spacing /.test(ppr) ? ppr.replace('<w:spacing ', `<w:spacing w:line="${line}" w:lineRule="auto" `) : ppr + `<w:spacing w:line="${line}" w:lineRule="auto"/>`;
    }
    if (st.align && st.align !== 'left') {
      const jc = `<w:jc w:val="${{ center: 'center', right: 'right', justify: 'both' }[st.align]}"/>`;
      // El esquema pide jc antes de outlineLvl.
      ppr = ppr.includes('<w:outlineLvl') ? ppr.replace('<w:outlineLvl', jc + '<w:outlineLvl') : ppr + jc;
    }
    const fam = st.font ? X(String(st.font)) : null;
    let rpr = '';
    if (fam) rpr += `<w:rFonts w:ascii="${fam}" w:hAnsi="${fam}" w:cs="${fam}"/>`;
    const bold = st.bold !== undefined ? st.bold : base.bold;
    if (bold === true) rpr += '<w:b/><w:bCs/>'; else if (bold === false) rpr += '<w:b w:val="0"/><w:bCs w:val="0"/>';
    const it = st.italic !== undefined ? st.italic : base.italic;
    if (it === true) rpr += '<w:i/><w:iCs/>'; else if (it === false) rpr += '<w:i w:val="0"/><w:iCs w:val="0"/>';
    const color = st.color ? String(st.color).replace('#', '').slice(0, 6).toUpperCase() : base.color;
    if (color) rpr += `<w:color w:val="${X(color)}"/>`;
    const size = st.size ? st.size * 2 : base.size;
    if (size) rpr += `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>`;
    return Object.assign(b, { pPr: ppr, rPr: rpr });
  }

  function styles(docStyles) {
    const ds = docStyles || {};
    const h = (n, base) => styleOverride(ds['heading' + n], base);
    const h1 = h(1, { pPr: '<w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/>', bold: true, size: 34 });
    const h2 = h(2, { pPr: '<w:keepNext/><w:spacing w:before="200" w:after="100"/><w:outlineLvl w:val="1"/>', bold: true, size: 28 });
    const h3 = h(3, { pPr: '<w:keepNext/><w:spacing w:before="160" w:after="80"/><w:outlineLvl w:val="2"/>', bold: true, size: 24 });
    const q = styleOverride(ds.quote, { pPr: '<w:ind w:left="360"/><w:spacing w:before="80" w:after="80"/>', italic: true, color: '444444' });
    const normal = ds.paragraph ? styleOverride(ds.paragraph, { pPr: '' }) : null;
    const normalXml = normal
      ? `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/>${normal.pPr ? `<w:pPr>${normal.pPr}</w:pPr>` : ''}${normal.rPr ? `<w:rPr>${normal.rPr}</w:rPr>` : ''}</w:style>`
      : '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>';
    const hx = (id, name, o) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>` +
      `<w:pPr>${o.pPr}</w:pPr><w:rPr>${o.rPr || ('<w:b/><w:bCs/>' + `<w:sz w:val="${o.size}"/><w:szCs w:val="${o.size}"/>`)}</w:rPr></w:style>`;
    return XML_HEAD +
      `<w:styles ${NS}>` +
      '<w:docDefaults><w:rPrDefault><w:rPr>' +
      '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/>' +
      '<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="es-ES"/>' +
      '</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
      normalXml +
      hx('Heading1', 'heading 1', h1) + hx('Heading2', 'heading 2', h2) + hx('Heading3', 'heading 3', h3) +
      '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
      `<w:pPr>${q.pPr}</w:pPr><w:rPr>${q.rPr}</w:rPr></w:style>` +
      '<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="200"/><w:jc w:val="center"/></w:pPr><w:rPr><w:b/><w:sz w:val="20"/></w:rPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
      '<w:pPr><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>' +
      '</w:styles>';
  }

  function numbering() {
    const bulletLevels = [0, 1, 2].map(ilvl =>
      `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="bullet"/>` +
      `<w:lvlText w:val="${['•', '◦', '▪'][ilvl]}"/><w:lvlJc w:val="left"/>` +
      `<w:pPr><w:ind w:left="${720 + ilvl * 360}" w:hanging="360"/></w:pPr>` +
      '<w:rPr><w:rFonts w:hint="default"/></w:rPr></w:lvl>').join('');

    const decimalLevels = [0, 1, 2].map(ilvl =>
      `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${ilvl ? 'lowerLetter' : 'decimal'}"/>` +
      `<w:lvlText w:val="%${ilvl + 1}."/><w:lvlJc w:val="left"/>` +
      `<w:pPr><w:ind w:left="${720 + ilvl * 360}" w:hanging="360"/></w:pPr></w:lvl>`).join('');

    return XML_HEAD + `<w:numbering ${NS}>` +
      '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>' + bulletLevels + '</w:abstractNum>' +
      '<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>' + decimalLevels + '</w:abstractNum>' +
      '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
      '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>' +
      '</w:numbering>';
  }

  // ---------------------------------------------------------------- entrada

  // Encabezado y pie: un parrafo de texto y, en el pie, el numero de pagina
  // como campo PAGE (Word lo recalcula solo en cada hoja).
  // {n} = numero de pagina, {total} = cantidad de paginas (campos PAGE / NUMPAGES).
  function hfParagraph(text, align) {
    const jc = align && align !== 'left' ? `<w:jc w:val="${align}"/>` : '';
    const rpr = '<w:rPr><w:sz w:val="18"/></w:rPr>';
    let runs = '';
    String(text).split(/(\{n\}|\{total\})/).forEach((part) => {
      if (!part) return;
      if (part === '{n}') runs += `<w:fldSimple w:instr=" PAGE "><w:r>${rpr}<w:t>1</w:t></w:r></w:fldSimple>`;
      else if (part === '{total}') runs += `<w:fldSimple w:instr=" NUMPAGES "><w:r>${rpr}<w:t>1</w:t></w:r></w:fldSimple>`;
      else runs += `<w:r>${rpr}<w:t xml:space="preserve">${X(part)}</w:t></w:r>`;
    });
    return `<w:p><w:pPr><w:spacing w:after="0"/>${jc}</w:pPr>${runs}</w:p>`;
  }

  function pageNumberParagraph(align) {
    const jc = align && align !== 'left' ? `<w:jc w:val="${align}"/>` : '';
    return `<w:p><w:pPr><w:spacing w:after="0"/>${jc}</w:pPr>` +
      '<w:fldSimple w:instr=" PAGE "><w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:t>1</w:t></w:r></w:fldSimple></w:p>';
  }

  function headerFooterParts(page) {
    const wrap = (tag, inner) => XML_HEAD + `<w:${tag} ${NS}>${inner}</w:${tag}>`;
    const out = { header: null, footer: null };
    if (page.header || page.watermark) {
      const wm = page.watermark
        ? '<w:p><w:pPr><w:spacing w:after="0"/></w:pPr><w:r><w:rPr><w:noProof/></w:rPr><w:pict>' +
          '<v:shapetype id="_x0000_t136" coordsize="21600,21600" o:spt="136" adj="10800" path="m@7,l@8,m@5,21600l@6,21600e"><v:path textpathok="t" o:connecttype="custom"/><v:textpath on="t" fitshape="t"/></v:shapetype>' +
          `<v:shape id="PowerPlusWaterMarkObject1" o:spid="_x0000_s2049" type="#_x0000_t136" style="position:absolute;margin-left:0;margin-top:0;width:420pt;height:120pt;rotation:315;z-index:-251658752;mso-position-horizontal:center;mso-position-horizontal-relative:margin;mso-position-vertical:center;mso-position-vertical-relative:margin" o:allowincell="f" fillcolor="silver" stroked="f"><v:fill opacity=".5"/><v:textpath style="font-family:&quot;Arial&quot;;font-size:1pt" string="${X(page.watermark)}"/></v:shape></w:pict></w:r></w:p>` : '';
      out.header = wrap('hdr', (page.header ? hfParagraph(page.header, 'left') : '') + wm);
    }
    const foot = [];
    if (page.footer) foot.push(hfParagraph(page.footer, 'left'));
    if (page.pageNumbers) foot.push(pageNumberParagraph(page.pageNumbers));
    if (foot.length) out.footer = wrap('ftr', foot.join(''));
    return out;
  }

  /**
   * docToDocxParts(doc, opts) -> { parts: [{name, data}], warnings: [] }
   * No devuelve bytes: el ZIP lo arma el llamador (core/zip.js), asi el
   * mismo codigo sirve para el proceso main y para el renderer.
   */
  function docToDocxParts(doc, opts) {
    const o = opts || {};
    const warnings = (o.warnings || []).slice();
    const page = Object.assign({}, model.PAGE.A4, doc.page || {});
    const mg = model.margins(page);
    const media = [];
    const mediaByExt = Object.create(null);

    const ctx = {
      pageWidth: page.width,
      pageHeight: page.height,
      margin: page.margin,
      contentWidth: Math.max(72, page.width - mg.left - mg.right),
      contentHeight: Math.max(72, page.height - mg.top - mg.bottom),
      links: [],
      addLink(url) {
        let e = this.links.find(l => l.url === url);
        if (!e) { e = { rid: `rIdLink${this.links.length + 1}`, url }; this.links.push(e); }
        return e.rid;
      },
      slugs: (() => { const a = model.headingSlugs(doc.blocks || []); const m = Object.create(null); (doc.blocks || []).forEach((b, i) => { if (a[i] && b.id) m[b.id] = a[i]; }); return m; })(),
      notes: [],
      endnotes: !!(page && page.endnotes),
      comments: [],
      addNote(text) { this.notes.push(text); return this.notes.length; },
      addComment(text) { this.comments.push(text); return this.comments.length - 1; },
      media,
      mediaByExt,
      hasLists: (doc.blocks || []).some(b => b.type === 'list'),
      imageSeq: 0,
      addMedia(src) {
        const parsed = /^data:image\/([a-zA-Z0-9.+-]+);base64,([\s\S]*)$/i.exec(src);
        if (!parsed) return null;
        const raw = parsed[1].toLowerCase();
        const ext = raw === 'jpeg' ? 'jpg' : raw === 'svg+xml' ? 'svg' : raw;
        const mime = raw === 'jpg' ? 'image/jpeg' : `image/${raw}`;
        const bytes = base64ToBytes(parsed[2]);
        if (!bytes || !bytes.length) return null;
        const entry = {
          rid: `rIdImg${media.length + 1}`,
          target: `media/image${media.length + 1}.${ext}`,
          file: `image${media.length + 1}.${ext}`,
          ext, bytes
        };
        media.push(entry);
        mediaByExt[ext] = mime;
        return entry;
      }
    };

    const body = [];
    for (const block of doc.blocks || []) {
      if (block.type === 'heading' || block.type === 'paragraph' || block.type === 'quote' ||
          block.type === 'code' || block.type === 'pagebreak' || block.type === 'hr') {
        body.push(emitParagraph(block, ctx));
      } else if (block.type === 'list') {
        body.push(emitList(block, ctx));
      } else if (block.type === 'toc') {
        body.push(emitToc(block, doc));
      } else if (block.type === 'table') {
        body.push(emitTable(block, ctx));
      } else if (block.type === 'image') {
        const xml = emitImage(block, ctx);
        if (xml) body.push(xml);
        else warnings.push('una imagen fue descartada: formato no soportado');
      }
    }

    const hf = headerFooterParts(page);
    ctx.headerFooter = hf;
    const tw = (pt) => Math.round(pt * PT_TO_TWIP);
    const sectPr =
      '<w:sectPr>' +
      (hf.header ? '<w:headerReference w:type="default" r:id="rIdHeader1"/>' : '') +
      (hf.footer ? '<w:footerReference w:type="default" r:id="rIdFooter1"/>' : '') +
      `<w:pgSz w:w="${tw(page.width)}" w:h="${tw(page.height)}"${(page.orientation === 'landscape' || page.width > page.height) ? ' w:orient="landscape"' : ''}/>` +
      `<w:pgMar w:top="${tw(mg.top)}" w:right="${tw(mg.right)}" w:bottom="${tw(mg.bottom)}" w:left="${tw(mg.left)}" ` +
      'w:header="708" w:footer="708" w:gutter="0"/>' +
      (page.pageStart > 1 ? `<w:pgNumType w:start="${Number(page.pageStart)}"/>` : '') +
      (page.columns > 1 ? `<w:cols w:num="${Number(page.columns)}" w:space="708"/>` : '') +
      (page.titlePage ? '<w:titlePg/>' : '') +
      '</w:sectPr>';

    const document = XML_HEAD + `<w:document ${NS}><w:body>${body.join('')}${sectPr}</w:body></w:document>`;

    const parts = [
      { name: '[Content_Types].xml', data: contentTypes(ctx) },
      { name: '_rels/.rels', data: rootRels() },
      { name: 'docProps/core.xml', data: coreProps(doc) },
      { name: 'docProps/app.xml', data: appProps(doc) },
      { name: 'word/_rels/document.xml.rels', data: documentRels(ctx) },
      { name: 'word/styles.xml', data: styles(doc.styles) },
      { name: 'word/theme/theme1.xml', data: theme() },
      { name: 'word/fontTable.xml', data: fontTable(doc) },
      { name: 'word/document.xml', data: document }
    ];
    if (ctx.hasLists) parts.push({ name: 'word/numbering.xml', data: numbering() });
    if (ctx.notes.length) {
      const para = (t, extra) => `<w:p><w:pPr><w:spacing w:after="0"/></w:pPr>${extra || ''}<w:r><w:t xml:space="preserve">${X(t)}</w:t></w:r></w:p>`;
      const K = ctx.endnotes ? 'endnote' : 'footnote';
      const fn = ctx.notes.map((t, i) => `<w:${K} w:id="${i + 1}"><w:p><w:pPr><w:spacing w:after="0"/></w:pPr><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:${K}Ref/></w:r><w:r><w:t xml:space="preserve"> ${X(t)}</w:t></w:r></w:p></w:${K}>`).join('');
      parts.push({ name: `word/${K}s.xml`, data: XML_HEAD + `<w:${K}s ${NS}>` +
        `<w:${K} w:type="separator" w:id="-1"><w:p><w:pPr><w:spacing w:after="0"/></w:pPr><w:r><w:separator/></w:r></w:p></w:${K}>` +
        `<w:${K} w:type="continuationSeparator" w:id="0"><w:p><w:pPr><w:spacing w:after="0"/></w:pPr><w:r><w:continuationSeparator/></w:r></w:p></w:${K}>` +
        fn + `</w:${K}s>` });
    }
    if (ctx.comments.length) {
      const cm = ctx.comments.map((t, i) => {
        const hm = /^\[([^|\]]*)\|([^\]]*)\]/.exec(t);
        const who = (hm && hm[1].trim()) || 'Autor';
        const when = hm && /^\d{4}-\d\d-\d\dT[\d:]+Z?$/.test(hm[2]) ? ` w:date="${X(hm[2].endsWith('Z') ? hm[2] : hm[2] + 'Z')}"` : '';
        return `<w:comment w:id="${i}" w:author="${X(who)}"${when} w:initials="${X(who.slice(0, 2).toUpperCase())}"><w:p><w:r><w:t xml:space="preserve">${X(t)}</w:t></w:r></w:p></w:comment>`;
      }).join('');
      parts.push({ name: 'word/comments.xml', data: XML_HEAD + `<w:comments ${NS}>${cm}</w:comments>` });
    }
    if (hf.header) parts.push({ name: 'word/header1.xml', data: hf.header });
    if (hf.footer) parts.push({ name: 'word/footer1.xml', data: hf.footer });

    for (const m of media) {
      parts.push({ name: `word/${m.target}`, data: m.bytes, binary: true });
    }
    return { parts, warnings, mediaCount: media.length };
  }

  /** atob existe en Chromium y en Node >= 16; Buffer es el respaldo. */
  function base64ToBytes(b64) {
    const clean = String(b64).replace(/\s+/g, '');
    if (typeof atob === 'function') {
      const bin = atob(clean);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    if (typeof Buffer === 'function') return new Uint8Array(Buffer.from(clean, 'base64'));
    return new Uint8Array(0);
  }

  return { docToDocxParts, emitParagraph, emitTable, runProps, paraProps, styles, numbering, theme, fontTable, base64ToBytes, NS, XML_HEAD };
});

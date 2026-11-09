'use strict';
/**
 * MC Browser -- modulo document-editor / core/odt-write.js
 *
 * Documento -> paquete OpenDocument Text (.odt). Titulos, parrafos con
 * formato en linea, listas, citas, codigo, tablas, imagenes, notas al pie,
 * saltos de pagina y configuracion de pagina (tamano, margenes, columnas).
 * Devuelve las partes del ZIP (mimetype primero); el llamador arma el archivo.
 */
(function (root, factory) {
  const mod = factory(typeof require === 'function' && typeof module === 'object' ? { model: require('./model') } : { model: root.MCDoc.model });
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else { root.MCDoc = root.MCDoc || {}; root.MCDoc.odtWrite = mod; }
})(typeof self !== 'undefined' ? self : this, function (deps) {
  const { model } = deps;
  const X = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
  const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" office:version="1.2"';
  const cm = (pt) => (Number(pt) * 2.54 / 72).toFixed(3) + 'cm';
  const pxCm = (px) => (Number(px) * 2.54 / 96).toFixed(3) + 'cm';
  const HEX = /^#[0-9a-fA-F]{6}$/;

  function convert(doc) {
    const autoText = new Map();   // clave -> nombre de estilo de texto
    const autoPara = new Map();
    const media = [];
    let tcount = 0, pcount = 0, imgN = 0, frameN = 0;

    const textStyle = (r) => {
      const props = [];
      if (r.bold) props.push('fo:font-weight="bold"');
      if (r.italic) props.push('fo:font-style="italic"');
      if (r.underline) props.push('style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"');
      if (r.strike) props.push('style:text-line-through-style="solid"');
      if (r.color && HEX.test(r.color)) props.push(`fo:color="${r.color}"`);
      if (r.highlight && HEX.test(r.highlight)) props.push(`fo:background-color="${r.highlight}"`);
      if (r.font) props.push(`style:font-name="${X(r.font)}" fo:font-family="${X(r.font)}"`);
      if (r.size) props.push(`fo:font-size="${Number(r.size)}pt"`);
      if (!props.length) return '';
      const key = props.join(' ');
      if (!autoText.has(key)) autoText.set(key, 'T' + (++tcount));
      return autoText.get(key);
    };

    const paraStyle = (parent, extra, brk) => {
      const key = parent + '|' + (extra || '') + '|' + (brk || '');
      if (!autoPara.has(key)) autoPara.set(key, { name: 'P' + (++pcount), parent, extra: extra || '', brk: brk || '' });
      return autoPara.get(key).name;
    };

    const alignProp = (b) => (b.align ? `fo:text-align="${b.align === 'justify' ? 'justify' : b.align === 'right' ? 'end' : b.align === 'center' ? 'center' : 'start'}"` : '');
    const blockProps = (b) => {
      const p = [alignProp(b)];
      if (b.indent && !b.hanging) p.push(`fo:margin-left="${(Number(b.indent) * 0.5).toFixed(2)}cm"`);
      if (b.hanging) p.push(`fo:margin-left="${((Number(b.indent || 0) * 18 + Number(b.hanging)) * 2.54 / 72).toFixed(3)}cm"`, `fo:text-indent="-${cm(b.hanging)}"`);
      else if (b.firstLine) p.push(`fo:text-indent="${cm(b.firstLine)}"`);
      if (b.lineHeight) p.push(`fo:line-height="${Math.round(Number(b.lineHeight) * 100)}%"`);
      if (b.spaceBefore != null) p.push(`fo:margin-top="${cm(b.spaceBefore)}"`);
      if (b.spaceAfter != null) p.push(`fo:margin-bottom="${cm(b.spaceAfter)}"`);
      return p.filter(Boolean).join(' ');
    };

    const runsXml = (runs) => (runs || []).map((r) => {
      if (!r || r.text == null || r.text === '') return '';
      let t = X(r.text).replace(/\n/g, '<text:line-break/>').replace(/ {2,}/g, (m) => ' <text:s text:c="' + (m.length - 1) + '"/>').replace(/\t/g, '<text:tab/>');
      const st = textStyle(r);
      if (st) t = `<text:span text:style-name="${st}">${t}</text:span>`;
      if (r.link) t = `<text:a xlink:type="simple" xlink:href="${X(r.link)}">${t}</text:a>`;
      if (r.note) t += `<text:note text:note-class="footnote"><text:note-body><text:p text:style-name="Standard">${X(r.note)}</text:p></text:note-body></text:note>`;
      return t;
    }).join('');
    const runsOf = (text, rr) => (Array.isArray(rr) && rr.length ? rr : [{ text: text || '' }]);

    const para = (b, parent) => {
      const brk = b.__brk ? 'page' : '';
      const st = paraStyle(parent, blockProps(b), brk);
      return `<text:p text:style-name="${st}">${runsXml(runsOf(b.text, b.runs))}</text:p>`;
    };

    const cellXml = (b, r, c, isHead) => {
      const m = (b.merges || []).find((x) => r >= x.r && r < x.r + x.rows && c >= x.c && c < x.c + x.cols);
      if (m && !(m.r === r && m.c === c)) return '<table:covered-table-cell/>';
      const span = m ? (m.cols > 1 ? ` table:number-columns-spanned="${m.cols}"` : '') + (m.rows > 1 ? ` table:number-rows-spanned="${m.rows}"` : '') : '';
      const fill = b.cellFill && b.cellFill[r + ',' + c];
      const rr = b.cellRuns && b.cellRuns[r + ',' + c];
      const cell = (b.rows[r] || [])[c];
      const runs = runsOf(cell, rr).map((x) => (isHead ? Object.assign({}, x, { bold: true }) : x));
      const stName = 'C' + (fill && HEX.test(fill) ? fill.slice(1) : 'x');
      if (fill && HEX.test(fill)) tableFills.add(fill);
      return `<table:table-cell table:style-name="${stName}" office:value-type="string"${span}><text:p text:style-name="Standard">${runsXml(runs)}</text:p></table:table-cell>`;
    };
    const tableFills = new Set();
    let tableN = 0;

    const table = (b) => {
      const rows = b.rows || [];
      const cols = Math.max(1, ...rows.map((r) => r.length));
      const name = 'Tbl' + (++tableN);
      const head = b.header !== false;
      return `<table:table table:name="${name}" table:style-name="Table"><table:table-column table:number-columns-repeated="${cols}"/>` +
        rows.map((row, r) => `<table:table-row>${Array.from({ length: cols }, (_, c) => cellXml(b, r, c, head && r === 0)).join('')}</table:table-row>`).join('') + '</table:table>';
    };

    const list = (b) => {
      const style = b.ordered ? 'LNum' : 'LBul';
      const lv = b.itemLevels || [];
      let out = '';
      let cur = -1;
      (b.items || []).forEach((it, i) => {
        let want = Math.min(2, lv[i] || 0);
        if (cur === -1) { out += `<text:list text:style-name="${style}">`; cur = 0; }
        else if (want > cur) { want = cur + 1; out += `<text:list text:style-name="${style}">`; cur = want; }
        else { out += '</text:list-item>'; while (cur > want) { out += '</text:list></text:list-item>'; cur--; } }
        out += `<text:list-item><text:p text:style-name="Standard">${runsXml(runsOf(it, b.itemRuns && b.itemRuns[i]))}</text:p>`;
      });
      if (cur >= 0) { out += '</text:list-item>'; while (cur > 0) { out += '</text:list></text:list-item>'; cur--; } out += '</text:list>'; }
      return out;
    };

    const image = (b) => {
      const m = /^data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(b.src || ''));
      if (!m || !MIME[m[1].toLowerCase()]) return '';
      const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
      const name = 'Pictures/img' + (++imgN) + '.' + ext;
      media.push({ name, mime: MIME[m[1].toLowerCase()] });
      mediaParts.push({ name, data: Buffer.from(m[2], 'base64') });
      const w = b.width ? pxCm(b.width) : '10cm';
      const h = b.height ? pxCm(b.height) : '7cm';
      return `<text:p text:style-name="${paraStyle('Standard', 'fo:text-align="center"')}"><draw:frame draw:name="Imagen${++frameN}" text:anchor-type="as-char" svg:width="${w}" svg:height="${h}"><draw:image xlink:href="${name}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame></text:p>`;
    };
    const mediaParts = [];

    let pendingBreak = false;
    const body = [];
    for (const b of doc.blocks || []) {
      switch (b.type) {
        case 'heading':
          body.push(`<text:h text:style-name="${paraStyle('Heading_' + Math.min(3, Math.max(1, b.level || 1)), blockProps(b), pendingBreak ? 'page' : '')}" text:outline-level="${Math.min(3, Math.max(1, b.level || 1))}">${runsXml(runsOf(b.text, b.runs))}</text:h>`);
          pendingBreak = false; break;
        case 'paragraph': body.push(para(Object.assign({}, b, { __brk: pendingBreak }), 'Standard')); pendingBreak = false; break;
        case 'quote': body.push(para(Object.assign({}, b, { __brk: pendingBreak }), 'Quotations')); pendingBreak = false; break;
        case 'code': (String(b.text || '').split('\n')).forEach((ln) => body.push(`<text:p text:style-name="Preformatted_Text">${runsXml([{ text: ln }])}</text:p>`)); pendingBreak = false; break;
        case 'list': body.push(list(b)); pendingBreak = false; break;
        case 'table': body.push(table(b)); pendingBreak = false; break;
        case 'image': body.push(image(b)); pendingBreak = false; break;
        case 'hr': body.push(`<text:p text:style-name="Horizontal_Line"/>`); break;
        case 'pagebreak': pendingBreak = true; break;
        default: break;
      }
    }

    const fills = Array.from(tableFills);
    const auto = [
      ...Array.from(autoText, ([k, n]) => `<style:style style:name="${n}" style:family="text"><style:text-properties ${k}/></style:style>`),
      ...Array.from(autoPara.values(), (p) => `<style:style style:name="${p.name}" style:family="paragraph" style:parent-style-name="${p.parent}"${p.brk ? ' ' : ''}>` +
        `<style:paragraph-properties ${p.extra}${p.brk ? ' fo:break-before="page"' : ''}/></style:style>`),
      '<style:style style:name="Table" style:family="table"><style:table-properties style:width="17cm" table:align="margins"/></style:style>',
      '<style:style style:name="Cx" style:family="table-cell"><style:table-cell-properties fo:padding="0.1cm" fo:border="0.5pt solid #999999"/></style:style>',
      ...fills.map((f) => `<style:style style:name="C${f.slice(1)}" style:family="table-cell"><style:table-cell-properties fo:padding="0.1cm" fo:border="0.5pt solid #999999" fo:background-color="${f}"/></style:style>`),
      '<text:list-style style:name="LBul">' + [1, 2, 3].map((l) => `<text:list-level-style-bullet text:level="${l}" text:bullet-char="•"><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" text:list-tab-stop-position="${(l * 0.8).toFixed(1)}cm" fo:text-indent="-0.5cm" fo:margin-left="${(l * 0.8).toFixed(1)}cm"/></style:list-level-properties></text:list-level-style-bullet>`).join('') + '</text:list-style>',
      '<text:list-style style:name="LNum">' + [1, 2, 3].map((l) => `<text:list-level-style-number text:level="${l}" style:num-suffix="." style:num-format="1"><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" text:list-tab-stop-position="${(l * 0.8).toFixed(1)}cm" fo:text-indent="-0.6cm" fo:margin-left="${(l * 0.8).toFixed(1)}cm"/></style:list-level-properties></text:list-level-style-number>`).join('') + '</text:list-style>'
    ].join('');
    return { body: body.join(''), auto, mediaParts, media };
  }

  const STYLES = (doc) => {
    const page = doc.page || model.PAGE.A4;
    const m = model.margins(page);
    const cols = page.columns > 1 ? `<style:columns fo:column-count="${Number(page.columns)}" fo:column-gap="0.8cm"/>` : '';
    const wm = String(page.footer || '').replace(/\{n\}/g, '').trim();
    return `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-styles ${NS}><office:styles>` +
      '<style:default-style style:family="paragraph"><style:paragraph-properties fo:margin-bottom="0.21cm"/><style:text-properties fo:font-size="11pt" style:font-name="Calibri" fo:font-family="Calibri"/></style:default-style>' +
      '<style:style style:name="Standard" style:family="paragraph" style:class="text"/>' +
      [1, 2, 3].map((l) => `<style:style style:name="Heading_${l}" style:display-name="Heading ${l}" style:family="paragraph" style:parent-style-name="Standard" style:default-outline-level="${l}"><style:paragraph-properties fo:margin-top="0.42cm" fo:margin-bottom="0.2cm" fo:keep-with-next="always"/><style:text-properties fo:font-size="${[20, 16, 13][l - 1]}pt" fo:font-weight="bold"/></style:style>`).join('') +
      '<style:style style:name="Quotations" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:margin-left="1cm" fo:margin-right="1cm"/><style:text-properties fo:font-style="italic"/></style:style>' +
      '<style:style style:name="Preformatted_Text" style:display-name="Preformatted Text" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:margin-bottom="0cm" fo:background-color="#f2f2f2"/><style:text-properties style:font-name="Courier New" fo:font-family="Courier New" fo:font-size="10pt"/></style:style>' +
      '<style:style style:name="Horizontal_Line" style:display-name="Horizontal Line" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:border-bottom="0.5pt solid #bfbfbf" fo:margin-top="0.1cm" fo:margin-bottom="0.2cm"/></style:style>' +
      '</office:styles><office:automatic-styles>' +
      `<style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="${cm(page.width)}" fo:page-height="${cm(page.height)}" style:print-orientation="${page.width > page.height ? 'landscape' : 'portrait'}" fo:margin-top="${cm(m.top)}" fo:margin-right="${cm(m.right)}" fo:margin-bottom="${cm(m.bottom)}" fo:margin-left="${cm(m.left)}">${cols}</style:page-layout-properties></style:page-layout>` +
      '</office:automatic-styles><office:master-styles><style:master-page style:name="Standard" style:page-layout-name="pm1">' +
      (page.header ? `<style:header><text:p text:style-name="Standard">${X(String(page.header).replace(/\{n\}/g, '').replace(/\{total\}/g, ''))}</text:p></style:header>` : '') +
      (wm ? `<style:footer><text:p text:style-name="Standard">${X(wm.replace(/\{total\}/g, ''))}</text:p></style:footer>` : '') +
      '</style:master-page></office:master-styles></office:document-styles>';
  };

  /** docToOdtParts(doc) -> { parts:[{name,data}] } */
  function docToOdtParts(doc) {
    const c = convert(doc);
    const content = `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-content ${NS}><office:automatic-styles>${c.auto}</office:automatic-styles><office:body><office:text>${c.body}</office:text></office:body></office:document-content>`;
    const meta = `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-meta ${NS}><office:meta><dc:title>${X(doc.title || 'Documento')}</dc:title>` +
      ((doc.meta && doc.meta.author) ? `<meta:initial-creator>${X(doc.meta.author)}</meta:initial-creator>` : '') + '</office:meta></office:document-meta>';
    const manifest = '<?xml version="1.0" encoding="UTF-8"?>\n<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">' +
      '<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>' +
      ['content.xml', 'styles.xml', 'meta.xml'].map((f) => `<manifest:file-entry manifest:full-path="${f}" manifest:media-type="text/xml"/>`).join('') +
      c.media.map((m) => `<manifest:file-entry manifest:full-path="${m.name}" manifest:media-type="${m.mime}"/>`).join('') + '</manifest:manifest>';
    return {
      parts: [
        { name: 'mimetype', data: 'application/vnd.oasis.opendocument.text' },
        { name: 'META-INF/manifest.xml', data: manifest },
        { name: 'content.xml', data: content },
        { name: 'styles.xml', data: STYLES(doc) },
        { name: 'meta.xml', data: meta }
      ].concat(c.mediaParts)
    };
  }

  return { docToOdtParts };
});

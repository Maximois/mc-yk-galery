'use strict';
/**
 * MC Browser -- modulo document-editor / core/epub.js
 *
 * Documento -> paquete EPUB 3 (con toc.ncx de respaldo). Capitulos: uno por
 * titulo de nivel 1 (o uno solo). Las imagenes data: se sacan a archivos.
 * Devuelve las partes del ZIP; el llamador arma el archivo (core/zip.js).
 */
(function (root, factory) {
  const mod = factory(typeof require === 'function' && typeof module === 'object' ? { model: require('./model'), html: require('./html') } : { model: root.MCDoc.model, html: root.MCDoc.html });
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else { root.MCDoc = root.MCDoc || {}; root.MCDoc.epub = mod; }
})(typeof self !== 'undefined' ? self : this, function (deps) {
  const { model, html } = deps;
  const X = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', 'svg+xml': 'image/svg+xml' };

  const CSS = `body{font-family:serif;line-height:1.5;margin:0 5%;}
h1,h2,h3{font-family:sans-serif;line-height:1.25;page-break-after:avoid;}
p{margin:0 0 .8em;text-align:justify;}
blockquote{margin:1em 1.5em;font-style:italic;}
pre{white-space:pre-wrap;font-size:.85em;}
table{border-collapse:collapse;width:100%;margin:1em 0;}td,th{border:1px solid #999;padding:3px 6px;}
img{max-width:100%;height:auto;}figure{margin:1em 0;text-align:center;}figcaption{font-size:.85em;}
.pagebreak{display:none;}.doc-ins{color:#0a7d33;}.doc-del{display:none;}
.doc-comment{background:none;}sup{font-size:.75em;}
nav.doc-toc{display:none;}
[data-callout]{padding:.5em .8em;border-left:4px solid #888;background:#f3f3f3;}`;

  // HTML5 -> XHTML: elementos vacios cerrados y entidades solo numericas.
  function toXhtml(h) {
    return String(h)
      .replace(/<(br|hr)\s*>/gi, '<$1/>')
      .replace(/<img\b([^>]*?)\s*\/?>/gi, '<img$1/>')
      .replace(/&nbsp;/g, '&#160;')
      .replace(/&#39;/g, '&#39;');
  }

  function chapterXhtml(title, body) {
    return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="es" lang="es"><head><meta charset="utf-8"/>' +
      `<title>${X(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body>${body}</body></html>`;
  }

  /** docToEpubParts(doc) -> { parts:[{name,data}], chapters } */
  function docToEpubParts(doc) {
    const list = html.blockHtmlList(doc).filter((x) => x.block.type !== 'toc');
    const media = [];
    let imgN = 0;
    // Capitulos
    const chapters = [];
    const newChapter = (title) => { const c = { title, parts: [], ids: [] }; chapters.push(c); return c; };
    let cur = newChapter(doc.title || 'Documento');
    let first = true;
    for (const { block, html: h } of list) {
      if (block.type === 'heading' && Number(block.level) === 1 && model.blockText(block).trim()) {
        if (!(first && !cur.parts.length)) cur = newChapter(model.blockText(block).trim());
        else cur.title = model.blockText(block).trim();
      }
      first = false;
      if (!h) continue;
      cur.parts.push(h);
      if (block.id) cur.ids.push(block.id);
      for (const m of h.matchAll(/\bid="([^"]+)"/g)) cur.ids.push(m[1]);
    }
    const files = chapters.map((c, i) => 'ch' + (i + 1) + '.xhtml');
    const anchorFile = Object.create(null);
    chapters.forEach((c, i) => c.ids.forEach((id) => { anchorFile[id] = files[i]; }));
    const notes = (html.notesOf ? html.notesOf(doc) : []);

    const parts = [];
    chapters.forEach((c, i) => {
      let body = toXhtml(c.parts.join('\n'));
      // Imagenes incrustadas -> archivos.
      body = body.replace(/src="data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)"/g, (m, kind, b64) => {
        const k = kind.toLowerCase();
        if (!MIME[k]) return 'src=""';
        const ext = k === 'jpeg' ? 'jpg' : k === 'svg+xml' ? 'svg' : k;
        const name = 'img' + (++imgN) + '.' + ext;
        media.push({ name, mime: MIME[k] });
        parts.push({ name: 'OEBPS/' + name, data: Buffer.from(b64, 'base64') });
        return 'src="' + name + '"';
      });
      // Enlaces internos entre capitulos.
      body = body.replace(/href="#([^"]+)"/g, (m, id) => (anchorFile[id] && anchorFile[id] !== files[i] ? `href="${anchorFile[id]}#${id}"` : m));
      if (i === chapters.length - 1 && notes.length) {
        body += `<hr/><ol class="doc-notes">${notes.map((n) => `<li>${X(n)}</li>`).join('')}</ol>`;
      }
      parts.push({ name: 'OEBPS/' + files[i], data: chapterXhtml(c.title, body) });
    });

    const title = doc.title || 'Documento';
    const author = (doc.meta && doc.meta.author) || '';
    const uid = 'urn:uuid:' + (doc.id ? String(doc.id).replace(/[^a-zA-Z0-9-]/g, '') : 'mcdoc') + '-' + (doc.hash || '0');
    const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const nav = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="es"><head><meta charset="utf-8"/><title>Contenido</title></head><body>' +
      '<nav epub:type="toc" id="toc"><h1>Contenido</h1><ol>' + chapters.map((c, i) => `<li><a href="${files[i]}">${X(c.title)}</a></li>`).join('') + '</ol></nav></body></html>';
    const ncx = '<?xml version="1.0" encoding="UTF-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="' + X(uid) + '"/></head><docTitle><text>' + X(title) + '</text></docTitle><navMap>' +
      chapters.map((c, i) => `<navPoint id="n${i + 1}" playOrder="${i + 1}"><navLabel><text>${X(c.title)}</text></navLabel><content src="${files[i]}"/></navPoint>`).join('') + '</navMap></ncx>';
    const opf = '<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="es"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">' +
      `<dc:identifier id="uid">${X(uid)}</dc:identifier><dc:title>${X(title)}</dc:title><dc:language>es</dc:language>` +
      (author ? `<dc:creator>${X(author)}</dc:creator>` : '') + `<meta property="dcterms:modified">${modified}</meta></metadata><manifest>` +
      '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="css" href="style.css" media-type="text/css"/>' +
      chapters.map((c, i) => `<item id="c${i + 1}" href="${files[i]}" media-type="application/xhtml+xml"/>`).join('') +
      media.map((m, i) => `<item id="m${i + 1}" href="${m.name}" media-type="${m.mime}"/>`).join('') +
      '</manifest><spine toc="ncx">' + chapters.map((c, i) => `<itemref idref="c${i + 1}"/>`).join('') + '</spine></package>';

    const head = [
      { name: 'mimetype', data: 'application/epub+zip' },
      { name: 'META-INF/container.xml', data: '<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>' },
      { name: 'OEBPS/content.opf', data: opf },
      { name: 'OEBPS/nav.xhtml', data: nav },
      { name: 'OEBPS/toc.ncx', data: ncx },
      { name: 'OEBPS/style.css', data: CSS }
    ];
    return { parts: head.concat(parts), chapters: chapters.length };
  }

  return { docToEpubParts, toXhtml };
});

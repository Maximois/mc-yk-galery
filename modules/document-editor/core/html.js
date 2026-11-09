'use strict';
/**
 * MC Browser -- modulo document-editor / core/html.js
 *
 * El modelo -> HTML. Este HTML tiene tres consumidores y por eso importa que
 * sea el mismo para todos:
 *  1. La exportacion a PDF (main lo imprime con printToPDF en una ventana sin
 *     JavaScript y sin red).
 *  2. La vista previa del editor (iframe con sandbox, sin scripts).
 *  3. La lectura por parte de la IA.
 *
 * Reglas de seguridad, no de estilo: el texto siempre pasa por escape, y las
 * imagenes solo pueden ser data: embebidas. Un documento importado de una
 * pagina cualquiera no puede inyectar HTML ni hacer que el exportador pida
 * una URL remota.
 */

(function (root, factory) {
  const mod = factory({
    model: (typeof require === 'function' && typeof module === 'object') ? require('./model.js') : (root.MCDoc && root.MCDoc.model)
  });
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (typeof window !== 'undefined') {
    window.MCDoc = window.MCDoc || {};
    window.MCDoc.html = mod;
  }
})(this, function (deps) {
  const model = deps.model;

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const escAttr = (s) => esc(s).replace(/'/g, '&#39;');

  const FONTS = '"Segoe UI", "Calibri", "Helvetica Neue", Arial, sans-serif';
  const MONO = 'Consolas, "Cascadia Mono", "Courier New", monospace';

  function runsToHtml(block) {
    const runs = Array.isArray(block.runs) && block.runs.length ? block.runs : [{ text: model.blockText(block) }];
    let out = '';
    for (const run of runs) {
      let html = esc(run.text).replace(/\n/g, '<br>');
      if (run.note) html = `<span class="doc-note" data-note="${escAttr(run.note)}" title="${escAttr(run.note)}">${html}</span>`;
      if (run.comment) html = `<span class="doc-comment" data-comment="${escAttr(run.comment)}" title="${escAttr(run.comment)}">${html}</span>`;
      if (run.ins) html = `<span class="doc-ins" data-ins="${escAttr(run.ins)}" title="Insertado: ${escAttr(run.ins)}">${html}</span>`;
      if (run.del) html = `<span class="doc-del" data-del="${escAttr(run.del)}" title="Eliminado: ${escAttr(run.del)}">${html}</span>`;
      if (run.link && model.isSafeLink(run.link)) html = `<a href="${escAttr(run.link)}">${html}</a>`;
      if (run.bold === true) html = `<strong>${html}</strong>`;
      if (run.italic === true) html = `<em>${html}</em>`;
      if (run.underline === true) html = `<u>${html}</u>`;
      if (run.strike === true) html = `<s>${html}</s>`;
      const styles = [];
      // `false` explicito: el tramo quita lo que el bloque trae por defecto
      // (una palabra sin negrita dentro de un titulo).
      if (run.bold === false) styles.push('font-weight:400');
      if (run.italic === false) styles.push('font-style:normal');
      if (run.underline === false) styles.push('text-decoration:none');
      if (run.color) styles.push(`color:${escAttr(run.color)}`);
      if (run.highlight) styles.push(`background-color:${escAttr(run.highlight)}`);
      if (run.font) styles.push(`font-family:'${escAttr(run.font)}'`);
      if (run.size) styles.push(`font-size:${Number(run.size) || 11}pt`);
      if (styles.length) html = `<span style="${escAttr(styles.join(';'))}">${html}</span>`;
      out += html;
    }
    return out;
  }

  // Cuadro de texto / forma flotante: ancho en %, posicion y apariencia.
  function boxCss(box) {
    if (!box) return '';
    const hx = (v, d) => (/^#[0-9a-fA-F]{6}$/.test(String(v || '')) ? v : d);
    const w = Math.min(100, Math.max(15, Number(box.w) || 40));
    const ell = box.shape === 'ellipse';
    const css = [`box-sizing:border-box`, `width:${w}%`, `border:1.5px solid ${hx(box.border, '#555555')}`, `background:${hx(box.fill, '#FFFFFF')}`,
      `border-radius:${ell ? '50%' : box.shape === 'round' ? '12px' : '0'}`, `padding:${ell ? '18px 26px' : '10px 14px'}`];
    if (ell) css.push('text-align:center');
    if (box.float === 'left') css.push('float:left', 'margin:4px 14px 6px 0');
    else if (box.float === 'right') css.push('float:right', 'margin:4px 0 6px 14px');
    else css.push('margin:8px auto', 'clear:both');
    return css.join(';');
  }

  const CALLOUTS = { info: ['#EAF2FF', '#3B82F6'], warn: ['#FFF6DD', '#F59E0B'], ok: ['#E7F7EC', '#22A559'], error: ['#FDECEC', '#E5484D'] };
  function blockStyle(block) {
    const styles = [];
    if (block.box) styles.push(boxCss(block.box));
    if (block.callout && CALLOUTS[block.callout]) styles.push(`background:${CALLOUTS[block.callout][0]};border-left:4px solid ${CALLOUTS[block.callout][1]};padding:8px 12px;border-radius:4px`);
    if (block.align) styles.push(`text-align:${block.align}`);
    if (block.size) styles.push(`font-size:${Number(block.size) || 11}pt`);
    if (block.color) styles.push(`color:${escAttr(block.color)}`);
    if (block.hanging) styles.push(`margin-left:${Number(block.indent || 0) * 18 + Number(block.hanging)}pt`, `text-indent:-${Number(block.hanging)}pt`);
    else {
      if (block.indent) styles.push(`margin-left:${Number(block.indent) * 18}pt`);
      if (block.firstLine) styles.push(`text-indent:${Number(block.firstLine)}pt`);
    }
    if (block.lineHeight) styles.push(`line-height:${Number(block.lineHeight)}`);
    if (block.spaceBefore != null) styles.push(`margin-top:${Number(block.spaceBefore)}pt`);
    if (block.spaceAfter != null) styles.push(`margin-bottom:${Number(block.spaceAfter)}pt`);
    const cap = block.caption ? ` data-caption="${block.caption}"` : '';
    return (styles.length ? ` style="${escAttr(styles.join(';'))}"` : '') + cap;
  }

  function blockToHtml(block, ctx) {
    const style = blockStyle(block);
    switch (block.type) {
      case 'heading': {
        const level = Math.min(3, Math.max(1, block.level || 1));
        const hid = ctx && ctx.anchors && block.id ? ` id="h-${escAttr(block.id)}"` : '';
        const slug = ctx && ctx.slugs && block.id && ctx.slugs[block.id];
        const anchor = slug ? `<a id="${escAttr(slug)}"></a>` : '';
        return `<h${level}${hid}${style}>${anchor}${runsToHtml(block)}</h${level}>`;
      }
      case 'paragraph': {
        const cid = block.caption && ctx && ctx.anchors && block.id ? ` id="c-${escAttr(block.id)}"` : '';
        return `<p${cid}${style}>${runsToHtml(block)}</p>`;
      }
      case 'quote':
        return `<blockquote${style}>${runsToHtml(block)}</blockquote>`;
      case 'code':
        return `<pre${style}><code>${esc(model.blockText(block))}</code></pre>`;
      case 'list': {
        const tag = block.ordered ? 'ol' : 'ul';
        const lv = block.itemLevels || [];
        let out = '';
        let depth = 0;
        (block.items || []).forEach((it, i) => {
          const rr = block.itemRuns && block.itemRuns[i];
          const want = Math.min(2, lv[i] || 0);
          // Anidado real: cada salto de nivel abre una sublista dentro del <li> anterior.
          while (depth < want) { out += `<${tag}>`; depth++; }
          while (depth > want) { out += `</li></${tag}>`; depth--; }
          if (i > 0 && depth === want && out.endsWith('</li>') === false && !out.endsWith(`<${tag}>`)) out += '</li>';
          out += `<li>${rr ? runsToHtml({ runs: rr }) : esc(it)}`;
        });
        while (depth > 0) { out += `</li></${tag}>`; depth--; }
        out += '</li>';
        return `<${tag}${style}>${out}</${tag}>`;
      }
      case 'table': {
        const rows = block.rows || [];
        const head = block.header !== false;
        const mAt = (r, c) => (block.merges || []).find(m => r >= m.r && r < m.r + m.rows && c >= m.c && c < m.c + m.cols);
        const body = rows.map((row, r) => {
          const tag = head && r === 0 ? 'th' : 'td';
          return `<tr>${row.map((cell, c) => {
            const m = mAt(r, c);
            if (m && !(m.r === r && m.c === c)) return '';
            const span = m ? (m.cols > 1 ? ` colspan="${m.cols}"` : '') + (m.rows > 1 ? ` rowspan="${m.rows}"` : '') : '';
            const fill = block.cellFill && block.cellFill[r + ',' + c];
            const cb = block.cellBorders && block.cellBorders[r + ',' + c];
            const stl = [fill && /^#[0-9a-f]{6}$/i.test(fill) ? `background:${fill}` : '', cb ? model.cellBorderCss(cb) : ''].filter(Boolean).join(';');
            const st = stl ? ` style="${stl}"` : '';
            const rr = block.cellRuns && block.cellRuns[r + ',' + c];
            return `<${tag}${span}${st}>${rr ? runsToHtml({ runs: rr }) : esc(cell).replace(/\n/g, '<br>')}</${tag}>`;
          }).join('')}</tr>`;
        }).join('');
        const grp = Array.isArray(block.colWidths) && block.colWidths.length
          ? '<colgroup>' + block.colWidths.map(w => `<col style="width:${Number(w)}%">`).join('') + '</colgroup>' : '';
        const attrs = (block.borders ? ` data-borders="${block.borders}"` : '') + (grp ? ' style="table-layout:fixed"' : '');
        return `<table${attrs}>${grp}${body}</table>`;
      }
      case 'image': {
        if (!model.isSafeImageSrc(block.src)) return '';
        const dims = [];
        if (block.width) dims.push(`width:${Number(block.width)}px`);
        if (block.height) dims.push(`height:${Number(block.height)}px`);
        const c = block.crop;
        const view = c ? `object-view-box:inset(${c.t}% ${c.r}% ${c.b}% ${c.l}%)` : '';
        const styled = dims.concat(view ? [view] : []);
        const attrs = styled.length ? ` style="${styled.join(';')}"` : '';
        const fig = block.wrap ? ` class="wrap-${block.wrap}"` : '';
        return `<figure${fig}><img src="${escAttr(block.src)}" alt="${escAttr(block.alt || '')}"${attrs}>${block.alt ? `<figcaption>${esc(block.alt)}</figcaption>` : ''}</figure>`;
      }
      case 'pagebreak':
        return '<div class="pagebreak"></div>';
      case 'toc': {
        if (block.kind) {
          const word = block.kind === 'table' ? 'Tabla' : 'Figura';
          const title = block.kind === 'table' ? 'Índice de tablas' : 'Índice de figuras';
          const items = model.captionList((ctx && ctx.blocks) || [], block.kind);
          if (!items.length) return `<nav class="doc-toc"><div class="doc-toc-title">${title}</div><p class="doc-toc-empty">(Sin rótulos)</p></nav>`;
          return `<nav class="doc-toc"><div class="doc-toc-title">${title}</div>` + items.map((c) =>
            `<div class="doc-toc-l1"><a href="#c-${escAttr(c.id)}">${word} ${c.n}. ${esc(c.text)}</a></div>`).join('') + '</nav>';
        }
        const max = Math.min(3, Math.max(1, block.levels || 3));
        const entries = ((ctx && ctx.outline) || []).filter((h) => h.level <= max && h.text.trim());
        if (!entries.length) return '<nav class="doc-toc"><div class="doc-toc-title">Contenido</div><p class="doc-toc-empty">(Sin títulos)</p></nav>';
        return '<nav class="doc-toc"><div class="doc-toc-title">Contenido</div>' + entries.map((h) =>
          `<div class="doc-toc-l${h.level}"><a href="#h-${escAttr(h.id)}">${esc(h.text)}</a></div>`).join('') + '</nav>';
      }
      case 'hr':
        return '<hr>';
      default:
        return '';
    }
  }

  const STYLE_SELECTORS = {
    heading1: 'h1', heading2: 'h2', heading3: 'h3', paragraph: 'p', quote: 'blockquote', code: 'pre'
  };

  /**
   * Reglas CSS de los estilos del documento. `scope` antepone un selector
   * (el editor las usa dentro de su hoja); `suffix` se agrega al elemento (el
   * editor marca sus superficies con .doc-ce).
   */
  function stylesCss(styles, scope, suffix) {
    if (!styles) return '';
    const out = [];
    for (const key of Object.keys(STYLE_SELECTORS)) {
      const st = styles[key];
      if (!st) continue;
      const decl = [];
      if (st.font) decl.push(`font-family: '${String(st.font).replace(/[^\p{L}\p{N} ._-]/gu, '')}', ${FONTS}`);
      if (st.size) decl.push(`font-size: ${Number(st.size)}pt`);
      if (st.color && /^#[0-9a-fA-F]{3,8}$/.test(st.color)) decl.push(`color: ${st.color}`);
      if (st.bold === true) decl.push('font-weight: 700');
      else if (st.bold === false) decl.push('font-weight: 400');
      if (st.italic === true) decl.push('font-style: italic');
      else if (st.italic === false) decl.push('font-style: normal');
      if (st.align) decl.push(`text-align: ${st.align}`);
      if (st.lineHeight) decl.push(`line-height: ${Number(st.lineHeight)}`);
      if (decl.length) out.push(`${scope ? scope + ' ' : ''}${STYLE_SELECTORS[key]}${suffix || ''} { ${decl.join('; ')}; }`);
    }
    return out.join('\n');
  }

  // Encabezado, pie, numeracion, primera pagina distinta y numero inicial con
  // cajas de margen de @page (Chromium las imprime; sustituye a las plantillas
  // de printToPDF, que no pueden variar la primera pagina ni desplazar el numero).
  function pageMarginCss(page) {
    const p = page || {};
    const css = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ');
    const tpl = (t) => {
      const parts = String(t).split(/(\{n\}|\{total\})/).filter((x) => x !== '');
      return parts.map((x) => (x === '{n}' ? 'counter(page)' : x === '{total}' ? 'counter(pages)' : `"${css(x)}"`)).join(' ') || '""';
    };
    const font = 'font: 9pt Calibri, Arial, sans-serif; color: #444;';
    const boxes = [];
    if (p.header) boxes.push(`@top-left { content: ${tpl(p.header)}; ${font} }`);
    if (p.footer || p.pageNumbers) {
      const pn = p.pageNumbers;
      if (p.footer && pn) {
        const body = pn === 'left' ? `counter(page) "   " ${tpl(p.footer)}` : `${tpl(p.footer)} "   " counter(page)`;
        boxes.push(`@bottom-${pn} { content: ${body}; ${font} }`);
      } else if (p.footer) boxes.push(`@bottom-left { content: ${tpl(p.footer)}; ${font} }`);
      else boxes.push(`@bottom-${pn} { content: counter(page); ${font} }`);
    }
    const rules = [];
    if (boxes.length) rules.push(`@page { ${boxes.join(' ')} }`);
    const start = Number(p.pageStart) > 1 ? Number(p.pageStart) : 0;
    const first = [];
    if (start) first.push(`counter-increment: page ${start};`);
    if (p.titlePage && boxes.length) first.push('@top-left { content: none; } @bottom-left { content: none; } @bottom-center { content: none; } @bottom-right { content: none; }');
    if (first.length) rules.push(`@page :first { ${first.join(' ')} }`);
    return rules.join('\n');
  }

  function stylesheet(doc) {
    const page = doc.page || model.PAGE.A4;
    const m = model.margins(page);
    return `
@page { size: ${page.width}pt ${page.height}pt; margin: ${m.top}pt ${m.right}pt ${m.bottom}pt ${m.left}pt; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { counter-reset: capfig captab; }
${page.columns > 1 ? `body { column-count: ${Number(page.columns)}; column-gap: 24pt; }\nh1, .doc-toc { column-span: all; }\ntable, img, figure, pre, blockquote { break-inside: avoid; }` : ''}
p[data-caption=figure] { counter-increment: capfig; font-size: 10pt; text-align: center; }
p[data-caption=table] { counter-increment: captab; font-size: 10pt; text-align: center; }
p[data-caption=figure]::before { content: "Figura " counter(capfig) ". "; font-weight: 700; }
p[data-caption=table]::before { content: "Tabla " counter(captab) ". "; font-weight: 700; }
body {
  font-family: ${FONTS};
  font-size: 11pt;
  line-height: 1.5;
  color: #111;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
h1 { font-size: 17pt; margin: 0 0 10pt; line-height: 1.25; }
h2 { font-size: 14pt; margin: 16pt 0 6pt; }
h3 { font-size: 12pt; margin: 14pt 0 5pt; }
p { margin: 0 0 8pt; }
ul, ol { margin: 0 0 8pt; padding-left: 20pt; }
li { margin: 0 0 3pt; }
ol ol { list-style-type: lower-alpha; margin: 3pt 0 0; }
ol ol ol { list-style-type: lower-roman; }
ul ul { list-style-type: circle; margin: 3pt 0 0; }
ul ul ul { list-style-type: square; }
blockquote { margin: 0 0 8pt; padding: 2pt 0 2pt 10pt; border-left: 3pt solid #ccc; color: #444; }
pre { background: #f4f4f4; padding: 8pt; border-radius: 3pt; white-space: pre-wrap; word-break: break-word; font-family: ${MONO}; font-size: 9.5pt; }
code { font-family: ${MONO}; }
table { border-collapse: collapse; width: 100%; margin: 0 0 10pt; font-size: 10pt; }
th, td { border: 0.5pt solid #999; padding: 4pt 6pt; text-align: left; vertical-align: top; }
th { background: #eee; }
table[data-borders="none"] th, table[data-borders="none"] td { border-color: transparent; }
table[data-borders="horizontal"] th, table[data-borders="horizontal"] td { border-left-color: transparent; border-right-color: transparent; }
table[data-borders="outer"] { border: 0.5pt solid #999; }
table[data-borders="outer"] th, table[data-borders="outer"] td { border-color: transparent; }
figure { margin: 0 0 10pt; }
figure.wrap-left { float: left; margin: 2pt 12pt 6pt 0; }
figure.wrap-right { float: right; margin: 2pt 0 6pt 12pt; }
img { max-width: 100%; height: auto; }
figcaption { font-size: 9pt; color: #666; margin-top: 3pt; }
hr { border: 0; border-top: 0.5pt solid #ccc; margin: 12pt 0; }
.doc-toc { margin: 0 0 12pt; }
.doc-toc-title { font-weight: 700; font-size: 14pt; margin: 0 0 6pt; }
.doc-toc a { color: inherit; text-decoration: none; }
.doc-toc-l2 { padding-left: 14pt; }
.doc-toc-l3 { padding-left: 28pt; }
body { counter-reset: docnote; }
.doc-note { counter-increment: docnote; }
.doc-note::after { content: counter(docnote); vertical-align: super; font-size: 0.7em; line-height: 0; color: #2b5fb4; }
.doc-comment { background: #fff3b0; }
.doc-ins { color: #0a7d33; text-decoration: underline; }
.doc-del { color: #c0262d; text-decoration: line-through; }
.doc-notes { font-size: 9pt; color: #444; margin: 18pt 0 0; padding: 6pt 0 0 18pt; border-top: 0.5pt solid #999; }
@media print { .doc-comment { background: none; } }
.pagebreak { break-after: page; page-break-after: always; height: 0; }
${stylesCss(doc.styles)}
${pageMarginCss(doc.page)}
`.trim();
  }

  /**
   * docToHtml(doc, opts) -> string
   * opts.print: documento completo con <head> (para imprimir o previsualizar).
   * opts.bodyOnly: solo el cuerpo (para insertar en la vista previa).
   */
  // Textos de las notas al pie, en orden de aparicion.
  function notesOf(doc) {
    const out = [];
    const scan = (rr) => { for (const r of rr || []) if (r && r.note) out.push(r.note); };
    for (const b of doc.blocks || []) {
      scan(b.runs);
      for (const rr of b.itemRuns || []) scan(rr);
      for (const k of Object.keys(b.cellRuns || {})) scan(b.cellRuns[k]);
    }
    return out;
  }

  /** HTML de cada bloque, con los mismos anclajes que docToHtml: [{ block, html }]. */
  function blockHtmlList(doc) {
    const slugArr = model.headingSlugs(doc.blocks || []);
    const slugs = Object.create(null);
    (doc.blocks || []).forEach((b, i) => { if (slugArr[i] && b.id) slugs[b.id] = slugArr[i]; });
    const tctx = { anchors: true, outline: model.outline(doc), slugs, blocks: doc.blocks || [] };
    return (doc.blocks || []).map((b) => ({ block: b, html: blockToHtml(b, tctx) }));
  }

  function docToHtml(doc, opts) {
    const o = opts || {};
    const notes = notesOf(doc);
    const slugArr = model.headingSlugs(doc.blocks || []);
    const slugs = Object.create(null);
    (doc.blocks || []).forEach((b, i) => { if (slugArr[i] && b.id) slugs[b.id] = slugArr[i]; });
    const tctx = { anchors: true, outline: model.outline(doc), slugs, blocks: doc.blocks || [] };
    const body = (doc.blocks || []).map((b) => blockToHtml(b, tctx)).filter(Boolean).join('\n') +
      (notes.length && !o.bodyOnly ? `\n${doc.page && doc.page.endnotes ? '<h3 class="doc-notes-title">Notas</h3>' : ''}<ol class="doc-notes">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ol>` : '');
    const title = esc(doc.title || 'Documento');
    if (o.bodyOnly) return body;
    if (!o.print) {
      return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>` +
        `<style>${stylesheet(doc)}body{padding:24px;max-width:820px;margin:0 auto;}</style>` +
        `</head><body>${body}</body></html>`;
    }
    const wm = doc.page && doc.page.watermark
      ? `<div class="doc-watermark" style="position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-35deg);font:700 96pt Arial,sans-serif;color:rgba(0,0,0,.08);white-space:nowrap;z-index:-1;pointer-events:none">${esc(doc.page.watermark)}</div>` : '';
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>` +
      `<style>${stylesheet(doc)}</style></head><body>${wm}${body}</body></html>`;
  }

  /** Solo el texto visible de un fragmento HTML (pegar desde la web). */
  function htmlToText(html) {
    let s = String(html == null ? '' : html);
    s = s.replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, ' ');
    s = s.replace(/<!--[\s\S]*?-->/g, ' ');
    s = s.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre)>/gi, '\n');
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<[^>]+>/g, '');
    s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
      .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)));
    s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
    return s.trim();
  }

  /**
   * Opciones de printToPDF para encabezado, pie y numeracion. Chromium dibuja
   * las plantillas dentro del margen de @page; las clases pageNumber /
   * totalPages las rellena el.
   */
  function pdfHeaderFooter(doc) {
    const page = (doc && doc.page) || model.PAGE.A4;
    const m = model.margins(page);
    const has = !!(page.header || page.footer || page.pageNumbers);
    if (!has) return { displayHeaderFooter: false, headerTemplate: '<span></span>', footerTemplate: '<span></span>' };
    const box = (inner, align) =>
      `<div style="font-size:9px;font-family:Calibri,Arial,sans-serif;color:#444;width:100%;` +
      `padding:0 ${m.right}pt 0 ${m.left}pt;text-align:${align || 'left'};">${inner}</div>`;
    const tok = (t) => esc(t).replace(/\{n\}/g, '<span class="pageNumber"></span>').replace(/\{total\}/g, '<span class="totalPages"></span>');
    const header = page.header ? box(tok(page.header), 'left') : '<span></span>';
    const num = '<span class="pageNumber"></span>';
    let footer = '<span></span>';
    if (page.footer && page.pageNumbers) {
      const side = page.pageNumbers === 'left' ? `${num} &nbsp; ${tok(page.footer)}` : `${tok(page.footer)} &nbsp; ${num}`;
      footer = box(side, page.pageNumbers === 'center' ? 'center' : page.pageNumbers);
    } else if (page.footer) footer = box(tok(page.footer), 'left');
    else if (page.pageNumbers) footer = box(num, page.pageNumbers);
    return { displayHeaderFooter: true, headerTemplate: header, footerTemplate: footer };
  }

  return { boxCss, blockHtmlList, notesOf, stylesCss, pageMarginCss, pdfHeaderFooter, docToHtml, blockToHtml, runsToHtml, stylesheet, htmlToText, esc, escAttr };
});

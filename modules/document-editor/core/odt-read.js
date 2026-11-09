'use strict';
/**
 * MC Browser -- modulo document-editor / core/odt-read.js
 *
 * .odt / .ott (OpenDocument) -> modelo. Un ODT es un ZIP OPC igual que un
 * DOCX, pero el contenido vive en `content.xml` con elementos
 * `office:text > text:h | text:p | text:list | table:table`.
 *
 * Que se conserva: texto, titulos (text:h con text:outline-level), parrafos,
 * listas (con orden/vineta segun el estilo) y tablas. El resto (marcos,
 * imagenes, notas) se ignora. Igual que doc-read, esto es contenido, no
 * diseno; al guardar se ofrece DOCX/PDF.
 *
 * No usa dependencias: reutiliza el parser XML propio (xml.js) y el ZIP
 * propio (zip.js). Corre en main, en el worker y en Node (tests).
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
    window.MCDoc.odtRead = mod;
  }
})(this, function (deps) {
  const model = deps.model;
  const xml = deps.xml;
  const zip = deps.zip;

  function baseName(p) {
    const b = String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
    return b.replace(/\.[^.\\/]+$/, '') || b;
  }

  // Texto de un parrafo/titulo: recorre hijos mezclando texto y elementos.
  function inlineText(node) {
    let out = '';
    for (const child of node.children) {
      if (!xml.isElement(child)) { out += child; continue; }
      const name = child.local;
      if (name === 's') {
        const count = parseInt(xml.attr(child, 'c') || '1', 10) || 1;
        out += ' '.repeat(Math.max(1, Math.min(count, 4096)));
        continue;
      }
      if (name === 'tab') { out += '\t'; continue; }
      if (name === 'line-break') { out += '\n'; continue; }
      if (name === 'note' || name === 'annotation' || name === 'frame' ||
          name === 'drawing' || name === 'image' || name === 'bookmark') continue;
      out += inlineText(child);
    }
    return out;
  }

  // map estilo de lista -> ordenada (numero) o con vineta.
  function listStyles(tree) {
    const map = Object.create(null);
    const autos = xml.findDeep(tree, 'automatic-styles');
    if (!autos) return map;
    for (const style of xml.childNodes(autos, 'list-style')) {
      const name = xml.attr(style, 'name');
      if (!name) continue;
      const numbered = xml.childNodes(style).some((c) => c.local === 'list-level-style-number');
      map[name] = numbered;
    }
    return map;
  }

  function cellText(cell) {
    const ps = xml.findAll(cell, 'p');
    if (!ps.length) return inlineText(cell).trim();
    return ps.map((p) => inlineText(p).trim()).filter(Boolean).join('\n');
  }

  function tableBlock(table) {
    const rows = [];
    for (const tr of xml.childNodes(table, 'table-row')) {
      const cells = [];
      for (const tc of tr.children) {
        if (!xml.isElement(tc)) continue;
        if (tc.local === 'table-cell') cells.push(cellText(tc));
        else if (tc.local === 'covered-table-cell') cells.push('');
      }
      if (cells.length) rows.push(cells);
    }
    return rows.length ? { type: 'table', rows, header: true } : null;
  }

  function listBlock(list, orderedMap) {
    const items = [];
    for (const li of xml.childNodes(list, 'list-item')) {
      for (const p of xml.childNodes(li, 'p')) {
        const text = inlineText(p).replace(/[ \t]+$/, '');
        if (text.trim()) items.push(text);
      }
    }
    if (!items.length) return null;
    const ordered = !!orderedMap[xml.attr(list, 'style-name')];
    return { type: 'list', items, ordered, level: 0 };
  }

  function walkBlocks(container, blocks, orderedMap) {
    for (const child of container.children) {
      if (!xml.isElement(child)) continue;
      const name = child.local;
      if (name === 'h') {
        const level = Math.max(1, Math.min(6, parseInt(xml.attr(child, 'outline-level') || '1', 10) || 1));
        const text = inlineText(child).replace(/\s+$/, '');
        if (text.trim()) blocks.push({ type: 'heading', level, text });
      } else if (name === 'p') {
        const text = inlineText(child).replace(/[ \t]+$/, '');
        if (text.trim()) blocks.push({ type: 'paragraph', text });
      } else if (name === 'list') {
        const b = listBlock(child, orderedMap);
        if (b) blocks.push(b);
      } else if (name === 'table') {
        const b = tableBlock(child);
        if (b) blocks.push(b);
      } else if (name === 'section' || name === 'hbox' || name === 'body') {
        walkBlocks(child, blocks, orderedMap);
      }
    }
  }

  function titleFromMeta(entries, fallback) {
    const raw = entries['meta.xml'];
    if (!raw) return fallback;
    try {
      const tree = xml.parse(zip.toStr(raw));
      const t = xml.findDeep(tree, 'title');
      const text = t ? String(xml.textOf(t)).trim() : '';
      return text || fallback;
    } catch (e) { return fallback; }
  }

  async function odtBytesToDoc(input, opts) {
    const o = opts || {};
    const warnings = [];
    let entries;
    try { entries = (await zip.readZip(input)).entries; }
    catch (e) { throw new Error('odt: ' + e.message); }

    const raw = entries['content.xml'];
    if (!raw) throw new Error('odt: falta content.xml (no parece un OpenDocument)');
    const tree = xml.parse(zip.toStr(raw));

    const body = xml.findDeep(tree, 'body');
    const textEl = (body && (xml.childNodes(body, 'text')[0] || xml.findDeep(body, 'text'))) || xml.findDeep(tree, 'text');
    if (!textEl) throw new Error('odt: no se encontro office:text');

    const orderedMap = listStyles(tree);
    const blocks = [];
    walkBlocks(textEl, blocks, orderedMap);

    const title = titleFromMeta(entries, o.title || (o.sourcePath ? baseName(o.sourcePath) : 'Documento'));
    const doc = model.createDoc({
      title,
      meta: { source: 'odt', sourcePath: o.sourcePath || '' },
      blocks,
      warnings
    });
    if (!blocks.length) warnings.push('el OpenDocument no tiene texto reconocible (puede tener solo imagenes)');
    if (!doc.title || doc.title === 'Documento') {
      doc.title = model.deriveTitle(doc);
      doc.hash = model.hashDoc(doc);
    }
    return { doc, warnings };
  }

  return {
    odtBytesToDoc,
    _internal: { inlineText, walkBlocks, listStyles, titleFromMeta }
  };
});

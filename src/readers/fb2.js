// Lector de FictionBook 2 (.fb2): XML con metadatos (<description>), cuerpos (<body>) y las imágenes
// incrustadas en base64 (<binary>). Cada párrafo, título, verso o cita pasa a ser un bloque, que es la
// base de las anclas de las anotaciones. Las notas al pie (<body name="notes">) van al final.
// Seguridad: se reconstruye el HTML elemento por elemento (nada del archivo se inserta crudo) y las
// imágenes solo se aceptan si son binarios del propio archivo.
import { bytesToBase64, base64ToBytes } from '../lib/bytes.js';

export const FB2_FORMATS = ['FB2'];

const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const local = (n) => (n && n.localName) || '';
const kids = (n, name) => Array.from(n.childNodes).filter((c) => c.nodeType === 1 && (!name || local(c) === name));
const first = (n, name) => kids(n, name)[0] || null;
const text = (n) => (n ? n.textContent.replace(/\s+/g, ' ').trim() : '');
const hrefOf = (img) => (img.getAttribute('l:href') || img.getAttribute('xlink:href') || img.getAttribute('href') || '').replace(/^#/, '');

/** Bytes -> texto, respetando la codificación declarada en el prólogo XML (windows-1251, koi8-r...). */
export function decodeFb2(bytes) {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 200));
  const m = /<\?xml[^>]*encoding\s*=\s*["']([\w.:-]+)["']/i.exec(head);
  let label = m ? m[1].toLowerCase() : 'utf-8';
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) label = 'utf-16le';
  else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) label = 'utf-16be';
  let decoder;
  try { decoder = new TextDecoder(label); } catch { decoder = new TextDecoder('utf-8'); } // etiqueta desconocida
  return decoder.decode(bytes);
}

function parse(bytes) {
  const doc = new DOMParser().parseFromString(decodeFb2(bytes), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('FB2 inválido: XML mal formado');
  const root = doc.documentElement;
  if (!root || local(root) !== 'FictionBook') throw new Error('El archivo no es un FB2 (FictionBook)');
  return root;
}

/** Binarios incrustados: id -> { bytes, mime }. */
function readBinaries(root) {
  const out = {};
  for (const b of kids(root, 'binary')) {
    const id = b.getAttribute('id');
    if (!id) continue;
    try {
      const bytes = base64ToBytes(b.textContent.replace(/\s+/g, ''));
      if (bytes.length && bytes.length <= MAX_IMAGE_BYTES) out[id] = { bytes, mime: b.getAttribute('content-type') || 'image/jpeg' };
    } catch { /* imagen dañada: se omite */ }
  }
  return out;
}

function readMeta(root) {
  const info = first(first(root, 'description') || root, 'title-info');
  if (!info) return { title: '', author: '', coverId: '' };
  const a = first(info, 'author');
  const author = a ? ['first-name', 'middle-name', 'last-name'].map((t) => text(first(a, t))).filter(Boolean).join(' ') || text(first(a, 'nickname')) : '';
  const cover = first(first(info, 'coverpage') || info, 'image');
  return { title: text(first(info, 'book-title')), author, coverId: cover ? hrefOf(cover) : '' };
}

/** Portada: { bytes, mime } o null. La usa el extractor de portadas de la biblioteca. */
export function fb2Cover(bytes) {
  try {
    const root = parse(bytes);
    const { coverId } = readMeta(root);
    return coverId ? readBinaries(root)[coverId] || null : null;
  } catch { return null; }
}

function inline(node, bin) {
  let out = '';
  for (const c of Array.from(node.childNodes)) {
    if (c.nodeType === 3) { out += esc(c.data); continue; }
    if (c.nodeType !== 1) continue;
    const inner = () => inline(c, bin);
    switch (local(c)) {
      case 'strong': out += '<strong>' + inner() + '</strong>'; break;
      case 'emphasis': out += '<em>' + inner() + '</em>'; break;
      case 'strikethrough': out += '<del>' + inner() + '</del>'; break;
      case 'sub': out += '<sub>' + inner() + '</sub>'; break;
      case 'sup': out += '<sup>' + inner() + '</sup>'; break;
      case 'code': out += '<code>' + inner() + '</code>'; break;
      case 'image': out += imageHtml(c, bin); break;
      default: out += inner(); // a (notas), style, etc.: se conserva el texto
    }
  }
  return out;
}

function imageHtml(img, bin) {
  const b = bin[hrefOf(img)];
  if (!b || !/^image\/(png|jpe?g|gif|webp)$/i.test(b.mime)) return '';
  return '<img alt="" src="data:' + b.mime.toLowerCase() + ';base64,' + bytesToBase64(b.bytes) + '">';
}

const heading = (depth, html) => '<h' + Math.min(5, Math.max(2, depth + 1)) + '>' + html + '</h' + Math.min(5, Math.max(2, depth + 1)) + '>';

function blocksOf(node, bin, depth, out) {
  for (const c of kids(node)) {
    switch (local(c)) {
      case 'title': {
        const t = kids(c, 'p').map((p) => inline(p, bin)).filter(Boolean).join(' ');
        if (t) out.push(heading(depth, t));
        break;
      }
      case 'section': blocksOf(c, bin, depth + 1, out); break;
      case 'epigraph': case 'cite': {
        const parts = [];
        blocksOf(c, bin, depth, parts);
        if (parts.length) out.push('<blockquote>' + parts.join('') + '</blockquote>');
        break;
      }
      case 'p': { const h = inline(c, bin); if (h.trim()) out.push('<p>' + h + '</p>'); break; }
      case 'subtitle': { const h = inline(c, bin); if (h.trim()) out.push('<p><strong>' + h + '</strong></p>'); break; }
      case 'text-author': { const h = inline(c, bin); if (h.trim()) out.push('<p style="text-align:right"><em>' + h + '</em></p>'); break; }
      case 'empty-line': out.push('<p>&nbsp;</p>'); break;
      case 'poem': {
        for (const part of kids(c)) {
          if (local(part) === 'stanza') out.push('<p>' + kids(part, 'v').map((v) => inline(v, bin)).join('<br>') + '</p>');
          else if (local(part) === 'title') blocksOf({ childNodes: [part] }, bin, depth, out);
          else if (local(part) === 'text-author') { const h = inline(part, bin); if (h.trim()) out.push('<p style="text-align:right"><em>' + h + '</em></p>'); }
        }
        break;
      }
      case 'image': { const h = imageHtml(c, bin); if (h) out.push('<p style="text-align:center">' + h + '</p>'); break; }
      case 'table': {
        const rows = kids(c, 'tr').map((tr) => '<tr>' + kids(tr).map((cell) => '<td>' + inline(cell, bin) + '</td>').join('') + '</tr>').join('');
        if (rows) out.push('<table>' + rows + '</table>');
        break;
      }
      default: break;
    }
  }
}

export function createFb2Reader(core) {
  return {
    id: 'fb2',
    formats: FB2_FORMATS,
    async load(bytes, book) {
      const root = parse(bytes);
      const bin = readBinaries(root);
      const meta = readMeta(root);
      const blocks = [];
      const notes = [];
      for (const body of kids(root, 'body')) {
        if ((body.getAttribute('name') || '') === 'notes') { blocksOf(body, bin, 1, notes); continue; }
        blocksOf(body, bin, 0, blocks);
      }
      if (notes.length) blocks.push('<h2>Notas</h2>', ...notes);
      const css = core.html.stylesheet(core.model.createDoc({ title: meta.title, blocks: [] }));
      return {
        kind: 'reflow',
        title: meta.title || (book && book.title) || '',
        css,
        blocks: blocks.map((html) => ({ html })),
        warnings: blocks.length ? [] : ['El FB2 no tiene texto'],
        meta: { author: meta.author }
      };
    }
  };
}

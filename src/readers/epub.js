// Lector de EPUB: ZIP con container.xml -> paquete .opf -> "spine" (orden de lectura) -> capítulos XHTML.
// Cada hijo directo del <body> de cada capítulo pasa a ser un bloque del contenido reflowable.
//
// Seguridad y estilo: del capítulo se descartan <script>, <style>, <link>, <iframe>, <object>,
// atributos on* y estilos en línea; el estilo lo pone el visor. Las imágenes internas se incrustan
// como data: URI (el iframe del visor no puede leer el ZIP) y las externas se descartan.
// Limitación: el DRM y los EPUB protegidos no se pueden abrir; los capítulos con una sola etiqueta
// enorme (un <div> que envuelve todo el capítulo) se bajan un nivel para que haya bloques de tamaño útil.
import { bytesToBase64 } from '../lib/bytes.js';

export const EPUB_FORMATS = ['EPUB'];

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const DROP = 'script,style,link,iframe,object,embed,form,meta,base,audio,video,source,track';
const WRAPPERS = new Set(['DIV', 'SECTION', 'ARTICLE', 'MAIN', 'BODY']);

const dec = (u8) => new TextDecoder('utf-8').decode(u8);
const safeDecodeURI = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

/** Resuelve `href` (con ../ y %20) relativo al archivo `base` dentro del ZIP. */
export function resolvePath(base, href) {
  const clean = safeDecodeURI(String(href || '').split('#')[0].split('?')[0]);
  if (!clean) return base;
  const parts = base.split('/').slice(0, -1);
  for (const seg of clean.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

function byLocal(root, name) {
  return Array.from(root.getElementsByTagName('*')).filter((n) => n.localName === name);
}

function parseXml(text) {
  const d = new DOMParser().parseFromString(text, 'application/xml');
  if (d.getElementsByTagName('parsererror').length) throw new Error('EPUB: XML inválido');
  return d;
}

/** Lee container.xml y el .opf: devuelve { title, author, spine: [rutas de capítulos en orden] }. */
export function readPackage(entries) {
  const container = entries['META-INF/container.xml'];
  if (!container) throw new Error('EPUB inválido: falta META-INF/container.xml');
  const root = byLocal(parseXml(dec(container)), 'rootfile')[0];
  const opfPath = root && root.getAttribute('full-path');
  if (!opfPath || !entries[opfPath]) throw new Error('EPUB inválido: no se encuentra el paquete (.opf)');

  const opf = parseXml(dec(entries[opfPath]));
  const manifest = {};
  for (const it of byLocal(opf, 'item')) manifest[it.getAttribute('id')] = it;
  const spine = [];
  for (const ref of byLocal(opf, 'itemref')) {
    if (ref.getAttribute('linear') === 'no') continue; // notas, cubiertas alternativas, etc.
    const it = manifest[ref.getAttribute('idref')];
    if (!it) continue;
    const type = it.getAttribute('media-type') || '';
    if (!/x?html/.test(type)) continue;
    const path = resolvePath(opfPath, it.getAttribute('href'));
    if (entries[path]) spine.push(path);
  }
  const text = (n) => { const e = byLocal(opf, n)[0]; return e ? e.textContent.replace(/\s+/g, ' ').trim() : ''; };
  return { title: text('title'), author: text('creator'), spine };
}

/**
 * Ruta de la imagen de portada dentro del ZIP, o null. Orden de confianza: propiedad `cover-image`
 * (EPUB 3), `<meta name="cover">` (EPUB 2) y, como último recurso, una imagen del manifiesto con
 * "cover" en el id o el nombre.
 */
export function findCoverPath(entries) {
  try {
    const container = entries['META-INF/container.xml'];
    const root = container && byLocal(parseXml(dec(container)), 'rootfile')[0];
    const opfPath = root && root.getAttribute('full-path');
    if (!opfPath || !entries[opfPath]) return null;
    const opf = parseXml(dec(entries[opfPath]));
    const items = byLocal(opf, 'item');
    const isImage = (it) => /^image\//.test(it.getAttribute('media-type') || '');
    const pathOf = (it) => resolvePath(opfPath, it.getAttribute('href'));
    const ok = (it) => it && isImage(it) && entries[pathOf(it)];
    let hit = items.find((it) => /(^|\s)cover-image(\s|$)/.test(it.getAttribute('properties') || '') && ok(it));
    if (!hit) {
      const meta = byLocal(opf, 'meta').find((m) => m.getAttribute('name') === 'cover');
      const id = meta && meta.getAttribute('content');
      hit = items.find((it) => it.getAttribute('id') === id && ok(it));
    }
    if (!hit) hit = items.find((it) => ok(it) && /cover/i.test((it.getAttribute('id') || '') + ' ' + (it.getAttribute('href') || '')));
    return hit ? pathOf(hit) : null;
  } catch { return null; }
}

function inlineImage(img, chapterPath, entries) {
  const src = img.getAttribute('src') || img.getAttribute('xlink:href') || '';
  if (!src || /^(data:|https?:|\/\/)/i.test(src)) {
    if (!/^data:image\//i.test(src)) img.remove(); // las externas no se cargan (privacidad y sin red)
    return;
  }
  const path = resolvePath(chapterPath, src);
  const bytes = entries[path];
  const ext = path.split('.').pop().toLowerCase();
  if (!bytes || !MIME[ext] || bytes.length > MAX_IMAGE_BYTES) { img.remove(); return; }
  img.setAttribute('src', 'data:' + MIME[ext] + ';base64,' + bytesToBase64(bytes));
  img.removeAttribute('srcset');
}

/** XHTML de un capítulo -> lista de HTML (uno por bloque), ya limpio. */
export function chapterToBlocks(xhtml, chapterPath, entries) {
  const html = new DOMParser().parseFromString(xhtml, 'text/html');
  const body = html.body;
  if (!body) return [];
  body.querySelectorAll(DROP).forEach((n) => n.remove());
  body.querySelectorAll('*').forEach((el) => {
    for (const a of Array.from(el.attributes)) {
      if (/^on/i.test(a.name) || a.name === 'style' || a.name === 'class') el.removeAttribute(a.name);
    }
    if (el.tagName === 'A') {
      const h = el.getAttribute('href') || '';
      if (!h.startsWith('#')) el.removeAttribute('href'); // sin navegación fuera del capítulo
    }
  });
  body.querySelectorAll('img, image').forEach((img) => inlineImage(img, chapterPath, entries));

  let nodes = Array.from(body.children);
  // Un solo envoltorio (<div class="chapter">…</div>) -> bajar un nivel.
  while (nodes.length === 1 && WRAPPERS.has(nodes[0].tagName) && nodes[0].children.length) nodes = Array.from(nodes[0].children);
  return nodes
    .filter((n) => n.textContent.trim() || n.tagName === 'IMG' || n.querySelector('img'))
    .map((n) => n.outerHTML);
}

export function createEpubReader(core) {
  return {
    id: 'epub',
    formats: EPUB_FORMATS,
    async load(bytes, book) {
      const { entries } = await core.zip.readZip(bytes);
      const pkg = readPackage(entries);
      if (!pkg.spine.length) throw new Error('El EPUB no tiene capítulos legibles');
      const blocks = [];
      for (const path of pkg.spine) {
        for (const html of chapterToBlocks(dec(entries[path]), path, entries)) blocks.push({ html });
      }
      const css = core.html.stylesheet(core.model.createDoc({ title: pkg.title, blocks: [] }));
      return {
        kind: 'reflow',
        title: pkg.title || (book && book.title) || '',
        css,
        blocks,
        warnings: blocks.length ? [] : ['El EPUB no tiene texto (puede estar protegido con DRM)'],
        meta: { author: pkg.author }
      };
    }
  };
}

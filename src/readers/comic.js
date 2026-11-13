// Lector de cómics CBZ (ZIP de imágenes). Las imágenes se presentan como un "documento de páginas" con
// la misma forma mínima que usa el visor de PDF (numPages, getPage, getViewport, render, getTextContent):
// así heredan sin código extra el modo hoja a hoja con animación, el zoom con pellizco, las anotaciones
// y hasta el OCR (útil para libros escaneados guardados como CBZ).
//   Limitaciones: el ZIP se descomprime en memoria (un CBZ de cientos de MB puede ser pesado en un teléfono
//   con poca RAM); CBR (RAR) y CB7 (7-Zip) no se pueden abrir: se pide convertirlos a CBZ. Hay CBR que en
//   realidad son ZIP con otro nombre: esos sí abren (se mira el contenido, no la extensión).
import { imageMime, imageSize, naturalCompare } from './images.js';

export const COMIC_FORMATS = ['CBZ', 'CBR'];

const hasPrefix = (b, ...bytes) => bytes.every((v, i) => b[i] === v);
export function sniffArchive(b) {
  if (hasPrefix(b, 0x50, 0x4b)) return 'zip';
  if (hasPrefix(b, 0x52, 0x61, 0x72, 0x21)) return 'rar';
  if (hasPrefix(b, 0x37, 0x7a, 0xbc, 0xaf)) return '7z';
  return 'unknown';
}

/** Nombres de imagen del ZIP en orden de lectura (sin carpetas de sistema ni archivos ocultos). */
export function listComicImages(entries) {
  return Object.keys(entries)
    .filter((n) => imageMime(n) && !/(^|\/)(__MACOSX\/|\.)/.test(n) && !/\/$/.test(n))
    .sort(naturalCompare);
}

const cancelled = () => Object.assign(new Error('Dibujo cancelado'), { name: 'RenderingCancelledException' });

/** Documento de páginas a partir de imágenes. pages: [{ name, bytes, mime }]. */
export function createImageDocument(pages, meta = {}) {
  let alive = true;
  const cache = new Map();

  async function sizeOf(p) {
    if (p.size) return p.size;
    p.size = imageSize(p.bytes);
    if (!p.size) { // formato raro o cabecera atípica: se decodifica una vez para saber el tamaño
      const bmp = await createImageBitmap(new Blob([p.bytes], { type: p.mime }));
      p.size = { w: bmp.width, h: bmp.height };
      if (bmp.close) bmp.close();
    }
    if (!(p.size.w > 0 && p.size.h > 0)) throw new Error('Imagen inválida: ' + p.name);
    return p.size;
  }

  return {
    numPages: pages.length,
    async getPage(n) {
      if (!alive) throw new Error('Documento cerrado');
      const p = pages[n - 1];
      if (!p) throw new Error('Página inexistente: ' + n);
      if (cache.has(n)) return cache.get(n);
      const { w, h } = await sizeOf(p);
      const page = {
        getViewport: ({ scale = 1 } = {}) => ({ width: w * scale, height: h * scale, scale, rotation: 0 }),
        getTextContent: async () => ({ items: [] }),
        render({ canvasContext: ctx, viewport, transform }) {
          let stop = false;
          const promise = (async () => {
            const bmp = await createImageBitmap(new Blob([p.bytes], { type: p.mime }));
            try {
              if (stop || !alive) throw cancelled();
              ctx.save();
              if (transform) ctx.setTransform(...transform);
              ctx.imageSmoothingQuality = 'high';
              ctx.drawImage(bmp, 0, 0, viewport.width, viewport.height);
              ctx.restore();
            } finally { if (bmp.close) bmp.close(); }
          })();
          return { promise, cancel() { stop = true; } };
        }
      };
      cache.set(n, page);
      return page;
    },
    async getMetadata() { return { info: { Title: meta.title || '', Author: meta.author || '' } }; },
    async destroy() { alive = false; cache.clear(); pages.length = 0; } // suelta los bytes de las imágenes
  };
}

/** ComicInfo.xml (estándar de los cómics digitales): título y autor. Opcional. */
function readComicInfo(entries) {
  const key = Object.keys(entries).find((n) => /(^|\/)comicinfo\.xml$/i.test(n));
  if (!key || typeof DOMParser === 'undefined') return {};
  try {
    const d = new DOMParser().parseFromString(new TextDecoder('utf-8').decode(entries[key]), 'application/xml');
    const t = (tag) => { const e = d.getElementsByTagName(tag)[0]; return e ? e.textContent.trim() : ''; };
    const series = t('Series');
    const number = t('Number');
    return { title: t('Title') || [series, number && '#' + number].filter(Boolean).join(' '), author: t('Writer') };
  } catch { return {}; }
}

export function createComicReader(core) {
  return {
    id: 'comic',
    formats: COMIC_FORMATS,
    async load(bytes, book) {
      const kind = sniffArchive(bytes);
      if (kind === 'rar') throw new Error('Este cómic está en formato RAR (CBR) y todavía no se puede abrir. Conviértelo a CBZ (un ZIP con las imágenes).');
      if (kind === '7z') throw new Error('Este cómic está en formato 7-Zip (CB7) y todavía no se puede abrir. Conviértelo a CBZ (un ZIP con las imágenes).');
      if (kind !== 'zip') throw new Error('El archivo no es un CBZ válido (no es un ZIP).');
      const { entries } = await core.zip.readZip(bytes);
      const names = listComicImages(entries);
      if (!names.length) throw new Error('El CBZ no contiene imágenes');
      const info = readComicInfo(entries);
      const pages = names.map((name) => ({ name, bytes: entries[name], mime: imageMime(name) }));
      return {
        kind: 'pdf', // se muestra con el visor de páginas
        pdf: createImageDocument(pages, info),
        lib: { renderTextLayer: () => ({ promise: Promise.resolve() }) }, // las imágenes no traen texto
        title: info.title || (book && book.title) || '',
        warnings: [],
        preferPaged: true, // los cómics se leen mejor hoja a hoja
        meta: { author: info.author, pageCount: pages.length }
      };
    }
  };
}

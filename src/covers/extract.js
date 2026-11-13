// Extracción de la portada propia de cada formato. Devuelve un Blob JPEG o null (sin portada).
// `ctx.loadCore(...groups)` carga el núcleo de documentos (se inyecta para no atar esto a Vite).
// Registro por formato: sumar un formato = una función en EXTRACTORS.
import { findCoverPath } from '../readers/epub.js';
import { fb2Cover } from '../readers/fb2.js';
import { listComicImages } from '../readers/comic.js';
import { drawToThumb, imageToThumb, mimeOfPath } from './thumb.js';

async function fromPdf(bytes, ctx) {
  const core = await ctx.loadCore('pdf');
  // Sin onPassword: un PDF cifrado lanza y se queda sin portada (no se pide contraseña al importar).
  const pdf = await core.pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, useSystemFonts: true, verbosity: 0 }).promise;
  try {
    const page = await pdf.getPage(1);
    const v1 = page.getViewport({ scale: 1 });
    return await drawToThumb(v1.width, v1.height, async (c, w) => {
      // Se renderiza directamente al tamaño final (más barato que dibujar grande y reducir).
      await page.render({ canvasContext: c, viewport: page.getViewport({ scale: w / v1.width }) }).promise;
    });
  } finally { try { await pdf.destroy(); } catch { /* ya liberado */ } }
}

async function fromEpub(bytes, ctx) {
  const core = await ctx.loadCore();
  const { entries } = await core.zip.readZip(bytes);
  const path = findCoverPath(entries);
  return path ? imageToThumb(entries[path], mimeOfPath(path) || 'image/jpeg') : null;
}

// ODT y DOCX guardan a veces una miniatura de la primera página.
async function zipThumb(bytes, ctx, candidates) {
  const core = await ctx.loadCore();
  const { entries } = await core.zip.readZip(bytes);
  const name = candidates.find((n) => entries[n]);
  return name ? imageToThumb(entries[name], mimeOfPath(name) || 'image/png') : null;
}

async function fromFb2(bytes) {
  const c = fb2Cover(bytes);
  return c ? imageToThumb(c.bytes, c.mime) : null;
}

async function fromComic(bytes, ctx) {
  const core = await ctx.loadCore();
  const { entries } = await core.zip.readZip(bytes);
  const first = listComicImages(entries)[0];
  return first ? imageToThumb(entries[first], mimeOfPath(first) || 'image/jpeg') : null;
}

const EXTRACTORS = {
  PDF: fromPdf,
  CBZ: fromComic,
  CBR: fromComic,
  FB2: fromFb2,
  EPUB: fromEpub,
  ODT: (b, c) => zipThumb(b, c, ['Thumbnails/thumbnail.png']),
  DOCX: (b, c) => zipThumb(b, c, ['docProps/thumbnail.jpeg', 'docProps/thumbnail.jpg', 'docProps/thumbnail.png'])
};

/** ¿Este formato puede tener portada propia? (los demás van directo a "Sin portada"). */
export const hasCoverExtractor = (format) => Object.prototype.hasOwnProperty.call(EXTRACTORS, String(format || '').toUpperCase());

export async function extractCover(bytes, format, ctx) {
  const fn = EXTRACTORS[String(format || '').toUpperCase()];
  if (!fn) return null;
  try { return await fn(bytes, ctx); } catch (e) { console.warn('Portada: no se pudo extraer (' + format + ')', e); return null; }
}

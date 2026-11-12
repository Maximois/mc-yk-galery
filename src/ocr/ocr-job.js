// Trabajo de OCR sobre un PDF: busca las páginas sin texto, las dibuja a resolución de lectura y
// las reconoce una por una, de modo que se pueda cancelar entre página y página.
import { linesFromBlocks, pageHasText } from './ocr-words.js';

const TARGET_WIDTH = 1600; // px: ~200 dpi en una página A4; más no mejora y gasta memoria/tiempo
const MAX_SIDE = 3200;

/** Números de página (1-based) que no tienen texto y por tanto necesitan OCR. */
export async function pagesNeedingOcr(pdf, { skip = new Set(), shouldStop = () => false } = {}) {
  const out = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    if (shouldStop()) break;
    if (skip.has(n)) continue;
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    if (!pageHasText(content.items)) out.push(n);
  }
  return out;
}

async function renderPage(pdf, n) {
  const page = await pdf.getPage(n);
  const v1 = page.getViewport({ scale: 1 });
  const scale = Math.min(TARGET_WIDTH / v1.width, MAX_SIDE / Math.max(v1.width, v1.height));
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(vp.width));
  canvas.height = Math.max(1, Math.floor(vp.height));
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  return canvas;
}

/**
 * Reconoce `pages` y llama onPage(n, lines) con cada resultado apenas está listo (así se guarda y se
 * muestra de a poco). Devuelve cuántas páginas se procesaron. Un fallo en una página no corta el resto.
 */
export async function runOcr({ pdf, engine, pages, onPage, onProgress, shouldStop = () => false }) {
  let done = 0;
  for (const n of pages) {
    if (shouldStop()) break;
    if (onProgress) onProgress(done, pages.length);
    let canvas;
    try {
      canvas = await renderPage(pdf, n);
      const blocks = await engine.recognize(canvas);
      if (shouldStop()) break;
      if (onPage) await onPage(n, linesFromBlocks(blocks, canvas.width, canvas.height));
    } catch (e) {
      console.warn('OCR: falló la página ' + n, e);
    } finally {
      if (canvas) { canvas.width = 0; canvas.height = 0; } // libera la memoria del bitmap ya
    }
    done++;
  }
  if (onProgress) onProgress(done, pages.length);
  return done;
}

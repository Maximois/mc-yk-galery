// Botón "OCR" del lector de PDF: reconoce el texto de las páginas escaneadas (sin texto propio), lo
// muestra como capa seleccionable y guarda el resultado para no repetirlo al reabrir el libro.
import { readTextFile, writeTextFile, ocrPath } from '../platform/files.js';
import { createOcrEngine } from '../ocr/engine.js';
import { pagesNeedingOcr, runOcr } from '../ocr/ocr-job.js';
import { hasWords } from '../ocr/ocr-words.js';

const SAVE_EVERY = 3; // páginas

export function createOcrController({ button, toast }) {
  let viewer = null;
  let pdf = null;
  let bookId = null;
  let results = {}; // página -> líneas
  let running = false;
  let stopRequested = false;
  let engine = null;

  const label = (text) => { button.textContent = text; };

  async function persist() {
    if (!bookId) return;
    try { await writeTextFile(ocrPath(bookId), JSON.stringify({ v: 1, pages: results })); } catch (e) { console.warn('OCR: no se pudo guardar', e); }
  }

  async function cached(id) {
    try {
      const raw = await readTextFile(ocrPath(id));
      const data = raw ? JSON.parse(raw) : null;
      return data && data.v === 1 && data.pages && typeof data.pages === 'object' ? data.pages : {};
    } catch { return {}; } // archivo dañado: se vuelve a reconocer
  }

  async function start() {
    running = true;
    stopRequested = false;
    const myPdf = pdf;
    const id = bookId;
    const stopped = () => stopRequested || pdf !== myPdf;
    try {
      label('Buscando…');
      const skip = new Set(Object.keys(results).map(Number));
      const pages = await pagesNeedingOcr(pdf, { skip, shouldStop: stopped });
      if (stopped()) return;
      if (!pages.length) {
        toast(skip.size ? 'El OCR de este documento ya está hecho' : 'Este PDF ya tiene texto seleccionable');
        return;
      }
      label('Preparando…');
      engine = await createOcrEngine();
      if (stopped()) return;
      let processed = 0;
      let sinceSave = 0;
      processed = await runOcr({
        pdf, engine, pages, shouldStop: stopped,
        onProgress: (done, total) => label('OCR ' + done + '/' + total + ' ✕'),
        onPage: async (n, lines) => {
          if (!hasWords(lines)) { results[n] = []; return; } // página sin texto reconocible: no se reintenta
          results[n] = lines;
          if (viewer && pdf === myPdf) viewer.setOcrPage(n, lines);
          if (++sinceSave >= SAVE_EVERY) { sinceSave = 0; await persist(); }
        }
      });
      if (bookId === id) await persist();
      toast(stopRequested ? 'OCR detenido (' + processed + ' páginas listas)' : 'OCR terminado: ' + processed + ' página(s)');
    } catch (e) {
      console.error(e);
      toast('No se pudo hacer el OCR: ' + (e.message || e));
    } finally {
      if (engine) { await engine.terminate(); engine = null; }
      running = false;
      label('OCR');
    }
  }

  button.addEventListener('click', () => {
    if (running) { stopRequested = true; label('Deteniendo…'); return; }
    if (viewer && pdf) start();
  });

  return {
    /** Resultados guardados del libro, para pasarlos al visor al montarlo. */
    cached,
    attach(opts) {
      viewer = opts.viewer; pdf = opts.pdf; bookId = opts.bookId; results = opts.results || {};
      label('OCR');
      button.classList.remove('hidden');
    },
    detach() {
      stopRequested = true; // si hay un trabajo en curso, termina solo al terminar su página
      viewer = null; pdf = null; bookId = null; results = {};
      button.classList.add('hidden');
      if (!running && engine) { engine.terminate(); engine = null; }
    }
  };
}

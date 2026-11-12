// Motor de OCR: tesseract.js ejecutándose en un Web Worker, todo desde archivos locales (public/ocr/,
// ver tools/copy-ocr.mjs). No usa internet ni IndexedDB. Se crea al primer uso y se libera al terminar.
const BASE = 'ocr/';
const LANGS = ['spa', 'eng'];

const abs = (p) => new URL(BASE + p, document.baseURI).href;

function loadScript(url) {
  return new Promise((resolve, reject) => {
    if (window.Tesseract) return resolve();
    const s = document.createElement('script');
    s.src = url;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('No se pudo cargar el motor de OCR'));
    document.head.appendChild(s);
  });
}

export async function createOcrEngine() {
  await loadScript(abs('tesseract.min.js'));
  const worker = await window.Tesseract.createWorker(LANGS, 1, {
    workerPath: abs('worker.min.js'),
    corePath: abs('tesseract-core-simd-lstm.js'),
    langPath: abs('lang'),
    cacheMethod: 'none',
    workerBlobURL: false,
    gzip: true
  });
  return {
    /** canvas -> data.blocks de tesseract.js */
    async recognize(canvas) {
      const r = await worker.recognize(canvas, {}, { blocks: true });
      return r.data.blocks || [];
    },
    async terminate() { try { await worker.terminate(); } catch { /* ya cerrado */ } }
  };
}

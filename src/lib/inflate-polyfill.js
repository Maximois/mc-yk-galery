// Descompresión ZIP para WebViews sin soporte de DecompressionStream('deflate-raw').
//
// Por qué: core/zip.js (copia del de MC Browser, no se edita aquí) lee los ZIP de DOCX, ODT y EPUB con
// DecompressionStream('deflate-raw'). Ese formato existe desde Chrome 103; en Chrome 92-102 el constructor
// lanza TypeError y esos tres formatos no se abrirían.
// Qué: si el navegador no lo soporta, se instala un DecompressionStream equivalente sobre `fflate`
// (librería de inflate probada, MIT). Se carga con import() dinámico, así que solo se descarga cuando hace falta.
// Debe ejecutarse ANTES de cargar zip.js: este decide al cargarse si hay compresión disponible.

function supportsDeflateRaw() {
  if (typeof DecompressionStream !== 'function') return false;
  try { new DecompressionStream('deflate-raw'); return true; } catch { return false; }
}

function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** Devuelve true si tuvo que instalar el reemplazo, false si el navegador ya lo soporta. */
export async function ensureDeflateRaw() {
  if (supportsDeflateRaw()) return false;
  const { inflateSync } = await import('fflate');

  class InflateRawStream {
    constructor(format) {
      if (format !== 'deflate-raw') throw new TypeError("Unsupported compression format: '" + format + "'");
      const parts = [];
      const t = new TransformStream({
        transform(chunk) { parts.push(chunk); },
        flush(controller) { controller.enqueue(inflateSync(concat(parts))); }
      });
      this.readable = t.readable;
      this.writable = t.writable;
    }
  }
  globalThis.DecompressionStream = InflateRawStream;

  // zip.js exige que existan las dos clases para activar la compresión. Aquí solo se LEE (no se escribe),
  // así que la de compresión solo falla con un mensaje claro si alguien intentara usarla.
  if (typeof CompressionStream !== 'function') {
    globalThis.CompressionStream = class {
      constructor() { throw new Error('Este WebView no puede comprimir ZIP; Digilibrary solo lee archivos.'); }
    };
  }
  return true;
}

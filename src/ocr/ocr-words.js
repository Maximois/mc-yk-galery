// OCR -> geometría: convierte la salida de tesseract.js (cajas en píxeles) en líneas de palabras con
// posición en FRACCIONES de la página. Con fracciones la capa de texto sirve a cualquier zoom, igual
// que las anotaciones (pdf-geometry.js). Funciones puras, probadas en tests/ocr.test.mjs.

const MIN_CONFIDENCE = 30; // por debajo es casi siempre ruido (manchas, bordes del escaneo)
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * blocks: data.blocks de tesseract.js (bloques > párrafos > líneas > palabras, bbox {x0,y0,x1,y1}).
 * (width, height): tamaño en píxeles de la imagen reconocida.
 * Devuelve [{ words: [{ t, x, y, w, h }] }] en orden de lectura, con x/y/w/h en 0..1.
 */
export function linesFromBlocks(blocks, width, height) {
  const out = [];
  if (!Array.isArray(blocks) || !(width > 0) || !(height > 0)) return out;
  for (const b of blocks) {
    for (const p of (b && b.paragraphs) || []) {
      for (const l of p.lines || []) {
        const words = [];
        for (const w of l.words || []) {
          const text = String(w.text || '').trim();
          const bb = w.bbox;
          if (!text || !bb || !(w.confidence >= MIN_CONFIDENCE)) continue;
          const x = clamp01(bb.x0 / width);
          const y = clamp01(bb.y0 / height);
          const wd = clamp01(bb.x1 / width) - x;
          const ht = clamp01(bb.y1 / height) - y;
          if (!(wd > 0) || !(ht > 0)) continue;
          words.push({ t: text, x: round(x), y: round(y), w: round(wd), h: round(ht) });
        }
        if (words.length) out.push({ words });
      }
    }
  }
  return out;
}

const round = (v) => Math.round(v * 10000) / 10000;

/** ¿Alguna palabra reconocida? (una página en blanco o una foto devuelve cero). */
export const hasWords = (lines) => Array.isArray(lines) && lines.some((l) => l.words && l.words.length);

/** items: getTextContent().items de pdf.js. Una página escaneada no trae ninguno con texto. */
export function pageHasText(items) {
  return Array.isArray(items) && items.some((i) => typeof i.str === 'string' && /\S/.test(i.str));
}

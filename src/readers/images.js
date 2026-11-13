// Utilidades de imágenes sin decodificarlas: tamaño leído de la cabecera (rápido, no gasta memoria) y
// orden natural de nombres (pag2 antes que pag10). Puras, probadas en tests/comic.test.mjs.

const u16be = (b, o) => (b[o] << 8) | b[o + 1];
const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const u24le = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const u32be = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const ascii = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));

/** { w, h } de un PNG, JPEG, GIF o WebP; null si no se reconoce. */
export function imageSize(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && b.length >= 24) return { w: u32be(b, 16), h: u32be(b, 20) };
  if (ascii(b, 0, 3) === 'GIF') return { w: u16le(b, 6), h: u16le(b, 8) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) { o++; continue; }
      const m = b[o + 1];
      if (m === 0xff) { o++; continue; } // relleno
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: u16be(b, o + 5), w: u16be(b, o + 7) };
      if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { o += 2; continue; } // marcadores sin longitud
      o += 2 + u16be(b, o + 2);
    }
    return null;
  }
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP' && b.length >= 30) {
    const kind = ascii(b, 12, 4);
    if (kind === 'VP8 ') return { w: u16le(b, 26) & 0x3fff, h: u16le(b, 28) & 0x3fff };
    if (kind === 'VP8L') return { w: 1 + (b[21] | ((b[22] & 0x3f) << 8)), h: 1 + ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0x0f) << 10)) };
    if (kind === 'VP8X') return { w: 1 + u24le(b, 24), h: 1 + u24le(b, 27) };
  }
  return null;
}

const collator = typeof Intl !== 'undefined' ? new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }) : null;
export const naturalCompare = (a, b) => (collator ? collator.compare(a, b) : a < b ? -1 : a > b ? 1 : 0);

const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
export const imageMime = (name) => MIME[String(name).split('.').pop().toLowerCase()] || null;

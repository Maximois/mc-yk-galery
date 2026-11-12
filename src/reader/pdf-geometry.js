// Geometría de las anotaciones sobre PDF. Funciones puras (sin DOM): se prueban con node --test.
//
// Un PDF es de maquetación fija, así que una anotación se guarda como rectángulos en FRACCIONES de la
// página (0..1, origen arriba-izquierda). Eso no depende del zoom ni del tamaño de pantalla: el mismo
// resaltado se ve igual a cualquier escala.
//   anchor = { kind: 'pdf', page, rects: [{ p, x, y, w, h }], q: 'texto citado' }

const MIN_PX = 2;
const MAX_AREA = 0.25; // un rectángulo que cubre >25 % de la página no es una línea de texto
const MAX_RECTS = 500;
const EPS = 0.0005;

const clamp01 = (n) => Math.max(0, Math.min(1, n));
const r4 = (n) => Math.round(n * 10000) / 10000;

/**
 * rects: DOMRect-like { left, top, width, height } en píxeles de pantalla (de range.getClientRects()).
 * boxes: [{ page, left, top, width, height }] posición en pantalla de cada página.
 * Cada rectángulo se asigna a la página que contiene su centro; los que caen fuera se descartan.
 */
export function fractionRects(rects, boxes) {
  const out = [];
  for (const r of rects) {
    if (r.width < MIN_PX || r.height < MIN_PX) continue;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const b = boxes.find((q) => cx >= q.left && cx <= q.left + q.width && cy >= q.top && cy <= q.top + q.height);
    if (!b || !b.width || !b.height) continue;
    const x = clamp01((r.left - b.left) / b.width);
    const y = clamp01((r.top - b.top) / b.height);
    const w = Math.min(1 - x, r.width / b.width);
    const h = Math.min(1 - y, r.height / b.height);
    if (w <= 0 || h <= 0 || w * h > MAX_AREA) continue;
    out.push({ p: b.page, x: r4(x), y: r4(y), w: r4(w), h: r4(h) });
  }
  return dedupe(out).slice(0, MAX_RECTS);
}

const contains = (a, b) =>
  a.p === b.p && a.x <= b.x + EPS && a.y <= b.y + EPS && a.x + a.w >= b.x + b.w - EPS && a.y + a.h >= b.y + b.h - EPS;

/** Quita los rectángulos contenidos en otro (getClientRects repite cajas anidadas) y ordena en lectura. */
export function dedupe(rects) {
  const keep = rects.filter((r, i) => !rects.some((o, j) => j !== i && contains(o, r) && (!contains(r, o) || j < i)));
  return keep.sort((a, b) => (a.p - b.p) || (a.y - b.y) || (a.x - b.x));
}

/** Cita legible: espacios colapsados y recortada. */
export function cleanQuote(text, max = 4000) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function makePdfAnchor(rects, text) {
  const q = cleanQuote(text);
  if (!rects.length || !q) return null;
  return { kind: 'pdf', page: rects[0].p, rects, q };
}

/** ¿Es un ancla de PDF válida para una página dada? (si el archivo cambió, puede no serlo). */
export function isPdfAnchor(anchor, pageCount) {
  return !!anchor && anchor.kind === 'pdf' && Number.isInteger(anchor.page) && anchor.page >= 1 &&
    (!pageCount || anchor.page <= pageCount) && Array.isArray(anchor.rects) && anchor.rects.length > 0;
}

/** Rectángulo de una fracción a estilo CSS en porcentaje. */
export function rectStyle(r) {
  return 'left:' + r4(r.x * 100) + '%;top:' + r4(r.y * 100) + '%;width:' + r4(r.w * 100) + '%;height:' + r4(r.h * 100) + '%';
}

/** Escala de ajuste al ancho: la página ocupa `avail` px a zoom 1. */
export function fitScale(avail, pageWidth, zoom = 1) {
  if (!(pageWidth > 0) || !(avail > 0)) return 1;
  return (avail / pageWidth) * Math.max(0.25, Math.min(5, zoom));
}

/**
 * Página que está en una posición de scroll. `tops[i]`/`heights[i]` son el borde superior y el alto
 * de la página i+1. Devuelve el índice (0-based) de la última página que empieza antes de `y`.
 */
export function pageAt(tops, y) {
  if (!tops.length) return 0;
  let lo = 0;
  let hi = tops.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tops[mid] <= y) lo = mid; else hi = mid - 1;
  }
  return lo;
}

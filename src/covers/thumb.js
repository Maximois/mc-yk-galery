// Miniaturas de portada: reduce una imagen o un canvas a JPEG pequeño (las portadas viven en la
// biblioteca, no hace falta más que ~360 px de ancho; así 200 libros ocupan pocos MB).
export const THUMB_W = 360;
export const THUMB_H = 480;
const MIN_SIDE = 40; // una imagen de 1x1 o un logo diminuto no sirve como portada

/** Tamaño reducido manteniendo proporción y sin agrandar. Pura. */
export function thumbSize(w, h, maxW = THUMB_W, maxH = THUMB_H) {
  if (!(w > 0) || !(h > 0)) return null;
  const k = Math.min(1, maxW / w, maxH / h);
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

const toJpeg = (canvas) => new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.78));

function flatCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; // PNG con transparencia: sin fondo saldría negro en JPEG
  ctx.fillRect(0, 0, w, h);
  return { c, ctx };
}

/** bytes de una imagen (png/jpg/gif/webp) -> Blob JPEG reducido, o null si no sirve. */
export async function imageToThumb(bytes, mime = 'image/jpeg') {
  let bmp;
  try { bmp = await createImageBitmap(new Blob([bytes], { type: mime })); } catch { return null; }
  try {
    if (bmp.width < MIN_SIDE || bmp.height < MIN_SIDE) return null;
    const size = thumbSize(bmp.width, bmp.height);
    const { c, ctx } = flatCanvas(size.w, size.h);
    ctx.drawImage(bmp, 0, 0, size.w, size.h);
    return await toJpeg(c);
  } finally { if (bmp.close) bmp.close(); }
}

/** Dibuja una función en un canvas del tamaño pedido y devuelve el JPEG. draw(ctx, w, h) */
export async function drawToThumb(w1, h1, draw) {
  const size = thumbSize(w1, h1);
  if (!size) return null;
  const { c, ctx } = flatCanvas(size.w, size.h);
  await draw(ctx, size.w, size.h);
  const blob = await toJpeg(c);
  c.width = 0;
  c.height = 0;
  return blob;
}

export const mimeOfPath = (path) => {
  const ext = String(path).split('.').pop().toLowerCase();
  return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[ext] || null;
};

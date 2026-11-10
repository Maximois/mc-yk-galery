// Portada generada para los libros: inicial del título sobre un color derivado del propio título,
// así cada libro es reconocible de un vistazo y el color no cambia entre sesiones.

export function coverColor(seed) {
  let h = 0;
  for (const ch of String(seed || '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return 'hsl(' + (h % 360) + ' 42% 30%)';
}

export function coverInitial(title) {
  const m = /[\p{L}\p{N}]/u.exec(String(title || ''));
  return m ? m[0].toUpperCase() : '?';
}

// Zoom por pellizco: cálculo puro a partir de dos puntos táctiles (sin DOM, probado en tests/pinch.test.mjs).

/** Distancia entre los dedos y punto medio, en las coordenadas que traigan los toques. */
export function pinchMetrics(a, b) {
  return { dist: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
}

/**
 * Factor de escala del gesto, acotado para que `zoom * factor` quede dentro de [min, max].
 * Si `dist0` es 0 (dedos superpuestos) no hay gesto válido: devuelve 1.
 */
export function pinchFactor(dist0, dist, zoom, min, max) {
  if (!(dist0 > 0) || !(dist > 0) || !(zoom > 0)) return 1;
  const raw = dist / dist0;
  return Math.max(min / zoom, Math.min(max / zoom, raw));
}

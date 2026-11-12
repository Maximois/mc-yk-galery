import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanQuote, dedupe, fitScale, fractionRects, isPdfAnchor, makePdfAnchor, pageAt, rectStyle } from '../src/reader/pdf-geometry.js';
import { buildNotesMarkdown, sortForExport } from '../src/notes/export.js';

// Dos páginas de 400x600 px apiladas en pantalla (la segunda empieza en y=610).
const boxes = [
  { page: 1, left: 10, top: 0, width: 400, height: 600 },
  { page: 2, left: 10, top: 610, width: 400, height: 600 }
];
const R = (left, top, width, height) => ({ left, top, width, height });

test('fractionRects convierte píxeles de pantalla a fracciones de la página', () => {
  const out = fractionRects([R(110, 60, 200, 30)], boxes);
  assert.deepEqual(out, [{ p: 1, x: 0.25, y: 0.1, w: 0.5, h: 0.05 }]);
});

test('el mismo lugar de la página da las mismas fracciones a cualquier zoom', () => {
  // Misma región (un cuarto desde la izquierda, 10 % desde arriba) con la página al doble de tamaño.
  const doble = [{ page: 1, left: 10, top: 0, width: 800, height: 1200 }];
  const normal = fractionRects([R(110, 60, 200, 30)], boxes);
  const zoom2 = fractionRects([R(210, 120, 400, 60)], doble);
  assert.deepEqual(zoom2, normal);
});

test('una selección que cruza dos páginas se reparte por página', () => {
  const out = fractionRects([R(60, 570, 100, 20), R(60, 620, 100, 20)], boxes);
  assert.deepEqual(out.map((r) => r.p), [1, 2]);
  assert.ok(out[1].y > 0 && out[1].y < 0.05);
});

test('descarta rectángulos diminutos, fuera de las páginas y cajas gigantes', () => {
  const out = fractionRects([R(20, 20, 1, 10), R(500, 20, 50, 20), R(10, 0, 400, 400), R(20, 20, 50, 15)], boxes);
  assert.equal(out.length, 1);
  assert.equal(out[0].w, 0.125);
});

test('dedupe quita cajas anidadas y ordena en lectura', () => {
  const big = { p: 1, x: 0.1, y: 0.1, w: 0.5, h: 0.05 };
  const inner = { p: 1, x: 0.2, y: 0.11, w: 0.1, h: 0.03 };
  const other = { p: 1, x: 0.1, y: 0.3, w: 0.2, h: 0.04 };
  assert.deepEqual(dedupe([other, inner, big, { ...big }]), [big, other]);
});

test('makePdfAnchor e isPdfAnchor', () => {
  const rects = [{ p: 3, x: 0.1, y: 0.2, w: 0.3, h: 0.02 }];
  const a = makePdfAnchor(rects, '  hola \n  mundo ');
  assert.deepEqual(a, { kind: 'pdf', page: 3, rects, q: 'hola mundo' });
  assert.equal(makePdfAnchor([], 'x'), null);
  assert.equal(makePdfAnchor(rects, '   '), null);
  assert.equal(isPdfAnchor(a, 10), true);
  assert.equal(isPdfAnchor(a, 2), false, 'página fuera del documento');
  assert.equal(isPdfAnchor({ s: 1, e: 2, q: 'x' }, 10), false, 'ancla de texto reflowable');
  assert.equal(isPdfAnchor(null, 10), false);
});

test('fitScale, pageAt, rectStyle, cleanQuote', () => {
  assert.equal(fitScale(400, 800, 1), 0.5);
  assert.equal(fitScale(400, 800, 2), 1);
  assert.equal(fitScale(400, 0), 1);
  assert.equal(fitScale(400, 800, 99), 2.5, 'el zoom se acota');
  const tops = [0, 100, 250, 400];
  assert.equal(pageAt(tops, -5), 0);
  assert.equal(pageAt(tops, 100), 1);
  assert.equal(pageAt(tops, 399), 2);
  assert.equal(pageAt(tops, 9999), 3);
  assert.equal(pageAt([], 5), 0);
  assert.equal(rectStyle({ x: 0.25, y: 0.1, w: 0.5, h: 0.05 }), 'left:25%;top:10%;width:50%;height:5%');
  assert.equal(cleanQuote('a\n\n b\t c'), 'a b c');
});

test('exportación con anotaciones de PDF: orden por página y posición', () => {
  const mk = (id, page, y, text) => ({ id, type: 'highlight', text, createdAt: '2026-11-11T10:00:00Z', anchor: { kind: 'pdf', page, rects: [{ p: page, x: 0, y, w: 0.1, h: 0.02 }], q: text } });
  const items = [mk('c', 5, 0.1, 'tercera'), mk('a', 2, 0.7, 'segunda'), mk('b', 2, 0.1, 'primera')];
  assert.deepEqual(sortForExport(items).map((i) => i.id), ['b', 'a', 'c']);
  const md = buildNotesMarkdown({ title: 'Libro' }, items);
  assert.ok(md.indexOf('primera') < md.indexOf('segunda') && md.indexOf('segunda') < md.indexOf('tercera'));
  assert.ok(md.includes('página 2') && md.includes('página 5'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { linesFromBlocks, hasWords, pageHasText } from '../src/ocr/ocr-words.js';

const word = (text, x0, y0, x1, y1, confidence = 90) => ({ text, bbox: { x0, y0, x1, y1 }, confidence });
const blocks = (words) => [{ paragraphs: [{ lines: [{ words }] }] }];

test('linesFromBlocks convierte píxeles a fracciones de la página', () => {
  const out = linesFromBlocks(blocks([word('Hola', 100, 50, 300, 100)]), 1000, 500);
  assert.deepEqual(out, [{ words: [{ t: 'Hola', x: 0.1, y: 0.1, w: 0.2, h: 0.1 }] }]);
});

test('descarta ruido: confianza baja, texto vacío, cajas sin área', () => {
  const out = linesFromBlocks(blocks([
    word('ok', 0, 0, 10, 10), word('ruido', 0, 0, 10, 10, 12), word('  ', 0, 0, 10, 10), word('plana', 5, 5, 5, 9)
  ]), 100, 100);
  assert.deepEqual(out[0].words.map((w) => w.t), ['ok']);
});

test('las cajas que se salen de la imagen se recortan a 0..1', () => {
  const [line] = linesFromBlocks(blocks([word('borde', -20, 90, 130, 140)]), 100, 100);
  const w = line.words[0];
  assert.ok(w.x >= 0 && w.y >= 0 && w.x + w.w <= 1 && w.y + w.h <= 1);
});

test('una línea sin palabras válidas no aparece; entrada inválida no rompe', () => {
  assert.deepEqual(linesFromBlocks(blocks([word('x', 0, 0, 5, 5, 3)]), 10, 10), []);
  assert.deepEqual(linesFromBlocks(null, 10, 10), []);
  assert.deepEqual(linesFromBlocks(blocks([word('a', 0, 0, 5, 5)]), 0, 10), []);
});

test('hasWords y pageHasText', () => {
  assert.equal(hasWords([]), false);
  assert.equal(hasWords([{ words: [{ t: 'a' }] }]), true);
  assert.equal(pageHasText([{ str: '  ' }, { str: '\n' }]), false); // página escaneada
  assert.equal(pageHasText([{ str: ' ' }, { str: 'Hola' }]), true);
  assert.equal(pageHasText(undefined), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { pinchMetrics, pinchFactor } from '../src/reader/pinch.js';

test('pinchMetrics: distancia y punto medio', () => {
  const m = pinchMetrics({ x: 0, y: 0 }, { x: 30, y: 40 });
  assert.equal(m.dist, 50);
  assert.equal(m.cx, 15);
  assert.equal(m.cy, 20);
});

test('pinchFactor: separar los dedos agranda, juntarlos achica', () => {
  assert.equal(pinchFactor(100, 200, 1, 0.5, 4), 2);
  assert.equal(pinchFactor(100, 50, 1, 0.5, 4), 0.5);
});

test('pinchFactor respeta los límites según el zoom actual', () => {
  assert.equal(pinchFactor(100, 1000, 2, 0.5, 4), 2); // 2 * 2 = 4 (tope)
  assert.equal(pinchFactor(100, 10, 1, 0.5, 4), 0.5); // piso
  assert.equal(pinchFactor(100, 10, 0.5, 0.5, 4), 1); // ya en el piso: no baja más
});

test('pinchFactor ignora gestos degenerados', () => {
  assert.equal(pinchFactor(0, 100, 1, 0.5, 4), 1);
  assert.equal(pinchFactor(100, 0, 1, 0.5, 4), 1);
  assert.equal(pinchFactor(NaN, 100, 1, 0.5, 4), 1);
});

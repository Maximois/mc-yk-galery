import test from 'node:test';
import assert from 'node:assert/strict';
import { blockAt, flatten, makeAnchor, resolveAnchor, splitByBlocks, trimRange } from '../src/reader/anchors.js';

const blocks = ['Primer párrafo.', 'Segundo párrafo con más texto.', 'Tercero.'];

test('flatten: offsets de inicio con separador', () => {
  const f = flatten(blocks);
  assert.equal(f.text, blocks.join('\n'));
  assert.deepEqual(f.starts, [0, 16, 47]);
  assert.equal(f.text.slice(f.starts[1], f.starts[1] + 7), 'Segundo');
});

test('blockAt encuentra el bloque de cada offset', () => {
  const { starts } = flatten(blocks);
  assert.equal(blockAt(starts, 0), 0);
  assert.equal(blockAt(starts, 15), 0);
  assert.equal(blockAt(starts, 16), 1);
  assert.equal(blockAt(starts, 60), 2);
});

test('splitByBlocks parte una selección que cruza bloques', () => {
  const { starts } = flatten(blocks);
  // desde "párrafo." (offset 7) hasta "Segundo" inclusive
  const segs = splitByBlocks(starts, blocks, 7, 23);
  assert.deepEqual(segs, [{ b: 0, from: 7, to: 15 }, { b: 1, from: 0, to: 7 }]);
  assert.deepEqual(splitByBlocks(starts, blocks, 5, 5), []);
});

test('resolveAnchor: exacta si el texto no cambió', () => {
  const f = flatten(blocks);
  const a = makeAnchor(f.text, 16, 23);
  assert.equal(a.q, 'Segundo');
  assert.deepEqual(resolveAnchor(a, f.text), { s: 16, e: 23, status: 'exact' });
});

test('resolveAnchor: se reubica si se insertó texto antes', () => {
  const f = flatten(blocks);
  const a = makeAnchor(f.text, 16, 23);
  const moved = flatten(['Un bloque nuevo al principio.', ...blocks]);
  const r = resolveAnchor(a, moved.text);
  assert.equal(r.status, 'moved');
  assert.equal(moved.text.slice(r.s, r.e), 'Segundo');
});

test('resolveAnchor: con la cita repetida elige la ocurrencia por contexto', () => {
  const text = 'casa roja. casa azul. casa verde.';
  const a = makeAnchor(text, 22, 26); // "casa" de "casa verde"
  const r = resolveAnchor({ ...a, s: 5, e: 9 }, text); // en la posición vieja ya no está la cita -> usa el contexto
  assert.equal(r.status, 'moved');
  assert.equal(text.slice(r.s, r.s + 10), 'casa verde');
});

test('resolveAnchor: huérfana si la cita desapareció', () => {
  const f = flatten(blocks);
  const a = makeAnchor(f.text, 16, 23);
  assert.equal(resolveAnchor(a, 'otro texto totalmente distinto'), null);
  assert.equal(resolveAnchor({ s: 0, e: 0, q: '' }, f.text), null);
  assert.equal(resolveAnchor(null, f.text), null);
});

test('trimRange quita espacios de los extremos', () => {
  assert.deepEqual(trimRange('  hola  ', 0, 8), { s: 2, e: 6 });
  assert.deepEqual(trimRange('   ', 0, 3), { s: 3, e: 3 });
});

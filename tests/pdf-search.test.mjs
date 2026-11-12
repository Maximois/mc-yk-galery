import test from 'node:test';
import assert from 'node:assert/strict';
import { indexPdfPageText } from '../src/reader/pdf-viewer.js';

test('la búsqueda PDF ignora mayúsculas y encuentra frases entre elementos', () => {
  const items = [
    { str: 'La biblioteca' },
    { type: 'beginMarkedContent' },
    { str: ' digital' },
    { str: 'guarda historias.' }
  ];

  assert.deepEqual(indexPdfPageText(items, 'BIBLIOTECA digital'), [[0, 1]]);
});

test('la búsqueda PDF normaliza espacios y devuelve los elementos de cada coincidencia', () => {
  const items = [{ str: 'Eco eco' }, { str: '  eco' }];
  assert.deepEqual(indexPdfPageText(items, 'eco'), [[0], [0], [1]]);
  assert.deepEqual(indexPdfPageText(items, '   '), []);
});

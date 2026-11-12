import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/data/store.js';
import { createImporter } from '../src/data/importer.js';
import { buildNotesMarkdown, buildNotesText, sortForExport } from '../src/notes/export.js';
import { base64ToBytes, bytesToBase64, newId, sha256Hex } from '../src/lib/bytes.js';
import { emptyCoverHtml, COVER_TITLE } from '../src/lib/cover.js';
import { escapeHtml, formatBytes, safeFileName } from '../src/lib/dom.js';

const mem = () => { const d = {}; return { get: async (k) => d[k] ?? null, set: async (k, v) => { d[k] = v; } }; };
const fakeFile = (name, text) => ({ name, arrayBuffer: async () => new TextEncoder().encode(text).buffer });

test('importar guarda el archivo y registra el libro; el mismo contenido no se duplica', async () => {
  const written = {};
  const files = { bookPath: (id, ext) => `books/${id}.${ext}`, writeBookFile: async (p, b) => { written[p] = b; } };
  const store = createStore(mem());
  const { importFile } = createImporter({ store, files });

  const r1 = await importFile(fakeFile('Mi Libro.MD', '# Hola'));
  assert.equal(r1.duplicate, false);
  assert.equal(r1.book.format, 'MD');
  assert.equal(r1.book.title, 'Mi Libro');
  assert.match(r1.book.id, /^bk_[0-9a-f]{20}$/);
  assert.equal(Object.keys(written).length, 1);

  const r2 = await importFile(fakeFile('copia.md', '# Hola'));
  assert.equal(r2.duplicate, true);
  assert.equal(r2.book.id, r1.book.id);
  assert.equal(store.books().length, 1);
});

test('base64 por trozos y sha256', async () => {
  const bytes = new Uint8Array(100000).map((_, i) => i % 251);
  assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
  assert.equal(await sha256Hex(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.notEqual(newId('int'), newId('int'));
});

test('trozos de 3 bytes se pueden concatenar en base64 sin relleno intermedio', () => {
  const bytes = new Uint8Array(3 * 1000).map((_, i) => (i * 7) % 256);
  const CH = 3 * 256;
  let joined = '';
  for (let o = 0; o < bytes.length; o += CH) joined += bytesToBase64(bytes.subarray(o, o + CH));
  assert.deepEqual(base64ToBytes(joined), bytes);
});

test('exportación: orden de lectura, Markdown y texto', () => {
  const book = { title: 'El libro', author: 'Ana' };
  const items = [
    { id: '2', type: 'note', text: 'segunda', comment: 'ojo', anchor: { s: 50 }, pct: 80, createdAt: '2026-11-09T10:00:00Z' },
    { id: '1', type: 'highlight', text: 'primera\nlinea', anchor: { s: 5 }, pct: 10, createdAt: '2026-11-09T11:00:00Z' },
    { id: '3', type: 'highlight', text: 'sin ancla', createdAt: '2026-11-08T11:00:00Z' },
    { id: '4', type: 'underline', text: 'subrayada', anchor: { s: 90 }, createdAt: '2026-11-09T12:00:00Z' }
  ];
  assert.deepEqual(sortForExport(items).map((i) => i.id), ['1', '2', '4', '3']);
  const md = buildNotesMarkdown(book, items);
  assert.ok(md.startsWith('# Notas: El libro\n\n*Ana*'));
  assert.ok(md.includes('> primera\n> linea'));
  assert.ok(md.includes('**Nota:** ojo'));
  const txt = buildNotesText(book, items);
  assert.ok(txt.includes('1. Resaltado'));
  assert.ok(txt.includes('2. Nota'));
  assert.ok(txt.includes('3. Subrayado'));
  assert.ok(buildNotesMarkdown(book, []).includes('_Sin anotaciones._'));
});

test('utilidades: escape, bytes, nombre de archivo, portada', () => {
  assert.equal(escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(safeFileName('¿Qué es esto? / año 2026'), 'Qué_es_esto_año_2026');
  assert.equal(safeFileName('///'), 'documento');
  assert.match(emptyCoverHtml(), new RegExp(COVER_TITLE));
  assert.match(emptyCoverHtml({ big: true }), /cover-empty big/);
});

// Prueba los lectores contra el núcleo REAL cargado como en el navegador (scripts clásicos, en el
// orden de doc-core.js). Los DOCX/ODT se fabrican con los escritores del propio núcleo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ROOT, coreLoadOrder, loadCoreLikeBrowser } from './helpers.mjs';
import { createTextReader, decodeText } from '../src/readers/text.js';
import { createDocxReader, createOdtReader } from '../src/readers/office.js';
import { flatten } from '../src/reader/anchors.js';

const require = createRequire(import.meta.url);
const core = loadCoreLikeBrowser();
const md = '# Capítulo uno\n\nPrimer párrafo del libro.\n\n- uno\n- dos\n\n> una cita\n';

test('el orden de carga de doc-core.js deja el núcleo completo', () => {
  assert.ok(coreLoadOrder().length >= 8);
  for (const k of ['xml', 'zip', 'model', 'textIo', 'html', 'docxRead', 'odtRead']) assert.ok(core[k], 'falta ' + k);
});

test('decodeText: UTF-8, BOM y Windows-1252', () => {
  assert.equal(decodeText(new TextEncoder().encode('año')), 'año');
  assert.equal(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x61])), 'a');
  assert.equal(decodeText(new Uint8Array([0x61, 0xf1, 0x6f])), 'año'); // latin-1 inválido como UTF-8
  assert.equal(decodeText(new Uint8Array([0xff, 0xfe, 0x61, 0x00])), 'a');
});

test('Markdown -> bloques con HTML indexado', async () => {
  const c = await createTextReader(core).load(new TextEncoder().encode(md), { title: 'Libro', format: 'MD' });
  assert.equal(c.kind, 'reflow');
  assert.equal(c.blocks.length, 4);
  assert.match(c.blocks[0].html, /<h1[^>]*>.*Capítulo uno/);
  assert.match(c.blocks[2].html, /<ul/);
  assert.ok(c.css.length > 100);
});

test('DOCX: ida y vuelta por el núcleo', async () => {
  const doc = core.textIo.textToDoc(md, { title: 'Libro' });
  const { parts } = require('../modules/document-editor/core/docx-write.js').docToDocxParts(doc);
  const bytes = await core.zip.writeZip(parts);
  const c = await createDocxReader(core).load(bytes, { format: 'DOCX' });
  assert.equal(c.blocks.length, 4);
  assert.match(c.blocks[1].html, /Primer párrafo del libro\./);
});

test('ODT: ida y vuelta por el núcleo', async () => {
  const doc = core.textIo.textToDoc(md, { title: 'Libro' });
  const { parts } = require('../modules/document-editor/core/odt-write.js').docToOdtParts(doc);
  const bytes = await core.zip.writeZip(parts);
  const c = await createOdtReader(core).load(bytes, { format: 'ODT' });
  assert.equal(c.blocks.length, 4);
  assert.match(c.blocks[1].html, /Primer párrafo del libro\./);
});

test('las anclas son deterministas: abrir dos veces el mismo archivo da el mismo texto aplanado', async () => {
  // Si no lo fueran (p. ej. por ids aleatorios del núcleo), las anotaciones no se reencontrarían.
  const text = (c) => flatten(c.blocks.map((b) => b.html.replace(/<[^>]*>/g, ''))).text;
  const bytes = new TextEncoder().encode(md);
  const a = await createTextReader(core).load(bytes, { title: 'L', format: 'MD' });
  const b = await createTextReader(core).load(bytes, { title: 'L', format: 'MD' });
  assert.equal(text(a), text(b));
  assert.ok(ROOT);
});

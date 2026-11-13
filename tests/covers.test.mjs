import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { thumbSize } from '../src/covers/thumb.js';
import { createCoverService } from '../src/covers/service.js';
import { hasCoverExtractor } from '../src/covers/extract.js';

// DOMParser para findCoverPath (el módulo epub.js lo usa del entorno del navegador)
const dom = new JSDOM('');
globalThis.DOMParser = dom.window.DOMParser;
const { findCoverPath } = await import('../src/readers/epub.js');

const u8 = (s) => new TextEncoder().encode(s);
const epub = (opf, extra = {}) => ({
  'META-INF/container.xml': u8('<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>'),
  'OEBPS/content.opf': u8(opf),
  ...extra
});
const pkg = (manifest, meta = '') => `<package xmlns="http://www.idpf.org/2007/opf"><metadata>${meta}</metadata><manifest>${manifest}</manifest><spine/></package>`;

test('thumbSize reduce sin deformar ni agrandar', () => {
  assert.deepEqual(thumbSize(720, 960), { w: 360, h: 480 });
  assert.deepEqual(thumbSize(100, 100), { w: 100, h: 100 }); // no agranda
  assert.deepEqual(thumbSize(2000, 500), { w: 360, h: 90 });
  assert.equal(thumbSize(0, 10), null);
});

test('findCoverPath: EPUB 3 (propiedad cover-image)', () => {
  const e = epub(pkg('<item id="c" href="img/tapa.jpg" media-type="image/jpeg" properties="cover-image"/>'), { 'OEBPS/img/tapa.jpg': u8('x') });
  assert.equal(findCoverPath(e), 'OEBPS/img/tapa.jpg');
});

test('findCoverPath: EPUB 2 (meta name=cover) con ruta relativa y %20', () => {
  const e = epub(pkg('<item id="portada" href="../imagenes/mi%20tapa.png" media-type="image/png"/><item id="o" href="o.png" media-type="image/png"/>', '<meta name="cover" content="portada"/>'), { 'imagenes/mi tapa.png': u8('x'), 'OEBPS/o.png': u8('y') });
  assert.equal(findCoverPath(e), 'imagenes/mi tapa.png');
});

test('findCoverPath: último recurso por nombre; y null si no hay o está dañado', () => {
  assert.equal(findCoverPath(epub(pkg('<item id="x" href="cover.jpeg" media-type="image/jpeg"/>'), { 'OEBPS/cover.jpeg': u8('x') })), 'OEBPS/cover.jpeg');
  assert.equal(findCoverPath(epub(pkg('<item id="x" href="foto.jpeg" media-type="image/jpeg"/>'), { 'OEBPS/foto.jpeg': u8('x') })), null);
  assert.equal(findCoverPath(epub(pkg('<item id="c" href="falta.jpg" media-type="image/jpeg" properties="cover-image"/>'))), null); // declarada pero no existe
  assert.equal(findCoverPath({}), null);
  assert.equal(findCoverPath(epub('<<no es xml')), null);
});

test('hasCoverExtractor', () => {
  assert.ok(hasCoverExtractor('pdf') && hasCoverExtractor('EPUB'));
  assert.ok(!hasCoverExtractor('TXT'));
});

function harness({ extract, format = 'PDF' } = {}) {
  const books = new Map([['b1', { id: 'b1', title: 'Uno', format, path: 'books/b1.pdf' }]]);
  const written = new Map();
  const store = {
    getBook: (id) => books.get(id),
    books: () => [...books.values()],
    updateBook: async (id, patch) => { Object.assign(books.get(id), patch); }
  };
  const files = {
    readBookFile: async () => new Uint8Array([1, 2, 3]),
    writeBookFile: async (p, b) => { written.set(p, b); },
    deleteBookFile: async (p) => { written.delete(p); },
    coverPath: (id) => 'covers/' + id + '.jpg'
  };
  const svc = createCoverService({ store, files, extract, hasExtractor: (f) => f !== 'TXT', loadCore: async () => ({}) });
  return { svc, books, written };
}

test('servicio: guarda la portada, marca ok y avisa a las pantallas', async () => {
  const { svc, books, written } = harness({ extract: async () => new Blob([new Uint8Array([9, 9])]) });
  const seen = [];
  svc.onChange((id) => seen.push(id));
  await svc.ensure(books.get('b1'));
  assert.equal(books.get('b1').cover, 'ok');
  assert.ok(written.has('covers/b1.jpg'));
  assert.deepEqual(seen, ['b1']);
  assert.match(await svc.urlFor(books.get('b1')), /^data:image\/jpeg;base64,/);
});

test('servicio: sin portada -> none, y no se reintenta', async () => {
  let calls = 0;
  const { svc, books } = harness({ extract: async () => { calls++; return null; } });
  await svc.ensure(books.get('b1'));
  await svc.ensure(books.get('b1'));
  assert.equal(books.get('b1').cover, 'none');
  assert.equal(calls, 1);
  assert.equal(await svc.urlFor(books.get('b1')), null);
});

test('servicio: si el extractor falla, el libro queda "none" y no se rompe nada', async () => {
  const { svc, books } = harness({ extract: async () => { throw new Error('PDF dañado'); } });
  await svc.ensure(books.get('b1'));
  assert.equal(books.get('b1').cover, 'none');
});

test('servicio: formatos sin extractor van directo a none; remove borra el archivo', async () => {
  const { svc, books, written } = harness({ format: 'TXT', extract: async () => { throw new Error('no debería llamarse'); } });
  await svc.ensure(books.get('b1'));
  assert.equal(books.get('b1').cover, 'none');
  written.set('covers/b1.jpg', 1);
  await svc.remove('b1');
  assert.ok(!written.has('covers/b1.jpg'));
});

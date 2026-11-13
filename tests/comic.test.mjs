import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { loadCoreLikeBrowser } from './helpers.mjs';
import { imageSize, naturalCompare, imageMime } from '../src/readers/images.js';
import { createComicReader, createImageDocument, listComicImages, sniffArchive } from '../src/readers/comic.js';

globalThis.DOMParser = new JSDOM('').window.DOMParser;
const core = loadCoreLikeBrowser();
const b64 = (s) => Uint8Array.from(Buffer.from(s, 'base64'));
const enc = (s) => new TextEncoder().encode(s);
const IMG = {
  png: b64('iVBORw0KGgoAAAANSUhEUgAAAAcAAAAFCAIAAAAG+GGPAAAAFklEQVR4XmM8wcXFgAGYMIUYGKggCgBgIgDmQ5jjSQAAAABJRU5ErkJggg=='),
  jpg: b64('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAJAA0DASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCGiiivhz84P//Z'),
  gif: b64('R0lGODdhBAAGAIAAAAAAAAAAACwAAAAABAAGAAAICwABCBxIsKDBgQEBADs='),
  webp: b64('UklGRjgAAABXRUJQVlA4ICwAAACQAQCdASoLAAgAAUAmJaACdLoAA5gA/vsZy/+BO/+BO/+BO/8Cd9fAFPEgAA=='),
  webpl: b64('UklGRh4AAABXRUJQVlA4TBEAAAAvBYAAAAdQhSoUuf+BiOh/AAA=')
};

test('imageSize lee PNG, JPEG, GIF y WebP (con pérdida y sin pérdida) sin decodificar', () => {
  assert.deepEqual(imageSize(IMG.png), { w: 7, h: 5 });
  assert.deepEqual(imageSize(IMG.jpg), { w: 13, h: 9 });
  assert.deepEqual(imageSize(IMG.gif), { w: 4, h: 6 });
  assert.deepEqual(imageSize(IMG.webp), { w: 11, h: 8 });
  assert.deepEqual(imageSize(IMG.webpl), { w: 6, h: 3 });
  assert.equal(imageSize(enc('no soy una imagen, solo texto largo')), null);
  assert.equal(imageSize(new Uint8Array(3)), null);
});

test('orden natural: pag2 antes que pag10, sin distinguir mayúsculas', () => {
  const names = ['pag10.jpg', 'Pag2.jpg', 'pag1.jpg', 'pag3.jpg'].sort(naturalCompare);
  assert.deepEqual(names, ['pag1.jpg', 'Pag2.jpg', 'pag3.jpg', 'pag10.jpg']);
  assert.equal(imageMime('a/B.JPEG'), 'image/jpeg');
  assert.equal(imageMime('notas.txt'), null);
});

test('listComicImages ignora carpetas del sistema, archivos ocultos y no imágenes', () => {
  const e = { '__MACOSX/._1.jpg': 1, '.DS_Store': 1, 'c/10.png': 1, 'c/2.png': 1, 'c/': 1, 'ComicInfo.xml': 1, 'c/.oculta.jpg': 1, 'c/leeme.txt': 1 };
  assert.deepEqual(listComicImages(e), ['c/2.png', 'c/10.png']);
});

test('sniffArchive distingue ZIP, RAR y 7z (por contenido, no por extensión)', () => {
  assert.equal(sniffArchive(Uint8Array.from([0x50, 0x4b, 3, 4])), 'zip');
  assert.equal(sniffArchive(enc('Rar!\x1a\x07')), 'rar');
  assert.equal(sniffArchive(Uint8Array.from([0x37, 0x7a, 0xbc, 0xaf])), '7z');
  assert.equal(sniffArchive(enc('hola')), 'unknown');
});

async function cbz(files) {
  const entries = Object.entries(files).map(([name, data]) => ({ name, data }));
  return core.zip.writeZip(entries);
}

test('CBZ: páginas en orden natural, tamaños desde la cabecera y metadatos de ComicInfo', async () => {
  const bytes = await cbz({
    'p10.png': IMG.png, 'p2.jpg': IMG.jpg, 'p1.gif': IMG.gif, '__MACOSX/._p1.gif': enc('x'),
    'ComicInfo.xml': enc('<ComicInfo><Series>Serie</Series><Number>4</Number><Writer>Ana</Writer></ComicInfo>')
  });
  const c = await createComicReader(core).load(bytes, { title: 'archivo', format: 'CBZ' });
  assert.equal(c.kind, 'pdf');
  assert.equal(c.preferPaged, true);
  assert.equal(c.title, 'Serie #4');
  assert.equal(c.meta.author, 'Ana');
  assert.equal(c.pdf.numPages, 3);
  const sizes = [];
  for (let n = 1; n <= 3; n++) { const v = (await c.pdf.getPage(n)).getViewport({ scale: 2 }); sizes.push([v.width, v.height]); }
  assert.deepEqual(sizes, [[8, 12], [26, 18], [14, 10]]); // gif (4x6), jpg (13x9), png (7x5), por 2
  assert.deepEqual((await (await c.pdf.getPage(1)).getTextContent()).items, []);
  assert.equal((await c.pdf.getMetadata()).info.Author, 'Ana');
});

test('CBZ: la capa de texto del visor no falla y destroy() libera las páginas', async () => {
  const c = await createComicReader(core).load(await cbz({ 'a.png': IMG.png }), { format: 'CBZ' });
  await c.lib.renderTextLayer().promise;
  await c.pdf.destroy();
  await assert.rejects(() => c.pdf.getPage(1), /cerrado/);
});

test('CBR/CB7 reales (RAR, 7z) dan un mensaje claro; un CBR que en realidad es ZIP abre', async () => {
  const r = createComicReader(core);
  await assert.rejects(() => r.load(enc('Rar!\x1a\x07\x00resto'), { format: 'CBR' }), /RAR \(CBR\).*CBZ/);
  await assert.rejects(() => r.load(Uint8Array.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]), { format: 'CBR' }), /7-Zip/);
  await assert.rejects(() => r.load(enc('esto no es un archivo comprimido'), { format: 'CBZ' }), /no es un CBZ válido/);
  const zipAsCbr = await r.load(await cbz({ '1.png': IMG.png }), { format: 'CBR' });
  assert.equal(zipAsCbr.pdf.numPages, 1);
});

test('CBZ sin imágenes -> error claro', async () => {
  const bytes = await cbz({ 'leeme.txt': enc('hola') });
  await assert.rejects(() => createComicReader(core).load(bytes, { format: 'CBZ' }), /no contiene imágenes/);
});

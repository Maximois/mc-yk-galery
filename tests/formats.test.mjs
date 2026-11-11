// Lectores de PDF, EPUB, RTF, DOC y HTML contra el núcleo real, con archivos de prueba fabricados.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import { loadCoreLikeBrowser } from './helpers.mjs';
import { createRtfReader, createDocReader, createHtmlReader } from '../src/readers/legacy.js';
import { createEpubReader, chapterToBlocks, readPackage, resolvePath } from '../src/readers/epub.js';
import { createPdfReader } from '../src/readers/pdf.js';
import { canRead } from '../src/readers/index.js';

const require = createRequire(import.meta.url);
globalThis.DOMParser = new JSDOM('').window.DOMParser; // el lector EPUB usa DOMParser del navegador
const core = loadCoreLikeBrowser();
core.pdfjs = require('../modules/document-editor/vendor/pdf.min.js'); // en la app lo carga doc-core.js
core.pdfText = globalThis.McDocPdfText; // ídem: doc-core.js lo expone desde el global `McDocPdfText`
const enc = (s) => new TextEncoder().encode(s);
const plain = (c) => c.blocks.map((b) => b.html.replace(/<[^>]*>/g, '')).join('\n');

test('canRead cubre todos los formatos con lector y rechaza el resto', () => {
  for (const f of ['TXT', 'MD', 'docx', 'ODT', 'EPUB', 'RTF', 'DOC', 'HTML', 'htm', 'PDF']) assert.ok(canRead(f), f);
  for (const f of ['MOBI', 'CBZ', '', undefined]) assert.equal(canRead(f), false, String(f));
});

test('RTF: texto y párrafos', async () => {
  const rtf = '{\\rtf1\\ansi\\deff0 {\\fonttbl{\\f0 Arial;}} Hola \\b mundo\\b0 .\\par Segundo p\\\'e1rrafo.\\par}';
  const c = await createRtfReader(core).load(enc(rtf), { title: 'R', format: 'RTF' });
  assert.match(plain(c), /Hola mundo\./);
  assert.match(plain(c), /Segundo párrafo\./);
});

test('HTML: el texto se lee y los scripts no aparecen', async () => {
  const html = '<html><body><h1>Título</h1><p>Hola <b>mundo</b></p><script>alert(1)</script></body></html>';
  const c = await createHtmlReader(core).load(enc(html), { title: 'H', format: 'HTML' });
  assert.match(plain(c), /Título/);
  assert.match(plain(c), /Hola mundo/);
  assert.doesNotMatch(plain(c), /alert/);
});

test('DOC: un archivo .doc que en realidad es RTF se abre por el respaldo', async () => {
  const rtf = '{\\rtf1\\ansi Contenido de prueba.\\par}';
  const c = await createDocReader(core).load(enc(rtf), { title: 'D', format: 'DOC' });
  assert.match(plain(c), /Contenido de prueba\./);
});

// ---------------------------------------------------------------------------------- PDF
function makePdf(lines) {
  const content = 'BT /F1 14 Tf 72 720 Td 18 TL ' + lines.map((l) => `(${l}) Tj T*`).join(' ') + ' ET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return enc(out);
}

test('PDF: extrae el texto con pdf.js y no consume el buffer original', async () => {
  const bytes = makePdf(['Primera linea del documento.', 'Segunda linea de prueba.']);
  const size = bytes.length;
  const c = await createPdfReader(core).load(bytes, { title: 'P', format: 'PDF' });
  assert.match(plain(c), /Primera linea del documento/);
  assert.match(plain(c), /Segunda linea de prueba/);
  assert.equal(bytes.length, size, 'el buffer original sigue usable (se le pasa una copia a pdf.js)');
  assert.equal(c.meta.pageCount, 1);
});

test('PDF sin texto avisa en vez de fallar en silencio', async () => {
  const c = await createPdfReader(core).load(makePdf([]), { title: 'P', format: 'PDF' });
  assert.equal(c.blocks.length, 0);
  assert.ok(c.warnings.some((w) => /no tiene texto|escaneado/i.test(w)));
});

// --------------------------------------------------------------------------------- EPUB
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

async function buildEpub(chapters, { extra = [] } = {}) {
  const parts = [
    { name: 'mimetype', data: enc('application/epub+zip') },
    { name: 'META-INF/container.xml', data: enc('<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>') },
    {
      name: 'OEBPS/content.opf',
      data: enc('<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Libro EPUB</dc:title><dc:creator>Ana Autora</dc:creator></metadata><manifest>' +
        chapters.map((_, i) => `<item id="c${i}" href="text/ch${i}.xhtml" media-type="application/xhtml+xml"/>`).join('') +
        '<item id="nota" href="text/nota.xhtml" media-type="application/xhtml+xml"/></manifest><spine>' +
        chapters.map((_, i) => `<itemref idref="c${i}"/>`).join('') + '<itemref idref="nota" linear="no"/></spine></package>')
    },
    { name: 'OEBPS/text/nota.xhtml', data: enc('<html><body><p>NO DEBE APARECER</p></body></html>') },
    ...chapters.map((body, i) => ({ name: `OEBPS/text/ch${i}.xhtml`, data: enc(`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title><style>p{color:red}</style></head><body>${body}</body></html>`) })),
    ...extra
  ];
  return core.zip.writeZip(parts);
}

test('EPUB: capítulos en orden, metadatos, y se ignora lo no lineal', async () => {
  const bytes = await buildEpub(['<h1>Uno</h1><p>Texto uno.</p>', '<h1>Dos</h1><p>Texto dos.</p>']);
  const c = await createEpubReader(core).load(bytes, { title: 'x', format: 'EPUB' });
  assert.equal(c.title, 'Libro EPUB');
  assert.equal(c.meta.author, 'Ana Autora');
  assert.deepEqual(c.blocks.map((b) => b.html.replace(/<[^>]*>/g, '')), ['Uno', 'Texto uno.', 'Dos', 'Texto dos.']);
});

test('EPUB: limpia scripts, estilos y eventos; incrusta imágenes internas y descarta las externas', async () => {
  const body = '<div class="cap"><h1 onclick="x()">Hola</h1><script>alert(1)</script><p style="color:red">Texto</p>' +
    '<img src="../img/a.png" alt="a"/><img src="https://malo.example/x.png"/><a href="https://x.example">enlace</a></div>';
  const bytes = await buildEpub([body], { extra: [{ name: 'OEBPS/img/a.png', data: PNG }] });
  const c = await createEpubReader(core).load(bytes, { title: 'x', format: 'EPUB' });
  const all = c.blocks.map((b) => b.html).join('');
  assert.doesNotMatch(all, /script|onclick|style=|malo\.example|href="https/);
  assert.match(all, /src="data:image\/png;base64,/);
  assert.equal(c.blocks.length, 4, 'el <div> envoltorio se baja un nivel: h1, p, img, a');
});

test('EPUB inválido da errores claros', async () => {
  const sinContainer = await core.zip.writeZip([{ name: 'x.txt', data: enc('hola') }]);
  await assert.rejects(createEpubReader(core).load(sinContainer, {}), /container\.xml/);
});

test('EPUB generado por el propio núcleo (epub.js) se puede leer de vuelta', async () => {
  const doc = core.textIo.textToDoc('# Capítulo\n\nUn párrafo de prueba.\n', { title: 'Ida y vuelta' });
  const { parts } = require('../modules/document-editor/core/epub.js').docToEpubParts(doc);
  const c = await createEpubReader(core).load(await core.zip.writeZip(parts), { title: 'x', format: 'EPUB' });
  assert.equal(c.title, 'Ida y vuelta');
  assert.match(plain(c), /Un párrafo de prueba\./);
});

test('resolvePath: relativas, ../ y %20', () => {
  assert.equal(resolvePath('OEBPS/content.opf', 'text/ch1.xhtml'), 'OEBPS/text/ch1.xhtml');
  assert.equal(resolvePath('OEBPS/text/ch1.xhtml', '../img/a%20b.png'), 'OEBPS/img/a b.png');
  assert.equal(resolvePath('a/b.xhtml', 'c.xhtml#sec'), 'a/c.xhtml');
});

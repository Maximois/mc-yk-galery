import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { loadCoreLikeBrowser } from './helpers.mjs';
import { createFb2Reader, decodeFb2, fb2Cover } from '../src/readers/fb2.js';

globalThis.DOMParser = new JSDOM('').window.DOMParser;
const core = loadCoreLikeBrowser();
const enc = (s) => new TextEncoder().encode(s);
const plain = (c) => c.blocks.map((b) => b.html.replace(/<[^>]*>/g, '')).join('\n');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const fb2 = (body, extra = '', info = '') =>
  '<?xml version="1.0" encoding="UTF-8"?><FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">' +
  '<description><title-info><book-title>El libro</book-title><author><first-name>Ana</first-name><last-name>Paz</last-name></author>' + info + '</title-info></description>' +
  body + extra + '</FictionBook>';

test('FB2: metadatos, títulos por nivel, párrafos y estilos en línea', async () => {
  const x = fb2('<body><title><p>Portada</p></title><section><title><p>Uno</p></title><p>Hola <strong>fuerte</strong> y <emphasis>suave</emphasis> y <strikethrough>x</strikethrough>.</p>' +
    '<section><title><p>Uno.A</p></title><p>Dentro</p></section></section></body>');
  const c = await createFb2Reader(core).load(enc(x), { title: 'archivo', format: 'FB2' });
  assert.equal(c.kind, 'reflow');
  assert.equal(c.title, 'El libro');
  assert.equal(c.meta.author, 'Ana Paz');
  assert.deepEqual(c.blocks.map((b) => b.html), [
    '<h2>Portada</h2>', '<h2>Uno</h2>', '<p>Hola <strong>fuerte</strong> y <em>suave</em> y <del>x</del>.</p>', '<h3>Uno.A</h3>', '<p>Dentro</p>'
  ]);
});

test('FB2: poemas, citas, epígrafes, líneas vacías y subtítulos', async () => {
  const x = fb2('<body><section><epigraph><p>Epí</p><text-author>Autor</text-author></epigraph><subtitle>Sub</subtitle><empty-line/>' +
    '<poem><stanza><v>verso 1</v><v>verso 2</v></stanza></poem><cite><p>cita</p></cite></section></body>');
  const c = await createFb2Reader(core).load(enc(x), {});
  const html = c.blocks.map((b) => b.html);
  assert.ok(html.some((h) => h.startsWith('<blockquote>') && h.includes('Epí') && h.includes('Autor')));
  assert.ok(html.includes('<p><strong>Sub</strong></p>'));
  assert.ok(html.includes('<p>&nbsp;</p>'));
  assert.ok(html.includes('<p>verso 1<br>verso 2</p>'));
  assert.ok(html.includes('<blockquote><p>cita</p></blockquote>'));
});

test('FB2: las notas al pie van al final bajo "Notas"; las imágenes salen de los <binary> del archivo', async () => {
  const x = fb2('<body><section><p>Texto<a l:href="#n1">[1]</a></p><image l:href="#img1"/><image l:href="#falta"/><image l:href="http://externa/x.png"/></section></body>' +
    '<body name="notes"><section id="n1"><title><p>1</p></title><p>La nota.</p></section></body>',
    '<binary id="img1" content-type="image/png">' + PNG + '</binary>');
  const c = await createFb2Reader(core).load(enc(x), {});
  const last = c.blocks.map((b) => b.html);
  assert.ok(last.findIndex((h) => h === '<h2>Notas</h2>') > 0);
  assert.equal(plain(c).split('\n').pop(), 'La nota.');
  assert.equal(last.filter((h) => h.includes('<img')).length, 1); // solo la que está en el archivo
  assert.ok(last.find((h) => h.includes('<img')).includes('data:image/png;base64,'));
  assert.ok(!last.some((h) => /externa|href=/.test(h)));
});

test('FB2: portada desde <coverpage>; sin portada -> null', () => {
  const withCover = fb2('<body><section><p>x</p></section></body>', '<binary id="cv" content-type="image/png">' + PNG + '</binary>', '<coverpage><image l:href="#cv"/></coverpage>');
  const c = fb2Cover(enc(withCover));
  assert.equal(c.mime, 'image/png');
  assert.ok(c.bytes.length > 10 && c.bytes[0] === 0x89);
  assert.equal(fb2Cover(enc(fb2('<body><section><p>x</p></section></body>'))), null);
  assert.equal(fb2Cover(enc('no es xml')), null);
});

test('FB2: respeta la codificación declarada (windows-1251) y el texto con < > & queda escapado', async () => {
  // «Привет» en windows-1251
  const head = '<?xml version="1.0" encoding="windows-1251"?><FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"><description><title-info><book-title>';
  const tail = '</book-title></title-info></description><body><section><p>a &lt;script&gt; &amp; b</p></section></body></FictionBook>';
  const bytes = Uint8Array.from([...enc(head), 0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, ...enc(tail)]);
  assert.match(decodeFb2(bytes), /Привет/);
  const c = await createFb2Reader(core).load(bytes, {});
  assert.equal(c.title, 'Привет');
  assert.equal(c.blocks[0].html, '<p>a &lt;script&gt; &amp; b</p>');
});

test('FB2: archivos inválidos dan un error claro', async () => {
  const r = createFb2Reader(core);
  await assert.rejects(() => r.load(enc('<root><a></root>'), {}), /FB2 inválido/);
  await assert.rejects(() => r.load(enc('<?xml version="1.0"?><html/>'), {}), /no es un FB2/);
});

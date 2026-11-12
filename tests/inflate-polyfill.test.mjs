// Simula un WebView sin DecompressionStream('deflate-raw') (Chrome 92-102): el constructor existe pero lanza.
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { ensureDeflateRaw } from '../src/lib/inflate-polyfill.js';
import { loadCoreLikeBrowser } from './helpers.mjs';

const realDecompression = globalThis.DecompressionStream;
const realCompression = globalThis.CompressionStream;
const restore = () => { globalThis.DecompressionStream = realDecompression; globalThis.CompressionStream = realCompression; };
const breakDeflateRaw = () => {
  globalThis.DecompressionStream = class { constructor(f) { throw new TypeError("Failed to construct 'DecompressionStream': Unsupported compression format: '" + f + "'"); } };
};
const inflateViaStream = async (compressed) =>
  new Uint8Array(await new Response(new Response(compressed).body.pipeThrough(new globalThis.DecompressionStream('deflate-raw'))).arrayBuffer());

test('si el navegador ya soporta deflate-raw no toca nada', async () => {
  restore();
  assert.equal(await ensureDeflateRaw(), false);
  assert.equal(globalThis.DecompressionStream, realDecompression);
});

test('sin soporte: instala el reemplazo y descomprime igual que el nativo (datos de 300 KB, varios trozos)', async () => {
  breakDeflateRaw();
  try {
    assert.throws(() => new globalThis.DecompressionStream('deflate-raw'), /Unsupported/);
    assert.equal(await ensureDeflateRaw(), true);
    const original = Uint8Array.from({ length: 300000 }, (_, i) => (i * 31 + (i >> 7)) & 0xff);
    const compressed = zlib.deflateRawSync(original);
    assert.deepEqual(await inflateViaStream(compressed), original);
    assert.throws(() => new globalThis.DecompressionStream('gzip'), /Unsupported compression format/);
  } finally { restore(); }
});

test('sin soporte: se puede leer un DOCX completo con el núcleo real', async () => {
  const { createDocxReader } = await import('../src/readers/office.js');
  const { createRequire } = await import('node:module');
  breakDeflateRaw();
  try {
    await ensureDeflateRaw();
    // El núcleo se carga UNA vez en este proceso (sus scripts declaran constantes globales) y ya ve el reemplazo.
    const core = loadCoreLikeBrowser();
    const doc = core.textIo.textToDoc('# Titulo\n\nTexto del documento comprimido.\n'.repeat(200), { title: 'T' });
    const parts = createRequire(import.meta.url)('../modules/document-editor/core/docx-write.js').docToDocxParts(doc).parts;
    const bytes = await core.zip.writeZip(parts); // comprime con el CompressionStream nativo
    const c = await createDocxReader(core).load(bytes, { format: 'DOCX' }); // descomprime con el reemplazo
    assert.ok(c.blocks.length > 100);
    assert.match(c.blocks[1].html, /Texto del documento comprimido/);
  } finally { restore(); }
});

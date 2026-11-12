// Prueba la lógica DOM del visor (selección -> ancla -> resaltado -> reabrir) con jsdom.
// jsdom no implementa iframe.srcdoc, por eso se usa viewer.attach() sobre el documento ya armado
// con pageHtml(): es exactamente el HTML que recibe el iframe en la app.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { loadCoreLikeBrowser } from './helpers.mjs';
import { createTextReader } from '../src/readers/text.js';
import { createReflowViewer, pageHtml } from '../src/reader/reflow-viewer.js';

const core = loadCoreLikeBrowser();
const MD = '# Título\n\nPrimer párrafo con palabras.\n\nSegundo párrafo, otro texto.\n\n- item uno\n- item dos\n';

async function open(content, highlights = []) {
  const dom = new JSDOM(pageHtml(content));
  globalThis.NodeFilter = dom.window.NodeFilter; // el visor lo usa como global del navegador
  const events = { selection: [], progress: [] };
  const viewer = createReflowViewer({
    host: null,
    onSelectionChange: (s) => events.selection.push(s),
    onProgress: (p) => events.progress.push(p)
  });
  const orphans = await viewer.attach(dom.window.document, dom.window, { highlights });
  return { dom, doc: dom.window.document, win: dom.window, viewer, orphans, events };
}

function select(doc, win, fromEl, fromOffset, toEl, toOffset) {
  const r = doc.createRange();
  r.setStart(fromEl.firstChild, fromOffset);
  r.setEnd(toEl.firstChild, toOffset);
  const sel = win.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

const load = (md = MD) => createTextReader(core).load(new TextEncoder().encode(md), { title: 'Libro', format: 'MD' });

test('seleccionar dentro de un párrafo produce un ancla con la cita exacta', async () => {
  const { doc, win, viewer } = await open(await load());
  const p = doc.querySelectorAll('.blk')[1].querySelector('p');
  select(doc, win, p, 7, p, 15); // "párrafo "
  const cap = viewer.captureSelection();
  assert.equal(cap.text, 'párrafo');
  assert.equal(cap.anchor.q, 'párrafo');
});

test('una selección que cruza dos bloques se resalta en ambos, sin alterar el texto', async () => {
  const content = await load();
  const { doc, win, viewer } = await open(content);
  const before = [...doc.querySelectorAll('.blk')].map((b) => b.textContent);
  const p1 = doc.querySelectorAll('.blk')[1].querySelector('p');
  const p2 = doc.querySelectorAll('.blk')[2].querySelector('p');
  select(doc, win, p1, 19, p2, 7); // "palabras." + "Segundo"
  const cap = viewer.captureSelection();
  assert.match(cap.text, /palabras\. Segundo/);

  assert.equal(viewer.addHighlight({ id: 'h1', type: 'highlight', anchor: cap.anchor }), true);
  const marks = [...doc.querySelectorAll('mark[data-hl="h1"]')];
  assert.equal(marks.map((m) => m.textContent).join('|'), 'palabras.|Segundo');
  const after = [...doc.querySelectorAll('.blk')].map((b) => b.textContent);
  assert.deepEqual(after, before, 'envolver en <mark> no debe cambiar el texto de los bloques');
});

test('los resaltados guardados se vuelven a pintar al reabrir el libro', async () => {
  const content = await load();
  const first = await open(content);
  const p = first.doc.querySelectorAll('.blk')[2].querySelector('p');
  select(first.doc, first.win, p, 0, p, 7);
  const item = { id: 'h2', type: 'note', anchor: first.viewer.captureSelection().anchor };

  const second = await open(content, [item]); // documento nuevo, como al reabrir la app
  assert.deepEqual(second.orphans, []);
  const mark = second.doc.querySelector('mark[data-hl="h2"]');
  assert.equal(mark.textContent, 'Segundo');
  assert.ok(mark.classList.contains('hl-note'));
});

test('el subrayado se dibuja como subrayado (clase hl-underline), no como resaltado', async () => {
  const first = await open(await load());
  const p = first.doc.querySelectorAll('.blk')[2].querySelector('p');
  select(first.doc, first.win, p, 0, p, 7);
  const item = { id: 'u1', type: 'underline', anchor: first.viewer.captureSelection().anchor };
  const second = await open(await load(), [item]);
  const mark = second.doc.querySelector('mark[data-hl="u1"]');
  assert.ok(mark.classList.contains('hl-underline'));
  assert.ok(!mark.classList.contains('hl-note'));
  assert.match([...second.doc.querySelectorAll('style')].map((x) => x.textContent).join('\n'), /hl-underline\{background:none;text-decoration:underline/);
});

test('si el texto cambió de lugar la anotación se reubica; si desapareció queda huérfana', async () => {
  const first = await open(await load());
  const p = first.doc.querySelectorAll('.blk')[1].querySelector('p');
  select(first.doc, first.win, p, 0, p, 6); // "Primer"
  const item = { id: 'h3', type: 'highlight', anchor: first.viewer.captureSelection().anchor };

  const shifted = await open(await load('Un bloque nuevo antes de todo.\n\n' + MD), [item]);
  assert.deepEqual(shifted.orphans, []);
  assert.equal(shifted.doc.querySelector('mark[data-hl="h3"]').textContent, 'Primer');

  const gone = await open(await load('Otro libro distinto.\n'), [item]);
  assert.equal(gone.orphans.length, 1);
  assert.equal(gone.doc.querySelectorAll('mark').length, 0);
});

test('sin selección no hay ancla; la selección en blanco se descarta', async () => {
  const { doc, win, viewer } = await open(await load());
  assert.equal(viewer.captureSelection(), null);
  const p = doc.querySelectorAll('.blk')[1].querySelector('p');
  select(doc, win, p, 6, p, 7); // un solo espacio
  assert.equal(viewer.captureSelection(), null);
});

test('hasText y blockCount reflejan el contenido', async () => {
  const { viewer } = await open(await load());
  assert.equal(viewer.blockCount(), 4);
  assert.equal(viewer.hasText(), true);
});

test('la búsqueda encuentra coincidencias, avanza y limpia el resaltado', async () => {
  const { doc, viewer } = await open(await load());

  const first = viewer.findText('TEXTO');
  assert.deepEqual(first, { index: 1, total: 1, block: 2 });
  assert.equal(doc.querySelectorAll('mark.reader-search-hit').length, 1);
  assert.equal(doc.querySelector('mark.reader-search-hit').textContent.toLowerCase(), 'texto');

  assert.deepEqual(viewer.findText('texto', -1), { index: 1, total: 1, block: 2 });
  viewer.clearFind();
  assert.equal(doc.querySelectorAll('mark.reader-search-hit').length, 0);
  assert.equal(viewer.findText('no existe'), null);
});

test('la búsqueda pagina las coincidencias y vuelve al inicio al avanzar', async () => {
  const { viewer } = await open(await load());
  assert.deepEqual(viewer.findText('o'), { index: 1, total: 10, block: 0 });
  assert.deepEqual(viewer.findText('o'), { index: 2, total: 10, block: 1 });
  assert.deepEqual(viewer.findText('o', -1), { index: 1, total: 10, block: 0 });
});

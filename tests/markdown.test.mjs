import test from 'node:test';
import assert from 'node:assert/strict';
import { inlineToHtml, markdownToBlocks } from '../src/readers/markdown.js';

test('énfasis en línea', () => {
  assert.equal(inlineToHtml('**negrita** y *cursiva* y ~~tachado~~'), '<strong>negrita</strong> y <em>cursiva</em> y <del>tachado</del>');
  assert.equal(inlineToHtml('***ambas***'), '<strong><em>ambas</em></strong>');
  assert.equal(inlineToHtml('__fuerte__ y _suave_'), '<strong>fuerte</strong> y <em>suave</em>');
});

test('snake_case y asteriscos sueltos no son énfasis', () => {
  assert.equal(inlineToHtml('mi_variable_larga'), 'mi_variable_larga');
  assert.equal(inlineToHtml('2 * 3 * 4'), '2 * 3 * 4');
});

test('el código en línea no se interpreta y se escapa', () => {
  assert.equal(inlineToHtml('usa `**no** <b>` aquí'), 'usa <code>**no** &lt;b&gt;</code> aquí');
});

test('escapes con barra y HTML crudo escapado (sin ejecutar nada)', () => {
  assert.equal(inlineToHtml('\\*literal\\*'), '*literal*');
  const html = inlineToHtml('<script>alert(1)</script> & "x"');
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;') && html.includes('&amp;'));
});

test('enlaces e imágenes: se ve el texto, no se carga nada externo', () => {
  assert.equal(inlineToHtml('[Mozilla](https://mozilla.org)'), '<span class="md-link">Mozilla</span>');
  assert.equal(inlineToHtml('![logo](http://x/y.png)'), '<span class="md-img">logo</span>');
  assert.ok(!/href=|src=/.test(inlineToHtml('[a](http://e) ![b](http://f)')));
  assert.equal(inlineToHtml('[**fuerte**](u)'), '<span class="md-link"><strong>fuerte</strong></span>');
});

test('bloques: títulos, párrafos con saltos, regla', () => {
  const b = markdownToBlocks('# Título\n\nUna línea\nsigue aquí  \ny corte.\n\n---\n\n## Dos');
  assert.deepEqual(b, ['<h1>Título</h1>', '<p>Una línea sigue aquí<br>y corte.</p>', '<hr>', '<h2>Dos</h2>']);
});

test('título subrayado (setext)', () => {
  assert.deepEqual(markdownToBlocks('Gran título\n===========\n\nSub\n---\n'), ['<h1>Gran título</h1>', '<h2>Sub</h2>']);
});

test('código en bloque (con y sin lenguaje) conserva el contenido tal cual', () => {
  const b = markdownToBlocks('```js\nconst a = "<x>";\n\n  sangrado\n```\n\nfin');
  assert.equal(b[0], '<pre><code>const a = &quot;&lt;x&gt;&quot;;\n\n  sangrado</code></pre>');
  assert.equal(b[1], '<p>fin</p>');
});

test('listas: viñetas, numeradas con inicio, anidadas y con énfasis', () => {
  assert.deepEqual(markdownToBlocks('- uno\n- **dos**\n- tres'), ['<ul><li>uno</li><li><strong>dos</strong></li><li>tres</li></ul>']);
  assert.deepEqual(markdownToBlocks('3. c\n4. d'), ['<ol start="3"><li>c</li><li>d</li></ol>']);
  assert.deepEqual(markdownToBlocks('- a\n  - a1\n  - a2\n- b'), ['<ul><li>a<ul><li>a1</li><li>a2</li></ul></li><li>b</li></ul>']);
});

test('citas (con contenido dentro) y tablas', () => {
  assert.deepEqual(markdownToBlocks('> **cita**\n> segunda'), ['<blockquote><p><strong>cita</strong> segunda</p></blockquote>']);
  const t = markdownToBlocks('| A | B |\n|---|:-:|\n| 1 | x*y* |\n| 2 | |')[0];
  assert.ok(t.startsWith('<table><thead><tr><th>A</th><th>B</th></tr></thead>'));
  assert.ok(t.includes('<td>x<em>y</em></td>') && t.includes('<td></td>'));
});

test('texto vacío o solo espacios no produce bloques; CRLF y BOM se toleran', () => {
  assert.deepEqual(markdownToBlocks('  \n\n'), []);
  assert.deepEqual(markdownToBlocks('﻿# A\r\n\r\ntexto\r\n'), ['<h1>A</h1>', '<p>texto</p>']);
});

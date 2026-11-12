// Vigila el piso de compatibilidad (Chrome/Android WebView). El número sale de capacitor.config.ts
// (android.minWebViewVersion) y esta prueba falla si el código de la app usa algo más nuevo.
// - Código propio (src/) y núcleo copiado (modules/document-editor/core): sintaxis Y funciones del navegador.
// - pdf.js vendorizado: solo sintaxis (sus llamadas a APIs nuevas van detrás de detección en su propio código).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import { ROOT } from './helpers.mjs';

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const FLOOR = Number(/minWebViewVersion:\s*(\d+)/.exec(read('capacitor.config.ts'))[1]);

function files(dir, ext) {
  const out = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...files(rel, ext)); else if (e.name.endsWith(ext)) out.push(rel);
  }
  return out;
}

const parse = (src) => {
  const opts = { ecmaVersion: 'latest', allowHashBang: true };
  try { return acorn.parse(src, { ...opts, sourceType: 'script' }); } catch { return acorn.parse(src, { ...opts, sourceType: 'module' }); }
};

// Versión de Chrome que introdujo cada cosa.
const API = { at: 92, replaceAll: 85, hasOwn: 93, findLast: 97, findLastIndex: 97, toSorted: 110, toReversed: 110, toSpliced: 110, withResolvers: 119, fromAsync: 121, isWellFormed: 111, toWellFormed: 111, groupBy: 117 };
const GLOBAL_CALLS = { structuredClone: 98 };

function scan(src, { apis }) {
  const found = new Map();
  const add = (what, v) => { if (!found.has(what) || found.get(what) < v) found.set(what, v); };
  walk.full(parse(src), (n) => {
    switch (n.type) {
      case 'ChainExpression': add('?.', 80); break;
      case 'LogicalExpression': if (n.operator === '??') add('??', 80); break;
      case 'AssignmentExpression': if (['??=', '||=', '&&='].includes(n.operator)) add(n.operator, 85); break;
      case 'PropertyDefinition': add(n.key.type === 'PrivateIdentifier' ? 'campo privado' : 'campo de clase', n.key.type === 'PrivateIdentifier' ? 74 : 72); break;
      case 'MethodDefinition': if (n.key.type === 'PrivateIdentifier') add('método privado', 84); break;
      case 'StaticBlock': add('static {}', 94); break;
      case 'BinaryExpression': if (n.left.type === 'PrivateIdentifier') add('#x in obj', 91); break;
      case 'CatchClause': if (!n.param) add('catch sin parámetro', 66); break;
      case 'ImportExpression': add('import()', 63); break;
      case 'Literal':
        if (n.regex) { const f = n.regex.flags; if (f.includes('v')) add('regex /v', 112); if (f.includes('d')) add('regex /d', 90); }
        if (typeof n.raw === 'string' && /^\d[\d_]*_\d/.test(n.raw)) add('separador numérico', 75);
        break;
      case 'CallExpression':
        if (!apis) break;
        if (n.callee.type === 'MemberExpression' && !n.callee.computed && n.callee.property.type === 'Identifier') {
          const m = n.callee.property.name;
          if (API[m]) add('.' + m + '()', API[m]);
        }
        if (n.callee.type === 'Identifier' && GLOBAL_CALLS[n.callee.name]) add(n.callee.name + '()', GLOBAL_CALLS[n.callee.name]);
        break;
    }
  });
  return found;
}

function offenders(list, opts) {
  const bad = [];
  for (const f of list) for (const [what, v] of scan(read(f), opts)) if (v > FLOOR) bad.push(f + ': ' + what + ' (Chrome ' + v + ')');
  return bad;
}

test('el piso sale de capacitor.config.ts y vite.config.ts compila para el mismo', () => {
  assert.ok(FLOOR >= 85, 'pdf.js necesita al menos Chrome 85 por su sintaxis (??=, métodos privados)');
  assert.match(read('vite.config.ts'), new RegExp("target:\\s*'chrome" + FLOOR + "'"), 'build.target debe ser chrome' + FLOOR);
  assert.match(read('capacitor.config.ts'), /errorPath:\s*'webview-antiguo\.html'/);
  assert.ok(fs.existsSync(path.join(ROOT, 'public/webview-antiguo.html')), 'falta la página de aviso para WebViews viejos');
});

test('código propio y núcleo copiado: sin sintaxis ni funciones más nuevas que el piso', () => {
  const list = [...files('src', '.js'), ...files('modules/document-editor/core', '.js')];
  assert.ok(list.length > 30);
  assert.deepEqual(offenders(list, { apis: true }), []);
});

test('pdf.js vendorizado: su sintaxis cabe en el piso', () => {
  const bad = offenders(['modules/document-editor/vendor/pdf.min.js', 'modules/document-editor/vendor/pdf.worker.min.js'], { apis: false });
  assert.deepEqual(bad, [], 'si falla, el pdf.js copiado exige un WebView más nuevo que el piso declarado');
});

test('el detector de CSS exige respaldo para dvh', () => {
  const withFallback = /([\w-]+):\s*(\d+)vh;\s*\1:\s*\2[dsl]vh;/g;
  assert.ok(!'height: 100vh;\n  height: 100dvh;'.replace(withFallback, '$1:$2vh;').includes('dvh'));
  assert.ok('height: 100dvh;'.replace(withFallback, '$1:$2vh;').includes('dvh'));
});

test('el detector funciona (no es un test que siempre pasa)', () => {
  const found = scan('class A { static { x(); } #p = 1; }\nconst a = b?.c ?? d; a.at(0); structuredClone(a); x ||= 1;', { apis: true });
  assert.equal(found.get('static {}'), 94);
  assert.equal(found.get('?.'), 80);
  assert.equal(found.get('.at()'), 92);
  assert.equal(found.get('structuredClone()'), 98);
  assert.equal(found.get('||='), 85);
});

test('CSS: sin funciones más nuevas que el piso', () => {
  // dvh/svh/lvh se aceptan solo con una declaración `vh` justo antes (un WebView viejo ignora la segunda y usa la primera).
  const withFallback = /([\w-]+):\s*(\d+)vh;\s*\1:\s*\2[dsl]vh;/g;
  const css = (read('src/styles.css') + files('src', '.js').map(read).join('\n')).replace(withFallback, '$1:$2vh;');
  const NEW = { ':has(': 105, '@container': 105, 'dvh': 108, 'svh': 108, 'lvh': 108, 'color-mix(': 111, '@layer': 99, 'light-dark(': 123, 'text-wrap': 114, 'field-sizing': 123, 'subgrid': 117, '@starting-style': 117, 'anchor-name': 125 };
  const bad = Object.entries(NEW).filter(([k, v]) => v > FLOOR && css.includes(k)).map(([k, v]) => k + ' (Chrome ' + v + ')');
  assert.deepEqual(bad, []);
});

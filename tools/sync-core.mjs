#!/usr/bin/env node
// Sincroniza modules/document-editor/core (y el pdf.js vendorizado) desde una copia local
// de mcbro-refact, para que Digilibrary y MC Browser compartan el mismo núcleo sin
// divergir a mano.
//
// Uso:   node tools/sync-core.mjs <ruta-a-mcbro-refact> [--dry]
//
// Qué copia: modules/document-editor/core/*.js y modules/document-editor/vendor/pdf*.min.js
// Qué NO toca: nada de src/ ni los archivos propios de Digilibrary. Tampoco borra nada:
//   si mcbro-refact elimina un archivo del core, hay que quitarlo aquí a mano.
// Después de sincronizar: npm test (los tests de tests/core-*.test.js detectan roturas).
import { cpSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = resolve(fileURLToPath(import.meta.url), '..', '..');
const args = process.argv.slice(2);
const dry = args.includes('--dry');
const srcRoot = args.find((a) => !a.startsWith('--'));

if (!srcRoot) {
  console.error('Uso: node tools/sync-core.mjs <ruta-a-mcbro-refact> [--dry]');
  process.exit(1);
}

const srcMod = join(resolve(srcRoot), 'modules', 'document-editor');
const dstMod = join(here, 'modules', 'document-editor');
if (!existsSync(join(srcMod, 'core'))) {
  console.error('No encuentro ' + join(srcMod, 'core') + ' — ¿es la ruta correcta de mcbro-refact?');
  process.exit(1);
}

let commit = 'desconocido';
try {
  commit = execFileSync('git', ['-C', resolve(srcRoot), 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
} catch { /* la copia puede no ser un repo git */ }

const jobs = [];
for (const f of readdirSync(join(srcMod, 'core')).filter((n) => n.endsWith('.js'))) {
  jobs.push([join(srcMod, 'core', f), join(dstMod, 'core', f)]);
}
for (const f of ['pdf.min.js', 'pdf.worker.min.js']) {
  if (existsSync(join(srcMod, 'vendor', f))) jobs.push([join(srcMod, 'vendor', f), join(dstMod, 'vendor', f)]);
}

for (const [from, to] of jobs) {
  console.log((dry ? '[dry] ' : '') + 'copiar ' + to.slice(here.length + 1));
  if (!dry) cpSync(from, to);
}

if (!dry) {
  const date = new Date().toISOString().slice(0, 10);
  writeFileSync(
    join(dstMod, 'SOURCE.md'),
    `# Origen del núcleo de documentos\n\n` +
      `Esta carpeta es una copia de \`modules/document-editor\` de **mcbro-refact** (solo \`core/\` y el pdf.js vendorizado).\n\n` +
      `- Commit de origen: \`${commit}\`\n- Última sincronización: ${date}\n\n` +
      `No se edita aquí: si hace falta un arreglo en \`core/\`, se hace en mcbro-refact y se vuelve a sincronizar con\n` +
      `\`node tools/sync-core.mjs <ruta-a-mcbro-refact>\`. Los archivos de Electron del módulo (main, renderer, worker, spell)\n` +
      `no se copian: Digilibrary solo usa el núcleo puro.\n`
  );
  console.log('\nSincronizado desde mcbro-refact@' + commit + '. Ahora: npm test');
}

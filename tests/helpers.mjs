// Carga el núcleo de documentos igual que el navegador: como scripts clásicos, en el orden exacto
// que declara src/readers/doc-core.js (se lee de ahí para que el test no pueda desincronizarse).
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Orden de carga de TODOS los scripts de core/ declarados en doc-core.js (base, legacy y pdf-text).
export function coreLoadOrder() {
  const src = fs.readFileSync(path.join(ROOT, 'src/readers/doc-core.js'), 'utf8');
  const urls = Object.fromEntries([...src.matchAll(/import (\w+) from '[^']*core\/([\w-]+)\.js\?url'/g)].map((m) => [m[1], m[2]]));
  const groups = src.slice(src.indexOf('const GROUPS'), src.indexOf('function inject'));
  return [...groups.matchAll(/(\w+Url)\b/g)].map((m) => urls[m[1]]).filter(Boolean);
}

export function loadCoreLikeBrowser() {
  globalThis.window = globalThis;
  globalThis.self = globalThis;
  for (const name of coreLoadOrder()) {
    const file = path.join(ROOT, 'modules/document-editor/core', name + '.js');
    vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
  }
  return globalThis.MCDoc;
}

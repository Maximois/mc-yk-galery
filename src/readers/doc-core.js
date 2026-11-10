// Carga del núcleo de documentos (modules/document-editor/core, copiado de mcbro-refact).
//
// Por qué <script> clásicos y no `import`: esos archivos son UMD y varios usan `this` como
// raíz global ((function (root, factory) {...})(this, ...)). Como módulo ES, `this` es undefined
// y fallan al arrancar. Como script clásico funcionan igual que en MC Browser.
// Por qué `?url`: Vite copia cada archivo tal cual a dist/ y nos da su URL, sin transformarlo.
//
// El ORDEN importa: cada archivo busca a sus dependencias en window.MCDoc al ejecutarse.
// tests/core-load.test.js lee este archivo y carga el núcleo en el mismo orden.
import xmlUrl from '../../modules/document-editor/core/xml.js?url';
import zipUrl from '../../modules/document-editor/core/zip.js?url';
import modelUrl from '../../modules/document-editor/core/model.js?url';
import runsUrl from '../../modules/document-editor/core/runs.js?url';
import textIoUrl from '../../modules/document-editor/core/text-io.js?url';
import htmlUrl from '../../modules/document-editor/core/html.js?url';
import docxReadUrl from '../../modules/document-editor/core/docx-read.js?url';
import odtReadUrl from '../../modules/document-editor/core/odt-read.js?url';

const SCRIPTS = [xmlUrl, zipUrl, modelUrl, runsUrl, textIoUrl, htmlUrl, docxReadUrl, odtReadUrl];
const REQUIRED = ['xml', 'zip', 'model', 'textIo', 'html', 'docxRead', 'odtRead'];

function inject(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.async = false;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('No se pudo cargar el núcleo de documentos: ' + url));
    document.head.appendChild(s);
  });
}

let pending = null;

/** Carga el núcleo una sola vez (la primera vez que se necesita) y devuelve window.MCDoc. */
export function loadCore() {
  if (!pending) {
    pending = (async () => {
      for (const url of SCRIPTS) await inject(url);
      const core = window.MCDoc || {};
      const missing = REQUIRED.filter((k) => !core[k]);
      if (missing.length) throw new Error('Núcleo de documentos incompleto, falta: ' + missing.join(', '));
      return core;
    })().catch((e) => { pending = null; throw e; }); // permite reintentar si falló
  }
  return pending;
}

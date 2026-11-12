// Carga del núcleo de documentos (modules/document-editor/core, copiado de mcbro-refact).
//
// Por qué <script> clásicos y no `import`: esos archivos son UMD y varios usan `this` como
// raíz global ((function (root, factory) {...})(this, ...)). Como módulo ES, `this` es undefined
// y fallan al arrancar. Como script clásico funcionan igual que en MC Browser.
// Por qué `?url`: Vite copia cada archivo tal cual a dist/ y nos da su URL, sin transformarlo.
//
// El ORDEN importa dentro de cada grupo: cada archivo busca a sus dependencias en window.MCDoc
// al ejecutarse. Los grupos se cargan solo cuando un lector los pide (pdf.js pesa ~1,5 MB y no
// hace falta para abrir un TXT). tests/helpers.mjs lee este archivo y carga los mismos grupos
// en el mismo orden, así que los tests no pueden desincronizarse de la app.
import xmlUrl from '../../modules/document-editor/core/xml.js?url';
import zipUrl from '../../modules/document-editor/core/zip.js?url';
import modelUrl from '../../modules/document-editor/core/model.js?url';
import runsUrl from '../../modules/document-editor/core/runs.js?url';
import textIoUrl from '../../modules/document-editor/core/text-io.js?url';
import htmlUrl from '../../modules/document-editor/core/html.js?url';
import docxReadUrl from '../../modules/document-editor/core/docx-read.js?url';
import odtReadUrl from '../../modules/document-editor/core/odt-read.js?url';
import rtfReadUrl from '../../modules/document-editor/core/rtf-read.js?url';
import docBinaryUrl from '../../modules/document-editor/core/doc-binary.js?url';
import docReadUrl from '../../modules/document-editor/core/doc-read.js?url';
import pdfJsUrl from '../../modules/document-editor/vendor/pdf.min.js?url';
import pdfWorkerUrl from '../../modules/document-editor/vendor/pdf.worker.min.js?url';

const GROUPS = {
  base: { scripts: [xmlUrl, zipUrl, modelUrl, runsUrl, textIoUrl, htmlUrl, docxReadUrl, odtReadUrl], provides: ['xml', 'zip', 'model', 'textIo', 'html', 'docxRead', 'odtRead'] },
  legacy: { scripts: [rtfReadUrl, docBinaryUrl, docReadUrl], provides: ['rtfRead', 'docBinary', 'docRead'] },
  // Solo pdf.js: el PDF se muestra como páginas (src/reader/pdf-viewer.js), no se convierte a texto.
  pdf: { scripts: [pdfJsUrl], provides: [], globals: ['pdfjsLib'] }
};

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

const pending = {};

function loadGroup(name) {
  if (!pending[name]) {
    const g = GROUPS[name];
    pending[name] = (async () => {
      for (const url of g.scripts) await inject(url);
      const core = window.MCDoc || {};
      const missing = g.provides.filter((k) => !core[k]).concat((g.globals || []).filter((k) => !window[k]));
      if (missing.length) throw new Error('Núcleo de documentos incompleto (' + name + '), falta: ' + missing.join(', '));
    })().catch((e) => { pending[name] = null; throw e; }); // permite reintentar si falló
  }
  return pending[name];
}

/**
 * Carga el núcleo base y los grupos pedidos ('legacy' = RTF/DOC/HTML, 'pdf' = pdf.js).
 * Devuelve window.MCDoc; con 'pdf' también expone `core.pdfjs` (pdf.js ya configurado).
 */
export async function loadCore(...groups) {
  await loadGroup('base');
  for (const g of groups) await loadGroup(g);
  const core = window.MCDoc;
  if (groups.includes('pdf')) {
    // El worker de pdf.js se sirve desde el mismo origen que la app (copiado por Vite a dist/).
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
    core.pdfjs = window.pdfjsLib;
  }
  return core;
}

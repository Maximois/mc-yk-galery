'use strict';
/**
 * modules/document-editor/main.js — proceso principal del editor de documentos.
 *
 * Reparto de responsabilidades (importante para no romper nada por accident):
 *
 *   MAIN  es dueño del archivo y del documento abierto:
 *     - rutas (solo archivos concedidos por el usuario)
 *     - lectura y escritura en disco
 *     - dialogos de abrir/guardar
 *     - exportacion a PDF (printToPDF) y DOCX (OOXML)
 *     - copias de seguridad antes de sobrescribir
 *     - lista de recientes
 *   RENDERER es una vista: pinta bloques, captura paginas y manda parches.
 *   IA  usa exactamente los mismos handlers que el renderer. No hay una vía
 *   paralela para la IA: si un parche se puede aplicar desde el chat, se puede
 *   aplicar desde el editor y viceversa, con el mismo hash de control.
 *
 * El nucleo (`core/`) es puro y se puede usar desde cualquier proceso.
 */

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { ipcMain, dialog, app, BrowserWindow, screen } = require('electron');

const model = require('./core/model');
const patch = require('./core/patch');
const zip = require('./core/zip');
const html = require('./core/html');
const docDiff = require('./core/diff');
const thesaurus = require('./thesaurus');
const epub = require('./core/epub');
const odtWrite = require('./core/odt-write');
const textIo = require('./core/text-io');
const docxWrite = require('./core/docx-write');
const docxRead = require('./core/docx-read');
const docRead = require('./core/doc-read');
const odtRead = require('./core/odt-read');
const formats = require('./core/formats');
const pdfText = require('./core/pdf-text');
const spell = require('./spell');

const LOG = '[DOC-ED]';
const log = (...a) => console.log(LOG, ...a);
const warn = (...a) => console.warn(LOG, ...a);
const err = (...a) => console.error(LOG, ...a);

// ── Limites ────────────────────────────────────────────────────────────────
// Son deliberados: un PDF de 900 MB o 5 000 paginas congelaria la app y no
// tiene sentido cargarlo entero en memoria. Cuando se corta, se avisa.
const LIMITS = {
  maxFileBytes: 100 * 1024 * 1024,
  maxPages: 2000,
  maxBlocks: 5000,
  extractTimeoutMs: 120000,
  exportTimeoutMs: 30000,
  printDelayMs: 900,
  maxPreviewBytes: 100 * 1024 * 1024,
  recentMax: 20,
  backupMax: 10
};

const FORMATS = {
  pdf:  { ext: '.pdf',  label: 'PDF',  canSaveInPlace: false },
  docx: { ext: '.docx', label: 'DOCX', canSaveInPlace: true  },
  txt:  { ext: '.txt',  label: 'TXT',  canSaveInPlace: true  },
  md:   { ext: '.md',   label: 'Markdown', canSaveInPlace: true },
  odt:  { ext: '.odt',  label: 'OpenDocument (ODT)', canSaveInPlace: false },
  epub: { ext: '.epub', label: 'EPUB (libro electronico)', canSaveInPlace: false }
};
// La lista de formatos abribles vive en core/formats.js (registro explicito
// por extension). Aqui se reexporta para no duplicar criterios.
const OPENABLE = formats.OPENABLE;
const MAX_UNDO_STEPS = 100;

// ── Estado del modulo ─────────────────────────────────────────────────────
let ctxRef = null;
let granted = new Set();   // rutas que el usuario concedio (dialogo o apertura del SO)
let state = null;          // { doc, sourcePath, format, dirty, bytes, meta, warnings }
let recents = [];
let lastOpenError = '';

// ── Rutas del sandbox ─────────────────────────────────────────────────────
function baseDir() {
  return path.join(app.getPath('userData'), 'doc-editor');
}
function dir(name) {
  const p = path.join(baseDir(), name);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}
const workDir = () => dir('work');
const backupDir = () => dir('backups');
const tmpDir = () => dir('tmp');
const recentsFile = () => path.join(baseDir(), 'recent.json');

function loadRecents() {
  try {
    if (fs.existsSync(recentsFile())) {
      const raw = JSON.parse(fs.readFileSync(recentsFile(), 'utf8'));
      recents = Array.isArray(raw) ? raw.filter(r => r && typeof r.path === 'string') : [];
    }
  } catch { recents = []; }
}
function saveRecents() {
  try {
    fs.mkdirSync(baseDir(), { recursive: true });
    fs.writeFileSync(recentsFile(), JSON.stringify(recents.slice(0, LIMITS.recentMax), null, 2), 'utf8');
  } catch (e) { warn('no pude guardar los recientes:', e.message); }
}
function pushRecent(entry) {
  const item = {
    path: entry.path,
    name: entry.name,
    format: entry.format,
    title: entry.title,
    size: entry.size || 0,
    at: Date.now()
  };
  recents = [item, ...recents.filter(r => r.path !== item.path)].slice(0, LIMITS.recentMax);
  saveRecents();
}

// ── Validacion de rutas ───────────────────────────────────────────────────
// Regla unica: fuera de un dialogo, solo se tocan archivos que el usuario ya
// concedio (los eligio con "Abrir", el SO los abrio con la app, o son del
// sandbox). Cualquier otra ruta se rechaza con un mensaje claro.
function isGranted(p) {
  if (!p) return false;
  const abs = path.resolve(p);
  if (granted.has(abs)) return true;
  const b = baseDir();
  return abs.startsWith(b + path.sep);
}
function grant(p) {
  if (!p) return '';
  const abs = path.resolve(p);
  granted.add(abs);
  return abs;
}
function denyPath(p) {
  return { error: 'Ruta no permitida: el archivo tiene que abrirse primero con "Abrir" o desde Recientes' };
}

// ── Deteccion de formato ──────────────────────────────────────────────────
// El formato se decide por la extension, con un registro explicito
// (core/formats.js). Solo se mira el contenido para firmas inequivocas
// (PDF/OLE2/ZIP) o para distinguir DOCX de ODT cuando el ZIP no trae una
// extension concluyente. No hay heuristica de "parece texto".
function formatFromExt(file) {
  return formats.fromPath(file);
}
function sniff(bytes) {
  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'pdf';
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) return 'zip';
  if (bytes.length >= 8 && bytes[0] === 0xD0 && bytes[1] === 0xCF && bytes[2] === 0x11 && bytes[3] === 0xE0
    && bytes[4] === 0xA1 && bytes[5] === 0xB1 && bytes[6] === 0x1A && bytes[7] === 0xE1) return 'ole2';
  return '';
}
// Distingue un ZIP de Office (DOCX) de uno de OpenDocument (ODT).
async function zipKind(bytes) {
  try {
    const { names } = await zip.readZip(bytes);
    if (names.indexOf('word/document.xml') !== -1) return 'docx';
    if (names.indexOf('content.xml') !== -1) return 'odt';
  } catch (e) { warn('no pude inspeccionar el ZIP:', e.message); }
  return 'docx';
}
// Formato final de un archivo: firma primero, luego extension declarada.
async function pickFormat(file, bytes) {
  const magic = sniff(bytes);
  if (magic === 'pdf') return 'pdf';
  if (magic === 'ole2') return 'doc';
  const byExt = formats.fromPath(file);
  if (magic === 'zip') {
    if (byExt === 'docx' || byExt === 'odt') return byExt;
    return zipKind(bytes);
  }
  return byExt;
}

// ── Copias de seguridad ────────────────────────────────────────────────────
// Nada se sobrescribe sin dejar antes una copia: un .docx generado por error
// no tiene historial de versiones.
function backup(file) {
  try {
    if (!fs.existsSync(file)) return '';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(backupDir(), `${path.basename(file)}.${stamp}.bak`);
    fs.copyFileSync(file, dest);
    pruneBackups(path.basename(file));
    return dest;
  } catch (e) {
    warn('no pude hacer la copia de', file, '->', e.message);
    return '';
  }
}
function pruneBackups(basename) {
  try {
    const prefix = basename + '.';
    const files = fs.readdirSync(backupDir())
      .filter(n => n.startsWith(prefix) && n.endsWith('.bak'))
      .map(n => ({ n, t: fs.statSync(path.join(backupDir(), n)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const old of files.slice(LIMITS.backupMax)) {
      try { fs.unlinkSync(path.join(backupDir(), old.n)); } catch {}
    }
  } catch {}
}

// Versiones anteriores del archivo abierto: las copias que dejo cada guardado.
function parseBackupStamp(name) {
  const m = /\.(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d+)Z\.bak$/.exec(name);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]) : 0;
}
function listVersions() {
  if (!state) return { error: 'No hay ningun documento abierto' };
  if (!state.sourcePath) return { ok: true, versions: [] };
  const base = path.basename(state.sourcePath);
  try {
    const versions = fs.readdirSync(backupDir())
      .filter(n => n.startsWith(base + '.') && n.endsWith('.bak'))
      .map(n => {
        const full = path.join(backupDir(), n);
        let size = 0, mt = 0;
        try { const st = fs.statSync(full); size = st.size; mt = st.mtimeMs; } catch {}
        return { name: n, size, savedAt: parseBackupStamp(n) || mt };
      })
      .sort((a, b) => b.savedAt - a.savedAt);
    return { ok: true, versions };
  } catch (e) { return { ok: true, versions: [] }; }
}
async function restoreVersion(name) {
  const err = requireOpen();
  if (err) return err;
  if (!state.sourcePath) return { error: 'Este documento aun no tiene archivo: no hay versiones.' };
  const base = path.basename(state.sourcePath);
  const clean = path.basename(String(name || ''));
  const full = path.join(backupDir(), clean);
  if (!clean.startsWith(base + '.') || !clean.endsWith('.bak') || !full.startsWith(backupDir() + path.sep) || !fs.existsSync(full)) {
    return { error: 'Version no encontrada' };
  }
  let loaded;
  try {
    const bytes = new Uint8Array(fs.readFileSync(full));
    const format = await pickFormat(state.sourcePath, bytes);
    if (!format || !OPENABLE.includes(format)) return { error: 'No se pudo leer esa version' };
    loaded = await readToDoc(state.sourcePath, bytes, format);
  } catch (e) { return { error: 'No pude leer esa version: ' + e.message }; }
  // Entra como una edicion mas: Deshacer devuelve el contenido de antes.
  state.undoStack = state.undoStack || [];
  state.undoStack.push(state.doc);
  if (state.undoStack.length > MAX_UNDO_STEPS) state.undoStack.shift();
  state.redoStack = [];
  state.doc = loaded.doc;
  touchState(true);
  log('version restaurada: ' + clean);
  return Object.assign(lightSnapshot(), { ok: true });
}

// Compara una version guardada con el documento actual (solo lectura).
async function diffVersion(name) {
  const err = requireOpen();
  if (err) return err;
  if (!state.sourcePath) return { error: 'Este documento aun no tiene archivo: no hay versiones.' };
  const base = path.basename(state.sourcePath);
  const clean = path.basename(String(name || ''));
  const full = path.join(backupDir(), clean);
  if (!clean.startsWith(base + '.') || !clean.endsWith('.bak') || !full.startsWith(backupDir() + path.sep) || !fs.existsSync(full)) {
    return { error: 'Version no encontrada' };
  }
  try {
    const bytes = new Uint8Array(fs.readFileSync(full));
    const format = await pickFormat(state.sourcePath, bytes);
    if (!format || !OPENABLE.includes(format)) return { error: 'No se pudo leer esa version' };
    const loaded = await readToDoc(state.sourcePath, bytes, format);
    const rows = docDiff.diffBlocks(loaded.doc.blocks, state.doc.blocks);
    return { ok: true, rows, summary: docDiff.summary(rows) };
  } catch (e) { return { error: 'No pude comparar: ' + e.message }; }
}

// ── Lectura del archivo -> modelo ─────────────────────────────────────────
function assertSize(bytes, file) {
  if (bytes.length > LIMITS.maxFileBytes) {
    throw new Error(`El archivo es demasiado grande (${Math.round(bytes.length / 1048576)} MB). `
      + `El limite del editor es ${Math.round(LIMITS.maxFileBytes / 1048576)} MB.`);
  }
}

// El worker corre aparte para que un PDF de 800 paginas no congele la UI.
let worker = null;
let workerBroken = false;
function getWorker() {
  if (workerBroken) return null;
  if (worker) return worker;
  try {
    worker = new Worker(path.join(__dirname, 'worker.js'));
    worker.on('error', (e) => {
      err('el worker de extraccion fallo, sigo en linea:', e.message);
      workerBroken = true;
      worker = null;
    });
    worker.on('exit', () => { worker = null; });
    return worker;
  } catch (e) {
    err('no pude arrancar el worker de extraccion:', e.message);
    workerBroken = true;
    return null;
  }
}

function extractInWorker(format, bytes, sourcePath) {
  const w = getWorker();
  if (!w) return null;
  const payload = {
    type: 'extract',
    format,
    sourcePath,
    data: Array.from(bytes),           // el worker necesita un array plano
    limits: { maxPages: LIMITS.maxPages }
  };
  // El worker se comunica por mensajes; aca se hace la promesa a mano porque
  // este main.js no depende de ningun helper de RPC.
  const at = worker._mcDocSeq = (worker._mcDocSeq || 0) + 1;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('La extraccion tardo demasiado y se cancelo.'));
    }, LIMITS.extractTimeoutMs);

    function onMessage(msg) {
      if (!msg || msg.id !== at) return;
      if (msg.type === 'error') { cleanup(); reject(new Error(msg.error || 'Error de extraccion')); }
      else { cleanup(); resolve(msg.result); }
    }
    function onErr(e) { cleanup(); reject(e); }
    function cleanup() {
      clearTimeout(timer);
      if (worker) {
        worker.off('message', onMessage);
        worker.off('error', onErr);
      }
    }
    if (worker) {
      worker.on('message', onMessage);
      worker.on('error', onErr);
      try { worker.postMessage({ ...payload, id: at }); }
      catch (e) { cleanup(); reject(e); }
    } else {
      cleanup();
      reject(new Error('worker no disponible'));
    }
  });
}

// Fallback en linea: mismo resultado, sin isolation. Se usa solo si el worker
// no arranca (no deberia pasar).
async function extractInline(format, bytes, sourcePath) {
  if (format === 'docx') {
    const res = await docxRead.docxBytesToDoc(bytes, { sourcePath });
    return { blocks: res.doc.blocks, meta: res.doc.meta, title: res.doc.title, warnings: res.warnings || [], pages: 0, pageCount: 0 };
  }
  if (format === 'doc' || format === 'rtf' || format === 'html' || format === 'text') {
    const kind = format === 'doc' ? 'doc' : format;
    const res = docRead.docBytesToDoc(bytes, { sourcePath, kind, format });
    return { blocks: res.doc.blocks, meta: res.doc.meta, title: res.doc.title, warnings: res.warnings || [], pages: 0, pageCount: 0 };
  }
  if (format === 'odt') {
    const res = await odtRead.odtBytesToDoc(bytes, { sourcePath });
    return { blocks: res.doc.blocks, meta: res.doc.meta, title: res.doc.title, warnings: res.warnings || [], pages: 0, pageCount: 0 };
  }
  if (format === 'pdf') {
    globalThis.pdfjsWorker = require('./vendor/pdf.worker.min.js');
    const pdfjs = require('./vendor/pdf.min.js');
    const res = await pdfText.pdfBytesToBlocks(bytes, { pdfjs, maxPages: LIMITS.maxPages });
    return { blocks: res.blocks, meta: res.meta, title: res.meta.title, warnings: res.warnings, pages: res.pages, pageCount: res.pageCount, empty: res.empty };
  }
  const text = zip.toStr(bytes);
  const doc = textIo.textToDoc(text, { sourcePath });
  return { blocks: doc.blocks, meta: doc.meta, title: doc.title, warnings: [], pages: 0, pageCount: 0 };
}

async function readToDoc(file, bytes, format) {
  let out;
  const workerResult = await extractInWorker(format, bytes, file).catch((e) => {
    warn('extraccion en worker fallo, uso la de linea:', e.message);
    return null;
  });
  out = workerResult || await extractInline(format, bytes, file);

  const doc = model.createDoc({
    title: out.title || path.basename(file, path.extname(file)),
    meta: out.meta || {},
    blocks: out.blocks || []
  });
  if (doc.blocks.length > LIMITS.maxBlocks) {
    warn('el documento tiene', doc.blocks.length, 'bloques: se corta en', LIMITS.maxBlocks);
    doc.blocks = doc.blocks.slice(0, LIMITS.maxBlocks);
  }
  doc.hash = model.hashDoc(doc);
  return { doc, pages: out.pages || 0, pageCount: out.pageCount || 0, warnings: out.warnings || [] };
}

// ── Escritura ─────────────────────────────────────────────────────────────
async function docToBytes(doc, format) {
  if (format === 'docx') {
    const { parts } = docxWrite.docToDocxParts(doc, { warnings: [] });
    return zip.writeZip(parts);
  }
  if (format === 'odt') {
    return zip.writeZip(odtWrite.docToOdtParts(doc).parts);
  }
  if (format === 'epub') {
    return zip.writeZip(epub.docToEpubParts(doc).parts);
  }
  if (format === 'txt') {
    return Buffer.from(model.plainText(doc, { maxChars: 0 }), 'utf8');
  }
  if (format === 'md') {
    return Buffer.from(model.toMarkdown(doc), 'utf8');
  }
  throw new Error('No se puede escribir en ' + format.toUpperCase() + ' de forma directa');
}

async function printToPdfBytes(doc) {
  const pageHtml = html.docToHtml(doc, { print: true });
  const pageUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(pageHtml);

  // Electron 42 fijo el deviceScaleFactor del renderizado offscreen en 1.0. Antes
  // salia con la escala de la pantalla principal; se fija a mano para que el PDF
  // se pagine igual que antes en pantallas HiDPI.
  let printScale = 1;
  try { printScale = screen.getPrimaryDisplay().scaleFactor || 1; } catch {}

  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: { offscreen: { deviceScaleFactor: printScale }, contextIsolation: true, sandbox: true, nodeIntegration: false, javascript: false }
  });
  try {
    await win.loadURL(pageUrl);
    // Las imagenes data: y las fuentes tardan un frame en pintar. Sin esta
    // espera el PDF salia con los huecos de las imagenes vacios.
    await new Promise((r) => setTimeout(r, LIMITS.printDelayMs));
    const buf = await Promise.race([
      // Tamano, orientacion y margenes salen del @page del documento (core/html.js);
      // antes se forzaba A4 con margenes fijos e ignoraba la configuracion.
      win.webContents.printToPDF(Object.assign({
        printBackground: true,
        preferCSSPageSize: true,
        margins: { top: 0, bottom: 0, left: 0, right: 0 }
      }, { displayHeaderFooter: false })),
      new Promise((_r, rej) => setTimeout(() => rej(new Error('La exportacion a PDF se paso de tiempo')), LIMITS.exportTimeoutMs))
    ]);
    return Buffer.from(buf);
  } finally {
    try { win.destroy(); } catch {}
  }
}

// Imprime con el dialogo del sistema (impresora, copias, rango de paginas).
// El documento se arma con el mismo HTML de la exportacion a PDF.
async function printDocument(doc) {
  const pageHtml = html.docToHtml(doc, { print: true });
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, javascript: false }
  });
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(pageHtml));
    await new Promise((r) => setTimeout(r, LIMITS.printDelayMs));
    return await new Promise((resolve) => {
      win.webContents.print({ silent: false, printBackground: true, margins: { marginType: 'none' } }, (ok, reason) => {
        if (ok) resolve({ ok: true });
        else if (/cancel/i.test(String(reason || ''))) resolve({ ok: false, canceled: true });
        else resolve({ ok: false, error: 'No se pudo imprimir' + (reason ? ': ' + reason : '') });
      });
    });
  } finally {
    try { win.destroy(); } catch {}
  }
}

// ── Estado publico ────────────────────────────────────────────────────────
function stateSnapshot(opts) {
  const o = opts || {};
  if (!state) return { open: false };
  return {
    open: true,
    doc: state.doc,
    sourcePath: state.sourcePath,
    sourceName: state.sourcePath ? path.basename(state.sourcePath) : '',
    format: state.format,
    dirty: state.dirty,
    pages: state.pages,
    pageCount: state.pageCount,
    warnings: state.warnings,
    savedFormat: state.savedFormat,
    history: {
      canUndo: !!(state.undoStack && state.undoStack.length),
      canRedo: !!(state.redoStack && state.redoStack.length)
    },
    capabilities: {
      canSaveInPlace: !!(FORMATS[state.savedFormat] && FORMATS[state.savedFormat].canSaveInPlace),
      isPdfSource: state.format === 'pdf',
      hasBytes: !!state.bytes
    },
    ...(o.withBytes && state.bytes ? { bytes: state.bytes } : {})
  };
}

function requireOpen() {
  if (!state) return { error: 'No hay ningun documento abierto' };
  return null;
}

// Las imagenes llegan como base64 (megabytes). El renderer ya las tiene
// decodificadas en sus nodos: mandarle los bytes de nuevo en CADA parche hace
// que el deserializado del IPC congele el hilo del renderer (medido: >3s en
// un doc con 8 imagenes). Si la imagen no cambio se manda sin `src`; si es
// nueva o distinta viaja completa la primera vez (y el renderer la guarda).
const imgSrcCache = new Map();
function lightDoc(doc) {
  if (!doc || !Array.isArray(doc.blocks)) return doc;
  let changed = false;
  const blocks = doc.blocks.map((b) => {
    if (b.type !== 'image' || typeof b.src !== 'string' || !b.src) return b;
    if (imgSrcCache.get(b.id) === b.src) {
      changed = true;
      const copy = Object.assign({}, b);
      delete copy.src;
      return copy;
    }
    imgSrcCache.set(b.id, b.src);
    return b;
  });
  return changed ? Object.assign({}, doc, { blocks }) : doc;
}
function lightSnapshot(opts) {
  const snap = stateSnapshot(opts);
  if (!snap.open) return snap;
  const doc = lightDoc(snap.doc);
  return doc === snap.doc ? snap : Object.assign({}, snap, { doc });
}

function touchState(skipHash) {
  if (!state) return;
  if (!skipHash) state.doc.hash = model.hashDoc(state.doc);
  state.dirty = true;
  broadcast();
}

let lastBroadcast = 0;
let pendingBroadcast = 0;
function broadcast(force) {
  const win = ctxRef && ctxRef.getMainWin ? ctxRef.getMainWin() : null;
  if (!win || win.isDestroyed()) return;
  const now = Date.now();
  if (!force && now - lastBroadcast < 120) {
    // No se descarta el aviso: se agenda para cuando se libere la ventana, para
    // que el ultimo estado siempre llegue. Antes se perdia, y con parches
    // seguidos eso dejaba la UI mostrando un estado viejo.
    if (!pendingBroadcast) {
      pendingBroadcast = setTimeout(() => { pendingBroadcast = 0; broadcast(true); }, 130);
      if (pendingBroadcast.unref) pendingBroadcast.unref();
    }
    return;
  }
  lastBroadcast = now;
  try { win.webContents.send('doc:changed', lightSnapshot()); } catch {}
}

function emitOpenRequest(file, snap) {
  const win = ctxRef && ctxRef.getMainWin ? ctxRef.getMainWin() : null;
  if (!win || win.isDestroyed()) return false;
  try {
    // Va el snapshot para que el renderer solo tenga que mostrar la pestaña y
    // pintar: si no, abriria el archivo otra vez por su cuenta.
    win.webContents.send('doc:open-request', { path: grant(file), snap: snap || null });
    return true;
  } catch { return false; }
}

/** Enfoca la ventana principal (si existe) sin romper si todavia no esta lista. */
function focusMainWin() {
  const win = ctxRef && ctxRef.getMainWin ? ctxRef.getMainWin() : null;
  if (!win || win.isDestroyed()) return false;
  try {
    if (win.isMinimized()) win.restore();
    win.focus();
    return true;
  } catch { return false; }
}

/**
 * Punto de entrada unico para "el SO me paso un archivo".
 * Concede la ruta, abre el documento y le avisa al renderer que muestre la
 * pestaña de Documentos. Lo usan tanto `open-file` (macOS) como argv y
 * `second-instance` (Windows/Linux).
 */
async function handleExternalOpen(file) {
  const target = String(file || '').trim();
  if (!target) return { error: 'Ruta vacia' };
  grant(target);
  focusMainWin();
  const res = await openFile(target, { withBytes: true });
  if (res && res.error) {
    lastOpenError = res.error;
    warn('no pude abrir', target, '->', res.error);
    const win = ctxRef && ctxRef.getMainWin ? ctxRef.getMainWin() : null;
    if (win && !win.isDestroyed()) {
      try { win.webContents.send('doc:error', { error: res.error }); } catch {}
    }
    return res;
  }
  lastOpenError = '';
  emitOpenRequest(target, res);
  return res;
}

/**
 * Busca un documento en los argumentos de linea de comandos (Windows/Linux no
 * avisan con `open-file`: llegan como argv en el primer y en cada
 * `second-instance`). Se ignoran los switches y cualquier ruta que no exista.
 */
function extractDocumentPath(argv) {
  const list = Array.isArray(argv) ? argv : [];
  for (const raw of list) {
    const value = String(raw || '').replace(/^['"]|['"]$/g, '');
    if (!value || value.startsWith('-')) continue;
    if (!path.isAbsolute(value)) continue;
    const fmt = formatFromExt(value);
    if (!OPENABLE.includes(fmt)) continue;
    try { if (fs.statSync(value).isFile()) return value; } catch {}
  }
  return '';
}

// ── Abrir ─────────────────────────────────────────────────────────────────
async function openFile(file, opts) {
  const o = opts || {};
  let target = String(file || '').trim();
  if (!target) return { error: 'Ruta vacia' };
  if (!path.isAbsolute(target)) target = path.resolve(target);
  target = path.resolve(target);

  if (!o.force && !isGranted(target)) {
    const denied = denyPath(target);
    lastOpenError = denied.error;
    return denied;
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    const e = 'El archivo ya no existe: ' + target;
    lastOpenError = e;
    return { error: e };
  }

  let bytes;
  try {
    assertSize(fs.statSync(target).size, target);
    bytes = new Uint8Array(fs.readFileSync(target));
  } catch (e) {
    lastOpenError = e.message;
    return { error: e.message };
  }

  const format = await pickFormat(target, bytes);
  if (!format || !OPENABLE.includes(format)) {
    const e = `Formato no soportado: ${path.extname(target) || '(sin extension)'}. `
      + `Se puede abrir PDF, Word (DOCX/DOC), OpenDocument (ODT), RTF, HTML y archivos de texto (txt, md, log, csv, json, xml, codigo, etc.).`;
    lastOpenError = e;
    return { error: e };
  }

  let loaded;
  try {
    loaded = await readToDoc(target, bytes, format);
  } catch (e) {
    lastOpenError = 'No pude leer el documento: ' + e.message;
    return { error: lastOpenError };
  }

  if (!loaded.doc.blocks.length && o.allowEmpty !== true) {
    warn('el documento quedo vacio:', target);
  }

  state = {
    doc: loaded.doc,
    undoStack: [],
    redoStack: [],
    sourcePath: target,
    format,
    // Un PDF NUNCA se guarda en el sitio: no sabemos reproducir su diseño.
    // savedFormat queda en 'pdf' para que canSaveInPlace sea false y el botón
    // Guardar redirija a Guardar como; el formato de salida lo elige el usuario.
    savedFormat: format,
    dirty: false,
    bytes,
    pages: loaded.pages,
    pageCount: loaded.pageCount,
    warnings: loaded.warnings
  };
  lastOpenError = '';
  pushRecent({ path: target, name: path.basename(target), format, title: loaded.doc.title, size: bytes.length });
  saveWorkCopy();

  const snap = stateSnapshot(o);
  broadcast(true);
  log(`abierto ${path.basename(target)} (${format}, ${loaded.doc.blocks.length} bloques, ${loaded.pageCount || 0} paginas)`);
  return snap;
}

async function openWithDialog(parentWin) {
  const g = formats.GLOBS;
  const options = {
    title: 'Abrir documento',
    properties: ['openFile'],
    filters: [
      { name: 'Documentos y texto', extensions: [].concat(g.pdf, g.docx, g.odt, g.doc, g.rtf, g.html, g.md, g.txt, g.text) },
      { name: 'PDF (*.pdf)', extensions: g.pdf },
      { name: 'Word (*.docx, *.doc)', extensions: g.docx.concat(g.doc) },
      { name: 'OpenDocument (*.odt, *.ott)', extensions: g.odt },
      { name: 'Texto enriquecido (*.rtf)', extensions: g.rtf },
      { name: 'Pagina web (*.html, *.htm)', extensions: g.html },
      { name: 'Markdown (*.md)', extensions: g.md },
      { name: 'Texto (*.txt, *.log, *.csv)', extensions: g.txt.concat(g.md) },
      { name: 'Texto y codigo', extensions: g.text },
      { name: 'Todos', extensions: ['*'] }
    ]
  };
  // Sin ventana principal se llama a la sobrecarga de un solo argumento: pasar
  // `undefined` explícito como primer parametro rompe la deteccion de ventana
  // de algunos Electron y deja el dialogo sin padre.
  const res = parentWin && !parentWin.isDestroyed()
    ? await dialog.showOpenDialog(parentWin, options)
    : await dialog.showOpenDialog(options);
  if (res.canceled || !res.filePaths.length) return { canceled: true };
  grant(res.filePaths[0]);
  return openFile(res.filePaths[0], { withBytes: true });
}

// ── Guardar ───────────────────────────────────────────────────────────────
function saveWorkCopy() {
  // Copia de trabajo: si la app se cae, el trabajo reciente sigue en disco.
  if (!state) return '';
  try {
    const name = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const file = path.join(workDir(), `${name}.json`);
    fs.writeFileSync(file, JSON.stringify({
      savedAt: Date.now(),
      sourcePath: state.sourcePath,
      format: state.format,
      doc: state.doc
    }), 'utf8');
    return file;
  } catch (e) {
    warn('no pude guardar la copia de trabajo:', e.message);
    return '';
  }
}
function listWorkCopies() {
  try {
    return fs.readdirSync(workDir())
      .filter(n => n.endsWith('.json'))
      .map(n => {
        const full = path.join(workDir(), n);
        let meta = {};
        try {
          const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
          meta = { sourcePath: raw.sourcePath, format: raw.format, title: raw.doc && raw.doc.title, savedAt: raw.savedAt };
        } catch {}
        return { file: full, name: n, size: fs.statSync(full).size, ...meta };
      })
      .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  } catch { return []; }
}
function loadWorkCopy(file) {
  const full = path.join(workDir(), path.basename(String(file || '')));
  if (!full.startsWith(workDir() + path.sep) || !fs.existsSync(full)) {
    return { error: 'Copia de trabajo no encontrada' };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
    state = {
      doc: model.normalizeDoc(raw.doc),
      undoStack: [],
      redoStack: [],
      sourcePath: raw.sourcePath || '',
      format: raw.format || 'docx',
      // Igual que en openFile(): un PDF de origen se sigue tratando como no
      // guardable en el sitio, tambien cuando viene de una copia de trabajo.
      savedFormat: raw.format || 'docx',
      dirty: true,
      bytes: null,
      pages: 0,
      pageCount: 0,
      warnings: ['Documento recuperado de una copia de trabajo: no se ha guardado en el archivo original todavia.']
    };
    state.doc.hash = model.hashDoc(state.doc);
    broadcast(true);
    return stateSnapshot();
  } catch (e) {
    return { error: 'Copia de trabajo ilegible: ' + e.message };
  }
}

async function saveTo(file, format) {
  const fmt = format || formatFromExt(file);
  if (!FORMATS[fmt]) return { error: `No se puede guardar en ${String(format).toUpperCase()}` };

  const bytes = fmt === 'pdf' ? await printToPdfBytes(state.doc) : await docToBytes(state.doc, fmt);

  const existed = fs.existsSync(file);
  if (existed) backup(file);

  // Escritura atomica: se escribe a un temporal y se renombra. Si se corta la
  // luz, el archivo viejo sigue entero.
  const tmp = path.join(tmpDir(), `${Date.now()}-${path.basename(file)}`);
  fs.writeFileSync(tmp, bytes);
  try { fs.renameSync(tmp, file); }
  catch {
    fs.copyFileSync(tmp, file);
    try { fs.unlinkSync(tmp); } catch {}
  }

  // El archivo recien escrito pasa a ser del usuario: se concede para que
  // despues se pueda guardar, revelar y reabrir sin volver a pickearlo.
  grant(file);
  state.sourcePath = file;
  state.savedFormat = fmt;
  state.format = fmt;
  state.dirty = false;
  pushRecent({ path: file, name: path.basename(file), format: fmt, title: state.doc.title, size: bytes.length });
  broadcast(true);
  log(`guardado ${path.basename(file)} (${fmt}, ${bytes.length} bytes)`);
  return stateSnapshot();
}

async function saveAs(opts) {
  const o = opts || {};
  if (!state) return { error: 'No hay ningun documento abierto' };
  const suggested = o.format && FORMATS[o.format] ? o.format : (state.sourcePath ? path.parse(state.sourcePath).name : (state.doc.title || 'documento'));
  const parent = o.parentWin && !o.parentWin.isDestroyed() ? o.parentWin : null;
  const options = {
    title: 'Guardar documento como',
    defaultPath: path.join(app.getPath('documents'), suggested + (o.format && FORMATS[o.format] ? FORMATS[o.format].ext : '.docx')),
    filters: [
      { name: 'Word (DOCX)', extensions: ['docx'] },
      { name: 'PDF', extensions: ['pdf'] },
      { name: 'OpenDocument (ODT)', extensions: ['odt'] },
      { name: 'EPUB (libro electrónico)', extensions: ['epub'] },
      { name: 'Markdown', extensions: ['md'] },
      { name: 'Texto plano', extensions: ['txt'] }
    ]
  };
  const res = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
  if (res.canceled || !res.filePath) return { canceled: true };
  grant(res.filePath);
  return saveTo(res.filePath, formatFromExt(res.filePath) || o.format);
}

async function exportAs(opts) {
  const o = opts || {};
  if (!state) return { error: 'No hay ningun documento abierto' };
  const fmt = String(o.format || '').toLowerCase();
  if (!FORMATS[fmt]) return { error: `Formato desconocido: ${o.format}` };
  const target = String(o.path || '').trim();
  if (!target) return { error: 'Falta la ruta de destino' };

  const abs = path.isAbsolute(target) ? path.resolve(target) : path.resolve(app.getPath('documents'), target);
  if (!isGranted(abs) && !isInsideSandbox(abs)) return denyPath(abs);
  const bytes = fmt === 'pdf' ? await printToPdfBytes(state.doc) : await docToBytes(state.doc, fmt);
  if (fs.existsSync(abs)) backup(abs);
  fs.writeFileSync(abs, bytes);
  return { ok: true, path: abs, format: fmt, size: bytes.length };
}

function isInsideSandbox(p) {
  const b = baseDir();
  return path.resolve(p).startsWith(b + path.sep);
}

// ── Patches (una sola via para la UI y para la IA) ────────────────────────
function applyUserPatch(req, who) {
  const errOpen = requireOpen();
  if (errOpen) return errOpen;
  const { expectedHash, ops } = req || {};
  if (!expectedHash) {
    return { ok: false, reason: 'missing_hash', error: 'Falta expectedHash: sin el no se puede saber si el documento cambio' };
  }
  if (expectedHash !== state.doc.hash) {
    return {
      ok: false,
      reason: 'stale_document',
      stale: true,
      error: 'El documento cambio desde que lo leiste. Vuelve a leerlo y reintenta.',
      hash: state.doc.hash
    };
  }
  const res = patch.applyPatch(state.doc, { expectedHash, ops });
  if (!res.ok) {
    return {
      ok: false,
      reason: res.stale ? 'stale_document' : 'patch_failed',
      errors: res.errors,
      error: (res.errors && res.errors[0] && res.errors[0].message) || 'El parche no se aplico',
      hash: state.doc.hash
    };
  }
  state.undoStack = state.undoStack || [];
  state.redoStack = state.redoStack || [];
  state.undoStack.push(state.doc);
  if (state.undoStack.length > MAX_UNDO_STEPS) state.undoStack.shift();
  state.redoStack.length = 0;
state.doc = res.doc;
  touchState(true);
  log(`parche de ${who}: ${res.diff.length} cambio(s)`);
  // La respuesta lleva el snapshot COMPLETO, no solo el doc. applySnapshot()
  // en el renderer descarta cualquier respuesta sin "open", asi que devolviendo
  // un objeto parcial la UI solo se enteraba por el broadcast doc:changed; y ese
  // broadcast tiene un throttle de 120 ms que DESCARTA el aviso. Con dos parches
  // seguidos (Enter partiendo un bloque: uno para la mitad de arriba y otro para
  // insertar la de abajo) se perdia el segundo y el editor mostraba el bloque
  // partido como si le hubieran borrado la mitad.
  return Object.assign(lightSnapshot(), {
    ok: true,
    applied: res.diff.length,
    diff: res.diff,
    summary: res.summary
  });
}

function travelDocumentHistory(direction) {
  const errOpen = requireOpen();
  if (errOpen) return errOpen;
  const from = direction === 'undo' ? 'undoStack' : 'redoStack';
  const to = direction === 'undo' ? 'redoStack' : 'undoStack';
  state[from] = state[from] || [];
  state[to] = state[to] || [];
  if (!state[from].length) {
    return { ok: false, error: direction === 'undo' ? 'Nada que deshacer' : 'Nada que rehacer', history: stateSnapshot().history };
  }
  state[to].push(state.doc);
  if (state[to].length > MAX_UNDO_STEPS) state[to].shift();
  state.doc = state[from].pop();
  touchState();
  saveWorkCopy();
  return Object.assign({ ok: true }, stateSnapshot());
}

function readDocument(req) {
  const o = req || {};
  const errOpen = requireOpen();
  if (errOpen) return errOpen;
  const maxChars = o.maxChars == null ? 20000 : Math.min(Math.max(Number(o.maxChars) || 0, 200), 200000);
  const full = model.plainText(state.doc, { maxChars: 0 });
  const truncated = full.length > maxChars;
  return {
    ok: true,
    hash: state.doc.hash,
    title: state.doc.title,
    meta: state.doc.meta,
    format: state.format,
    sourcePath: state.sourcePath,
    sourceName: state.sourcePath ? path.basename(state.sourcePath) : '',
    text: truncated ? full.slice(0, maxChars) : full,
    truncated,
    totalChars: full.length,
    outline: model.outline(state.doc).slice(0, 200),
    stats: model.stats(state.doc),
    warnings: state.warnings
  };
}

function findInDocument(req) {
  const errOpen = requireOpen();
  if (errOpen) return errOpen;
  const q = String((req && req.query) || '');
  if (!q) return { error: 'Falta la busqueda' };
  const res = patch.locate(state.doc, q, {
    caseSensitive: !!(req && req.caseSensitive),
    regex: !!(req && req.regex),
    max: Math.min(Number((req && req.max) || 20), 100)
  });
  return { ok: true, hash: state.doc.hash, ...res };
}

// ── Setup ─────────────────────────────────────────────────────────────────
async function saveInPlace() {
  const errOpen = requireOpen();
  if (errOpen) return errOpen;
  if (!state.sourcePath) return { needsSaveAs: true, error: 'El documento nunca se guardo: elegi "Guardar como"' };
  const fmtInPlace = FORMATS[state.savedFormat];
  if (!fmtInPlace || !fmtInPlace.canSaveInPlace) {
    const label = state.savedFormat === 'pdf' ? 'Un PDF' : `Un archivo de solo lectura (${String(state.savedFormat).toUpperCase()})`;
    return { needsSaveAs: true, error: `${label} no se puede guardar en el sitio: usá "Guardar como" para crear el DOCX o PDF nuevo` };
  }
  return saveTo(state.sourcePath, state.savedFormat);
}

function configureSpellLanguages() {
  const win = ctxRef && ctxRef.getMainWin ? ctxRef.getMainWin() : null;
  const ses = (win && !win.isDestroyed() ? win.webContents.session : null) || require('electron').session.defaultSession;
  if (!ses || !ses.setSpellCheckerLanguages) return;
  if (ses.setSpellCheckerEnabled) ses.setSpellCheckerEnabled(true);
  const langs = spell.pickSpellLanguages(ses.availableSpellCheckerLanguages, ses.getSpellCheckerLanguages());
  if (langs.length) ses.setSpellCheckerLanguages(langs);
}

function setup(ctx) {
  if (!ctx) return;
  ctxRef = ctx;
  loadRecents();

  // El SO abre .pdf/.docx con la app: en macOS esto llega por `open-file`, y en
  // Windows/Linux como argumento de linea de comandos (ver handleExternalOpen,
  // que tambien usan argv y `second-instance` desde el main principal).
  app.on('open-file', (event, file) => {
    event.preventDefault();
    handleExternalOpen(file).catch((e) => warn('open-file fallo:', e.message));
  });

  // ── Corrector ortografico (ver spell.js) ──
  // Con un locale sin diccionario propio (es-PY, por ejemplo) Chromium se queda
  // sin idioma y no subraya nada: se fija espanol (+ ingles) de forma explicita.
  try { configureSpellLanguages(); } catch (e) { warn('corrector:', e.message); }
  ipcMain.removeAllListeners('doc:ctx-open');
  ipcMain.on('doc:ctx-open', () => spell.mark());
  ipcMain.removeHandler('doc:spell-add');
  ipcMain.handle('doc:spell-add', (event, word) => {
    const w = String(word || '').trim().slice(0, 80);
    if (!w || /\s/.test(w)) return { ok: false };
    try { event.sender.session.addWordToSpellCheckerDictionary(w); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  // ── Canales ──
  const handle = (channel, fn) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, payload) => {
      try {
        return await fn(payload || {}, event);
      } catch (e) {
        err(channel, '->', e && e.message);
        return { error: e && e.message ? e.message : String(e) };
      }
    });
  };

  handle('doc:state', (p) => (p.withBytes ? stateSnapshot(p) : stateSnapshot()));
  handle('doc:limits', () => ({ ok: true, limits: LIMITS, formats: FORMATS, openable: OPENABLE }));
  handle('doc:open', async (p) => openWithDialog(p.parentWin));
  handle('doc:open-path', (p) => openFile(p.path, { withBytes: !!p.withBytes, allowEmpty: !!p.allowEmpty }));
  handle('doc:close', () => {
    if (state && state.dirty) saveWorkCopy();
    state = null;
    broadcast(true);
    return { ok: true };
  });
  handle('doc:create', (p) => {
    const doc = model.createDoc({
      title: (p && p.title) || 'Documento nuevo',
      meta: { author: (p && p.author) || '' },
      blocks: (p && Array.isArray(p.blocks) && p.blocks.length)
        ? p.blocks
        : [{ type: 'heading', level: 1, text: (p && p.title) || 'Documento nuevo' }, { type: 'paragraph', text: '' }]
    });
    state = {
      doc,
      undoStack: [],
      redoStack: [],
      sourcePath: '',
      format: (p && p.format) || 'docx',
      savedFormat: (p && p.format) || 'docx',
      dirty: true,
      bytes: null,
      pages: 0,
      pageCount: 0,
      warnings: ['Documento nuevo, todavia sin guardar.']
    };
    state.doc.hash = model.hashDoc(state.doc);
    saveWorkCopy();
    broadcast(true);
    return stateSnapshot();
  });

  handle('doc:read', (p) => readDocument(p));
  handle('doc:find', (p) => findInDocument(p));
  handle('doc:patch', (p) => applyUserPatch(p, 'la IA'));
  handle('doc:edit', (p) => applyUserPatch(p, 'el usuario'));
  handle('doc:undo', () => travelDocumentHistory('undo'));
  handle('doc:redo', () => travelDocumentHistory('redo'));
  handle('doc:preview', (p) => {
    const errOpen = requireOpen();
    if (errOpen) return errOpen;
    return patch.previewPatch(state.doc, { expectedHash: state.doc.hash, ops: (p && p.ops) || [] });
  });

  handle('doc:save', () => saveInPlace());
  handle('doc:save-as', (p) => saveAs(p));
  handle('doc:export', (p) => exportAs(p));
  handle('doc:versions', () => listVersions());
  handle('doc:thesaurus', (p) => Object.assign({ ok: true }, thesaurus.lookup(p && p.word)));
  handle('doc:version-diff', (p) => diffVersion(p && p.name));
  handle('doc:version-restore', (p) => restoreVersion(p && p.name));
  handle('doc:print', async () => {
    const errOpen = requireOpen();
    if (errOpen) return errOpen;
    return printDocument(state.doc);
  });
  handle('doc:print-preview-html', () => {
    const errOpen = requireOpen();
    if (errOpen) return errOpen;
    return { ok: true, html: html.docToHtml(state.doc, { print: true }) };
  });

  handle('doc:work:list', () => ({ ok: true, copies: listWorkCopies() }));
  handle('doc:work:load', (p) => loadWorkCopy(p.file));
  handle('doc:work:save', () => {
    const file = saveWorkCopy();
    return file ? { ok: true, file } : { error: 'No pude guardar la copia de trabajo' };
  });
  handle('doc:work:delete', (p) => {
    try {
      const full = path.join(workDir(), path.basename(String(p.file || '')));
      if (!isInsideSandbox(full) || !fs.existsSync(full)) return { ok: false };
      fs.unlinkSync(full);
      return { ok: true };
    } catch (e) { return { error: e.message }; }
  });

  handle('doc:recent:list', () => ({ ok: true, recents }));
  handle('doc:recent:clear', () => { recents = []; saveRecents(); return { ok: true }; });
  handle('doc:recent:open', async (p) => {
    const target = String((p && p.path) || '');
    if (!recents.some(r => r.path === target)) return denyPath(target);
    grant(target);
    const res = await openFile(target, { withBytes: true });
    if (!res.error) emitOpenRequest(target, res);
    return res;
  });
  handle('doc:reveal', (p) => {
    const target = String((p && p.path) || '');
    if (!isGranted(target) || !fs.existsSync(target)) return { error: 'Ese archivo no esta abierto' };
    shellShow(target);
    return { ok: true };
  });

  // Bytes crudos para el render de paginas del PDF en el renderer.
  handle('doc:bytes', () => {
    const errOpen = requireOpen();
    if (errOpen) return errOpen;
    if (!state.bytes) return { ok: false, reason: 'no_bytes' };
    if (state.bytes.length > LIMITS.maxPreviewBytes) return { ok: false, reason: 'too_big', size: state.bytes.length };
    return { ok: true, bytes: state.bytes, format: state.format };
  });

  // Lectura acotada para la IA: texto + estructura, sin el HTML entero.
  handle('doc:context', (p) => {
    const errOpen = requireOpen();
    if (errOpen) return errOpen;
    const maxChars = p && p.maxChars ? Math.min(Number(p.maxChars) || 8000, 60000) : 8000;
    const full = model.plainText(state.doc, { maxChars: 0 });
    return {
      ok: true,
      hash: state.doc.hash,
      title: state.doc.title,
      sourceName: state.sourcePath ? path.basename(state.sourcePath) : '(sin guardar)',
      format: state.format,
      chars: full.length,
      text: full.slice(0, maxChars),
      truncated: full.length > maxChars,
      outline: model.outline(state.doc).slice(0, 60),
      stats: model.stats(state.doc),
      warnings: state.warnings
    };
  });

  log('listo. sandbox en', baseDir());
  return {
    openFile: (file) => openFile(file, { withBytes: true }),
    openExternal: handleExternalOpen,
    extractDocumentPath,
    getState: () => stateSnapshot(),
    isOpen: () => !!state
  };
}

function shellShow(target) {
  try {
    // Mostrar en el explorador de archivos sin abrirlo con el programa del SO.
    const { shell } = require('electron');
    shell.showItemInFolder(target);
  } catch (e) {
    warn('no pude revelar el archivo:', e.message);
  }
}

module.exports = {
  setup,
  LIMITS,
  FORMATS,
  // Apertura por asociacion de archivos / linea de comandos. El main raiz los
  // llama desde argv y desde `second-instance`.
  handleExternalOpen,
  extractDocumentPath,
  // Superficie de solo lectura que usa el contexto de la IA y los tests.
  // No expone escritura directa: el unico camino es applyUserPatch.
  getState: () => stateSnapshot(),
  isOpen: () => !!state,
  readDocument: (p) => readDocument(p),
  getContext: (p) => {
    const errOpen = requireOpen();
    if (errOpen) return errOpen;
    const maxChars = p && p.maxChars ? Math.min(Number(p.maxChars) || 8000, 60000) : 8000;
    const full = model.plainText(state.doc, { maxChars: 0 });
    return {
      ok: true,
      hash: state.doc.hash,
      title: state.doc.title,
      sourceName: state.sourcePath ? path.basename(state.sourcePath) : '(sin guardar)',
      format: state.format,
      chars: full.length,
      text: full.slice(0, maxChars),
      truncated: full.length > maxChars,
      outline: model.outline(state.doc).slice(0, 60),
      stats: model.stats(state.doc),
      warnings: state.warnings
    };
  },
  applyPatch: (p) => applyUserPatch(p, 'la IA'),
  // Solo para tools/ y tests.
  _internals: {
    openFile, saveTo, saveAs, saveInPlace, exportAs, docToBytes, printToPdfBytes,
    formatFromExt, sniff, pickFormat, zipKind, formats, isGranted, grant, applyUserPatch,
    listVersions, restoreVersion, stateSnapshot, saveWorkCopy, listWorkCopies, loadWorkCopy, travelDocumentHistory
  }
};
// Pantalla "Lector": abre el libro, muestra el visor y conecta selección -> resaltado/nota/copiar.
import { $, escapeHtml } from '../lib/dom.js';
import { newId } from '../lib/bytes.js';
import { readBookFile } from '../platform/files.js';
import { UnsupportedFormatError, loadDocument } from '../readers/index.js';
import { createReflowViewer } from '../reader/reflow-viewer.js';
import { createPdfViewer } from '../reader/pdf-viewer.js';
import { toast } from './toast.js';

const SAVE_EVERY_MS = 1500;
const ZOOM_STEP = 1.25;

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
  return new Promise((resolve, reject) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy') ? resolve() : reject(new Error('copy')); } catch (e) { reject(e); }
    ta.remove();
  });
}

export function createReaderView({ store }) {
  const el = $('view-reader');
  const host = $('reader-host');
  const toolbar = $('reader-toolbar');
  const pageInfo = $('page-info');
  const slider = $('page-slider');
  const menu = $('selection-menu');
  const noteModal = $('note-modal');
  const noteSelection = $('note-selection');
  const noteText = $('note-text');
  const zoomBox = $('zoom-controls');
  const zoomLabel = $('zoom-label');
  const searchToggle = $('reader-search-toggle');
  const searchForm = $('reader-search');
  const searchInput = $('reader-search-input');
  const searchCount = $('reader-search-count');

  let book = null;
  let viewer = null;
  let selection = null; // última selección capturada: { anchor, text }
  let saveTimer = 0;
  let pendingProgress = null;
  let openToken = 0; // descarta respuestas de una apertura anterior si el usuario ya salió
  let searchTimer = 0;
  let searchRequest = 0;

  slider.min = '0';
  slider.max = '100';
  slider.step = '1';

  function message(html) {
    host.innerHTML = '<div class="reader-message">' + html + '</div>';
  }

  function flushProgress() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    if (book && pendingProgress) {
      store.updateBook(book.id, pendingProgress);
      pendingProgress = null;
    }
  }

  function onProgress({ ratio, block, page, pages }) {
    const pct = Math.round(ratio * 100);
    // PDF: "Página X de N" (lastBlock guarda el índice de página); resto: porcentaje de lectura.
    pageInfo.textContent = page ? 'Página ' + page + ' de ' + pages : 'Progreso ' + pct + ' %';
    slider.value = String(pct);
    pendingProgress = { progress: pct, lastBlock: block };
    if (!saveTimer) saveTimer = setTimeout(flushProgress, SAVE_EVERY_MS);
  }

  function onSelectionChange(sel) {
    if (sel) selection = sel;
    menu.classList.toggle('hidden', !sel);
  }

  function hideMenu() {
    menu.classList.add('hidden');
    selection = null;
    if (viewer) viewer.clearSelection();
  }

  async function saveInteraction(type, comment) {
    if (!book || !selection) return;
    const item = {
      id: newId('int'),
      bookId: book.id,
      type,
      text: selection.text,
      anchor: selection.anchor,
      pct: Math.round((viewer.progress().ratio) * 100),
      createdAt: new Date().toISOString()
    };
    if (comment) item.comment = comment;
    await store.addInteraction(item);
    viewer.addHighlight(item);
    hideMenu();
  }

  menu.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-action]');
    if (!btn || !selection) return;
    switch (btn.dataset.action) {
      case 'highlight': await saveInteraction('highlight'); break;
      case 'note':
        noteSelection.textContent = selection.text.length > 200 ? selection.text.slice(0, 200) + '…' : selection.text;
        noteText.value = '';
        noteModal.classList.remove('hidden');
        menu.classList.add('hidden'); // la selección se conserva en `selection` hasta guardar o cancelar
        setTimeout(() => noteText.focus(), 100);
        break;
      case 'copy':
        try { await copyText(selection.text); toast('Copiado'); } catch { toast('No se pudo copiar'); }
        hideMenu();
        break;
      case 'clear': hideMenu(); break;
    }
  });

  $('note-cancel').addEventListener('click', () => { noteModal.classList.add('hidden'); hideMenu(); });
  $('note-save').addEventListener('click', async () => {
    noteModal.classList.add('hidden');
    await saveInteraction('note', noteText.value.trim());
  });
  noteModal.addEventListener('click', (ev) => { if (ev.target === noteModal) { noteModal.classList.add('hidden'); hideMenu(); } });

  slider.addEventListener('input', () => viewer && viewer.setProgress(Number(slider.value) / 100));

  function showZoom() {
    const z = viewer && viewer.getZoom ? viewer.getZoom() : 1;
    zoomLabel.textContent = Math.round(z * 100) + '%';
  }
  const zoomBy = (f) => { if (viewer && viewer.setZoom) { viewer.setZoom(viewer.getZoom() * f); showZoom(); } };
  $('zoom-in').addEventListener('click', () => zoomBy(ZOOM_STEP));
  $('zoom-out').addEventListener('click', () => zoomBy(1 / ZOOM_STEP));

  function clearReaderSearch({ close = false } = {}) {
    clearTimeout(searchTimer);
    searchTimer = 0;
    searchRequest++;
    if (viewer && viewer.clearFind) viewer.clearFind();
    searchInput.value = '';
    searchCount.textContent = '';
    if (close) {
      searchForm.classList.add('hidden');
      searchToggle.setAttribute('aria-expanded', 'false');
    }
  }

  async function findText(direction = 1) {
    const query = searchInput.value;
    if (!query.trim()) {
      clearReaderSearch();
      return;
    }
    if (!viewer || !viewer.findText) return;

    const request = ++searchRequest;
    searchCount.textContent = 'Buscando…';
    try {
      const result = await viewer.findText(query, direction);
      if (request !== searchRequest) return;
      if (!result) {
        searchCount.textContent = 'Sin resultados';
        return;
      }
      const location = result.page ? ' · pág. ' + result.page : '';
      searchCount.textContent = result.index + '/' + result.total + location;
    } catch (error) {
      if (request !== searchRequest) return;
      console.error('No se pudo buscar en el documento', error);
      searchCount.textContent = 'Error al buscar';
      toast('No se pudo buscar en el documento');
    }
  }

  searchToggle.addEventListener('click', () => {
    const open = searchForm.classList.contains('hidden');
    searchForm.classList.toggle('hidden', !open);
    searchToggle.setAttribute('aria-expanded', String(open));
    if (open) searchInput.focus();
    else clearReaderSearch();
  });
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTimer = 0;
      findText(1);
    }, 250);
  });
  searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    clearTimeout(searchTimer);
    searchTimer = 0;
    findText(1);
  });
  $('reader-search-prev').addEventListener('click', () => findText(-1));
  $('reader-search-next').addEventListener('click', () => findText(1));
  $('reader-search-close').addEventListener('click', () => {
    clearReaderSearch({ close: true });
    searchToggle.focus();
  });

  async function open(bookId) {
    const token = ++openToken;
    clearReaderSearch({ close: true });
    book = store.getBook(bookId);
    if (!book) return;
    toolbar.classList.remove('hidden');
    searchToggle.disabled = true;
    pageInfo.textContent = 'Cargando…';
    message('Cargando documento…');
    try {
      const bytes = await readBookFile(book.path);
      const content = await loadDocument(bytes, book);
      if (token !== openToken) { if (content.pdf) content.pdf.destroy(); return; } // el usuario ya salió: liberar el PDF
      // Si el archivo trae autor y el libro todavía no tiene uno, se completa solo (no pisa lo editado).
      if (content.meta && content.meta.author && !book.author) store.updateBook(book.id, { author: content.meta.author });
      host.innerHTML = '';
      viewer = (content.kind === 'pdf' ? createPdfViewer : createReflowViewer)({ host, onSelectionChange, onProgress });
      zoomBox.classList.toggle('hidden', !viewer.setZoom);
      showZoom();
      const highlights = store.interactionsOf(book.id).filter((i) => i.anchor);
      const orphans = await viewer.mount(content, { highlights, startBlock: book.lastBlock || 0 });
      if (token !== openToken) { viewer.destroy(); return; }
      searchToggle.disabled = false;
      if (!viewer.hasText()) toast('El documento no tiene texto legible');
      else if (orphans.length) toast(orphans.length + ' anotación(es) ya no se pueden ubicar en el documento');
    } catch (e) {
      if (token !== openToken) return;
      console.error(e);
      if (viewer) { viewer.destroy(); viewer = null; }
      zoomBox.classList.add('hidden');
      searchToggle.disabled = true;
      pageInfo.textContent = '';
      message(e instanceof UnsupportedFormatError
        ? 'Todavía no hay lector para <strong>' + escapeHtml(e.format) + '</strong>.'
        : 'No se pudo abrir el documento.<br><small>' + escapeHtml(e.message || e) + '</small>');
    }
  }

  return {
    el,
    title: (p) => (store.getBook(p.bookId) || {}).title || 'Lector',
    enter(params) { open(params.bookId); },
    leave() {
      openToken++;
      clearReaderSearch({ close: true });
      flushProgress();
      hideMenu();
      noteModal.classList.add('hidden');
      if (viewer) { viewer.destroy(); viewer = null; }
      zoomBox.classList.add('hidden');
      searchToggle.disabled = true;
      host.innerHTML = '';
      book = null;
    }
  };
}

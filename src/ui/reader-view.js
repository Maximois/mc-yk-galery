// Pantalla "Lector": abre el libro, muestra el visor y conecta selección -> resaltado/nota/copiar.
import { $, escapeHtml } from '../lib/dom.js';
import { newId } from '../lib/bytes.js';
import { readBookFile } from '../platform/files.js';
import { UnsupportedFormatError, loadDocument } from '../readers/index.js';
import { createReflowViewer } from '../reader/reflow-viewer.js';
import { toast } from './toast.js';

const SAVE_EVERY_MS = 1500;

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

  let book = null;
  let viewer = null;
  let selection = null; // última selección capturada: { anchor, text }
  let saveTimer = 0;
  let pendingProgress = null;
  let openToken = 0; // descarta respuestas de una apertura anterior si el usuario ya salió

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

  function onProgress({ ratio, block }) {
    const pct = Math.round(ratio * 100);
    pageInfo.textContent = 'Progreso ' + pct + ' %';
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

  async function open(bookId) {
    const token = ++openToken;
    book = store.getBook(bookId);
    if (!book) return;
    toolbar.classList.remove('hidden');
    pageInfo.textContent = 'Cargando…';
    message('Cargando documento…');
    try {
      const bytes = await readBookFile(book.path);
      const content = await loadDocument(bytes, book);
      if (token !== openToken) return;
      host.innerHTML = '';
      viewer = createReflowViewer({ host, onSelectionChange, onProgress });
      const highlights = store.interactionsOf(book.id).filter((i) => i.anchor);
      const orphans = await viewer.mount(content, { highlights, startBlock: book.lastBlock || 0 });
      if (token !== openToken) { viewer.destroy(); return; }
      if (!viewer.hasText()) toast('El documento no tiene texto legible');
      else if (orphans.length) toast(orphans.length + ' anotación(es) ya no se pueden ubicar en el texto');
    } catch (e) {
      if (token !== openToken) return;
      console.error(e);
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
      flushProgress();
      hideMenu();
      noteModal.classList.add('hidden');
      if (viewer) { viewer.destroy(); viewer = null; }
      host.innerHTML = '';
      book = null;
    }
  };
}

// MC Digilibrary - Android App
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Preferences } from '@capacitor/preferences';
import { Share } from '@capacitor/share';

const APP_VERSION = '0.1.0';
const DB_KEY = 'mc-digilibrary-db';

let db = { books: [], interactions: [] };
let currentBook = null;
let currentView = 'library';
let currentPage = 1;
let selectionData = null;

const $ = (id) => document.getElementById(id);
const views = {
  library: view-library,
  details: view-details,
  reader: view-reader,
  notebook: view-notebook
};

const headerTitle = title;
const btnBack = btn-back;
const btnAddBook = btn-add-book;
const fileInput = file-input;
const searchInput = search-input;
const libraryGrid = library-grid;
const libraryEmpty = library-empty;
const bookDetails = book-details;
const btnOpenReader = btn-open-reader;
const btnOpenNotebook = btn-open-notebook;
const btnRemoveBook = btn-remove-book;
const readerHost = reader-host;
const readerToolbar = reader-toolbar;
const pageInfo = page-info;
const pageSlider = page-slider;
const selectionMenu = selection-menu;
const noteModal = note-modal;
const noteSelection = note-selection;
const noteText = document.getElementById('note-text');
const noteCancel = document.getElementById('note-cancel');
const noteSave = document.getElementById('note-save');
const notebookTitle = document.getElementById('notebook-title');
const btnExportNotes = document.getElementById('btn-export-notes');
const notebookEmpty = document.getElementById('notebook-empty');
const notebookList = document.getElementById('notebook-list');

async function loadDB() {
  try {
    const { value } = await Preferences.get({ key: DB_KEY });
    if (value) db = JSON.parse(value);
  } catch (e) {
    console.error('Error cargando DB:', e);
  }
}

async function saveDB() {
  try {
    await Preferences.set({ key: DB_KEY, value: JSON.stringify(db) });
  } catch (e) {
    console.error('Error guardando DB:', e);
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = String(text || '');
  return div.innerHTML;
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatDate(dateStr) {
  try { return new Date(dateStr).toLocaleDateString('es-AR'); } catch { return dateStr; }
}

function getBookStats(bookId) {
  const interactions = db.interactions.filter(i => i.bookId === bookId);
  return {
    notes: interactions.filter(i => i.type === 'note').length,
    highlights: interactions.filter(i => i.type === 'highlight').length,
    total: interactions.length
  };
}

function showView(name) {
  currentView = name;
  Object.values(views).forEach(v => v && v.classList.remove('active'));
  if (views[name]) views[name].classList.add('active');
  if (name === 'library') {
    headerTitle.textContent = 'Biblioteca Digital';
    btnBack.classList.add('hidden');
    renderLibrary();
  } else if (name === 'details') {
    headerTitle.textContent = currentBook ? currentBook.title : 'Detalles';
    btnBack.classList.remove('hidden');
    renderDetails();
  } else if (name === 'reader') {
    headerTitle.textContent = currentBook ? currentBook.title : 'Lector';
    btnBack.classList.remove('hidden');
    readerToolbar.classList.remove('hidden');
  } else if (name === 'notebook') {
    headerTitle.textContent = 'Mi Cuaderno - ' + (currentBook ? currentBook.title : '');
    btnBack.classList.remove('hidden');
    renderNotebook();
  }
}

btnBack.addEventListener('click', () => {
  if (currentView === 'reader') { showView('details'); selectionMenu.classList.add('hidden'); }
  else if (currentView === 'notebook') { showView('details'); }
  else if (currentView === 'details') { showView('library'); }
});

btnAddBook.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  for (const file of files) await importBook(file);
  fileInput.value = '';
  renderLibrary();
});

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function importBook(file) {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const ext = file.name.split('.').pop().toLowerCase();
    const fileName = 'book_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9) + '.' + ext;
    const base64 = arrayBufferToBase64(arrayBuffer);
    await Filesystem.writeFile({ path: fileName, data: base64, directory: Directory.Data });
    const book = {
      id: 'book_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
      title: file.name.replace(/\.[^/.]+$/, ''),
      originalName: file.name,
      filename: fileName,
      path: fileName,
      format: ext.toUpperCase(),
      size: file.size,
      addedAt: new Date().toISOString(),
      lastPage: 1,
      progress: 0
    };
    db.books.push(book);
    await saveDB();
    currentBook = book;
    showView('details');
  } catch (e) {
    alert('Error al importar: ' + e.message);
  }
}

searchInput.addEventListener('input', () => renderLibrary());

function renderLibrary() {
  const query = (searchInput.value || '').toLowerCase().trim();
  let books = db.books || [];
  if (query) {
    books = books.filter(b => b.title.toLowerCase().includes(query) || b.format.toLowerCase().includes(query));
  }
  libraryGrid.innerHTML = '';
  if (books.length === 0) libraryEmpty.classList.remove('hidden');
  else {
    libraryEmpty.classList.add('hidden');
    for (const book of books) {
      const card = document.createElement('div');
      card.className = 'book-card';
      const stats = getBookStats(book.id);
      card.innerHTML = '<div class="book-cover"><div class="cover-fallback"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"></path></svg><span style="font-size:10px;text-transform:uppercase">' + escapeHtml(book.format) + '</span></div><span class="format-badge">' + escapeHtml(book.format) + '</span></div><div class="book-info"><div class="book-title">' + escapeHtml(book.title) + '</div><div class="book-author">' + escapeHtml(book.originalName) + '</div><div class="book-meta">' + formatBytes(book.size) + ' - ' + formatDate(book.addedAt) + '</div><div class="progress-bar"><div class="progress-fill" style="width:' + (book.progress||0) + '%"></div></div><div class="stats"><span>Notas: ' + stats.notes + '</span><span>Resaltados: ' + stats.highlights + '</span></div></div>';
      card.addEventListener('click', () => { currentBook = book; showView('details'); });
      libraryGrid.appendChild(card);
    }
  }
}

btnOpenReader.addEventListener('click', () => { showView('reader'); loadBookInReader(); });
btnOpenNotebook.addEventListener('click', () => showView('notebook'));
btnRemoveBook.addEventListener('click', () => {
  if (!currentBook) return;
  if (confirm('Eliminar "' + currentBook.title + '" de la biblioteca?')) {
    db.books = db.books.filter(b => b.id !== currentBook.id);
    db.interactions = db.interactions.filter(i => i.bookId !== currentBook.id);
    saveDB();
    currentBook = null;
    showView('library');
  }
});

function renderDetails() {
  if (!currentBook) return;
  const stats = getBookStats(currentBook.id);
  bookDetails.innerHTML = '<div class="details-card"><div class="details-cover"><div class="cover-fallback" style="height:100%;justify-content:center"><svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"></path></svg><span style="font-size:12px;margin-top:8px;text-transform:uppercase">' + escapeHtml(currentBook.format) + '</span></div></div><div class="details-info"><div class="details-title">' + escapeHtml(currentBook.title) + '</div><div class="details-meta"><div><strong>Archivo:</strong> ' + escapeHtml(currentBook.originalName) + '</div><div><strong>Formato:</strong> ' + currentBook.format + '</div><div><strong>Tamano:</strong> ' + formatBytes(currentBook.size) + '</div><div><strong>Agregado:</strong> ' + formatDate(currentBook.addedAt) + '</div></div><div class="details-section"><h3>Mi Cuaderno</h3><div class="stats-grid"><div class="stat-item"><div class="stat-value">' + stats.total + '</div><div class="stat-label">Interacciones</div></div><div class="stat-item"><div class="stat-value">' + stats.notes + '</div><div class="stat-label">Notas</div></div><div class="stat-item"><div class="stat-value">' + stats.highlights + '</div><div class="stat-label">Resaltados</div></div><div class="stat-item"><div class="stat-value">' + (currentBook.progress||0) + '%</div><div class="stat-label">Progreso</div></div></div></div></div></div>';
}

async function loadBookInReader() {
  if (!currentBook) return;
  readerHost.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--muted)">Cargando documento...</div>';
  try {
    const file = await Filesystem.readFile({ path: currentBook.filename, directory: Directory.Data });
    const base64 = typeof file.data === 'string' ? file.data : arrayBufferToBase64(new Uint8Array(file.data));
    const dataUrl = 'data:application/octet-stream;base64,' + base64;
    readerHost.innerHTML = '';
    const iframe = document.createElement('iframe');
    iframe.id = 'doc-iframe';
    iframe.style.cssText = 'width:100%;height:100%;border:none;background:#fff;';
    iframe.srcdoc = getReaderHtml(dataUrl, currentBook);
    readerHost.appendChild(iframe);
    iframe.onload = () => setupReaderInteractions(iframe);
  } catch (e) {
    readerHost.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--danger);padding:16px;text-align:center">Error al cargar<br><small>' + escapeHtml(e.message) + '</small></div>';
  }
}

function getReaderHtml(dataUrl, book) {
  return '<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"><style>*{margin:0;padding:0;box-sizing:border-box}html,body{height:100%;width:100%;background:#1a1a1a;overflow:auto;font-family:-apple-system,sans-serif}.doc{background:#fff;max-width:800px;margin:0 auto;padding:40px 24px;min-height:100%}.doc p{margin-bottom:1em;line-height:1.7;color:#1a1a1a}::selection{background:rgba(0,212,170,0.3)}</style></head><body><div class="doc" id="doc-content"><p style="text-align:center;color:#666;padding:40px">Documento ' + book.format + ' - ' + book.title + '</p></div><script>document.addEventListener("mouseup",function(){var sel=window.getSelection();if(sel&&sel.toString().trim()){window.parent.postMessage({type:"digilibrary-selection",text:sel.toString().trim()}, "*");}});<\/script></body></html>';
}

function setupReaderInteractions(iframe) {
  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'digilibrary-selection') {
      const text = e.data.text.trim();
      if (text.length === 0) { selectionMenu.classList.add('hidden'); return; }
      selectionData = { text: text, bookId: currentBook.id, page: currentPage };
      showSelectionMenu(50, 200);
    }
  });
  document.addEventListener('mouseup', (e) => {
    if (currentView !== 'reader') return;
    setTimeout(() => {
      const sel = window.getSelection();
      if (sel && sel.toString().trim().length > 0) {
        selectionData = { text: sel.toString().trim(), bookId: currentBook ? currentBook.id : null, page: currentPage };
        showSelectionMenu(e.clientX, e.clientY);
      } else selectionMenu.classList.add('hidden');
    }, 10);
  });
}

function showSelectionMenu(x, y) {
  selectionMenu.style.left = Math.min(Math.max(x, 50), window.innerWidth - 220) + 'px';
  selectionMenu.style.top = Math.min(y - 60, window.innerHeight - 70) + 'px';
  selectionMenu.classList.remove('hidden');
}

selectionMenu.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === 'highlight') {
    if (!selectionData) return;
    db.interactions.push({ id: 'int_' + Date.now(), bookId: selectionData.bookId, type: 'highlight', text: selectionData.text, page: selectionData.page, createdAt: new Date().toISOString() });
    saveDB(); selectionMenu.classList.add('hidden'); window.getSelection()?.removeAllRanges();
  } else if (action === 'note') {
    if (!selectionData) return;
    noteSelection.textContent = selectionData.text.length > 200 ? selectionData.text.substring(0,200) + '...' : selectionData.text;
    noteText.value = ''; noteModal.classList.remove('hidden'); selectionMenu.classList.add('hidden'); setTimeout(() => noteText.focus(), 100);
  } else if (action === 'copy') {
    if (selectionData) navigator.clipboard.writeText(selectionData.text);
    selectionMenu.classList.add('hidden'); window.getSelection()?.removeAllRanges();
  } else if (action === 'clear') {
    selectionMenu.classList.add('hidden'); window.getSelection()?.removeAllRanges();
  }
});

noteCancel.addEventListener('click', () => noteModal.classList.add('hidden'));
noteSave.addEventListener('click', () => {
  if (!selectionData) return;
  db.interactions.push({ id: 'int_' + Date.now(), bookId: selectionData.bookId, type: 'note', text: selectionData.text, comment: noteText.value.trim(), page: selectionData.page, createdAt: new Date().toISOString() });
  saveDB(); noteModal.classList.add('hidden'); window.getSelection()?.removeAllRanges(); selectionData = null;
});
noteModal.addEventListener('click', (e) => { if (e.target === noteModal) noteModal.classList.add('hidden'); });

function renderNotebook() {
  if (!currentBook) return;
  notebookTitle.textContent = 'NOTAS E INTERACCIONES: "' + currentBook.title + '"';
  const interactions = (db.interactions || []).filter(i => i.bookId === currentBook.id).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
  notebookList.innerHTML = '';
  if (interactions.length === 0) notebookEmpty.classList.remove('hidden');
  else {
    notebookEmpty.classList.add('hidden');
    for (const item of interactions) {
      const card = document.createElement('div');
      card.className = 'interaction-card';
      const dateStr = new Date(item.createdAt).toLocaleDateString('es-AR');
      card.innerHTML = '<div class="interaction-header"><div class="interaction-meta"><span class="badge ' + (item.type === 'note' ? 'badge-note' : 'badge-highlight') + '">' + (item.type === 'note' ? 'RESALTADO+NOTA' : 'RESALTADO') + '</span><span>Pag. ' + (item.page||'?') + '</span><span>-</span><span>' + dateStr + '</span></div><button class="btn-icon btn-small" data-del="' + item.id + '"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"></path><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path></svg></button></div><div class="interaction-selected">' + escapeHtml(item.text) + '</div>' + (item.comment ? '<div class="interaction-comment">Nota: ' + escapeHtml(item.comment) + '</div>' : '');
      card.querySelector('[data-del]').addEventListener('click', () => { if (confirm('Eliminar esta interaccion?')) { db.interactions = db.interactions.filter(i => i.id !== item.id); saveDB(); renderNotebook(); renderLibrary(); if (currentView==='details') renderDetails(); }});
      notebookList.appendChild(card);
    }
  }
}

btnExportNotes.addEventListener('click', async () => {
  if (!currentBook) return;
  const interactions = (db.interactions || []).filter(i => i.bookId === currentBook.id).sort((a,b) => (a.page||0)-(b.page||0));
  if (interactions.length === 0) { alert('Sin anotaciones para exportar'); return; }
  let content = '# NOTAS: ' + currentBook.title + '\n\n';
  for (const item of interactions) {
    if (item.comment) { content += '## RESALTADO+NOTA Pag.' + (item.page||'?') + '\n> ' + item.text + '\n\nNota: ' + item.comment + '\n\n---\n\n'; }
    else { content += '## RESALTADO Pag.' + (item.page||'?') + '\n> ' + item.text + '\n\n---\n\n'; }
  }
  try { await Share.share({ title: 'Notas - ' + currentBook.title, text: content, dialogTitle: 'Exportar notas' }); }
  catch(e) { const blob = new Blob([content], {type:'text/markdown'}); const url = URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='Notas_'+currentBook.title.replace(/[^a-z0-9]/gi,'_')+'.md'; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url); }
});

window.addEventListener('DOMContentLoaded', async () => { await loadDB(); showView('library'); });
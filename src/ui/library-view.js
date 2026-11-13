// Pantalla "Biblioteca": estantería, búsqueda e importación.
import { $, escapeHtml, formatBytes, formatDate } from '../lib/dom.js';
import { emptyCoverHtml } from '../lib/cover.js';
import { toast } from './toast.js';

/** Reemplaza la portada estática por la real, si el libro tiene una. */
export async function applyCover(container, book, covers) {
  const url = await covers.urlFor(book);
  const empty = container.querySelector('.cover-empty');
  if (!url || !empty || !container.isConnected) return;
  const img = new Image();
  img.alt = 'Portada de ' + book.title;
  img.decoding = 'async';
  img.src = url;
  empty.replaceWith(img);
}

export function createLibraryView({ store, importer, covers, router }) {
  const el = $('view-library');
  const grid = $('library-grid');
  const empty = $('library-empty');
  const search = $('search-input');
  const fileInput = $('file-input');

  function matches(book, q) {
    return [book.title, book.author, book.format, book.originalName].some((v) => String(v || '').toLowerCase().includes(q));
  }

  function card(book) {
    const stats = store.statsOf(book.id);
    const node = document.createElement('div');
    node.className = 'book-card';
    node.innerHTML =
      '<div class="book-cover">' + emptyCoverHtml() +
        '<span class="format-badge">' + escapeHtml(book.format) + '</span>' +
      '</div>' +
      '<div class="book-info">' +
        '<div class="book-title">' + escapeHtml(book.title) + '</div>' +
        '<div class="book-author">' + escapeHtml(book.author || book.originalName) + '</div>' +
        '<div class="book-meta">' + formatBytes(book.size) + ' · ' + formatDate(book.addedAt) + '</div>' +
        '<div class="progress-bar"><div class="progress-fill" style="width:' + (Number(book.progress) || 0) + '%"></div></div>' +
        '<div class="stats"><span>Notas: ' + stats.notes + '</span><span>Resaltados: ' + stats.highlights + '</span></div>' +
      '</div>';
    node.dataset.bookId = book.id;
    node.addEventListener('click', () => router.go('details', { bookId: book.id }));
    applyCover(node.querySelector('.book-cover'), book, covers);
    return node;
  }

  function render() {
    const q = search.value.toLowerCase().trim();
    const books = store.books().filter((b) => !q || matches(b, q));
    grid.innerHTML = '';
    empty.classList.toggle('hidden', books.length > 0);
    for (const b of books) grid.appendChild(card(b));
  }

  // Una portada nueva (o regenerada) solo cambia su tarjeta; no se vuelve a armar toda la estantería.
  covers.onChange((id) => {
    const node = grid.querySelector('[data-book-id="' + id + '"]');
    const book = store.getBook(id);
    if (node && book) applyCover(node.querySelector('.book-cover'), book, covers);
  });

  $('btn-add-book').addEventListener('click', () => fileInput.click());
  search.addEventListener('input', render);

  fileInput.addEventListener('change', async (ev) => {
    const files = Array.from(ev.target.files || []);
    fileInput.value = '';
    let last = null;
    for (const file of files) {
      try {
        const { book, duplicate } = await importer.importFile(file);
        if (duplicate) toast('"' + book.title + '" ya estaba en la biblioteca');
        last = book;
        if (!duplicate) covers.ensure(book);
      } catch (e) {
        console.error(e);
        toast('No se pudo importar "' + file.name + '": ' + (e.message || e));
      }
    }
    if (files.length === 1 && last) router.go('details', { bookId: last.id });
    else render();
  });

  return {
    el,
    title: () => 'Biblioteca Digital',
    enter: render,
    leave() {}
  };
}

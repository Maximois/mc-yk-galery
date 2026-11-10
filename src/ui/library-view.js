// Pantalla "Biblioteca": estantería, búsqueda e importación.
import { $, escapeHtml, formatBytes, formatDate } from '../lib/dom.js';
import { coverColor, coverInitial } from '../lib/cover.js';
import { toast } from './toast.js';

export function createLibraryView({ store, importer, router }) {
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
      '<div class="book-cover" style="background:' + coverColor(book.title) + '">' +
        '<div class="cover-fallback"><span class="cover-initial">' + escapeHtml(coverInitial(book.title)) + '</span></div>' +
        '<span class="format-badge">' + escapeHtml(book.format) + '</span>' +
      '</div>' +
      '<div class="book-info">' +
        '<div class="book-title">' + escapeHtml(book.title) + '</div>' +
        '<div class="book-author">' + escapeHtml(book.author || book.originalName) + '</div>' +
        '<div class="book-meta">' + formatBytes(book.size) + ' · ' + formatDate(book.addedAt) + '</div>' +
        '<div class="progress-bar"><div class="progress-fill" style="width:' + (Number(book.progress) || 0) + '%"></div></div>' +
        '<div class="stats"><span>Notas: ' + stats.notes + '</span><span>Resaltados: ' + stats.highlights + '</span></div>' +
      '</div>';
    node.addEventListener('click', () => router.go('details', { bookId: book.id }));
    return node;
  }

  function render() {
    const q = search.value.toLowerCase().trim();
    const books = store.books().filter((b) => !q || matches(b, q));
    grid.innerHTML = '';
    empty.classList.toggle('hidden', books.length > 0);
    for (const b of books) grid.appendChild(card(b));
  }

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

// Pantalla "Ficha del libro": datos, progreso, últimas anotaciones y accesos al lector y al cuaderno.
import { $, escapeHtml, formatBytes, formatDate } from '../lib/dom.js';
import { emptyCoverHtml } from '../lib/cover.js';
import { canRead } from '../readers/index.js';
import { deleteBookFile } from '../platform/files.js';
import { toast } from './toast.js';

const RECENT = 3;

export function createDetailsView({ store, router }) {
  const el = $('view-details');
  const body = $('book-details');
  const btnReader = $('btn-open-reader');
  const btnNotebook = $('btn-open-notebook');
  const btnRemove = $('btn-remove-book');
  let book = null;

  function recentNotes() {
    const list = store.interactionsOf(book.id)
      .slice()
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, RECENT);
    if (!list.length) return '';
    return '<div class="details-section"><h3>Últimas anotaciones</h3>' +
      list.map((i) =>
        '<div class="interaction-selected">' + escapeHtml(String(i.text).slice(0, 160)) +
        (i.comment ? '<div class="interaction-comment">Nota: ' + escapeHtml(i.comment) + '</div>' : '') + '</div>'
      ).join('') + '</div>';
  }

  function render() {
    const stats = store.statsOf(book.id);
    const readable = canRead(book.format);
    body.innerHTML =
      '<div class="details-card">' +
        '<div class="details-cover">' + emptyCoverHtml({ big: true }) + '</div>' +
        '<div class="details-info">' +
          '<div class="details-title">' + escapeHtml(book.title) + '</div>' +
          '<div class="details-meta">' +
            (book.author ? '<div><strong>Autor:</strong> ' + escapeHtml(book.author) + '</div>' : '') +
            '<div><strong>Archivo:</strong> ' + escapeHtml(book.originalName) + '</div>' +
            '<div><strong>Formato:</strong> ' + escapeHtml(book.format) + '</div>' +
            '<div><strong>Tamaño:</strong> ' + formatBytes(book.size) + '</div>' +
            '<div><strong>Agregado:</strong> ' + formatDate(book.addedAt) + '</div>' +
          '</div>' +
          (readable ? '' : '<p class="hint">Todavía no hay lector para ' + escapeHtml(book.format) +
            '. El documento queda guardado en tu biblioteca y se podrá leer cuando el formato esté disponible.</p>') +
          '<div class="details-section"><h3>Mi Cuaderno</h3><div class="stats-grid">' +
            stat(stats.total, 'Interacciones') + stat(stats.notes, 'Notas') +
            stat(stats.highlights, 'Resaltados') + stat(stats.underlines, 'Subrayados') + stat((Number(book.progress) || 0) + '%', 'Progreso') +
          '</div></div>' +
          recentNotes() +
        '</div>' +
      '</div>';
    btnReader.disabled = !readable;
    btnReader.textContent = readable
      ? (book.progress > 0 ? 'Continuar lectura' : 'Abrir Lector')
      : 'Lector no disponible para ' + book.format;
  }

  const stat = (value, label) =>
    '<div class="stat-item"><div class="stat-value">' + value + '</div><div class="stat-label">' + label + '</div></div>';

  btnReader.addEventListener('click', () => book && router.go('reader', { bookId: book.id }));
  btnNotebook.addEventListener('click', () => book && router.go('notebook', { bookId: book.id }));
  btnRemove.addEventListener('click', async () => {
    if (!book || !confirm('¿Eliminar "' + book.title + '" de la biblioteca? Se borran también sus notas y resaltados.')) return;
    const removed = await store.removeBook(book.id);
    if (removed) await deleteBookFile(removed.path); // sin esto el archivo quedaba huérfano ocupando espacio
    toast('Libro eliminado');
    router.reset('library');
  });

  return {
    el,
    title: (p) => (store.getBook(p.bookId) || {}).title || 'Detalles',
    enter(params) {
      book = store.getBook(params.bookId);
      if (!book) { router.reset('library'); return; }
      render();
    },
    leave() { book = null; }
  };
}

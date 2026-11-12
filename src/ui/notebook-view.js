// Pantalla "Cuaderno": anotaciones del libro, borrado y exportación (.md / .txt).
import { $, escapeHtml, formatDate, safeFileName } from '../lib/dom.js';
import { buildNotesMarkdown, buildNotesText } from '../notes/export.js';
import { shareTextFile } from '../platform/share.js';
import { toast } from './toast.js';

export function createNotebookView({ store }) {
  const el = $('view-notebook');
  const title = $('notebook-title');
  const empty = $('notebook-empty');
  const list = $('notebook-list');
  let book = null;

  function card(item) {
    const node = document.createElement('div');
    node.className = 'interaction-card';
    const isNote = item.type === 'note';
    node.innerHTML =
      '<div class="interaction-header"><div class="interaction-meta">' +
        '<span class="badge ' + (isNote ? 'badge-note' : 'badge-highlight') + '">' + (isNote ? 'RESALTADO + NOTA' : 'RESALTADO') + '</span>' +
        (item.anchor && Number.isFinite(item.anchor.page) ? '<span>Pág. ' + item.anchor.page + '</span><span>·</span>'
          : Number.isFinite(item.pct) ? '<span>Pos. ' + item.pct + ' %</span><span>·</span>' : '') +
        '<span>' + formatDate(item.createdAt) + '</span></div>' +
        '<button class="btn-icon btn-small" data-del="' + escapeHtml(item.id) + '" aria-label="Eliminar anotación">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"></path><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path></svg></button></div>' +
      '<div class="interaction-selected">' + escapeHtml(item.text) + '</div>' +
      (item.comment ? '<div class="interaction-comment">Nota: ' + escapeHtml(item.comment) + '</div>' : '');
    node.querySelector('[data-del]').addEventListener('click', async () => {
      if (!confirm('¿Eliminar esta anotación?')) return;
      await store.removeInteraction(item.id);
      render();
    });
    return node;
  }

  function render() {
    if (!book) return;
    title.textContent = 'Notas e interacciones: "' + book.title + '"';
    const items = store.interactionsOf(book.id).slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    list.innerHTML = '';
    empty.classList.toggle('hidden', items.length > 0);
    items.forEach((i) => list.appendChild(card(i)));
  }

  async function exportAs(kind) {
    if (!book) return;
    const items = store.interactionsOf(book.id);
    if (!items.length) { toast('Todavía no hay anotaciones para exportar'); return; }
    const build = kind === 'md' ? buildNotesMarkdown : buildNotesText;
    const result = await shareTextFile({
      filename: 'Notas_' + safeFileName(book.title) + '.' + kind,
      content: build(book, items, { formatDate }),
      title: 'Notas — ' + book.title
    });
    if (result === 'downloaded') toast('Archivo descargado');
  }

  $('btn-export-md').addEventListener('click', () => exportAs('md'));
  $('btn-export-txt').addEventListener('click', () => exportAs('txt'));

  return {
    el,
    title: (p) => 'Mi Cuaderno — ' + ((store.getBook(p.bookId) || {}).title || ''),
    enter(params) { book = store.getBook(params.bookId); render(); },
    leave() { book = null; }
  };
}

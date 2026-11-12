// Exportación de anotaciones a Markdown o texto plano. Funciones puras (sin DOM ni Capacitor).

/** En orden de lectura; las anotaciones sin ancla (huérfanas o antiguas) van al final por fecha. */
export function sortForExport(items) {
  // Texto reflowable: offset en el texto. PDF: página + posición vertical dentro de la página.
  const pos = (i) => {
    const a = i.anchor;
    if (!a) return Infinity;
    if (Number.isFinite(a.s)) return a.s;
    if (Number.isFinite(a.page)) return a.page + ((a.rects && a.rects[0] && a.rects[0].y) || 0);
    return Infinity;
  };
  return items.slice().sort((a, b) => (pos(a) - pos(b)) || (new Date(a.createdAt) - new Date(b.createdAt)));
}

function where(item, formatDate) {
  const parts = [];
  if (item.anchor && Number.isFinite(item.anchor.page)) parts.push('página ' + item.anchor.page);
  else if (Number.isFinite(item.pct)) parts.push('posición ' + item.pct + ' %');
  if (item.createdAt) parts.push(formatDate(item.createdAt));
  return parts.join(' · ');
}

const defaultDate = (v) => String(v).slice(0, 10);

export function buildNotesMarkdown(book, items, { formatDate = defaultDate } = {}) {
  const out = ['# Notas: ' + book.title, ''];
  if (book.author) out.push('*' + book.author + '*', '');
  const list = sortForExport(items);
  if (!list.length) out.push('_Sin anotaciones._', '');
  for (const it of list) {
    out.push(String(it.text || '').split('\n').map((l) => '> ' + l).join('\n'), '');
    if (it.comment) out.push('**Nota:** ' + it.comment, '');
    const w = where(it, formatDate);
    if (w) out.push('_' + w + '_', '');
    out.push('---', '');
  }
  return out.join('\n');
}

export function buildNotesText(book, items, { formatDate = defaultDate } = {}) {
  const out = ['NOTAS: ' + book.title];
  if (book.author) out.push(book.author);
  out.push('');
  const list = sortForExport(items);
  if (!list.length) out.push('(Sin anotaciones)', '');
  list.forEach((it, i) => {
    out.push((i + 1) + '. ' + (it.type === 'note' ? 'Nota' : 'Resaltado') + ' (' + where(it, formatDate) + ')');
    out.push('   "' + String(it.text || '').replace(/\n+/g, ' ') + '"');
    if (it.comment) out.push('   Nota: ' + it.comment);
    out.push('');
  });
  return out.join('\n');
}

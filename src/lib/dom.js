// Utilidades de DOM y formato. Sin estado ni dependencias: se pueden usar desde cualquier módulo.

/** getElementById que falla en voz alta si el id no existe (evita bugs silenciosos al renombrar). */
export function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error('Falta el elemento #' + id + ' en index.html');
  return el;
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escapa texto para meterlo en HTML, también dentro de atributos. */
export function escapeHtml(text) {
  return String(text == null ? '' : text).replace(/[&<>"']/g, (c) => ESC[c]);
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return parseFloat((bytes / Math.pow(1024, i)).toFixed(1)) + ' ' + units[i];
}

export function formatDate(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value || '') : d.toLocaleDateString('es-AR');
}

/** Nombre de archivo seguro (conserva letras y números de cualquier idioma). */
export function safeFileName(name, fallback = 'documento') {
  const clean = String(name || '').replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '');
  return clean.slice(0, 80) || fallback;
}

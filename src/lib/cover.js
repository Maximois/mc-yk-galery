// Portada estática para los libros que no traen una propia. Es la misma para todos (no depende
// del título): así la estantería se ve ordenada y "Sin portada" se entiende de un vistazo.
// El estilo vive en styles.css (.cover-empty); acá solo el marcado, que usan la biblioteca y la ficha.

const ORNAMENT =
  '<svg class="cover-ornament" viewBox="0 0 64 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1">' +
  '<path d="M2 8h22M40 8h22"/><path d="M32 2l5 6-5 6-5-6z"/><circle cx="32" cy="8" r="1.2" fill="currentColor"/></svg>';

export const COVER_TITLE = 'Sin portada';
export const COVER_SUBTITLE = '¿Algún hechizo de ocultación?';

/** HTML de la portada por defecto. `big` la agranda para la ficha del libro. */
export function emptyCoverHtml({ big = false } = {}) {
  return '<div class="cover-empty' + (big ? ' big' : '') + '" role="img" aria-label="' + COVER_TITLE + '">' +
    '<div class="cover-frame">' + ORNAMENT +
    '<div class="cover-empty-title">' + COVER_TITLE + '</div>' +
    '<div class="cover-empty-sub">' + COVER_SUBTITLE + '</div>' +
    ORNAMENT + '</div></div>';
}

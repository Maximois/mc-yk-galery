// Registro de lectores: formato -> lector. Es el único lugar que hay que tocar para sumar un formato.
//
// Estado de formatos (ver docs/PLAN.md):
//   listos:      TXT, MD, DOCX, ODT
//   por escribir: PDF (pdf.js ya está vendorizado; mcbro-refact tiene core/pdf-pages.js con capa de
//                 texto), EPUB (el núcleo solo sabe escribirlo, no leerlo), RTF y DOC (el núcleo
//                 ya los lee: falta cablearlos y probarlos con archivos reales).
import { loadCore } from './doc-core.js';
import { TEXT_FORMATS, createTextReader } from './text.js';
import { DOCX_FORMATS, ODT_FORMATS, createDocxReader, createOdtReader } from './office.js';

const ENTRIES = [
  { formats: TEXT_FORMATS, create: createTextReader },
  { formats: DOCX_FORMATS, create: createDocxReader },
  { formats: ODT_FORMATS, create: createOdtReader }
];

const upper = (f) => String(f || '').toUpperCase();

/** ¿Hay lector para este formato? Es síncrono: no hace falta cargar el núcleo para saberlo. */
export function canRead(format) {
  return ENTRIES.some((e) => e.formats.includes(upper(format)));
}

export class UnsupportedFormatError extends Error {
  constructor(format) {
    super('Todavía no hay lector para ' + upper(format));
    this.name = 'UnsupportedFormatError';
    this.format = upper(format);
  }
}

/** Convierte los bytes del libro en contenido listo para el visor. */
export async function loadDocument(bytes, book) {
  const entry = ENTRIES.find((e) => e.formats.includes(upper(book.format)));
  if (!entry) throw new UnsupportedFormatError(book.format);
  const core = await loadCore();
  return entry.create(core).load(bytes, book);
}

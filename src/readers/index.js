// Registro de lectores: formato -> lector. Es el único lugar que hay que tocar para sumar un formato.
//
// Cada entrada dice qué grupos del núcleo necesita (ver doc-core.js) para no cargar de más:
//   base   TXT, MD, DOCX, ODT, EPUB
//   legacy RTF, DOC, HTML
//   pdf    PDF (pdf.js + extractor de texto)
import { loadCore } from './doc-core.js';
import { TEXT_FORMATS, createTextReader } from './text.js';
import { DOCX_FORMATS, ODT_FORMATS, createDocxReader, createOdtReader } from './office.js';
import { RTF_FORMATS, DOC_FORMATS, HTML_FORMATS, createRtfReader, createDocReader, createHtmlReader } from './legacy.js';
import { PDF_FORMATS, createPdfReader } from './pdf.js';
import { EPUB_FORMATS, createEpubReader } from './epub.js';

const ENTRIES = [
  { formats: TEXT_FORMATS, groups: [], create: createTextReader },
  { formats: DOCX_FORMATS, groups: [], create: createDocxReader },
  { formats: ODT_FORMATS, groups: [], create: createOdtReader },
  { formats: EPUB_FORMATS, groups: [], create: createEpubReader },
  { formats: RTF_FORMATS, groups: ['legacy'], create: createRtfReader },
  { formats: DOC_FORMATS, groups: ['legacy'], create: createDocReader },
  { formats: HTML_FORMATS, groups: ['legacy'], create: createHtmlReader },
  { formats: PDF_FORMATS, groups: ['pdf'], create: createPdfReader }
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

/** Convierte los bytes del libro en contenido listo para el visor. `opts.askPassword` solo lo usa el PDF. */
export async function loadDocument(bytes, book, opts) {
  const entry = ENTRIES.find((e) => e.formats.includes(upper(book.format)));
  if (!entry) throw new UnsupportedFormatError(book.format);
  const core = await loadCore(...entry.groups);
  return entry.create(core).load(bytes, book, opts);
}

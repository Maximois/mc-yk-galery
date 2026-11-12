// Lector de PDF: abre el documento con pdf.js y devuelve un contenido de tipo 'pdf' que muestra
// src/reader/pdf-viewer.js: las páginas tal cual el original (canvas) con capa de texto para seleccionar.
//
// Contrato (distinto del reflowable): load(bytes, book) -> { kind:'pdf', pdf, lib, title, warnings, meta }
// El visor se encarga de destruir `pdf` al cerrar el lector.
import { friendlyPdfError } from '../reader/pdf-errors.js';

export const PDF_FORMATS = ['PDF'];

export function createPdfReader(core) {
  return {
    id: 'pdf',
    formats: PDF_FORMATS,
    async load(bytes, book) {
      if (!core.pdfjs) throw new Error('pdf.js no está cargado');
      let pdf;
      try {
        // pdf.js transfiere el buffer a su worker y lo deja inutilizable: se le pasa una copia.
        pdf = await core.pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, useSystemFonts: true, verbosity: 0 }).promise;
      } catch (e) {
        throw new Error(friendlyPdfError(e));
      }
      let info = {};
      try { info = ((await pdf.getMetadata()) || {}).info || {}; } catch { /* metadatos opcionales */ }
      const clean = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 300) : '');
      return {
        kind: 'pdf',
        pdf,
        lib: core.pdfjs,
        title: clean(info.Title) || (book && book.title) || '',
        warnings: [],
        meta: { author: clean(info.Author), pageCount: pdf.numPages }
      };
    }
  };
}

// Lector de PDF: extrae el TEXTO con pdf.js (core/pdf-text.js) y lo muestra reflowable, igual que
// el resto de formatos. Es la mejor opción para pantallas chicas (el texto se adapta al ancho) y
// permite usar el mismo sistema de resaltados y notas.
//
// Limitaciones (a propósito, hasta que se pida otra cosa):
//   - No muestra la maquetación original, las imágenes ni las tablas como están en la página.
//   - Un PDF escaneado (solo imágenes) no tiene texto: se avisa, hace falta OCR.
//   - El progreso es porcentaje del texto, no número de página.
// Para una vista fiel de las páginas, mcbro-refact tiene core/pdf-pages.js (canvas + capa de texto);
// sería un segundo visor, no un reemplazo de este.
import { docToReflow } from './reflow.js';

export const PDF_FORMATS = ['PDF'];

export function createPdfReader(core) {
  return {
    id: 'pdf',
    formats: PDF_FORMATS,
    async load(bytes, book) {
      if (!core.pdfjs) throw new Error('pdf.js no está cargado');
      // pdf.js transfiere el buffer a su worker y lo deja inutilizable: se le pasa una copia.
      const res = await core.pdfText.pdfBytesToBlocks(bytes.slice(), { pdfjs: core.pdfjs });
      const title = res.meta.title || (book && book.title) || '';
      const doc = core.model.createDoc({ title, blocks: res.blocks, meta: { source: 'pdf', author: res.meta.author } });
      const out = docToReflow(core, doc, res.warnings);
      out.meta = { author: res.meta.author, pageCount: res.pageCount };
      return out;
    }
  };
}

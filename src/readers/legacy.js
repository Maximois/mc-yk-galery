// Lectores de RTF, DOC (Word binario) y HTML. Los tres pasan por doc-read.js del núcleo, que según
// `kind` decide cómo abrir; el binario .doc intenta además el respaldo RTF/HTML/texto si no es OLE2.
import { docToReflow } from './reflow.js';

export const RTF_FORMATS = ['RTF'];
export const DOC_FORMATS = ['DOC', 'DOT'];
export const HTML_FORMATS = ['HTML', 'HTM', 'XHTML'];

function make(id, formats, kind) {
  return (core) => ({
    id,
    formats,
    async load(bytes, book) {
      const { doc, warnings } = core.docRead.docBytesToDoc(bytes, {
        kind,
        title: book && book.title,
        format: String((book && book.format) || kind).toLowerCase()
      });
      return docToReflow(core, doc, warnings);
    }
  });
}

export const createRtfReader = make('rtf', RTF_FORMATS, 'rtf');
export const createDocReader = make('doc', DOC_FORMATS, 'doc');
export const createHtmlReader = make('html', HTML_FORMATS, 'html');

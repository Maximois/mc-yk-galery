// Lector de texto plano y Markdown. El TXT pasa por el núcleo compartido; el Markdown tiene su propio
// intérprete (markdown.js) porque el núcleo no entiende el énfasis en línea (**negrita**, *cursiva*, enlaces).
import { docToReflow } from './reflow.js';
import { MARKDOWN_CSS, markdownToBlocks } from './markdown.js';

export const TEXT_FORMATS = ['TXT', 'MD', 'MARKDOWN'];

/** Decodifica bytes de un archivo de texto: BOM UTF-16, UTF-8 y, si no es UTF-8 válido, Windows-1252. */
export function decodeText(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes); // quita el BOM UTF-8 solo
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

export function createTextReader(core) {
  return {
    id: 'text',
    formats: TEXT_FORMATS,
    async load(bytes, book) {
      const fmt = String((book && book.format) || 'txt').toLowerCase();
      if (fmt === 'md' || fmt === 'markdown') {
        const blocks = markdownToBlocks(decodeText(bytes)).map((html) => ({ html }));
        const css = core.html.stylesheet(core.model.createDoc({ title: '', blocks: [] })) + MARKDOWN_CSS;
        return { kind: 'reflow', title: (book && book.title) || '', css, blocks, warnings: blocks.length ? [] : ['El archivo está vacío'] };
      }
      const doc = core.textIo.textToDoc(decodeText(bytes), {
        title: book && book.title,
        source: String((book && book.format) || 'txt').toLowerCase()
      });
      return docToReflow(core, doc);
    }
  };
}

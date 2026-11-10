// Lectores de DOCX y ODT (ambos son un ZIP que el núcleo convierte al modelo de bloques).
import { docToReflow } from './reflow.js';

export const DOCX_FORMATS = ['DOCX'];
export const ODT_FORMATS = ['ODT'];

export function createDocxReader(core) {
  return {
    id: 'docx',
    formats: DOCX_FORMATS,
    async load(bytes) {
      const { doc, warnings } = await core.docxRead.docxBytesToDoc(bytes);
      return docToReflow(core, doc, warnings);
    }
  };
}

export function createOdtReader(core) {
  return {
    id: 'odt',
    formats: ODT_FORMATS,
    async load(bytes) {
      const { doc, warnings } = await core.odtRead.odtBytesToDoc(bytes);
      return docToReflow(core, doc, warnings);
    }
  };
}

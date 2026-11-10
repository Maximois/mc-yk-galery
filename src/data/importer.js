// Importación de documentos: copia el archivo al almacenamiento privado y lo registra en la biblioteca.
// `files` se inyecta ({ bookPath, writeBookFile }) para poder probar sin Capacitor.
import { sha256Hex } from '../lib/bytes.js';

const extensionOf = (name) => {
  const m = /\.([^.\\/]+)$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : 'bin';
};
const stripExtension = (name) => String(name || 'Documento').replace(/\.[^.\\/]+$/, '') || 'Documento';

export function createImporter({ store, files }) {
  /** Devuelve { book, duplicate }. El mismo archivo (mismo contenido) no se importa dos veces. */
  async function importFile(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const hash = await sha256Hex(bytes);
    const id = 'bk_' + hash.slice(0, 20);

    const existing = store.getBook(id);
    if (existing) return { book: existing, duplicate: true };

    const ext = extensionOf(file.name);
    const path = files.bookPath(id, ext);
    await files.writeBookFile(path, bytes);

    const book = {
      id,
      title: stripExtension(file.name),
      author: '',
      originalName: file.name,
      path,
      format: ext.toUpperCase(),
      size: bytes.length,
      addedAt: new Date().toISOString(),
      lastBlock: 0,
      progress: 0
    };
    await store.addBook(book);
    return { book, duplicate: false };
  }

  return { importFile };
}

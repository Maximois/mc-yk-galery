// Servicio de portadas: genera la miniatura de cada libro (una sola vez), la guarda como archivo y la
// entrega a las pantallas. Estado en el libro: cover = 'ok' | 'none' (undefined = todavía no se intentó).
// 'none' no se reintenta en cada arranque: esos libros muestran la portada estática "Sin portada".
// `files` ({ readBookFile, writeBookFile, deleteBookFile, coverPath }) y `extract` se inyectan para probar sin Capacitor.
import { bytesToBase64 } from '../lib/bytes.js';

export function createCoverService({ store, files, extract, hasExtractor, loadCore }) {
  const urls = new Map(); // id -> data URL ya leída (o null)
  const listeners = new Set();
  let chain = Promise.resolve(); // una portada a la vez: pdf.js y los ZIP gastan memoria

  const notify = (id) => listeners.forEach((fn) => { try { fn(id); } catch { /* una pantalla rota no frena al resto */ } });

  async function generate(book) {
    if (!hasExtractor(book.format)) return store.updateBook(book.id, { cover: 'none' });
    let state = 'none';
    try {
      const bytes = await files.readBookFile(book.path);
      const blob = await extract(bytes, book.format, { loadCore });
      if (blob && blob.size) {
        await files.writeBookFile(files.coverPath(book.id), new Uint8Array(await blob.arrayBuffer()));
        state = 'ok';
      }
    } catch (e) { console.warn('Portada: falló para "' + book.title + '"', e); }
    urls.delete(book.id);
    await store.updateBook(book.id, { cover: state });
    notify(book.id);
  }

  return {
    /** Genera la portada si hace falta. Se encadena: llamadas seguidas se hacen de una en una. */
    ensure(book) {
      if (!book || book.cover) return Promise.resolve();
      chain = chain.then(() => generate(store.getBook(book.id) || book), () => generate(book));
      return chain;
    },
    /** Al arrancar: libros importados antes de que existieran las portadas. */
    ensureAll() { return Promise.all(store.books().filter((b) => !b.cover).map((b) => this.ensure(b))); },
    /** data URL de la miniatura o null si el libro no tiene portada. */
    async urlFor(book) {
      if (!book || book.cover !== 'ok') return null;
      if (urls.has(book.id)) return urls.get(book.id);
      let url = null;
      try { url = 'data:image/jpeg;base64,' + bytesToBase64(await files.readBookFile(files.coverPath(book.id))); } catch { /* archivo perdido: queda sin portada */ }
      urls.set(book.id, url);
      return url;
    },
    async remove(bookId) { urls.delete(bookId); await files.deleteBookFile(files.coverPath(bookId)); },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  };
}

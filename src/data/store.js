// Estado de la biblioteca (libros + anotaciones) y su persistencia.
//
// Por qué un módulo aparte: la persistencia es la decisión de arquitectura más probable de cambiar
// (Preferences -> SQLite/IndexedDB). Si el resto de la app solo habla con esta API, cambiar el
// almacenamiento es reemplazar el `storage` que se inyecta, sin tocar la interfaz ni los lectores.
//
// `storage` es cualquier objeto { get(key): Promise<string|null>, set(key, value): Promise<void> }.
// Sin dependencias de Capacitor ni del DOM: se prueba con node --test.

export const DB_VERSION = 2;
const DEFAULT_KEY = 'mc-digilibrary-db';

function emptyState() {
  return { version: DB_VERSION, books: [], interactions: [] };
}

/** Lleva cualquier versión guardada a la actual sin perder datos. */
export function migrate(raw) {
  const s = emptyState();
  if (!raw || typeof raw !== 'object') return s;
  s.books = (Array.isArray(raw.books) ? raw.books : []).map((b) => ({
    author: '',
    progress: 0,
    lastBlock: 0,
    ...b
  }));
  s.interactions = Array.isArray(raw.interactions) ? raw.interactions : [];
  return s;
}

export function createStore(storage, key = DEFAULT_KEY) {
  let state = emptyState();
  const listeners = new Set();
  let saveChain = Promise.resolve();

  const emit = () => listeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });

  async function load() {
    let text = null;
    try {
      text = await storage.get(key);
      state = migrate(text ? JSON.parse(text) : null);
    } catch (e) {
      console.error('Error cargando la biblioteca:', e);
      // Si el JSON está dañado, se guarda una copia antes de que el próximo guardado lo pise.
      if (text) { try { await storage.set(key + '-corrupto', text); } catch { /* sin más */ } }
      state = emptyState();
    }
    emit();
  }

  /** Guardados en cola: dos escrituras nunca se cruzan y siempre gana la más reciente. */
  function save() {
    const snapshot = JSON.stringify(state);
    saveChain = saveChain
      .then(() => storage.set(key, snapshot))
      .catch((e) => console.error('Error guardando la biblioteca:', e));
    return saveChain;
  }

  async function commit() {
    emit();
    await save();
  }

  return {
    load,
    flush: () => saveChain,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    // ---- libros
    books: () => state.books.slice(),
    getBook: (id) => state.books.find((b) => b.id === id) || null,
    async addBook(book) {
      state.books.push({ author: '', progress: 0, lastBlock: 0, ...book });
      await commit();
      return book;
    },
    async updateBook(id, patch) {
      const b = state.books.find((x) => x.id === id);
      if (!b) return null;
      Object.assign(b, patch);
      await commit();
      return b;
    },
    /** Quita el libro y sus anotaciones; devuelve el libro para que el llamador borre su archivo. */
    async removeBook(id) {
      const b = state.books.find((x) => x.id === id) || null;
      state.books = state.books.filter((x) => x.id !== id);
      state.interactions = state.interactions.filter((i) => i.bookId !== id);
      await commit();
      return b;
    },

    // ---- anotaciones
    interactionsOf: (bookId) => state.interactions.filter((i) => i.bookId === bookId),
    async addInteraction(item) {
      state.interactions.push(item);
      await commit();
      return item;
    },
    async removeInteraction(id) {
      state.interactions = state.interactions.filter((i) => i.id !== id);
      await commit();
    },
    statsOf(bookId) {
      const list = state.interactions.filter((i) => i.bookId === bookId);
      const notes = list.filter((i) => i.type === 'note').length;
      const highlights = list.filter((i) => i.type === 'highlight').length;
      const underlines = list.filter((i) => i.type === 'underline').length;
      return { notes, highlights, underlines, total: list.length };
    }
  };
}

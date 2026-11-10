import test from 'node:test';
import assert from 'node:assert/strict';
import { DB_VERSION, createStore, migrate } from '../src/data/store.js';

function memStorage(initial = {}) {
  const data = { ...initial };
  return { data, get: async (k) => (k in data ? data[k] : null), set: async (k, v) => { data[k] = v; } };
}

test('migrate completa campos y tolera basura', () => {
  assert.deepEqual(migrate(null), { version: DB_VERSION, books: [], interactions: [] });
  const m = migrate({ books: [{ id: 'a', title: 'T' }], interactions: 'no' });
  assert.equal(m.books[0].progress, 0);
  assert.equal(m.books[0].author, '');
  assert.deepEqual(m.interactions, []);
});

test('guarda y recarga libros y anotaciones', async () => {
  const st = memStorage();
  const a = createStore(st);
  await a.load();
  await a.addBook({ id: 'b1', title: 'Uno', format: 'TXT' });
  await a.addInteraction({ id: 'i1', bookId: 'b1', type: 'note', text: 'x' });
  await a.addInteraction({ id: 'i2', bookId: 'b1', type: 'highlight', text: 'y' });

  const b = createStore(st);
  await b.load();
  assert.equal(b.books().length, 1);
  assert.deepEqual(b.statsOf('b1'), { notes: 1, highlights: 1, total: 2 });
});

test('removeBook borra también sus anotaciones y devuelve el libro', async () => {
  const s = createStore(memStorage());
  await s.addBook({ id: 'b1', path: 'books/b1.txt' });
  await s.addBook({ id: 'b2' });
  await s.addInteraction({ id: 'i1', bookId: 'b1', type: 'note' });
  await s.addInteraction({ id: 'i2', bookId: 'b2', type: 'note' });
  const removed = await s.removeBook('b1');
  assert.equal(removed.path, 'books/b1.txt');
  assert.equal(s.interactionsOf('b1').length, 0);
  assert.equal(s.interactionsOf('b2').length, 1);
});

test('updateBook cambia campos y avisa a los suscriptores', async () => {
  const s = createStore(memStorage());
  await s.addBook({ id: 'b1' });
  let calls = 0;
  s.subscribe(() => calls++);
  const b = await s.updateBook('b1', { progress: 42, lastBlock: 7 });
  assert.equal(b.progress, 42);
  assert.equal(calls, 1);
  assert.equal(await s.updateBook('nope', {}), null);
});

test('un JSON dañado no se pierde: se respalda antes de empezar vacío', async () => {
  const st = memStorage({ 'mc-digilibrary-db': '{esto no es json' });
  const s = createStore(st);
  await s.load();
  assert.equal(s.books().length, 0);
  assert.equal(st.data['mc-digilibrary-db-corrupto'], '{esto no es json');
});

test('guardados concurrentes quedan en orden (gana el último)', async () => {
  const st = memStorage();
  const s = createStore(st);
  await Promise.all([s.addBook({ id: 'a' }), s.addBook({ id: 'b' }), s.addBook({ id: 'c' })]);
  await s.flush();
  assert.equal(JSON.parse(st.data['mc-digilibrary-db']).books.length, 3);
});

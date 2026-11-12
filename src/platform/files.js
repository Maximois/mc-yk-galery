// Archivos de los libros en el almacenamiento privado de la app (Directory.Data).
// El documento se copia aquí al importarlo, así no depende de dónde estaba el original.
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { base64ToBytes, bytesToBase64 } from '../lib/bytes.js';

// Múltiplo de 3 bytes: cada trozo codifica a base64 sin relleno ("="), así los trozos se pueden
// anexar uno tras otro y el resultado decodificado es idéntico al original.
const WRITE_CHUNK = 3 * 256 * 1024;

export function bookPath(id, format) {
  return 'books/' + id + '.' + String(format || 'bin').toLowerCase();
}

export async function writeBookFile(path, bytes) {
  try {
    let first = true;
    for (let off = 0; first || off < bytes.length; off += WRITE_CHUNK) {
      const data = bytesToBase64(bytes.subarray(off, off + WRITE_CHUNK));
      if (first) await Filesystem.writeFile({ path, data, directory: Directory.Data, recursive: true });
      else await Filesystem.appendFile({ path, data, directory: Directory.Data });
      first = false;
    }
  } catch (e) {
    await deleteBookFile(path); // no dejar un archivo a medias
    throw e;
  }
}

export async function readBookFile(path) {
  const res = await Filesystem.readFile({ path, directory: Directory.Data });
  if (typeof res.data === 'string') return base64ToBytes(res.data);
  return new Uint8Array(await res.data.arrayBuffer()); // en web devuelve un Blob
}

export async function deleteBookFile(path) {
  try {
    await Filesystem.deleteFile({ path, directory: Directory.Data });
  } catch { /* si ya no existe, mejor */ }
}

// Archivos de texto auxiliares (por ejemplo, el resultado del OCR de un libro).
export async function readTextFile(path) {
  try {
    const res = await Filesystem.readFile({ path, directory: Directory.Data, encoding: Encoding.UTF8 });
    return typeof res.data === 'string' ? res.data : await res.data.text();
  } catch { return null; } // no existe todavía
}

export async function writeTextFile(path, text) {
  await Filesystem.writeFile({ path, data: text, directory: Directory.Data, encoding: Encoding.UTF8, recursive: true });
}

export const ocrPath = (bookId) => 'ocr/' + bookId + '.json';

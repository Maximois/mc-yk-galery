// Conversión de bytes <-> base64 y hash. Todo por trozos: un `for` con `+=` carácter a carácter
// (como en la primera versión) se vuelve muy lento y gasta mucha memoria con archivos grandes.

const CHUNK = 0x8000;

export function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** SHA-256 en hexadecimal. Sirve de identificador estable del libro (mismo archivo = mismo id). */
export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Id único para anotaciones (crypto.randomUUID donde exista, con respaldo). */
export function newId(prefix) {
  const rand = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  return prefix + '_' + rand;
}

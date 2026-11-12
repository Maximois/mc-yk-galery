// Mensajes claros para los errores de pdf.js (sus mensajes originales son técnicos y en inglés).
export function friendlyPdfError(e) {
  const name = e && e.name;
  if (name === 'PasswordException') return 'El PDF está protegido con contraseña.';
  if (name === 'InvalidPDFException') return 'El archivo no es un PDF válido o está dañado.';
  if (name === 'MissingPDFException') return 'No se encontró el archivo PDF.';
  return 'No se pudo abrir el PDF' + (e && e.message ? ': ' + e.message : '.');
}

/** El usuario canceló el cuadro de contraseña: no es un fallo, la pantalla ofrece reintentar. */
export class PasswordCancelledError extends Error {
  constructor() { super('Contraseña cancelada'); this.name = 'PasswordCancelledError'; }
}

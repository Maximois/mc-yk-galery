// Mensajes claros para los errores de pdf.js (sus mensajes originales son técnicos y en inglés).
export function friendlyPdfError(e) {
  const name = e && e.name;
  if (name === 'PasswordException') return 'El PDF está protegido con contraseña (todavía no se pueden abrir).';
  if (name === 'InvalidPDFException') return 'El archivo no es un PDF válido o está dañado.';
  if (name === 'MissingPDFException') return 'No se encontró el archivo PDF.';
  return 'No se pudo abrir el PDF' + (e && e.message ? ': ' + e.message : '.');
}

// Compartir o descargar un archivo de texto (las notas exportadas).
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

/**
 * Escribe el archivo en la caché y abre el menú de compartir de Android con el archivo adjunto
 * (el usuario puede guardarlo, enviarlo por mail, etc.). Fuera de Android descarga el archivo.
 * Devuelve 'shared' | 'cancelled' | 'downloaded'.
 */
export async function shareTextFile({ filename, content, title }) {
  try {
    const can = await Share.canShare();
    if (can && can.value) {
      const written = await Filesystem.writeFile({
        path: filename,
        data: content,
        directory: Directory.Cache,
        encoding: Encoding.UTF8
      });
      await Share.share({ title, dialogTitle: title, files: [written.uri] });
      return 'shared';
    }
  } catch (e) {
    if (/cancel/i.test(String((e && e.message) || e))) return 'cancelled';
    console.error('No se pudo compartir, se descarga en su lugar:', e);
  }
  downloadText(filename, content);
  return 'downloaded';
}

function downloadText(filename, content) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

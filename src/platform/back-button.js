// Botón "atrás" de Android: vuelve una pantalla; solo sale de la app desde la biblioteca.
import { App } from '@capacitor/app';

/** `onBack()` debe devolver true si manejó el gesto (había adónde volver). */
export function installBackButton(onBack) {
  try {
    App.addListener('backButton', () => {
      if (!onBack()) App.exitApp();
    });
  } catch (e) {
    console.warn('Botón atrás no disponible fuera de Android:', e);
  }
}

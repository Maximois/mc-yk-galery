// MC Digilibrary — punto de entrada. Solo cablea módulos; la lógica vive en cada uno:
//
//   data/       estado y persistencia (store, importer)       sin DOM, se prueba con node --test
//   platform/   Capacitor: archivos, preferencias, compartir, botón atrás
//   readers/    formato -> contenido (núcleo de documentos de mcbro-refact)
//   reader/     visor, selección y anclas de anotaciones
//   notes/      exportación de anotaciones
//   ui/         una pantalla por archivo + router
//   lib/        utilidades sueltas
import { $ } from './lib/dom.js';
import { createStore } from './data/store.js';
import { createImporter } from './data/importer.js';
import { preferencesStorage } from './platform/storage.js';
import { bookPath, writeBookFile } from './platform/files.js';
import { installBackButton } from './platform/back-button.js';
import { createRouter } from './ui/router.js';
import { createLibraryView } from './ui/library-view.js';
import { createDetailsView } from './ui/details-view.js';
import { createReaderView } from './ui/reader-view.js';
import { createNotebookView } from './ui/notebook-view.js';
import { toast } from './ui/toast.js';

export const APP_VERSION = '0.2.0';

function showFatal(error) {
  console.error(error);
  const msg = (error && error.message) || String(error);
  const app = document.getElementById('app');
  if (app) {
    // Un error de arranque ya no deja una pantalla muda: se ve qué falló.
    app.insertAdjacentHTML('afterbegin',
      '<div class="fatal"><strong>MC Digilibrary no pudo iniciar</strong><br><small></small></div>');
    app.querySelector('.fatal small').textContent = msg;
  }
}

async function boot() {
  const store = createStore(preferencesStorage);
  const importer = createImporter({ store, files: { bookPath, writeBookFile } });

  // Las pantallas se crean con el router por referencia: las vistas lo usan al navegar.
  const routerRef = {
    go: (...a) => router.go(...a),
    back: () => router.back(),
    reset: (...a) => router.reset(...a)
  };

  const views = {
    library: createLibraryView({ store, importer, router: routerRef }),
    details: createDetailsView({ store, router: routerRef }),
    reader: createReaderView({ store }),
    notebook: createNotebookView({ store })
  };
  const router = createRouter({ views, headerTitle: $('title'), backButton: $('btn-back') });

  $('btn-back').addEventListener('click', () => router.back());
  installBackButton(() => router.back());

  await store.load();
  router.reset('library');
}

function start() {
  boot().catch(showFatal);
}

window.addEventListener('unhandledrejection', (ev) => toast('Error inesperado: ' + ((ev.reason && ev.reason.message) || ev.reason)));
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();

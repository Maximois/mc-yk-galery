# Plan de MC Digilibrary

## Propósito

MC Digilibrary será una biblioteca digital personal para Android: permitirá
importar documentos, organizarlos visualmente, leerlos en el dispositivo y
guardar un cuaderno de notas y resaltados asociado a cada libro.

La experiencia de lectura toma como referencia la lógica reutilizable de
MC Browser Suite / MC Doc, pero Digilibrary es un producto independiente,
enfocado en lectores y en su biblioteca local.

Este documento describe la visión y el trabajo previsto. No significa que todas
estas funciones ya estén implementadas.

## Experiencia objetivo

### Biblioteca

- Estantería adaptable en cuadrícula o lista, con tema oscuro y búsqueda rápida.
- Importación desde el selector de archivos de Android y copia del documento al
almacenamiento privado de la app para que no dependa de la ubicación original.
- Tarjeta por documento con título, formato, tamaño, progreso y contadores de
notas y resaltados.
- Portada extraída del documento cuando sea posible; si no, una portada
generada con la inicial del título y un color distintivo.
- Búsqueda por título y autor, con posibilidad de filtrar por formato.

### Ficha del libro

- Información y progreso del documento.
- Acción para comenzar o continuar desde la última posición guardada.
- Vista previa de las anotaciones recientes.
- Accesos al cuaderno completo, a la exportación y a la eliminación del libro.

### Lector y cuaderno

- Lector táctil que muestre el contenido de los formatos admitidos.
- Selección de texto para copiar, resaltar o acompañar con una nota.
- Guardado de la posición de lectura para continuar más tarde.
- Cuaderno por libro, ordenado cronológicamente, para consultar y eliminar
  anotaciones.
- Exportación o compartición de las anotaciones en `.md` o `.txt`.
- Diseño oscuro y transiciones suaves entre biblioteca, ficha y lector.

## Arquitectura objetivo propuesta

- **Capa Android nativa:** ciclo de vida, selector de documentos, almacenamiento
  privado y persistencia local.
- **Interfaz y lector:** HTML, CSS y JavaScript en una WebView adaptable a
  pantallas táctiles.
- **Procesamiento de documentos:** reutilizar y adaptar los parsers de
  MC Doc / MC Browser Suite cuando sean compatibles con Android WebView.
- **Persistencia:** base de datos local para libros e interacciones. Room sobre
  SQLite es una opción propuesta para la capa nativa; debe decidirse junto con
  la estrategia de persistencia antes de implementarla.
- **Comunicación entre lector y Android:** puente JavaScript–Android limitado a
  operaciones explícitas y validadas, si se adopta una capa nativa Kotlin.

El proyecto actual está construido con Vite y Capacitor. La propuesta Kotlin,
Room y WebView es una dirección de arquitectura por evaluar, no una descripción
de la implementación actual. Antes de migrar o añadir componentes nativos, se
debe decidir si se mantiene Capacitor o se adopta una arquitectura Android
nativa con WebView.

## Modelo de datos conceptual

### Libro

- Identificador estable, idealmente derivado de un hash del archivo.
- Título editable o extraído y autor cuando esté disponible.
- Nombre original, tipo de archivo y ruta dentro del almacenamiento privado.
- Fecha de incorporación.
- Última posición leída, posición total y progreso.
- Portada o recurso visual generado, si existe.

### Interacción

- Identificador y referencia al libro.
- Tipo: resaltado, nota o marcador.
- Texto seleccionado y comentario opcional.
- Página o posición de lectura.
- Fecha de creación y, para resaltados, color opcional.

## Flujo previsto

1. El usuario elige un documento mediante el selector del dispositivo.
2. La app copia el archivo a su almacenamiento privado y determina su formato.
3. El procesador compatible lo prepara para el lector y extrae metadatos cuando
   es posible.
4. El lector presenta el documento y comunica posición y selección de texto a la
   app.
5. La app guarda el progreso y las interacciones localmente.
6. El usuario puede volver a la ficha, consultar el cuaderno y compartir o
   exportar sus notas.

## Etapas sugeridas

1. **Definir arquitectura:** decidir Capacitor frente a Android nativo,
   persistencia, formatos prioritarios y estrategia de integración de MC Doc.
2. **Completar la biblioteca:** metadatos editables, autor, portadas de respaldo,
   filtros y gestión fiable de archivos.
3. **Implementar lectura:** integrar el primer formato prioritario y guardar y
   restaurar la posición.
4. **Añadir interacciones:** selección, resaltados, notas y marcadores
   persistentes y asociados a posiciones estables.
5. **Completar el cuaderno:** vista previa en la ficha, gestión y exportación
   `.md` / `.txt`.
6. **Pulir y validar:** tema, accesibilidad, rendimiento, manejo de errores,
   pruebas en Android 8.0 o posterior y verificación de cada formato.

## Estado actual (rama `refactor/modular`)

Probado en Chrome (viewport de celular) con un flujo completo: importar, leer, resaltar,
añadir nota, recargar y reabrir, cuaderno y exportación `.md`. **Todavía no se probó en un
dispositivo Android real ni con archivos reales grandes.**

- **Formatos con lector:** TXT, Markdown, DOCX, ODT, RTF, DOC, HTML, EPUB y PDF (núcleo de
  documentos compartido con MC Browser, copiado de `mcbro-refact`; ver
  `modules/document-editor/SOURCE.md`). Todos se muestran como texto reflowable y usan el mismo
  sistema de resaltados y notas. pdf.js y el lector de RTF/DOC solo se cargan al abrir esos formatos.
- **PDF:** se extrae el texto (no se ve la maquetación, las imágenes ni las tablas como en la
  página). Un PDF escaneado no tiene texto: se avisa, haría falta OCR. Una vista fiel de páginas
  sería un segundo visor (hay base en `mcbro-refact/core/pdf-pages.js`).
- **EPUB:** se lee el orden de lectura del paquete, se incrustan las imágenes internas y se
  descarta scripts, estilos propios, enlaces externos e imágenes remotas. Los EPUB con DRM no se abren.
- **DOC binario:** lo lee el núcleo, pero solo se probó con archivos RTF disfrazados de .doc,
  no con un .doc real de Word. Pendiente de probar con archivos tuyos.
- **Anotaciones:** se anclan al texto (posición + cita + contexto), no a ids que cambian
  entre aperturas. Si el texto cambia se reubican; si desaparece quedan como huérfanas
  (siguen en el cuaderno, sin resaltado).
- **Duplicados:** el id del libro es el hash del contenido; importar dos veces no duplica.
- **Limitaciones conocidas:** el Markdown no interpreta negrita, cursiva ni enlaces en línea
  (el núcleo no los soporta); el progreso es porcentaje de scroll, no "página";
  no hay portadas extraídas ni metadatos de autor editables.

## Estructura modular

```
src/main.js        cablea módulos (sin lógica)
src/data/          store (estado + persistencia), importer        -> sin DOM, con tests
src/platform/      Capacitor: storage, files, share, back-button  -> único código nativo
src/readers/       formato -> contenido; index.js es el registro  -> agregar un formato = 1 archivo
src/reader/        visor, anclas (puras) y selección
src/notes/         exportación .md / .txt
src/ui/            una pantalla por archivo + router
modules/document-editor/   núcleo compartido con MC Browser (no se edita aquí)
tools/sync-core.mjs        trae el núcleo actualizado desde mcbro-refact
tests/             npm test (42 pruebas, incluye jsdom, el núcleo real y pdf.js)
```

Contrato de un lector: `load(bytes, book) -> { kind:'reflow', title, css, blocks:[{html}], warnings }`.

## Decisiones tomadas

- **Capacitor se mantiene.** Todo el stack de lectura es JS; pasar a Kotlin/Room obligaría
  a un puente sin beneficio hoy. La persistencia está detrás de `store.js`: si `Preferences`
  se queda corta, se cambia el adaptador de `platform/storage.js` (SQLite o IndexedDB).
- **minSdk 24 (Android 7).** Es el mínimo por defecto de Capacitor y no se pierde ninguna
  capacidad; subirlo a 26 no aporta nada hoy.

## Decisiones pendientes

- ¿Hace falta una vista fiel de páginas para PDF (maquetación, imágenes)? Sería un segundo visor.
- ¿OCR para PDF escaneados?
- ¿Base de datos con más capacidad cuando haya muchas anotaciones?
- ¿Qué metadatos (autor, portada) se pueden extraer de forma fiable por formato?

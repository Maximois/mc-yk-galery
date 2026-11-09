# Editor de documentos (PDF, DOCX, TXT, Markdown)

Módulo independiente para abrir, editar y reexportar documentos dentro de MC
Browser. PDF y DOCX no se editan página a página: se convierten a un modelo
canónico de bloques, se edita eso y se vuelve a exportar.

## Qué abre

| Formato | Lectura | Guardado en el sitio | Exportación |
|---|---|---|---|
| PDF | texto y estructura por geometría | no (se guarda como DOCX/TXT/PDF nuevo) | PDF, DOCX, TXT, MD |
| DOCX | OOXML completo: runs, tablas, listas, imágenes, metadatos | sí | PDF, DOCX, TXT, MD |
| TXT | texto plano | sí | PDF, DOCX, TXT, MD |
| Markdown | estructura por marcas | sí | PDF, DOCX, TXT, MD |

Un PDF no se puede "guardar en el sitio" porque escribir sobre el original
destruiría el archivo sin forma de recuperar la maquetación: el editor fuerza
"Guardar como" y genera un archivo nuevo.

## Cómo se usa

El editor es una **pestaña del navegador** (`mc://doc`), no una ventana
superpuesta: la barra de direcciones, las pestañas y la barra lateral siguen
visibles y en su lugar normal.

- Botón de documento en la barra lateral izquierda, o **Ctrl+Shift+D**, abre la
  pestaña (y la enfoca si ya estaba abierta, sin duplicarla).
- **Ctrl+S** guarda, **Ctrl+O** abre, **Esc** cierra la pestaña.
- **Ctrl+Z** deshace, **Ctrl+Y** o **Ctrl+Shift+Z** rehace, y **Ctrl+F** busca/reemplaza.
- El botón `×` de la pestaña y **Ctrl+W** la cierran como cualquier otra.
- La hoja es **un solo texto continuo** (un único `contenteditable`), como Google Docs o Word:
  selección, Enter, Retroceso, Supr, arrastrar y pegar los maneja el navegador.
- La cinta superior da formato a la selección (cruce bloques o no) o a los bloques que toca.
- Retroceso/Supr junto a una imagen, salto de página o línea quita solo ese elemento.
- Deshacer incluye cambios del usuario y parches de la IA (hasta 100 pasos).
- Pestaña **Páginas** muestra el PDF original renderizado (hasta 60 páginas);
  **Contenido** muestra el texto editable.
- Si el usuario abre un `.pdf`/`.docx`/`.txt`/`.md` haciendo doble clic (o con
  "Abrir con"), el editor aparece solo en esa pestaña.

## Arquitectura

```
core/          puro, sin Electron ni DOM. Testeable con node --test.
  model.js       modelo canónico, hash, outline, texto plano, Markdown
  patch.js       parches atómicos con expectedHash
  pdf-text.js    extracción PDF por geometría de pdf.js
  docx-read.js   DOCX -> bloques
  docx-write.js  bloques -> OOXML
  zip.js         lector/escritor ZIP (métodos 0 y 8, CompressionStream)
  xml.js         parser XML tolerante a namespaces
  html.js        bloques -> HTML para preview y para printToPDF
  runs.js        formato en línea: álgebra de tramos (aplicar, partir, unir)
  dom-runs.js    lee un nodo del DOM y devuelve sus tramos (sin globals: se prueba con jsdom)
  dom-blocks.js  lee toda la hoja (DOM) y devuelve bloques; diffSurface compara con el modelo
  text-io.js     TXT/Markdown -> bloques y viceversa
main.js        dueño del archivo: lecturas, escrituras, diálogos, backups,
               recientes, sandbox y export a PDF (printToPDF)
worker.js      extracción PDF/DOCX en un worker_threads
renderer.js    pestaña mc://doc: UI, edición de bloques y render de páginas
vendor/        pdfjs-dist 3.11.174 legacy (Apache-2.0)
```

El **main** es dueño del documento. El renderer y la IA mandan los mismos
parches sobre el mismo hash: no hay dos caminos que puedan pisarse.

La pestaña se apoya en tres enganches en `src/renderer.html`: el panel
`#panel-doc` con su `#doc-host`, y dos ramas que reconhecen `mc://doc`
(`showWebview()` y `loadUrl()`), igual que `mc://newtab` y `mc://lab`.

## Cómo se prueba

```
npm test                                  # nucleo (node --test)
node tools/doc-editor-smoke.js            # main con stub de Electron
node tools/doc-editor-worker.js           # worker con archivos reales
npx electron tools/doc-editor-tab-smoke.js --pdf "C:\ruta\a\algo.pdf"
```

El último abre la UI real y el preload real dentro de Electron y comprueba que
el editor aparece como pestaña (y no como modal), que TXT/DOCX/MD se abren, que
una edición llega a main por `doc:edit`, que el PDF se pinta con pdf.js y que
`printToPDF` genera un PDF válido.

## Reglas de la IA

La IA edita con parches atómicos, nunca reescribiendo el documento:

```doc:read
```

Trae el texto y el **hash** actual. Después:

````
```doc:patch
{ "expectedHash": "<hash del doc:read>", "ops": [
  { "op": "replace", "find": "texto exacto", "replace": "texto nuevo" },
  { "op": "insert", "after": "ancla", "block": { "type": "paragraph", "text": "..." } },
  { "op": "style", "find": "texto", "bold": true, "color": "#c00000" },
  { "op": "setTitle", "title": "..." }
] }
```
````

`style` aplica formato SOLO al texto encontrado y respeta el que ya tenía el
párrafo (no lo aplana). Propiedades: `bold`, `italic`, `underline`, `strike`
(true/false; `false` quita la propiedad en ese tramo, incluso en un título que
es negrita por estilo), `color` y `highlight` (`#rrggbb`), `font` (nombre de
familia, p. ej. `"Georgia"`) y `size` (puntos).

Si el parche vuelve con error de hash obsoleto, el documento cambió: hay que
volver a `doc:read`. Si falla una operación, se descarta el parche entero.

## Formato en línea

El formato dentro de un párrafo vive en `runs` (`{ text, bold, italic,
underline, strike, color, highlight, font, size }`). Tres piezas, todas puras
y con tests:

- `core/runs.js`: álgebra de tramos (aplicar formato a un rango, partir, unir,
  alternar, compactar). La usan los parches de la IA y el renderer.
- `core/dom-runs.js`: lee un nodo del DOM y devuelve sus tramos. Interpreta el
  marcado (`b`, `i`, `u`, `s` y el `style` en línea que genera `execCommand`),
  no el estilo calculado, así que un título en negrita por CSS no se confunde
  con negrita de tramo.
- `core/model.js`: `normalizeRun` valida cada propiedad (color `#hex`, fuente
  solo letras/números/espacios) y descarta los `false` redundantes.

Mientras se escribe, **el DOM es la verdad**: el formato se aplica con
`execCommand` sobre la selección real y, al confirmar el bloque, se lee con
`dom-runs`. Antes los tramos se reproyectaban por posición y un cambio de
largo borraba TODO el formato del párrafo; Enter y Backspace tampoco lo
conservaban. Ahora Enter parte el párrafo con el formato de cada mitad y
Backspace al inicio lo une con el anterior.

Un `false` explícito significa "este tramo NO lleva esa propiedad aunque el
bloque la traiga por defecto". En DOCX se escribe `w:val="0"`.

Límites actuales: el formato en línea solo existe en párrafos, títulos y citas
(las listas y las celdas de tabla siguen siendo texto plano con formato de
bloque). La fuente `Calibri` no se guarda en los tramos porque es la que el
escritor DOCX pone por defecto.

## Tablas e imágenes

UI (barra de formato, grupo *Insertar*):
- **▦ Tabla**: selector de tamaño (hasta 8×6; el modelo admite 100 filas × 20 columnas). Se inserta tras el bloque seleccionado, o al final.
- Con una tabla seleccionada aparece la barra de objeto: `+ Fila ↑/↓`, `− Fila`, `+ Col ←/→`, `− Col`, `Encabezado`. Las filas/columnas son relativas a la **celda con foco**; lo escrito y sin confirmar se guarda antes de operar.
- **🖼 Imagen**: selector de archivo, pegar desde el portapapeles o arrastrar un archivo al documento. PNG/JPG/GIF/WebP/SVG/BMP, máx. 8 MB; se reduce para caber en el ancho de página. Con la imagen seleccionada: asa en la esquina (conserva proporción), ancho en px, atajos 25/50/75/100 % y texto alternativo.

Núcleo puro: `core/tables.js` (`create`, `addRow`, `deleteRow`, `addCol`, `deleteCol`, `setHeader`, `setCell`, `resizeImage`, `fitWidth`, `setAlt`). Devuelven bloques nuevos o `null`.

Operaciones de parche para la IA:
```json
{ "op":"table", "id":"b5", "action":"addRow|deleteRow|addCol|deleteCol", "index":1, "where":"before|after" }
{ "op":"table", "id":"b5", "action":"setHeader", "value":true }
{ "op":"table", "id":"b5", "action":"setCell", "row":0, "col":1, "text":"..." }
{ "op":"image", "id":"b8", "width":320, "alt":"descripcion" }   // el otro lado sale de la proporción
```
Notas: `header:false` ahora se guarda explícito (antes un `false` se perdía y la primera fila volvía a ser encabezado). Al guardar como DOCX y reabrir, la primera fila se vuelve a leer como encabezado: es una limitación conocida de docx-read. Se corrigió además que `core/html.js` emitía las dimensiones de imagen sin `style=""`, por lo que el tamaño no llegaba al PDF/HTML.

## Página, párrafo y enlaces

UI: **📄 Página** (orientación, papel A4/Carta/Legal/A5, márgenes normal/estrecho/ancho, encabezado, pie y número de página), **Interlineado**, sangría ⇤¶ / ¶⇥, **🔗 Enlace** (sobre el texto seleccionado; vacío = quitar; solo http, https y mailto) y **zoom** 50–200 %. La hoja del editor dibuja márgenes por lado, encabezado, pie y número.

Núcleo puro: `core/pagesetup.js` (`setOrientation`, `setPaper`, `setMargins`, `setHeaderFooter`, `apply`). Parche para la IA:
```json
{ "op":"page", "orientation":"landscape", "paper":"LETTER", "margin":"narrow" | 56, "marginTop":40,
  "header":"texto", "footer":"texto", "pageNumbers":"left|center|right|none" }
{ "op":"style", "find":"texto", "lineHeight":1.5, "indent":1, "link":"https://..." }   // link:false lo quita
```
Exportación: el DOCX escribe y lee márgenes por lado, orientación, encabezado/pie con campo PAGE, interlineado y enlaces (relaciones externas). El PDF ahora respeta el `@page` del documento (antes forzaba A4 con márgenes fijos) y pide encabezado/pie/numeración a Chromium (`core/html.js: pdfHeaderFooter`). **Verificar a mano en la app**: el PDF con encabezado y pie, porque `printToPDF` no se puede ejercitar en los tests.

Diálogos: no se usan `confirm/prompt/alert` nativos (en Electron/Windows dejaban la página sin foco al cerrarse); hay un diálogo propio (`modal`), y borrar un bloque ofrece *Deshacer* en vez de preguntar.

## Documento completo y estilos (la IA redacta)

Para redactar un documento nuevo la IA manda **un** parche: `setTitle`, `page`, `styles` e `insertBlocks`.
```json
{ "op":"insertBlocks", "index":0, "blocks":[ {"type":"heading","level":1,"text":"..."}, {"type":"paragraph","text":"..."} ] }   // hasta 500, todo o nada; también "after"/"before"
{ "op":"styles", "set":{ "heading1":{"font":"Georgia","size":20,"color":"#1a3c6e","bold":true,"align":"left"}, "paragraph":{"lineHeight":1.5} }, "clear":["quote"] }   // clear:"all" los quita
```
Estilos (`doc.styles`): `heading1-3`, `paragraph`, `quote`, `code`, cada uno con `font`, `size` (pt), `color`, `bold`, `italic`, `align`, `lineHeight`. Un bloque con una propiedad propia gana sobre el estilo. Se aplican en el editor, en el HTML/PDF (`stylesCss`) y en el DOCX (`word/styles.xml`: Normal, Heading1-3 y Quote). UI: **📌 Fijar estilo** toma el formato del bloque seleccionado y lo convierte en el estilo de su tipo (como "actualizar estilo" de Word); **Sin estilos** los quita.

Cambios de fondo que conviene conocer:
- El hash del documento ahora incluye todo el formato de los bloques, la página y los estilos; antes un parche viejo no fallaba si solo había cambiado el formato.
- El DOCX ya no escribe Calibri en cada tramo: manda el estilo del documento. El lector ignora el tamaño 11 pt de un párrafo (es el base).
- Limitación: al reabrir un DOCX, los estilos se leen como formato propio de cada bloque, no como `doc.styles`.

## Pegar con formato

Al pegar HTML (Word, Google Docs, una web) dentro de un párrafo, título o cita, `core/paste.js` lo convierte en bloques del modelo: títulos (h1-h6 → 1-3), párrafos con negrita/cursiva/subrayado/tachado/color/resaltado/fuente/tamaño/enlace, alineación, listas (HTML y las `mso-list` de Word), citas, código, tablas e imágenes `data:`. Se descartan scripts, estilos, clases, iframes y enlaces no seguros, y el "ruido" que Word escribe en cada tramo (Calibri 11, color negro). Un solo párrafo se inserta en el cursor; varios bloques se insertan después del actual (o en lugar de un párrafo vacío) con un solo *Deshacer*. Si el HTML no aporta nada más que texto, se usa el pegado de texto plano de siempre.

## Seguridad

- Solo se tocan archivos concedidos: los que el usuario eligió con un diálogo,
  los que abrió el sistema operativo con la app, o los del sandbox.
- Nada se sobrescribe sin dejar copia en `userData/doc-editor/backups/`.
- La escritura es atómica (temporal + rename).
- Las imágenes del modelo solo se aceptan como `data:`.
- Límites: 100 MB por archivo, 2000 páginas, 5000 bloques, 200 operaciones
  por parche.

## Limitaciones

- La extracción de PDF es heurística. No hay OCR: un PDF escaneado como
  imagen sale vacío, y el editor lo avisa. Las tablas en PDF no se detectan
  como tablas (salen como líneas de texto).
- No se conservan los estilos de página del PDF original: al exportar se
  reconstruye con CSS de impresión A4.
- La escritura a PDF usa `printToPDF`, así que el resultado se parece al modelo,
  no al archivo original.

## Herramientas de prueba

```
node --test test/document-editor.test.js   # núcleo, parches, DOCX, PDF
node --test test/document-inline-format.test.js     # formato en línea (tramos, DOCX, lector del DOM)
node --test test/document-editor-renderer.test.js   # renderer real en jsdom (Enter, Backspace, formato)
node tools/doc-editor-smoke.js             # main con stub de Electron
node tools/doc-editor-worker.js            # worker real de extracción
node tools/docx-smoke.js                   # round-trip DOCX
node tools/pdf-smoke.js <archivo.pdf>      # extracción PDF real
```

`doc-editor-smoke.js` intercepta `require('electron')` con un stub, así que
corre fuera de la app. La exportación a PDF necesita una ventana real y solo
se prueba a mano dentro de Electron.
## Formato dentro de listas y tablas

Los items de lista y las celdas son superficies editables como un parrafo (`.doc-cell`),
asi que negrita, cursiva, color, fuente, tamano y enlaces funcionan igual. El texto plano
(`items`, `rows`) sigue siendo la fuente de verdad; el formato vive en overlays opcionales:
`itemRuns` (arreglo alineado con `items`, `null` = sin formato) y `cellRuns`
(`{"fila,col": runs}`). Si el texto de un item/celda cambia por otra via (replace, setCell,
patch de la IA) el overlay se descarta en la normalizacion. Se conserva en HTML, PDF y DOCX
(ida y vuelta). Enter en un item inserta salto de linea; Enter en una celda crea un parrafo debajo.
Limites: el pegado de listas/tablas con formato aun entra como texto plano, y la operacion
`style` de la IA no aplica sobre items/celdas.

## Hoja de ruta (hitos)

- ☑ **Hito 1 — Formato en línea sobre la selección**: tramos (`runs.js`), lector del DOM (`dom-runs.js`), `style` del parche.
- ☑ **Hito 2 — Tablas e imágenes**: `tables.js`, ops `table`/`image`, barra contextual, redimensionar.
- ☑ **Hito 3 — Página**: papel, orientación, márgenes, encabezado/pie, numeración, interlineado, enlaces, zoom; exporta a DOCX y PDF.
- ☑ **Hito 4 — Documento completo por la IA y estilos**: `insertBlocks`, `styles`, estilos del documento.
- ☑ **Pegar con formato** desde Word/Docs/web (`paste.js`).
- ☑ **Formato dentro de listas y celdas** (`itemRuns`/`cellRuns`).
- ☐ Pendiente: pegar listas/tablas con formato dentro de items/celdas, `style` de la IA sobre items/celdas, PDF escaneados (OCR), tablas de PDF.

## Menu contextual

Clic derecho dentro del documento abre un menu propio (DOM, no nativo): cortar/copiar/pegar sin formato,
formato en linea y enlace, convertir el bloque (parrafo, titulos, cita, codigo, listas), operaciones de tabla
(si el clic es en una celda) y de imagen (ancho), mover/duplicar/eliminar bloque, insertar tabla/imagen/salto de
pagina, buscar y reemplazar, deshacer/rehacer. Escape o clic fuera lo cierra. La barra de objeto (tabla/imagen)
ahora reserva su altura para que seleccionar una tabla no desplace el contenido bajo el cursor.

### Corrector ortografico en el menu contextual

Los parrafos, titulos, items y celdas tienen `spellcheck` activo (el codigo no). Chromium solo entrega la palabra
mal escrita y sus sugerencias en el evento `context-menu` del webContents, que no se emite si la pagina cancela
`contextmenu`; por eso sobre texto el editor NO cancela el evento: avisa con `docCtxOpen` (canal `doc:ctx-open`),
`src/main/windows/context-menu.js` suprime su menu nativo mientras el aviso es reciente (`spell.js`) y reenvia
`doc:spell {word, suggestions}`. El editor agrega al tope de su menu las sugerencias (reemplazan la palabra bajo el
cursor) y "Agregar al diccionario" (`doc:spell-add`). Los idiomas son los del sistema. Si el aviso se perdiera
saldria ademas el menu nativo: es el unico punto a verificar en la app real.

## Superficie continua (rama feat/doc-continuous)

- `.doc-paper-stack` es el único `contenteditable`; cada hoja es `section.doc-paper > .doc-paper-content`
  y los bloques (`p`, `h1-3`, `ul/ol`, `blockquote`, `pre`, `table`) son hijos directos con
  `class="doc-b"`, `data-id` y `data-type`. Imagen, salto de página y línea son `contenteditable=false`.
- Escribir no repinta: tras 500 ms (`markDirty`/`flushPending`) `runSync` compara el DOM con el modelo
  (`diffSurface`) y manda parches (`deleteBlock`, `insertBlocks`, `replaceBlock`; los bloques movidos se
  detectan con la subsecuencia creciente más larga). Un `data-id` repetido o ausente es un bloque nuevo
  (Enter copia los atributos).
- Deshacer/rehacer usan el historial del modelo (`beforeinput` + Ctrl+Z/Y), no el del navegador.
- La selección es la nativa; `updateSelectedBlocks` calcula los bloques tocados para la cinta.
- Paginación: `layoutPaperPages` reparte los nodos entre hojas sin recrearlos; se repite al detectar
  desborde. Los párrafos y citas largos se parten entre hojas: el resto va en otro elemento con el mismo `data-id` y `data-cont` (`dom-blocks.js` los lee como un solo bloque; antes de repartir de nuevo, `mergeFragments` los une, y Enter/pegar/cortar los unen primero). Imágenes, tablas y listas no se parten (la hoja crece si no caben).
- Tab: sangra en listas y salta de celda en tablas.
- Tablas con celdas combinadas (`merges`) existen en el modelo, DOCX y parches; botones Combinar/Separar en la barra de tabla y en el menú contextual (selecciona celdas arrastrando).
- Pruebas: `test/document-dom-blocks.test.js` y la sección «superficie continua» de
  `test/document-editor-renderer.test.js` (jsdom). El comportamiento real del navegador se probó con
  Chromium (Playwright).

## Extras de la rama feat/doc-extras
- **Contador**: barra de estado con palabras, caracteres y, si hay selección, los de la selección (`countText` / `surfaceText` en `core/dom-blocks.js`).
- **Regla**: entre la barra de formato y la hoja. Arrastrar los márgenes (op `page`), la sangría izquierda (`indent`, pasos de 18 pt) y la de primera línea (`firstLine`, pasos de 3 pt).
- **Tablas**: ancho de columnas (`colWidths`, % que suman 100; se arrastra el borde de la celda), relleno por celda (`cellFill`) y bordes de tabla (`borders`: none | horizontal | outer). No hay bordes por celda. Acciones: `setColWidths`, `setFill`, `setBorders`.
- **Imprimir** (Ctrl+P): ventana oculta + `webContents.print` (`doc:print`). **Versiones**: copias de seguridad en `userData/doc-editor/backups`, se restauran desde el botón "Versiones" (deshacible).
- **Notas al pie y comentarios**: propiedades de tramo `note` y `comment` (texto, máx. 500). En el editor son `span[data-note]` / `span[data-comment]`; la nota se numera con contadores CSS (en la vista de una sola hoja la numeración puede saltar). HTML/PDF agregan la lista de notas al final; DOCX escribe `footnotes.xml` y `comments.xml` reales (la nota cuelga de la última palabra al leer).
- **Imágenes flotantes y recorte**: `wrap` (left | right) y `crop` ({t,r,b,l} en %). Editor y HTML usan `float` y `object-view-box`; DOCX escribe `wp:anchor` con `wrapSquare` y `a:srcRect`, y los lee de vuelta. Las imágenes de DOCX ahora conservan su tamaño (antes se perdía) y, sin alto, se respeta la proporción natural.
- Pendiente de probar en Electron real: impresión, corrector en Electron 44.

## Extras de la rama feat/doc-extras2
- **Buscar y reemplazar**: barra propia (Ctrl+F / Ctrl+H) con resaltado de coincidencias (CSS Custom Highlight), mayúsculas, palabra completa, anterior/siguiente y reemplazo uno/todo. Reemplaza editando el texto en su sitio (conserva el formato y entra al historial).
- **Encabezado y pie**: `{n}` y `{total}` (pantalla, PDF y campos PAGE/NUMPAGES de DOCX).
- **Tabla de contenido viva**: bloque `toc` (`levels` 1-3). En el editor se arma sola con los títulos y su hoja; HTML con enlaces; DOCX con campo TOC (las entradas salen sin número hasta que Word actualiza el campo).
- **PENDIENTE / NO FUNCIONA (2026-10-18)**: el índice largo no se reparte bien entre hojas. Con muchos títulos (índice de 130 renglones) la hoja se estiraba para meter todo en un solo lugar; se intentó cortarlo por renglones (`splitTocToFit`, con los trozos `data-cont` como los párrafos) y el índice salió DUPLICADO y descolocado ("1-2", "-1", "2-3"). Corregir el borrado de los trozos no lo resolvió. Queda el código y el comentario en el renderer como registro. Al retomar: reproducir con N renglones en jsdom con medidas reales y seguir `refreshToc -> relayout -> splitTocToFit`.
- **Listas de varios niveles**: `itemLevels` (0-2, un nivel más que el anterior como máximo). Tab / Mayús+Tab por ítem; numeración 1. / a. / i.; HTML anidado; DOCX con `ilvl` por ítem.
- **Panel de notas y comentarios** (botón «Panel»): lista, salta al texto, edita y resuelve.
- **Espaciado**: `spaceBefore` / `spaceAfter` (pt) en títulos, párrafos, citas y listas.
- **Tablas (feat/doc-extras3)**: bordes por celda (`cellBorders`, clave `"fila,col"`, lados visibles `t r b l` o `none`; acciones `setCellBorders` y selector «Bordes de celda…») y ordenar filas por la columna actual (`sortRows`, numérico o texto, deja el encabezado; no admite celdas combinadas). Un borde compartido con una celda vecina se dibuja si cualquiera de las dos lo tiene: para ocultarlo hay que aplicarlo a ambas.

### Extras de la rama feat/doc-extras4
- Autoformato al escribir: `# `/`## `/`### ` titulo, `- `/`* ` vinetas, `1. ` numerada, `> ` cita, `**negrita**`, `*cursiva*`, `---` + Enter separador. Ctrl+Z lo deshace.
- Pegar una URL sobre texto elegido la convierte en enlace; sin selección inserta el enlace.
- Indicador "Copia automática hh:mm" junto al título (autoguardado de trabajo).
- Versiones → "Comparar con el documento actual": diff por bloques (agregados/quitados/modificados) con `core/diff.js`.
- Documento nuevo: plantillas (en blanco, carta, informe con portada e índice, currículum).
- Cuadros de aviso (callout): selector «Aviso» en el formato de párrafo (info/atención/correcto/error); HTML, DOCX (borde+sombreado) y lectura.

### Extras de la rama feat/doc-extras6
- Configurar página: marca de agua (texto), «Empezar a numerar en» y primera página sin encabezado/pie. Editor, impresión HTML (marca de agua) y DOCX (VML, `pgNumType`, `titlePg`) con lectura de vuelta. El PDF y la impresión usan cajas de margen de `@page` (`html.pageMarginCss`), así que también respetan el número inicial y la primera página sin encabezado/pie.
- Paleta «Ω Símbolos» (matemática, griegas, flechas, otros).
- Rótulos numerados «Figura n» / «Tabla n» (selector «Rótulo»): numeración automática con contadores CSS en editor y HTML; DOCX con estilo Caption y campo SEQ.
- Modo enfoque (botón «Enfoque»): oculta barras, atenúa los bloques que no se están escribiendo; Esc sale.

### Extras de la rama feat/doc-extras7
- Control de cambios: botón «Cambios» (lo escrito se marca en verde, lo borrado queda tachado en rojo) y «Aceptar» / «Rechazar» sobre la selección o todo el documento. Propiedades de tramo `ins` / `del` ("autor|fecha"); DOCX con `w:ins` / `w:del` (lectura y escritura), HTML con `.doc-ins` / `.doc-del`. Límite: borrar a través de varios bloques no se registra (se borra de verdad).

### Extras de la rama feat/doc-extras8
- Comentarios con autor y fecha y respuestas (botón «Responder» en el panel de notas). Se guardan como hilo `[Autor|fecha] texto ‖ [Autor|fecha] respuesta`; el DOCX conserva autor y fecha del primer comentario y el hilo en su texto.

### Extras de la rama feat/doc-extras9
- Referencias cruzadas: botón «↪ Referencia» (enlace interno `#marcador` a un título; Ctrl+clic para ir). Marcadores = título sin tildes (`model.headingSlugs`). HTML con `<a id>`, DOCX con `w:bookmarkStart` y `w:hyperlink w:anchor` (ida y vuelta). Si se renombra el título, el enlace deja de apuntar.

### Extras de la rama feat/doc-extras10
- Índice de figuras / de tablas (botón «☰ Figuras»): bloque `toc` con `kind` ('figure'|'table'); se arma solo con los rótulos y la hoja de cada uno. En DOCX sale como campo `TOC \c "Figura"|"Tabla"` (con las entradas ya escritas), y se lee de vuelta.

### Extras de la rama feat/doc-extras11
- Asistente de texto («✨ IA»): mejorar, acortar, formalizar, corregir, resumir o traducir la selección con el proveedor de IA ya configurado (`aiChat`). Solo se envía el texto elegido (máx. 6000 caracteres, un solo párrafo), se muestra la propuesta editable y recién al aceptar reemplaza; se deshace con Ctrl+Z. El resultado es texto plano (la selección pierde su formato en línea).

### Extras de la rama feat/doc-extras12
- Sinónimos: en «✨ IA» → «Sinónimos de la palabra / frase» (hasta 8 alternativas según el contexto, se elige una y reemplaza). Usa el proveedor de IA configurado; no hay diccionario sin conexión.

### Extras de la rama feat/doc-thesaurus
- Tesauro de sinónimos sin conexión: «Sinónimos…» en el menú contextual o Mayús+F7 (con el cursor en una palabra o con la palabra elegida). Datos: OpenThesaurus-es de LibreOffice (LGPL 2.1, ~2,9 MB, `vendor/thesaurus/`, con su licencia y README). Busca formas base (plural, género, verbos comunes y sin tildes), agrupa por sentido, respeta mayúsculas. Si no hay resultado locales, cae a la IA («Sinónimos con IA» también está en «✨ IA»).

### Extras de la rama feat/doc-styles
- «Mis estilos»: guarda el formato de un bloque (tamaño, color, negrita/cursiva/subrayado, alineación, sangría, interlineado, espaciado) con un nombre y lo aplica a otros bloques (también varios seleccionados). Se guardan en el navegador (`localStorage`, máx. 20) y valen para todos los documentos; al aplicar se copia el formato al bloque, así que no cambian si luego editas el estilo.

### Extras de la rama feat/doc-merge
- Combinar correspondencia («Combinar»): el documento es la plantilla con campos `{{columna}}`; se elige un CSV (coma, punto y coma o tabulador, máx. 500 filas) y se genera una copia por fila separadas por salto de página (`core/merge.js`). Reemplaza el contenido; Ctrl+Z recupera la plantilla. Los campos sin columna quedan tal cual.

### Extras de la rama feat/doc-pdf
- PDF e impresión: encabezado, pie, `{n}`/`{total}`, número inicial y primera página distinta con cajas de margen `@page` (reemplazan a las plantillas de `printToPDF`). Verificado con Chromium 141; necesita comprobarse en el Electron de la app.

### Extras de la rama feat/doc-epub
- Exportar a EPUB 3 («Guardar como» → EPUB): un capítulo por título de nivel 1 (más un primer capítulo si hay texto antes), índice (`nav.xhtml` + `toc.ncx`), imágenes como archivos, enlaces internos entre capítulos, notas al pie al final del último capítulo (`core/epub.js`). Solo exportación (no se abre ni se guarda en el sitio).

## Lectura en voz alta (feat/doc-read)

- Botón **🔊 Leer** en la barra: lee la selección o, sin selección, desde el bloque del cursor hasta el final (títulos, párrafos, citas, listas y tablas; omite índice, imágenes, código y saltos).
- Usa `speechSynthesis` (voces del sistema). Un modal permite elegir velocidad y voz (prefiere voces `es`); se recuerda en `localStorage`.
- El bloque que suena se resalta (`data-reading`) y se desplaza a la vista. Otro clic en el botón detiene la lectura.
- Pendiente: verificar en Electron real qué voces ofrece cada sistema.

## Cuadros de texto y formas flotantes (feat/doc-shapes)

- Botón **▭ Cuadro**: convierte el párrafo seleccionado en un cuadro con forma (rectángulo, redondeado, elipse), ancho (% de página), posición (izquierda/derecha con el texto alrededor, o centrado), relleno y borde. "Quitar cuadro" lo revierte.
- Modelo: propiedad `box` en párrafos/citas. HTML/PDF/editor: `float` + borde/relleno (`html.boxCss`).
- DOCX: `w:framePr` (marco de texto) con bordes y sombreado; se vuelve a leer como cuadro. La elipse se guarda como rectángulo en Word (límite de los marcos).
- Límites: el cuadro contiene un solo párrafo (no bloques anidados); no se arrastra con el ratón; ODT/EPUB lo muestran como párrafo normal.
- Pendiente: verificar en Word/Electron real cómo ubica el marco.

## Notas finales y bibliografía (feat/doc-biblio)

- **Notas al final**: en Configurar página, "Notas → Al final del documento" (`page.endnotes`). DOCX usa `endnotes.xml`/`endnoteReference` y se vuelve a leer; HTML/PDF muestran la lista bajo el título «Notas».
- **📚 Cita**: formulario (estilo, autores `Apellido, Nombre; …`, año, título, editorial, lugar, URL). Inserta la cita en el cursor y añade la entrada bajo el título «Referencias»/«Bibliografía» (se crea al final si no existe). APA 7: `(Autor, año)`, lista alfabética con título en cursiva. ISO 690 numérico: `[n]`, lista numerada. Una fuente idéntica reutiliza su entrada.
- **↻ Referencias**: reordena (APA) o renumera (ISO) la lista; al borrar una fuente ISO hay que renumerar a mano las citas `[n]` del texto.
- Módulo puro `core/biblio.js`. Las fuentes se guardan como texto en la lista (sin registro oculto), así que sobreviven a DOCX/PDF.
- Límites: sin sangría francesa en APA; solo libros/recursos web genéricos (sin artículos de revista con volumen/páginas).

## Columnas de texto (feat/doc-columns)

- Configurar página → **Columnas** (1, 2 o 3), propiedad `page.columns` (también por el op `page` de la IA).
- Se aplica a **PDF, vista previa/HTML y DOCX** (`w:cols`, se vuelve a leer). Los títulos de nivel 1 abarcan todas las columnas; tablas, imágenes, citas y código no se parten entre columnas.
- **En el editor se sigue viendo una sola columna**: la edición continua con paginación por fragmentos no admite columnas reales sin riesgo de romperla. Por eso es una propiedad del documento entero (sin secciones con columnas distintas).

## Exportar a ODT (feat/doc-export)

- **Guardar como → OpenDocument (ODT)**: `core/odt-write.js` genera content/styles/meta/manifest. Soporta títulos, párrafos con negrita/cursiva/subrayado/tachado/color/resaltado/fuente/tamaño, enlaces, listas anidadas, citas, código, tablas (combinadas y con relleno), imágenes incrustadas, notas al pie, saltos de página, tamaño/márgenes/columnas, encabezado y pie (texto sin campos de número).
- Verificado abriendo y convirtiendo con LibreOffice (texto, listas anidadas, nota al pie, tabla, 2 páginas). Markdown ya se podía guardar (`.md`).
- Límites: no exporta cuadros flotantes, marca de agua ni cambios con control de cambios; el lector ODT propio no recupera el formato en línea al reabrir.

## Sangría francesa (feat/doc-hanging)

- Botón **⇤ Francesa**: alterna la sangría francesa (36 pt) en el párrafo seleccionado (propiedad `hanging`; sustituye a la sangría de primera línea).
- Las entradas APA que crea **📚 Cita** ya la llevan.
- HTML/PDF: `margin-left` + `text-indent` negativo. DOCX: `w:ind w:left/w:hanging` (se vuelve a leer). ODT: `fo:text-indent` negativo.

## Rendimiento del reparto de hojas (feat/doc-perf)

- Medición (Chromium, 4500 bloques ≈ 540 hojas, modo continuo): al desbordarse una hoja se rehace el reparto completo; costaba ~4-5 s por reparto y crecía más que lineal porque cada párrafo se medía con todas las hojas montadas.
- Ahora `layoutPaperPages` arma y mide cada hoja en un contenedor auxiliar oculto y la pasa a la pila al terminarla. Mismo resultado (mismas hojas y numeración; 180 hojas para 1500 bloques en ambos casos); el tiempo de medición baja ~60 % (3,8 s → 1,6 s en el perfil). Escribir en un documento de ~180 hojas ya era fluido (~55 ms/tecla).
- Sigue siendo O(n) por reparto: el reparto incremental (parar al estabilizarse un salto de hoja) queda pendiente por riesgo con fragmentos `data-cont`. Más de 20 hojas ya se muestran de a una por defecto.

## Accesibilidad (feat/doc-a11y)

- **♿ Accesibilidad**: revisa el documento (`core/a11y.js`) y lista avisos: imágenes sin texto alternativo (importante), saltos de nivel de título, títulos vacíos, tablas sin fila de encabezado, enlaces poco descriptivos («aquí», URL suelta) y texto con contraste < 4,5:1 (WCAG AA, color de texto/resaltado contra blanco). Elegir un aviso lleva al bloque.
- Semántica: barras con `role="toolbar"` y nombre, botones solo-icono con `aria-label` tomado de su título, `aria-pressed` en los botones que se encienden, avisos (`toast`) como región `status`/`aria-live`, diálogos con `aria-labelledby` y foco atrapado (Tab/Mayús+Tab), superficie con nombre «Contenido del documento».
- Teclado: **Alt+F10** entra a la barra; flechas, Inicio y Fin se mueven entre botones; **Esc** vuelve al documento (antes cerraba todo el editor desde una barra).
- Límites: el color del tema oscuro y el fondo de celdas no entran en el cálculo de contraste; no se probó con un lector de pantalla real (NVDA/VoiceOver).

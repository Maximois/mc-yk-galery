// Contenido "reflowable": un documento convertido a bloques de HTML que se adaptan al ancho de
// pantalla (TXT, Markdown, DOCX, ODT...). Es el formato común entre los lectores y el visor.
//
// Contrato de los lectores (src/readers/*.js):  load(bytes, book) -> ReflowContent
//   ReflowContent = { kind: 'reflow', title, css, blocks: [{ html }], warnings: [] }
// El visor (src/reader/reflow-viewer.js) solo conoce este contrato: agregar un formato nuevo
// que se pueda convertir a bloques no toca ni el visor ni las anotaciones.

/** `core` es window.MCDoc; `doc` es el modelo canónico de bloques del núcleo. */
export function docToReflow(core, doc, warnings = []) {
  // blockHtmlList devuelve un HTML por bloque, en el mismo orden que doc.blocks:
  // el índice del bloque es la base de las anclas de las anotaciones.
  const list = core.html.blockHtmlList(doc);
  return {
    kind: 'reflow',
    title: doc.title || '',
    css: core.html.stylesheet(doc),
    blocks: list.map((item) => ({ html: item.html || '' })),
    warnings: warnings || []
  };
}

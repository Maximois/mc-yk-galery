/**
 * core/pdf-annotate.js — escribe anotaciones sobre un PDF existente (copia nueva).
 *
 * Por qué: el PDF solo se podía ver; no había forma de marcarlo y guardar las marcas.
 * Qué: toma los bytes originales y una lista de anotaciones y devuelve un PDF nuevo:
 *   - highlight: anotación PDF real /Highlight (la ven y editan Acrobat, Edge, pdf.js…).
 *   - text: texto estampado en la página (Helvetica, solo caracteres Latin-1).
 *   - ink: trazo a mano alzada estampado en la página.
 *   Las coordenadas son fracciones de la página (0..1, origen arriba a la izquierda),
 *   así no dependen del zoom con el que se dibujó.
 * Cómo se verifica: test/document-pdf-annotate.test.js.
 * Qué no se toca: el PDF original (siempre se devuelve una copia), páginas rotadas
 *   (se rechazan con aviso) ni PDF cifrados (error claro).
 *
 * pdf-lib se recibe por parámetro (opts.PDFLib) como pdf.js en pdf-text.js.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (typeof window !== 'undefined') { window.MCDoc = window.MCDoc || {}; window.MCDoc.pdfAnnotate = mod; }
})(this, function () {
  'use strict';

  const HEX = /^#[0-9a-f]{6}$/i;
  const rgbOf = (hex, fallback) => {
    const h = HEX.test(String(hex || '')) ? hex : fallback;
    return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  };
  const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));
  // Helvetica estándar solo codifica WinAnsi; lo demás se cambia por "?" en vez de romper el guardado.
  const latin1 = (s) => String(s).replace(/[\r\n]+/g, ' ').replace(/[^\x20-\x7e¡-ÿ]/g, '?');

  /**
   * annots: [{ page, type:'highlight', color?, rects:[{x,y,w,h}] }
   *          { page, type:'text', x, y, text, size?, color? }
   *          { page, type:'ink', color?, width?, points:[{x,y}] }]
   * Devuelve { bytes, applied, warnings }.
   */
  async function annotatePdf(bytes, annots, opts) {
    const PDFLib = opts && opts.PDFLib;
    if (!PDFLib) throw new Error('pdf-annotate: falta pdf-lib (opts.PDFLib)');
    const { PDFDocument, PDFName, PDFString, StandardFonts, rgb } = PDFLib;
    let pdf;
    try { pdf = await PDFDocument.load(bytes, { updateMetadata: false }); }
    catch (e) {
      if (/encrypted/i.test(e && e.message)) throw new Error('El PDF está protegido con contraseña: no se puede anotar.');
      throw e;
    }
    const pages = pdf.getPages();
    const warnings = [];
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    let applied = 0;
    let rotated = 0;

    for (const a of Array.isArray(annots) ? annots : []) {
      const page = pages[(Number(a && a.page) || 0) - 1];
      if (!page) continue;
      if (page.getRotation().angle % 360 !== 0) { rotated++; continue; }
      const { x: ox, y: oy, width: W, height: H } = page.getCropBox ? page.getCropBox() : page.getMediaBox();
      const px = (fx) => ox + clamp01(fx) * W;
      const py = (fy) => oy + (1 - clamp01(fy)) * H;

      if (a.type === 'highlight') {
        const rects = (a.rects || []).filter((r) => r && r.w > 0 && r.h > 0);
        if (!rects.length) continue;
        const quads = [];
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const r of rects) {
          const x1 = px(r.x), x2 = px(r.x + r.w), yT = py(r.y), yB = py(r.y + r.h);
          quads.push(x1, yT, x2, yT, x1, yB, x2, yB);
          minX = Math.min(minX, x1); maxX = Math.max(maxX, x2); minY = Math.min(minY, yB); maxY = Math.max(maxY, yT);
        }
        const dict = pdf.context.obj({
          Type: 'Annot', Subtype: 'Highlight', F: 4,
          Rect: [minX, minY, maxX, maxY], QuadPoints: quads,
          C: rgbOf(a.color, '#ffeb3b'), CA: 0.4,
          T: PDFString.of('MC-DOC-PRO'),
          Contents: PDFString.of(latin1(a.note || ''))
        });
        const ref = pdf.context.register(dict);
        const existing = page.node.lookup(PDFName.of('Annots'));
        if (existing && existing.push) existing.push(ref);
        else page.node.set(PDFName.of('Annots'), pdf.context.obj([ref]));
        applied++;
      } else if (a.type === 'text') {
        const text = latin1(a.text || '').trim();
        if (!text) continue;
        const size = Math.max(6, Math.min(72, Number(a.size) || 12));
        const [r, g, b] = rgbOf(a.color, '#d32f2f');
        page.drawText(text, { x: px(a.x), y: py(a.y) - size, size, font, color: rgb(r, g, b) });
        applied++;
      } else if (a.type === 'ink') {
        const pts = (a.points || []).filter((p) => p && isFinite(p.x) && isFinite(p.y));
        if (pts.length < 2) continue;
        const [r, g, b] = rgbOf(a.color, '#d32f2f');
        const thickness = Math.max(0.5, Math.min(12, Number(a.width) || 2));
        for (let i = 1; i < pts.length; i++) {
          page.drawLine({ start: { x: px(pts[i - 1].x), y: py(pts[i - 1].y) }, end: { x: px(pts[i].x), y: py(pts[i].y) }, thickness, color: rgb(r, g, b), lineCap: 1 });
        }
        applied++;
      }
    }
    if (rotated) warnings.push(rotated + ' anotación(es) en páginas rotadas se omitieron (aún no se soportan).');
    const out = await pdf.save({ useObjectStreams: false });
    return { bytes: out, applied, warnings };
  }

  return { annotatePdf };
});

'use strict';
/**
 * document-editor / core/docx-patch.js — guardar un .docx SIN perder lo que el modelo del editor no representa.
 *
 * El lector (docx-read) anota de qué hijos de <w:body> sale cada bloque (srcMap). Al guardar se parte del
 * paquete original y solo se reescribe lo que se editó:
 *   · Bloque sin cambios (misma huella)  → su XML original, byte a byte (campos, estilos con nombre, resaltado,
 *     columnas por sección, cuadros de texto, marcadores, saltos de sección, …).
 *   · Bloque editado o nuevo             → se genera con el escritor y se inyecta (con sus relaciones: enlaces,
 *     imágenes, notas, comentarios, numeración y estilos que falten, agregados al original).
 *   · Bloque borrado                     → se quita solo su rango.
 *   · Hijos que el lector no convirtió en bloque (marcadores, párrafos que solo llevan un salto de sección…) → se conservan.
 *   · Encabezados, pies, temas, estilos, numeración, comentarios, propiedades, fuentes → intactos, salvo que se hayan cambiado.
 * Solo Node/main.
 */
(function (root, factory) {
  const deps = typeof require === 'function' && typeof module === 'object'
    ? { W: require('./docx-write'), R: require('./docx-read'), zip: require('./zip'), xml: require('./xml') }
    : { W: root.MCDoc.docxWrite, R: root.MCDoc.docxRead, zip: root.MCDoc.zip, xml: root.MCDoc.xml };
  const mod = factory(deps);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.MCDoc.docxPatch = mod;
})(typeof self !== 'undefined' ? self : this, function ({ W, R, zip, xml }) {
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
  const CT = {
    numbering: 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml',
    footnotes: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml',
    endnotes: 'application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml',
    comments: 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml',
    header: 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml',
    footer: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml'
  };
  const enc = new TextEncoder();
  const X = xml.escapeXml;

  function h32(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h.toString(36); }
  /** Huella del contenido de un bloque (sin id): si no cambia, se conserva el XML original. */
  function blockSig(b) { return h32(JSON.stringify(b, (k, v) => (k === 'id' ? undefined : v))); }
  /** Datos que main guarda al abrir: paquete + mapa id→{a,b,h}. */
  function makeSource(entries, read, blocks) {
    const map = Object.create(null);
    for (const b of blocks) { const r = read.srcMap && read.srcMap[b.id]; if (r) map[b.id] = { a: r.a, b: r.b, h: blockSig(b) }; }
    return { entries, map, childCount: read.childCount, pageSrc: read.pageSrc || null };
  }

  const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(\/?)(?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  /** Posición exacta de cada hijo de primer nivel de <w:body>. */
  function scanBody(str) {
    TOKEN.lastIndex = 0; let m; let state = 0; let depth = 0; let cur = null; let idx = -1; let openEnd = -1;
    const children = [];
    while ((m = TOKEN.exec(str))) {
      if (m[2] === undefined) continue;
      const close = m[1] === '/', local = m[2], self = m[4] === '/';
      if (state === 0) { if (!close && !self && local === 'body') { state = 1; openEnd = TOKEN.lastIndex; } continue; }
      if (close) {
        if (depth === 0) return { openEnd, closeStart: m.index, children };
        depth--; if (depth === 0 && cur) { cur.end = TOKEN.lastIndex; cur = null; }
      } else if (self) {
        if (depth === 0) children.push({ i: ++idx, local, start: m.index, end: TOKEN.lastIndex });
      } else {
        if (depth === 0) { cur = { i: ++idx, local, start: m.index, end: -1 }; children.push(cur); }
        depth++;
      }
    }
    return null;
  }

  function makePackage(entries) {
    const files = new Map(); const order = [];
    for (const [k, v] of Object.entries(entries)) { files.set(k, v); order.push(k); }
    return {
      has: (n) => files.has(n),
      text: (n) => (files.has(n) ? zip.toStr(files.get(n)) : null),
      set: (n, data) => { if (!files.has(n)) order.push(n); files.set(n, typeof data === 'string' ? enc.encode(data) : data); },
      get: (n) => files.get(n),
      names: () => order.filter((n) => files.has(n))
    };
  }
  const relList = (str) => { const out = []; if (!str) return out; const re = /<Relationship\b([^>]*?)\/?>/g; let m; while ((m = re.exec(str))) { const g = (k) => { const x = new RegExp('\\b' + k + '="([^"]*)"').exec(m[1]); return x ? x[1] : ''; }; out.push({ id: g('Id'), type: g('Type'), target: g('Target') }); } return out; };
  const tw = (pt) => Math.round(pt * 20);

  async function patchDocx(doc, src) {
    const warnings = []; const pkg = makePackage(src.entries);
    const docXml = pkg.text('word/document.xml'); if (!docXml) throw new Error('El paquete original no tiene word/document.xml');
    const sc = scanBody(docXml); if (!sc) throw new Error('No pude ubicar el cuerpo del documento original');
    let ct = pkg.text('[Content_Types].xml') || '';
    let relsXml = pkg.text('word/_rels/document.xml.rels') || `${W.XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
    const addOverride = (part, type) => { if (!ct.includes(`PartName="${part}"`)) ct = ct.replace('</Types>', `<Override PartName="${part}" ContentType="${type}"/></Types>`); };
    const ensureDefault = (ext, type) => { if (!new RegExp(`<Default\\b[^>]*Extension="${ext}"`, 'i').test(ct)) ct = ct.replace(/(<Types\b[^>]*>)/, `$1<Default Extension="${ext}" ContentType="${type}"/>`); };
    let relSeq = 0;
    const addRel = (type, target, external) => {
      const used = new Set(relList(relsXml).map((r) => r.id)); let id; do { id = 'rIdMc' + (++relSeq); } while (used.has(id));
      relsXml = relsXml.replace('</Relationships>', `<Relationship Id="${id}" Type="${REL}${type}" Target="${X(target)}"${external ? ' TargetMode="External"' : ''}/></Relationships>`);
      return id;
    };

    // ── 1. Qué grupos de hijos del original siguen, cambiaron o se borraron ──
    const map = src.map || {}; const kids = sc.children;
    const last = kids[kids.length - 1]; const finalSect = last && last.local === 'sectPr' ? last : null;
    const contentKids = finalSect ? kids.slice(0, -1) : kids;
    const keyOf = (id) => { const m = map[id]; return m ? m.a + '-' + m.b : null; };
    const groupIds = new Map(); const mapped = new Uint8Array(kids.length);
    for (const [id, m] of Object.entries(map)) { const k = m.a + '-' + m.b; if (!groupIds.has(k)) groupIds.set(k, []); groupIds.get(k).push(id); for (let i = m.a; i <= m.b && i < mapped.length; i++) mapped[i] = 1; }
    const seen = new Set(); const cur = new Map(); const order = [];
    for (const b of doc.blocks || []) {
      const k = !seen.has(b.id) ? keyOf(b.id) : null; seen.add(b.id);
      if (k) { if (!cur.has(k)) cur.set(k, []); cur.get(k).push(b); order.push({ k, b }); } else order.push({ k: null, b });
    }
    const unchanged = (k) => { const now = cur.get(k); const was = groupIds.get(k); return now.length === was.length && now.every((b) => map[b.id] && blockSig(b) === map[b.id].h); };

    // ── 2. Generar lo editado/nuevo con el escritor ──
    const ctx = W.makeCtx(doc); const gen = [];          // XML de cada grupo regenerado, en orden
    const piece = (b) => W.emitBlock(b, ctx, warnings) || '';
    const emitted = new Uint8Array(kids.length); const pieces = []; const used = new Set();
    const flushUnmapped = (upTo) => { for (let i = 0; i < upTo && i < contentKids.length; i++) if (!mapped[i] && !emitted[i]) { emitted[i] = 1; pieces.push(docXml.slice(contentKids[i].start, contentKids[i].end)); } };
    let reach = 0;
    for (const { k, b } of order) {
      if (!k) { const x = piece(b); if (x) { pieces.push(x); gen.push(x); } continue; }
      if (used.has(k)) continue; used.add(k);
      const [a, bb] = k.split('-').map(Number);
      if (a >= reach) { flushUnmapped(a); reach = a; }
      if (unchanged(k)) { for (let i = a; i <= bb; i++) emitted[i] = 1; pieces.push(docXml.slice(contentKids[a].start, contentKids[bb].end)); }
      else { for (let i = a; i <= bb; i++) emitted[i] = 1; const x = cur.get(k).map(piece).join(''); pieces.push(x); gen.push(x); }
      reach = Math.max(reach, bb + 1);
    }
    flushUnmapped(contentKids.length);
    let body = pieces.join(''); const generated = gen.join('');

    // ── 3. Lo que el XML generado necesita del paquete ──
    if (generated) {
      // enlaces e imágenes: rIds propios
      const linkMap = {}; for (const l of ctx.links) linkMap[l.rid] = addRel('hyperlink', l.url, true);
      const imgMap = {};
      for (const m of ctx.media) {
        let name; let n = 0; do { name = `word/media/mc${++n}.${m.ext}`; } while (pkg.has(name));
        pkg.set(name, m.bytes); ensureDefault(m.ext, ctx.mediaByExt[m.ext] || 'image/' + m.ext); imgMap[m.rid] = addRel('image', name.replace(/^word\//, ''), false);
      }
      const fix = (s) => s.replace(/r:id="(rIdLink\d+)"/g, (a, id) => `r:id="${linkMap[id] || id}"`).replace(/r:embed="(rIdImg\d+)"/g, (a, id) => `r:embed="${imgMap[id] || id}"`);
      // numeración: se reutilizan las listas del original (viñeta / ordenada)
      let numIds = null;
      if (/<w:numId w:val="[12]"\/>/.test(generated)) numIds = ensureNumbering();
      // estilos que el original no tenga
      const need = new Set(); for (const m of generated.matchAll(/<w:(?:pStyle|rStyle|tblStyle) w:val="([^"]+)"/g)) need.add(m[1]);
      if (need.size) ensureStyles(need);
      // notas y comentarios: se suman a los archivos del original
      let noteOff = 0; let commentOff = 0; const K = ctx.endnotes ? 'endnote' : 'footnote';
      if (ctx.notes.length) noteOff = appendNotes(K);
      if (ctx.comments.length) commentOff = appendComments();
      const remap = (s) => {
        let o = fix(s);
        if (numIds) o = o.replace(/<w:numId w:val="([12])"\/>/g, (a, n) => `<w:numId w:val="${numIds[n]}"/>`);
        if (noteOff) o = o.replace(new RegExp(`<w:${K}Reference w:id="(\\d+)"/>`, 'g'), (a, n) => `<w:${K}Reference w:id="${+n + noteOff}"/>`);
        if (commentOff) o = o.replace(/<w:(commentRangeStart|commentRangeEnd|commentReference) w:id="(\d+)"\/>/g, (a, t, n) => `<w:${t} w:id="${+n + commentOff}"/>`);
        return o;
      };
      for (let i = 0; i < pieces.length; i++) if (gen.includes(pieces[i])) pieces[i] = remap(pieces[i]);
      body = pieces.join('');
    }
    function ensureNumbering() {
      const part = 'word/numbering.xml'; const fmts = R.numberingFormats(Object.fromEntries(pkg.names().map((n) => [n, pkg.get(n)])));
      const findId = (bullet) => Object.keys(fmts).find((id) => (bullet ? /bullet/i.test(fmts[id]) : fmts[id] && !/bullet|none/i.test(fmts[id])));
      const out = { 1: findId(true), 2: findId(false) };
      if (out[1] && out[2]) return out;
      const ours = W.numbering(); const absRe = /<w:abstractNum\b[\s\S]*?<\/w:abstractNum>/g; const abs = ours.match(absRe) || [];
      let add = ''; let nums = '';
      [1, 2].forEach((n) => { if (out[n]) return; const a = abs[n - 1]; if (!a) return; const nid = 9000 + n;
        add += a.replace(/w:abstractNumId="\d+"/, `w:abstractNumId="${nid}"`); nums += `<w:num w:numId="${nid}"><w:abstractNumId w:val="${nid}"/></w:num>`; out[n] = String(nid); });
      if (pkg.has(part)) {
        let t = pkg.text(part); t = /<w:num\b/.test(t) ? t.replace(/<w:num\b/, (m0) => add + m0) : t.replace('</w:numbering>', add + '</w:numbering>'); t = t.replace('</w:numbering>', nums + '</w:numbering>'); pkg.set(part, t);
      } else {
        pkg.set(part, ours.replace(/<w:abstractNum\b[\s\S]*<\/w:abstractNum>/, add).replace(/<w:num\b[\s\S]*<\/w:num>/, nums));
        addOverride('/' + part, CT.numbering); addRel('numbering', 'numbering.xml', false);
      }
      return out;
    }
    function ensureStyles(need) {
      const part = 'word/styles.xml'; if (!pkg.has(part)) return;
      let t = pkg.text(part); const ours = W.styles(doc.styles); let add = '';
      for (const id of need) {
        if (new RegExp(`w:styleId="${id}"`).test(t)) continue;
        const m = new RegExp(`<w:style\\b[^>]*w:styleId="${id}"[\\s\\S]*?</w:style>`).exec(ours); if (m) add += m[0];
      }
      if (add) pkg.set(part, t.replace('</w:styles>', add + '</w:styles>'));
    }
    function appendNotes(K) {
      const part = `word/${K}s.xml`;
      if (pkg.has(part)) {
        let t = pkg.text(part); let max = 0; for (const m of t.matchAll(new RegExp(`<w:${K}\\b[^>]*w:id="(-?\\d+)"`, 'g'))) max = Math.max(max, +m[1]);
        pkg.set(part, t.replace(`</w:${K}s>`, W.noteItems(ctx, max) + `</w:${K}s>`)); return max;
      }
      const sep = `<w:${K} w:type="separator" w:id="-1"><w:p><w:pPr><w:spacing w:after="0"/></w:pPr><w:r><w:separator/></w:r></w:p></w:${K}><w:${K} w:type="continuationSeparator" w:id="0"><w:p><w:pPr><w:spacing w:after="0"/></w:pPr><w:r><w:continuationSeparator/></w:r></w:p></w:${K}>`;
      pkg.set(part, `${W.XML_HEAD}<w:${K}s ${W.NS}>${sep}${W.noteItems(ctx, 0)}</w:${K}s>`); addOverride('/' + part, CT[K + 's']); addRel(K + 's', `${K}s.xml`, false); return 0;
    }
    function appendComments() {
      const part = 'word/comments.xml';
      if (pkg.has(part)) {
        let t = pkg.text(part); let max = -1; for (const m of t.matchAll(/<w:comment\b[^>]*w:id="(\d+)"/g)) max = Math.max(max, +m[1]);
        pkg.set(part, t.replace('</w:comments>', W.commentItems(ctx, max + 1) + '</w:comments>')); return max + 1;
      }
      pkg.set(part, `${W.XML_HEAD}<w:comments ${W.NS}>${W.commentItems(ctx, 0)}</w:comments>`); addOverride('/' + part, CT.comments); addRel('comments', 'comments.xml', false); return 0;
    }

    // ── 4. Página: geometría, encabezado y pie ──
    let sect = finalSect ? docXml.slice(finalSect.start, finalSect.end) : '';
    const was = src.pageSrc || {}; const now = doc.page || {};
    const diff = (k) => JSON.stringify(was[k]) !== JSON.stringify(now[k]);
    if (sect) {
      const geo = ['width', 'height', 'orientation', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'columns', 'titlePage', 'pageStart'].some(diff);
      if (geo) sect = patchSection(sect, now);
      const hdr = diff('header') || diff('watermark'); const ftr = diff('footer') || diff('pageNumbers');
      if (hdr || ftr) {
        const hf = W.headerFooterParts(Object.assign({}, require_page(now)));
        const put = (kind, data) => {
          const re = new RegExp(`<w:${kind}Reference\\b[^>]*w:type="default"[^>]*/>|<w:${kind}Reference\\b[^>]*/>`);
          const ref = re.exec(sect);
          if (!data) { if (ref) sect = sect.replace(ref[0], ''); return; }
          const rid = ref && /r:id="([^"]+)"/.exec(ref[0]);
          const target = rid && relList(relsXml).find((r) => r.id === rid[1]);
          if (target) { pkg.set('word/' + target.target.replace(/^\/?(word\/)?/, ''), data); return; }
          let n = 1; let name; do { name = `word/${kind}Mc${n++}.xml`; } while (pkg.has(name));
          pkg.set(name, data); addOverride('/' + name, CT[kind]); const nid = addRel(kind, name.replace(/^word\//, ''), false);
          sect = sect.replace(/(<w:sectPr\b[^>]*>)/, `$1<w:${kind}Reference w:type="default" r:id="${nid}"/>`);
        };
        if (hdr) put('header', hf.header); if (ftr) put('footer', hf.footer);
      }
    }
    function require_page(p) { return p; }

    // ── 5. Ensamblar document.xml (declarando los espacios de nombres que falten) ──
    let rootTagEnd = docXml.indexOf('>', docXml.indexOf('<w:document')); let head = docXml.slice(0, sc.openEnd);
    const rootDecl = head.slice(0, rootTagEnd + 1);
    const wanted = {}; for (const m of W.NS.matchAll(/xmlns:([a-z0-9]+)="([^"]+)"/g)) wanted[m[1]] = m[2];
    let add = '';
    for (const [pfx, uri] of Object.entries(wanted)) if (new RegExp(`<${pfx}:`).test(generated) && !new RegExp(`xmlns:${pfx}=`).test(rootDecl)) add += ` xmlns:${pfx}="${uri}"`;
    if (add) head = head.slice(0, rootTagEnd) + add + head.slice(rootTagEnd);
    pkg.set('word/document.xml', head + body + sect + docXml.slice(sc.closeStart));
    pkg.set('word/_rels/document.xml.rels', relsXml); pkg.set('[Content_Types].xml', ct);

    const parts = [{ name: '[Content_Types].xml', data: pkg.get('[Content_Types].xml') }];
    for (const n of pkg.names()) if (n !== '[Content_Types].xml') parts.push({ name: n, data: pkg.get(n) });
    return { data: await zip.writeZip(parts), warnings };
  }

  function patchSection(sect, p) {
    const setAttr = (tag, attrs) => sect.replace(new RegExp(`<w:${tag}\\b[^>]*?/>`), (m0) => {
      let o = m0; for (const [k, v] of Object.entries(attrs)) { if (v == null) o = o.replace(new RegExp(`\\sw:${k}="[^"]*"`), ''); else if (new RegExp(`w:${k}="`).test(o)) o = o.replace(new RegExp(`w:${k}="[^"]*"`), `w:${k}="${v}"`); else o = o.replace(/\s*\/>$/, ` w:${k}="${v}"/>`); }
      return o;
    });
    if (p.width && p.height) sect = setAttr('pgSz', { w: tw(p.width), h: tw(p.height), orient: p.orientation === 'landscape' || p.width > p.height ? 'landscape' : null });
    const m = (k) => (p[k] != null ? tw(p[k]) : undefined);
    const mar = {}; for (const [k, a] of [['marginTop', 'top'], ['marginRight', 'right'], ['marginBottom', 'bottom'], ['marginLeft', 'left']]) if (m(k) !== undefined) mar[a] = m(k);
    if (Object.keys(mar).length) sect = setAttr('pgMar', mar);
    const cols = p.columns > 1 ? p.columns : 1;
    if (/<w:cols\b/.test(sect)) sect = setAttr('cols', { num: cols });
    else if (cols > 1) sect = /<w:pgNumType\b[^>]*\/>/.test(sect) ? sect.replace(/(<w:pgNumType\b[^>]*\/>)/, `$1<w:cols w:num="${cols}" w:space="708"/>`) : sect.replace(/(<w:pgMar\b[^>]*\/>)/, `$1<w:cols w:num="${cols}" w:space="708"/>`);
    if (p.titlePage && !/<w:titlePg\b/.test(sect)) sect = /<w:docGrid\b/.test(sect) ? sect.replace(/<w:docGrid\b/, '<w:titlePg/><w:docGrid') : sect.replace('</w:sectPr>', '<w:titlePg/></w:sectPr>');
    if (!p.titlePage) sect = sect.replace(/<w:titlePg\b[^>]*\/>/, '');
    if (p.pageStart > 1) { if (/<w:pgNumType\b/.test(sect)) sect = setAttr('pgNumType', { start: p.pageStart }); else sect = sect.replace(/(<w:pgMar\b[^>]*\/>)/, `$1<w:pgNumType w:start="${p.pageStart}"/>`); }
    return sect;
  }

  return { patchDocx, makeSource, blockSig, scanBody };
});

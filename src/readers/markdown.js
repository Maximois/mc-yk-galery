// Markdown -> bloques de HTML (uno por bloque de nivel superior, que es la base de las anclas de las
// anotaciones). Cubre lo habitual: títulos, párrafos, negrita/cursiva/tachado, código en línea y en
// bloque, citas, listas (con anidado), reglas, tablas y enlaces/imágenes.
// Seguridad: TODO el texto se escapa; el HTML crudo del archivo se muestra como texto, no se ejecuta.
// Los enlaces se muestran como texto con estilo (el lector no navega fuera del documento) y las
// imágenes no se cargan (sin red): se ve su texto alternativo.

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Énfasis y enlaces dentro de una línea. `text` es Markdown sin escapar. */
export function inlineToHtml(text) {
  const stash = [];
  const keep = (html) => '\u0000' + (stash.push(html) - 1) + '\u0000';
  let s = String(text);

  // 1) Código en línea y escapes con barra: se guardan aparte para que nada más los toque.
  s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, __, code) => keep('<code>' + esc(code.trim()) + '</code>'));
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, (_, ch) => keep(esc(ch)));

  s = esc(s);

  // 2) Imágenes y enlaces (el texto del enlace puede llevar énfasis, se procesa después).
  s = s.replace(/!\[([^\]]*)\]\(([^)]*)\)/g, (_, alt) => keep('<span class="md-img">' + (alt || 'imagen') + '</span>'));
  s = s.replace(/\[([^\]]+)\]\(([^)]*)\)/g, (_, label) => '<span class="md-link">' + label + '</span>');
  s = s.replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, (_, u) => '<span class="md-link">' + u + '</span>');

  // 3) Énfasis. El guion bajo solo cuenta en límite de palabra (snake_case no es cursiva).
  s = s.replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>');
  s = s.replace(/\*(?=\S)([^*]*?\S)\*/g, '<em>$1</em>');
  s = s.replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');

  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)]);
}

const isBlank = (l) => !l.trim();
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>[ ]?/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const splitRow = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));

function renderList(lines, start) {
  // Agrupa líneas de un mismo nivel de sangría; lo más sangrado se vuelve a procesar como sublista.
  const first = ITEM.exec(lines[start]);
  const baseIndent = first[1].replace(/\t/g, '    ').length;
  const ordered = /\d/.test(first[2]);
  const items = [];
  let i = start;
  while (i < lines.length) {
    const m = ITEM.exec(lines[i]);
    if (m && m[1].replace(/\t/g, '    ').length === baseIndent && /\d/.test(m[2]) === ordered) {
      items.push({ text: [m[3]], sub: [] });
      i++;
      continue;
    }
    if (!m && !isBlank(lines[i]) && /^\s{2,}\S/.test(lines[i]) && items.length) { // continuación del ítem
      const last = items[items.length - 1];
      (last.sub.length ? last.sub : last.text).push(lines[i].trim());
      i++;
      continue;
    }
    if (m && m[1].replace(/\t/g, '    ').length > baseIndent && items.length) { items[items.length - 1].sub.push(lines[i]); i++; continue; }
    break;
  }
  const tag = ordered ? 'ol' : 'ul';
  const startNum = ordered ? parseInt(first[2], 10) : null;
  const html = '<' + tag + (ordered && startNum > 1 ? ' start="' + startNum + '"' : '') + '>' +
    items.map((it) => {
      const subItems = it.sub.filter((l) => ITEM.test(l));
      const cont = it.text.join(' ');
      return '<li>' + inlineToHtml(cont) + (subItems.length ? renderList(it.sub.filter((l) => !isBlank(l)), 0).html : '') + '</li>';
    }).join('') + '</' + tag + '>';
  return { html, next: i };
}

/** Markdown -> array de HTML, uno por bloque de nivel superior. */
export function markdownToBlocks(source) {
  const lines = String(source).replace(/\r\n?/g, '\n').replace(/^﻿/, '').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }

    let m = FENCE.exec(line);
    if (m) {
      const fence = m[1];
      const body = [];
      i++;
      while (i < lines.length && !new RegExp('^ {0,3}' + fence[0] + '{' + fence.length + ',}\\s*$').test(lines[i])) body.push(lines[i++]);
      i++; // cierre
      out.push('<pre><code>' + esc(body.join('\n')) + '</code></pre>');
      continue;
    }
    if ((m = HEADING.exec(line))) { out.push('<h' + m[1].length + '>' + inlineToHtml(m[2]) + '</h' + m[1].length + '>'); i++; continue; }
    if (HR.test(line)) { out.push('<hr>'); i++; continue; }

    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(lines[i++].replace(QUOTE, ''));
      out.push('<blockquote>' + markdownToBlocks(body.join('\n')).join('') + '</blockquote>');
      continue;
    }
    if (ITEM.test(line)) { const r = renderList(lines, i); out.push(r.html); i = r.next; continue; }

    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = splitRow(line);
      const rows = [];
      i += 2;
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|')) rows.push(splitRow(lines[i++]));
      out.push('<table><thead><tr>' + head.map((c) => '<th>' + inlineToHtml(c) + '</th>').join('') + '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' + head.map((_, k) => '<td>' + inlineToHtml(r[k] || '') + '</td>').join('') + '</tr>').join('') + '</tbody></table>');
      continue;
    }

    // Código sangrado (4 espacios o tab) fuera de una lista
    if (/^( {4}|\t)/.test(line)) {
      const body = [];
      while (i < lines.length && (/^( {4}|\t)/.test(lines[i]) || (isBlank(lines[i]) && i + 1 < lines.length && /^( {4}|\t)/.test(lines[i + 1])))) body.push(lines[i++].replace(/^( {4}|\t)/, ''));
      out.push('<pre><code>' + esc(body.join('\n')) + '</code></pre>');
      continue;
    }

    // Párrafo (y títulos subrayados con === o ---)
    const para = [];
    while (i < lines.length && !isBlank(lines[i]) && !FENCE.test(lines[i]) && !HEADING.test(lines[i]) && !QUOTE.test(lines[i])) {
      // Subrayado === o --- bajo un párrafo: es un título (tiene prioridad sobre la regla horizontal).
      if (para.length && /^ {0,3}(=+|-+)[ \t]*$/.test(lines[i])) { para.level = lines[i].trim()[0] === '=' ? 1 : 2; i++; break; }
      if (para.length && (HR.test(lines[i]) || ITEM.test(lines[i]))) break;
      para.push(lines[i++]);
    }
    if (!para.length) { i++; continue; }
    const joined = para.map((l, k) => (k < para.length - 1 && / {2,}$/.test(l) ? l.trimEnd() + '\u0001' : l.trim())).join(' ').replace(/\u0001 /g, '\u0001');
    const html = inlineToHtml(joined).replace(/\u0001/g, '<br>');
    out.push(para.level ? '<h' + para.level + '>' + html + '</h' + para.level + '>' : '<p>' + html + '</p>');
  }
  return out;
}

export const MARKDOWN_CSS = 'code{font-family:ui-monospace,Consolas,monospace;font-size:.92em;background:rgba(127,127,127,.16);padding:.08em .3em;border-radius:3px}' +
  'pre{background:rgba(127,127,127,.12);padding:10px 12px;border-radius:6px;overflow-x:auto}pre code{background:none;padding:0}' +
  'blockquote{margin:.8em 0;padding:.1em 1em;border-left:3px solid rgba(127,127,127,.5);color:inherit;opacity:.9}' +
  '.md-link{color:#0b6bcb;text-decoration:underline}.md-img{font-style:italic;opacity:.7}' +
  'table{border-collapse:collapse}th,td{border:1px solid rgba(127,127,127,.5);padding:4px 8px}th{background:rgba(127,127,127,.12)}hr{border:0;border-top:1px solid rgba(127,127,127,.5);margin:1.2em 0}';

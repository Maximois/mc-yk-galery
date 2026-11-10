// Anclas: cómo una anotación se "pega" a un lugar del documento y lo vuelve a encontrar.
//
// Por qué no se usa el id de bloque del núcleo: model.genId() mezcla Date.now() y Math.random(),
// así que cambia cada vez que se abre el archivo. Lo estable es el TEXTO.
//
// Modelo: el documento se aplana a un solo string (el texto de cada bloque, unidos con '\n').
// Un ancla es { s, e, q, pre, post }: posición de inicio y fin en ese string, la cita exacta (q)
// y un poco de contexto antes y después. Si el documento se reconstruye distinto (otra versión
// del conversor, otro archivo editado) la cita permite reubicar la anotación; si ni así aparece,
// la anotación queda "huérfana": sigue en el cuaderno pero sin resaltado en pantalla.
//
// Funciones puras (sin DOM): se prueban con node --test. El DOM vive en reflow-viewer.js.

const CONTEXT = 32;
const MAX_QUOTE = 4000;
const MAX_CANDIDATES = 200;

/** Aplana los textos de los bloques. `starts[i]` es el offset donde empieza el bloque i. */
export function flatten(blockTexts) {
  const starts = [];
  let pos = 0;
  for (const t of blockTexts) {
    starts.push(pos);
    pos += t.length + 1; // +1 por el '\n' separador
  }
  return { text: blockTexts.join('\n'), starts };
}

export function makeAnchor(flatText, s, e) {
  return {
    s,
    e,
    q: flatText.slice(s, Math.min(e, s + MAX_QUOTE)),
    pre: flatText.slice(Math.max(0, s - CONTEXT), s),
    post: flatText.slice(e, e + CONTEXT)
  };
}

function commonSuffix(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function commonPrefix(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/**
 * Devuelve { s, e, status } con status 'exact' (sigue en su sitio) o 'moved' (reubicada por la cita),
 * o null si la cita ya no aparece en el texto.
 */
export function resolveAnchor(anchor, flatText) {
  if (!anchor || typeof anchor.q !== 'string' || !anchor.q) return null;
  const { q } = anchor;
  const len = Math.max(anchor.e - anchor.s, q.length);

  if (flatText.slice(anchor.s, anchor.s + q.length) === q) {
    return { s: anchor.s, e: anchor.s + len, status: 'exact' };
  }

  let best = null;
  let from = 0;
  for (let n = 0; n < MAX_CANDIDATES; n++) {
    const idx = flatText.indexOf(q, from);
    if (idx === -1) break;
    const score =
      commonSuffix(anchor.pre || '', flatText.slice(Math.max(0, idx - CONTEXT), idx)) +
      commonPrefix(anchor.post || '', flatText.slice(idx + q.length, idx + q.length + CONTEXT));
    const dist = Math.abs(idx - anchor.s);
    if (!best || score > best.score || (score === best.score && dist < best.dist)) best = { idx, score, dist };
    from = idx + 1;
  }
  return best ? { s: best.idx, e: best.idx + len, status: 'moved' } : null;
}

/** Índice del bloque que contiene el offset (el último cuyo inicio es <= offset). */
export function blockAt(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return Math.max(0, lo);
}

/** Parte el rango [s, e) en tramos por bloque: [{ b, from, to }] con offsets locales al bloque. */
export function splitByBlocks(starts, blockTexts, s, e) {
  const out = [];
  if (e <= s || !starts.length) return out;
  for (let b = blockAt(starts, s); b < starts.length && starts[b] < e; b++) {
    const from = Math.max(s, starts[b]) - starts[b];
    const to = Math.min(e, starts[b] + blockTexts[b].length) - starts[b];
    if (to > from) out.push({ b, from, to });
  }
  return out;
}

/** Recorta espacios en los extremos de la selección (los toques en pantalla suelen agarrarlos). */
export function trimRange(flatText, s, e) {
  while (s < e && /\s/.test(flatText[s])) s++;
  while (e > s && /\s/.test(flatText[e - 1])) e--;
  return { s, e };
}

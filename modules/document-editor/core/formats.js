'use strict';

/*
 * Registro explicito de formatos conocidos.
 *
 * La idea es NO adivinar: cada extension (o nombre de archivo conocido)
 * declara de antemano como se abre. Asi el editor sabe que lector usar y
 * no depende de mirar el contenido para "suponer" si es texto o no.
 *
 * Valores de formato:
 *   pdf    -> lector PDF
 *   docx   -> word/document.xml (docx, docm, dotx, dotm)
 *   odt    -> ODT/OTT (zip OpenDocument)
 *   doc    -> .doc binario (OLE2), con respaldo RTF/HTML/texto
 *   rtf    -> texto enriquecido (se abre como texto)
 *   html   -> HTML/XHTML (se abre como texto)
 *   md     -> Markdown (se abre como texto)
 *   txt    -> texto plano con guardado en el lugar (txt, log, csv, ...)
 *   text   -> cualquier otro texto/codigo/config (se abre; al guardar -> DOCX)
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DocFormats = api;
})(typeof self !== 'undefined' ? self : this, function () {

  // Formato canonico por extension (con punto, en minusculas).
  const EXT = {
    '.pdf': 'pdf',
    '.epub': 'epub',

    '.docx': 'docx', '.docm': 'docx', '.dotx': 'docx', '.dotm': 'docx',
    '.odt': 'odt', '.ott': 'odt',
    '.doc': 'doc', '.dot': 'doc',
    '.rtf': 'rtf',
    '.html': 'html', '.htm': 'html', '.xhtml': 'html',

    '.md': 'md', '.markdown': 'md', '.mdown': 'md', '.mkd': 'md', '.mkdn': 'md', '.mdwn': 'md',

    // Texto plano con guardado en el lugar.
    '.txt': 'txt', '.text': 'txt', '.log': 'txt', '.csv': 'txt', '.tsv': 'txt',
    '.lst': 'txt', '.nfo': 'txt', '.me': 'txt',

    // Texto amplio: codigo, configuracion, marcado y datos.
    '.json': 'text', '.jsonl': 'text', '.ndjson': 'text', '.json5': 'text', '.jsonc': 'text',
    '.yaml': 'text', '.yml': 'text', '.toml': 'text',
    '.ini': 'text', '.cfg': 'text', '.conf': 'text', '.config': 'text',
    '.properties': 'text', '.prefs': 'text', '.env': 'text',
    '.xml': 'text', '.svg': 'text', '.plist': 'text',
    '.tex': 'text', '.latex': 'text', '.bib': 'text', '.rst': 'text',
    '.adoc': 'text', '.asciidoc': 'text', '.org': 'text',
    '.srt': 'text', '.vtt': 'text', '.ass': 'text', '.sub': 'text', '.ssa': 'text',

    '.js': 'text', '.mjs': 'text', '.cjs': 'text', '.jsx': 'text',
    '.ts': 'text', '.tsx': 'text', '.mts': 'text', '.cts': 'text',
    '.css': 'text', '.scss': 'text', '.sass': 'text', '.less': 'text', '.styl': 'text',
    '.php': 'text', '.py': 'text', '.pyw': 'text', '.pyi': 'text',
    '.rb': 'text', '.rbw': 'text', '.java': 'text', '.kt': 'text', '.kts': 'text',
    '.c': 'text', '.h': 'text', '.cc': 'text', '.cpp': 'text', '.cxx': 'text',
    '.hpp': 'text', '.hh': 'text', '.hxx': 'text', '.cs': 'text', '.csx': 'text',
    '.go': 'text', '.rs': 'text', '.swift': 'text', '.m': 'text', '.mm': 'text',
    '.sh': 'text', '.bash': 'text', '.zsh': 'text', '.fish': 'text', '.ksh': 'text',
    '.ps1': 'text', '.psm1': 'text', '.psd1': 'text', '.bat': 'text', '.cmd': 'text',
    '.sql': 'text', '.r': 'text', '.lua': 'text', '.pl': 'text', '.pm': 'text', '.tcl': 'text',
    '.vue': 'text', '.svelte': 'text', '.astro': 'text', '.dart': 'text',
    '.scala': 'text', '.sc': 'text', '.clj': 'text', '.cljs': 'text', '.cljc': 'text',
    '.ex': 'text', '.exs': 'text', '.erl': 'text', '.hrl': 'text',
    '.hs': 'text', '.lhs': 'text', '.fs': 'text', '.fsx': 'text', '.fsi': 'text',
    '.vb': 'text', '.vbs': 'text', '.asm': 'text', '.s': 'text',
    '.groovy': 'text', '.gradle': 'text', '.jl': 'text', '.nim': 'text', '.zig': 'text',
    '.graphql': 'text', '.gql': 'text', '.proto': 'text',
    '.diff': 'text', '.patch': 'text', '.mk': 'text',
    '.tf': 'text', '.tfvars': 'text', '.hcl': 'text'
  };

  // Nombres de archivo sin extension util (dotfiles, Makefile, ...).
  const BASE = {
    '.gitignore': 'text', '.gitattributes': 'text', '.gitmodules': 'text', '.gitconfig': 'text',
    '.editorconfig': 'text', '.dockerignore': 'text', '.npmrc': 'text', '.nvmrc': 'text',
    '.babelrc': 'text', '.eslintrc': 'text', '.eslintignore': 'text',
    '.prettierrc': 'text', '.prettierignore': 'text', '.stylelintrc': 'text',
    '.env': 'text', '.flaskenv': 'text', '.htaccess': 'text',
    'makefile': 'text', 'gnumakefile': 'text', 'makefile.am': 'text', 'makefile.in': 'text',
    'dockerfile': 'text', 'containerfile': 'text', 'cmakelists.txt': 'text',
    'procfile': 'text', 'gemfile': 'text', 'rakefile': 'text', 'vagrantfile': 'text',
    'brewfile': 'text', 'justfile': 'text', 'license': 'text', 'licence': 'text',
    'copying': 'text', 'authors': 'text', 'contributors': 'text', 'notice': 'text',
    'readme': 'md', 'changelog': 'md', 'changes': 'md', 'todo': 'md'
  };

  // Etiquetas para los filtros de los dialogos de apertura/guardado.
  const LABELS = {
    pdf: 'PDF',
    docx: 'Word (DOCX)',
    odt: 'OpenDocument (ODT)',
    doc: 'Word 97-2003 (DOC)',
    rtf: 'Texto enriquecido (RTF)',
    html: 'Pagina web (HTML)',
    md: 'Markdown',
    txt: 'Texto (TXT/LOG/CSV)',
    text: 'Texto y codigo'
  };

  // Extensiones sugeridas por formato (para los filtros del dialogo).
  const GLOBS = {
    pdf: ['pdf'],
    docx: ['docx', 'docm', 'dotx', 'dotm'],
    odt: ['odt', 'ott'],
    doc: ['doc', 'dot'],
    rtf: ['rtf'],
    html: ['html', 'htm', 'xhtml'],
    md: ['md', 'markdown', 'mdown', 'mkd', 'mkdn', 'mdwn'],
    txt: ['txt', 'text', 'log', 'csv', 'tsv', 'lst', 'nfo'],
    // Lista curada solo para mostrar en el filtro; el editor reconoce muchas
    // mas extensiones (ver EXT), aqui basta un subconjunto representativo.
    text: ['json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'xml', 'svg',
      'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'css', 'scss', 'less',
      'py', 'rb', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs', 'php',
      'sh', 'bash', 'ps1', 'bat', 'cmd', 'sql', 'r', 'lua', 'pl', 'tex', 'rst']
  };

  const OPENABLE = ['pdf', 'docx', 'odt', 'doc', 'rtf', 'html', 'md', 'txt', 'text'];

  function baseName(file) {
    return String(file == null ? '' : file).replace(/[\\/]+$/, '').split(/[\\/]/).pop().toLowerCase();
  }

  // Extension con punto, tomada del nombre (sin depender de path del SO).
  function extOf(base) {
    const m = /\.[^.\\/]+$/.exec(base);
    return m ? m[0] : '';
  }

  // Devuelve el formato declarado para una ruta, o '' si es desconocido.
  function fromPath(file) {
    const base = baseName(file);
    if (!base) return '';
    if (BASE[base]) return BASE[base];
    const ext = extOf(base);
    if (ext && EXT[ext]) return EXT[ext];
    return '';
  }

  function isOpenable(format) {
    return OPENABLE.indexOf(format) !== -1;
  }

  return {
    EXT: EXT,
    BASE: BASE,
    LABELS: LABELS,
    GLOBS: GLOBS,
    OPENABLE: OPENABLE,
    fromPath: fromPath,
    isOpenable: isOpenable,
    baseName: baseName,
    extOf: extOf
  };
});

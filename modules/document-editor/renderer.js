'use strict';
/**
 * modules/document-editor/renderer.js — vista del editor de documentos.
 *
 * El renderer no es dueño de nada: el main tiene el archivo y el documento
 * (ver main.js). Acá se pintan los bloques, se renderizan las páginas del PDF
 * y se mandan parches. Cada cambio del usuario vuelve como parche (`doc:edit`),
 * igual que los de la IA (`doc:patch`): un solo camino y un solo control de
 * concurrencia (el hash).
 *
 * El editor vive como una PESTAÑA del navegador (mc://doc → panel-doc), no
 * como modal: no tapa la interfaz y se cierra con el mismo botón que las
 * demás pestañas. La UI se inyecta dentro de #doc-host.
 */

(function () {
  'use strict';

  const API = window.mc || {};
  // El nucleo del editor, cargado por script tag en renderer.html. Aporta el
  // render de Word (core/html.js): la vista edita sobre ese HTML, no sobre un
  // dibujo propio, para que pantalla, PDF y DOCX digan lo mismo.
  const html = (window.MCDoc && window.MCDoc.html) || null;
  // Formato en linea: algebra de tramos y lector del DOM (core/runs.js, core/dom-runs.js).
  const runsLib = (window.MCDoc && window.MCDoc.runs) || null;
  const domRuns = (window.MCDoc && window.MCDoc.domRuns) || null;
  const tablesLib = (window.MCDoc && window.MCDoc.tables) || null;
  const pageLib = (window.MCDoc && window.MCDoc.pagesetup) || null;
  const pasteLib = (window.MCDoc && window.MCDoc.paste) || null;
  const domBlocks = (window.MCDoc && window.MCDoc.domBlocks) || null;
  const RUN_TYPES = ['paragraph', 'heading', 'quote'];
  const PANEL_ID = 'panel-doc';
  const HOST_ID = 'doc-host';
  const BTN_ID = 'doc-editor-btn';
  const TAB_URL = 'mc://doc';

  const ui = {
    snap: null,        // último estado que mandó el main
    selectedBlockId: null,
    view: 'content',   // 'content' | 'pages'
    onePage: false,    // mostrar de a una hoja (para libros largos)
    paperTone: 'claro', // tono de la hoja: claro | suave | oscuro
    onePageUser: null, // true/false si el usuario lo fijo a mano; null = automatico
    pageIndex: 0,      // hoja visible en modo unaPagina
    pdfRenderToken: 0,
    toast: null
  };
  // A partir de esta cantidad de hojas el documento se abre de a una: en un
  // libro de 200 hojas verlas todas seguidas satura la vista y el scroll.
  const AUTO_ONE_PAGE_FROM = 20;
  // El reparto en hojas necesita medidas reales; si el panel todavia no las
  // tiene, se reintenta en los frames siguientes.
  let needsRelayout = false;
  let relayoutTimer = 0;
  let relayoutTries = 0;
  // true cuando la pestaña se cerro y se solto el DOM. El MutationObserver
  // vuelve a levantar la carcasa, pero el documento se rearma recien al
  // mostrar el panel de nuevo.
  let torn = false;

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // El main viaja liviano: cuando una imagen ya se envio completa (lightDoc)
  // el snapshot llega sin su `src` base64. Estas son propias del renderer: si
  // el bloque id ya se vio con bytes, se recuperan al repintar (el render no
  // reusa nodos: reconstruye el innerHTML y sin esto la imagen saldria en
  // blanco en cada parche).
  const knownImgSrc = new Map();
  function rememberImgSrc(snap) {
    if (!snap || typeof snap !== 'object' || !snap.doc || !Array.isArray(snap.doc.blocks)) return snap;
    let changed = false;
    const blocks = snap.doc.blocks.map((b) => {
      if (!b || b.type !== 'image') return b;
      if (typeof b.src === 'string' && b.src) {
        knownImgSrc.set(b.id, b.src);
        return b;
      }
      const known = knownImgSrc.get(b.id);
      if (known) {
        changed = true;
        const copy = Object.assign({}, b);
        copy.src = known;
        return copy;
      }
      return b;
    });
    if (!changed) return snap;
    return Object.assign({}, snap, { doc: Object.assign({}, snap.doc, { blocks }) });
  }
  const panel = () => document.getElementById(PANEL_ID);
  const host = () => document.getElementById(HOST_ID);
  const el = (id) => { const h = host(); return h ? h.querySelector('#' + id) : null; };

  function cssEscape(s) {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(s);
    return String(s).replace(/["\\]/g, '\\$&');
  }

  // El panel está activo cuando la app puso .active (showPanel) y cuando su
  // pestaña es la activa. Con los dos chequeos no hay que adivinar.
  function isActive() {
    const p = panel();
    if (!p || !p.classList.contains('active')) return false;
    try { return state0().activeTab === docTab()?.id; } catch { return true; }
  }
  function state0() {
    // `state` es un binding global del renderer.html; se accede por nombre para
    // no depender de window.
    return typeof state === 'object' ? state : { tabs: [], activeTab: null };
  }
  function docTab() {
    const s = state0();
    return (s.tabs || []).find((t) => t.url === TAB_URL) || null;
  }

  function toast(msg, kind, action) {
    const t = el('doc-toast');
    if (!t) { console.log('[DocEditor]', msg); return; }
    t.textContent = msg;
    if (action && action.label) {
      const b = document.createElement('button');
      b.className = 'doc-toast-action';
      b.textContent = action.label;
      b.addEventListener('click', () => { t.className = 'doc-toast'; action.run(); });
      t.appendChild(b);
    }
    t.className = 'doc-toast show' + (kind ? ' ' + kind : '') + (action ? ' has-action' : '');
    clearTimeout(ui.toast);
    ui.toast = setTimeout(() => { t.className = 'doc-toast'; }, kind === 'error' ? 6000 : (action ? 8000 : 3000));
  }

  // Dialogo propio en el DOM. window.confirm/alert nativos dejan a Electron
  // (Windows) sin foco de teclado en la pagina al cerrarse: no se podia volver
  // a escribir en el documento. Y window.prompt ni existe en Electron.
  // opts: { title, message, fields:[{name,label,value}], ok, cancel }
  // Devuelve una promesa con { campo: valor } o null si se cancela.
  function modal(opts) {
    const h = host();
    if (!h) return Promise.resolve(null);
    return new Promise((resolve) => {
      const o = opts || {};
      const back = document.createElement('div');
      back.className = 'doc-modal-back';
      const box = document.createElement('div');
      box.className = 'doc-modal';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      const title = document.createElement('div');
      title.className = 'doc-modal-title';
      title.id = 'doc-modal-title-' + Date.now();
      box.setAttribute('aria-labelledby', title.id);
      title.textContent = o.title || '';
      box.appendChild(title);
      if (o.message) {
        const m = document.createElement('div');
        m.className = 'doc-modal-msg';
        m.textContent = o.message;
        box.appendChild(m);
      }
      const inputs = {};
      (o.fields || []).forEach((f) => {
        const lab = document.createElement('label');
        lab.textContent = f.label || f.name;
        let inp;
        if (f.options) {
          inp = document.createElement('select');
          f.options.forEach((op) => {
            const opt = document.createElement('option');
            opt.value = op[0];
            opt.textContent = op[1];
            inp.appendChild(opt);
          });
          inp.value = f.value || '';
        } else {
          inp = document.createElement('input');
          inp.type = 'text';
          inp.value = f.value || '';
        }
        inputs[f.name] = inp;
        lab.appendChild(inp);
        box.appendChild(lab);
      });
      const row = document.createElement('div');
      row.className = 'doc-modal-row';
      const okB = document.createElement('button');
      okB.className = 'doc-btn primary';
      okB.textContent = o.ok || 'Aceptar';
      row.appendChild(okB);
      let cancelB = null;
      if (o.cancel !== false) {
        cancelB = document.createElement('button');
        cancelB.className = 'doc-btn';
        cancelB.textContent = o.cancel || 'Cancelar';
        row.insertBefore(cancelB, okB);
      }
      box.appendChild(row);
      back.appendChild(box);
      const prev = document.activeElement;
      const close = (val) => {
        back.remove();
        try { if (prev && prev.focus && document.contains(prev)) prev.focus(); } catch (e) { /* sin foco previo */ }
        resolve(val);
      };
      const done = () => {
        const out = {};
        Object.keys(inputs).forEach((k) => { out[k] = inputs[k].value; });
        close(out);
      };
      okB.addEventListener('click', done);
      if (cancelB) cancelB.addEventListener('click', () => close(null));
      back.addEventListener('mousedown', (e) => { if (e.target === back && cancelB) close(null); });
      box.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Tab') {
          const f = Array.from(box.querySelectorAll('button,input,select,textarea')).filter((x) => !x.disabled && x.offsetParent !== null);
          if (f.length) {
            const first = f[0], last = f[f.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
          }
        }
        if (e.key === 'Escape') { e.preventDefault(); close(cancelB ? null : {}); }
        else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); done(); }
      });
      h.appendChild(back);
      const first = Object.keys(inputs)[0];
      (first ? inputs[first] : okB).focus();
      if (first && inputs[first].select) inputs[first].select();
    });
  }

  // ── Estilos ────────────────────────────────────────────────────────────
  const DOC_CSS = [
'#' + HOST_ID + '{font-family:Calibri,"Segoe UI",Arial,sans-serif;color:var(--text,#e6e8ee);}',
'#' + HOST_ID + ' .doc-bar{display:flex;align-items:center;gap:6px;padding:8px 14px;',
'border-bottom:1px solid var(--border,#2a2f3a);background:var(--surface2,#191c24);flex-wrap:wrap;flex-shrink:0;}',
'#' + HOST_ID + ' .doc-formatbar{display:flex;align-items:center;gap:8px;padding:7px 12px;',
'border-bottom:1px solid var(--border,#2a2f3a);background:var(--surface,#14161c);flex-wrap:wrap;flex-shrink:0;}',
'#' + HOST_ID + ' .doc-format-group{display:flex;align-items:center;gap:3px;padding-right:9px;border-right:1px solid var(--border,#2a2f3a);}',
'#' + HOST_ID + ' .doc-format-group:last-child{border:0;padding-right:0;}',
'#' + HOST_ID + ' .doc-formatbar select{height:27px;padding:3px 6px;background:var(--surface2,#191c24);',
'color:inherit;border:1px solid var(--border,#2a2f3a);border-radius:4px;font:inherit;font-size:.82rem;}',
'#' + HOST_ID + ' .doc-objbar{display:flex;visibility:hidden;min-height:38px;box-sizing:border-box;align-items:center;gap:6px;padding:5px 12px;border-bottom:1px solid var(--border,#2a2f3a);background:var(--surface,#14161c);flex-wrap:wrap;flex-shrink:0;font-size:.82rem;}',
'#' + HOST_ID + ' .doc-objbar.on{visibility:visible;}',
'#' + HOST_ID + ' .doc-objbar .doc-obj-label{opacity:.7;margin-right:4px;}',
'#' + HOST_ID + ' .doc-objbar input[type=number],#' + HOST_ID + ' .doc-objbar input[type=text]{height:26px;padding:2px 6px;background:var(--surface2,#191c24);color:inherit;border:1px solid var(--border,#2a2f3a);border-radius:4px;font:inherit;}',
'#' + HOST_ID + ' .doc-objbar input[type=number]{width:70px;}',
'#' + HOST_ID + ' .doc-objbar input[type=text]{width:220px;}',
'#' + HOST_ID + ' .doc-table-picker{position:absolute;z-index:30;display:none;padding:8px;background:var(--surface2,#191c24);border:1px solid var(--border,#2a2f3a);border-radius:6px;box-shadow:0 6px 20px rgba(0,0,0,.4);}',
'#' + HOST_ID + ' .doc-table-picker.on{display:block;}',
'#' + HOST_ID + ' .doc-table-grid{display:grid;grid-template-columns:repeat(8,18px);gap:2px;}',
'#' + HOST_ID + ' .doc-table-grid i{width:18px;height:18px;border:1px solid var(--border,#2a2f3a);border-radius:2px;display:block;cursor:pointer;}',
'#' + HOST_ID + ' .doc-table-grid i.hot{background:rgba(77,163,255,.45);border-color:var(--accent,#4da3ff);}',
'#' + HOST_ID + ' .doc-table-size{margin-top:6px;text-align:center;font-size:.8rem;opacity:.8;}',
'.doc-b .doc-img-wrap{position:relative;display:inline-block;max-width:calc(100% - 16px);margin:8px;line-height:0;}',
'.doc-b .doc-img-wrap img.doc-img{margin:0;display:block;width:100%;height:auto;}',
'.doc-b.doc-img-block[data-wrap=left]{float:left;margin:2pt 12pt 6pt 0;max-width:60%;}',
'.doc-b.doc-img-block[data-wrap=right]{float:right;margin:2pt 0 6pt 12pt;max-width:60%;}',
'.doc-paper{position:relative;}',
'.doc-paper-hf{position:absolute;font-size:9pt;color:#555;white-space:pre;overflow:hidden;pointer-events:none;}',
'.doc-b .doc-img-handle{display:none;position:absolute;right:-5px;bottom:-5px;width:12px;height:12px;background:var(--accent,#4da3ff);border:2px solid #fff;border-radius:3px;cursor:nwse-resize;}',
'.doc-b.sel .doc-img-handle{display:block;}',
'.doc-b.sel .doc-img-wrap{outline:2px solid var(--accent,#4da3ff);}',
'#' + HOST_ID + ' .doc-format-tool{min-width:28px;height:27px;padding:2px 6px;background:transparent;',
'color:inherit;border:1px solid transparent;border-radius:4px;cursor:pointer;font:inherit;}',
'#' + HOST_ID + ' .doc-format-tool:hover:not(:disabled){background:var(--surface3,#22262f);}',
'#' + HOST_ID + ' .doc-format-tool.active{background:rgba(77,163,255,.2);border-color:var(--accent,#4da3ff);}',
'#' + HOST_ID + ' .doc-format-tool:disabled,#' + HOST_ID + ' .doc-formatbar select:disabled{opacity:.4;cursor:default;}',
'#' + HOST_ID + ' .doc-color-wrap{position:relative;display:inline-flex;align-items:center;justify-content:center;width:30px;height:27px;border:1px solid var(--border,#2a2f3a);border-radius:5px;cursor:pointer;overflow:hidden;}',
'#' + HOST_ID + ' .doc-color-wrap:hover{background:var(--surface3,#22262f);}',
'#' + HOST_ID + ' .doc-color-wrap input{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;}',
'#' + HOST_ID + ' .doc-color-wrap:has(input:disabled){opacity:.4;cursor:default;}',
'#' + HOST_ID + ' .doc-color-wrap:has(input:disabled) input{cursor:default;}',
'#' + HOST_ID + ' .doc-color-a{font-weight:700;border-bottom:3px solid var(--doc-color-a,#d32f2f);line-height:1;padding:0 2px;}',
'#' + HOST_ID + ' .doc-color-h{font-weight:600;background:var(--doc-color-h,#fff176);color:#222;padding:0 3px;border-radius:2px;line-height:1.2;}',
'#' + HOST_ID + ' .doc-formatbar .doc-format-label{font-size:.72rem;color:var(--muted,#8b93a7);margin-right:3px;}',
'#' + HOST_ID + ' .doc-title{font-size:1.15rem;font-weight:700;overflow:hidden;',
'text-overflow:ellipsis;white-space:nowrap;max-width:46%;}',
'#' + HOST_ID + ' .doc-title .doc-star{color:var(--accent,#4da3ff);margin-left:4px;}',
'#' + HOST_ID + ' .doc-sub{font-size:.82rem;color:var(--muted,#8b93a7);margin-right:auto;}',
'#' + HOST_ID + ' .doc-views{display:flex;gap:2px;}',
'#' + HOST_ID + ' button.doc-btn{background:var(--surface,#14161c);color:inherit;',
'border:1px solid var(--border,#2a2f3a);border-radius:6px;padding:5px 10px;font-size:.85rem;cursor:pointer;white-space:nowrap;}',
'#' + HOST_ID + ' button.doc-btn:hover:not(:disabled){background:var(--surface3,#22262f);color:var(--accent,#4da3ff);}',
'#' + HOST_ID + ' button.doc-btn:disabled{opacity:.4;cursor:default;}',
'#' + HOST_ID + ' button.doc-btn.primary{background:var(--accent,#4da3ff);color:#07101c;border-color:transparent;font-weight:600;}',
'#' + HOST_ID + ' button.doc-btn.on{background:var(--surface3,#22262f);color:var(--accent,#4da3ff);}',
'#' + HOST_ID + ' .doc-warn{padding:7px 14px;font-size:.82rem;background:rgba(255,183,77,.12);',
'border-bottom:1px solid rgba(255,183,77,.3);color:#ffb74d;flex-shrink:0;}',
'#' + HOST_ID + ' .doc-ruler{flex:none;position:relative;height:24px;overflow:hidden;background:var(--bg2,#eceff3);border-bottom:1px solid var(--border,#d0d5dd);user-select:none;font-size:9px;color:#5a6472;}',
'#' + HOST_ID + ' .doc-ruler[hidden]{display:none;}',
'#' + HOST_ID + ' .ruler-page{position:absolute;top:0;bottom:0;background:#fff;}',
'#' + HOST_ID + ' .ruler-margin{position:absolute;top:0;bottom:0;background:#cfd5de;}',
'#' + HOST_ID + ' .ruler-tick{position:absolute;bottom:0;width:1px;background:#8a93a0;}',
'#' + HOST_ID + ' .ruler-num{position:absolute;top:2px;transform:translateX(-50%);}',
'#' + HOST_ID + ' .ruler-mh{position:absolute;top:0;bottom:0;width:7px;margin-left:-3px;cursor:ew-resize;z-index:2;}',
'#' + HOST_ID + ' .ruler-mh::after{content:"";position:absolute;left:3px;top:0;bottom:0;width:1px;background:var(--accent,#4da3ff);}',
'#' + HOST_ID + ' .ruler-ind{position:absolute;width:0;height:0;margin-left:-5px;border-left:5px solid transparent;border-right:5px solid transparent;cursor:ew-resize;z-index:3;}',
'#' + HOST_ID + ' .ruler-ind.first{top:0;border-top:8px solid var(--accent,#4da3ff);}',
'#' + HOST_ID + ' .ruler-ind.left{bottom:0;border-bottom:8px solid var(--accent,#4da3ff);}',
'#' + HOST_ID + ' .doc-b[data-callout]{padding:8px 12px;border-radius:4px;border-left:4px solid;}',
'#' + HOST_ID + ' .doc-b[data-callout="info"]{background:#EAF2FF;border-color:#3B82F6;color:#111;}',
'#' + HOST_ID + ' .doc-b[data-callout="warn"]{background:#FFF6DD;border-color:#F59E0B;color:#111;}',
'#' + HOST_ID + ' .doc-b[data-callout="ok"]{background:#E7F7EC;border-color:#22A559;color:#111;}',
'#' + HOST_ID + ' .doc-b[data-callout="error"]{background:#FDECEC;border-color:#E5484D;color:#111;}',
'#' + HOST_ID + ' .doc-paper-stack{counter-reset:capfig captab;}',
'#' + HOST_ID + ' .doc-b[data-caption]{text-align:center;font-size:10pt;}',
'#' + HOST_ID + ' .doc-b[data-caption=figure]:not([data-cont]){counter-increment:capfig;}',
'#' + HOST_ID + ' .doc-b[data-caption=table]:not([data-cont]){counter-increment:captab;}',
'#' + HOST_ID + ' .doc-b[data-caption=figure]:not([data-cont])::before{content:"Figura " counter(capfig) ". ";font-weight:700;}',
'#' + HOST_ID + ' .doc-b[data-caption=table]:not([data-cont])::before{content:"Tabla " counter(captab) ". ";font-weight:700;}',
'#' + HOST_ID + '.doc-focus .doc-bar,#' + HOST_ID + '.doc-focus .doc-formatbar,#' + HOST_ID + '.doc-focus .doc-statusbar{display:none;}',
'#' + HOST_ID + '.doc-focus .doc-b{opacity:.35;transition:opacity .15s;}',
'#' + HOST_ID + '.doc-focus .doc-b[data-cur]{opacity:1;}',
'#' + HOST_ID + ' .doc-ins{color:#0a7d33;text-decoration:underline;}',
'#' + HOST_ID + ' .doc-del{color:#c0262d;text-decoration:line-through;}',
'#' + HOST_ID + ' .doc-b[data-reading]{background:rgba(255,213,0,.25);border-radius:3px;}',
'#' + HOST_ID + ' .doc-paper{position:relative;}',
'#' + HOST_ID + ' .doc-paper-wm{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) rotate(-35deg);font:700 84px Arial,sans-serif;color:rgba(0,0,0,.07);white-space:nowrap;pointer-events:none;user-select:none;z-index:0;}',
'#' + HOST_ID + ' .doc-statusbar{flex:none;display:flex;gap:16px;padding:3px 14px;font-size:.78rem;color:var(--text2,#5a6472);border-top:1px solid var(--border,#d0d5dd);background:var(--bg2,#f3f4f6);min-height:20px;}',
'#' + HOST_ID + ' .doc-scroll{flex:1;overflow:auto;padding:24px;background:#d9dde5;}',
'#' + HOST_ID + ' .doc-paper-stack{display:flex;flex-direction:column;align-items:center;gap:22px;',
'width:max-content;min-width:100%;padding-bottom:22px;}',
'#' + HOST_ID + ' .doc-paper{box-sizing:border-box;background:#fff;color:#111;flex:0 0 auto;',
'border:1px solid #c8ccd2;box-shadow:0 2px 12px rgba(0,0,0,.25);}',
'#' + HOST_ID + ' .doc-paper-content{box-sizing:border-box;width:100%;overflow:visible;}',
'#' + HOST_ID + ' .doc-pages{display:flex;flex-direction:column;align-items:center;gap:14px;}',
'#' + HOST_ID + ' .doc-page-wrap{position:relative;box-shadow:0 4px 18px rgba(0,0,0,.45);background:#fff;}',
'#' + HOST_ID + ' .doc-page-wrap canvas{display:block;}',
'#' + HOST_ID + ' .doc-page-no{position:absolute;right:6px;bottom:4px;font-size:10px;color:#55606f;',
'background:rgba(255,255,255,.85);padding:1px 5px;border-radius:3px;}',
'#' + HOST_ID + ' .doc-empty{text-align:center;padding:70px 20px;color:var(--muted,#8b93a7);}',
'#' + HOST_ID + ' .doc-empty h3{color:inherit;margin:0 0 8px;font-size:1.15rem;}',
'#' + HOST_ID + ' .doc-empty ul{list-style:none;padding:0;margin:14px 0 0;text-align:left;display:inline-block;}',
'#' + HOST_ID + ' .doc-empty li{padding:8px 10px;border-bottom:1px solid var(--border);display:flex;gap:10px;align-items:center;}',
'#' + HOST_ID + ' .doc-toast{position:absolute;left:50%;bottom:20px;transform:translateX(-50%) translateY(8px);',
'background:var(--surface3,#22262f);border:1px solid var(--border,#2a2f3a);color:inherit;padding:8px 14px;',
'border-radius:8px;font-size:.85rem;opacity:0;pointer-events:none;transition:opacity .18s,transform .18s;max-width:80%;}',
'#' + HOST_ID + ' .doc-toast.show{opacity:1;transform:translateX(-50%) translateY(0);}',
'#' + HOST_ID + ' .doc-toast.error{border-color:#d9534f;color:#ff8a85;}',
'#' + HOST_ID + ' .doc-toast.has-action{pointer-events:auto;}',
'#' + HOST_ID + ' .doc-toast-action{margin-left:12px;background:transparent;border:0;color:var(--accent,#4da3ff);cursor:pointer;font:inherit;font-weight:600;}',
'#' + HOST_ID + ' .doc-modal-back{position:absolute;inset:0;z-index:50;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;}',
'#' + HOST_ID + ' .doc-modal{min-width:320px;max-width:90%;background:var(--surface2,#191c24);border:1px solid var(--border,#2a2f3a);border-radius:10px;padding:16px 18px;box-shadow:0 10px 30px rgba(0,0,0,.5);}',
'#' + HOST_ID + ' .doc-modal-title{font-weight:600;margin-bottom:8px;}',
'#' + HOST_ID + ' .doc-modal-msg{white-space:pre-line;opacity:.9;margin-bottom:10px;}',
'#' + HOST_ID + ' .doc-modal label{display:block;font-size:.82rem;margin-bottom:8px;opacity:.9;}',
'#' + HOST_ID + ' .doc-modal select,#' + HOST_ID + ' .doc-modal input{display:block;width:100%;margin-top:3px;height:30px;padding:3px 8px;background:var(--surface,#14161c);color:inherit;border:1px solid var(--border,#2a2f3a);border-radius:5px;font:inherit;}',
'#' + HOST_ID + ' .doc-modal-row{display:flex;justify-content:flex-end;gap:8px;margin-top:10px;}',
  '#doc-ctxmenu{position:fixed;z-index:60;min-width:230px;max-height:calc(100vh - 16px);overflow-y:auto;padding:4px;background:var(--surface2,#191c24);color:var(--text,#e6e8ee);border:1px solid var(--border,#2a2f3a);border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.45);font-size:.85rem;}',
  '#doc-ctxmenu .doc-ctx-item{display:flex;align-items:center;justify-content:space-between;gap:18px;width:100%;padding:5px 10px;border:0;border-radius:5px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;}',
  '#doc-ctxmenu .doc-ctx-item:hover:not(:disabled),#doc-ctxmenu .doc-ctx-item:focus-visible{background:var(--surface3,#22262f);outline:0;}',
  '#doc-ctxmenu .doc-ctx-item:disabled{opacity:.4;cursor:default;}',
  '#doc-ctxmenu .doc-ctx-item.danger{color:#ff8a85;}',
  '#doc-ctxmenu .doc-ctx-item.spell{font-weight:600;}',
  '#doc-ctxmenu kbd{font:inherit;font-size:.75rem;opacity:.55;}',
  '#doc-ctxmenu .doc-ctx-head{padding:6px 10px 2px;font-size:.7rem;text-transform:uppercase;letter-spacing:.05em;opacity:.55;}',
  '#doc-ctxmenu .doc-ctx-sep{height:1px;margin:4px 6px;background:var(--border,#2a2f3a);}',
'.doc-paper-stack{outline:0;cursor:text;counter-reset:docnote;}',
  '::highlight(doc-find){background:#ffe066;color:#111;}',
  '#doc-notes-panel{position:fixed;right:0;width:280px;z-index:25;display:flex;flex-direction:column;background:var(--surface,#14161c);color:var(--text,#e6e8ee);border-left:1px solid var(--border,#2a2f3a);box-shadow:-8px 0 24px rgba(0,0,0,.3);font-size:.82rem;}',
  '#doc-notes-panel .np-title{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;font-weight:700;border-bottom:1px solid var(--border,#2a2f3a);}',
  '#doc-notes-panel .np-title button{background:transparent;color:inherit;border:0;cursor:pointer;font-size:1rem;}',
  '#doc-notes-panel .np-list{flex:1;overflow:auto;padding:8px;display:flex;flex-direction:column;gap:8px;}',
  '#doc-notes-panel .np-item{padding:8px;border:1px solid var(--border,#2a2f3a);border-radius:6px;cursor:pointer;background:var(--surface2,#191c24);}',
  '#doc-notes-panel .np-item:hover{border-color:var(--accent,#4da3ff);}',
  '#doc-notes-panel .np-head{font-size:.72rem;opacity:.7;margin-bottom:3px;}',
  '#doc-notes-panel .np-quote{opacity:.75;font-style:italic;margin-bottom:4px;}',
  '#doc-notes-panel .np-text{white-space:pre-wrap;word-break:break-word;}',
  '#doc-notes-panel .np-actions{display:flex;gap:6px;margin-top:6px;}',
  '#doc-notes-panel .np-actions button{background:transparent;color:inherit;border:1px solid var(--border,#2a2f3a);border-radius:4px;padding:2px 8px;cursor:pointer;font:inherit;}',
  '#doc-notes-panel .np-empty{opacity:.65;padding:8px;}',
  '.doc-b.doc-toc{padding:4px 0 8px;cursor:default;}',
  '.doc-toc .doc-toc-title{font-size:14pt;font-weight:700;margin:0 0 6pt;}',
  '.doc-toc .doc-toc-row{display:flex;align-items:baseline;gap:6px;cursor:pointer;padding:1px 0;}',
  '.doc-toc .doc-toc-row.l2{padding-left:14pt;}.doc-toc .doc-toc-row.l3{padding-left:28pt;}',
  '.doc-toc .doc-toc-row .dots{flex:1;border-bottom:1px dotted #999;transform:translateY(-3px);}',
  '.doc-toc .doc-toc-row:hover .t{text-decoration:underline;}',
  '.doc-toc .doc-toc-empty{opacity:.6;}',
  '::highlight(doc-find-cur){background:#ff9f43;color:#111;}',
  '#doc-findbar{position:fixed;top:8px;right:28px;z-index:30;display:flex;flex-wrap:wrap;align-items:center;gap:4px;max-width:420px;padding:6px 8px;background:var(--surface,#14161c);color:var(--text,#e6e8ee);border:1px solid var(--border,#2a2f3a);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.4);font-size:.82rem;}',
  '#doc-findbar input{height:26px;padding:2px 8px;background:var(--surface2,#191c24);color:inherit;border:1px solid var(--border,#2a2f3a);border-radius:4px;font:inherit;width:150px;}',
  '#doc-findbar button{height:26px;min-width:26px;padding:0 7px;background:transparent;color:inherit;border:1px solid var(--border,#2a2f3a);border-radius:4px;font:inherit;cursor:pointer;}',
  '#doc-findbar button.on{background:var(--accent,#4da3ff);color:#06121f;}',
  '#doc-findbar .doc-find-count{min-width:62px;opacity:.7;text-align:center;}',
  '.doc-note{counter-increment:docnote;}',
  '.doc-note::after{content:counter(docnote);vertical-align:super;font-size:.7em;line-height:0;color:#2b5fb4;font-weight:600;}',
  '.doc-comment{background:#fff3b0;border-bottom:1.5px solid #e0b400;}',
  '.doc-paper-content{outline:0;}',
  // La hoja es un solo documento editable. Estas medidas son las de core/html.js
  // (lo que imprime y exporta): 17/14/12pt los titulos, 11pt el cuerpo.
  '.doc-b{position:relative;margin:0 0 8pt;max-width:none;color:#111;font-size:11pt;line-height:1.45;white-space:pre-wrap;word-wrap:break-word;outline:0;}',
  '.doc-b[data-cont]{margin-top:0 !important;text-indent:0 !important;}',
  '.doc-b[data-more]{margin-bottom:0 !important;}',
  'h1.doc-b{font-size:17pt;font-weight:700;margin:0 0 10pt;line-height:1.25;}',
  'h2.doc-b{font-size:14pt;font-weight:700;margin:16pt 0 6pt;}',
  'h3.doc-b{font-size:12pt;font-weight:700;margin:14pt 0 5pt;}',
  'blockquote.doc-b{border-left:3px solid #cfcfcf;padding-left:10pt;color:#444;margin:8pt 0;font-style:italic;}',
  'pre.doc-b{font-family:Consolas,"Cascadia Mono","Courier New",monospace;font-size:10pt;background:#f6f6f6;padding:6pt 8pt;border-radius:4px;white-space:pre-wrap;overflow-x:auto;}',
  'ul.doc-b,ol.doc-b{padding-left:28pt;}',
  'ul.doc-b[data-level="1"],ol.doc-b[data-level="1"]{margin-left:18pt;}',
  'ul.doc-b[data-level="2"],ol.doc-b[data-level="2"]{margin-left:36pt;}',
  'ul.doc-b[data-level="3"],ol.doc-b[data-level="3"]{margin-left:54pt;}',
  'ul.doc-b li,ol.doc-b li{margin:0 0 3pt;}',
  'ul.doc-b li[data-lvl="1"],ol.doc-b li[data-lvl="1"]{margin-left:22pt;}',
  'ul.doc-b li[data-lvl="2"],ol.doc-b li[data-lvl="2"]{margin-left:44pt;}',
  'ul.doc-b li[data-lvl="1"]{list-style-type:circle;}',
  'ul.doc-b li[data-lvl="2"]{list-style-type:square;}',
  // Numeracion por nivel (1. / a. / i.): contadores propios, porque el contador de la lista plana contaria todos los niveles juntos.
  'ol.doc-b{counter-reset:ln0 ln1 ln2;}',
  'ol.doc-b li{counter-increment:ln0;counter-set:ln1 0 ln2 0;}',
  'ol.doc-b li::marker{content:counter(ln0) ". ";}',
  'ol.doc-b li[data-lvl="1"]{counter-increment:ln1;counter-set:ln2 0;}',
  'ol.doc-b li[data-lvl="1"]::marker{content:counter(ln1,lower-alpha) ". ";}',
  'ol.doc-b li[data-lvl="2"]{counter-increment:ln2;counter-set:none;}',
  'ol.doc-b li[data-lvl="2"]::marker{content:counter(ln2,lower-roman) ". ";}',
  'hr.doc-b{border:0;border-top:.5pt solid #bfbfbf;margin:8pt 0;height:1px;}',
  'table.doc-b{border-collapse:collapse;width:100%;margin:0 0 8pt;font-size:10pt;}',
  'table.doc-b th,table.doc-b td{border:.5pt solid #999;padding:4pt 6pt;text-align:left;vertical-align:top;min-width:24px;}',
  'table.doc-b th{background:#eee;font-weight:600;}',
  'table.doc-b[data-borders="none"] th,table.doc-b[data-borders="none"] td{border-color:transparent;}',
  'table.doc-b[data-borders="horizontal"] th,table.doc-b[data-borders="horizontal"] td{border-left-color:transparent;border-right-color:transparent;}',
  'table.doc-b[data-borders="outer"]{outline:.5pt solid #999;outline-offset:-.5pt;}',
  'table.doc-b[data-borders="outer"] th,table.doc-b[data-borders="outer"] td{border-color:transparent;}',
  'table.doc-b.col-resizing,table.doc-b.col-resizing *{cursor:col-resize !important;user-select:none;}',
  '.doc-pagebreak{margin:8pt 0;padding:0;border-top:1px dotted #c6cad2;text-align:left;font-size:0;color:transparent;user-select:none;height:0;}',
  // Cuando el salto ya Caió en un borde de hoja, la marca sobra: solo ruido.
  '.doc-pagebreak[data-paged]{display:none;}',
  '.doc-img-block{margin:8px 0;user-select:none;}',
  '.doc-b a{color:#0563c1;}',
  '.doc-b::selection,.doc-b *::selection{background:rgba(0,120,215,.28);}',
  '.doc-b.doc-img-block.sel .doc-img-wrap{outline:2px solid var(--accent,#4da3ff);}',
'#' + BTN_ID + '.open{background:var(--surface2);color:var(--accent,#4da3ff);}',
  '.doc-pagenav{display:flex;align-items:center;gap:8px;padding:4px 10px;border-bottom:1px solid var(--border,#2a2f3a);background:var(--surface1,#f7f8fa);}',
  '.doc-pagenav[hidden]{display:none;}',
  '.doc-pagenav-info{font-size:.85rem;color:var(--text2,#5a6472);min-width:120px;text-align:center;}',
  '#' + HOST_ID + '.doc-onepage .doc-paper-stack .doc-paper{display:none;}',
  '#' + HOST_ID + '.doc-onepage .doc-paper-stack .doc-paper.cur{display:block;}',
  '.doc-paper-stack.doc-onepage > .doc-paper{display:none;}',
  '.doc-paper-stack.doc-onepage > .doc-paper.cur{display:block;}',
  // ── Tono de la hoja ──────────────────────────────────────────────────────
  // Leer en blanco puro por la noche molesta. "suave" es un papel crema y
  // "oscuro" invierte la hoja para dejarlo como el resto de la app. Solo
  // cambia como se ve: el documento sigue siendo el mismo.
  '#' + HOST_ID + '[data-paper="suave"] .doc-scroll{background:#b9b2a4;}',
  '#' + HOST_ID + '[data-paper="suave"] .doc-paper{background:#f4ecd9;color:#2b2620;border-color:#c8bfa8;box-shadow:0 2px 12px rgba(0,0,0,.28);}',
  '#' + HOST_ID + '[data-paper="suave"] .doc-b{color:#2b2620;}',
  '#' + HOST_ID + '[data-paper="suave"] blockquote.doc-b{border-left-color:#c0b393;color:#4a4237;}',
  '#' + HOST_ID + '[data-paper="suave"] pre.doc-b{background:#e7dcc4;color:#332c23;}',
  '#' + HOST_ID + '[data-paper="suave"] hr.doc-b{border-top-color:#bfb59c;}',
  '#' + HOST_ID + '[data-paper="suave"] table.doc-b th{background:#e6dcc6;}',
  '#' + HOST_ID + '[data-paper="suave"] table.doc-b td,#' + HOST_ID + '[data-paper="suave"] table.doc-b th{border-color:#c9bfa8;}',
  '#' + HOST_ID + '[data-paper="suave"] .doc-b a{color:#8a5a1e;}',
  '#' + HOST_ID + '[data-paper="suave"] .doc-paper-hf{color:#6b6252;}',
  '#' + HOST_ID + '[data-paper="suave"] .doc-pagebreak{border-top-color:#c0b7a1;}',
  '#' + HOST_ID + '[data-paper="oscuro"] .doc-scroll{background:#0f1115;}',
  '#' + HOST_ID + '[data-paper="oscuro"] .doc-paper{background:#1b1f26;color:#dfe4ec;border-color:#2b313b;box-shadow:0 2px 14px rgba(0,0,0,.6);}',
  '#' + HOST_ID + '[data-paper="oscuro"] .doc-b{color:#dfe4ec;}',
  '#' + HOST_ID + '[data-paper="oscuro"] blockquote.doc-b{border-left-color:#3d4756;color:#aab4c4;}',
  '#' + HOST_ID + '[data-paper="oscuro"] pre.doc-b{background:#232833;color:#e3e8f0;}',
  '#' + HOST_ID + '[data-paper="oscuro"] hr.doc-b{border-top-color:#39404c;}',
  '#' + HOST_ID + '[data-paper="oscuro"] table.doc-b th{background:#252b35;}',
  '#' + HOST_ID + '[data-paper="oscuro"] table.doc-b td,#' + HOST_ID + '[data-paper="oscuro"] table.doc-b th{border-color:#333b47;}',
  '#' + HOST_ID + '[data-paper="oscuro"] .doc-b a{color:#6fb3ff;}',
  '#' + HOST_ID + '[data-paper="oscuro"] .doc-paper-hf{color:#8b95a5;}',
  '#' + HOST_ID + '[data-paper="oscuro"] .doc-pagebreak{border-top-color:#39404c;}',
  '#' + HOST_ID + '[data-paper="oscuro"] .doc-b::selection,#' + HOST_ID + '[data-paper="oscuro"] .doc-b *::selection{background:rgba(111,179,255,.3);}'
  ].join('\n');

  function injectStyles() {
    if (document.getElementById('doc-editor-css')) return;
    const s = document.createElement('style');
    s.id = 'doc-editor-css';
    s.textContent = DOC_CSS;
    document.head.appendChild(s);
  }

  function injectButton() {
    if (document.getElementById(BTN_ID)) return;
    const bar = document.getElementById('topnav');
    if (!bar) return;
    const labButton = bar.querySelector('#lab-btn') || Array.from(bar.querySelectorAll('.tnbtn'))
      .find(button => button.getAttribute('onclick') === "showPanel('lab')");
    if (!labButton) return;
    const b = document.createElement('button');
    b.id = BTN_ID;
    b.className = 'tnbtn';
    b.title = 'Documentos (Ctrl+Shift+D)';
    b.innerHTML = 'MC-DOC';
    b.addEventListener('click', () => api.toggle());
    labButton.insertAdjacentElement('afterend', b);
  }

  // ── UI dentro del panel ────────────────────────────────────────────────
  function buildUI() {
    const h = host();
    if (!h || h.dataset.built) return;
    h.dataset.built = '1';
    h.innerHTML = [
'<div class="doc-bar">',
  '<span class="doc-title" id="doc-title">Documentos</span>',
  '<span class="doc-sub" id="doc-sub"></span>',
  '<div class="doc-views" id="doc-views">',
    '<button class="doc-btn on" data-view="content" title="Contenido editable">Contenido</button>',
    '<button class="doc-btn" data-view="pages" title="Paginas del PDF original">Paginas</button>',
  '</div>',
  '<button class="doc-btn" id="doc-new" title="Documento nuevo">Nuevo</button>',
  '<button class="doc-btn" id="doc-open" title="Abrir PDF, DOCX, TXT o Markdown">Abrir</button>',
  '<button class="doc-btn" id="doc-recent" title="Documentos recientes">Recientes</button>',
  '<button class="doc-btn" id="doc-undo" title="Deshacer (Ctrl+Z)" disabled>↶</button>',
  '<button class="doc-btn" id="doc-redo" title="Rehacer (Ctrl+Y)" disabled>↷</button>',
  '<button class="doc-btn" id="doc-find" title="Buscar y reemplazar">Buscar</button>',
  '<button class="doc-btn" id="doc-stats" title="Recuento de palabras y elementos">Recuento</button>',
  '<button class="doc-btn primary" id="doc-save" title="Guardar (Ctrl+S)">Guardar</button>',
  '<button class="doc-btn" id="doc-saveas" title="Guardar como DOCX, PDF, ODT, EPUB, TXT o Markdown">Guardar como</button>',
  '<button class="doc-btn" id="doc-print" title="Imprimir (Ctrl+P)">Imprimir</button>',
  '<button class="doc-btn" id="doc-track" title="Control de cambios: lo que escribas queda marcado en verde y lo que borres, tachado en rojo">Cambios</button>',
  '<button class="doc-btn" id="doc-track-acc" title="Aceptar los cambios de la selección (o de todo el documento)">✔ Aceptar</button>',
  '<button class="doc-btn" id="doc-track-rej" title="Rechazar los cambios de la selección (o de todo el documento)">✖ Rechazar</button>',
  '<button class="doc-btn" id="doc-a11y" title="Revisar accesibilidad: imágenes sin texto alternativo, títulos saltados, contraste y enlaces">♿ Accesibilidad</button>',
  '<button class="doc-btn" id="doc-hang" title="Sangría francesa (1.ª línea sale a la izquierda) en el párrafo seleccionado; otro clic la quita">⇤ Francesa</button>',
  '<button class="doc-btn" id="doc-cite" title="Insertar una cita (APA o ISO 690) y añadirla a la lista de referencias">📚 Cita</button>',
  '<button class="doc-btn" id="doc-refs" title="Ordenar (APA) o renumerar (ISO) la lista de referencias">↻ Referencias</button>',
  '<button class="doc-btn" id="doc-box" title="Cuadro de texto o forma flotante en el párrafo seleccionado">▭ Cuadro</button>',
  '<button class="doc-btn" id="doc-read" title="Leer en voz alta la selección o desde el cursor (otro clic para detener)">🔊 Leer</button>',
  '<button class="doc-btn" id="doc-merge" title="Combinar correspondencia: usa este documento como plantilla con campos {{columna}} y un CSV con los datos">Combinar</button>',
  '<button class="doc-btn" id="doc-focus" title="Modo enfoque: oculta las barras y atenúa lo que no estás escribiendo (Esc para salir)">Enfoque</button>',
  '<button class="doc-btn" id="doc-versions" title="Versiones anteriores del archivo">Versiones</button>',
'</div>',
  '<div class="doc-formatbar" id="doc-formatbar" aria-label="Formato del bloque seleccionado">',
    '<div class="doc-format-group"><label class="doc-format-label" for="doc-style">Estilo</label>',
      '<select id="doc-style" title="Cambiar estilo del bloque"><option value="paragraph">Normal</option>',
        '<option value="heading-1">Título 1</option><option value="heading-2">Título 2</option>',
        '<option value="heading-3">Título 3</option><option value="quote">Cita</option>',
        '<option value="code">Código</option></select></div>',
    '<div class="doc-format-group"><label class="doc-format-label" for="doc-font">Fuente</label>',
      '<select id="doc-font" title="Fuente del texto seleccionado" disabled><option value="">Predeterminada</option>',
        '<option value="Calibri">Calibri</option><option value="Arial">Arial</option>',
        '<option value="Times New Roman">Times New Roman</option><option value="Georgia">Georgia</option>',
        '<option value="Verdana">Verdana</option><option value="Segoe UI">Segoe UI</option>',
        '<option value="Courier New">Courier New</option><option value="Consolas">Consolas</option></select></div>',
    '<div class="doc-format-group"><label class="doc-format-label" for="doc-size">Tamaño</label>',
      '<select id="doc-size" title="Tamaño del texto seleccionado (o del bloque)"><option value="11">11</option>',
        '<option value="9">9</option><option value="10">10</option><option value="12">12</option>',
        '<option value="14">14</option><option value="16">16</option><option value="18">18</option>',
        '<option value="24">24</option><option value="36">36</option></select>',
      '<button class="doc-format-tool" data-block-toggle="bold" title="Negrita (Ctrl+B)"><b>B</b></button>',
      '<button class="doc-format-tool" data-block-toggle="italic" title="Cursiva (Ctrl+I)"><i>I</i></button>',
      '<button class="doc-format-tool" data-block-toggle="underline" title="Subrayado (Ctrl+U)"><u>U</u></button>',
      '<button class="doc-format-tool" data-inline-only="strike" title="Tachado" disabled><s>S</s></button>',
      '<label class="doc-color-wrap" title="Color del texto"><span class="doc-color-a">A</span><input type="color" id="doc-color" value="#d32f2f" disabled></label>',
      '<label class="doc-color-wrap" title="Resaltado"><span class="doc-color-h">ab</span><input type="color" id="doc-highlight" value="#ffeb3b" disabled></label>',
      '<button class="doc-format-tool" data-inline-only="clear" title="Quitar el formato del texto seleccionado" disabled>Tx</button></div>',
    '<div class="doc-format-group" aria-label="Alineación">',
      '<button class="doc-format-tool" data-block-align="left" title="Alinear a la izquierda">⇤</button>',
      '<button class="doc-format-tool" data-block-align="center" title="Centrar">↔</button>',
      '<button class="doc-format-tool" data-block-align="right" title="Alinear a la derecha">⇥</button>',
      '<button class="doc-format-tool" data-block-align="justify" title="Justificar">☰</button></div>',
    '<div class="doc-format-group" aria-label="Insertar">',
      '<button class="doc-format-tool" id="doc-ins-table" data-always title="Insertar tabla">▦ Tabla</button>',
      '<button class="doc-format-tool" id="doc-ins-lof" title="Insertar índice de figuras o de tablas">☰ Figuras</button>',
      '<button class="doc-format-tool" id="doc-ai-text" title="Asistente de texto con IA: reescribir, resumir, traducir o corregir lo seleccionado (vos decidís si lo reemplaza)">✨ IA</button>',
      '<button class="doc-format-tool" id="doc-ins-xref" title="Referencia cruzada: enlace a un título del documento (Ctrl+clic para ir)">↪ Referencia</button>',
      '<button class="doc-format-tool" id="doc-ins-sym" title="Insertar símbolo o ecuación simple">Ω Símbolos</button>',
      '<button class="doc-format-tool" id="doc-ins-toc" data-always title="Insertar tabla de contenido (se actualiza sola)">☰ Índice</button>',
      '<button class="doc-format-tool" id="doc-ins-image" data-always title="Insertar imagen (también se puede pegar o arrastrar)">🖼 Imagen</button>',
      '<button class="doc-format-tool" data-inline-only="link" title="Insertar o quitar enlace en el texto seleccionado" disabled>🔗 Enlace</button>',
      '<button class="doc-format-tool" data-inline-only="note" title="Nota al pie en el texto seleccionado (se numera sola)" disabled>¹ Nota</button>',
      '<button class="doc-format-tool" id="doc-notes-btn" data-always title="Ver todas las notas y comentarios">🗒 Panel</button>',
      '<button class="doc-format-tool" data-inline-only="comment" title="Comentar el texto seleccionado" disabled>💬 Comentar</button>',
      '<button class="doc-format-tool" id="doc-page-setup" data-always title="Configurar página: papel, orientación, márgenes, encabezado y pie">📄 Página</button>',
      '<button class="doc-format-tool" id="doc-onepage" data-always title="Mostrar de a una hoja. Los documentos de más de 20 hojas ya se abren así; este botón lo cambia">1 pág.</button>',
      '<select id="doc-zoom" data-always title="Zoom"><option value="50">50%</option><option value="75">75%</option>',
        '<option value="100" selected>100%</option><option value="125">125%</option><option value="150">150%</option><option value="200">200%</option></select>',
      '<select id="doc-paper" data-always title="Tono de la hoja para leer. No cambia el documento">' +
        '<option value="claro">Papel claro</option><option value="suave">Papel suave</option><option value="oscuro">Papel oscuro</option></select>',
      '<input type="file" id="doc-image-file" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml,image/bmp" hidden></div>',
    '<div class="doc-format-group" aria-label="Párrafo">',
      '<select id="doc-lh" title="Interlineado"><option value="">Interlineado</option><option value="1">1,0</option>',
        '<option value="1.15">1,15</option><option value="1.5">1,5</option><option value="2">2,0</option><option value="2.5">2,5</option></select>',
      '<select id="doc-sp" title="Espacio antes y después del párrafo"><option value="">Espaciado</option><option value="0,0">Sin espacio</option><option value="0,4">Compacto</option>',
        '<option value="0,8">Normal</option><option value="6,12">Abierto</option><option value="12,18">Muy abierto</option></select>',
      '<select id="doc-named" style="max-width:120px" title="Mis estilos: formatos de párrafo con nombre, disponibles en todos tus documentos"><option value="">Mis estilos</option></select>',
      '<select id="doc-caption" title="Rótulo numerado (se renumera solo)"><option value="">Rótulo</option><option value="figure">Figura n</option><option value="table">Tabla n</option></select>',
      '<select id="doc-callout" title="Cuadro de aviso"><option value="">Aviso</option><option value="info">ℹ Información</option><option value="warn">⚠ Atención</option><option value="ok">✔ Correcto</option><option value="error">✖ Error</option></select>',
      '<button class="doc-format-tool" data-block-indent="-1" title="Reducir sangría">⇤¶</button>',
      '<button class="doc-format-tool" data-block-indent="1" title="Aumentar sangría">¶⇥</button>',
      '<button class="doc-format-tool" data-style-save title="Usar el formato de este bloque como estilo de todos los bloques de su tipo (título 1, párrafo, cita...)">📌 Fijar estilo</button>',
      '<button class="doc-format-tool" data-style-reset data-always title="Quitar los estilos del documento">Sin estilos</button></div>',
    '<div class="doc-format-group" aria-label="Listas">',
      '<button class="doc-format-tool" data-block-list="bullet" title="Viñetas">•</button>',
      '<button class="doc-format-tool" data-block-list="ordered" title="Numeración">1.</button>',
      '<button class="doc-format-tool" id="doc-insert-pagebreak" title="Insertar salto de página">↵</button>',
      '<button class="doc-format-tool" data-block-move="up" title="Mover bloque arriba">↑</button>',
      '<button class="doc-format-tool" data-block-move="down" title="Mover bloque abajo">↓</button>',
      '<button class="doc-format-tool" data-block-delete title="Eliminar bloque seleccionado">×</button></div>',
  '</div>',
  '<div class="doc-objbar" id="doc-objbar" aria-label="Herramientas del objeto seleccionado"></div>',
  '<div class="doc-pagenav" id="doc-pagenav" hidden>',
    '<button class="doc-btn" id="doc-page-prev" title="Hoja anterior">◀</button>',
    '<span class="doc-pagenav-info" id="doc-pagenav-info">Hoja 1 / 1</span>',
    '<button class="doc-btn" id="doc-page-next" title="Hoja siguiente">▶</button>',
  '</div>',
'<div class="doc-table-picker" id="doc-table-picker"></div>',
'<div id="doc-warn-host"></div>',
'<div class="doc-ruler" id="doc-ruler" hidden></div>',
'<div class="doc-scroll" id="doc-scroll"><div id="doc-body"></div></div>',
'<div class="doc-statusbar" id="doc-stats" aria-live="off"></div>',
'<div class="doc-toast" id="doc-toast" role="status" aria-live="polite"></div>'].join('\n');

    h.querySelector('#doc-new').addEventListener('click', onNew);
    h.querySelector('#doc-open').addEventListener('click', onOpen);
    h.querySelector('#doc-recent').addEventListener('click', onRecents);
    h.querySelector('#doc-save').addEventListener('click', onSave);
    h.querySelector('#doc-saveas').addEventListener('click', onSaveAs);
    h.querySelector('#doc-print').addEventListener('click', onPrint);
    h.querySelector('#doc-versions').addEventListener('click', onVersions);
    h.querySelector('#doc-undo').addEventListener('click', () => travelHistory('undo'));
    h.querySelector('#doc-redo').addEventListener('click', () => travelHistory('redo'));
    h.querySelector('#doc-focus').addEventListener('click', () => toggleFocus());
    h.querySelector('#doc-merge').addEventListener('click', () => mailMerge());
    h.querySelector('#doc-read').addEventListener('click', () => toggleReadAloud());
    h.querySelector('#doc-box').addEventListener('click', () => boxDialog());
    h.querySelector('#doc-hang').addEventListener('click', () => toggleHanging());
    h.querySelector('#doc-a11y').addEventListener('click', () => a11yReview());
    setupA11y(h);
    h.querySelector('#doc-hang').addEventListener('mousedown', (e) => e.preventDefault());
    h.querySelector('#doc-cite').addEventListener('click', () => citeDialog());
    h.querySelector('#doc-cite').addEventListener('mousedown', (e) => e.preventDefault());
    h.querySelector('#doc-refs').addEventListener('click', () => sortReferences());
    h.querySelector('#doc-box').addEventListener('mousedown', (e) => e.preventDefault());
    h.querySelector('#doc-read').addEventListener('mousedown', (e) => e.preventDefault());
    h.querySelector('#doc-track').addEventListener('click', () => toggleTrack());
    h.querySelector('#doc-track-acc').addEventListener('click', () => resolveTracked(true));
    h.querySelector('#doc-track-rej').addEventListener('click', () => resolveTracked(false));
    ['#doc-track', '#doc-track-acc', '#doc-track-rej'].forEach((q) => h.querySelector(q).addEventListener('mousedown', (e) => e.preventDefault()));
    h.querySelector('#doc-find').addEventListener('click', findAndReplace);
    h.querySelector('#doc-stats').addEventListener('click', showDocumentStats);
    h.querySelector('#doc-formatbar').addEventListener('click', onFormatClick);
    h.querySelector('#doc-page-prev').addEventListener('click', () => showSheet(ui.pageIndex - 1));
    h.querySelector('#doc-page-next').addEventListener('click', () => showSheet(ui.pageIndex + 1));
    h.querySelector('#doc-style').addEventListener('change', (e) => {
      if (e.target.value === 'paragraph' || e.target.value === 'quote' || e.target.value === 'code') {
        applyBlockType(e.target.value);
      } else {
        const level = Number(e.target.value.split('-')[1]);
        if (level >= 1 && level <= 3) applyBlockType('heading', level);
      }
    });
    h.querySelector('#doc-size').addEventListener('change', (e) => {
      const pt = Number(e.target.value);
      if (pt > 0 && activeCe()) { applyInline('size', pt); return; }
      applySelectedBlock((block) => {
        const next = Object.assign({}, block);
        const size = Number(e.target.value);
        if (size > 0) next.size = size;
        else delete next.size;
        return next;
      });
    });
    h.querySelector('#doc-views').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-view]');
      if (b) setView(b.dataset.view);
    });
    const paperSel = h.querySelector('#doc-paper');
    if (paperSel) paperSel.addEventListener('change', (e) => setPaperTone(e.target.value));
    wireEditing();
  }

  function setView(v) {
    ui.view = v === 'pages' ? 'pages' : 'content';
    const h = host();
    if (!h) return;
    h.querySelectorAll('#doc-views button').forEach((b) => {
      b.classList.toggle('on', b.dataset.view === ui.view);
    });
    if (ui.view === 'pages') renderPages();
    else render();
  }

  // ── Pestaña ────────────────────────────────────────────────────────────
function ensureTab() {
    const existing = docTab();
    if (existing) return existing.id;
    if (typeof addTab !== 'function') return null;
    // Se crea con mc://doc y NO con about:blank a proposito: el webview de la
    // app convierte cualquier navegacion a about:blank de vuelta en
    // "mc://newtab" (ver el did-navigate de bindWebviewToTab), y eso borraria
    // la url de la pestaña. Con mc://doc la carga falla en silencio (no es
    // http) y la url se mantiene, tal como funciona la pestaña del Lab.
    addTab(TAB_URL);
    const t = docTab();
    return t ? t.id : null;
  }

  // El editor se identifica SIEMPRE como MC-DOC-PRO, en una burbuja que ocupa
  // toda la pestaña y sin la pelota de color (petición del usuario). Da igual si
  // hay un documento abierto o no: antes el detalle se perdía al abrir un
  // archivo. El nombre del documento sigue viéndose en el panel (título y línea
  // de información), así que no se pierde por acá. El asterisco de "sin guardar"
  // se conserva adentro de la burbuja.
  const ETIQUETA_EDITOR = 'MC-DOC-PRO';

  function setTabTitle(text) {
    const t = docTab();
    if (!t) return;
    // El texto venia con el icono adelante (📄) y un '*' de sin guardar.
    const sucio = /\s\*\s*$/.test(String(text || ''));
    const titulo = sucio ? ETIQUETA_EDITOR + ' *' : ETIQUETA_EDITOR;
    t.title = titulo;
    const te = document.querySelector('#tab-' + t.id + ' .tab-title');
    if (te) te.textContent = titulo;
    const fav = document.querySelector('#tab-' + t.id + ' .tab-favicon');
    if (fav) fav.textContent = '';
    const tab = document.getElementById('tab-' + t.id);
    if (tab) tab.classList.add('tab-mcdocpro');
    // La barra de direcciones muestra el mismo nombre en vez de mc://doc pelado.
    try {
      if (typeof state !== 'undefined' && state.activeTab === t.id) {
        const barra = document.getElementById('urlinput');
        if (barra) barra.value = ETIQUETA_EDITOR;
      }
    } catch {}
  }

  // ── Seleccion ───────────────────────────────────────────────────────────
  // La seleccion es la NATIVA del navegador (una sola superficie editable para
  // todo el documento). Aqui solo se calcula, a partir de ella, que bloques
  // toca: los botones de formato por bloque (alineacion, tipo, lista...) actuan
  // sobre esos bloques.
  function surface() {
    const h = host();
    return h ? h.querySelector('.doc-paper-stack') : null;
  }

  // Elementos de bloque en pantalla, en orden (a traves de todas las paginas).
  function topEls(st) {
    const out = [];
    (st || surface() || { querySelectorAll: () => [] }).querySelectorAll('.doc-paper-content').forEach((c) => {
      Array.from(c.children).forEach((x) => out.push(x));
    });
    return out;
  }

  function select(id) { setSelection(id ? [id] : [], id || null); }

  // `ids` en cualquier orden, `primary` manda para la barra de formato.
  function setSelection(ids, primary) {
    const h = host();
    if (!h) return;
    const list = Array.from(new Set(ids || []));
    ui.selIds = list;
    ui.selectedBlockId = primary && list.includes(primary) ? primary : (list[list.length - 1] || null);
    // Solo la imagen elegida muestra su asa de tamano.
    h.querySelectorAll('.doc-b.sel').forEach((x) => x.classList.remove('sel'));
    const one = list.length === 1 ? h.querySelector('.doc-b[data-id="' + cssEscape(list[0]) + '"]') : null;
    if (one && one.dataset.type === 'image') one.classList.add('sel');
    refreshFormatBar();
  }

  // Ids de los bloques seleccionados, en el orden del documento.
  function selectedIds() {
    const have = new Set(((ui.snap && ui.snap.doc && ui.snap.doc.blocks) || []).map((b) => b.id));
    return (ui.selIds || []).filter((id) => have.has(id));
  }

  function selectedBlocks() {
    const ids = new Set(selectedIds());
    return ((ui.snap && ui.snap.doc && ui.snap.doc.blocks) || []).filter((b) => ids.has(b.id));
  }

  const TEXT_TYPES = ['paragraph', 'heading', 'quote', 'code', 'list'];

  function selectedBlock() {
    const blocks = (ui.snap && ui.snap.doc && ui.snap.doc.blocks) || [];
    const ids = selectedIds();
    const id = ids.includes(ui.selectedBlockId) ? ui.selectedBlockId : ids[ids.length - 1];
    return id ? blocks.find((b) => b.id === id) || null : null;
  }

  // Posicion relativa de dos puntos del DOM: -1, 0 o 1 (b respecto de a).
  function pointCmp(an, ao, bn, bo) {
    const r = document.createRange();
    r.setStart(an, ao); r.collapse(true);
    return r.comparePoint(bn, bo);
  }

  // Bloques que toca la seleccion actual y celda del cursor.
  function updateSelectedBlocks() {
    const st = surface();
    const sel = window.getSelection && window.getSelection();
    if (!st || !sel || !sel.rangeCount || !st.contains(sel.anchorNode)) return;
    const r = sel.getRangeAt(0);
    const els = topEls(st);
    const ids = [];
    let focusId = null;
    const focusNode = sel.focusNode && (sel.focusNode.nodeType === 1 ? sel.focusNode : sel.focusNode.parentElement);
    els.forEach((e) => {
      if (!e.dataset.id) return;
      let hit;
      if (r.collapsed) hit = e.contains(r.startContainer);
      else {
        // Solapa de verdad: un rango que termina justo al inicio del bloque siguiente no lo toca.
        const first = placeAt(e, 0);
        const last = placeAt(e, 1e9);
        hit = pointCmp(r.startContainer, r.startOffset, last.node, last.offset) > 0 &&
          pointCmp(first.node, first.offset, r.endContainer, r.endOffset) > 0;
      }
      if (hit) ids.push(e.dataset.id);
      if (focusNode && e.contains(focusNode)) focusId = e.dataset.id;
    });
    if (!ids.length) return;
    const cur = ui.selIds || [];
    if (ids.length !== cur.length || ids.some((x, i) => x !== cur[i]) || (focusId && focusId !== ui.selectedBlockId)) {
      setSelection(ids, focusId || ids[ids.length - 1]);
    }
    ui.cellRect = selectedCellRect();
    scheduleRuler();
    const cell = focusNode && focusNode.closest && focusNode.closest('td,th');
    if (cell) {
      const bEl = cell.closest('.doc-b');
      const at = gridCoord(cell);
      if (bEl && at) ui.cell = { id: bEl.dataset.id, row: at.row, col: at.col };
    }
  }

  // Rectangulo de celdas (cuadricula) entre donde empieza y donde termina la seleccion.
  function selectedCellRect() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const cellOfNode = (n) => { const e = n && (n.nodeType === 1 ? n : n.parentElement); return e && e.closest ? e.closest('td,th') : null; };
    const a = cellOfNode(sel.anchorNode);
    const f = cellOfNode(sel.focusNode);
    if (!a || !f || a.closest('table') !== f.closest('table')) return null;
    const pa = gridCoord(a);
    const pf = gridCoord(f);
    if (!pa || !pf) return null;
    const span = (td) => [Math.max(1, parseInt(td.getAttribute('rowspan'), 10) || 1), Math.max(1, parseInt(td.getAttribute('colspan'), 10) || 1)];
    const [ra, ca] = span(a);
    const [rf, cf] = span(f);
    return {
      r1: Math.min(pa.row, pf.row), c1: Math.min(pa.col, pf.col),
      r2: Math.max(pa.row + ra - 1, pf.row + rf - 1), c2: Math.max(pa.col + ca - 1, pf.col + cf - 1)
    };
  }

  // Fila y columna (de la cuadricula, contando celdas combinadas) de una celda.
  function gridCoord(cell) {
    const tr = cell.parentElement;
    const table = tr && tr.closest('table');
    if (!table) return null;
    const trs = Array.from(table.querySelectorAll('tr'));
    const occupied = [];
    for (let r = 0; r < trs.length; r++) {
      let c = 0;
      occupied[r] = occupied[r] || [];
      for (const td of Array.from(trs[r].children).filter((x) => /^(td|th)$/i.test(x.tagName))) {
        while (occupied[r][c]) c++;
        const cs = Math.max(1, parseInt(td.getAttribute('colspan'), 10) || 1);
        const rs = Math.max(1, parseInt(td.getAttribute('rowspan'), 10) || 1);
        if (td === cell) return { row: r, col: c };
        for (let i = 0; i < rs; i++) for (let j = 0; j < cs; j++) { occupied[r + i] = occupied[r + i] || []; occupied[r + i][c + j] = true; }
        c += cs;
      }
    }
    return null;
  }

  function refreshBlockFormatBar() {
    const h = host();
    const bar = h && h.querySelector('#doc-formatbar');
    if (!bar) return;
    const block = selectedBlock();
    const supported = block && ['paragraph', 'heading', 'quote', 'code', 'list'].includes(block.type);
    bar.querySelectorAll('button,select').forEach((control) => {
      const formatOnly = control.id === 'doc-style' || control.id === 'doc-size' ||
        control.hasAttribute('data-block-toggle') || control.hasAttribute('data-block-align') ||
        control.hasAttribute('data-block-list') || control.hasAttribute('data-block-indent') || control.hasAttribute('data-style-save') ||
        control.id === 'doc-lh' || control.id === 'doc-insert-pagebreak';
      if (control.hasAttribute('data-always')) { control.disabled = !(ui.snap && ui.snap.open); return; }
      const inlineInTable = block && block.type === 'table' && control.hasAttribute('data-block-toggle');
      control.disabled = !block || (formatOnly && !supported && !inlineInTable);
    });
    if (!block) return;
    const blocks = ui.snap.doc.blocks || [];
    const index = blocks.findIndex((item) => item.id === block.id);
    bar.querySelectorAll('[data-block-move]').forEach((button) => {
      button.disabled = button.dataset.blockMove === 'up' ? index <= 0 : index < 0 || index >= blocks.length - 1;
    });
    bar.querySelector('#doc-style').value = block.type === 'heading' ? 'heading-' + (block.level || 1)
      : ['paragraph', 'quote', 'code'].includes(block.type) ? block.type : 'paragraph';
    if (!supported) return;
    bar.querySelector('#doc-size').value = String(block.size || 11);
    const lhSel = bar.querySelector('#doc-lh');
    const spSel = bar.querySelector('#doc-sp');
    if (spSel) {
      const key = block.spaceBefore != null || block.spaceAfter != null ? (block.spaceBefore || 0) + ',' + (block.spaceAfter != null ? block.spaceAfter : 8) : '';
      spSel.value = Array.from(spSel.options).some((o) => o.value === key) ? key : '';
    }
    const capSel = bar.querySelector('#doc-caption');
    if (capSel) capSel.value = block.caption || '';
    const coSel = bar.querySelector('#doc-callout');
    if (coSel) coSel.value = block.callout || '';
    if (lhSel) lhSel.value = Array.from(lhSel.options).some((o) => Number(o.value) === Number(block.lineHeight) && o.value) ? String(Number(block.lineHeight)) : '';
    bar.querySelectorAll('[data-block-toggle]').forEach((button) => {
      button.classList.toggle('active', !!block[button.dataset.blockToggle]);
    });
    bar.querySelectorAll('[data-block-align]').forEach((button) => {
      button.classList.toggle('active', (block.align || 'left') === button.dataset.blockAlign);
    });
    bar.querySelectorAll('[data-block-list]').forEach((button) => {
      button.classList.toggle('active', block.type === 'list' && block.ordered === (button.dataset.blockList === 'ordered'));
    });
  }

  function refreshFormatBar() {
    refreshBlockFormatBar();
    refreshObjectBar();
    refreshInlineState();
  }

  async function applySelectedBlock(update) {
    const ids = selectedIds();
    if (!ids.length || !ui.snap || !ui.snap.open) return;
    await flushPending();
    const multi = ids.length > 1;
    const ops = [];
    for (const id of ids) {
      const current = (ui.snap.doc.blocks || []).find((block) => block.id === id);
      if (!current) continue;
      // Con varios bloques, tablas e imagenes no entran en cambios de texto.
      if (multi && !TEXT_TYPES.includes(current.type)) continue;
      const next = update(current);
      if (next) ops.push({ op: 'replaceBlock', id, block: next });
    }
    if (!ops.length) return;
    const res = await docEdit({ expectedHash: ui.snap.doc.hash, ops });
    if (res && res.ok) {
      const keepPrimary = ui.selectedBlockId;
      applySnapshot(res); setSelection(ids, keepPrimary); scheduleAutoSave();
      // Una imagen no tiene cursor: al repintarla el navegador deja la seleccion
      // en otro bloque y la barra de objeto se vaciaba. Se vuelve a marcar.
      const only = ids.length === 1 ? ((ui.snap.doc.blocks || []).find((b) => b.id === ids[0])) : null;
      if (only && only.type === 'image') reselectBlock(only.id);
    }
    else if (res && res.error) toast(res.error, 'error');
  }

  function reselectBlock(id) {
    const st = surface();
    const node = st && st.querySelector('.doc-b[data-id="' + cssEscape(id) + '"]');
    const sel = window.getSelection && window.getSelection();
    if (!node || !sel) return;
    const range = document.createRange();
    range.selectNode(node);
    sel.removeAllRanges();
    sel.addRange(range);
    setSelection([id], id);
  }

  // Pasar de parrafo a lista (y volver) conserva el formato en linea: los tramos
  // se reparten por renglon (itemRuns) y al volver se vuelven a unir.
  function itemsOfBlock(block) {
    if (block.type === 'list') {
      return { items: (block.items || []).slice(), itemRuns: Array.isArray(block.itemRuns) ? block.itemRuns.slice() : [] };
    }
    const text = blockText(block).replace(/\r\n/g, '\n');
    const runs = runsLib ? runsLib.ofBlock(block) : [];
    const items = [];
    const itemRuns = [];
    let pos = 0;
    text.split('\n').forEach((line) => {
      const start = pos;
      pos += line.length + 1;
      if (!line.trim()) return;
      items.push(line);
      const part = runsLib && runs.length ? runsLib.slice(runs, start, start + line.length) : [];
      itemRuns.push(part.length && runsLib.hasFormatting(part) ? part : null);
    });
    return { items, itemRuns };
  }

  function runsOfList(block) {
    const items = block.items || [];
    const out = [];
    items.forEach((it, i) => {
      if (i) out.push({ text: '\n' });
      const rr = Array.isArray(block.itemRuns) ? block.itemRuns[i] : null;
      (Array.isArray(rr) && rr.length ? rr : [{ text: it }]).forEach((r) => out.push(r));
    });
    return runsLib ? runsLib.normalize(out) : out;
  }

  function applyBlockType(type, level) {
    applySelectedBlock((block) => {
      const next = Object.assign({}, block);
      if (type === 'list') {
        const got = itemsOfBlock(block);
        if (!got.items.length) return null;
        next.items = got.items;
        if (got.itemRuns.some(Boolean)) next.itemRuns = got.itemRuns; else delete next.itemRuns;
        next.ordered = block.type === 'list' ? block.ordered === true : false;
        if (block.type !== 'list') { delete next.text; delete next.runs; }
      } else if (block.type === 'list') {
        const rr = runsOfList(block);
        if (runsLib && runsLib.hasFormatting(rr)) { next.runs = rr; delete next.text; }
        else next.text = blockText(block);
        delete next.items; delete next.itemRuns; delete next.ordered;
      }
      next.type = type;
      if (type === 'heading') next.level = level || 1;
      else if (type !== 'list') delete next.level;
      return next;
    });
  }

  // Con varios bloques: si todos ya lo tienen se quita, si no se pone a todos.
  function toggleBlockFlag(key) {
    const turnOff = selectedBlocks().filter((b) => TEXT_TYPES.includes(b.type)).every((b) => b[key]);
    applySelectedBlock((block) => {
      const next = Object.assign({}, block);
      if (turnOff) delete next[key];
      else next[key] = true;
      return next;
    });
  }

  function toggleList(ordered) {
    const block = selectedBlock();
    if (!block) return;
    if (block.type === 'list' && block.ordered === ordered) applyBlockType('paragraph');
    else applySelectedBlock((current) => {
      const next = Object.assign({}, current);
      const got = itemsOfBlock(current);
      if (!got.items.length) return null;
      next.items = got.items;
      if (got.itemRuns.some(Boolean)) next.itemRuns = got.itemRuns; else delete next.itemRuns;
      next.type = 'list'; next.ordered = ordered;
      delete next.text; delete next.runs;
      return next;
    });
  }

  function onFormatClick(event) {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if (button.id === 'doc-page-setup') {
      openPageSetup();
    } else if (button.id === 'doc-onepage') {
      // Click Manual: a partir de aca manda el usuario, no la cantidad de hojas.
      ui.onePageUser = !ui.onePage;
      toggleOnePage();
    } else if (button.hasAttribute('data-style-save')) {
      saveBlockStyle();
    } else if (button.hasAttribute('data-style-reset')) {
      resetStyles();
    } else if (button.dataset.blockIndent) {
      const delta = Number(button.dataset.blockIndent);
      applySelectedBlock((block) => {
        const n = Math.min(8, Math.max(0, (Number(block.indent) || 0) + delta));
        if (n === (Number(block.indent) || 0)) return null;
        const next = Object.assign({}, block);
        if (n) next.indent = n; else delete next.indent;
        return next;
      });
    } else if (button.dataset.inlineOnly === 'link') {
      linkAction();
    } else if (button.dataset.inlineOnly === 'note' || button.dataset.inlineOnly === 'comment') {
      noteAction(button.dataset.inlineOnly);
    } else if (button.dataset.inlineOnly) {
      applyInline(button.dataset.inlineOnly);
    } else if (button.dataset.blockToggle && ['bold', 'italic', 'underline'].includes(button.dataset.blockToggle) && activeCe()) {
      applyInline(button.dataset.blockToggle);
    } else if (button.dataset.blockToggle) {
      toggleBlockFlag(button.dataset.blockToggle);
    } else if (button.dataset.blockAlign) {
      applySelectedBlock((block) => Object.assign({}, block, { align: button.dataset.blockAlign }));
    } else if (button.dataset.blockList) {
      toggleList(button.dataset.blockList === 'ordered');
    } else if (button.id === 'doc-insert-pagebreak') {
      insertSelectedPageBreak();
    } else if (button.dataset.blockMove) {
      moveSelectedBlock(button.dataset.blockMove);
    } else if (button.hasAttribute('data-block-delete')) {
      deleteSelectedBlock();
    }
  }


  // ── Menu contextual del editor ─────────────────────────────────────────
  // Reemplaza el menu generico del navegador dentro del documento. Es DOM
  // (no nativo) por la misma razon que los dialogos: el foco de Electron en
  // Windows. Los botones no roban la seleccion (mousedown se cancela), y cada
  // accion la restaura antes de actuar.
  function closeContextMenu() {
    const m = document.getElementById('doc-ctxmenu');
    if (m) m.remove();
    ui.ctxCleanup && ui.ctxCleanup();
    ui.ctxCleanup = null;
  }

  async function clipboardText() {
    try { return String(await navigator.clipboard.readText()); } catch (e) { return null; }
  }

  function insertPlainText(ce, text) {
    ce.focus({ preventScroll: true });
    let ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch (e) { ok = false; }
    if (!ok) {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      const r = sel.getRangeAt(0);
      r.deleteContents();
      const node = document.createTextNode(text);
      r.insertNode(node);
      r.setStartAfter(node); r.collapse(true);
      sel.removeAllRanges(); sel.addRange(r);
    }
    markDirty();
    flushPending();
  }

  async function duplicateSelectedBlock() {
    const ids = selectedIds();
    if (!ids.length || !ui.snap) return;
    await flushPending();
    const blocks = ui.snap.doc.blocks || [];
    const chosen = new Set(ids);
    const idx = blocks.map((b, i) => (chosen.has(b.id) ? i : -1)).filter((i) => i >= 0);
    const last = idx[idx.length - 1];
    const copies = idx.map((i) => { const c = Object.assign({}, blocks[i]); delete c.id; return c; });
    const res = await docEdit({ expectedHash: ui.snap.doc.hash, ops: [{ op: 'insertBlocks', index: last + 1, blocks: copies }] });
    if (res && res.ok) {
      const newIds = (res.doc.blocks || []).slice(last + 1, last + 1 + copies.length).map((b) => b.id);
      applySnapshot(res);
      setSelection(newIds, newIds[newIds.length - 1]);
    } else if (res && res.error) toast(res.error, 'error');
  }

  function contextMenuItems(ctx) {
    const { ce, hasSel, block, inCell, bEl, count } = ctx;
    const items = [];
    const sep = () => { if (items.length && items[items.length - 1].sep !== true) items.push({ sep: true }); };
    const head = (label) => { sep(); items.push({ head: label }); };
    const inline = (label, action, value) => ({ label, inline: true, run: () => applyInline(action, value) });

    if (ce) {
      items.push({ label: 'Cortar', hint: 'Ctrl+X', disabled: !hasSel, inline: true, run: () => { try { document.execCommand('cut'); } catch (e) { /* sin portapapeles */ } } });
      items.push({ label: 'Copiar', hint: 'Ctrl+C', disabled: !hasSel, inline: true, run: () => { try { document.execCommand('copy'); } catch (e) { /* sin portapapeles */ } } });
      items.push({ label: 'Pegar sin formato', hint: 'Ctrl+Shift+V', inline: true, run: async () => {
        const t = await clipboardText();
        if (t == null) { toast('El portapapeles no esta disponible: usa Ctrl+V', 'error'); return; }
        if (t) insertPlainText(ce, t);
      } });
      items.push({ label: 'Seleccionar todo', hint: 'Ctrl+A', inline: true, run: () => {
        const r = document.createRange(); r.selectNodeContents(ce);
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
      } });
      head('Formato');
      items.push(inline('Negrita', 'bold'), inline('Cursiva', 'italic'), inline('Subrayado', 'underline'), inline('Tachado', 'strike'));
      items.push({ label: 'Color del texto…', inline: true, run: () => openColorPicker('color') });
      items.push({ label: 'Color de fondo…', inline: true, run: () => openColorPicker('highlight') });
      items.push({ label: 'Enlace…', inline: true, run: () => linkAction() });
      items.push({ label: 'Sinónimos…', hint: 'Mayús+F7', inline: true, run: () => synonymsAssist() });
      items.push({ label: 'Nota al pie…', inline: true, run: () => noteAction('note') });
      items.push({ label: 'Comentario…', inline: true, run: () => noteAction('comment') });
      if (window.getSelection().anchorNode && window.getSelection().anchorNode.parentElement && window.getSelection().anchorNode.parentElement.closest('a')) items.push(inline('Quitar enlace', 'unlink'));
      items.push(inline('Quitar formato', 'clear'));
    }
    if (block && !inCell) {
      head(count > 1 ? 'Convertir ' + count + ' bloques en' : 'Convertir en');
      const t = block.type;
      if (t !== 'paragraph') items.push({ label: 'Párrafo', run: () => applyBlockType('paragraph') });
      [1, 2, 3].forEach((l) => items.push({ label: 'Título ' + l, run: () => applyBlockType('heading', l) }));
      items.push({ label: 'Cita', run: () => applyBlockType('quote') });
      items.push({ label: 'Código', run: () => applyBlockType('code') });
      items.push({ label: 'Lista con viñetas', run: () => toggleList(false) });
      items.push({ label: 'Lista numerada', run: () => toggleList(true) });
    } else if (block && block.type === 'list') {
      head('Lista');
      items.push({ label: 'Con viñetas', run: () => toggleList(false) }, { label: 'Numerada', run: () => toggleList(true) });
    }
    if (block && block.type === 'table') {
      head('Tabla');
      [['addRowBefore', 'Insertar fila arriba'], ['addRowAfter', 'Insertar fila abajo'], ['addColBefore', 'Insertar columna a la izquierda'],
        ['addColAfter', 'Insertar columna a la derecha'], ['deleteRow', 'Eliminar fila'], ['deleteCol', 'Eliminar columna'],
        ['merge', 'Combinar celdas seleccionadas'], ['unmerge', 'Separar celda combinada'],
        ['header', block.header === false ? 'Primera fila como encabezado' : 'Quitar encabezado']]
        .forEach(([a, l]) => items.push({ label: l, run: () => tableAction(a) }));
    }
    if (block && block.type === 'image') {
      head('Imagen');
      [25, 50, 75, 100].forEach((pct) => items.push({ label: 'Ancho ' + pct + '%', run: () => setImageWidth(Math.round(contentWidthPx() * pct / 100)) }));
    }
    if (block) {
      head('Bloque');
      items.push({ label: 'Subir', run: () => moveSelectedBlock('up') }, { label: 'Bajar', run: () => moveSelectedBlock('down') });
      items.push({ label: 'Duplicar', run: duplicateSelectedBlock });
      items.push({ label: 'Eliminar', danger: true, run: deleteSelectedBlock });
    }
    head('Insertar');
    items.push({ label: 'Tabla…', run: () => { const b = el('doc-ins-table'); if (b) b.click(); } });
    items.push({ label: 'Imagen…', run: () => { const b = el('doc-ins-image'); if (b) b.click(); } });
    items.push({ label: 'Salto de página', run: insertSelectedPageBreak });
    items.push({ label: 'Tabla de contenido', run: insertTableOfContents });
    head('Documento');
    items.push({ label: 'Buscar y reemplazar…', hint: 'Ctrl+F', run: findAndReplace });
    const h = ui.snap && ui.snap.history;
    items.push({ label: 'Deshacer', hint: 'Ctrl+Z', disabled: !(h && h.canUndo), run: () => travelHistory('undo') });
    items.push({ label: 'Rehacer', hint: 'Ctrl+Y', disabled: !(h && h.canRedo), run: () => travelHistory('redo') });
    return items;
  }

  // Palabra bajo el punto (x, y) dentro de un contenteditable: rango y texto.
  function wordRangeAt(ce, x, y) {
    let r = null;
    if (document.caretRangeFromPoint) r = document.caretRangeFromPoint(x, y);
    if (!r || !ce.contains(r.startContainer) || r.startContainer.nodeType !== 3) return null;
    const node = r.startContainer;
    const text = node.nodeValue || '';
    const isW = (c) => /[\p{L}\p{M}\p{N}'’_-]/u.test(c);
    let a = r.startOffset, b = r.startOffset;
    while (a > 0 && isW(text[a - 1])) a--;
    while (b < text.length && isW(text[b])) b++;
    if (a === b) return null;
    const range = document.createRange();
    range.setStart(node, a); range.setEnd(node, b);
    return { range, word: text.slice(a, b) };
  }

  // Llega del main (doc:spell) con la palabra mal escrita del clic derecho.
  function addSpellItems(payload) {
    const menu = document.getElementById('doc-ctxmenu');
    const at = ui.ctxWord;
    if (!menu || !at || !payload || !payload.word) return;
    const norm = (w) => String(w).replace(/^[-'’_]+|[-'’_]+$/g, '');
    if (norm(at.word) !== norm(payload.word)) return;
    if (menu.querySelector('[data-spell]')) return;
    const frag = document.createDocumentFragment();
    const mk = (label, fn, cls) => {
      const b = document.createElement('button');
      b.type = 'button'; b.setAttribute('role', 'menuitem');
      b.className = 'doc-ctx-item' + (cls ? ' ' + cls : '');
      b.innerHTML = '<span></span><kbd></kbd>';
      b.firstChild.textContent = label;
      if (!fn) b.disabled = true;
      else b.addEventListener('click', async () => { closeContextMenu(); try { await fn(); } catch (e) { toast('No se pudo completar la accion', 'error'); } });
      frag.appendChild(b);
    };
    const replaceWith = (text) => () => {
      const ce = ceOf(at.range.startContainer);
      if (!ce) return;
      ce.focus({ preventScroll: true });
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(at.range);
      insertPlainText(ce, text);
    };
    const hd = document.createElement('div');
    hd.className = 'doc-ctx-head'; hd.setAttribute('data-spell', '1'); hd.textContent = 'Ortografía: «' + payload.word + '»';
    frag.appendChild(hd);
    if (payload.suggestions && payload.suggestions.length) payload.suggestions.forEach((sg) => mk(sg, replaceWith(sg), 'spell'));
    else mk('Sin sugerencias', null);
    if (API.docSpellAdd) mk('Agregar al diccionario', async () => { await API.docSpellAdd(payload.word); toast('«' + payload.word + '» agregada al diccionario'); });
    const sp = document.createElement('div');
    sp.className = 'doc-ctx-sep';
    frag.appendChild(sp);
    menu.insertBefore(frag, menu.firstChild);
  }

  function showContextMenu(e) {
    const bEl = e.target.closest && e.target.closest('.doc-b');
    const st = surface();
    const ce = bEl && st && st.contains(bEl) && bEl.getAttribute('contenteditable') !== 'false' ? st : null;
    closeContextMenu();
    updateSelectedBlocks();
    const cell = e.target.closest && e.target.closest('td,th');
    if (cell && bEl) { const at = gridCoord(cell); if (at) ui.cell = { id: bEl.dataset.id, row: at.row, col: at.col }; }
    const sel = window.getSelection();
    const inside = !!(ce && sel && sel.rangeCount && ce.contains(sel.getRangeAt(0).startContainer));
    const hasSel = !!(inside && !sel.isCollapsed);
    if (inside) {
      ui.savedCe = ce; ui.savedRange = sel.getRangeAt(0).cloneRange();
    } else if (ce) {
      // Clic derecho sin seleccion: el cursor se lleva al punto del clic.
      let r = null;
      if (document.caretRangeFromPoint) r = document.caretRangeFromPoint(e.clientX, e.clientY);
      if (r && ce.contains(r.startContainer)) { sel.removeAllRanges(); sel.addRange(r); ui.savedCe = ce; ui.savedRange = r.cloneRange(); updateSelectedBlocks(); }
    }
    ui.ctxWord = ce ? wordRangeAt(ce, e.clientX, e.clientY) : null;
    const blocks = (ui.snap && ui.snap.doc && ui.snap.doc.blocks) || [];
    const block = bEl && !(ui.selIds && ui.selIds.length > 1) ? blocks.find((b) => b.id === bEl.dataset.id) || null : selectedBlock();
    const items = contextMenuItems({ ce, hasSel, block, bEl, inCell: !!cell, count: selectedIds().length });

    const menu = document.createElement('div');
    menu.id = 'doc-ctxmenu';
    menu.setAttribute('role', 'menu');
    items.forEach((it) => {
      if (it.sep) { const d = document.createElement('div'); d.className = 'doc-ctx-sep'; menu.appendChild(d); return; }
      if (it.head) { const d = document.createElement('div'); d.className = 'doc-ctx-head'; d.textContent = it.head; menu.appendChild(d); return; }
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.className = 'doc-ctx-item' + (it.danger ? ' danger' : '');
      b.disabled = !!it.disabled;
      b.innerHTML = '<span></span><kbd></kbd>';
      b.firstChild.textContent = it.label;
      b.lastChild.textContent = it.hint || '';
      b.addEventListener('click', async () => {
        closeContextMenu();
        if (it.inline) { if (liveCe() !== ui.savedCe) restoreSavedSelection(); }
        try { await it.run(); } catch (err) { toast('No se pudo completar la accion', 'error'); }
      });
      menu.appendChild(b);
    });
    // Cancelar mousedown evita que el menu le quite el foco o la seleccion al texto.
    menu.addEventListener('mousedown', (ev) => ev.preventDefault());
    const hostEl = host() || document.body;
    hostEl.appendChild(menu);
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    let x = e.clientX, y = e.clientY;
    if (x + mw > window.innerWidth - 4) x = Math.max(4, window.innerWidth - mw - 4);
    if (y + mh > window.innerHeight - 4) y = Math.max(4, window.innerHeight - mh - 4);
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    const away = (ev) => { if (!menu.contains(ev.target)) closeContextMenu(); };
    const esc = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); closeContextMenu(); } };
    document.addEventListener('mousedown', away, true);
    document.addEventListener('keydown', esc, true);
    window.addEventListener('blur', closeContextMenu);
    const body = el('doc-body');
    body && body.addEventListener('scroll', closeContextMenu, { once: true });
    ui.ctxCleanup = () => {
      document.removeEventListener('mousedown', away, true);
      document.removeEventListener('keydown', esc, true);
      window.removeEventListener('blur', closeContextMenu);
    };
    // Sugerencias: consulta directa al corrector; el aviso del main (doc:spell) llega
    // por otro camino y solo se usa si esta consulta no dio nada.
    if (ui.ctxWord && API.docSpellWord) {
      const r = API.docSpellWord(ui.ctxWord.word);
      if (r && r.misspelled) { ui.ctxWord.done = true; addSpellItems({ word: r.word, suggestions: r.suggestions }); }
      // Si ningun camino trae nada, el menu lo dice (y de que lado quedo la consulta).
      const w0 = ui.ctxWord.word;
      setTimeout(() => {
        const m = document.getElementById('doc-ctxmenu');
        if (!m || m.querySelector('[data-spell]')) return;
        const d = document.createElement('div');
        d.className = 'doc-ctx-head'; d.setAttribute('data-spell', '0');
        d.textContent = 'Ortografía «' + w0 + '»: sin sugerencias (' + (!r ? 'consulta no disponible' : 'el corrector la da por buena') + ')';
        m.insertBefore(d, m.firstChild);
      }, 500);
    }
    const first = menu.querySelector('button:not([disabled])');
    if (first) first.tabIndex = -1;
  }

  // ── Estilos del documento (hito 4) ─────────────────────────────────────
  const STYLE_PROPS = ['size', 'color', 'bold', 'italic', 'align', 'lineHeight'];

  // Estilos propios con nombre: se guardan en el navegador (valen para todos los
  // documentos) y al aplicarlos copian su formato al bloque.
  const NAMED_KEYS = ['bold', 'italic', 'underline', 'align', 'color', 'size', 'indent', 'firstLine', 'hanging', 'lineHeight', 'spaceBefore', 'spaceAfter'];
  const NAMED_LS = 'mcdoc.namedStyles';
  function loadNamed() {
    try {
      const o = JSON.parse(localStorage.getItem(NAMED_LS) || '{}');
      return o && typeof o === 'object' ? o : {};
    } catch (e) { return {}; }
  }
  function storeNamed(o) { try { localStorage.setItem(NAMED_LS, JSON.stringify(o)); } catch (e) { toast('No se pudo guardar el estilo en este navegador', 'error'); } }

  function paintNamedStyles() {
    const sel = el('doc-named');
    if (!sel) return;
    const names = Object.keys(loadNamed());
    sel.innerHTML = '<option value="">Mis estilos</option>' + names.map((n) => '<option value="use:' + esc(n) + '">' + esc(n) + '</option>').join('') +
      '<option value="save">＋ Guardar como estilo…</option>' + (names.length ? '<option value="del">🗑 Borrar un estilo…</option>' : '');
  }

  async function onNamedStyle(v) {
    if (!v) return;
    const all = loadNamed();
    if (v === 'save') {
      const block = selectedBlock();
      if (!block) { toast('Elegí un bloque con el formato que querés guardar', 'error'); return; }
      await flushPending();
      const cur = (ui.snap.doc.blocks || []).find((b) => b.id === block.id) || block;
      const set = {};
      NAMED_KEYS.forEach((k) => { if (cur[k] != null && cur[k] !== false) set[k] = cur[k]; });
      if (!Object.keys(set).length) { toast('Este bloque no tiene formato propio para guardar (tamaño, color, alineación, espaciado…)', 'error'); return; }
      const r = await modal({ title: 'Guardar estilo', message: 'Se guarda el formato de este bloque: ' + Object.keys(set).join(', ') + '.', fields: [{ name: 'name', label: 'Nombre del estilo', value: '' }], ok: 'Guardar' });
      const name = r && String(r.name || '').replace(/[<>"&]/g, '').trim().slice(0, 24);
      if (!name) return;
      if (!all[name] && Object.keys(all).length >= 20) { toast('Máximo 20 estilos propios', 'error'); return; }
      all[name] = set;
      storeNamed(all); paintNamedStyles();
      toast('Estilo «' + name + '» guardado');
      return;
    }
    if (v === 'del') {
      const names = Object.keys(all);
      const r = await modal({ title: 'Borrar estilo', fields: [{ name: 'name', label: 'Estilo', value: names[0], options: names.map((n) => [n, n]) }], ok: 'Borrar' });
      if (!r || !all[r.name]) return;
      delete all[r.name];
      storeNamed(all); paintNamedStyles();
      return;
    }
    if (v.startsWith('use:')) {
      const st = all[v.slice(4)];
      if (!st) return;
      await applySelectedBlock((block) => {
        if (!['paragraph', 'quote', 'heading', 'list'].includes(block.type)) return null;
        const next = Object.assign({}, block);
        NAMED_KEYS.forEach((k) => { delete next[k]; });
        Object.assign(next, st);
        return next;
      });
    }
  }
  const STYLE_NAMES = { heading1: 'Título 1', heading2: 'Título 2', heading3: 'Título 3', paragraph: 'Normal', quote: 'Cita', code: 'Código' };

  // Como "actualizar estilo desde la seleccion" de Word: el formato del bloque
  // pasa a ser el de TODOS los bloques de su tipo, y al bloque se le quita lo
  // que ahora hereda del estilo.
  async function saveBlockStyle() {
    const block = selectedBlock();
    const M = window.MCDoc && window.MCDoc.model;
    const key = block && M && M.styleKeyOf ? M.styleKeyOf(block) : null;
    if (!key) { toast('Elegí un título, párrafo, cita o bloque de código', 'error'); return; }
    await flushPending();
    const cur = (ui.snap.doc.blocks || []).find((b) => b.id === block.id);
    if (!cur) return;
    const set = {};
    STYLE_PROPS.forEach((k) => { if (cur[k] != null && cur[k] !== false) set[k] = cur[k]; });
    // Una fuente uniforme en todos los tramos tambien cuenta.
    if (Array.isArray(cur.runs) && cur.runs.length && cur.runs.every((r) => r.font && r.font === cur.runs[0].font)) set.font = cur.runs[0].font;
    if (!Object.keys(set).length) { toast('Este bloque no tiene formato propio para fijar (tamaño, color, negrita, alineación…)', 'error'); return; }
    const next = Object.assign({}, cur);
    STYLE_PROPS.forEach((k) => { if (k in set) delete next[k]; });
    if (set.font && Array.isArray(next.runs)) next.runs = next.runs.map((r) => { const c = Object.assign({}, r); delete c.font; return c; });
    const res = await docEdit({ expectedHash: ui.snap.doc.hash, ops: [
      { op: 'styles', set: { [key]: set } },
      { op: 'replaceBlock', id: cur.id, block: next }
    ] });
    if (res && res.ok) {
      applySnapshot(res); select(cur.id); scheduleAutoSave();
      toast('Estilo «' + STYLE_NAMES[key] + '» actualizado', null, { label: 'Deshacer', run: () => travelHistory('undo') });
    } else if (res && res.error) toast(res.error, 'error');
  }

  async function resetStyles() {
    if (!ui.snap || !ui.snap.open || !ui.snap.doc.styles) { toast('El documento no tiene estilos propios'); return; }
    await flushPending();
    const res = await docEdit({ expectedHash: ui.snap.doc.hash, ops: [{ op: 'styles', clear: 'all' }] });
    if (res && res.ok) {
      applySnapshot(res); scheduleAutoSave();
      toast('Estilos quitados', null, { label: 'Deshacer', run: () => travelHistory('undo') });
    } else if (res && res.error) toast(res.error, 'error');
  }

  // Las reglas de estilo del documento se pintan en una hoja propia, despues de
  // la del editor, y el formato propio de un bloque (style="") sigue ganando.
  function applyDocStyles() {
    let tag = document.getElementById('doc-doc-styles');
    if (!tag) { tag = document.createElement('style'); tag.id = 'doc-doc-styles'; document.head.appendChild(tag); }
    const styles = ui.snap && ui.snap.doc && ui.snap.doc.styles;
    tag.textContent = styles && html && html.stylesCss ? html.stylesCss(styles, '', '.doc-b') : '';
  }

  // ── Tono de la hoja ────────────────────────────────────────────────────
  // Leer horas en blanco puro cansa la vista, sobre todo de noche. El tono es
  // una preferencia de la app (no del documento): se guarda en la config para
  // que siga igual al abrir cualquier archivo y no se toca el archivo al
  // guardarlo.
  const PAPER_TONES = ['claro', 'suave', 'oscuro'];

  function paperTone(v) {
    const s = String(v == null ? '' : v).toLowerCase().trim();
    return PAPER_TONES.indexOf(s) !== -1 ? s : 'claro';
  }

  function applyPaperTone() {
    const h = host();
    if (h) h.setAttribute('data-paper', ui.paperTone);
    const sel = el('doc-paper');
    if (sel && sel.value !== ui.paperTone) sel.value = ui.paperTone;
  }

  async function loadPaperTone() {
    if (!API.getCfg) return;
    try {
      const cfg = await API.getCfg();
      ui.paperTone = paperTone(cfg && cfg.docPaper);
    } catch {}
    applyPaperTone();
  }

  async function setPaperTone(v) {
    ui.paperTone = paperTone(v);
    applyPaperTone();
    if (API.updateCfg) { try { await API.updateCfg({ docPaper: ui.paperTone }); } catch {} }
  }

  // ── Pagina, enlaces y zoom (hito 3) ────────────────────────────────────
  async function openPageSetup() {
    if (!pageLib || !ui.snap || !ui.snap.open) return;
    await flushPending();
    const page = ui.snap.doc.page || {};
    const paper = pageLib.paperOf(page);
    const r = await modal({
      title: 'Configurar página',
      fields: [
        { name: 'orientation', label: 'Orientación', value: pageLib.orientationOf(page),
          options: [['portrait', 'Vertical'], ['landscape', 'Horizontal']] },
        { name: 'paper', label: 'Papel', value: paper === 'custom' ? '' : paper,
          options: [['', paper === 'custom' ? 'Personalizado (actual)' : 'Actual'], ['A4', 'A4'], ['LETTER', 'Carta'],
            ['LEGAL', 'Legal'], ['A5', 'A5'],
            ['A6', 'A6 (libro chico)'], ['B6', 'B6 (12,5x17,6)'], ['B5', 'B5 (17,6x25)'],
            ['LIB_13X18', 'Tasca 13x18'], ['LIB_17X22', 'Novela 17x22']] },
        { name: 'margin', label: 'Márgenes', value: '',
          options: [['', 'Actuales'], ['normal', 'Normal (2 cm)'], ['narrow', 'Estrechos (1,3 cm)'], ['wide', 'Anchos (3 cm)']] },
        { name: 'header', label: 'Encabezado (usá {n} y {total})', value: page.header || '' },
        { name: 'footer', label: 'Pie de página (ej.: Página {n} de {total})', value: page.footer || '' },
        { name: 'pageNumbers', label: 'Número de página', value: page.pageNumbers || 'none',
          options: [['none', 'Sin números'], ['left', 'Izquierda'], ['center', 'Centro'], ['right', 'Derecha']] },
        { name: 'pageStart', label: 'Empezar a numerar en', value: String(page.pageStart || 1) },
        { name: 'titlePage', label: 'Primera página', value: page.titlePage ? '1' : '',
          options: [['', 'Con encabezado y pie'], ['1', 'Sin encabezado ni pie (portada)']] },
        { name: 'watermark', label: 'Marca de agua (texto, vacío = ninguna)', value: page.watermark || '' },
        { name: 'columns', label: 'Columnas (PDF, DOCX y vista previa)', value: String(page.columns || 1), options: [['1', 'Una'], ['2', 'Dos'], ['3', 'Tres']] },
        { name: 'endnotes', label: 'Notas', value: page.endnotes ? '1' : '', options: [['', 'Al pie de página'], ['1', 'Al final del documento']] }
      ],
      ok: 'Aplicar'
    });
    if (!r) return;
    const op = { op: 'page', header: r.header, footer: r.footer, pageNumbers: r.pageNumbers, orientation: r.orientation,
      watermark: r.watermark || '', titlePage: r.titlePage === '1', pageStart: Number(r.pageStart) > 1 ? Number(r.pageStart) : 1, endnotes: r.endnotes === '1', columns: Number(r.columns) || 1 };
    if (r.paper) op.paper = r.paper;
    if (r.margin) op.margin = r.margin;
    const res = await docEdit({ expectedHash: ui.snap.doc.hash, ops: [op] });
    if (res && res.ok) { applySnapshot(res); scheduleAutoSave(); }
    else if (res && res.error) toast(res.error, 'error');
  }

  function normalizeUrl(raw) {
    const v = String(raw || '').trim();
    if (!v) return '';
    if (/^(https?:\/\/|mailto:)/i.test(v)) return v;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return 'mailto:' + v;
    if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(v)) return 'https://' + v;
    return v;
  }

  async function linkAction() {
    const ce = activeCe();
    if (!ce) { toast('Seleccioná el texto que querés convertir en enlace', 'error'); return; }
    // Al abrir el dialogo el foco se va al campo: la seleccion se guarda ahora.
    const sel = window.getSelection && window.getSelection();
    const range = sel && sel.rangeCount && ce.contains(sel.getRangeAt(0).commonAncestorContainer)
      ? sel.getRangeAt(0).cloneRange() : ui.savedRange;
    const insideLink = !!(sel && sel.rangeCount && sel.anchorNode &&
      (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement).closest('a'));
    const r = await modal({
      title: 'Enlace',
      message: 'Dejá la dirección vacía para quitar el enlace.',
      fields: [{ name: 'url', label: 'Dirección (https://… o correo)', value: insideLink ? (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement).closest('a').getAttribute('href') : '' }],
      ok: 'Aplicar'
    });
    if (!r) return;
    if (range) {
      ui.savedRange = range; ui.savedCe = ce;
      ce.focus({ preventScroll: true });
      const cur = window.getSelection();
      cur.removeAllRanges();
      cur.addRange(range);
    }
    const url = normalizeUrl(r.url);
    if (!url) { await applyInline('unlink'); return; }
    if (!(window.MCDoc && window.MCDoc.model && window.MCDoc.model.isSafeLink(url))) {
      toast('Solo se admiten enlaces http, https o mailto', 'error');
      return;
    }
    await applyInline('link', url);
  }

  // Nota al pie / comentario: el texto elegido se envuelve en un span con
  // data-note / data-comment; el modelo lo lee como propiedad del tramo.
  // Panel lateral con las notas y comentarios del documento, en orden.
  const sidePanel = { open: false };
  function noteSpans() {
    const st = surface();
    return st ? Array.from(st.querySelectorAll('[data-comment],[data-note]')) : [];
  }

  // Un comentario es un hilo: "[Autor|fecha] texto ‖ [Autor|fecha] respuesta".
  const THREAD_SEP = ' ‖ ';
  function parseThread(s) {
    return String(s || '').split(THREAD_SEP).map((part) => {
      const m = /^\[([^|\]]*)\|([^\]]*)\]\s*([\s\S]*)$/.exec(part);
      return m ? { who: m[1], when: m[2].replace('T', ' ').replace(/Z$/, ''), text: m[3] } : { who: '', when: '', text: part };
    });
  }
  function commentStamp() {
    const meta = ui.snap && ui.snap.doc && ui.snap.doc.meta;
    const who = ((meta && meta.author) || 'Autor').replace(/[|\]\[]/g, ' ').trim() || 'Autor';
    return '[' + who + '|' + new Date().toISOString().slice(0, 16) + '] ';
  }

  function paintNotesPanel() {
    const box = el('doc-notes-panel');
    if (!box) return;
    const spans = noteSpans();
    const list = box.querySelector('.np-list');
    const sig = spans.map((x) => (x.dataset.comment ? 'c:' : 'n:') + (x.dataset.comment || x.dataset.note) + '|' + x.textContent).join('\n');
    if (list.dataset.sig === sig) return;
    list.dataset.sig = sig;
    list.innerHTML = spans.length ? spans.map((x, i) => {
      const isC = x.hasAttribute('data-comment');
      const txt = x.dataset.comment || x.dataset.note;
      const thread = isC ? parseThread(txt) : null;
      const quote = x.textContent.replace(/\s+/g, ' ').trim();
      return '<div class="np-item" data-i="' + i + '"><div class="np-head">' + (isC ? '💬 Comentario' : '¹ Nota al pie') +
        '</div><div class="np-quote">“' + esc(quote.length > 70 ? quote.slice(0, 70) + '…' : quote) + '”</div>' +
        (thread ? thread.map((t) => '<div class="np-text">' + (t.who ? '<b>' + esc(t.who) + '</b> <small style="opacity:.6">' + esc(t.when) + '</small><br>' : '') + esc(t.text) + '</div>').join('')
          : '<div class="np-text">' + esc(txt) + '</div>') +
        '<div class="np-actions">' + (isC ? '<button type="button" data-act="reply">Responder</button>' : '') + '<button type="button" data-act="edit">Editar</button><button type="button" data-act="del">' + (isC ? 'Resolver' : 'Quitar') + '</button></div></div>';
    }).join('') : '<div class="np-empty">Todavía no hay notas ni comentarios. Seleccioná texto y usá «Nota» o «Comentar».</div>';
  }

  function toggleNotesPanel(force) {
    const h = host();
    if (!h) return;
    const want = force == null ? !sidePanel.open : !!force;
    let box = el('doc-notes-panel');
    sidePanel.open = want;
    const btn = el('doc-notes-btn');
    if (btn) btn.classList.toggle('active', want);
    if (!want) { if (box) box.remove(); return; }
    if (!box) {
      box = document.createElement('aside');
      box.id = 'doc-notes-panel';
      box.innerHTML = '<div class="np-title">Notas y comentarios<button type="button" data-act="close" title="Cerrar">✕</button></div><div class="np-list"></div>';
      const sc = el('doc-scroll');
      (sc && sc.parentElement ? sc.parentElement : h).appendChild(box);
      if (sc) { const rc = sc.getBoundingClientRect(); box.style.top = Math.round(rc.top) + 'px'; box.style.height = Math.round(rc.height) + 'px'; }
      box.addEventListener('click', async (e) => {
        const b = e.target.closest('button');
        if (b && b.dataset.act === 'close') { toggleNotesPanel(false); return; }
        const item = e.target.closest('.np-item');
        if (!item) return;
        const span = noteSpans()[Number(item.dataset.i)];
        if (!span) return;
        span.scrollIntoView({ block: 'center', behavior: 'smooth' });
        const range = document.createRange();
        range.selectNodeContents(span);
        const sel = window.getSelection();
        sel.removeAllRanges(); sel.addRange(range);
        ui.savedRange = range.cloneRange(); ui.savedCe = surface();
        if (!b) return;
        const kind = span.hasAttribute('data-comment') ? 'comment' : 'note';
        if (b.dataset.act === 'del') { surface().focus({ preventScroll: true }); await applyInline(kind, ''); }
        else if (b.dataset.act === 'edit') noteAction(kind);
        else if (b.dataset.act === 'reply') replyComment(span);
      });
    }
    box.querySelector(".np-list").dataset.sig = ""; paintNotesPanel();
  }

  async function replyComment(span) {
    const cur = span.getAttribute('data-comment') || '';
    const r = await modal({ title: 'Responder', message: 'Se agrega al hilo del comentario.', fields: [{ name: 'text', label: 'Respuesta', value: '' }], ok: 'Responder' });
    if (!r || !String(r.text || '').trim()) return;
    const next = (cur + THREAD_SEP + commentStamp() + String(r.text).replace(/\s+/g, ' ').trim());
    if (next.length > 500) { toast('El hilo supera los 500 caracteres', 'error'); return; }
    const range = document.createRange();
    range.selectNodeContents(span);
    const sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(range);
    ui.savedRange = range.cloneRange(); ui.savedCe = surface();
    surface().focus({ preventScroll: true });
    await applyInline('comment', next);
  }

  async function noteAction(kind) {
    const ce = activeCe();
    if (!ce) { toast('Seleccioná el texto al que va la ' + (kind === 'note' ? 'nota' : 'comentario'), 'error'); return; }
    const sel = window.getSelection && window.getSelection();
    const range = sel && sel.rangeCount && ce.contains(sel.getRangeAt(0).commonAncestorContainer)
      ? sel.getRangeAt(0).cloneRange() : ui.savedRange;
    if (!range) { toast('Seleccioná el texto primero', 'error'); return; }
    const parent = (n) => (n.nodeType === 1 ? n : n.parentElement);
    const existing = parent(range.startContainer).closest('[data-' + kind + ']');
    if (!existing && range.collapsed) { toast('Seleccioná el texto primero', 'error'); return; }
    const b1 = parent(range.startContainer).closest('.doc-b');
    const b2 = parent(range.endContainer).closest('.doc-b');
    if (!existing && (!b1 || b1 !== b2)) { toast('La selección tiene que estar dentro de un solo párrafo', 'error'); return; }
    const label = kind === 'note' ? 'Nota al pie' : 'Comentario';
    const r = await modal({
      title: label,
      message: existing ? 'Dejalo vacío para quitarlo.' : 'Máximo 500 caracteres.',
      fields: [{ name: 'text', label: label, value: existing ? existing.getAttribute('data-' + kind) : '' }],
      ok: 'Aplicar'
    });
    if (!r) return;
    ui.savedRange = range; ui.savedCe = ce;
    ce.focus({ preventScroll: true });
    const cur = window.getSelection();
    cur.removeAllRanges();
    cur.addRange(range);
    let value = String(r.text || '').replace(/\s+/g, ' ').trim();
    if (kind === 'comment' && value && !existing && !/^\[[^|\]]*\|/.test(value)) value = commentStamp() + value;
    await applyInline(kind, value.slice(0, 500));
  }

  function wrapAttrSpan(kind, value) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const attr = 'data-' + kind;
    const unwrap = (n) => { const p = n.parentNode; while (n.firstChild) p.insertBefore(n.firstChild, n); p.removeChild(n); };
    const start = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    const existing = start && start.closest('[' + attr + ']');
    if (existing) {
      if (value) { existing.setAttribute(attr, value); existing.setAttribute('title', value); } else unwrap(existing);
      return;
    }
    if (range.collapsed || !value) return;
    const span = document.createElement('span');
    span.className = kind === 'note' ? 'doc-note' : 'doc-comment';
    span.setAttribute(attr, value);
    span.setAttribute('title', value);
    const frag = range.extractContents();
    frag.querySelectorAll('[' + attr + ']').forEach(unwrap);
    span.appendChild(frag);
    range.insertNode(span);
    const next = document.createRange();
    next.selectNodeContents(span);
    sel.removeAllRanges();
    sel.addRange(next);
  }

  function applyZoom(pct) {
    ui.zoom = Math.min(200, Math.max(25, Number(pct) || 100));
    const stack = host() && host().querySelector('.doc-paper-stack');
    if (stack) stack.style.zoom = ui.zoom === 100 ? '' : String(ui.zoom / 100);
    const sel = el('doc-zoom');
    if (sel) sel.value = String(ui.zoom);
    scheduleRuler();
  }

// ── Vista de a una hoja ────────────────────────────────────────────────
// En libros de muchas páginas mostrar todas las hojas seguidas satura la
// vista y el scroll. Con esto se ve una sola hoja por vez y se navega.
// Las hojas del documento, en orden.
function sheets() {
  const st = surface();
  return st ? Array.from(st.querySelectorAll(':scope > .doc-paper')) : [];
}

// Qué hoja se está viendo ahora, mirando el scroll. Solo tiene sentido con las
// hojas visibles (antes de esconderlas): devuelve la PRIMERA a la vista, que es
// la que el lector tiene delante, no la ultima.
function visibleSheetIndex() {
  const list = sheets();
  if (list.length < 2) return 0;
  const body = el('doc-body');
  const top = body ? body.getBoundingClientRect().top : 0;
  for (let n = 0; n < list.length; n++) {
    const r = list[n].getBoundingClientRect();
    if (r.height > 0 && r.bottom > top + 4) return n;
  }
  return 0;
}

function showSheet(index) {
    const list = sheets();
    if (!list.length) return;
    const i = Math.min(list.length - 1, Math.max(0, Number(index) || 0));
    ui.pageIndex = i;
    list.forEach((p, n) => p.classList.toggle('cur', n === i));
    const info = el('doc-pagenav-info');
    if (info) info.textContent = 'Hoja ' + (i + 1) + ' / ' + list.length;
    const prev = el('doc-page-prev');
    const next = el('doc-page-next');
    if (prev) prev.disabled = i <= 0;
    if (next) next.disabled = i >= list.length - 1;
    const body = el('doc-body');
    if (body) body.scrollTop = 0;
  }

  function toggleOnePage(force) {
    const next = force === undefined ? !ui.onePage : !!force;
    const h = host();
    if (!h) return;
    // Sin hojas no se entra en el modo: al esconderlas no queda nada que
    // mostrar y el documento quedaria en blanco.
    if (next && !sheets().length) return;
    // La hoja visible se calcula ANTES de esconder: una hoja oculta no mide.
    const idx = next ? visibleSheetIndex() : 0;
    ui.onePage = next;
    h.classList.toggle('doc-onepage', ui.onePage);
    const st = surface();
    if (st) st.classList.toggle('doc-onepage', ui.onePage);
    const nav = el('doc-pagenav');
    if (nav) nav.hidden = !ui.onePage;
    const btn = el('doc-onepage');
    if (btn) btn.classList.toggle('active', ui.onePage);
    if (ui.onePage) showSheet(idx);
    else {
      sheets().forEach((p) => p.classList.remove('cur'));
      if (ui.pageIndex) { ui.pageIndex = 0; }
    }
  }

// El modo de a una hoja se decide solo: entra cuando el documento pasa de
// AUTO_ONE_PAGE_FROM hojas. Si el usuario lo fijo a mano, no se lo movemos.
function autoOnePage() {
    if (ui.onePageUser !== null) return;
    const want = sheets().length > AUTO_ONE_PAGE_FROM;
    if (want !== ui.onePage) toggleOnePage(want);
  }

  // ── Tablas e imagenes (hito 2) ─────────────────────────────────────────
  const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp'];
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
  const PICKER_COLS = 8;
  const PICKER_ROWS = 6;

  function contentWidthPx() {
    const page = (ui.snap && ui.snap.doc && ui.snap.doc.page) || {};
    const w = Number(page.width) || 595;
    const m = Number(page.margin);
    return Math.round((w - 2 * (Number.isFinite(m) ? m : 57)) * 96 / 72);
  }

  function refreshObjectBar() {
    const bar = el('doc-objbar');
    if (!bar || !tablesLib) return;
    const block = selectedBlock();
    const kind = block && (block.type === 'table' || block.type === 'image') ? block.type : '';
    if (bar.dataset.kind !== kind || bar.dataset.bid !== (block ? block.id : '')) {
      bar.dataset.kind = kind;
      bar.dataset.bid = block ? block.id : '';
      if (kind === 'table') {
        bar.innerHTML = '<span class="doc-obj-label">Tabla</span>' +
          '<button class="doc-format-tool" data-tbl="addRowBefore" title="Insertar fila arriba">+ Fila ↑</button>' +
          '<button class="doc-format-tool" data-tbl="addRowAfter" title="Insertar fila abajo">+ Fila ↓</button>' +
          '<button class="doc-format-tool" data-tbl="deleteRow" title="Eliminar la fila actual">− Fila</button>' +
          '<button class="doc-format-tool" data-tbl="addColBefore" title="Insertar columna a la izquierda">+ Col ←</button>' +
          '<button class="doc-format-tool" data-tbl="addColAfter" title="Insertar columna a la derecha">+ Col →</button>' +
          '<button class="doc-format-tool" data-tbl="deleteCol" title="Eliminar la columna actual">− Col</button>' +
          '<label title="Color de relleno de las celdas seleccionadas">Relleno <input type="color" id="doc-tbl-fill" value="#ffe08a"></label>' +
          '<button class="doc-format-tool" data-tbl="fillClear" title="Quitar el relleno de las celdas seleccionadas">Sin relleno</button>' +
          '<select id="doc-tbl-borders" title="Bordes de la tabla"><option value="all">Todos los bordes</option><option value="horizontal">Solo horizontales</option><option value="outer">Solo el contorno</option><option value="none">Sin bordes</option></select>' +
          '<select id="doc-tbl-cb" title="Bordes de las celdas seleccionadas"><option value="">Bordes de celda…</option><option value="all">Todos</option><option value="outer">Contorno</option><option value="inner">Interior</option><option value="top">Solo arriba</option><option value="bottom">Solo abajo</option><option value="left">Solo izquierda</option><option value="right">Solo derecha</option><option value="none">Ninguno</option><option value="clear">Como la tabla</option></select>' +
          '<select id="doc-tbl-sort" title="Ordenar las filas por la columna actual"><option value="">Ordenar…</option><option value="asc">Columna A → Z</option><option value="desc">Columna Z → A</option></select>' +
          '<button class="doc-format-tool" data-tbl="merge" title="Combinar las celdas seleccionadas">Combinar</button>' +
          '<button class="doc-format-tool" data-tbl="unmerge" title="Separar la celda combinada">Separar</button>' +
          '<button class="doc-format-tool" data-tbl="header" title="Primera fila como encabezado">Encabezado</button>';
      } else if (kind === 'image') {
        bar.innerHTML = '<span class="doc-obj-label">Imagen</span>' +
          '<label>Ancho <input type="number" id="doc-img-w" min="16" max="2000"> px</label>' +
          '<button class="doc-format-tool" data-img-pct="25">25%</button>' +
          '<button class="doc-format-tool" data-img-pct="50">50%</button>' +
          '<button class="doc-format-tool" data-img-pct="75">75%</button>' +
          '<button class="doc-format-tool" data-img-pct="100">100%</button>' +
          '<label>Ajuste <select id="doc-img-wrap"><option value="">En línea</option><option value="left">Flota a la izquierda</option><option value="right">Flota a la derecha</option></select></label>' +
          '<label title="Recorte en % de cada lado">Recorte % <input type="number" class="doc-crop" data-crop="t" min="0" max="90" placeholder="arr" style="width:3.2em"> <input type="number" class="doc-crop" data-crop="r" min="0" max="90" placeholder="der" style="width:3.2em"> <input type="number" class="doc-crop" data-crop="b" min="0" max="90" placeholder="aba" style="width:3.2em"> <input type="number" class="doc-crop" data-crop="l" min="0" max="90" placeholder="izq" style="width:3.2em"></label>' +
          '<label>Texto alternativo <input type="text" id="doc-img-alt" maxlength="300" placeholder="describe la imagen"></label>';
      } else bar.innerHTML = '';
    }
    bar.classList.toggle('on', !!kind);
    if (kind === 'table') {
      const hb = bar.querySelector('[data-tbl="header"]');
      if (hb) hb.classList.toggle('active', block.header !== false);
      const bs = bar.querySelector('#doc-tbl-borders');
      if (bs && document.activeElement !== bs) bs.value = block.borders || 'all';
    } else if (kind === 'image') {
      const w = bar.querySelector('#doc-img-w');
      const a = bar.querySelector('#doc-img-alt');
      if (w && document.activeElement !== w) w.value = block.width || '';
      if (a && document.activeElement !== a) a.value = block.alt || '';
      const wsel = bar.querySelector('#doc-img-wrap');
      if (wsel && document.activeElement !== wsel) wsel.value = block.wrap || '';
      bar.querySelectorAll('.doc-crop').forEach((inp) => {
        if (document.activeElement !== inp) inp.value = (block.crop && block.crop[inp.dataset.crop]) || '';
      });
    }
  }

  function cellOf(block, c) {
    const last = block ? Math.max(0, (block.rows || []).length - 1) : 0;
    if (!c || !block || c.id !== block.id) return { row: last, col: Math.max(0, tablesLib.cols(block || { rows: [] }) - 1) };
    return { row: Math.min(c.row, last), col: Math.min(c.col, Math.max(0, tablesLib.cols(block) - 1)) };
  }

  function tableAction(name, arg) {
    if (!tablesLib) return;
    // La celda se toma ANTES de confirmar lo pendiente: al repintar el foco
    // puede moverse y la fila nueva iria a otro lado.
    const at = ui.cell ? Object.assign({}, ui.cell) : null;
    const rect = (name === 'merge' || name === 'fill' || name === 'cellBorders') ? (selectedCellRect() || ui.cellRect || null) : null;
    applySelectedBlock((block) => {
      if (block.type !== 'table') return null;
      const c = cellOf(block, at);
      let next = null;
      if (name === 'addRowBefore') next = tablesLib.addRow(block, c.row, 'before');
      else if (name === 'addRowAfter') next = tablesLib.addRow(block, c.row, 'after');
      else if (name === 'deleteRow') next = tablesLib.deleteRow(block, c.row);
      else if (name === 'addColBefore') next = tablesLib.addCol(block, c.col, 'before');
      else if (name === 'addColAfter') next = tablesLib.addCol(block, c.col, 'after');
      else if (name === 'deleteCol') next = tablesLib.deleteCol(block, c.col);
      else if (name === 'header') next = tablesLib.setHeader(block, block.header === false);
      else if (name === 'merge') {
        const r = rect || { r1: c.row, c1: c.col, r2: c.row, c2: c.col };
        if (r.r1 === r.r2 && r.c1 === r.c2) { toast('Selecciona dos o más celdas para combinar', 'error'); return null; }
        next = tablesLib.mergeCells(block, r.r1, r.c1, r.r2, r.c2);
      } else if (name === 'unmerge') next = tablesLib.unmergeCell(block, c.row, c.col);
      else if (name === 'fill') {
        const r = rect || { r1: c.row, c1: c.col, r2: c.row, c2: c.col };
        next = tablesLib.setFill(block, r.r1, r.c1, r.r2, r.c2, arg);
      } else if (name === 'cellBorders') {
        const r = rect || { r1: c.row, c1: c.col, r2: c.row, c2: c.col };
        next = tablesLib.setCellBorders(block, r.r1, r.c1, r.r2, r.c2, arg);
      } else if (name === 'sort') {
        if (block.merges && block.merges.length) { toast('No se puede ordenar una tabla con celdas combinadas', 'error'); return null; }
        next = tablesLib.sortRows(block, c.col, arg);
      } else if (name === 'setBorders') next = tablesLib.setBorders(block, arg);
      else if (name === 'setColWidths') next = tablesLib.setColWidths(block, arg);
      if (!next) { toast('Esa operación no es posible en esta tabla', 'error'); return null; }
      return next;
    });
  }

  // Inserta un bloque despues del seleccionado (o al final) y lo selecciona.
  async function insertBlockHere(block) {
    if (!ui.snap || !ui.snap.open) return null;
    await flushPending();
    const blocks = ui.snap.doc.blocks || [];
    const sel = selectedBlock();
    const at = sel ? blocks.findIndex((b) => b.id === sel.id) + 1 : blocks.length;
    const ops = [{ op: 'insert', index: at, block }];
    // Una imagen al final no deja donde seguir escribiendo: se agrega una linea.
    if (block.type === 'image' && at >= blocks.length) ops.push({ op: 'insert', index: at + 1, block: { type: 'paragraph', text: '' } });
    const res = await docEdit({ expectedHash: ui.snap.doc.hash, ops });
    if (res && res.ok) {
      applySnapshot(res);
      const created = ((res.doc && res.doc.blocks) || [])[at];
      if (created) select(created.id);
      scheduleAutoSave();
      return created || null;
    }
    if (res && res.error) toast(res.error, 'error');
    return null;
  }

  async function insertTable(rows, cols) {
    if (!tablesLib) return;
    const created = await insertBlockHere(tablesLib.create(rows, cols, true));
    if (created) setTimeout(() => {
      const t = host() && host().querySelector('.doc-b[data-id="' + cssEscape(created.id) + '"] td, .doc-b[data-id="' + cssEscape(created.id) + '"] th');
      if (!t) return;
      const p0 = placeAt(t, 0);
      const sel = window.getSelection();
      const r = document.createRange();
      r.setStart(p0.node, p0.offset); r.collapse(true);
      sel.removeAllRanges(); sel.addRange(r);
      const st = surface(); if (st) st.focus({ preventScroll: true });
    }, 30);
  }

  function hidePicker() {
    const p = el('doc-table-picker');
    if (p) p.classList.remove('on');
  }

  function showPicker() {
    const p = el('doc-table-picker');
    const btn = el('doc-ins-table');
    if (!p || !btn) return;
    if (p.classList.contains('on')) { hidePicker(); return; }
    let cells = '';
    for (let i = 0; i < PICKER_COLS * PICKER_ROWS; i++) {
      cells += '<i data-r="' + (Math.floor(i / PICKER_COLS) + 1) + '" data-c="' + ((i % PICKER_COLS) + 1) + '"></i>';
    }
    p.innerHTML = '<div class="doc-table-grid">' + cells + '</div><div class="doc-table-size">Elegí el tamaño</div>';
    const hostEl = host();
    const hr = hostEl.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    p.style.left = Math.max(0, br.left - hr.left) + 'px';
    p.style.top = Math.max(0, br.bottom - hr.top + 4) + 'px';
    p.classList.add('on');
  }

  function wirePicker() {
    const p = el('doc-table-picker');
    if (!p || p.dataset.wired) return;
    p.dataset.wired = '1';
    const paint = (r, c) => {
      p.querySelectorAll('.doc-table-grid i').forEach((i) => {
        i.classList.toggle('hot', Number(i.dataset.r) <= r && Number(i.dataset.c) <= c);
      });
      const label = p.querySelector('.doc-table-size');
      if (label) label.textContent = r && c ? c + ' × ' + r : 'Elegí el tamaño';
    };
    p.addEventListener('mouseover', (e) => {
      const i = e.target.closest && e.target.closest('i[data-r]');
      if (i) paint(Number(i.dataset.r), Number(i.dataset.c));
    });
    p.addEventListener('click', (e) => {
      const i = e.target.closest && e.target.closest('i[data-r]');
      if (!i) return;
      hidePicker();
      insertTable(Number(i.dataset.r), Number(i.dataset.c));
    });
    document.addEventListener('mousedown', (e) => {
      if (!p.classList.contains('on')) return;
      if (e.target.closest && (e.target.closest('#doc-table-picker') || e.target.closest('#doc-ins-table'))) return;
      hidePicker();
    });
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => reject(fr.error || new Error('no se pudo leer la imagen'));
      fr.readAsDataURL(file);
    });
  }

  // Tamano natural de la imagen. Si el navegador no la decodifica a tiempo se
  // usa un tamano razonable: mejor insertarla que dejar al usuario esperando.
  function naturalSize(src) {
    return new Promise((resolve) => {
      let done = false;
      const fin = (v) => { if (!done) { done = true; resolve(v); } };
      const img = new Image();
      img.onload = () => fin({ width: img.naturalWidth || 400, height: img.naturalHeight || 300 });
      img.onerror = () => fin({ width: 400, height: 300 });
      setTimeout(() => fin({ width: 400, height: 300 }), 2500);
      img.src = src;
    });
  }

  async function insertImageFile(file) {
    if (!file || !tablesLib) return;
    if (!IMAGE_TYPES.includes(file.type)) { toast('Formato de imagen no admitido (PNG, JPG, GIF, WebP, SVG o BMP)', 'error'); return; }
    if (file.size > MAX_IMAGE_BYTES) { toast('La imagen pesa más de 8 MB', 'error'); return; }
    let src;
    try { src = await readFileAsDataUrl(file); } catch (e) { toast('No se pudo leer la imagen', 'error'); return; }
    const nat = await naturalSize(src);
    const size = tablesLib.fitWidth(nat, contentWidthPx());
    await insertBlockHere({ type: 'image', src, alt: '', width: size.width, height: size.height });
  }

  function imageFilesOf(dt) {
    return dt && dt.files ? Array.from(dt.files).filter((f) => IMAGE_TYPES.includes(f.type)) : [];
  }

  async function setImageWidth(px) {
    if (!tablesLib) return;
    applySelectedBlock((block) => {
      if (block.type !== 'image') return null;
      const nat = block.width && block.height ? { width: block.width, height: block.height } : null;
      return tablesLib.resizeImage(block, { width: px }, nat);
    });
  }

  function wireObjects() {
    const h = host();
    const b0 = el('doc-body');
    if (!h || !b0 || b0.dataset.objWired || !tablesLib) return;
    b0.dataset.objWired = '1';
    wirePicker();
    el('doc-zoom').addEventListener('change', (e) => applyZoom(e.target.value));
    el('doc-sp').addEventListener('change', (e) => {
      const parts = String(e.target.value).split(',').map(Number);
      applySelectedBlock((block) => {
        if (!['heading', 'paragraph', 'quote', 'list'].includes(block.type)) return null;
        const next = Object.assign({}, block);
        if (parts.length === 2 && parts.every((n) => isFinite(n))) { next.spaceBefore = parts[0]; next.spaceAfter = parts[1]; }
        else { delete next.spaceBefore; delete next.spaceAfter; }
        return next;
      });
    });
    paintNamedStyles();
    el('doc-named').addEventListener('change', (e) => { const v = e.target.value; e.target.value = ''; onNamedStyle(v); });
    el('doc-caption').addEventListener('change', (e) => {
      const v = e.target.value;
      applySelectedBlock((block) => {
        if (block.type !== 'paragraph') return null;
        const next = Object.assign({}, block);
        if (v) next.caption = v; else delete next.caption;
        return next;
      });
    });
    el('doc-callout').addEventListener('change', (e) => {
      const v = e.target.value;
      applySelectedBlock((block) => {
        if (!['paragraph', 'quote'].includes(block.type)) return null;
        const next = Object.assign({}, block);
        if (v) next.callout = v; else delete next.callout;
        return next;
      });
    });
    el('doc-lh').addEventListener('change', (e) => {
      const v = Number(e.target.value);
      applySelectedBlock((block) => {
        const next = Object.assign({}, block);
        if (v > 0) next.lineHeight = v; else delete next.lineHeight;
        return next;
      });
    });
    // Un enlace dentro del texto editable no navega: se edita, no se sigue.
    b0.addEventListener('click', (e) => {
      if (e.target.closest && e.target.closest('.doc-b a')) e.preventDefault();
    });

    el('doc-ins-table').addEventListener('click', showPicker);
    el('doc-ins-toc').addEventListener('click', insertTableOfContents);
    el('doc-ins-sym').addEventListener('click', toggleSymbols);
    el('doc-ins-xref').addEventListener('click', insertCrossRef);
    el('doc-ai-text').addEventListener('click', aiTextAssist);
    el('doc-ai-text').addEventListener('mousedown', (e) => e.preventDefault());
    el('doc-ins-lof').addEventListener('click', insertCaptionList);
    el('doc-ins-xref').addEventListener('mousedown', (e) => e.preventDefault());
    el('doc-ins-sym').addEventListener('mousedown', (e) => e.preventDefault());
    el('doc-notes-btn').addEventListener('click', () => toggleNotesPanel());
    b0.addEventListener('click', (e) => {
      const row = e.target.closest && e.target.closest('.doc-toc-row');
      if (!row) return;
      const t = surface() && surface().querySelector('.doc-b[data-id="' + cssEscape(row.dataset.go) + '"]');
      if (t && t.scrollIntoView) t.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    const fileInput = el('doc-image-file');
    el('doc-ins-image').addEventListener('click', () => { hidePicker(); fileInput.click(); });
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (f) await insertImageFile(f);
    });

    const bar = el('doc-objbar');
    bar.addEventListener('click', (e) => {
      const t = e.target.closest && e.target.closest('button');
      if (!t) return;
      if (t.dataset.tbl === 'fillClear') tableAction('fill', null);
      else if (t.dataset.tbl) tableAction(t.dataset.tbl);
      else if (t.dataset.imgPct) setImageWidth(Math.round(contentWidthPx() * Number(t.dataset.imgPct) / 100));
    });
    bar.addEventListener('change', (e) => {
      if (e.target.id === 'doc-tbl-fill') { tableAction('fill', e.target.value); return; }
      if (e.target.id === 'doc-tbl-borders') { tableAction('setBorders', e.target.value); return; }
      if (e.target.id === 'doc-tbl-cb') { if (e.target.value) tableAction('cellBorders', e.target.value); e.target.value = ''; return; }
      if (e.target.id === 'doc-tbl-sort') { if (e.target.value) tableAction('sort', e.target.value); e.target.value = ''; return; }
      if (e.target.id === 'doc-img-w') {
        const v = Number(e.target.value);
        if (v >= 16) setImageWidth(v);
      } else if (e.target.id === 'doc-img-wrap') {
        const wv = e.target.value;
        applySelectedBlock((block) => {
          if (block.type !== 'image') return null;
          const next = Object.assign({}, block);
          if (wv === 'left' || wv === 'right') next.wrap = wv; else delete next.wrap;
          return next;
        });
      } else if (e.target.classList && e.target.classList.contains('doc-crop')) {
        const vals = {};
        bar.querySelectorAll('.doc-crop').forEach((inp) => { vals[inp.dataset.crop] = Math.max(0, Math.min(90, parseInt(inp.value, 10) || 0)); });
        applySelectedBlock((block) => {
          if (block.type !== 'image') return null;
          const next = Object.assign({}, block);
          const ok = vals.t + vals.b <= 90 && vals.l + vals.r <= 90 && (vals.t || vals.r || vals.b || vals.l);
          if (ok) next.crop = vals; else delete next.crop;
          return next;
        });
      } else if (e.target.id === 'doc-img-alt') {
        const alt = e.target.value;
        applySelectedBlock((block) => (block.type === 'image' ? tablesLib.setAlt(block, alt) : null));
      }
    });

    b0.addEventListener('dragover', (e) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) e.preventDefault();
    });
    b0.addEventListener('drop', (e) => {
      const files = imageFilesOf(e.dataTransfer);
      if (!files.length) return;
      e.preventDefault();
      const bEl = e.target.closest && e.target.closest('.doc-b');
      if (bEl) select(bEl.dataset.id);
      insertImageFile(files[0]);
    });

    wireColumnResize(b0);
    wireRuler();

    // Redimensionar arrastrando la esquina: proporcion siempre conservada.
    b0.addEventListener('mousedown', (e) => {
      const handle = e.target.closest && e.target.closest('[data-img-handle]');
      if (!handle) return;
      e.preventDefault();
      const bEl = handle.closest('.doc-b');
      const wrap = handle.closest('.doc-img-wrap');
      const img = wrap && wrap.querySelector('img');
      if (!bEl || !img) return;
      const startX = e.clientX;
      const startW = wrap.getBoundingClientRect().width || img.width || 100;
      const maxW = contentWidthPx();
      let width = startW;
      const move = (ev) => {
        width = Math.max(16, Math.min(maxW, startW + (ev.clientX - startX)));
        wrap.style.width = Math.round(width) + 'px';
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        select(bEl.dataset.id);
        setImageWidth(Math.round(width));
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  // Arrastrar el borde derecho de una celda cambia el ancho de esa columna.
  const EDGE_PX = 5;
  function edgeCell(e) {
    const cell = e.target && e.target.closest && e.target.closest('td,th');
    const table = cell && cell.closest('table.doc-b');
    if (!cell || !table) return null;
    const r = cell.getBoundingClientRect();
    const tr = table.getBoundingClientRect();
    if (Math.abs(e.clientX - r.right) > EDGE_PX || r.right >= tr.right - 3) return null;
    return { cell, table };
  }

  function wireColumnResize(b0) {
    b0.addEventListener('mousemove', (e) => {
      if (e.buttons) return;
      const hit = edgeCell(e);
      b0.querySelectorAll('table.col-resizing').forEach((t) => { if (!hit || t !== hit.table) t.classList.remove('col-resizing'); });
      if (hit) hit.table.classList.add('col-resizing');
    });
    b0.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const hit = edgeCell(e);
      if (!hit || !tablesLib) return;
      const { cell, table } = hit;
      const at = gridCoord(cell);
      const blk = ((ui.snap && ui.snap.doc && ui.snap.doc.blocks) || []).find((b) => b.id === table.dataset.id);
      if (!at || !blk) return;
      e.preventDefault();
      const n = tablesLib.cols(blk);
      const k = Math.min(n - 2, at.col + Math.max(1, parseInt(cell.getAttribute('colspan'), 10) || 1) - 1);
      if (k < 0) return;
      const tw = table.getBoundingClientRect().width || 1;
      // Anchos de partida: los del modelo o los medidos en una fila sin celdas combinadas.
      let w0 = Array.isArray(blk.colWidths) && blk.colWidths.length === n ? blk.colWidths.slice() : null;
      if (!w0) {
        const plain = Array.from(table.querySelectorAll('tr')).find((tr) => tr.children.length === n && Array.from(tr.children).every((c) => !(parseInt(c.getAttribute('colspan'), 10) > 1)));
        w0 = plain ? Array.from(plain.children).map((c) => c.getBoundingClientRect().width / tw * 100) : new Array(n).fill(100 / n);
      }
      const pair = w0[k] + w0[k + 1];
      let widths = w0.slice();
      let grp = table.querySelector(':scope > colgroup');
      if (!grp) { grp = document.createElement('colgroup'); table.insertBefore(grp, table.firstChild); }
      const paint = () => {
        grp.innerHTML = widths.map((w) => '<col style="width:' + w + '%">').join('');
        table.style.tableLayout = 'fixed';
      };
      const startX = e.clientX;
      const move = (ev) => {
        const d = (ev.clientX - startX) / tw * 100;
        const a = Math.max(3, Math.min(pair - 3, w0[k] + d));
        widths = w0.slice();
        widths[k] = a;
        widths[k + 1] = pair - a;
        paint();
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        select(table.dataset.id);
        tableAction('setColWidths', widths);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  async function insertSelectedPageBreak() {
    const block = selectedBlock();
    if (!block || !ui.snap) return;
    await flushPending();
    const index = ui.snap.doc.blocks.findIndex((item) => item.id === block.id);
    if (index < 0) return;
    const res = await docEdit({ expectedHash: ui.snap.doc.hash, ops: [
      { op: 'insert', index: index + 1, block: { type: 'pagebreak' } }
    ] });
    if (res && res.ok) { applySnapshot(res); select(block.id); }
    else if (res && res.error) toast(res.error, 'error');
  }

  // Tabla de contenido: una linea por titulo, sangrada segun el nivel. Es una
  // foto del momento (se vuelve a insertar para actualizarla).
  // Tabla de contenido viva: un bloque `toc` cuyas lineas se arman solas con los
  // titulos que hay en pantalla (y la hoja en que cae cada uno).
  async function insertTableOfContents() {
    if (!ui.snap || !ui.snap.open) return;
    await flushPending();
    const list = ui.snap.doc.blocks || [];
    if (list.some((b) => b.type === 'toc' && !b.kind)) { toast('Ya hay una tabla de contenido en el documento', 'error'); return; }
    if (!list.some((b) => b.type === 'heading' && blockText(b).trim())) { toast('No hay títulos para armar la tabla de contenido', 'error'); return; }
    const cur = selectedBlock();
    const at = cur ? list.findIndex((b) => b.id === cur.id) + 1 : 0;
    const res = await docEdit({ expectedHash: ui.snap.doc.hash, ops: [{ op: 'insertBlocks', index: at, blocks: [{ type: 'toc', levels: 3 }] }] });
    if (res && res.ok) { applySnapshot(res); scheduleAutoSave(); refreshToc(); toast('Tabla de contenido insertada', null, { label: 'Deshacer', run: () => travelHistory('undo') }); }
    else if (res && res.error) toast(res.error, 'error');
  }

  async function insertCaptionList() {
    if (!ui.snap || !ui.snap.open) return;
    await flushPending();
    const r = await modal({ title: 'Índice de figuras o tablas', message: 'Lista los rótulos «Figura n» / «Tabla n» del documento y se actualiza sola.',
      fields: [{ name: 'kind', label: 'Tipo', value: 'figure', options: [['figure', 'Figuras'], ['table', 'Tablas']] }], ok: 'Insertar' });
    if (!r) return;
    const list = ui.snap.doc.blocks || [];
    const cur = selectedBlock();
    const at = cur ? list.findIndex((b) => b.id === cur.id) + 1 : 0;
    const res = await docEdit({ expectedHash: ui.snap.doc.hash, ops: [{ op: 'insertBlocks', index: at, blocks: [{ type: 'toc', levels: 3, kind: r.kind }] }] });
    if (res && res.ok) { applySnapshot(res); scheduleAutoSave(); refreshToc(); }
    else if (res && res.error) toast(res.error, 'error');
  }

  function refreshToc() {
    const st = surface();
    if (!st) return;
    // Los trozos del indice (data-cont) son un artefacto del reparto, no contenido:
    // se borran y se vuelven a hacer en el reparto siguiente. NO se rellenan.
    // Si se dejaran, al recalcular los numeros de pagina el primer trozo se
    // vuelve a llenar con TODAS las entradas y quedan tambien las de los trozos:
    // el indice sale duplicado y descolocado ("1-2", "-1", "2-3").
    const trozos = st.querySelectorAll('.doc-toc[data-cont]');
    trozos.forEach((t) => t.remove());
    const tocs = st.querySelectorAll('.doc-toc:not([data-cont])');
    if (!tocs.length) return;
    let cambio = trozos.length > 0;
    const heads = [];
    st.querySelectorAll('.doc-b[data-type="heading"]').forEach((h) => {
      if (h.hasAttribute('data-cont')) return;
      const text = h.textContent.replace(/\s+/g, ' ').trim();
      if (!text) return;
      const paper = h.closest('.doc-paper');
      heads.push({ id: h.dataset.id, level: Math.min(3, Number(h.dataset.level) || 1), text, page: paper ? paper.dataset.page : '' });
    });
    tocs.forEach((box) => {
      const kind = box.dataset.kind;
      if (kind) {
        const word = kind === 'table' ? 'Tabla' : 'Figura';
        const caps = Array.from(st.querySelectorAll('.doc-b[data-caption="' + kind + '"]:not([data-cont])'));
        const htmlK = '<div class="doc-toc-title">' + (kind === 'table' ? 'Índice de tablas' : 'Índice de figuras') + '</div>' + (caps.length
          ? caps.map((c, i) => '<div class="doc-toc-row l1" data-go="' + esc(c.dataset.id) + '"><span class="t">' + word + ' ' + (i + 1) + '. ' + esc(c.textContent.replace(/\s+/g, ' ').trim()) +
            '</span><span class="dots"></span><span class="n">' + esc(c.closest('.doc-paper') ? c.closest('.doc-paper').dataset.page : '') + '</span></div>').join('')
          : '<div class="doc-toc-empty">(Sin rótulos)</div>');
        if (box.dataset.sig !== htmlK) { box.dataset.sig = htmlK; box.innerHTML = htmlK; cambio = true; }
        return;
      }
      const max = Math.min(3, Math.max(1, Number(box.dataset.levels) || 3));
      const rows = heads.filter((h) => h.level <= max);
      const html2 = '<div class="doc-toc-title">Contenido</div>' + (rows.length
        ? rows.map((h) => '<div class="doc-toc-row l' + h.level + '" data-go="' + esc(h.id) + '"><span class="t">' + esc(h.text) +
          '</span><span class="dots"></span><span class="n">' + esc(h.page) + '</span></div>').join('')
        : '<div class="doc-toc-empty">(Sin títulos)</div>');
      if (box.dataset.sig !== html2) { box.dataset.sig = html2; box.innerHTML = html2; cambio = true; }
    });
    // La tabla de contenido crece DESPUÉS del reparto de hojas: el bloque se
    // pinta primero vacio, layoutPaperPages mide esa altura y reparte, y recién
    // despues se le ponen los renglones. Con muchos titulos el indice queda mas
    // alto que la hoja y se salia de ella (doc-paper-content es overflow:
    // visible, o sea que el desborde se ve encima de la hoja siguiente).
    // Por eso, si el indice cambio de tamaño, se vuelve a repartir.
    if (cambio && st.isConnected) relayout();
  }

  async function moveSelectedBlock(direction) {
    const ids = selectedIds();
    if (!ids.length || !ui.snap) return;
    await flushPending();
    const blocks = ui.snap.doc.blocks || [];
    const chosen = new Set(ids);
    const idx = blocks.map((b, i) => (chosen.has(b.id) ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) return;
    const n = idx.length;
    let insertAt;
    let newStart;
    if (direction === 'up') {
      let prev = idx[0] - 1;
      while (prev >= 0 && chosen.has(blocks[prev].id)) prev--;
      if (prev < 0) return;
      insertAt = prev;
      newStart = prev;
    } else {
      let next = idx[n - 1] + 1;
      while (next < blocks.length && chosen.has(blocks[next].id)) next++;
      if (next >= blocks.length) return;
      insertAt = next + 1;
      newStart = next - n + 1;
    }
    const copies = idx.map((i) => { const c = Object.assign({}, blocks[i]); delete c.id; return c; });
    const ops = [{ op: 'insertBlocks', index: insertAt, blocks: copies }].concat(ids.map((id) => ({ op: 'deleteBlock', id })));
    const res = await docEdit({ expectedHash: ui.snap.doc.hash, ops });
    if (res && res.ok) {
      const movedIds = (res.doc.blocks || []).slice(newStart, newStart + n).map((b) => b.id);
      applySnapshot(res);
      setSelection(movedIds, movedIds[movedIds.length - 1]);
    } else if (res && res.error) toast(res.error, 'error');
  }

  async function deleteSelectedBlock() {
    const ids = selectedIds();
    if (!ids.length || !ui.snap) return;
    await flushPending();
    const blocks = ui.snap.doc.blocks || [];
    const at = blocks.findIndex((x) => x.id === ids[0]);
    const delOps = ids.map((id) => ({ op: 'deleteBlock', id }));
    // Un documento sin ningun bloque no tiene donde escribir: queda un parrafo vacio.
    if (ids.length >= blocks.length) delOps.push({ op: 'insert', index: 0, block: { type: 'paragraph', text: '' } });
    const res = await docEdit({ expectedHash: ui.snap.doc.hash, ops: delOps });
    if (!(res && res.ok)) { if (res && res.error) toast(res.error, 'error'); return; }
    // Sin confirmacion nativa: se borra y se ofrece Deshacer (como Word).
    ui.selectedBlockId = null;
    applySnapshot(res);
    scheduleAutoSave();
    const left = (res.doc && res.doc.blocks) || [];
    const next = left[Math.min(at, left.length - 1)];
    if (next) { select(next.id); setTimeout(() => focusBlock(next.id), 0); }
    else setSelection([], null);
    toast(ids.length > 1 ? ids.length + ' bloques eliminados' : 'Bloque eliminado', null, { label: 'Deshacer', run: () => travelHistory('undo') });
  }

  async function travelHistory(direction) {
    await flushPending();
    const res = direction === 'undo' ? await API.docUndo() : await API.docRedo();
    if (res && res.ok) applySnapshot(res);
    else if (res && res.error) toast(res.error);
  }

  // ---- Buscar y reemplazar (barra propia, Ctrl+F / Ctrl+H) ------------------
  // Las coincidencias se marcan con la API de resaltado de CSS (no toca el DOM
  // editable) y reemplazar edita el texto en su sitio, asi conserva el formato
  // del tramo y entra al historial como cualquier otra edicion.
  const find = { open: false, ranges: [], cur: -1, timer: 0 };

  function findOptions() {
    const bar = el('doc-findbar');
    return {
      q: bar ? bar.querySelector('[data-f="q"]').value : '',
      r: bar ? bar.querySelector('[data-f="r"]').value : '',
      cs: !!(bar && bar.querySelector('[data-f="cs"]').classList.contains('on')),
      ww: !!(bar && bar.querySelector('[data-f="ww"]').classList.contains('on'))
    };
  }

  function findRegex(o) {
    if (!o.q) return null;
    const body = o.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const src = o.ww ? '(?<![\\p{L}\\p{N}_])' + body + '(?![\\p{L}\\p{N}_])' : body;
    try { return new RegExp(src, 'gu' + (o.cs ? '' : 'i')); } catch (e) { return null; }
  }

  // Rangos de cada coincidencia, bloque por bloque (un hallazgo no cruza bloques).
  function findRanges(re) {
    const st = surface();
    const out = [];
    if (!st || !re) return out;
    const seen = new Set();
    topEls(st).forEach((blk) => {
      if (blk.getAttribute('contenteditable') === 'false') return;
      const nodes = [];
      const walker = document.createTreeWalker(blk, NodeFilter.SHOW_TEXT);
      let n; let text = '';
      while ((n = walker.nextNode())) { nodes.push({ node: n, start: text.length }); text += n.nodeValue; }
      if (!text) return;
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        if (!m[0].length) { re.lastIndex++; continue; }
        const at = (pos, end) => {
          for (let i = nodes.length - 1; i >= 0; i--) {
            if (pos >= nodes[i].start && (pos < nodes[i].start + nodes[i].node.nodeValue.length || (end && pos === nodes[i].start + nodes[i].node.nodeValue.length))) return { node: nodes[i].node, off: pos - nodes[i].start };
          }
          return null;
        };
        const s0 = at(m.index, false); const e0 = at(m.index + m[0].length, true);
        if (!s0 || !e0) continue;
        const rg = document.createRange();
        rg.setStart(s0.node, s0.off); rg.setEnd(e0.node, e0.off);
        out.push(rg);
      }
    });
    return out;
  }

  function paintFind() {
    const bar = el('doc-findbar');
    const count = bar && bar.querySelector('[data-f="count"]');
    if (window.CSS && CSS.highlights && typeof Highlight === 'function') {
      CSS.highlights.delete('doc-find'); CSS.highlights.delete('doc-find-cur');
      if (find.open && find.ranges.length) {
        CSS.highlights.set('doc-find', new Highlight(...find.ranges));
        if (find.cur >= 0 && find.ranges[find.cur]) CSS.highlights.set('doc-find-cur', new Highlight(find.ranges[find.cur]));
      }
    }
    if (count) {
      const o = findOptions();
      count.textContent = !o.q ? '' : find.ranges.length ? (find.cur + 1) + ' de ' + find.ranges.length : 'Sin resultados';
    }
  }

  function runFind(keepIndex) {
    const o = findOptions();
    find.ranges = find.open ? findRanges(findRegex(o)) : [];
    if (!find.ranges.length) find.cur = -1;
    else if (!keepIndex || find.cur < 0 || find.cur >= find.ranges.length) {
      // Empieza en la primera coincidencia a partir del cursor.
      const sel = window.getSelection && window.getSelection();
      let idx = 0;
      if (sel && sel.rangeCount && surface() && surface().contains(sel.anchorNode)) {
        const cur = sel.getRangeAt(0);
        const k = find.ranges.findIndex((r) => r.compareBoundaryPoints(Range.START_TO_START, cur) >= 0);
        idx = k < 0 ? 0 : k;
      }
      find.cur = idx;
    }
    paintFind();
  }

  function goFind(step, scroll) {
    if (!find.ranges.length) return;
    find.cur = (find.cur + step + find.ranges.length) % find.ranges.length;
    paintFind();
    if (scroll !== false) {
      const r = find.ranges[find.cur];
      const target = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
      if (target && target.scrollIntoView) target.scrollIntoView({ block: 'center', behavior: 'auto' });
    }
  }

  async function commitFindEdit() {
    ui.dirty = true;
    await flushPending();
    runFind(true);
  }

  function replaceRange(r, text) {
    r.deleteContents();
    if (text) r.insertNode(document.createTextNode(text));
    const st = r.startContainer.parentElement;
    if (st && st.normalize) st.normalize();
  }

  async function findReplaceOne() {
    if (!find.ranges.length || find.cur < 0) return;
    const o = findOptions();
    const idx = find.cur;
    replaceRange(find.ranges[idx], o.r);
    await commitFindEdit();
    if (find.ranges.length) { find.cur = Math.min(idx, find.ranges.length) - 1; goFind(1); }
  }

  async function findReplaceAll() {
    if (!find.ranges.length) return;
    const o = findOptions();
    const n = find.ranges.length;
    // De atras hacia adelante: reemplazar no mueve los rangos que faltan.
    for (let i = find.ranges.length - 1; i >= 0; i--) replaceRange(find.ranges[i], o.r);
    await commitFindEdit();
    toast('Reemplazadas ' + n + ' coincidencia(s)', null, { label: 'Deshacer', run: () => travelHistory('undo') });
  }

  function closeFind() {
    find.open = false; find.ranges = []; find.cur = -1;
    paintFind();
    const bar = el('doc-findbar');
    if (bar) bar.remove();
    const st = surface();
    if (st) st.focus({ preventScroll: true });
  }

  function openFind(focusReplace) {
    const h = host();
    if (!h) return;
    let bar = el('doc-findbar');
    const sel = window.getSelection && window.getSelection();
    const picked = sel && !sel.isCollapsed && surface() && surface().contains(sel.anchorNode) ? sel.toString() : '';
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'doc-findbar';
      bar.innerHTML =
        '<input data-f="q" type="text" placeholder="Buscar" aria-label="Buscar" autocomplete="off" spellcheck="false">' +
        '<span class="doc-find-count" data-f="count"></span>' +
        '<button type="button" data-f="cs" title="Distinguir mayúsculas">Aa</button>' +
        '<button type="button" data-f="ww" title="Solo palabras completas">ab</button>' +
        '<button type="button" data-f="prev" title="Anterior (Mayús+Enter)">↑</button>' +
        '<button type="button" data-f="next" title="Siguiente (Enter)">↓</button>' +
        '<button type="button" data-f="close" title="Cerrar (Esc)">✕</button>' +
        '<input data-f="r" type="text" placeholder="Reemplazar por" aria-label="Reemplazar por" autocomplete="off" spellcheck="false">' +
        '<button type="button" data-f="one" title="Reemplazar esta coincidencia">Reemplazar</button>' +
        '<button type="button" data-f="all" title="Reemplazar todas">Todo</button>';
      const sc = el('doc-scroll');
      (sc && sc.parentElement ? sc.parentElement : h).appendChild(bar);
      if (sc) { const rc = sc.getBoundingClientRect(); bar.style.top = Math.round(rc.top + 8) + 'px'; bar.style.right = Math.round(window.innerWidth - rc.right + 28) + 'px'; }
      const rerun = () => { clearTimeout(find.timer); find.timer = setTimeout(() => runFind(false), 80); };
      bar.addEventListener('input', (e) => { if (e.target.dataset.f === 'q') rerun(); });
      bar.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        const k = b.dataset.f;
        if (k === 'cs' || k === 'ww') { b.classList.toggle('on'); runFind(false); }
        else if (k === 'next') goFind(1);
        else if (k === 'prev') goFind(-1);
        else if (k === 'close') closeFind();
        else if (k === 'one') findReplaceOne();
        else if (k === 'all') findReplaceAll();
      });
      bar.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); closeFind(); return; }
        if (e.key === 'Enter') {
          e.preventDefault();
          if (e.target.dataset.f === 'r') findReplaceOne();
          else goFind(e.shiftKey ? -1 : 1);
        }
      });
    }
    find.open = true;
    const q = bar.querySelector('[data-f="q"]');
    if (picked && picked.length < 200 && !/\n/.test(picked)) q.value = picked;
    runFind(false);
    const target = focusReplace ? bar.querySelector('[data-f="r"]') : q;
    target.focus(); target.select();
  }

  function findAndReplace() { openFind(false); }

  async function showDocumentStats() {
    await flushPending();
    const res = await API.docRead({ maxChars: 200000 });
    if (res && res.error) { toast(res.error, 'error'); return; }
    const stats = res && res.stats;
    if (!stats) return;
    await modal({
      title: 'Recuento',
      message: 'Palabras: ' + stats.words + '\nCaracteres: ' + stats.chars +
        '\nBloques: ' + stats.blocks + '\nTítulos: ' + stats.headings +
        '\nTablas: ' + stats.tables + '\nImágenes: ' + stats.images + '\nPáginas: ' + stats.pages,
      cancel: false
    });
  }

  // Las ediciones de la UI van de a una (una cola) y, si el main avisa que el
  // documento cambio (el hash que se envio ya era viejo porque una edicion
  // anterior o un aviso del main llego en el medio), se vuelve a leer el estado
  // y se reintenta una vez. Un parche viejo solo tiene sentido para la IA: la
  // UI siempre parte de lo que el usuario esta viendo.
  let editQueue = Promise.resolve();
  function docEdit(req) {
    const run = async () => {
      let res = await API.docEdit(req);
      if (res && res.stale) {
        let fresh = null;
        try { fresh = await API.docState({}); } catch (e) { fresh = null; }
        if (fresh && fresh.open && fresh.doc && fresh.doc.hash) {
          ui.snap = fresh;
          res = await API.docEdit(Object.assign({}, req, { expectedHash: fresh.doc.hash }));
        }
      }
      return res;
    };
    const next = editQueue.then(run, run);
    editQueue = next.catch(() => {});
    return next;
  }

  // ── Contenido ──────────────────────────────────────────────────────────
  function blockText(b) {
    if (typeof b.text === 'string') return b.text;
    if (Array.isArray(b.runs)) return b.runs.map((r) => (r && r.text) || '').join('');
    if (Array.isArray(b.items)) return b.items.join('\n');
    return '';
  }

  // Texto en linea de un bloque, item o celda. Un salto es <br>; un bloque
  // vacio lleva un <br> para que el navegador le de una linea donde poner el
  // cursor (y un salto final necesita otro, que es el marcador de la linea).
  function inlineHtml(text, rr) {
    const hasRuns = Array.isArray(rr) && rr.length && html;
    let out = hasRuns ? html.runsToHtml({ runs: rr }) : esc(text).replace(/\n/g, '<br>');
    if (!out || /(\n|<br>)$/.test(out) || /\n$/.test(String(text || ''))) out += '<br>';
    return out;
  }

  function blockStyle(b) {
    const styles = [];
    if (b.align && ['left', 'center', 'right', 'justify'].includes(b.align)) styles.push('text-align:' + b.align);
    if (Number.isFinite(Number(b.size)) && Number(b.size) >= 4) styles.push('font-size:' + Number(b.size) + 'pt');
    if (b.color && /^#[0-9a-fA-F]{3,8}$/.test(b.color)) styles.push('color:' + b.color);
    if (b.bold) styles.push('font-weight:700');
    if (b.italic) styles.push('font-style:italic');
    if (b.underline) styles.push('text-decoration:underline');
    if (b.box && html && html.boxCss) styles.push(html.boxCss(b.box));
    if (Number(b.hanging) > 0) { styles.push('margin-left:' + (Number(b.indent || 0) * 18 + Number(b.hanging)) + 'pt'); styles.push('text-indent:-' + Number(b.hanging) + 'pt'); }
    else {
      if (Number(b.indent) > 0) styles.push('margin-left:' + (Number(b.indent) * 18) + 'pt');
      if (Number(b.firstLine) > 0) styles.push('text-indent:' + Number(b.firstLine) + 'pt');
    }
    if (Number(b.lineHeight) > 0) styles.push('line-height:' + Number(b.lineHeight));
    if (b.spaceBefore != null) styles.push('margin-top:' + Number(b.spaceBefore) + 'pt');
    if (b.spaceAfter != null) styles.push('margin-bottom:' + Number(b.spaceAfter) + 'pt');
    return styles.length ? ' style="' + esc(styles.join(';')) + '"' : '';
  }

  // Cuadros de aviso (callout): fondo + barra lateral segun el tipo.
  const CALLOUTS = { info: ['#EAF2FF', '#3B82F6'], warn: ['#FFF6DD', '#F59E0B'], ok: ['#E7F7EC', '#22A559'], error: ['#FDECEC', '#E5484D'] };
  function blockAttrs(b, cls) {
    return 'class="doc-b' + (cls ? ' ' + cls : '') + '" data-id="' + esc(b.id) + '" data-type="' + esc(b.type) + '"' +
      (b.type === 'heading' ? ' data-level="' + Math.min(3, Math.max(1, Number(b.level) || 1)) + '"' : '') +
      (b.type === 'list' && Number(b.level) > 0 ? ' data-level="' + Math.min(3, Number(b.level)) + '"' : '') +
      (Number(b.indent) > 0 ? ' data-indent="' + Math.min(8, Number(b.indent)) + '"' : '') +
      (b.callout ? ' data-callout="' + esc(b.callout) + '"' : '') +
      (Number(b.hanging) > 0 ? ' data-hanging="' + Number(b.hanging) + '"' : '') +
      (b.box ? ' data-box="' + esc(b.box.shape) + '" data-box-w="' + Number(b.box.w) + '" data-box-float="' + esc(b.box.float) + '" data-box-fill="' + esc(b.box.fill) + '" data-box-border="' + esc(b.box.border) + '"' : '') +
      (b.caption ? ' data-caption="' + esc(b.caption) + '"' : '') + blockStyle(b);
  }

  // Etiqueta que lleva cada tipo de bloque en la superficie.
  function tagForBlock(b) {
    if (b.type === 'heading') return 'h' + Math.min(3, Math.max(1, Number(b.level) || 1));
    if (b.type === 'quote') return 'blockquote';
    if (b.type === 'code') return 'pre';
    if (b.type === 'list') return b.ordered ? 'ol' : 'ul';
    if (b.type === 'table') return 'table';
    if (b.type === 'hr') return 'hr';
    if (b.type === 'image' || b.type === 'pagebreak' || b.type === 'toc') return 'div';
    return 'p';
  }

  // Un bloque del modelo -> el HTML de UN elemento de la superficie. Mismas
  // etiquetas que core/html.js (lo que se imprime y exporta), para que editar y
  // ver sea lo mismo que sacar el PDF.
  function blockMarkup(b) {
    const tag = tagForBlock(b);
    if (b.type === 'list') {
      const items = Array.isArray(b.items) && b.items.length ? b.items : [''];
      return '<' + tag + ' ' + blockAttrs(b) + '>' + items.map((it, i) =>
        '<li' + (b.itemLevels && b.itemLevels[i] > 0 ? ' data-lvl="' + Math.min(2, b.itemLevels[i]) + '"' : '') + '>' + inlineHtml(it, Array.isArray(b.itemRuns) ? b.itemRuns[i] : null) + '</li>').join('') + '</' + tag + '>';
    }
    if (b.type === 'table') {
      const rows = Array.isArray(b.rows) ? b.rows : [];
      const merges = Array.isArray(b.merges) ? b.merges : [];
      const mAt = (r, c) => merges.find((m) => r >= m.r && r < m.r + m.rows && c >= m.c && c < m.c + m.cols);
      const hasW = Array.isArray(b.colWidths) && b.colWidths.length > 0;
      let out = '<table ' + blockAttrs(b) + (b.borders ? ' data-borders="' + b.borders + '"' : '') + (hasW ? ' style="table-layout:fixed"' : '') + '>' +
        (hasW ? '<colgroup>' + b.colWidths.map((w) => '<col style="width:' + Number(w) + '%">').join('') + '</colgroup>' : '') + '<tbody>';
      rows.forEach((row, ri) => {
        const cellTag = (b.header !== false && ri === 0) ? 'th' : 'td';
        out += '<tr>';
        (Array.isArray(row) ? row : []).forEach((cell, ci) => {
          const m = mAt(ri, ci);
          if (m && !(m.r === ri && m.c === ci)) return;
          const span = m ? (m.cols > 1 ? ' colspan="' + m.cols + '"' : '') + (m.rows > 1 ? ' rowspan="' + m.rows + '"' : '') : '';
          const fill = b.cellFill && b.cellFill[ri + ',' + ci];
          const cbSpec = b.cellBorders && b.cellBorders[ri + ',' + ci];
          const fstParts = [fill && /^#[0-9a-f]{6}$/i.test(fill) ? 'background:' + fill : '', cbSpec && window.MCDoc && window.MCDoc.model ? window.MCDoc.model.cellBorderCss(cbSpec) : ''].filter(Boolean).join(';');
          const fst = fstParts ? ' style="' + fstParts + '"' : '';
          out += '<' + cellTag + span + fst + '>' + inlineHtml(cell, b.cellRuns && b.cellRuns[ri + ',' + ci]) + '</' + cellTag + '>';
        });
        out += '</tr>';
      });
      return out + '</tbody></table>';
    }
    if (b.type === 'image') {
      const w = Number(b.width) > 0 ? ' style="width:' + Number(b.width) + 'px"' : '';
      const cr = b.crop ? ' style="object-view-box:inset(' + b.crop.t + '% ' + b.crop.r + '% ' + b.crop.b + '% ' + b.crop.l + '%)"' : '';
      const fl = b.wrap ? ' data-wrap="' + esc(b.wrap) + '"' : '';
      return '<div ' + blockAttrs(b, 'doc-img-block') + fl + ' contenteditable="false"><span class="doc-img-wrap"' + w + '><img class="doc-img"' + cr + ' src="' +
        esc(b.src || '') + '" alt="' + esc(b.alt || '') + '" draggable="false"><span class="doc-img-handle" data-img-handle></span></span></div>';
    }
    if (b.type === 'pagebreak') {
      return '<div ' + blockAttrs(b, 'doc-pagebreak') + ' contenteditable="false"><span>Salto de página</span></div>';
    }
    if (b.type === 'hr') return '<hr ' + blockAttrs(b) + ' contenteditable="false">';
    if (b.type === 'toc') return '<div ' + blockAttrs(b, 'doc-toc') + ' data-levels="' + (Number(b.levels) || 3) + '"' + (b.kind ? ' data-kind="' + esc(b.kind) + '"' : '') + ' contenteditable="false"></div>';
    if (b.type === 'code') {
      return '<pre ' + blockAttrs(b) + ' spellcheck="false">' + (esc(blockText(b)).replace(/\n/g, '<br>') || '') + '<br></pre>';
    }
    // Parrafo, titulo y cita.
    const inner = inlineHtml(blockText(b), Array.isArray(b.runs) && b.runs.length ? b.runs : null);
    return '<' + tag + ' ' + blockAttrs(b) + '>' + inner + '</' + tag + '>';
  }

  function blockElement(b) {
    const t = document.createElement('template');
    t.innerHTML = blockMarkup(b);
    return t.content.firstElementChild;
  }

  // Numero que se muestra: respeta "empezar a numerar en".
  function shownPage(n) {
    const pg = ui.snap && ui.snap.doc && ui.snap.doc.page;
    return n + ((pg && Number(pg.pageStart) > 1 ? Number(pg.pageStart) : 1) - 1);
  }

  function hfText(tpl, n, total) {
    return String(tpl).replace(/\{n\}/g, String(n)).replace(/\{total\}/g, String(total));
  }

  // {n} y {total} en encabezado y pie: el total se conoce al terminar de paginar.
  function refreshHfTokens() {
    const st = surface();
    if (!st) return;
    const papers = Array.from(st.querySelectorAll('.doc-paper'));
    papers.forEach((p, i) => {
      p.querySelectorAll('.doc-paper-hf[data-tpl]').forEach((d) => {
        const t = hfText(d.dataset.tpl, shownPage(Number(p.dataset.page) || i + 1), papers.length);
        if (d.textContent !== t) d.textContent = t;
      });
    });
  }

  function createPaperPage(stack, page, pageNumber) {
    const scale = 96 / 72;
    const width = Math.max(100, Number(page.width) || 595) * scale;
    const height = Math.max(100, Number(page.height) || 842) * scale;
    const mm = (window.MCDoc && window.MCDoc.model && window.MCDoc.model.margins)
      ? window.MCDoc.model.margins(page)
      : { top: Number(page.margin) || 0, right: Number(page.margin) || 0, bottom: Number(page.margin) || 0, left: Number(page.margin) || 0 };
    const m = { top: mm.top * scale, right: mm.right * scale, bottom: mm.bottom * scale, left: mm.left * scale };
    const paper = document.createElement('section');
    paper.className = 'doc-paper';
    paper.dataset.page = pageNumber;
    paper.style.width = width + 'px';
    paper.style.height = height + 'px';
    paper.style.padding = m.top + 'px ' + m.right + 'px ' + m.bottom + 'px ' + m.left + 'px';
    const content = document.createElement('div');
    content.className = 'doc-paper-content';
    content.style.height = Math.max(1, height - m.top - m.bottom - 2) + 'px';
    paper.appendChild(content);
    // Encabezado y pie van en el margen, como en Word; no entran en el flujo
    // ni en lo que se lee del documento.
    const hf = (cls, text, align, edge) => {
      const d = document.createElement('div');
      d.className = 'doc-paper-hf ' + cls;
      d.setAttribute('contenteditable', 'false');
      d.setAttribute('data-skip', '1');
      d.style.left = m.left + 'px';
      d.style.right = m.right + 'px';
      d.style.textAlign = align || 'left';
      d.style[edge] = Math.max(4, (edge === 'top' ? m.top : m.bottom) / 2 - 7) + 'px';
      d.dataset.tpl = text;
      d.textContent = hfText(text, shownPage(pageNumber), pageNumber);
      paper.appendChild(d);
    };
    if (page.watermark) {
      const wm = document.createElement('div');
      wm.className = 'doc-paper-wm';
      wm.setAttribute('contenteditable', 'false');
      wm.setAttribute('data-skip', '1');
      wm.textContent = page.watermark;
      paper.appendChild(wm);
    }
    const skipHf = !!page.titlePage && pageNumber === 1;
    if (page.header && !skipHf) hf('head', page.header, 'left', 'top');
    if ((page.footer || page.pageNumbers) && !skipHf) {
      const num = page.pageNumbers ? String(shownPage(pageNumber)) : '';
      if (page.footer && page.pageNumbers) {
        hf('foot', page.pageNumbers === 'left' ? num + '   ' + page.footer : page.footer + '   ' + num,
          page.pageNumbers === 'center' ? 'center' : page.pageNumbers, 'bottom');
      } else hf('foot', page.footer || num, page.footer ? 'left' : page.pageNumbers, 'bottom');
    }
    stack.appendChild(paper);
    return content;
  }

  // Una hoja crece lo justo cuando un bloque (tabla, imagen, parrafo largo) es
// mas alto que la pagina entera: si no, quedaria cortado encima de la siguiente.
function growPaperToFit(content) {
  const need = Math.ceil(content.scrollHeight) + 1;
  if (!(need > content.clientHeight + 1)) return false;
  const delta = need - content.clientHeight;
  content.style.height = need + 'px';
  const paper = content.parentElement;
  if (paper && paper.style && paper.style.height) {
    const h = parseFloat(paper.style.height);
    if (isFinite(h)) paper.style.height = (h + delta) + 'px';
  }
  return true;
}

  // ── Parrafos partidos entre hojas ──────────────────────────────────────
  // Un parrafo (o cita) mas largo que lo que queda de la hoja se parte en dos
  // elementos con el mismo data-id; el segundo lleva data-cont. Para el modelo
  // siguen siendo UN bloque (core/dom-blocks.js los une al leer).
  const SPLITTABLE_TAGS = /^(P|BLOCKQUOTE)$/;

  function isSplittable(node) {
    return !!(node && node.tagName && SPLITTABLE_TAGS.test(node.tagName) &&
      node.getAttribute('contenteditable') !== 'false' && (node.textContent || '').length > 1);
  }

  function paperOverflows(content) {
    return content.scrollHeight > content.clientHeight + 1;
  }

  // Junta spans vecinos con el mismo formato y quita los vacios que deja partir.
  function tidyInline(root) {
    root.normalize();
    Array.from(root.childNodes).forEach((n) => {
      if (n.nodeType === 1 && n.tagName === 'SPAN' && !n.textContent && !n.querySelector('img,br')) n.remove();
    });
    const same = (x, y) => x.tagName === y.tagName && /^(SPAN|B|I|U|S|STRONG|EM|A)$/.test(x.tagName) &&
      ['style', 'class', 'href'].every((k) => x.getAttribute(k) === y.getAttribute(k));
    for (let n = root.firstChild; n;) {
      const nx = n.nextSibling;
      if (nx && n.nodeType === 1 && nx.nodeType === 1 && same(n, nx)) {
        while (nx.firstChild) n.appendChild(nx.firstChild);
        nx.remove();
        n.normalize();
        continue;
      }
      n = nx;
    }
  }

  function splitAt(node, k) {
    const p = placeAt(node, k);
    const r = document.createRange();
    r.setStart(p.node, p.offset);
    r.setEndAfter(node.lastChild);
    const frag = r.extractContents();
    const tail = node.cloneNode(false);
    tail.setAttribute('data-cont', '1');
    tail.removeAttribute('data-more');
    tail.appendChild(frag);
    return tail;
  }

  function joinBack(node, tail) {
    while (tail.firstChild) node.appendChild(tail.firstChild);
    node.normalize();
  }

  // El indice se parte POR RENGLONES, no por texto: los renglones son atoms
  // (indice, renglon, paginas con puntos) y partir uno por la mitad dejaria un
  // titulo cortado. Sin esto, un indice con muchos titulos no entra en una hoja
  // y growPaperToFit agrandaba la pagina para que TODAS las entradas cupieran
  // en una sola hoja interminable.
  // NO FUNCIONA (2026-10-18). Se corta el indice por renglones, pero el resultado
  // sigue sin ser el esperado: el usuario reporto que las entradas salen
  // duplicadas y descolocadas ("1-2", "-1", "2-3" en vez de "1", "2", "3") y que
  // corregir el borrado de los trozos NO cambio nada. O sea: el problema NO era
  // solo que los trozos quedaran sueltos, hay algo mas que no se entendio todavia
  // (lo mas probable es que refreshToc este leyendo y escribiendo sobre un DOM
  // que el propio reparto acaba de mover, y que las claves data-sig / data-id no
  // sobrevivan el viaje entre trozos).
  // PENDIENTE: reproducir con un indice de N renglones en un jsdom con medidas
  // reales, seguir el ciclo refreshToc -> relayout -> splitTocToFit y ver en que
  // momento se duplican las filas. NO borrar este bloque antes: es el unico
  // registro de lo que se intento y de lo que se vio.
  function splitTocToFit(node, content) {
    const rows = Array.from(node.querySelectorAll(':scope > .doc-toc-row'));
    if (rows.length < 2) return null;
    const tail = node.cloneNode(false);
    tail.setAttribute('data-cont', '1');
    while (rows.length > 1) {
      const row = rows.pop();
      tail.insertBefore(row, tail.firstChild);
      if (!paperOverflows(content)) return tail;
      // Ese renglon tampoco entra solo: se devuelve arriba y no se parte.
      tail.removeChild(row);
      node.appendChild(row);
      if (rows.length === 0) return null;
    }
    return null;
  }

  // Parte `node` (ya puesto en `content`, que se desborda) donde la hoja se llena.
  // Devuelve el resto (aun sin ubicar) o null si no conviene partir.
  function splitToFit(node, content) {
    const total = (node.textContent || '').length;
    if (total < 2) return null;
    let lo = 1; let hi = total - 1; let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const tail = splitAt(node, mid);
      const fits = !paperOverflows(content);
      joinBack(node, tail);
      if (fits) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (best < 1) return null;
    // Cortar en un espacio cercano en vez de a mitad de palabra.
    const text = node.textContent || '';
    const sp = text.lastIndexOf(' ', best - 1);
    let k = best;
    if (sp > 0 && sp >= best - 60) k = sp + 1;
    if (k >= total) k = best;
    const tail = splitAt(node, k);
    if (paperOverflows(content)) { joinBack(node, tail); return null; }
    // Con otros bloques en la hoja, no dejar una sola linea suelta al pie.
    if (content.childElementCount > 1) {
      const lh = parseFloat(window.getComputedStyle(node).lineHeight) || 18;
      if (node.getBoundingClientRect().height < lh * 1.9) { joinBack(node, tail); return null; }
    }
    tidyInline(node);
    node.setAttribute('data-more', '1');
    return tail;
  }

  // Vuelve a unir los trozos de cada parrafo partido (antes de repartir otra vez).
  function mergeFragments(st, ids) {
    const els = topEls(st);
    for (let i = els.length - 1; i > 0; i--) {
      const e = els[i];
      if (!e.hasAttribute('data-cont')) continue;
      if (ids && !ids.has(e.dataset.id)) continue;
      const prev = els[i - 1];
      if (prev.dataset.id !== e.dataset.id) { e.removeAttribute('data-cont'); continue; }
      while (e.firstChild) prev.appendChild(e.firstChild);
      e.remove();
      prev.removeAttribute('data-more');
      tidyInline(prev);
    }
  }

  // Siguiente trozo del mismo parrafo (en la hoja siguiente) o null.
  function nextFragment(e) {
    const els = topEls();
    const n = els[els.indexOf(e) + 1];
    return n && n.hasAttribute('data-cont') && n.dataset.id === e.dataset.id ? n : null;
  }

  // El reparto quedo viejo: una hoja vacia, o lo que abre una hoja cabria ahora
  // al pie de la anterior (se borro texto). Escribir de mas lo detecta pagesOverflow.
  function fragmentsStale() {
    const st = surface();
    if (!st) return false;
    const cs = Array.from(st.querySelectorAll('.doc-paper-content'));
    for (let i = 1; i < cs.length; i++) {
      const c = cs[i];
      const pc = cs[i - 1];
      if (!pc.clientHeight) continue;
      const first = c.firstElementChild;
      if (!first) return true;
      const last = pc.lastElementChild;
      if (!last || (last.dataset && last.dataset.type === 'pagebreak')) continue;
      if (first.dataset && first.dataset.type === 'heading') continue;
      const free = pc.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom;
      if (first.hasAttribute('data-cont')) {
        const lh = parseFloat(window.getComputedStyle(last).lineHeight) || 18;
        if (free >= lh * 1.1) return true;
      } else if (free >= first.getBoundingClientRect().height + 4) return true;
    }
    return false;
  }

  // Antes de que el navegador haga algo estructural (Enter, pegar, cortar...) los
  // trozos del parrafo tocado se juntan: asi no se parten por la mitad del trozo.
  function defragmentSelection() {
    const st = surface();
    if (!st || !st.querySelector('[data-cont]')) return;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const els = topEls(st);
    const r = sel.getRangeAt(0);
    const a = els.findIndex((x) => x.contains(r.startContainer));
    const b = els.findIndex((x) => x.contains(r.endContainer));
    if (a < 0 && b < 0) return;
    const ids = new Set();
    for (let i = Math.max(0, Math.min(a < 0 ? b : a, b < 0 ? a : b)); i <= Math.max(a, b); i++) if (els[i].dataset.id) ids.add(els[i].dataset.id);
    const cap = captureSel();
    mergeFragments(st, ids);
    restoreSel(cap);
  }

  // Reparte los elementos de bloque en hojas. Un salto de pagina cierra la hoja.
  // Los nodos se mueven (no se recrean): el texto que se esta escribiendo no se pierde.
  function layoutPaperPages(stack, els, page) {
    stack.replaceChildren();
    // Las hojas se arman y miden de a una en una en un contenedor auxiliar
    // (oculto) y recien terminadas pasan a la pila: medir con todas las hojas
    // montadas rehacia el layout de toda la pila en cada parrafo (O(n^2)).
    const probe = stack.cloneNode(false);
    probe.removeAttribute('id');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText += ';position:absolute;visibility:hidden;pointer-events:none;left:-100000px;top:0;width:' + stack.offsetWidth + 'px;height:auto;';
    stack.parentNode.insertBefore(probe, stack);
    let content = createPaperPage(probe, page, 1);
    const nextPage = () => {
      stack.appendChild(content.parentElement);
      return createPaperPage(probe, page, stack.children.length + 1);
    };
    try {
    // Sin medidas reales no se puede repartir: el panel recien mostrado todavia
    // mide cero y todo el documento caeria en una sola hoja interminable.
    if (!content.clientHeight || !content.clientWidth) {
      for (const node of els) content.appendChild(node);
      needsRelayout = true;
      stack.appendChild(content.parentElement);
      return;
    }
    // Cola: un parrafo que no cabe se parte y su resto vuelve a la cola.
    const queue = els.slice().reverse();
    while (queue.length) {
      const node = queue.pop();
      content.appendChild(node);
      if (node.dataset && node.dataset.type === 'pagebreak') {
        // El salto ya cumplio: cerro la hoja, asi que no se dibuja la marca.
        node.dataset.paged = '1';
        content = nextPage();
        continue;
      }
      if (!paperOverflows(content)) continue;
      // El indice se parte por renglones (no por texto, ni por mitades).
      if (node.classList && node.classList.contains('doc-toc')) {
        const cola = splitTocToFit(node, content);
        if (cola) {
          content = nextPage();
          queue.push(cola);
          continue;
        }
      }
      if (isSplittable(node)) {
        const tail = splitToFit(node, content);
        if (tail) {
          content = nextPage();
          queue.push(tail);
          continue;
        }
      }
      if (content.childElementCount > 1) {
        content.removeChild(node);
        // Un titulo no puede quedar solo al pie de la hoja: se va con lo que sigue.
        const prev = content.lastElementChild;
        if (prev && prev.dataset && prev.dataset.type === 'heading' && content.childElementCount > 1) {
          content.removeChild(prev);
          content = nextPage();
          content.appendChild(prev);
        } else {
          content = nextPage();
        }
        queue.push(node);
        continue;
      }
      // El bloque es mas alto que una hoja entera: agrandarla en vez de partilo.
      growPaperToFit(content);
    }
    needsRelayout = false;
    stack.appendChild(content.parentElement);
    } finally { probe.remove(); }
  }

  // Rehace el reparto cuando el panel ya tiene medidas de verdad. Se reintenta
  // unos frames: al abrir la app el panel aparece con una transicion.
  function scheduleRelayout() {
    if (relayoutTimer) return;
    if (relayoutTries > 60) { relayoutTries = 0; return; }
    relayoutTries++;
    relayoutTimer = requestAnimationFrame(() => {
      relayoutTimer = 0;
      const st = surface();
      // Si el panel ya no esta (se cerro la pestana o la app), no insistir:
      // el bucle se queda vivo para siempre si no.
      if (!st || !st.isConnected) { relayoutTries = 0; return; }
      if (!st.offsetWidth || !st.clientHeight) { scheduleRelayout(); return; }
      relayoutTries = 0;
      needsRelayout = false;
      relayout();
    });
  }

  function pageOfDoc() {
    return (ui.snap && ui.snap.doc && ui.snap.doc.page) || { width: 595, height: 842, margin: 57 };
  }

  // Alguna hoja se desborda (se escribio de mas): hay que repartir otra vez.
  function pagesOverflow() {
    const st = surface();
    if (!st) return false;
    return Array.from(st.querySelectorAll('.doc-paper-content')).some((c) => (c.childElementCount > 1 || isSplittable(c.firstElementChild)) && c.scrollHeight > c.clientHeight + 1);
  }

  function relayout() {
    const st = surface();
    if (!st) return;
    const cap = captureSel();
    mergeFragments(st);
    layoutPaperPages(st, topEls(st), pageOfDoc());
    if (ui.zoom && ui.zoom !== 100) st.style.zoom = String(ui.zoom / 100);
    autoOnePage();
    if (ui.onePage) showSheet(ui.pageIndex);
    restoreSel(cap);
    scheduleRuler();
    if (needsRelayout) scheduleRelayout();
  }

  function textOffset(root, container, offset) {
    try {
      const r = document.createRange();
      r.setStart(root, 0);
      r.setEnd(container, offset);
      return r.toString().replace(/ /g, ' ').length;
    } catch (e) { return null; }
  }

  function placeAt(root, pos) {
    let left = Math.max(0, pos);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = null;
    let last = null;
    while ((node = walker.nextNode())) {
      const len = (node.nodeValue || '').length;
      if (left <= len) return { node: node, offset: left };
      left -= len;
      last = node;
    }
    if (last) return { node: last, offset: (last.nodeValue || '').length };
    return { node: root, offset: 0 };
  }

  // Seleccion como (bloque, desplazamiento de texto): sobrevive a que el DOM se
  // reconstruya, a repartir otra vez las hojas y a que cambie el documento.
  function pointOf(els, node, offset) {
    let i = els.findIndex((e) => e.contains(node));
    let o;
    if (i >= 0) o = textOffset(els[i], node, offset);
    else {
      // Entre bloques (el cursor sobre la hoja misma): el bloque al que apunta el indice.
      const host0 = node.nodeType === 1 ? node : node.parentElement;
      const child = host0 && host0.childNodes[offset];
      i = child ? els.indexOf(child) : els.length - 1;
      if (i < 0) return null;
      o = child ? 0 : textOffset(els[i], els[i], els[i].childNodes.length);
    }
    o = o == null ? 0 : o;
    // Un trozo de parrafo partido: el desplazamiento cuenta desde el primer trozo.
    let h = i;
    while (h > 0 && els[h].hasAttribute('data-cont') && els[h - 1].dataset.id === els[h].dataset.id) {
      h--;
      o += (els[h].textContent || '').length;
    }
    return { id: els[h].dataset.id || null, i: h, o };
  }

  // Como placeAt, pero recorriendo los trozos de un parrafo partido entre hojas.
  function placeInBlock(el0, pos) {
    let cur = el0;
    let left = Math.max(0, pos);
    for (;;) {
      const len = (cur.textContent || '').length;
      const nxt = nextFragment(cur);
      if (left <= len || !nxt) return placeAt(cur, left);
      left -= len;
      cur = nxt;
    }
  }

  function captureSel() {
    const st = surface();
    const sel = window.getSelection && window.getSelection();
    if (!st || !sel || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    if (!st.contains(r.startContainer) || !st.contains(r.endContainer)) return null;
    const els = topEls(st);
    const a = pointOf(els, r.startContainer, r.startOffset);
    const b = r.collapsed ? a : pointOf(els, r.endContainer, r.endOffset);
    return a && b ? { a, b } : null;
  }

  function restoreSel(cap) {
    if (!cap) return false;
    const st = surface();
    if (!st) return false;
    const els = topEls(st);
    if (!els.length) return false;
    const find = (p) => {
      // Primero el elemento que sigue en el mismo lugar (los ids pueden repetirse
      // mientras se escribe: Enter copia el data-id); si el documento cambio, por id.
      let el = els[p.i] && els[p.i].dataset.id === p.id ? els[p.i] : null;
      if (!el && p.id) el = els.find((e) => e.dataset.id === p.id) || null;
      if (!el) el = els[Math.min(p.i, els.length - 1)];
      return el ? placeInBlock(el, p.o) : null;
    };
    const a = find(cap.a);
    const b = cap.b === cap.a ? a : find(cap.b);
    const sel = window.getSelection && window.getSelection();
    if (!a || !b || !sel) return false;
    try {
      const r = document.createRange();
      r.setStart(a.node, a.offset);
      r.setEnd(b.node, b.offset);
      sel.removeAllRanges();
      sel.addRange(r);
      st.focus({ preventScroll: true });
    } catch (e) { return false; }
    return true;
  }

  // Cursor al final (o inicio) de un bloque.
  function focusBlock(id, atStart) {
    const st = surface();
    if (!st) return;
    const el = topEls(st).find((e) => e.dataset.id === id);
    if (!el) return;
    const p = placeInBlock(el, atStart ? 0 : 1e9);
    const sel = window.getSelection && window.getSelection();
    if (!sel) return;
    try {
      const r = document.createRange();
      r.setStart(p.node, p.offset);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
      st.focus({ preventScroll: true });
    } catch (e) { /* sin cursor */ }
  }

  function render() {
    const b0 = el('doc-body');
    if (!b0) return;
    const snap = ui.snap;
    if (!snap || !snap.open) {
      b0.innerHTML = '<div class="doc-empty"><h3>Ningun documento abierto</h3>' +
        '<p>Abri un PDF, DOCX, TXT o Markdown para editarlo.</p>' +
        '<p style="margin-top:14px"><button class="doc-btn primary" id="doc-open2">Abrir documento</button></p></div>';
      const b2 = b0.querySelector('#doc-open2');
      if (b2) b2.addEventListener('click', onOpen);
      return;
    }
    applyDocStyles();
    applyPaperTone();
    const cap = captureSel();
    const ae = document.activeElement;
    const hadFocus = !!(cap && ae && (ae === surface() || (host() && host().contains(ae) && !ae.closest('.doc-modal'))));
    const scrollY = b0.scrollTop;
    const blocks = (snap.doc && snap.doc.blocks) || [];
    const els = blocks.map(blockElement).filter(Boolean);
    const stack = document.createElement('div');
    stack.className = 'doc-paper-stack';
    stack.setAttribute('contenteditable', 'true');
    stack.setAttribute('spellcheck', 'true');
    stack.setAttribute('role', 'textbox');
    stack.setAttribute('aria-multiline', 'true');
    stack.setAttribute('aria-label', 'Contenido del documento');
    b0.replaceChildren(stack);
    layoutPaperPages(stack, els, snap.doc.page || { width: 595, height: 842, margin: 57 });
    if (ui.zoom && ui.zoom !== 100) stack.style.zoom = String(ui.zoom / 100);
    autoOnePage();
    if (ui.onePage) showSheet(ui.pageIndex);
    const have = new Set(blocks.map((b) => b.id));
    const keep = (ui.selIds || []).filter((x) => have.has(x));
    setSelection(keep, ui.selectedBlockId);
    if (cap && (hadFocus || ui.keepFocus)) restoreSel(cap);
    b0.scrollTop = scrollY;
    if (needsRelayout) scheduleRelayout();
  }

  // Para distinguir pestañas manda el nombre del archivo; el titulo que trae el
  // documento dentro (primer encabezado) va como dato secundario.
  function labelOf(snap) {
    if (!snap || !snap.open) return 'Documentos';
    return snap.sourceName || (snap.doc && snap.doc.title) || 'Documento';
  }

  function renderChrome() {
    const h = host();
    if (!h) return;
    const snap = ui.snap;
    const t = el('doc-title');
    const s = el('doc-sub');
    const btnSave = el('doc-save');
    const btnUndo = el('doc-undo');
    const btnRedo = el('doc-redo');
    if (!snap || !snap.open) {
      t.textContent = 'Documentos';
      s.textContent = '';
      btnSave.disabled = true;
      btnUndo.disabled = true;
      btnRedo.disabled = true;
      setTabTitle('📄 Documentos');
      return;
    }
    const nombre = labelOf(snap);
    paintSaveState();
    const bits = [];
    bits.push(snap.capabilities && snap.capabilities.isPdfSource ? 'PDF' : String(snap.format || '').toUpperCase());
    if (snap.pageCount) bits.push(snap.pageCount + ' pag');
    bits.push(((snap.doc && snap.doc.blocks) || []).length + ' bloques');
    const tituloDoc = snap.doc && snap.doc.title;
    if (tituloDoc && tituloDoc !== nombre) bits.push(tituloDoc);
    s.textContent = bits.join(' · ');
    btnSave.disabled = !snap.dirty || !snap.sourcePath;
    btnUndo.disabled = !snap.history?.canUndo;
    btnRedo.disabled = !snap.history?.canRedo;
    setTabTitle('📄 ' + nombre + (snap.dirty ? ' *' : ''));
  }

  function renderWarnings() {
    const wh = el('doc-warn-host');
    if (!wh) return;
    const w = (ui.snap && ui.snap.warnings) || [];
    wh.innerHTML = w.length
      ? '<div class="doc-warn">' + esc(w.slice(0, 3).join(' · ')) +
        (w.length > 3 ? ' (+' + (w.length - 3) + ' avisos)' : '') + '</div>'
      : '';
  }

  // ── Regla: margenes de la hoja y sangrias del parrafo ────────────────
  const CM_PT = 28.3465;
  let rulerFrame = 0;
  function scheduleRuler() {
    if (rulerFrame) return;
    rulerFrame = requestAnimationFrame(() => { rulerFrame = 0; paintRuler(); });
  }

  function rulerGeometry() {
    const st = surface();
    const ruler = el('doc-ruler');
    if (!st || !ruler || !ui.snap || !ui.snap.open || ui.view === 'pages') return null;
    const paper = Array.from(st.querySelectorAll('.doc-paper')).find((p) => p.offsetWidth > 0);
    if (!paper) return null;
    const page = pageOfDoc();
    const pw = Number(page.width) || 595;
    const mm = (window.MCDoc && window.MCDoc.model && window.MCDoc.model.margins) ? window.MCDoc.model.margins(page) : { left: Number(page.margin) || 0, right: Number(page.margin) || 0 };
    const pr = paper.getBoundingClientRect();
    const rr = ruler.getBoundingClientRect();
    return { ruler, pw, left: mm.left, right: mm.right, ppp: pr.width / pw, x0: pr.left - rr.left, width: pr.width };
  }

  function paintRuler() {
    const ruler = el('doc-ruler');
    if (!ruler) return;
    const g = rulerGeometry();
    if (!g) { ruler.hidden = true; return; }
    ruler.hidden = false;
    const g2 = rulerGeometry() || g;     // hidden -> visible cambia la medida
    const { ppp, x0 } = g2;
    let h = '<div class="ruler-page" style="left:' + x0 + 'px;width:' + g2.width + 'px">';
    h += '<div class="ruler-margin" style="left:0;width:' + (g2.left * ppp) + 'px"></div>';
    h += '<div class="ruler-margin" style="right:0;width:' + (g2.right * ppp) + 'px"></div>';
    for (let i = 0; i * CM_PT / 2 <= g2.pw; i++) {
      const x = i * CM_PT / 2 * ppp;
      const big = i % 2 === 0;
      h += '<div class="ruler-tick" style="left:' + x + 'px;height:' + (big ? 9 : 5) + 'px"></div>';
      if (big && i > 0) h += '<div class="ruler-num" style="left:' + x + 'px">' + (i / 2) + '</div>';
    }
    h += '<div class="ruler-mh" data-ruler="mleft" title="Margen izquierdo" style="left:' + (g2.left * ppp) + 'px"></div>';
    h += '<div class="ruler-mh" data-ruler="mright" title="Margen derecho" style="left:' + ((g2.pw - g2.right) * ppp) + 'px"></div>';
    const blk = selectedBlock();
    if (blk && ['paragraph', 'quote', 'heading', 'list', 'code'].includes(blk.type)) {
      const ind = (Number(blk.indent) || 0) * 18;
      h += '<div class="ruler-ind left" data-ruler="indent" title="Sangría del párrafo" style="left:' + ((g2.left + ind) * ppp) + 'px"></div>';
      if (blk.type === 'paragraph' || blk.type === 'quote') {
        h += '<div class="ruler-ind first" data-ruler="first" title="Sangría de primera línea" style="left:' + ((g2.left + ind + (Number(blk.firstLine) || 0)) * ppp) + 'px"></div>';
      }
    }
    ruler.innerHTML = h + '</div>';
  }

  function wireRuler() {
    const ruler = el('doc-ruler');
    if (!ruler || ruler.dataset.wired) return;
    ruler.dataset.wired = '1';
    ruler.addEventListener('mousedown', (e) => {
      const hnd = e.target.closest && e.target.closest('[data-ruler]');
      if (!hnd || e.button !== 0) return;
      const g = rulerGeometry();
      if (!g) return;
      e.preventDefault();
      const kind = hnd.dataset.ruler;
      const startX = e.clientX;
      const startLeft = parseFloat(hnd.style.left) || 0;
      const blk = selectedBlock();
      const ind0 = blk ? (Number(blk.indent) || 0) * 18 : 0;
      let pt = null;       // valor final en puntos
      const move = (ev) => {
        const px = startLeft + (ev.clientX - startX);
        const absPt = px / g.ppp;                         // desde el borde izquierdo de la hoja
        if (kind === 'mleft') pt = Math.max(0, Math.min(g.pw - g.right - 72, Math.round(absPt)));
        else if (kind === 'mright') pt = Math.max(0, Math.min(g.pw - g.left - 72, Math.round(g.pw - absPt)));
        else if (kind === 'indent') pt = Math.max(0, Math.min(8, Math.round((absPt - g.left) / 18)));
        else pt = Math.max(0, Math.min(144, Math.round((absPt - g.left - ind0) / 3) * 3));
        const shown = kind === 'mleft' ? pt : kind === 'mright' ? g.pw - pt : kind === 'indent' ? g.left + pt * 18 : g.left + ind0 + pt;
        hnd.style.left = (shown * g.ppp) + 'px';
      };
      const up = async () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        if (pt == null) return;
        if (kind === 'mleft' || kind === 'mright') {
          await flushPending();
          const res = await docEdit({ expectedHash: ui.snap.doc.hash, ops: [{ op: 'page', [kind === 'mleft' ? 'marginLeft' : 'marginRight']: pt }] });
          if (res && res.ok) { applySnapshot(res); scheduleAutoSave(); }
          else if (res && res.error) { toast(res.error, 'error'); scheduleRuler(); }
        } else if (kind === 'indent') {
          applySelectedBlock((b) => { const next = Object.assign({}, b); if (pt) next.indent = pt; else delete next.indent; return next; });
        } else {
          applySelectedBlock((b) => {
            if (b.type !== 'paragraph' && b.type !== 'quote') return null;
            const next = Object.assign({}, b);
            if (pt) next.firstLine = pt; else delete next.firstLine;
            return next;
          });
        }
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    window.addEventListener('resize', scheduleRuler);
    const sc = el('doc-scroll');
    if (sc) sc.addEventListener('scroll', scheduleRuler, { passive: true });
  }

  // Contador de palabras y caracteres (documento y seleccion).
  let statsTimer = 0;
  function scheduleStats() {
    if (statsTimer) return;
    statsTimer = setTimeout(() => { statsTimer = 0; paintStats(); refreshHfTokens(); refreshToc(); if (sidePanel.open) paintNotesPanel(); if (find.open) runFind(true); }, 250);
  }

  function paintStats() {
    const box = el('doc-stats');
    const st = surface();
    if (!box) return;
    if (!st || !domBlocks || !domBlocks.countText) { box.textContent = ''; return; }
    const total = domBlocks.countText(domBlocks.surfaceText(st));
    let txt = total.words + ' palabras · ' + total.chars + ' caracteres';
    const sel = window.getSelection && window.getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed && st.contains(sel.anchorNode)) {
      const part = domBlocks.countText(sel.toString());
      if (part.words || part.chars) txt += '   |   Selección: ' + part.words + ' palabras · ' + part.chars + ' caracteres';
    }
    box.textContent = txt;
  }

  function repaint() {
    if (!host()) return;
    scheduleStats();
    scheduleRuler();
    renderChrome();
    renderWarnings();
    if (ui.view === 'pages') renderPages();
    else render();
  }

  function autosize(ta) {
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.max(ta.scrollHeight, 18) + 'px';
  }

  // ── Paginas del PDF ────────────────────────────────────────────────────
  async function renderPages() {
    const scroll = el('doc-scroll');
    if (!scroll) return;
    const b0 = el('doc-body');
    const token = ++ui.pdfRenderToken;
    b0.innerHTML = '<div class="doc-empty"><p>Cargando paginas...</p></div>';
    const res = await API.docBytes();
    if (token !== ui.pdfRenderToken) return;
    if (!res || !res.ok || !res.bytes) {
      b0.innerHTML = '<div class="doc-empty"><h3>Sin paginas que mostrar</h3>' +
        '<p>La vista de paginas solo existe para los PDF originales. Para TXT, Markdown o DOCX usa la pestana Contenido.</p></div>';
      return;
    }
    try {
      const lib = await loadPdfjs();
      if (token !== ui.pdfRenderToken) return;
      const task = lib.getDocument({ data: new Uint8Array(res.bytes), disableWorker: true, isEvalSupported: false });
      const pdf = await task.promise;
      if (token !== ui.pdfRenderToken) return;
      b0.innerHTML = '<div class="doc-pages"></div>';
      const pages = b0.querySelector('.doc-pages');
      const total = pdf.numPages;
      const MAX = 60;
      for (let i = 1; i <= Math.min(total, MAX); i++) {
        const page = await pdf.getPage(i);
        if (token !== ui.pdfRenderToken) return;
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min((scroll.clientWidth - 60) / base.width, 1.5) || 1;
        const vp = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        const wrap = document.createElement('div');
        wrap.className = 'doc-page-wrap';
        wrap.appendChild(canvas);
        const no = document.createElement('span');
        no.className = 'doc-page-no';
        no.textContent = i + ' / ' + total;
        wrap.appendChild(no);
        pages.appendChild(wrap);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      }
      if (total > MAX) {
        const note = document.createElement('div');
        note.className = 'doc-empty';
        note.innerHTML = '<p>Solo se pintan las primeras ' + MAX + ' paginas de ' + total +
          '.<br>El texto completo esta en la pestana Contenido.</p>';
        pages.appendChild(note);
      }
    } catch (e) {
      if (token !== ui.pdfRenderToken) return;
      b0.innerHTML = '<div class="doc-empty"><h3>No pude pintar las paginas</h3><p>' + esc(e.message) + '</p></div>';
    }
  }

  // pdf.js en el renderer: los bundles estan vendorizados y se sirven por
  // file://, asi que se puede usar el worker fake sin CSP que lo bloquee.
  const VENDOR = '../modules/document-editor/vendor/';
  let pdfjsPromise = null;
  function loadPdfjs() {
    if (pdfjsPromise) return pdfjsPromise;
    pdfjsPromise = injectScript(VENDOR + 'pdf.worker.min.js')
      .then(() => injectScript(VENDOR + 'pdf.min.js'))
      .then(() => {
        const lib = window.pdfjsLib;
        if (!lib) throw new Error('pdf.js no se cargo');
        if (lib.GlobalWorkerOptions) lib.GlobalWorkerOptions.workerSrc = VENDOR + 'pdf.worker.min.js';
        return lib;
      })
      .catch((e) => { pdfjsPromise = null; throw e; });
    return pdfjsPromise;
  }

  function injectScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve(true);
      s.onerror = () => reject(new Error('No se pudo cargar ' + src));
      document.head.appendChild(s);
    });
  }

  // ── Acciones ───────────────────────────────────────────────────────────
  // Todas las acciones de abrir/create usan el snapshot que devuelve el main y,
  // ademas, el evento doc:changed. Aplicar el retorno evita que, si el evento
  // llegara tarde o perdiera el renderer, la pestana quedara mostrando el
  // documento anterior.
  async function onOpen() {
    const res = await API.docOpen();
    if (!res) return;
    if (res.error) toast(res.error, 'error');
    else { applySnapshot(res); setView('content'); }
  }

  // ---- Control de cambios --------------------------------------------------
  // Con el modo activo, lo escrito va en span.doc-ins y lo borrado se envuelve
  // en span.doc-del (sigue en el texto, tachado). Aceptar/Rechazar los resuelve.
  const track = { on: false };

  function trackStamp() {
    const meta = ui.snap && ui.snap.doc && ui.snap.doc.meta;
    const who = ((meta && meta.author) || 'Autor').replace(/\|/g, ' ');
    return who + '|' + new Date().toISOString().slice(0, 19) + 'Z';
  }

  function toggleTrack(force) {
    track.on = typeof force === 'boolean' ? force : !track.on;
    const b = el('doc-track');
    if (b) b.classList.toggle('on', track.on);
    toast(track.on ? 'Control de cambios activado' : 'Control de cambios desactivado');
  }

  const trackAncestor = (node, cls) => {
    const e = node && (node.nodeType === 1 ? node : node.parentElement);
    return e && e.closest ? e.closest(cls) : null;
  };

  function markDeleted(range, backward) {
    const frag = range.extractContents();
    const span = document.createElement('span');
    span.className = 'doc-del';
    span.setAttribute('data-del', trackStamp());
    span.appendChild(frag);
    range.insertNode(span);
    const sel = window.getSelection();
    const r = document.createRange();
    if (backward) r.setStartBefore(span); else r.setStartAfter(span);
    r.collapse(true);
    sel.removeAllRanges(); sel.addRange(r);
    markDirty();
  }

  function onTrackInput(e) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return false;
    const type = e.inputType;
    const isDel = type === 'deleteContentBackward' || type === 'deleteContentForward';
    if (type === 'insertText' && e.data) {
      let range = sel.getRangeAt(0);
      if (!sel.isCollapsed) {
        const bs = trackAncestor(range.startContainer, '.doc-b'), be = trackAncestor(range.endContainer, '.doc-b');
        if (!bs || bs !== be) return false;
        markDeleted(range, false);
        range = sel.getRangeAt(0);
      }
      if (trackAncestor(range.startContainer, '.doc-ins')) return false;
      e.preventDefault();
      const span = document.createElement('span');
      span.className = 'doc-ins';
      span.setAttribute('data-ins', trackStamp());
      const tn = document.createTextNode(e.data);
      span.appendChild(tn);
      range.insertNode(span);
      const r = document.createRange();
      r.setStart(tn, tn.nodeValue.length); r.collapse(true);
      sel.removeAllRanges(); sel.addRange(r);
      markDirty();
      return true;
    }
    if (!isDel) return false;
    const backward = type === 'deleteContentBackward';
    if (sel.isCollapsed && typeof sel.modify === 'function') sel.modify('extend', backward ? 'backward' : 'forward', 'character');
    if (sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    const bs = trackAncestor(range.startContainer, '.doc-b'), be = trackAncestor(range.endContainer, '.doc-b');
    if (!bs || bs !== be) { return false; }
    const insS = trackAncestor(range.startContainer, '.doc-ins'), insE = trackAncestor(range.endContainer, '.doc-ins');
    if (insS && insS === insE) return false;
    e.preventDefault();
    const delS = trackAncestor(range.startContainer, '.doc-del'), delE = trackAncestor(range.endContainer, '.doc-del');
    if (delS && delS === delE) {
      const r = document.createRange();
      if (backward) r.setStartBefore(delS); else r.setStartAfter(delS);
      r.collapse(true); sel.removeAllRanges(); sel.addRange(r);
      return true;
    }
    markDeleted(range, backward);
    return true;
  }

  async function resolveTracked(accept) {
    const st = surface();
    if (!st) return;
    const sel = window.getSelection();
    let spans = Array.from(st.querySelectorAll('.doc-ins,.doc-del'));
    if (sel && sel.rangeCount && !sel.isCollapsed && st.contains(sel.anchorNode)) {
      const rg = sel.getRangeAt(0);
      spans = spans.filter((s) => rg.intersectsNode(s));
    }
    if (!spans.length) { toast('No hay cambios para resolver'); return; }
    spans.forEach((s) => {
      const keep = s.classList.contains('doc-ins') ? accept : !accept;
      if (keep) { while (s.firstChild) s.parentNode.insertBefore(s.firstChild, s); s.remove(); }
      else s.remove();
    });
    st.querySelectorAll('.doc-b').forEach((b) => { if (!b.textContent && !b.querySelector('br,img,table')) b.innerHTML = '<br>'; });
    ui.dirty = true;
    await flushPending();
    toast((accept ? 'Aceptados ' : 'Rechazados ') + spans.length + ' cambio(s)');
  }

  // Modo enfoque: sin barras, con el bloque actual resaltado y el resto atenuado.
  function toggleFocus(force) {
    const h = host();
    if (!h) return;
    const on = typeof force === 'boolean' ? force : !h.classList.contains('doc-focus');
    h.classList.toggle('doc-focus', on);
    if (on) markFocusBlock(); else clearFocusBlock();
    if (on) toast('Modo enfoque: Esc para salir');
  }

  function clearFocusBlock() {
    const st = surface();
    if (st) st.querySelectorAll('.doc-b[data-cur]').forEach((n) => n.removeAttribute('data-cur'));
  }

  function markFocusBlock() {
    const h = host();
    if (!h || !h.classList.contains('doc-focus')) return;
    clearFocusBlock();
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const n = sel.anchorNode;
    const e = n && (n.nodeType === 1 ? n : n.parentElement);
    const b = e && e.closest && e.closest('.doc-b');
    if (b && inSurface(b)) b.setAttribute('data-cur', '1');
  }

  // Asistente de texto: manda SOLO la seleccion al proveedor de IA configurado
  // y muestra la propuesta; nada cambia hasta que se acepta.
  const AI_TASKS = {
    improve: 'Reescribí el texto para que sea más claro y fluido, conservando el significado y el idioma.',
    shorter: 'Acortá el texto a lo esencial, conservando el significado y el idioma.',
    formal: 'Reescribí el texto con un tono más formal y profesional, conservando el significado y el idioma.',
    fix: 'Corregí ortografía, gramática y puntuación sin cambiar el estilo ni el sentido.',
    summary: 'Resumí el texto en pocas oraciones, en el mismo idioma.',
    en: 'Traducí el texto al inglés.',
    es: 'Traducí el texto al español.'
  };

  async function aiTextAssist() {
    const ce = activeCe();
    if (!ce) { toast('Seleccioná el texto primero', 'error'); return; }
    if (!API.aiChat) { toast('El asistente de IA no está disponible', 'error'); return; }
    const sel = window.getSelection();
    const range = sel && sel.rangeCount && ce.contains(sel.getRangeAt(0).commonAncestorContainer) ? sel.getRangeAt(0).cloneRange() : ui.savedRange;
    const text = range ? range.toString().trim() : '';
    if (!range || !text) { toast('Seleccioná el texto primero', 'error'); return; }
    const b1 = trackAncestor(range.startContainer, '.doc-b'), b2 = trackAncestor(range.endContainer, '.doc-b');
    if (!b1 || b1 !== b2) { toast('La selección tiene que estar dentro de un solo párrafo', 'error'); return; }
    if (text.length > 6000) { toast('Selección demasiado larga (máx. 6000 caracteres)', 'error'); return; }
    const r = await modal({
      title: 'Asistente de texto (IA)',
      message: 'Se envía solo el texto seleccionado a tu proveedor de IA. Después vas a poder revisar el resultado antes de reemplazar.',
      fields: [
        { name: 'task', label: 'Acción', value: 'improve', options: [['improve', 'Mejorar redacción'], ['shorter', 'Acortar'], ['formal', 'Tono más formal'], ['fix', 'Corregir ortografía'], ['summary', 'Resumir'], ['en', 'Traducir al inglés'], ['es', 'Traducir al español'], ['syn', 'Sinónimos con IA (según el contexto)']] },
        { name: 'extra', label: 'Indicación extra (opcional)', value: '' }
      ],
      ok: 'Generar'
    });
    if (!r) return;
    toast('Consultando a la IA…');
    if (r.task === 'syn') { await aiSynonymPick(range, text, ce, b1); return; }
    const instruction = AI_TASKS[r.task] + (r.extra ? ' Indicación adicional: ' + String(r.extra).slice(0, 300) : '');
    let out;
    try {
      out = await API.aiChat({
        system: 'Sos un asistente de edición de texto. Respondé SOLO con el texto resultante, sin comillas, sin explicaciones ni encabezados.',
        messages: [{ role: 'user', content: instruction + '\n\nTEXTO:\n' + text }]
      });
    } catch (e) { out = { error: e.message }; }
    if (!out || out.error || !String(out.text || '').trim()) { toast((out && out.error) || 'La IA no devolvió texto', 'error'); return; }
    const proposal = String(out.text).trim().replace(/^["“]|["”]$/g, '');
    const ok = await modal({
      title: 'Propuesta de la IA',
      message: 'Podés editarla antes de reemplazar. Original: «' + (text.length > 120 ? text.slice(0, 120) + '…' : text) + '»',
      fields: [{ name: 'text', label: 'Texto propuesto', value: proposal }],
      ok: 'Reemplazar'
    });
    if (!ok || !String(ok.text || '').trim()) return;
    ui.savedRange = range; ui.savedCe = ce;
    ce.focus({ preventScroll: true });
    const cur = window.getSelection();
    cur.removeAllRanges(); cur.addRange(range);
    try { document.execCommand('insertText', false, String(ok.text).replace(/\s*\n+\s*/g, ' ').trim()); } catch (e) { /* nada */ }
    markDirty();
    toast('Texto reemplazado', null, { label: 'Deshacer', run: () => travelHistory('undo') });
  }

  // Sinonimos con IA segun el contexto de la oracion.
  async function aiSynonymPick(range, text, ce, b1) {
      if (text.length > 80) { toast('Para sinónimos seleccioná una palabra o frase corta', 'error'); return; }
      const ctxText = (b1.textContent || '').slice(0, 400);
      let res;
      try {
        res = await API.aiChat({
          system: 'Sos un tesauro. Respondé SOLO con una lista de hasta 8 sinónimos o alternativas, separados por saltos de línea, sin numeración ni explicaciones, en el mismo idioma y respetando el sentido en el contexto.',
          messages: [{ role: 'user', content: 'Palabra o frase: ' + text + '\nContexto: ' + ctxText }]
        });
      } catch (e) { res = { error: e.message }; }
      if (!res || res.error) { toast((res && res.error) || 'La IA no devolvió sinónimos', 'error'); return; }
      const opts = String(res.text || '').split('\n').map((x) => x.replace(/^[\s\-*•\d.)]+/, '').trim()).filter(Boolean).slice(0, 8);
      if (!opts.length) { toast('La IA no devolvió sinónimos', 'error'); return; }
      const pick = await modal({ title: 'Sinónimos de «' + text + '»', fields: [{ name: 'w', label: 'Reemplazar por', value: opts[0], options: opts.map((o) => [o, o]) }], ok: 'Reemplazar' });
      if (!pick || !pick.w) return;
      ui.savedRange = range; ui.savedCe = ce;
      ce.focus({ preventScroll: true });
      const cur2 = window.getSelection();
      cur2.removeAllRanges(); cur2.addRange(range);
      try { document.execCommand('insertText', false, pick.w); } catch (e) { /* nada */ }
      markDirty();
      toast('Reemplazado', null, { label: 'Deshacer', run: () => travelHistory('undo') });
      return;
  }

  // Sinonimos: primero el tesauro local (sin conexion); si no hay, la IA.
  async function synonymsAssist() {
    const ce = activeCe();
    if (!ce) { toast('Hacé clic en una palabra primero', 'error'); return; }
    const sel = window.getSelection();
    if (sel && sel.rangeCount && sel.isCollapsed && ce.contains(sel.anchorNode) && typeof sel.modify === 'function') {
      sel.modify('move', 'backward', 'word'); sel.modify('extend', 'forward', 'word');
    }
    const range = sel && sel.rangeCount && ce.contains(sel.getRangeAt(0).commonAncestorContainer) ? sel.getRangeAt(0).cloneRange() : ui.savedRange;
    const text = range ? range.toString().replace(/[\s.,;:!?¡¿()"“”]+$/g, '').trim() : '';
    if (!range || !text) { toast('Seleccioná o poné el cursor en una palabra', 'error'); return; }
    const b1 = trackAncestor(range.startContainer, '.doc-b');
    if (!b1 || b1 !== trackAncestor(range.endContainer, '.doc-b')) { toast('La selección tiene que estar dentro de un solo párrafo', 'error'); return; }
    let res = null;
    try { res = API.docThesaurus ? await API.docThesaurus({ word: text }) : null; } catch (e) { res = null; }
    const senses = (res && res.senses) || [];
    if (!senses.length) {
      if (API.aiChat && text.length <= 80) { toast('Sin resultados locales: consultando a la IA…'); await aiSynonymPick(range, text, ce, b1); }
      else toast('No hay sinónimos para «' + text + '»', 'error');
      return;
    }
    const cap = (w) => (text[0] !== text[0].toLowerCase() ? w.charAt(0).toUpperCase() + w.slice(1) : w);
    const upper = text.length > 1 && text === text.toUpperCase();
    const fix = (w) => (upper ? w.toUpperCase() : cap(w));
    const opts = [];
    const seen = new Set();
    senses.forEach((grp, i) => grp.forEach((w) => {
      const v = fix(w);
      if (seen.has(v.toLowerCase())) return;
      seen.add(v.toLowerCase());
      opts.push([v, (i + 1) + ' · ' + v]);
    }));
    const pick = await modal({ title: 'Sinónimos de «' + text + '»' + (res.base && res.base !== text.toLowerCase() ? ' (' + res.base + ')' : ''),
      fields: [{ name: 'w', label: 'Reemplazar por (el número agrupa por sentido)', value: opts[0][0], options: opts }], ok: 'Reemplazar' });
    if (!pick || !pick.w) return;
    ui.savedRange = range; ui.savedCe = ce;
    ce.focus({ preventScroll: true });
    const cur = window.getSelection();
    cur.removeAllRanges(); cur.addRange(range);
    try { document.execCommand('insertText', false, pick.w); } catch (e) { /* nada */ }
    markDirty();
    toast('Reemplazado', null, { label: 'Deshacer', run: () => travelHistory('undo') });
  }

  // Revision de accesibilidad: lista los problemas y lleva al bloque elegido.
  async function a11yReview() {
    if (!ui.snap || !ui.snap.open) return;
    await flushPending();
    const found = window.MCDoc.a11y.check(ui.snap.doc);
    if (!found.length) { toast('Sin problemas de accesibilidad detectados'); return; }
    const errors = found.filter((f) => f.level === 'error').length;
    const r = await modal({
      title: 'Revisión de accesibilidad',
      message: found.length + ' aviso' + (found.length === 1 ? '' : 's') + (errors ? ' (' + errors + ' importante' + (errors === 1 ? '' : 's') + ')' : '') + '. Elige uno para ir a ese bloque.',
      fields: [{ name: 'id', label: 'Aviso', value: found[0].id, options: found.map((f, i) => [f.id + '|' + i, (f.level === 'error' ? '✖ ' : '⚠ ') + f.message]) }],
      ok: 'Ir al bloque', cancel: 'Cerrar'
    });
    if (!r || !r.id) return;
    const id = String(r.id).split('|')[0];
    select(id);
    const st = surface();
    const n = st && st.querySelector('.doc-b[data-id="' + cssEscape(id) + '"]');
    if (n) n.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  // Semantica y teclado de las barras: rol toolbar, etiquetas para lector de
  // pantalla, aria-pressed en los botones que se encienden y flechas entre
  // botones (Alt+F10 entra a la barra, Esc vuelve al documento).
  function setupA11y(h) {
    const bars = [['.doc-bar', 'Archivo y herramientas'], ['#doc-formatbar', 'Formato del bloque seleccionado'], ['#doc-objbar', 'Herramientas del objeto seleccionado']];
    bars.forEach(([sel, label]) => {
      const bar = h.querySelector(sel);
      if (!bar) return;
      if (!bar.getAttribute('role')) bar.setAttribute('role', 'toolbar');
      if (!bar.getAttribute('aria-label')) bar.setAttribute('aria-label', label);
      bar.addEventListener('keydown', (e) => {
        if (e.target.tagName !== 'BUTTON' || !['ArrowRight', 'ArrowLeft', 'Home', 'End', 'Escape'].includes(e.key)) return;
        if (e.key === 'Escape') { const st = surface(); if (st) { e.preventDefault(); e.stopPropagation(); st.focus({ preventScroll: true }); } return; }
        const items = Array.from(bar.querySelectorAll('button,select')).filter((x) => !x.disabled && x.offsetParent !== null);
        const i = items.indexOf(e.target);
        if (i < 0) return;
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
        e.preventDefault();
        items[next].focus();
      });
    });
    const label = (root) => root.querySelectorAll('button,select,input').forEach((c) => {
      if (c.getAttribute('aria-label') || (c.labels && c.labels.length)) return;
      if (c.tagName === 'BUTTON' && c.textContent.trim().replace(/[^\p{L}\p{N}]/gu, '')) return;   // ya tiene nombre visible
      const t = c.getAttribute('title') || c.getAttribute('placeholder');
      if (t) c.setAttribute('aria-label', t);
    });
    label(h);
    h.querySelectorAll('[data-block-toggle],[data-block-align],[data-block-list],#doc-onepage').forEach((b) => b.setAttribute('aria-pressed', String(b.classList.contains('active') || b.classList.contains('on'))));
    try {
      const mo = new MutationObserver((list) => {
        list.forEach((m) => {
          const t = m.target;
          if (t.nodeType !== 1) return;
          if (m.type === 'attributes' && t.tagName === 'BUTTON') {
            const was = /\b(active|on)\b/.test(m.oldValue || '');
            const now = t.classList.contains('active') || t.classList.contains('on');
            if (was !== now || t.hasAttribute('aria-pressed')) t.setAttribute('aria-pressed', String(now));
          } else if (m.type === 'childList') {
            m.addedNodes.forEach((n) => { if (n.nodeType === 1) { if (/^(BUTTON|SELECT|INPUT)$/.test(n.tagName)) label({ querySelectorAll: () => [n] }); else label(n); } });
          }
        });
      });
      mo.observe(h, { attributes: true, attributeFilter: ['class'], attributeOldValue: true, subtree: true, childList: true });
    } catch (e) { /* sin MutationObserver */ }
    h.addEventListener('keydown', (e) => {
      if (e.altKey && e.key === 'F10') {
        const b = h.querySelector('.doc-bar button:not([disabled])');
        if (b) { e.preventDefault(); b.focus(); }
      }
    });
  }

  function toggleHanging() {
    const cur = selectedBlock();
    if (!cur || !['paragraph', 'quote'].includes(cur.type)) { toast('Pon el cursor en un párrafo', 'error'); return; }
    const on = !(Number(cur.hanging) > 0);
    applySelectedBlock((block) => {
      if (!['paragraph', 'quote'].includes(block.type)) return null;
      const next = Object.assign({}, block);
      if (on) { next.hanging = 36; delete next.firstLine; } else delete next.hanging;
      return next;
    });
  }

  // Citas y bibliografia: la cita va en el texto y la entrada a la lista que
  // sigue al titulo "Referencias" / "Bibliografia" (se crea al final si falta).
  const REF_HEAD = /^(referencias|bibliograf[ií]a|referencias bibliogr[aá]ficas|bibliography|references)$/i;
  const BIB = () => window.MCDoc.biblio;

  const refText = (b) => (b.text != null ? String(b.text) : (b.runs || []).map((r) => r.text).join(''));

  function refSection() {
    const blocks = (ui.snap && ui.snap.doc && ui.snap.doc.blocks) || [];
    const hi = blocks.findIndex((b) => b.type === 'heading' && REF_HEAD.test(String(b.text || '').trim()));
    if (hi < 0) return null;
    let end = hi + 1;
    while (end < blocks.length && blocks[end].type === 'paragraph') end++;
    return { head: hi, start: hi + 1, end, blocks: blocks.slice(hi + 1, end) };
  }

  async function sortReferences(quiet) {
    if (!ui.snap || !ui.snap.open) return;
    await flushPending();
    const sec = refSection();
    if (!sec || !sec.blocks.length) { if (!quiet) toast('No hay lista de referencias (titulo «Referencias»)', 'error'); return; }
    const entries = sec.blocks.map((b) => ({ text: refText(b), runs: b.runs && b.runs.length ? b.runs : [{ text: refText(b) }] }));
    const arranged = BIB().arrange(entries);
    const ops = [];
    arranged.forEach((e, i) => {
      const old = sec.blocks[i];
      if (refText(old) !== e.text || JSON.stringify(old.runs || null) !== JSON.stringify(e.runs)) ops.push({ op: 'replaceBlock', id: old.id, block: Object.assign({}, old, { text: e.text, runs: e.runs }) });
    });
    if (!ops.length) { if (!quiet) toast('Las referencias ya están en orden'); return; }
    const res = await docEdit({ expectedHash: ui.snap.doc.hash, ops });
    if (res && res.ok) { applySnapshot(res); scheduleAutoSave(); if (!quiet) toast('Referencias actualizadas'); }
    else if (res && res.error) toast(res.error, 'error');
  }

  async function citeDialog() {
    const ce = activeCe();
    if (!ce || !ui.snap || !ui.snap.open) { toast('Hacé clic dentro del documento primero', 'error'); return; }
    const sel0 = window.getSelection();
    const range = sel0 && sel0.rangeCount && ce.contains(sel0.getRangeAt(0).commonAncestorContainer) ? sel0.getRangeAt(0).cloneRange() : ui.savedRange;
    const r = await modal({
      title: 'Insertar cita',
      message: 'Autores como «Apellido, Nombre; Apellido, Nombre». La entrada se añade a la lista «Referencias».',
      fields: [
        { name: 'style', label: 'Estilo', value: 'apa', options: [['apa', 'APA 7 (Autor, año)'], ['iso', 'ISO 690 numérico [n]']] },
        { name: 'authors', label: 'Autores', value: '' },
        { name: 'year', label: 'Año', value: '' },
        { name: 'title', label: 'Título', value: '' },
        { name: 'publisher', label: 'Editorial o fuente', value: '' },
        { name: 'place', label: 'Lugar (ISO)', value: '' },
        { name: 'url', label: 'URL (opcional)', value: '' }
      ],
      ok: 'Insertar'
    });
    if (!r || !String(r.title || '').trim()) return;
    await flushPending();
    const B = BIB();
    const sec0 = refSection();
    const same = sec0 && sec0.blocks.findIndex((b) => refText(b).replace(/^\[\d+\]\s*/, '') === B.plain(B.reference(r, r.style, 1)).replace(/^\[\d+\]\s*/, ''));
    const n = same >= 0 && sec0 ? same + 1 : (sec0 ? sec0.blocks.length : 0) + 1;
    ui.savedRange = range; ui.savedCe = ce;
    ce.focus({ preventScroll: true });
    if (range) { const cur = window.getSelection(); cur.removeAllRanges(); cur.addRange(range); }
    try { document.execCommand('insertText', false, B.cite(r, r.style, n)); } catch (e) { /* nada */ }
    await flushPending();
    if (same >= 0 && sec0) return;
    const runs = B.reference(r, r.style, n);
    const entry = { type: 'paragraph', text: B.plain(runs), runs };
    if (r.style === 'apa') entry.hanging = 36;
    const list = ui.snap.doc.blocks || [];
    const sec = refSection();
    const ops = sec
      ? [{ op: 'insertBlocks', index: sec.end, blocks: [entry] }]
      : [{ op: 'insertBlocks', index: list.length, blocks: [{ type: 'heading', level: 1, text: 'Referencias' }, entry] }];
    const res = await docEdit({ expectedHash: ui.snap.doc.hash, ops });
    if (res && res.ok) { applySnapshot(res); scheduleAutoSave(); await sortReferences(true); toast('Cita insertada y referencia añadida'); }
    else if (res && res.error) toast(res.error, 'error');
  }

  // Cuadro de texto / forma flotante: el parrafo seleccionado pasa a ser un
  // cuadro con ancho, posicion (el texto lo rodea) y apariencia propios.
  async function boxDialog() {
    const cur = (selectedBlock && selectedBlock()) || null;
    if (!cur || !['paragraph', 'quote'].includes(cur.type)) { toast('Pon el cursor en un párrafo para convertirlo en cuadro', 'error'); return; }
    const b = cur.box || { shape: 'rect', w: 40, float: 'right', fill: '#FFF6DD', border: '#F59E0B' };
    const r = await modal({
      title: 'Cuadro de texto / forma',
      message: 'El párrafo se muestra como cuadro; el resto del texto lo rodea.',
      fields: [
        { name: 'shape', label: 'Forma', value: b.shape, options: [['rect', 'Rectángulo'], ['round', 'Redondeado'], ['ellipse', 'Elipse'], ['none', '(Quitar cuadro)']] },
        { name: 'w', label: 'Ancho (% de la página)', value: String(b.w), options: [['25', '25%'], ['33', '33%'], ['40', '40%'], ['50', '50%'], ['75', '75%'], ['100', '100%']] },
        { name: 'float', label: 'Posición', value: b.float, options: [['left', 'Izquierda (texto a la derecha)'], ['right', 'Derecha (texto a la izquierda)'], ['center', 'Centrado']] },
        { name: 'fill', label: 'Relleno (#RRGGBB)', value: b.fill },
        { name: 'border', label: 'Borde (#RRGGBB)', value: b.border }
      ],
      ok: 'Aplicar'
    });
    if (!r) return;
    applySelectedBlock((block) => {
      const next = Object.assign({}, block);
      if (r.shape === 'none') delete next.box;
      else next.box = { shape: r.shape, w: Number(r.w) || 40, float: r.float, fill: r.fill, border: r.border };
      return next;
    });
  }

  // Lectura en voz alta (voz del sistema, speechSynthesis). Lee la seleccion o,
  // sin seleccion, desde el bloque del cursor hasta el final, resaltando el
  // bloque que suena.
  const reader = { on: false, queue: [], i: 0 };
  const READ_LS = 'mcdoc.read';

  function readPrefs() {
    try { return Object.assign({ rate: '1', voice: '' }, JSON.parse(localStorage.getItem(READ_LS) || '{}')); } catch (e) { return { rate: '1', voice: '' }; }
  }

  function stopReading() {
    reader.on = false; reader.queue = [];
    try { window.speechSynthesis.cancel(); } catch (e) { /* sin voz */ }
    const st = surface();
    if (st) st.querySelectorAll('[data-reading]').forEach((n) => n.removeAttribute('data-reading'));
    const b = el('doc-read');
    if (b) b.classList.remove('on');
  }

  function readableText(node) {
    if (node.dataset.type === 'table') return Array.from(node.querySelectorAll('tr')).map((tr) => Array.from(tr.children).map((c) => c.textContent.trim()).filter(Boolean).join(', ')).join('. ');
    return node.textContent.replace(/\s+/g, ' ').trim();
  }

  function speakNext() {
    const st = surface();
    if (!reader.on || !st) return;
    const prev = st.querySelector('[data-reading]');
    if (prev) prev.removeAttribute('data-reading');
    if (reader.i >= reader.queue.length) { stopReading(); return; }
    const item = reader.queue[reader.i++];
    if (item.node) { item.node.setAttribute('data-reading', '1'); item.node.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    const u = new SpeechSynthesisUtterance(item.text);
    const prefs = readPrefs();
    u.rate = Number(prefs.rate) || 1;
    const voices = window.speechSynthesis.getVoices();
    const v = voices.find((x) => x.name === prefs.voice) || voices.find((x) => /^es/i.test(x.lang));
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'es-ES';
    u.onend = () => speakNext();
    u.onerror = () => { stopReading(); };
    window.speechSynthesis.speak(u);
  }

  async function toggleReadAloud() {
    if (reader.on) { stopReading(); return; }
    if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') { toast('Este equipo no tiene lectura en voz alta disponible', 'error'); return; }
    const st = surface();
    if (!st) return;
    const sel = window.getSelection();
    const selected = sel && sel.rangeCount && !sel.isCollapsed && st.contains(sel.anchorNode) ? sel.toString().replace(/\s+/g, ' ').trim() : '';
    const prefs = readPrefs();
    const voices = (window.speechSynthesis.getVoices() || []).slice().sort((a, b) => (/^es/i.test(b.lang) ? 1 : 0) - (/^es/i.test(a.lang) ? 1 : 0));
    const r = await modal({
      title: 'Lectura en voz alta',
      message: selected ? 'Se leerá el texto seleccionado.' : 'Se leerá desde el cursor hasta el final del documento.',
      fields: [
        { name: 'rate', label: 'Velocidad', value: prefs.rate, options: [['0.8', 'Lenta'], ['1', 'Normal'], ['1.25', 'Rápida'], ['1.5', 'Muy rápida']] },
        { name: 'voice', label: 'Voz', value: prefs.voice || (voices[0] ? voices[0].name : ''), options: voices.length ? voices.map((v) => [v.name, v.name + ' (' + v.lang + ')']) : [['', 'Voz del sistema']] }
      ],
      ok: 'Leer'
    });
    if (!r) return;
    try { localStorage.setItem(READ_LS, JSON.stringify({ rate: r.rate, voice: r.voice })); } catch (e) { /* sin almacenamiento */ }
    reader.queue = [];
    reader.i = 0;
    if (selected) reader.queue.push({ text: selected, node: null });
    else {
      const blocks = Array.from(st.querySelectorAll('.doc-b')).filter((n) => ['heading', 'paragraph', 'quote', 'list', 'table'].includes(n.dataset.type));
      let startAt = 0;
      const a = sel && sel.rangeCount ? sel.anchorNode : null;
      const own = a && (a.nodeType === 1 ? a : a.parentElement) && (a.nodeType === 1 ? a : a.parentElement).closest('.doc-b');
      if (own) { const k = blocks.indexOf(own); if (k >= 0) startAt = k; }
      blocks.slice(startAt).forEach((n) => { const t = readableText(n); if (t) reader.queue.push({ text: t, node: n }); });
    }
    if (!reader.queue.length) { toast('No hay texto para leer', 'error'); return; }
    reader.on = true;
    el('doc-read').classList.add('on');
    try { window.speechSynthesis.cancel(); } catch (e) { /* nada */ }
    speakNext();
  }

  // Combinar correspondencia: el documento es la plantilla ({{columna}}); un CSV
  // da una copia por fila. Reemplaza el contenido (Ctrl+Z recupera la plantilla).
  async function mailMerge() {
    const M = window.MCDoc && window.MCDoc.merge;
    if (!M || !ui.snap || !ui.snap.open) return;
    await flushPending();
    const blocks = ui.snap.doc.blocks || [];
    const fields = M.fieldsOf(blocks);
    if (!fields.length) { toast('La plantilla no tiene campos. Escribí campos como {{nombre}} en el texto.', 'error'); return; }
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.csv,.tsv,.txt,text/csv,text/plain';
    const file = await new Promise((resolve) => { input.addEventListener('change', () => resolve(input.files && input.files[0])); input.addEventListener('cancel', () => resolve(null)); input.click(); });
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast('El archivo CSV es demasiado grande (máx. 5 MB)', 'error'); return; }
    const text = await file.text();
    const csv = M.parseCsv(text);
    if (!csv.headers.length || !csv.rows.length) { toast('El CSV no tiene filas de datos', 'error'); return; }
    const missing = fields.filter((f) => !csv.headers.includes(f));
    const r = await modal({
      title: 'Combinar correspondencia',
      message: csv.rows.length + ' filas · campos de la plantilla: ' + fields.join(', ') + (missing.length ? ' · SIN COLUMNA en el CSV: ' + missing.join(', ') + ' (quedan tal cual)' : '') +
        '. Se reemplaza el contenido por ' + csv.rows.length + ' copias separadas por salto de página; Ctrl+Z recupera la plantilla.',
      ok: 'Generar'
    });
    if (!r) return;
    const merged = M.mergeBlocks(blocks, csv.headers, csv.rows);
    const ops = [{ op: 'insertBlocks', index: 0, blocks: merged }].concat(blocks.map((b) => ({ op: 'deleteBlock', id: b.id })));
    const res = await docEdit({ expectedHash: ui.snap.doc.hash, ops });
    if (res && res.ok) { applySnapshot(res); scheduleAutoSave(); refreshToc(); toast('Generadas ' + csv.rows.length + ' copias', null, { label: 'Deshacer', run: () => travelHistory('undo') }); }
    else if (res && res.error) toast(res.error, 'error');
  }

  // Referencia cruzada: enlace interno (#marcador) a un titulo. Sobre texto
  // elegido lo enlaza; sin seleccion inserta el texto del titulo como enlace.
  function headingList() {
    const blocks = (ui.snap && ui.snap.doc && ui.snap.doc.blocks) || [];
    const slugs = window.MCDoc.model.headingSlugs(blocks);
    return blocks.map((b, i) => (slugs[i] ? { slug: slugs[i], text: window.MCDoc.model.blockText(b) || '(sin texto)', level: b.level || 1 } : null)).filter(Boolean);
  }

  async function insertCrossRef() {
    const ce = activeCe();
    if (!ce) { toast('Hacé clic dentro del documento primero', 'error'); return; }
    const sel0 = window.getSelection();
    const range = sel0 && sel0.rangeCount && ce.contains(sel0.getRangeAt(0).commonAncestorContainer) ? sel0.getRangeAt(0).cloneRange() : ui.savedRange;
    const hs = headingList();
    if (!hs.length) { toast('No hay títulos a los que referirse', 'error'); return; }
    const r = await modal({
      title: 'Referencia cruzada',
      message: 'Con texto seleccionado lo convierte en enlace; si no, inserta el título. Ctrl+clic en el enlace para ir.',
      fields: [{ name: 'slug', label: 'Título', value: hs[0].slug, options: hs.map((h) => [h.slug, '  '.repeat(h.level - 1) + h.text.slice(0, 60)]) }],
      ok: 'Insertar'
    });
    if (!r || !r.slug) return;
    ui.savedRange = range; ui.savedCe = ce;
    ce.focus({ preventScroll: true });
    if (range) { const cur = window.getSelection(); cur.removeAllRanges(); cur.addRange(range); }
    const collapsed = !range || range.collapsed;
    if (collapsed) {
      const h = hs.find((x) => x.slug === r.slug);
      try { document.execCommand('insertText', false, h ? h.text : r.slug); } catch (e) { /* nada */ }
      const sel = window.getSelection();
      if (sel && sel.rangeCount) {
        const c = sel.getRangeAt(0);
        const len = (h ? h.text : r.slug).length;
        const node = c.startContainer;
        if (node.nodeType === 3 && c.startOffset >= len) { const rg = document.createRange(); rg.setStart(node, c.startOffset - len); rg.setEnd(node, c.startOffset); sel.removeAllRanges(); sel.addRange(rg); }
      }
    }
    await applyInline('link', '#' + r.slug);
  }

  // Ctrl+clic en un enlace interno: ir al titulo.
  function gotoSlug(slug) {
    const blocks = (ui.snap && ui.snap.doc && ui.snap.doc.blocks) || [];
    const slugs = window.MCDoc.model.headingSlugs(blocks);
    const i = slugs.indexOf(slug);
    const st = surface();
    const node = i >= 0 && st && st.querySelector('.doc-b[data-id="' + cssEscape(blocks[i].id) + '"]');
    if (node) node.scrollIntoView({ block: 'start', behavior: 'smooth' });
    else toast('No encuentro ese título', 'error');
  }

  // Paleta de simbolos y expresiones matematicas simples (texto Unicode).
  const SYMBOL_SETS = [
    ['Matemática', ['±', '×', '÷', '≠', '≈', '≤', '≥', '∞', '√', '∑', '∏', '∫', '∂', '∆', '∇', '∈', '∉', '⊂', '∪', '∩', '∀', '∃', '¬', '∴', '°', '′', '″', '‰', 'π', '²', '³', 'ⁿ', '½', '⅓', '¼', '¾', 'x²', 'x₁', 'a/b']],
    ['Griegas', ['α', 'β', 'γ', 'δ', 'ε', 'θ', 'λ', 'μ', 'ρ', 'σ', 'τ', 'φ', 'ψ', 'ω', 'Γ', 'Δ', 'Θ', 'Λ', 'Σ', 'Φ', 'Ψ', 'Ω']],
    ['Flechas', ['←', '→', '↑', '↓', '↔', '⇐', '⇒', '⇔', '↩', '↪', '➜']],
    ['Otros', ['©', '®', '™', '§', '¶', '†', '‡', '•', '…', '€', '£', '¥', '¢', '₲', '✓', '✗', '★', '☆', '♥', '☎', '✉', '¿', '¡', '«', '»', '“', '”']]
  ];

  function insertSymbol(sym) {
    const ce = activeCe();
    if (!ce) { toast('Hacé clic dentro del documento primero', 'error'); return; }
    if (liveCe() !== ce) restoreSavedSelection();
    ce.focus({ preventScroll: true });
    try { document.execCommand('insertText', false, sym); } catch (e) { /* nada */ }
    markDirty();
  }

  function toggleSymbols() {
    const old = document.getElementById('doc-sym-pop');
    if (old) { old.remove(); return; }
    const btn = el('doc-ins-sym');
    const r = btn.getBoundingClientRect();
    const pop = document.createElement('div');
    pop.id = 'doc-sym-pop';
    pop.style.cssText = 'position:fixed;z-index:99998;left:' + Math.max(8, r.left) + 'px;top:' + (r.bottom + 4) + 'px;width:330px;max-height:60vh;overflow:auto;background:var(--bg,#fff);color:var(--text,#111);border:1px solid #0003;border-radius:8px;box-shadow:0 6px 24px #0004;padding:8px;';
    pop.innerHTML = SYMBOL_SETS.map((set) => '<div style="font-size:.72rem;opacity:.7;margin:6px 2px 2px">' + esc(set[0]) + '</div><div style="display:flex;flex-wrap:wrap;gap:2px">' +
      set[1].map((s) => '<button type="button" class="doc-btn" data-sym="' + esc(s) + '" style="min-width:30px;padding:3px 6px">' + esc(s) + '</button>').join('') + '</div>').join('');
    pop.addEventListener('mousedown', (e) => e.preventDefault());
    pop.addEventListener('click', (e) => {
      const b = e.target.closest('[data-sym]');
      if (b) insertSymbol(b.dataset.sym);
    });
    document.body.appendChild(pop);
    const off = (e) => {
      if (e.type === 'keydown' ? e.key === 'Escape' : !pop.contains(e.target) && e.target !== btn) {
        pop.remove(); document.removeEventListener('mousedown', off, true); document.removeEventListener('keydown', off, true);
      }
    };
    document.addEventListener('mousedown', off, true);
    document.addEventListener('keydown', off, true);
  }

  // Plantillas de documento nuevo (bloques iniciales).
  const P = (text, extra) => Object.assign({ type: 'paragraph', text }, extra || {});
  const H = (level, text, extra) => Object.assign({ type: 'heading', level, text }, extra || {});
  const DOC_TEMPLATES = {
    blank: { label: 'En blanco', blocks: () => [] },
    letter: { label: 'Carta', blocks: () => [
      P('Tu nombre', { align: 'right', bold: true }), P('Tu dirección · Ciudad', { align: 'right' }), P('Fecha', { align: 'right' }),
      P(''), P('Destinatario'), P('Cargo / Empresa'), P(''), P('Asunto: …', { bold: true }), P(''),
      P('Estimado/a …:'), P('Escribí aquí el cuerpo de la carta.', { align: 'justify' }), P(''), P('Atentamente,'), P(''), P('Tu nombre')] },
    report: { label: 'Informe con portada e índice', blocks: () => [
      P(''), P(''), P(''), H(1, 'Título del informe', { align: 'center' }), P('Subtítulo o descripción', { align: 'center' }),
      P(''), P('Autor · Fecha', { align: 'center' }), { type: 'pagebreak' },
      H(1, 'Índice'), { type: 'toc', levels: 3 }, { type: 'pagebreak' },
      H(1, '1. Introducción'), P('…'), H(1, '2. Desarrollo'), H(2, '2.1 Primer punto'), P('…'), H(1, '3. Conclusiones'), P('…')] },
    cv: { label: 'Currículum', blocks: () => [
      H(1, 'Tu nombre', { align: 'center' }), P('correo@ejemplo.com · Teléfono · Ciudad', { align: 'center' }), { type: 'hr' },
      H(2, 'Perfil'), P('Resumen breve de tu perfil profesional.'),
      H(2, 'Experiencia'), P('Puesto — Empresa (años)', { bold: true }), { type: 'list', ordered: false, items: ['Logro o responsabilidad', 'Logro o responsabilidad'] },
      H(2, 'Educación'), P('Título — Institución (año)'),
      H(2, 'Habilidades'), { type: 'list', ordered: false, items: ['Habilidad', 'Habilidad', 'Habilidad'] }] }
  };

  async function onNew() {
    const r = await modal({
      title: 'Documento nuevo',
      fields: [{ name: 'tpl', label: 'Plantilla', value: 'blank', options: Object.keys(DOC_TEMPLATES).map((k) => [k, DOC_TEMPLATES[k].label]) }],
      ok: 'Crear'
    });
    if (!r) return;
    const res = await API.docCreate({ title: 'Documento nuevo' });
    if (res && res.error) { toast(res.error, 'error'); return; }
    applySnapshot(res); setView('content');
    const tpl = DOC_TEMPLATES[r.tpl];
    const blocks = tpl ? tpl.blocks() : [];
    if (!blocks.length) return;
    const out = await docEdit({ expectedHash: ui.snap.doc.hash, ops: blocks.map((block, i) => ({ op: 'insert', index: i, block })) });
    if (out && out.ok) { applySnapshot(out); scheduleAutoSave(); refreshToc(); }
    else if (out && out.error) toast(out.error, 'error');
  }

  async function onRecents() {
    const res = await API.docRecents();
    const items = (res && res.recents) || [];
    const b0 = el('doc-body');
    if (!b0) return;
    if (ui.view === 'pages') setView('content');
    b0.innerHTML = '<div class="doc-empty" style="text-align:left;padding:26px">' +
      '<h3>Documentos recientes</h3>' +
      (items.length
        ? '<ul>' + items.map((r) =>
            '<li><button class="doc-btn" data-recent="' + esc(r.path) + '">Abrir</button>' +
            '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(r.name || r.path) + '</span>' +
            '<span style="color:var(--muted);font-size:.78rem">' + esc(String(r.format || '').toUpperCase()) + '</span></li>').join('') + '</ul>'
        : '<p style="margin-top:10px">Todavia no abriste ningun documento.</p>') +
      '</div>';
    b0.querySelectorAll('[data-recent]').forEach((b) => b.addEventListener('click', async () => {
      const r = await API.docRecentOpen({ path: b.dataset.recent });
      if (r && r.error) toast(r.error, 'error');
      else { applySnapshot(r); setView('content'); }
    }));
  }

  async function onSave() {
    await flushPending();
    const res = await API.docSave();
    if (!res) return;
    if (res.needsSaveAs) {
      toast(res.error || 'Elige "Guardar como"');
      return onSaveAs();
    }
    if (res.error) toast(res.error, 'error');
    else { applySnapshot(res); toast('Guardado ' + res.sourceName); }
  }

  // Versiones: las copias que deja cada guardado del archivo abierto.
  async function onVersions() {
    if (!ui.snap || !ui.snap.open) return;
    await flushPending();
    if (!API.docVersions) { toast('Las versiones no están disponibles', 'error'); return; }
    const res = await API.docVersions();
    if (!res || res.error) { toast((res && res.error) || 'No se pudieron leer las versiones', 'error'); return; }
    const list = res.versions || [];
    if (!list.length) { toast('Todavía no hay versiones anteriores: se crean al guardar sobre el archivo.'); return; }
    const fmt = (t) => { const d = new Date(t); return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
    const r = await modal({
      title: 'Versiones anteriores',
      message: 'Comparar solo muestra las diferencias. Restaurar reemplaza el contenido actual (podés volver con Ctrl+Z).',
      fields: [{ name: 'name', label: 'Versión', value: list[0].name,
        options: list.map((v, i) => [v.name, (i === 0 ? 'Última guardada · ' : '') + fmt(v.savedAt) + ' · ' + Math.max(1, Math.round(v.size / 1024)) + ' KB']) },
      { name: 'action', label: 'Acción', value: 'diff', options: [['diff', 'Comparar con el documento actual'], ['restore', 'Restaurar esta versión']] }],
      ok: 'Aceptar'
    });
    if (!r || !r.name) return;
    if (r.action !== 'restore') { await showVersionDiff(r.name); return; }
    const out = await API.docVersionRestore({ name: r.name });
    if (out && out.ok) { applySnapshot(out); scheduleAutoSave(); toast('Versión restaurada'); }
    else toast((out && out.error) || 'No se pudo restaurar', 'error');
  }

  // Diferencias entre una version guardada y el documento actual.
  async function showVersionDiff(name) {
    if (!API.docVersionDiff) { toast('Comparar no está disponible', 'error'); return; }
    const out = await API.docVersionDiff({ name });
    if (!out || !out.ok) { toast((out && out.error) || 'No se pudo comparar', 'error'); return; }
    const sm = out.summary;
    const old = document.getElementById('doc-diff-ov');
    if (old) old.remove();
    const ov = document.createElement('div');
    ov.id = 'doc-diff-ov';
    ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;';
    const colors = { add: '#d1f5d8', del: '#fbd5d5', chg: '#fff3c4', same: 'transparent' };
    const mark = { add: '+ ', del: '− ', chg: '± ', same: '  ' };
    const rows = out.rows.filter((r) => r.kind !== 'same' || out.rows.length <= 60).map((r) => {
      const before = r.kind === 'chg' ? '<div style="text-decoration:line-through;opacity:.6">' + esc(r.before) + '</div>' : '';
      return '<div class="doc-diff-row" data-kind="' + r.kind + '" style="background:' + colors[r.kind] + ';padding:3px 8px;border-bottom:1px solid #0001;white-space:pre-wrap">' +
        '<b>' + mark[r.kind] + '</b>' + before + esc(r.text || '(vacío)') + '</div>';
    }).join('');
    ov.innerHTML = '<div style="background:var(--bg,#fff);color:var(--text,#111);width:min(760px,92vw);max-height:80vh;display:flex;flex-direction:column;border-radius:8px;overflow:hidden">' +
      '<div style="padding:10px 14px;font-weight:600;border-bottom:1px solid #0002">Cambios desde esa versión: ' + sm.add + ' agregados, ' + sm.del + ' quitados, ' + sm.chg + ' modificados</div>' +
      '<div style="overflow:auto;flex:1;color:#111">' + (rows || '<div style="padding:14px">Sin diferencias.</div>') + '</div>' +
      '<div style="padding:8px 14px;text-align:right;border-top:1px solid #0002"><button class="doc-btn" id="doc-diff-close">Cerrar</button></div></div>';
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.querySelector('#doc-diff-close').addEventListener('click', close);
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  }

  async function onPrint() {
    if (!ui.snap || !ui.snap.open) return;
    await flushPending();
    if (!API.docPrint) { toast('Imprimir no está disponible', 'error'); return; }
    const res = await API.docPrint();
    if (res && res.error) toast(res.error, 'error');
  }

  async function onSaveAs() {
    await flushPending();
    cancelAutoSave();
    const res = await API.docSaveAs({});
    if (res && res.error) toast(res.error, 'error');
    else if (res && res.canceled) return;
    else if (res) { applySnapshot(res); toast('Guardado ' + res.sourceName); }
  }

  // El estado de guardado se pinta desde dos sitios: el snapshot que llega del
  // main y el autoguardado que dispara el renderer. Tener un solo pintor evita
  // que uno de los dos pise al otro.
  function paintSaveState() {
    const snap = ui.snap;
    const t = el('doc-title');
    const btnSave = el('doc-save');
    if (!snap || !snap.open) return;
    const nombre = labelOf(snap);
    let auto = '';
    if (snap.dirty) {
      const hm = snap.workSavedAt ? new Date(snap.workSavedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      auto = ' <span class="doc-autosave" style="font-size:.75rem;font-weight:400;opacity:.65">' + (hm ? 'Copia automática ' + hm : 'Sin guardar…') + '</span>';
    }
    t.innerHTML = esc(nombre) + (snap.dirty ? '<span class="doc-star">*</span>' : '') + auto;
    btnSave.disabled = !snap.dirty || !snap.sourcePath;
  }

  // ── Autoguardado ────────────────────────────────────────────────────────
  // Antes solo se guardaba al abrir, al crear y al deshacer, y al cerrar la
  // pestaña el trabajo se perdia. Ahora cada cambio confirmed dispara una copia
  // de trabajo con rebote: escribir seguido no golpea el disco, y si la app se
  // cae quedan los ultimos cambios en userData/doc-editor/work/.
  let autoSaveTimer = null;
  let autoSaveAt = 0;

  function cancelAutoSave() {
    if (autoSaveTimer) { clearTimeout(autoSaveTimer); autoSaveTimer = null; }
  }

  function scheduleAutoSave() {
    if (!ui.snap || !ui.snap.open || !ui.snap.dirty) return;
    cancelAutoSave();
    autoSaveAt = Date.now();
    autoSaveTimer = setTimeout(async () => {
      autoSaveTimer = null;
      try {
        await flushPending();
        const res = await API.docWorkSave();
        if (res && res.ok) {
          const s = ui.snap;
          if (s) s.workSavedAt = Date.now();
          paintSaveState();
        }
      } catch {}
    }, 900);
  }

  // ── Edicion ────────────────────────────────────────────────────────────
  // La superficie es la verdad MIENTRAS se escribe: cada cambio marca el
  // documento como "sucio" y, tras una pausa corta (o antes de cualquier otra
  // accion), se lee el DOM, se compara con el modelo y se manda solo lo que
  // cambio. No se repinta: el cursor y la seleccion no se tocan.
  const SYNC_MS = 500;
  let syncTimer = 0;
  let syncing = null;

  function markDirty() {
    ui.dirty = true;
    scheduleStats();
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => { flushPending(); }, SYNC_MS);
  }

  // Todo lo escrito hasta ahora llega al modelo. Las demas acciones (formato,
  // guardar, deshacer...) la esperan antes de actuar.
  async function flushPending() {
    clearTimeout(syncTimer);
    syncTimer = 0;
    while (syncing || ui.dirty) {
      if (syncing) { await syncing; continue; }
      syncing = runSync().catch((e) => { toast('No se pudo guardar el cambio: ' + ((e && e.message) || e), 'error'); });
      await syncing;
      syncing = null;
    }
  }

  // Indices que forman la subsecuencia creciente mas larga (los bloques que
  // siguen en su orden); los demas se movieron y se tratan como nuevos.
  function lisMask(seq) {
    const n = seq.length;
    const tails = [];
    const prev = new Array(n).fill(-1);
    const at = [];
    for (let i = 0; i < n; i++) {
      if (seq[i] < 0) continue;
      let lo = 0, hi = tails.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (seq[at[mid]] < seq[i]) lo = mid + 1; else hi = mid; }
      if (lo > 0) prev[i] = at[lo - 1];
      at[lo] = i;
      tails[lo] = seq[i];
    }
    const mask = new Array(n).fill(false);
    let k = at.length ? at[at.length - 1] : -1;
    while (k >= 0) { mask[k] = true; k = prev[k]; }
    return mask;
  }

  // El elemento queda con la etiqueta y los datos del bloque. Si el navegador
  // lo hizo distinto (un <div> en vez de <p>) se rehace en el lugar sin mover
  // el cursor.
  function tagElement(elm, block) {
    // Los trozos de un parrafo partido comparten el id del primero.
    const oldId = elm.dataset.id;
    const frags = [];
    {
      const all = topEls();
      for (let j = all.indexOf(elm) + 1; j > 0 && j < all.length && all[j].hasAttribute('data-cont') && all[j].dataset.id === oldId; j++) frags.push(all[j]);
    }
    frags.forEach((f) => { f.dataset.id = block.id; });
    const want = tagForBlock(block);
    if (elm.tagName.toLowerCase() !== want && !/^(table|hr|div)$/.test(want)) {
      const cap = captureSel();
      const fresh = document.createElement(want);
      Array.from(elm.attributes).forEach((a) => fresh.setAttribute(a.name, a.value));
      while (elm.firstChild) fresh.appendChild(elm.firstChild);
      elm.replaceWith(fresh);
      elm = fresh;
      restoreSel(cap);
    }
    elm.classList.add('doc-b');
    elm.dataset.id = block.id;
    elm.dataset.type = block.type;
    if (block.type === 'heading') elm.dataset.level = String(Math.min(3, Math.max(1, Number(block.level) || 1)));
    else if (block.type !== 'list') elm.removeAttribute('data-level');
    return elm;
  }

  async function runSync() {
    const snap = ui.snap;
    const st = surface();
    if (!snap || !snap.open || !st || !domBlocks) { ui.dirty = false; return; }
    ui.dirty = false;
    const prev = (snap.doc && snap.doc.blocks) || [];
    const diff = domBlocks.diffSurface(st, prev);
    // Bloques que siguen en el documento pero cambiaron de lugar (cortar y pegar).
    const order = new Map(prev.map((b, i) => [b.id, i]));
    const keep = lisMask(diff.blocks.map((x) => (x.id ? order.get(x.id) : -1)));
    const removed = new Set(diff.removed);
    diff.blocks.forEach((x, i) => {
      if (x.id && !keep[i]) { removed.add(x.id); x.id = null; x.isNew = true; x.changed = true; }
    });
    const ops = [];
    removed.forEach((id) => ops.push({ op: 'deleteBlock', id }));
    let batch = null;
    diff.blocks.forEach((x, pos) => {
      if (x.isNew) {
        if (batch && batch.next === pos) { batch.op.blocks.push(x.block); batch.next++; }
        else { batch = { op: { op: 'insertBlocks', index: pos, blocks: [x.block] }, next: pos + 1 }; ops.push(batch.op); }
      } else {
        batch = null;
        if (x.changed) ops.push({ op: 'replaceBlock', id: x.id, block: x.block });
      }
    });
    let emptyDoc = false;
    if (!diff.blocks.length) {
      // Se borro todo: un documento sin bloques no tiene donde escribir.
      ops.push({ op: 'insertBlocks', index: 0, blocks: [{ type: 'paragraph', text: '' }] });
      emptyDoc = true;
    }
    if (!ops.length) { ui.lastDiff = diff; return; }
    ui.shrunk = ui.shrunk || removed.size > 0;
    let res = null;
    for (let i = 0; i < ops.length; i += 150) {
      res = await docEdit({ expectedHash: ui.snap.doc.hash, ops: ops.slice(i, i + 150) });
      if (!res || !res.ok) break;
      ui.snap = rememberImgSrc(res);
    }
    if (!res || !res.ok) {
      if (res && res.error) toast(res.error, 'error');
      applySnapshot(await API.docState({}));   // lo que se ve vuelve a ser lo que hay
      return;
    }
    const now = (res.doc && res.doc.blocks) || [];
    let repaintNeeded = emptyDoc || now.length !== diff.blocks.length || diff.blocks.some((x) => !x.el);
    if (!repaintNeeded) diff.blocks.forEach((x, i) => { tagElement(x.el, now[i]); });
    renderChrome();
    scheduleAutoSave();
    if (repaintNeeded) { ui.keepFocus = true; try { repaint(); } finally { ui.keepFocus = false; } }
    else if (pagesOverflow() || ui.shrunk || fragmentsStale()) { ui.shrunk = false; relayout(); }
    updateSelectedBlocks();
  }

  // Solo acepta snapshots de verdad: `{canceled:true}` de un dialogo o
  // `{error}` no pueden pisar lo que hay en pantalla.
  function applySnapshot(snap) {
    if (!snap || typeof snap !== 'object') return;
    if (snap.error || snap.canceled) return;
    if (!('open' in snap)) return;
    // Si es otro documento (no una edicion del actual), la vista de a una hoja
    // arranca en la primera hoja.
    const prevId = ui.openId;
    ui.snap = rememberImgSrc(snap);
    ui.dirty = false;
    const nextId = (snap.sourcePath || snap.sourceName || '') + '|' + (snap.doc && snap.doc.hash || '');
    if (nextId !== prevId) {
      ui.openId = nextId;
      ui.pageIndex = 0;
      // Otro documento: vuelve a decidir la cantidad de hojas. Se apaga por
      // la via normal para que se limpien la clase del host, la barra y el
      // boton: si solo se baja la bandera, el CSS sigue escondiendo las hojas
      // y el documento aparece en blanco.
      ui.onePageUser = null;
      toggleOnePage(false);
    }
    repaint();
  }

  // La "superficie de texto" ahora es una sola: la hoja continua del documento.
  function ceOf(node) {
    const st = surface();
    return node && st && st.contains(node) ? st : null;
  }

  function liveCe() {
    const sel = window.getSelection && window.getSelection();
    return sel && sel.rangeCount ? ceOf(sel.getRangeAt(0).startContainer) : null;
  }

  // La superficie con la seleccion actual. Si el foco paso a un control de la
  // barra (fuente, tamaño, color) vale la seleccion guardada.
  function activeCe() {
    const live = liveCe();
    if (live) return live;
    const saved = ui.savedCe;
    return saved && saved.isConnected && saved === surface() && ui.savedRange ? saved : null;
  }

  function restoreSavedSelection() {
    const ce = ui.savedCe;
    const range = ui.savedRange;
    if (!ce || !range || !ce.isConnected) return false;
    ce.focus({ preventScroll: true });
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  }

  // execCommand('fontSize') solo conoce la escala 1-7: se pide el 7 y se
  // cambia por el tamaño real en puntos.
  function convertSizeMarkers(ce, pt) {
    let changed = false;
    ce.querySelectorAll('font[size="7"]').forEach((f) => {
      const span = document.createElement('span');
      span.style.fontSize = pt + 'pt';
      while (f.firstChild) span.appendChild(f.firstChild);
      f.replaceWith(span);
      changed = true;
    });
    ce.querySelectorAll('span').forEach((sp) => {
      if (sp.style.fontSize === 'xxx-large') { sp.style.fontSize = pt + 'pt'; changed = true; }
    });
    return changed;
  }

  function applySizeInline(ce, pt) {
    if (!(pt > 0)) return;
    try { document.execCommand('fontSize', false, '7'); } catch (e) { return; }
    // Con el cursor sin selección todavía no hay nodo: se convierte al escribir.
    ui.pendingSizePt = convertSizeMarkers(ce, pt) ? null : pt;
  }

  function fixPendingSize(ce) {
    if (ui.pendingSizePt && convertSizeMarkers(ce, ui.pendingSizePt)) ui.pendingSizePt = null;
  }

  async function applyInline(action, value) {
    const ce = activeCe();
    if (!ce) return;
    if (liveCe() !== ce && !restoreSavedSelection()) return;
    // Enfocar la hoja no debe perder la seleccion (el control de la barra la tenia aparte).
    const keepSel = window.getSelection();
    const keepRange = keepSel && keepSel.rangeCount ? keepSel.getRangeAt(0).cloneRange() : null;
    if (document.activeElement !== ce) ce.focus({ preventScroll: true });
    if (keepRange && keepSel && (!keepSel.rangeCount || (keepSel.isCollapsed && !keepRange.collapsed))) { keepSel.removeAllRanges(); keepSel.addRange(keepRange); }
    const exec = (cmd, arg) => { try { return document.execCommand(cmd, false, arg); } catch (e) { return false; } };
    exec('styleWithCSS', true);
    switch (action) {
      case 'bold': exec('bold'); break;
      case 'italic': exec('italic'); break;
      case 'underline': exec('underline'); break;
      case 'strike': exec('strikeThrough'); break;
      case 'color': exec('foreColor', value); break;
      case 'highlight': exec('hiliteColor', value); break;
      case 'font': exec('fontName', value || 'inherit'); break;
      case 'size': applySizeInline(ce, Number(value)); break;
      case 'clear': exec('removeFormat'); break;
      case 'link': exec('createLink', value); break;
      case 'unlink': exec('unlink'); break;
      case 'note': case 'comment': wrapAttrSpan(action, value); break;
      default: return;
    }
    // Lo escrito hasta ahora sale del DOM tal cual está y se confirma ya: así
    // el formato entra al historial (deshacer/rehacer) y al autoguardado.
    ui.dirty = true;
    await flushPending();
    refreshInlineState();
  }

  // Al abrirse una paleta de color el navegador le da el foco al control y
  // COLAPSA la seleccion del texto. Se guarda antes, para poder restaurarla
  // despues y pintar solo lo que estaba elegido (si no, no hay nada que pintar).
  function capturePickSelection() {
    const live = window.getSelection && window.getSelection();
    if (live && live.rangeCount && !live.isCollapsed) {
      const c = ceOf(live.getRangeAt(0).startContainer);
      if (c) { ui.pickCe = c; ui.pickRange = live.getRangeAt(0).cloneRange(); }
    }
  }

  // Aplicar lo elegido en una paleta: si sigue habiendo texto seleccionado se
  // pinta solo eso; si la paleta colapso la seleccion se restaura la guardada;
  // si nunca hubo seleccion, el color va al bloque entero (blockField). El
  // resaltado no tiene equivalente a nivel de bloque: se queda en el texto.
  function applyPick(input, action, blockField) {
    const v = input.value;
    const live = window.getSelection && window.getSelection();
    if (live && !live.isCollapsed) { applyInline(action, v); return; }
    if (ui.pickRange && ui.pickCe && ui.pickCe.isConnected && ui.pickCe.contains(ui.pickRange.startContainer)) {
      ui.savedCe = ui.pickCe; ui.savedRange = ui.pickRange;
      if (restoreSavedSelection()) { applyInline(action, v); return; }
    }
    if (blockField && selectedIds().length) applySelectedBlock((b) => Object.assign({}, b, { [blockField]: v }));
    else applyInline(action, v);
  }

  // Color desde el menu contextual: se abre el MISMO control de la barra de
  // formato, que ya sabe aplicar lo elegido. Asi hay un solo camino y una sola
  // paleta (la del navegador, que es la que el usuario ya conoce).
  function openColorPicker(action) {
    const h = host() || document.body;
    const input = h.querySelector(action === 'color' ? '#doc-color' : '#doc-highlight');
    if (!input) return;
    ui.pickOpened = true;
    capturePickSelection();
    input.disabled = false;
    input.click();
  }

  function refreshInlineState() {
    const h = host();
    const bar = h && h.querySelector('#doc-formatbar');
    if (!bar) return;
    const ce = activeCe();
    bar.querySelectorAll('[data-inline-only], #doc-font, #doc-color, #doc-highlight').forEach((c) => {
      c.disabled = !ce && !(c.id === 'doc-color' && selectedIds().length > 0);
    });
    // Con el foco en un control de la barra no se lee nada: seria el estado
    // de otra seleccion.
    if (!ce || liveCe() !== ce) return;
    const state = (cmd) => { try { return document.queryCommandState(cmd); } catch (e) { return false; } };
    const value = (cmd) => { try { return String(document.queryCommandValue(cmd) || ''); } catch (e) { return ''; } };
    const mark = (sel, on) => { const b = bar.querySelector(sel); if (b) b.classList.toggle('active', !!on); };
    mark('[data-block-toggle="bold"]', state('bold'));
    mark('[data-block-toggle="italic"]', state('italic'));
    mark('[data-block-toggle="underline"]', state('underline'));
    mark('[data-inline-only="strike"]', state('strikeThrough'));

    const fontSel = bar.querySelector('#doc-font');
    const family = value('fontName').split(',')[0].replace(/^["']|["']$/g, '').trim();
    fontSel.value = Array.from(fontSel.options).some((o) => o.value === family) ? family : '';

    const sel = window.getSelection();
    const node = sel && sel.rangeCount ? sel.getRangeAt(0).startContainer : null;
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    const px = el ? parseFloat(window.getComputedStyle(el).fontSize) : NaN;
    const pt = Math.round(px * 0.75 * 2) / 2;
    const sizeSel = bar.querySelector('#doc-size');
    if (isFinite(pt) && Array.from(sizeSel.options).some((o) => Number(o.value) === pt)) sizeSel.value = String(pt);

    const paint = (id, cssVar, color) => {
      const input = bar.querySelector(id);
      if (input && color) {
        // Mientras se elige en la paleta manda su valor: pisarlo aqui lo deja
        // en negro otra vez (se lee el formato del cursor, no el color elegido).
        if (!ui.pickOpened) input.value = color;
        input.parentElement.style.setProperty(cssVar, color);
      }
    };
    paint('#doc-color', '--doc-color-a', domRuns && domRuns.parseColor(value('foreColor')));
    paint('#doc-highlight', '--doc-color-h', domRuns && domRuns.parseColor(value('hiliteColor') || value('backColor')));
  }

  let inlineSelectionWired = false;
  function wireInlineFormatting() {
    const h = host();
    const bar = h && h.querySelector('#doc-formatbar');
    if (!bar || bar.dataset.inlineWired) return;
    bar.dataset.inlineWired = '1';
    // Los botones no deben quitarle el foco ni la selección al texto.
    bar.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
    // Color/resaltado de la paleta. El <input type=color> del navegador no es
    // fiable: al abrirlo le da el foco y COLAPSA la seleccion del texto, y segun
    // como se cierre no siempre llega `change` (elegir el mismo color no cambia
    // el valor, y antes se pisaba el valor en el mousedown para forzar el aviso:
    // asi la paleta se quedaba en negro y no aplicaba nada). Por eso se aplica
    // al elegir (input, agrupado), al cerrar la paleta (change) y al salir del
    // control (focusout), y una sola vez por apertura.
    ['#doc-color', '#doc-highlight'].forEach((sel) => {
      const input = bar.querySelector(sel);
      if (!input) return;
      const isColor = sel === '#doc-color';
      let timer = 0;
      const applyOnce = () => {
        if (timer) { clearTimeout(timer); timer = 0; }
        if (!ui.pickOpened) return;
        ui.pickOpened = false;
        applyPick(input, isColor ? 'color' : 'highlight', isColor ? 'color' : null);
      };
      const open = () => {
        ui.pickOpened = true;
        capturePickSelection();
      };
      input.addEventListener('mousedown', open);
      input.addEventListener('keydown', open);
      // Al mover el control se agrupa: la paleta dispara `input` en cada paso.
      input.addEventListener('input', () => { if (timer) clearTimeout(timer); timer = setTimeout(applyOnce, 250); });
      input.addEventListener('change', applyOnce);
      input.addEventListener('focusout', applyOnce);
    });
    bar.querySelector('#doc-font').addEventListener('change', (e) => applyInline('font', e.target.value));
    if (inlineSelectionWired) return;
    inlineSelectionWired = true;
    let frame = 0;
    document.addEventListener('selectionchange', () => {
      const sel = window.getSelection();
      const ce = sel && sel.rangeCount ? ceOf(sel.getRangeAt(0).startContainer) : null;
      if (!ce) return;
      ui.savedCe = ce;
      ui.savedRange = sel.getRangeAt(0).cloneRange();
      markFocusBlock();
      updateSelectedBlocks();
      scheduleStats();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(refreshInlineState);
    });
  }

  // ── Pegar ──────────────────────────────────────────────────────────────
  // El HTML del portapapeles (Word, Docs, web) se convierte a bloques con
  // core/paste.js y se inserta como HTML limpio en el cursor: el navegador
  // parte y une los parrafos como lo haria Word. Lo que no es HTML util entra
  // como texto plano, linea por linea.
  function insertPlainLines(text) {
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    lines.forEach((line, i) => {
      if (i) { try { document.execCommand('insertParagraph'); } catch (e) { /* sin editor */ } }
      if (line) { try { document.execCommand('insertText', false, line); } catch (e) { /* sin editor */ } }
    });
  }

  function richPaste(e) {
    if (!pasteLib || !html) return false;
    const dt = e.clipboardData;
    const htmlText = dt ? String(dt.getData('text/html') || '') : '';
    if (!htmlText) return false;
    let blocks;
    try {
      const doc = new DOMParser().parseFromString(htmlText, 'text/html');
      blocks = pasteLib.blocksFromHtml(doc.body);
    } catch (err) { return false; }
    if (!pasteLib.isRich(blocks)) return false;
    const clean = blocks.map((b) => html.blockToHtml(Object.assign({ id: 'x' }, b))).join('');
    if (!clean) return false;
    let ok = false;
    try { ok = document.execCommand('insertHTML', false, clean); } catch (err) { ok = false; }
    if (ok) markDirty();
    return ok;
  }

  // Copiar/cortar con parrafos partidos entre hojas: el navegador los entrega como
  // varios parrafos (y con saltos de linea de mas); aqui se vuelven a unir.
  function fragmentsClipboard(sel) {
    const st = surface();
    if (!st || !sel || !sel.rangeCount || sel.isCollapsed || !domBlocks || !st.querySelector('[data-cont]')) return null;
    const holder = document.createElement('div');
    holder.appendChild(sel.getRangeAt(0).cloneContents());
    if (!holder.querySelector('[data-cont]')) return null;
    const tops = Array.from(holder.querySelectorAll('.doc-b')).filter((x) => !(x.parentElement && x.parentElement.closest('.doc-b')));
    const out = document.createElement('div');
    let last = null;
    tops.forEach((x) => {
      if (x.hasAttribute('data-cont') && last && last.getAttribute('data-id') === x.getAttribute('data-id')) {
        while (x.firstChild) last.appendChild(x.firstChild);
        return;
      }
      last = x;
      out.appendChild(x);
    });
    out.querySelectorAll('.doc-b').forEach((x) => {
      ['data-cont', 'data-more', 'data-paged'].forEach((a) => x.removeAttribute(a));
    });
    return { html: out.innerHTML, text: domBlocks.surfaceText(out) };
  }

  function onCopyCut(e) {
    const sel = window.getSelection && window.getSelection();
    const clip = fragmentsClipboard(sel);
    if (!clip || !e.clipboardData) return;
    e.preventDefault();
    e.clipboardData.setData('text/html', clip.html);
    e.clipboardData.setData('text/plain', clip.text);
    if (e.type === 'cut') { try { document.execCommand('delete'); } catch (err) { /* sin edicion */ } }
  }

  // ── Cableado de edición ────────────────────────────────────────────────
  function inSurface(node) {
    const st = surface();
    return !!(st && node && st.contains(node));
  }

  // ---- Autoformato al escribir (como Docs / Word) -------------------------------
  //   "# " "## " "### " titulo, "- " "* " vinetas, "1. " numerada, "> " cita
  //   "**texto** " negrita, "*texto* " / "_texto_ " cursiva, "---" + Enter separador
  // Todo se deshace con Ctrl+Z (es una edicion mas del documento).
  const AUTO_BLOCK = /^(#{1,3}|[-*]|\d{1,3}\.|>)$/;

  function caretInfo() {
    const sel = window.getSelection && window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return null;
    const node = sel.anchorNode;
    const elx = node && (node.nodeType === 1 ? node : node.parentElement);
    const blk = elx && elx.closest && elx.closest('.doc-b');
    if (!blk || !inSurface(blk) || !/^(P|BLOCKQUOTE|H[1-6])$/.test(blk.tagName)) return null;
    return { sel, node, blk, offset: sel.anchorOffset };
  }

  function placeCaretIn(id) {
    const node = surface() && surface().querySelector('.doc-b[data-id="' + cssEscape(id) + '"]');
    if (!node) return;
    const p0 = placeAt(node, 0);
    const sel = window.getSelection();
    const rg = document.createRange();
    rg.setStart(p0.node, p0.offset); rg.collapse(true);
    sel.removeAllRanges(); sel.addRange(rg);
    surface().focus({ preventScroll: true });
  }

  async function autoBlock(blk, marker) {
    const id = blk.dataset.id;
    blk.innerHTML = '<br>';
    ui.dirty = true;
    await flushPending();
    select(id);
    const m = /^(#{1,3})$/.exec(marker);
    if (m) applyBlockType('heading', m[1].length);
    else if (marker === '>') applyBlockType('quote');
    else {
      const ordered = !(marker === '-' || marker === '*');
      applySelectedBlock((cur) => {
        const next = Object.assign({}, cur);
        next.type = 'list'; next.ordered = ordered; next.items = [''];
        delete next.text; delete next.runs; delete next.itemRuns;
        return next;
      });
    }
    setTimeout(() => placeCaretIn(id), 80);
  }

  function autoInline(info) {
    const { node, offset } = info;
    if (node.nodeType !== 3) return false;
    const before = node.nodeValue.slice(0, offset);
    const rules = [
      { re: /(\*\*|__)(?=\S)(.+?)(?<=\S)\1$/, mark: 'strong', len: 2, g: 2 },
      { re: /(^|[\s(])(\*|_)(?=[^\s*_])([^*_]+?)(?<=[^\s*_])\2$/, mark: 'em', len: 1, g: 3 }
    ];
    for (const rule of rules) {
      const m = rule.re.exec(before);
      if (!m) continue;
      const inner = m[rule.g];
      const start = offset - (inner.length + rule.len * 2);
      if (start < 0) continue;
      const rest = node.nodeValue.slice(offset);
      const mk = document.createElement(rule.mark);
      mk.textContent = inner;
      const after = document.createTextNode(' ' + rest);
      node.nodeValue = node.nodeValue.slice(0, start);
      node.parentNode.insertBefore(mk, node.nextSibling);
      node.parentNode.insertBefore(after, mk.nextSibling);
      const rg = document.createRange();
      rg.setStart(after, 1); rg.collapse(true);
      info.sel.removeAllRanges(); info.sel.addRange(rg);
      return true;
    }
    return false;
  }

  function onAutoFormat(e) {
    const info = caretInfo();
    if (!info) return;
    const text = info.blk.textContent;
    if (info.blk.dataset.type === 'paragraph' && info.offset === text.length && AUTO_BLOCK.test(text)) {
      e.preventDefault();
      autoBlock(info.blk, text);
      return;
    }
    if (autoInline(info)) { e.preventDefault(); markDirty(); }
  }

  async function autoRule(e) {
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return false;
    const info = caretInfo();
    if (!info || info.blk.dataset.type !== 'paragraph') return false;
    const t = info.blk.textContent;
    if (!/^(---|\*\*\*|___)$/.test(t) || info.offset !== t.length) return false;
    e.preventDefault();
    const id = info.blk.dataset.id;
    info.blk.innerHTML = '<br>';
    ui.dirty = true;
    await flushPending();
    const blocks = (ui.snap && ui.snap.doc.blocks) || [];
    const at = blocks.findIndex((b) => b.id === id);
    if (at < 0) return true;
    const res = await docEdit({ expectedHash: ui.snap.doc.hash, ops: [
      { op: 'replaceBlock', id, block: { type: 'hr' } },
      { op: 'insert', index: at + 1, block: { type: 'paragraph', text: '' } }
    ] });
    if (res && res.ok) {
      applySnapshot(res); scheduleAutoSave();
      const nb = (res.doc.blocks || [])[at + 1];
      if (nb) setTimeout(() => placeCaretIn(nb.id), 80);
    } else if (res && res.error) toast(res.error, 'error');
    return true;
  }

  // Pegar una direccion: sobre texto elegido lo convierte en enlace; sin
  // seleccion inserta la propia direccion como enlace.
  function pasteLink(txt) {
    if (!/^(https?:\/\/|mailto:)\S+$/i.test(txt)) return false;
    if (!(window.MCDoc && window.MCDoc.model && window.MCDoc.model.isSafeLink(txt))) return false;
    const sel = window.getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed) { applyInline('link', txt); return true; }
    const esc = txt.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    try { document.execCommand('insertHTML', false, '<a href="' + esc + '">' + esc + '</a>&nbsp;'); } catch (err) { return false; }
    markDirty();
    return true;
  }

  function wireEditing() {
    const b0 = el('doc-body');
    if (!b0 || b0.dataset.wired) return;
    b0.dataset.wired = '1';

    b0.addEventListener('input', (e) => {
      if (!inSurface(e.target) && e.target !== surface()) return;
      const st = surface();
      fixPendingSize(st);
      markDirty();
      // Si se escribio de mas, la hoja se reparte ya (sin esperar al modelo).
      requestAnimationFrame(() => { if (pagesOverflow()) relayout(); });
    });
    // Deshacer y rehacer son los del documento (modelo), no los del navegador:
    // asi tambien cubren lo que hacen los botones de formato.
    b0.addEventListener('beforeinput', (e) => {
      if (track.on && onTrackInput(e)) return;
      if (e.inputType === 'insertText' && e.data === ' ') { onAutoFormat(e); if (e.defaultPrevented) return; }
      if (e.inputType === 'historyUndo') { e.preventDefault(); travelHistory('undo'); }
      else if (e.inputType === 'historyRedo') { e.preventDefault(); travelHistory('redo'); }
      else if (/^(insertParagraph|insertFromPaste|insertFromDrop|insertReplacementText|deleteByCut)$/.test(e.inputType)) defragmentSelection();
      else if (/^delete/.test(e.inputType)) {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) defragmentSelection();
      }
    });
    b0.addEventListener('focusout', (e) => {
      // Un tick de retardo: si el foco se va a un boton de la barra, esa accion espera lo pendiente igual.
      setTimeout(() => { if (ui.dirty) flushPending(); }, 0);
    });
    b0.addEventListener('copy', onCopyCut);
    b0.addEventListener('cut', onCopyCut);
    b0.addEventListener('paste', (e) => {
      const files = imageFilesOf(e.clipboardData);
      if (files.length) { e.preventDefault(); insertImageFile(files[0]); return; }
      e.preventDefault();
      const txt0 = e.clipboardData ? String(e.clipboardData.getData('text/plain') || '').trim() : '';
      if (pasteLink(txt0)) return;
      if (richPaste(e)) return;
      const txt = e.clipboardData ? String(e.clipboardData.getData('text/plain') || '') : '';
      if (txt) { insertPlainLines(txt); markDirty(); }
    }, true);
    b0.addEventListener('contextmenu', (e) => {
      // Sobre texto NO se cancela el evento: Chromium solo entrega la palabra
      // mal escrita y sus sugerencias si el clic derecho sigue su camino. El
      // main suprime su menu nativo al recibir este aviso (ver spell.js).
      const spellable = !!(e.target.closest && e.target.closest('.doc-b:not(pre)') && API.docCtxOpen && !e.target.closest('[contenteditable="false"]'));
      if (spellable) { try { API.docCtxOpen(); } catch (err) { /* sin aviso: sale el menu nativo */ } }
      else e.preventDefault();
      showContextMenu(e);
    });
    b0.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a[href^="#"]');
      if (a && (e.ctrlKey || e.metaKey)) { e.preventDefault(); gotoSlug(a.getAttribute('href').slice(1)); }
    });
    b0.addEventListener('mousedown', (e) => {
      // Una imagen no es texto: un clic la elige (y muestra su asa de tamano).
      const img = e.target.closest && e.target.closest('.doc-img-block');
      if (img && e.button === 0 && !e.target.closest('[data-img-handle]')) {
        const sel = window.getSelection && window.getSelection();
        if (sel) { const r = document.createRange(); r.selectNode(img); sel.removeAllRanges(); sel.addRange(r); }
        select(img.dataset.id);
      }
    });
    wireInlineFormatting();
    wireObjects();
  }

  // ── Teclado ────────────────────────────────────────────────────────────
  // Escribir, Enter, Retroceso, Supr, flechas, seleccionar, copiar y cortar son
  // del navegador. Aqui solo van los atajos propios del documento.
  async function onKeyDown(e) {
    if (e.key === 'Enter' && (await autoRule(e))) return;
    if (e.key === 'F7' && e.shiftKey && isActive()) { e.preventDefault(); synonymsAssist(); return; }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
      e.preventDefault();
      api.toggle();
      return;
    }
    if (!isActive()) return;
    if (e.key === 'Escape' && document.getElementById('doc-ctxmenu')) {
      e.preventDefault(); e.stopPropagation(); closeContextMenu(); return;
    }
    if (e.key === 'Escape' && host() && host().classList.contains('doc-focus') && !document.getElementById('doc-sym-pop')) {
      e.preventDefault(); e.stopPropagation(); toggleFocus(false); return;
    }
    const target = e.target;
    const inDoc = inSurface(target) || target === surface();
    const inField = !!(target && target.closest && target.closest('textarea, input, select, .doc-modal'));
    if (e.key === 'Escape' && !inField && !inDoc && !(target && target.closest && target.closest('[role="toolbar"]'))) { e.preventDefault(); api.close(); return; }
    if (inField) return;

    // Atajos de bloque: Ctrl+Alt+0 parrafo, Ctrl+Alt+1..3 titulos.
    if ((e.ctrlKey || e.metaKey) && e.altKey && !e.shiftKey && /^Digit[0-3]$|^[0-3]$/.test(String(e.code || e.key || ''))) {
      const d = Number(String(e.code || e.key).slice(-1));
      e.preventDefault();
      await flushPending();
      updateSelectedBlocks();
      if (d === 0) applyBlockType('paragraph'); else applyBlockType('heading', d);
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      const k = String(e.key || '').toLowerCase();
      if (k === 'z') { e.preventDefault(); await travelHistory(e.shiftKey ? 'redo' : 'undo'); return; }
      if (k === 'y') { e.preventDefault(); await travelHistory('redo'); return; }
      if (k === 'f') { e.preventDefault(); openFind(false); return; }
      if (k === 'h') { e.preventDefault(); openFind(true); return; }
      if (k === 's') { e.preventDefault(); onSave(); return; }
      if (k === 'p' && !e.shiftKey) { e.preventDefault(); onPrint(); return; }
      if (k === 'o') { e.preventDefault(); onOpen(); return; }
      if (k === 'v' && e.shiftKey) { // pegar sin formato
        e.preventDefault();
        const t = await clipboardText();
        if (t) { insertPlainLines(t); markDirty(); }
        return;
      }
    }
    if (!inDoc) return;

    // Retroceso/Supr junto a una imagen, salto de pagina o linea: el navegador
    // las arrastra y une los bloques de alrededor (se perdia la imagen). Se quita
    // solo ese elemento, como en Word.
    if ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      const sel0 = window.getSelection();
      if (sel0 && sel0.rangeCount && sel0.isCollapsed) {
        const els = topEls();
        const at = els.findIndex((x) => x.contains(sel0.anchorNode));
        if (at >= 0) {
          const cur = els[at];
          const back = e.key === 'Backspace';
          const nb = els[at + (back ? -1 : 1)];
          const solid = (x) => x && x.getAttribute('contenteditable') === 'false';
          const edge = back ? textOffset(cur, sel0.anchorNode, sel0.anchorOffset) === 0
            : textOffset(cur, sel0.anchorNode, sel0.anchorOffset) >= (cur.textContent || '').replace(/\u00a0/g, ' ').length;
          if (solid(nb) && !solid(cur) && edge && cur.tagName !== 'TABLE') {
            e.preventDefault();
            nb.remove();
            markDirty();
            ui.shrunk = true;
            return;
          }
        }
      }
    }
    // Tab: en una celda salta a la siguiente; en un item de lista sangra; en el resto, sangria de texto.
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const sel = window.getSelection();
      const node = sel && sel.focusNode && (sel.focusNode.nodeType === 1 ? sel.focusNode : sel.focusNode.parentElement);
      const cell = node && node.closest && node.closest('td,th');
      const li = node && node.closest && node.closest('li');
      if (cell) { moveToCell(cell, e.shiftKey ? -1 : 1); return; }
      if (li) {
        // Nivel de cada item: se cambia el data-lvl del DOM y la sincronizacion lo
        // pasa al modelo (itemLevels). Un item no puede estar mas de un nivel por
        // debajo del anterior.
        const listEl = li.closest('ul,ol');
        const lis = Array.from(listEl.children).filter((x) => x.tagName === 'LI');
        const range = sel.getRangeAt(0);
        const hit = lis.map((x, i) => (range.intersectsNode(x) ? i : -1)).filter((i) => i >= 0);
        if (!hit.length) return;
        const lvlOf = (x) => Math.min(2, parseInt(x.getAttribute('data-lvl'), 10) || 0);
        let changed = false;
        hit.forEach((i) => {
          const prev = i > 0 ? lvlOf(lis[i - 1]) : -1;
          const n = Math.max(0, Math.min(2, lvlOf(lis[i]) + (e.shiftKey ? -1 : 1), prev + 1));
          if (n !== lvlOf(lis[i])) {
            if (n) lis[i].setAttribute('data-lvl', String(n)); else lis[i].removeAttribute('data-lvl');
            changed = true;
          }
        });
        if (changed) { ui.dirty = true; await flushPending(); return; }
        // El primer item no tiene nivel que cambiar: Tab sangra la lista entera.
        if (hit.includes(0)) {
          await flushPending();
          updateSelectedBlocks();
          const blk = selectedBlock();
          if (!blk) return;
          const n = Math.min(8, Math.max(0, (Number(blk.indent) || 0) + (e.shiftKey ? -1 : 1)));
          if (n === (Number(blk.indent) || 0)) return;
          const next = Object.assign({}, blk);
          if (n) next.indent = n; else delete next.indent;
          const res = await docEdit({ expectedHash: ui.snap.doc.hash, ops: [{ op: 'replaceBlock', id: blk.id, block: next }] });
          if (res && res.ok) { ui.keepFocus = true; applySnapshot(res); ui.keepFocus = false; scheduleAutoSave(); }
          else if (res && res.error) toast(res.error, 'error');
        }
        return;
      }
      if (!e.shiftKey) { try { document.execCommand('insertText', false, '    '); } catch (err) { /* sin editor */ } }
    }
  }

  // Siguiente (dir 1) o anterior (-1) celda de la tabla; al final de la tabla agrega una fila.
  function moveToCell(cell, dir) {
    const cells = Array.from(cell.closest('table').querySelectorAll('td,th'));
    const at = cells.indexOf(cell) + dir;
    if (at >= 0 && at < cells.length) {
      const p = placeAt(cells[at], 0);
      const sel = window.getSelection();
      const r = document.createRange();
      r.setStart(p.node, p.offset); r.collapse(true);
      sel.removeAllRanges(); sel.addRange(r);
    } else if (at >= cells.length) {
      ui.cell = ui.cell || null;
      tableAction('addRowAfter');
    }
  }

  // Suelta el DOM del documento cuando su pestaña se cierra: son bloques,
  // imagenes y listeners que no hacen falta mientras la pestaña no existe.
  // El documento sigue vivo en main, asi que al reabrir la pestaña se
  // reconstruye desde el snapshot (buildUI + repaint).
  function teardown() {
    const h = host();
    if (h) { h.dataset.built = ''; h.innerHTML = ''; }
    ui.snap = null;
    torn = true;
  }

  // ── API pública ────────────────────────────────────────────────────────
  const api = {
    async open() {
      injectStyles(); injectButton(); buildUI();
      const id = ensureTab();
      if (id != null && typeof switchTab === 'function' && state0().activeTab !== id) switchTab(id);
      // showPanel deja el panel visible; si la pestaña quedó activa, switchTab
      // ya lo hizo.
      if (panel() && !panel().classList.contains('active') && typeof showPanel === 'function') showPanel('doc');
      wireEditing();
      // El tono de la hoja viene de la config de la app. No se espera: el
      // documento se pinta ya y el tono entra apenas llega.
      loadPaperTone();
      if (!ui.snap) {
        ui.snap = rememberImgSrc(await API.docState({}));
        repaint();
      } else {
        repaint();
      }
      return api;
    },
    toggle() {
      const t = docTab();
      if (t && state0().activeTab === t.id) return api.close();
      return api.open();
    },
    close() {
      // Volcar lo que haya en el textarea antes de cerrar la pestaña: si no, el
      // ultimo renglon que se estaba escribiendo se perdia.
      flushPending();
      if (ui.snap && ui.snap.dirty) API.docWorkSave();
      const t = docTab();
      const s = state0();
      if (!t) return;
      // No se puede cerrar la última pestaña: en ese caso se vuelve a la
      // primera que no sea de documentos.
      if (typeof closeTab === 'function' && (s.tabs || []).length > 1) {
        closeTab({ stopPropagation() {} }, t.id);
      } else {
        const otra = (s.tabs || []).find((x) => x.url !== TAB_URL);
        if (otra && typeof switchTab === 'function') switchTab(otra.id);
        // Sin closeTab no se dispara mc:tab-closed: soltar el DOM aca, despues
        // de confirmar el texto pendiente para no perder el ultimo renglon.
        Promise.resolve(flushPending()).then(teardown, teardown);
      }
      const btn = document.getElementById(BTN_ID);
      if (btn) btn.classList.remove('open');
    },
    isOpen() {
      const t = docTab();
      return !!(t && state0().activeTab === t.id);
    },
    /** Lo llama el main cuando el SO abre un archivo con la app. */
    async openPath(p) {
      await api.open();
      // El main ya abrio el archivo y mando el snapshot con la peticion: solo
      // hay que mostrarlo. Si por alguna razon no vino, se pide explicitamente
      // (con withBytes:false, que los bytes del PDF se piden aparte).
      if (p && p.snap) {
        applySnapshot(p.snap);
      } else {
        const res = await API.docOpenPath({ path: (p && p.path) || '', withBytes: false });
        if (res && res.error) { toast(res.error, 'error'); return res; }
        if (res && res.ok) applySnapshot(res);
      }
      setView('content');
      return ui.snap;
    },
    snapshot() { return ui.snap; },
    /** Espera a que lo escrito llegue al modelo (lo usan los tests y el guardado). */
    flush: flushPending,
    applySnapshot
  };

  window.DocEditor = api;

  // ── Eventos del main ───────────────────────────────────────────────────
  try {
    API.on('doc:changed', (snap) => {
      // Eco de una edicion propia (mismo contenido) o con texto sin confirmar:
      // repintar borraria lo que se esta escribiendo.
      const same = ui.snap && ui.snap.doc && snap && snap.doc && snap.doc.hash === ui.snap.doc.hash;
      if (same || ui.dirty || syncing) { if (snap && !ui.dirty && !syncing) ui.snap = rememberImgSrc(snap); if (host()) renderChrome(); return; }
      ui.snap = rememberImgSrc(snap);
      if (!host()) return;
      if (isActive()) { ui.keepFocus = true; try { repaint(); } finally { ui.keepFocus = false; } }
      else renderChrome();   // alcanza con actualizar el título de la pestaña
      const btn = document.getElementById(BTN_ID);
      if (btn) btn.classList.toggle('open', api.isOpen());
    });
    API.on('doc:open-request', (p) => { api.openPath(p); });
    API.on('doc:spell', (payload) => addSpellItems(payload));
    API.on('doc:error', (p) => toast((p && p.error) || 'Error del editor', 'error'));
  } catch {}

  // ── Ciclo de vida de la pestaña ────────────────────────────────────────
  // Si la pestaña del documento se cierra, confirmar el texto pendiente y
  // soltar el DOM (liberar recursos). El documento sigue en main.
  document.addEventListener('mc:tab-closed', (e) => {
    if (!e || !e.detail || e.detail.url !== TAB_URL) return;
    Promise.resolve(flushPending()).then(teardown, teardown);
  });

  // Al volver a mostrar el panel, reconstruir solo si se habia soltado el DOM.
  document.addEventListener('mc:panel-shown', (e) => {
    if (!e || !e.detail || e.detail.name !== 'doc') return;
    if (!torn) return;   // el DOM sigue vivo: no rehacer nada
    torn = false;
    buildUI();
    wireEditing();
    if (!ui.snap) {
      API.docState({}).then((snap) => { ui.snap = rememberImgSrc(snap); repaint(); }).catch(() => {});
    } else {
      repaint();
    }
  });

  // ── Arranque ───────────────────────────────────────────────────────────
  function boot() {
    injectStyles();
    injectButton();
    buildUI();
    document.addEventListener('keydown', onKeyDown, true);
    API.docState({}).then((snap) => {
      ui.snap = rememberImgSrc(snap);
      if (snap && snap.open && host()) renderChrome();
    }).catch(() => {});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // El panel y la barra lateral pueden aparecer después (la barra se
  // reemplaza al cambiar de sesión). Se agrupa con rAF para no correr por
  // cada nodo que mueve la app.
  let moQueued = false;
  const mo = new MutationObserver(() => {
    if (moQueued) return;
    moQueued = true;
    requestAnimationFrame(() => {
      moQueued = false;
      injectButton();
      buildUI();
    });
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
})();
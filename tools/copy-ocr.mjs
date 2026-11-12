// Copia el motor de OCR (tesseract.js) y los idiomas desde node_modules a public/ocr/, que Vite
// incluye tal cual en dist/. Así el OCR funciona SIN internet. public/ocr/ no se sube a git (~9 MB):
// se regenera con `npm run build` / `npm run dev` (hooks prebuild/predev). Idiomas: español e inglés.
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = (...p) => join(root, 'node_modules', ...p);
const out = (...p) => join(root, 'public', 'ocr', ...p);

// Una sola variante del núcleo (LSTM + SIMD): WebAssembly SIMD existe desde Chrome 91 y nuestro piso es 92.
const files = [
  [nm('tesseract.js', 'dist', 'tesseract.min.js'), out('tesseract.min.js')],
  [nm('tesseract.js', 'dist', 'worker.min.js'), out('worker.min.js')],
  [nm('tesseract.js-core', 'tesseract-core-simd-lstm.js'), out('tesseract-core-simd-lstm.js')],
  [nm('tesseract.js-core', 'tesseract-core-simd-lstm.wasm'), out('tesseract-core-simd-lstm.wasm')],
  [nm('@tesseract.js-data', 'spa', '4.0.0_best_int', 'spa.traineddata.gz'), out('lang', 'spa.traineddata.gz')],
  [nm('@tesseract.js-data', 'eng', '4.0.0_best_int', 'eng.traineddata.gz'), out('lang', 'eng.traineddata.gz')]
];

mkdirSync(out('lang'), { recursive: true });
for (const [from, to] of files) {
  if (!existsSync(from)) { console.error('Falta ' + from + ' — ejecuta npm install'); process.exit(1); }
  copyFileSync(from, to);
}
console.log('OCR: ' + files.length + ' archivos copiados a public/ocr/');

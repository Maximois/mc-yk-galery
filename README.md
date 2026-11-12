# MC Digilibrary

MC Digilibrary es una biblioteca y lector digital para Android. Está inspirada en la experiencia de lectura de MC Browser Suite / MC Doc, pero es una aplicación independiente enfocada en organizar documentos, leerlos y guardar notas.

La app está construida con Vite y Capacitor. Permite importar documentos, organizarlos en una biblioteca, leerlos y tomar notas y resaltados vinculados al texto. Hoy se leen **PDF, EPUB, DOCX, ODT, RTF, DOC, HTML, TXT y Markdown**, el PDF se ve fiel al original (páginas dibujadas con pdf.js, selección de texto, resaltados, subrayado, zoom con pellizco, contraseña y OCR sin internet para escaneados) y el resto como texto que se adapta a la pantalla (ver límites en `docs/PLAN.md`).

## Requisitos

- Node.js y npm
- Android Studio y Android SDK para compilar o ejecutar la app en Android

## Pruebas

```bash
npm test
```

## Núcleo compartido con MC Browser

`modules/document-editor/` es una copia del núcleo de `mcbro-refact`. Para actualizarlo: `node tools/sync-core.mjs <ruta-a-mcbro-refact>`.

## OCR

El motor (tesseract.js) y los idiomas viajan dentro de la app. `npm run build`/`npm run dev` copian los archivos desde `node_modules` a `public/ocr/` (no se versionan, ~8 MB) con `tools/copy-ocr.mjs`.

## Compatibilidad

Piso de Android System WebView: Chrome 92 (lo exige pdf.js). Con uno más viejo la app muestra un aviso para actualizarlo en vez de quedar en blanco.

## Desarrollo web

```bash
npm ci
npm run dev
```

## Preparar Android

```bash
npm ci
npm run sync
npm run android
```

`npm run sync` compila la interfaz web y sincroniza los archivos y plugins de Capacitor con Android. `npm run android` también abre el proyecto nativo en Android Studio.

Para compilar un APK de depuración desde Windows:

```powershell
cd android
.\gradlew.bat assembleDebug
```

# MC Digilibrary

MC Digilibrary es una biblioteca y lector digital para Android. Está inspirada en la experiencia de lectura de MC Browser Suite / MC Doc, pero es una aplicación independiente enfocada en organizar documentos, leerlos y guardar notas.

La app está construida con Vite y Capacitor. La interfaz permite importar documentos PDF, EPUB, DOCX, TXT y Markdown, organizarlos en una biblioteca y tomar notas vinculadas a la lectura.

## Requisitos

- Node.js y npm
- Android Studio y Android SDK para compilar o ejecutar la app en Android

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

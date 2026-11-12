import type { CapacitorConfig } from '@capacitor/cli';

// Piso de WebView: Chrome 92. Lo fija pdf.js (usa Array.prototype.at, ??=, métodos privados de clase)
// y el visor. Capacitor, sin esta línea, daría por bueno Chrome 60 y la app quedaría en blanco en
// un WebView viejo. tests/compat.test.mjs comprueba que el código no use nada más nuevo que este número
// y que vite.config.ts compile para el mismo piso. Si lo cambiás, cambiá también `build.target` en vite.config.ts.
const config: CapacitorConfig = {
  appId: 'com.mcproducciones.digilibrary',
  appName: 'YK-MChronicles',
  webDir: 'dist',
  server: {
    // Con un WebView por debajo del mínimo, Capacitor muestra esta página (en public/) en vez de una pantalla en blanco.
    errorPath: 'webview-antiguo.html'
  },
  android: {
    minWebViewVersion: 92
  }
};

export default config;

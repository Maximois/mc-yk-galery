import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: '.',
  base: './',
  build: {
    // Mismo piso que android.minWebViewVersion en capacitor.config.ts (Chrome 92). Sin esto Vite compila para
    // Chrome 111+ y la app fallaría con un error de sintaxis en WebViews anteriores.
    target: 'chrome92',
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html')
      }
    }
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src')
    }
  },
  server: {
    port: 5173,
    host: '0.0.0.0'
  }
});

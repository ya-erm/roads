import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 4800,
    strictPort: true,
  },
  preview: {
    port: 4801,
    strictPort: true,
  },
  build: {
    rollupOptions: {
      // Игра и лаборатория полос (новая модель дорог, пока отдельно от игры).
      input: { main: resolve(__dirname, 'index.html'), lab: resolve(__dirname, 'lab.html') },
    },
  },
});

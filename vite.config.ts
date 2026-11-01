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
});

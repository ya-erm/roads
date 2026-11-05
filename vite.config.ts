import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Connect, type Plugin } from 'vite';

/**
 * Короткие адреса тестовых страниц: /test — оглавление (test/index.html; без слеша иначе открылась бы игра),
 * /test/lanes — лаборатория полос (lab.html, старый адрес /lab.html тоже работает). Сцены игры (/test/bus)
 * открывает сама игра: src/main.ts выбирает сцену по адресу.
 */
const TEST_ALIASES: Record<string, string> = {
  '/test': '/test/',
  '/test/lanes': '/lab.html',
  '/test/lanes/': '/lab.html',
};

const aliasTestPages: Connect.NextHandleFunction = (req, _res, next) => {
  const [path, query] = (req.url ?? '').split('?');
  // /test/bus без слеша — тоже его test/bus/index.html.
  const dir = /^\/test\/[\w-]+$/.test(path) && existsSync(resolve(__dirname, `.${path}/index.html`)) ? `${path}/` : undefined;
  const to = TEST_ALIASES[path] ?? dir;
  if (to) req.url = query === undefined ? to : `${to}?${query}`;
  next();
};

const testPages: Plugin = {
  name: 'test-pages',
  configureServer: (server) => void server.middlewares.use(aliasTestPages),
  configurePreviewServer: (server) => void server.middlewares.use(aliasTestPages),
};

export default defineConfig({
  // Относительные пути в сборке: одна и та же dist работает и в корне домена (roads.ya-erm.ru), и в подпапке
  // (ya-erm.github.io/roads/). Ссылки между страницами строятся от корня сайта — src/testpages/route.ts, siteRoot.
  base: './',
  plugins: [testPages],
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
      // Игра, лаборатория полос (новая модель дорог, пока отдельно от игры) и тестовые страницы (/test, /test/bus).
      input: {
        main: resolve(__dirname, 'index.html'),
        lab: resolve(__dirname, 'lab.html'),
        test: resolve(__dirname, 'test/index.html'),
        testBus: resolve(__dirname, 'test/bus/index.html'),
      },
    },
  },
});

/// <reference types="vitest/config" />
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Connect, type Plugin } from 'vite';
import { defaultExclude } from 'vitest/config';

/**
 * Тесты, которые подменяют глобальное (vi.stubGlobal, window и HTMLInputElement, vi.mock модуля игры), — каждый
 * файл в своих модулях, как по умолчанию. Остальные файлы одного потока делят модули: игра загружается и
 * разогревается один раз на поток, а не на каждый файл (процессор на полном прогоне — на треть меньше).
 */
const ISOLATED_TESTS = [
  'src/core/idle.test.ts',
  'src/ui/prefs.test.ts',
  'src/ui/settingsMenu.test.ts',
  'src/input/baseTool.test.ts',
  'src/input/escMenu.test.ts',
  'src/input/redoKeys.test.ts',
  'src/input/sharedProject.test.ts',
  'src/game/templates.test.ts',
  'src/game/workTrainSelect.test.ts',
  'src/game/roadEditTraffic.test.ts',
];

/**
 * Версия игры (src/version.ts): MAJOR.MINOR.PATCH из package.json, а к PATCH прибавляется число коммитов после
 * того, в котором поле version меняли, — каждая публикация получает свою версию без ручных правок. Нужна полная
 * история git (в публикации — fetch-depth: 0); без git версия — как в package.json. Локальный сервер — «-dev».
 */
function appVersion(dev: boolean): string {
  const base = (JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string }).version;
  const [major, minor, patch] = base.split('.').map((n) => Number.parseInt(n, 10) || 0);
  let since = 0;
  try {
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const bump = git('log', '-1', '--format=%H', '-G^[[:space:]]*"version":', '--', 'package.json');
    if (bump) since = Number(git('rev-list', '--count', `${bump}..HEAD`)) || 0;
  } catch {
    // Без git (архив исходников) — версия из package.json как есть.
  }
  return `${major}.${minor}.${patch + since}${dev ? '-dev' : ''}`;
}

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

export default defineConfig(({ command }) => ({
  // Относительные пути в сборке: одна и та же dist работает и в корне домена (roads.ya-erm.ru), и в подпапке
  // (ya-erm.github.io/roads/). Ссылки между страницами строятся от корня сайта — src/testpages/route.ts, siteRoot.
  base: './',
  plugins: [testPages],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion(command === 'serve')),
  },
  test: {
    // По умолчанию vitest занимает все ядра, и на полном прогоне машина «встаёт». Половины хватает:
    // общее время задают самые долгие файлы, а не число процессов.
    maxWorkers: '50%',
    // Тесты со сценариями и генерацией мира идут по 2–3 с, а под нагрузкой (параллельные прогоны, dev-серверы)
    // переваливали за 5 с по умолчанию — и падали по таймауту то один, то другой.
    testTimeout: 15_000,
    projects: [
      { extends: true, test: { name: 'shared', isolate: false, exclude: [...defaultExclude, ...ISOLATED_TESTS] } },
      { extends: true, test: { name: 'isolated', include: ISOLATED_TESTS } },
    ],
  },
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
        testVehicles: resolve(__dirname, 'test/vehicles/index.html'),
        testJunctions: resolve(__dirname, 'test/junctions/index.html'),
        testConstruction: resolve(__dirname, 'test/construction/index.html'),
      },
    },
  },
}));

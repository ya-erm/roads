import { laneSvg, stationSvg } from '../ui/icons';
import { siteRoot } from './route';

/** Строчка оглавления /test: куда (от корня сайта, без слеша в начале), как зовётся, значок и что там проверять. */
interface TestPage {
  href: string;
  title: string;
  icon: string;
  what: string;
}

/**
 * Тестовые и лабораторные страницы — оглавление /test. Новая страница — одна строка здесь
 * (сцены игры, как /test/bus, ещё регистрируются в src/testpages/index.ts).
 */
const TEST_PAGES: TestPage[] = [
  {
    href: 'test/bus/',
    title: 'Автобусы',
    icon: stationSvg('stop', 48),
    what: 'Маршруты по остановкам: улица 1+1, проспект 2+2 (правая полоса), «кармашек», кварталы с поворотами и односторонней',
  },
  {
    // Короткий /test/lanes есть только на dev-сервере (vite.config.ts), на GitHub Pages — сам файл.
    href: 'lab.html',
    title: 'Лаборатория полос',
    icon: laneSvg(),
    what: 'Дороги без игры: съезды, въезды, перекрёстки, кольцо, редактор полос; D — оси и стыки (на dev-сервере ещё /test/lanes)',
  },
];

// Сайт может лежать в подпапке (ya-erm.github.io/roads/), поэтому ссылки — от его корня, а не от корня домена.
const root = siteRoot(location.pathname);
const list = document.getElementById('pages') as HTMLElement;
list.innerHTML = TEST_PAGES.map(
  (p) => `<a class="page" href="${root}${p.href}">
    <span class="icon">${p.icon}</span>
    <span class="text"><b>${p.title}</b> <code>/${p.href.replace(/\/$/, '')}</code><span class="what">${p.what}</span></span>
  </a>`,
).join('');
const home = document.getElementById('home');
if (home instanceof HTMLAnchorElement) home.href = root;

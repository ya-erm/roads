import { laneSvg, stationSvg } from '../ui/icons';

/** Строчка оглавления /test: куда, как зовётся, значок и что там проверять. */
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
    href: '/test/bus',
    title: 'Автобусы',
    icon: stationSvg('stop', 48),
    what: 'Маршруты по остановкам: улица 1+1, проспект 2+2 (правая полоса), «кармашек», кварталы с поворотами и односторонней',
  },
  {
    href: '/test/lanes',
    title: 'Лаборатория полос',
    icon: laneSvg(),
    what: 'Дороги без игры: съезды, въезды, перекрёстки, кольцо, редактор полос; D — оси и стыки (старый адрес /lab.html)',
  },
];

const list = document.getElementById('pages') as HTMLElement;
list.innerHTML = TEST_PAGES.map(
  (p) => `<a class="page" href="${p.href}">
    <span class="icon">${p.icon}</span>
    <span class="text"><b>${p.title}</b> <code>${p.href}</code><span class="what">${p.what}</span></span>
  </a>`,
).join('');

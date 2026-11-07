import { buildSvg } from '../ui/constructionUi';
import { laneSvg, modelSvg, stationSvg } from '../ui/icons';
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
    href: 'test/vehicles/',
    title: 'Транспорт',
    icon: modelSvg('truck3', '#e07b39'),
    what: 'Все автобусы и грузовики на сетке улиц с проспектом: повороты направо и налево, сочленённый автобус и тягачи с полуприцепом гнутся на поворотах',
  },
  {
    href: 'test/junctions/',
    title: 'Перекрёстки',
    icon: junctionsSvg(),
    what: 'Шестнадцать перекрёстков: крест, косой X под 32° (и со скруглёнными углами), Т и Y, пяти- и шестилучевой, разные классы и односторонние, смещённый, излом ветки, полоса поворота и съезд; J — разметка перекрёстков вкл/выкл',
  },
  {
    href: 'test/construction/',
    title: 'Стройка',
    icon: buildSvg(48, 36),
    what: 'Режим «Со строительством»: у каждого проекта своя база с бригадой — улица, проспект, автомагистраль, выемка и насыпь через холм, мост через реку, тоннель, проект из трёх участков между перекрёстками; этапы 🟫⬛⬜ колонной. Заново — перезагрузить страницу',
  },
  {
    // Короткий /test/lanes есть только на dev-сервере (vite.config.ts), на GitHub Pages — сам файл.
    href: 'lab.html',
    title: 'Лаборатория полос',
    icon: laneSvg(),
    what: 'Дороги без игры: съезды, въезды, перекрёстки, кольцо, редактор полос; D — оси и стыки (на dev-сервере ещё /test/lanes)',
  },
];

/** Значок страницы перекрёстков: косой X, лишний асфальт в остром углу заштрихован, поворот — пунктиром. */
function junctionsSvg(): string {
  return `<svg viewBox="0 0 48 36" width="48" height="36">
    <defs><pattern id="tp-hatch" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <path d="M0 0V3" stroke="#e0a800" stroke-width="1.2"/></pattern></defs>
    <path d="M2 28L46 8M2 8L46 28" stroke="#646b76" stroke-width="8"/>
    <path d="M9 18L20 18L15 15.4Z M39 18L28 18L33 20.6Z" fill="url(#tp-hatch)"/>
    <path d="M5 25C16 20 32 20 43 25" stroke="#fff" stroke-width="1.4" stroke-dasharray="2.6 2" fill="none"/>
  </svg>`;
}

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

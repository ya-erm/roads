/**
 * Значки режима «Сценарий»: типы заданий, медали, сложность, испытание, миниатюры регионов и режимов.
 * Круглые значки — в том же стиле, что значки грузов и статей финансов: цветной кружок с белой пиктограммой.
 */
import type { ArchetypeId, Difficulty, Objective, ScoreResult } from '../scenario/types';
import { cargoIcon, TOWN_COLOR } from './cargoIcons';

/** Цветной кружок 24×24 с белой пиктограммой. */
const disc = (color: string, body: string, size: number, title: string) =>
  `<svg class="cargo-icon" viewBox="0 0 24 24" width="${size}" height="${size}"><title>${title}</title><circle cx="12" cy="12" r="12" fill="${color}"/>${body}</svg>`;

const HOUSE = '<path d="M4.8 12.2L12 6l7.2 6.2V19h-4.6v-4.4h-5.2V19H4.8z" fill="#fff"/>';

/** Производство предприятия: завод с трубой. */
export const factoryIcon = (size = 24) =>
  disc('#b0703a', '<path d="M4.5 18.5v-7.2l4 2.4v-2.4l4 2.4V7h2.2l.5-2.4h1.6l.5 2.4h2.2v11.5z" fill="#fff"/><path d="M7 16h1.6M10.6 16h1.6M14.2 16h1.6" stroke="#b0703a" stroke-width="1.4"/>', size, 'Производство');

/** Прибыль: монета. */
export const coinIcon = (size = 24) =>
  disc('#2e9d57', '<circle cx="12" cy="12" r="7" fill="none" stroke="#fff" stroke-width="1.6"/><text x="12" y="16" text-anchor="middle" font-size="11" font-weight="800" fill="#fff">$</text>', size, 'Прибыль');

/** Качество: молния. */
export const boltIcon = (size = 24) => disc('#9a6be0', '<path d="M13.6 3.6L6.6 13.4h4.6l-1.4 7 7.2-10h-4.6z" fill="#fff"/>', size, 'Быстрая доставка');

/** Пропускная способность: встречные потоки. */
export const flowIcon = (size = 24) =>
  disc(
    '#4a8fe7',
    '<path d="M5 9h11M13 6l3 3-3 3M19 15H8M11 12l-3 3 3 3" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    size,
    'Объём перевозок',
  );

/** Рост населения: житель и стрелка вверх. */
export const growthIcon = (size = 24) =>
  disc(
    TOWN_COLOR,
    '<circle cx="9.6" cy="8.4" r="2.7" fill="#fff"/><path d="M5 18.6v-2.6a4.6 4.6 0 0 1 9.2 0v2.6z" fill="#fff"/><path d="M18 18.4V7.6M15.2 10.4L18 7.6l2.8 2.8" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    size,
    'Рост города',
  );

/** Снабжение города: дом и зелёная галочка. */
export const supplyIcon = (size = 24) =>
  disc(
    TOWN_COLOR,
    `${HOUSE}<circle cx="17.6" cy="16.6" r="4.4" fill="#2e9d57" stroke="#fff" stroke-width="1"/><path d="M15.7 16.6l1.4 1.4 2.5-2.7" stroke="#fff" stroke-width="1.5" fill="none" stroke-linecap="round"/>`,
    size,
    'Снабжение города',
  );

/** Зелёный «плюс» в углу значка — новое: маршрут, город, предприятие. */
const PLUS = '<circle cx="18" cy="6" r="4.6" fill="#2e9d57" stroke="#fff" stroke-width="1"/><path d="M18 3.6v4.8M15.6 6h4.8" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>';

/** Новые маршруты: линия между двумя станциями и «плюс». */
export const newRouteIcon = (size = 24) =>
  disc(
    '#4a8fe7',
    `<path d="M5.5 17.5C9 17.5 9 10 14 10" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round"/><circle cx="5.5" cy="17.5" r="2.2" fill="#fff"/><circle cx="14" cy="10" r="2.2" fill="#fff"/>${PLUS}`,
    size,
    'Новые маршруты',
  );

/** Подключить новые города: дом и «плюс». */
export const newTownIcon = (size = 24) =>
  disc(TOWN_COLOR, `<path d="M3.8 13.4L10.4 7.6l6.6 5.8V20h-4.2v-4h-4.8v4H3.8z" fill="#fff"/>${PLUS}`, size, 'Новые города в сети');

/** Подключить новые предприятия: завод и «плюс». */
export const newIndustryIcon = (size = 24) =>
  disc(
    '#b0703a',
    `<path d="M3.5 19.5v-6.8l3.8 2.3v-2.3l3.8 2.3V9h2l.5-2.2h1.4l.5 2.2h1.8v10.5z" fill="#fff"/>${PLUS}`,
    size,
    'Новые предприятия в сети',
  );

/** Значок задания по его типу: груз, пассажиры, деньги, город, завод, молния, поток, новое в сети. */
export function objectiveIcon(o: Objective, size = 24): string {
  const p = o.params;
  switch (p.kind) {
    case 'deliver':
      return cargoIcon(p.cargo, size);
    case 'passengers':
      return cargoIcon('passengers', size);
    case 'profit':
      return coinIcon(size);
    case 'supply':
      return supplyIcon(size);
    case 'population':
      return growthIcon(size);
    case 'industry':
      return factoryIcon(size);
    case 'quality':
      return boltIcon(size);
    case 'throughput':
      return flowIcon(size);
    case 'newRoutes':
      return newRouteIcon(size);
    case 'connect':
      return p.what === 'town' ? newTownIcon(size) : newIndustryIcon(size);
  }
}

const MEDAL_COLORS = {
  gold: ['#f2c94c', '#c9961a', '#fff3c4'],
  silver: ['#d5dce3', '#8f9aa6', '#f7f9fb'],
  bronze: ['#e3a46f', '#a8642f', '#f8dcc3'],
} as const;

export const MEDAL_NAMES = { gold: 'Золото', silver: 'Серебро', bronze: 'Бронза' } as const;

/** Пятиконечная звезда с центром (cx, cy). */
function star(cx: number, cy: number, r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.45 : r;
    pts.push(`${(cx + rr * Math.cos(a)).toFixed(2)},${(cy + rr * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(' ');
}

/** Медаль на ленте; без медали — серый жетон с прочерком. */
export function medalSvg(medal: ScoreResult['medal'], size = 56): string {
  const h = Math.round(size * (56 / 48));
  if (!medal) {
    return `<svg viewBox="0 0 48 56" width="${size}" height="${h}"><title>Без медали</title>
      <path d="M14 2h8l5 16h-8zM34 2h-8l-5 16h8z" fill="#c9d1d9"/>
      <circle cx="24" cy="35" r="16" fill="#eef1f4" stroke="#c9d1d9" stroke-width="3"/>
      <path d="M17 35h14" stroke="#9aa3ad" stroke-width="3" stroke-linecap="round"/></svg>`;
  }
  const [face, rim, shine] = MEDAL_COLORS[medal];
  return `<svg viewBox="0 0 48 56" width="${size}" height="${h}"><title>${MEDAL_NAMES[medal]}</title>
    <path d="M14 2h8l5 16h-8z" fill="#4a8fe7"/><path d="M34 2h-8l-5 16h8z" fill="#e5534b"/>
    <circle cx="24" cy="35" r="16" fill="${face}" stroke="${rim}" stroke-width="3"/>
    <circle cx="24" cy="35" r="11.5" fill="none" stroke="${shine}" stroke-width="1.2" opacity="0.8"/>
    <polygon points="${star(24, 35.6, 8)}" fill="${rim}"/></svg>`;
}

const DIFF_COLORS: Record<Difficulty, string> = { easy: '#3fae6a', normal: '#e9a32f', hard: '#e5534b' };
const DIFF_LEVEL: Record<Difficulty, number> = { easy: 1, normal: 2, hard: 3 };

/** Сложность — три столбика, как шкала сигнала: закрашено 1, 2 или 3. */
export function difficultySvg(d: Difficulty, size = 22): string {
  const n = DIFF_LEVEL[d];
  const bars = [0, 1, 2]
    .map((i) => `<rect x="${3 + i * 7}" y="${15 - i * 5}" width="5" height="${6 + i * 5}" rx="1.2" fill="${i < n ? DIFF_COLORS[d] : '#d5dce3'}"/>`)
    .join('');
  return `<svg class="cargo-icon" viewBox="0 0 24 24" width="${size}" height="${size}">${bars}</svg>`;
}

/** Испытание: секундомер, стрелка идёт. */
export function stopwatchSvg(size = 22): string {
  return `<svg class="cargo-icon" viewBox="0 0 24 24" width="${size}" height="${size}"><title>Испытание: без паузы</title>
    <circle cx="12" cy="13.5" r="8" fill="#fff" stroke="#c4662f" stroke-width="2"/>
    <path d="M10 3h4M12 3v2.5M18.5 6.5l1.4-1.4" stroke="#c4662f" stroke-width="2" stroke-linecap="round"/>
    <path d="M12 13.5V9M12 13.5l3 2" stroke="#1f2933" stroke-width="1.8" stroke-linecap="round"/></svg>`;
}

/** Флажок сценария. */
export function flagSvg(size = 20): string {
  return `<svg class="cargo-icon" viewBox="0 0 24 24" width="${size}" height="${size}">
    <path d="M6 21V3.5" stroke="#55606e" stroke-width="2" stroke-linecap="round"/>
    <path d="M6.5 4h11l-2.6 4 2.6 4h-11z" fill="#e5534b"/></svg>`;
}

/** Календарь: сколько месяцев. */
export function calendarSvg(size = 24): string {
  return `<svg class="cargo-icon" viewBox="0 0 24 24" width="${size}" height="${size}"><circle cx="12" cy="12" r="12" fill="#7a5cc4"/>
    <rect x="5.5" y="7" width="13" height="11.5" rx="1.6" fill="#fff"/><path d="M5.5 10.5h13" stroke="#7a5cc4" stroke-width="1.4"/>
    <path d="M8.6 5.4v3M15.4 5.4v3" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>
    <path d="M8 13h2M11 13h2M14 13h2M8 15.6h2M11 15.6h2" stroke="#7a5cc4" stroke-width="1.3"/></svg>`;
}

/** Предел кредита: столбик упирается в черту. */
export function limitSvg(size = 24): string {
  return `<svg class="cargo-icon" viewBox="0 0 24 24" width="${size}" height="${size}"><circle cx="12" cy="12" r="12" fill="#646b76"/>
    <path d="M5.5 7h13" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>
    <rect x="7.5" y="10" width="3.4" height="8" rx="0.8" fill="#fff"/><rect x="13.1" y="8.6" width="3.4" height="9.4" rx="0.8" fill="#fff"/></svg>`;
}

/** Репутация: рукопожатие сведено к двум сцепленным кольцам. */
export function reputationSvg(size = 18): string {
  return `<svg class="cargo-icon" viewBox="0 0 24 24" width="${size}" height="${size}"><circle cx="12" cy="12" r="12" fill="#2fb8b3"/>
    <circle cx="9.3" cy="12" r="4.4" fill="none" stroke="#fff" stroke-width="1.9"/><circle cx="14.7" cy="12" r="4.4" fill="none" stroke="#fff" stroke-width="1.9"/></svg>`;
}

/** Расстояние между городами: стрелка в обе стороны. */
export function distanceSvg(size = 24): string {
  return `<svg class="cargo-icon" viewBox="0 0 24 24" width="${size}" height="${size}"><circle cx="12" cy="12" r="12" fill="#8aa070"/>
    <path d="M5 12h14M8 9l-3 3 3 3M16 9l3 3-3 3" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

/** Переиграть: круговая стрелка. */
export function replaySvg(size = 22): string {
  return `<svg viewBox="0 0 22 22" width="${size}" height="${size}"><circle cx="11" cy="11" r="10" fill="#2f80ed"/>
    <path d="M15.6 8.6A5.2 5.2 0 1 0 16 12.4" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round"/>
    <path d="M16.6 4.8v4.4h-4.4" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

/** Контракт: свиток. */
export function contractSvg(size = 18): string {
  return `<svg class="cargo-icon" viewBox="0 0 24 24" width="${size}" height="${size}"><title>Контракт</title><circle cx="12" cy="12" r="12" fill="#c4662f"/>
    <path d="M7 5.5h9.5v11.2a2 2 0 0 1-2 2H7z" fill="#fff"/><path d="M9 9h5.5M9 11.6h5.5M9 14.2h3.5" stroke="#c4662f" stroke-width="1.2"/></svg>`;
}

/** События региона: сложенная газета — заголовок, колонки текста и картинка. */
export function newsSvg(size = 18): string {
  return `<svg class="cargo-icon" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="#3f7fcf"/>
    <rect x="5" y="6" width="14" height="12" rx="1.5" fill="#fff"/><path d="M7 8.8h10" stroke="#3f7fcf" stroke-width="1.8"/>
    <rect x="7" y="11" width="4.2" height="4.6" rx="0.6" fill="#9cc0ec"/><path d="M12.6 11.6h4.4M12.6 13.6h4.4M12.6 15.6h3" stroke="#7b8794" stroke-width="1.1"/></svg>`;
}

// ---------- Миниатюры карт ----------

const MAP_BG = '<rect x="1" y="1" width="62" height="42" rx="6" fill="#d6e2bd" stroke="#8aa070"/>';
const RIVER = '<path d="M1 30c10-3 14 4 24 1s16-10 38-8" stroke="#8cc3e6" stroke-width="2.4" fill="none"/>';
const town = (x: number, y: number, r: number) => `<circle cx="${x}" cy="${y}" r="${r}" fill="#8b95a1" stroke="#fff" stroke-width="1"/>`;
/** Предприятие: сырьевое — охрой, завод — фиолетовым. */
const ind = (x: number, y: number, plant = false) => `<rect x="${x - 2.6}" y="${y - 2.6}" width="5.2" height="5.2" rx="1.2" fill="${plant ? '#7a5cc4' : '#c4862f'}" stroke="#fff" stroke-width="0.8"/>`;
const link = (pts: [number, number][]) => `<path d="M${pts.map((p) => p.join(' ')).join('L')}" stroke="#55606e" stroke-width="1.1" stroke-dasharray="2 1.6" fill="none"/>`;

const ARCH_ART: Record<ArchetypeId, string> = {
  // Много заводов, длинные цепочки «сырьё → завод → завод».
  industrial:
    link([
      [10, 12],
      [24, 16],
      [38, 12],
      [52, 18],
    ]) +
    link([
      [22, 34],
      [24, 16],
    ]) +
    link([
      [44, 34],
      [52, 18],
    ]) +
    ind(10, 12) +
    ind(24, 16, true) +
    ind(38, 12) +
    ind(52, 18, true) +
    ind(22, 34) +
    ind(44, 34) +
    ind(32, 26, true) +
    town(10, 26, 3.4) +
    town(56, 32, 2.4),
  // Крупные города тесной группой.
  agglomeration: town(24, 18, 6.4) + town(37, 25, 5.8) + town(25, 32, 4.4) + town(41, 13, 3.8) + town(14, 28, 2.6) + ind(54, 36) + ind(54, 8, true),
  // Много маленьких городов далеко друг от друга.
  scattered: [
    [8, 8],
    [30, 7],
    [55, 9],
    [16, 22],
    [42, 21],
    [57, 35],
    [27, 38],
    [7, 37],
  ]
    .map(([x, y]) => town(x, y, 2.2))
    .join('') + ind(46, 34) + ind(20, 12),
  // Предприятия кольцом вокруг одного города.
  logistics:
    [
      [32, 8],
      [46, 14],
      [47, 30],
      [32, 36],
      [17, 30],
      [18, 14],
    ]
      .map(([x, y]) => link([[x, y], [32, 22]]))
      .join('') +
    town(32, 22, 5.6) +
    ind(32, 8) +
    ind(46, 14, true) +
    ind(47, 30) +
    ind(32, 36, true) +
    ind(17, 30) +
    ind(18, 14, true),
  // И города, и пара цепочек.
  mixed:
    link([
      [30, 26],
      [40, 13],
    ]) +
    town(14, 14, 4.4) +
    town(47, 31, 3.8) +
    town(54, 10, 2.4) +
    town(16, 35, 2.2) +
    ind(30, 26) +
    ind(40, 13, true) +
    ind(26, 8),
};

/** Миниатюра региона: города серыми кружками, предприятия квадратиками, цепочки пунктиром. */
export function archetypeSvg(id: ArchetypeId, w = 64, h = 44): string {
  return `<svg class="map-mini" viewBox="0 0 64 44" width="${w}" height="${h}">${MAP_BG}${RIVER}${ARCH_ART[id]}</svg>`;
}

/** Регион по seed: игральная кость на карте. */
export function diceMapSvg(w = 64, h = 44): string {
  const dot = (x: number, y: number) => `<circle cx="${x}" cy="${y}" r="2" fill="#1f2933"/>`;
  return `<svg class="map-mini" viewBox="0 0 64 44" width="${w}" height="${h}">${MAP_BG}${RIVER}
    <rect x="20" y="6" width="24" height="24" rx="5" fill="#fff" stroke="#55606e" stroke-width="1.4" transform="rotate(-8 32 18)"/>
    <g transform="rotate(-8 32 18)">${dot(26, 12)}${dot(38, 12)}${dot(32, 18)}${dot(26, 24)}${dot(38, 24)}</g></svg>`;
}

/** Режим «Песочница»: свободная карта с дорогами и городами — стройте что хотите. */
export function sandboxSvg(w = 88, h = 56): string {
  return `<svg class="map-mini" viewBox="0 0 64 44" width="${w}" height="${h}">${MAP_BG}${RIVER}
    <path d="M6 36C18 30 24 18 40 14S56 8 60 6" stroke="#646b76" stroke-width="2.6" fill="none" stroke-linecap="round"/>
    <path d="M22 40L28 22" stroke="#646b76" stroke-width="2" fill="none" stroke-linecap="round"/>
    ${town(40, 14, 4.6)}${town(14, 32, 3.4)}${ind(50, 30)}${ind(28, 22, true)}</svg>`;
}

/** Режим «Сценарий»: путь через этапы A → B → C к медали. */
export function scenarioModeSvg(w = 88, h = 56): string {
  const step = (x: number, y: number, l: string, done: boolean) =>
    `<circle cx="${x}" cy="${y}" r="5.4" fill="${done ? '#2f80ed' : '#fff'}" stroke="#2f80ed" stroke-width="1.4"/>
    <text x="${x}" y="${y + 2.6}" text-anchor="middle" font-size="7" font-weight="800" fill="${done ? '#fff' : '#2f80ed'}">${l}</text>`;
  return `<svg class="map-mini" viewBox="0 0 64 44" width="${w}" height="${h}">${MAP_BG}
    <path d="M9 34C16 24 22 32 28 24S40 12 46 20" stroke="#2f80ed" stroke-width="1.6" stroke-dasharray="2.4 1.8" fill="none"/>
    ${step(9, 34, 'A', true)}${step(28, 24, 'B', true)}${step(46, 20, 'C', false)}
    <path d="M52 22V6" stroke="#55606e" stroke-width="1.4"/><path d="M52.5 6.5h8l-2 3 2 3h-8z" fill="#e5534b"/></svg>`;
}

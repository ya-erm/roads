/**
 * Стартовый экран и окно «Новая игра»: черновик параметров нового мира и разметка, которой не нужен DOM
 * (клики по data-action обрабатывает Hud).
 */
import type { ScenarioSettings } from '../scenario/types';
import { BIOME_LIST, BIOMES, type BiomeId, biomeForSeed, biomeRaw } from '../world/biomes';
import { CARGO, type CargoType, INDUSTRY_LIST } from '../world/cargo';
import { KM_PER_UNIT } from '../scenario/analysis';
import {
  DEFAULT_SETTINGS,
  MAP_SCALE,
  type MapSize,
  mapDims,
  mapScaleOf,
  NEW_GAME_SETTINGS,
  type Relief,
  TOWN_RANGE,
  townCount,
  townLimits,
  type WorldSettings,
} from '../world/settings';
import { cargoIcon, townIcon } from './cargoIcons';
import { biomeRandomSvg, biomeSvg, diceBadgeSvg } from './icons';
import { diceMapSvg } from './scenarioIcons';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Откуда открыли «Новую игру»: со стартового экрана или из меню. «Отмена» возвращает туда же. */
export type NewGameFrom = 'start' | 'menu';

export interface NewGameDraft {
  /**
   * Параметры нового мира: биом в них всегда есть и уже решён — выбранный или тот, что даёт seed («Случайно»,
   * biomeBySeed: true). В партию и её сохранение уходит сам биом; метка нужна, чтобы следующая «Новая игра»
   * снова предложила «Случайно».
   */
  settings: WorldSettings;
  /** Выбор сценария (сложность, испытание, регион): вернётся, когда снова выберут «Сценарий». */
  scenario: ScenarioSettings;
}

/**
 * Биом партии выпал «Случайно» (по seed), а не выбран игроком. Метка есть — по ней; у партий без метки (сохранения
 * версий, где «Случайно» у биома не было, и мир первого запуска) — случайный, если биома нет или он тот, что даёт
 * seed: так новая игра после них начнётся со «Случайно», а явно выбранный другой биом запомнится.
 */
export function biomeIsRandom(s: Pick<WorldSettings, 'seed' | 'biome' | 'biomeBySeed'>): boolean {
  if (s.biomeBySeed !== undefined) return s.biomeBySeed;
  return !s.biome || s.biome === biomeForSeed(s.seed);
}

/**
 * Новый seed в черновике (кубиком, вводом или при открытии окна). При «Случайно» биом — тот, что даёт новый seed;
 * выбранный игроком биом остаётся, как и выбранный регион.
 */
export function withSeed(s: WorldSettings, seed: number): WorldSettings {
  const random = biomeIsRandom(s);
  // Масштаб карты — всегда нынешний: новая партия после старой (без поля) — на карте нового размера.
  const next: WorldSettings = { ...s, seed, biome: random ? biomeForSeed(seed) : s.biome, biomeBySeed: random, mapScale: MAP_SCALE };
  // Городов — в пределах размера карты (после старой партии на 14 городов средняя — 9).
  return { ...next, towns: townCount(next) };
}

/** Биом в черновике: карточкой биома — он сам, «Случайно» — тот, что даёт seed черновика. */
export function withBiome(s: WorldSettings, pick: BiomeId | 'random'): WorldSettings {
  if (pick === 'random') return { ...s, biome: biomeForSeed(s.seed), biomeBySeed: true };
  return { ...s, biome: pick, biomeBySeed: false };
}

/**
 * Размер карты подписью, км: как его карта и получится — с масштабом новой партии (mapScale), единица карты 0,6 м.
 * Маленькая новой партии — «5.8 × 3.9 км» (9600 × 6450 ед.).
 */
export function mapSizeKm(size: MapSize, mapScale: number | undefined): string {
  const m = mapDims({ size, mapScale });
  // До десятых — с округлением половины вверх: 12 750 ед. — 7,65 км → «7.7» (умножение на 0.0006 даёт 7.6499…).
  const km = (u: number) => (Math.round(u * KM_PER_UNIT * 10 + 1e-6) / 10).toFixed(1);
  return `${km(m.w)} × ${km(m.h)} км`;
}

/**
 * Другой размер карты в черновике: городов — в его пределах (TOWN_RANGE); было обычное число прежнего размера —
 * обычное и у нового (средняя 8 → маленькая 5), выбранное игроком — ближайшее допустимое.
 */
export function withSize(s: WorldSettings, size: MapSize): WorldSettings {
  const usual = mapScaleOf(s) > 1 && s.towns === TOWN_RANGE[s.size].base;
  const next = { ...s, size };
  return { ...next, towns: usual ? TOWN_RANGE[size].base : townCount(next) };
}

/** «−» / «+» у числа городов: на шаг, в пределах размера карты (townLimits). */
export function stepTowns(s: WorldSettings, d: number): WorldSettings {
  const { min, max } = townLimits(s);
  return { ...s, towns: Math.max(min, Math.min(max, s.towns + d)) };
}

/**
 * Черновик «Новой игры» по текущей партии, с новым seed (и биомом по нему). Со стартового экрана — сразу
 * «Сценарий»: регион с заданиями понятнее пустой карты; из меню — тот же режим, что у текущей партии.
 * У сценария берём только выбор игрока: регион, если его не выбирали, решится заново.
 */
export function newGameDraft(s: WorldSettings, from: NewGameFrom, remembered: ScenarioSettings, seed: number): NewGameDraft {
  let scenario = remembered;
  if (s.scenario) {
    const { difficulty, challenge, pick } = s.scenario;
    scenario = pick ? { difficulty, challenge, pick } : { difficulty, challenge };
  }
  // Рельеф в черновике — всегда явный. Без поля мир плоский (так открываются старые сохранения), а окно
  // подсвечивает «Холмы»: партия первого запуска (DEFAULT_SETTINGS, без рельефа) давала плоский сценарий.
  // Предприятия — тоже явно: после старой партии (без поля) новая — как новая игра, «Строит игрок».
  // Биом — выбор игрока в прошлой партии: «Случайно» (и по умолчанию — у мира первого запуска и старых партий)
  // выпадет заново по новому seed, выбранный сам — останется.
  const biome: Pick<WorldSettings, 'biome' | 'biomeBySeed'> = biomeIsRandom(s) ? { biomeBySeed: true } : { biome: s.biome, biomeBySeed: false };
  const own = { ...s, ...biome, relief: s.relief ?? DEFAULT_RELIEF, industryMode: s.industryMode ?? NEW_GAME_SETTINGS.industryMode };
  if (!s.scenario && from === 'menu') return { settings: withSeed(own, seed), scenario };
  // Города, предприятия и капитал сценарий задаёт сам — у песочницы оставляем её прежние, иначе — обычные.
  const base = s.scenario ? { ...scenarioBase(s), ...biome } : own;
  return { settings: withSeed({ ...base, scenario: { ...scenario } }, seed), scenario };
}

/** Рельеф новой партии, если его не выбирали: его и подсвечивает окно «Новая игра». */
export const DEFAULT_RELIEF: Relief = 'hills';

/**
 * Обычные настройки мира под новый сценарий после партии s: города, предприятия и капитал сценарий задаёт сам,
 * а карта, вода, рельеф и режим стройки — прежние.
 */
function scenarioBase(s: WorldSettings): WorldSettings {
  return {
    ...DEFAULT_SETTINGS,
    // Городов — обычное число для размера карты (переключат на «Песочницу» — столько и будет).
    towns: TOWN_RANGE[s.size].base,
    // Предприятия — как в прежней партии; у старой (без поля) — как в новой игре: строит игрок.
    industryMode: s.industryMode ?? NEW_GAME_SETTINGS.industryMode,
    size: s.size,
    water: s.water,
    relief: s.relief ?? DEFAULT_RELIEF,
    ...(s.construction ? { construction: s.construction } : {}),
  };
}

/** «Другой регион» после итогов сценария: тот же выбор сложности, новый seed — и рельеф прежней партии. */
export function nextScenarioSettings(s: WorldSettings, seed: number): WorldSettings {
  const scenario: ScenarioSettings = { difficulty: s.scenario?.difficulty ?? 'normal', challenge: !!s.scenario?.challenge };
  return withSeed({ ...scenarioBase(s), scenario }, seed);
}

/**
 * Окно перед стартом песочницы: что делать в игре и одна кнопка «Начать». На стартовом экране (intro) она
 * открывает «Новую игру», в только что созданном мире — запускает время.
 */
export function rulesHtml(intro: boolean): string {
  return `<h1>Дороги региона</h1>
    <p class="sub">Транспортная компания: дороги, грузы, пассажиры и пробки.</p>
    <ul>
      <li>Ставьте <b>станции</b> у дорог в городах или вплотную к <b>предприятию</b> — с любой его стороны.</li>
      <li>Соедините станции <b>маршрутом</b> и купите на него грузовики или автобусы.</li>
      <li>Для дальних перевозок проложите <b>ж/д путь</b>, поставьте <b>ж/д станции</b> и пустите поезда.</li>
      <li>Сырьё везите на заводы, готовую продукцию — в города. Что кому нужно, видно по значкам и в панели <b>«Цепочки»</b>.</li>
      <li>Выберите предприятие или город — пунктиром покажутся ближайшие партнёры.</li>
      <li>Обеспеченные города растут, а жители ездят по вашим дорогам и создают пробки.</li>
    </ul>
    <div class="actions"><button class="primary" data-action="${intro ? 'ng-intro' : 'begin'}">Начать</button></div>
    <p class="muted save-note">Прогресс сохраняется сам: каждый игровой месяц и при закрытии вкладки.</p>`;
}

/** Карточка «Случайно» у региона: игральная кость на карте. */
export function randomCardHtml(action: string, active: boolean, tip: string): string {
  return `<button class="card region ${active ? 'active' : ''}" data-action="${action}" data-id="random" data-tip="${esc(tip)}">${diceMapSvg()}<span class="name">Случайно</span></button>`;
}

/**
 * Строка «Биом»: «Случайно» и пять пейзажей. Подсвечен выбор черновика: «Случайно» — тогда у биома, который выпадет
 * при этом seed, пунктирная рамка и кость в углу, — или выбранный сами. Под ней — строка «Ресурсы» (заголовок
 * в левом столбце, как у остальных): что в этом биоме (при «Случайно» — в выпавшем) добывают и что просят города,
 * значками. Подсказки — только у самих карточек и значков: вложенные друг в друга всплывали разом и накрывали
 * одна другую.
 */
export function biomeRowHtml(biome: BiomeId, random = false): string {
  const dice = `<button class="card region ${random ? 'active' : ''}" data-action="ng-biome" data-id="random" data-tip="${esc(
    `Один из пяти биомов по seed: тот же seed — тот же биом. Сейчас выпадет: ${BIOMES[biome].name}`,
  )}">${biomeRandomSvg()}<span class="name">Случайно</span></button>`;
  const cards = BIOME_LIST.map((b) => {
    const rolled = random && biome === b.id;
    const cls = !random && biome === b.id ? 'active' : rolled ? 'rolled' : '';
    const tip = rolled ? `Выпадет при этом seed. ${b.pitch}` : b.pitch;
    return `<button class="card region ${cls}" data-action="ng-biome" data-id="${b.id}" data-tip="${esc(tip)}">${biomeSvg(b.id)}${
      rolled ? diceBadgeSvg() : ''
    }<span class="name">${esc(b.name)}</span></button>`;
  }).join('');
  const shown = BIOMES[biome];
  const icon = (c: CargoType) => `<span class="ng-cargo" data-tip="${esc(CARGO[c].name)}">${cargoIcon(c, 20, false)}</span>`;
  const raw = biomeRaw(shown.id, INDUSTRY_LIST).map(icon).join('');
  const towns = [...shown.towns, ...shown.extra].map(icon).join('');
  const strip = `<div class="ng-biome-strip">
    <span class="ng-biome-part"><span class="ng-part-ic" data-tip="Сырьё: что здесь добывают">⛏</span>${raw}</span>
    <span class="ng-biome-part"><span class="ng-part-ic" data-tip="Что просят города">${townIcon(18)}</span>${towns}</span></div>`;
  return `<div class="ng-row top"><span class="ng-label">Биом</span><div class="ng-region"><div class="cards ng-regions ng-biomes">${dice}${cards}</div></div></div>
    <div class="ng-row ng-res-row"><span class="ng-label">Ресурсы</span>${strip}</div>`;
}

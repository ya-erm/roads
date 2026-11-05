/**
 * Стартовый экран и окно «Новая игра»: черновик параметров нового мира и разметка, которой не нужен DOM
 * (клики по data-action обрабатывает Hud).
 */
import type { ScenarioSettings } from '../scenario/types';
import { BIOME_LIST, BIOMES, type BiomeId, biomeForSeed, biomeRaw } from '../world/biomes';
import { CARGO, type CargoType, INDUSTRY_LIST } from '../world/cargo';
import { DEFAULT_SETTINGS, type WorldSettings } from '../world/settings';
import { cargoIcon, townIcon } from './cargoIcons';
import { biomeSvg } from './icons';
import { diceMapSvg } from './scenarioIcons';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Откуда открыли «Новую игру»: со стартового экрана или из меню. «Отмена» возвращает туда же. */
export type NewGameFrom = 'start' | 'menu';

export interface NewGameDraft {
  /** Параметры нового мира: биом в них всегда есть — по seed. */
  settings: WorldSettings;
  /** Выбор сценария (сложность, испытание, регион): вернётся, когда снова выберут «Сценарий». */
  scenario: ScenarioSettings;
}

/**
 * Новый seed в черновике (кубиком, вводом или при открытии окна): биом — тот, что даёт этот seed, даже если
 * до этого его выбирали сами. Выбрать другой можно карточкой биома — он останется до следующей смены seed.
 */
export function withSeed(s: WorldSettings, seed: number): WorldSettings {
  const next: WorldSettings = { ...s, seed, biome: biomeForSeed(seed) };
  // Метка старых версий: «Случайно» у биома больше нет.
  delete next.biomeBySeed;
  return next;
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
  if (!s.scenario && from === 'menu') return { settings: withSeed(s, seed), scenario };
  // Города, предприятия и капитал сценарий задаёт сам — у песочницы оставляем её прежние, иначе — обычные.
  const base = s.scenario ? { ...DEFAULT_SETTINGS, size: s.size, water: s.water, relief: s.relief ?? 'hills' } : s;
  return { settings: withSeed({ ...base, scenario: { ...scenario } }, seed), scenario };
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
 * Строка «Биом»: пять пейзажей, подсвечен биом черновика — тот, что даёт seed, или выбранный сами
 * («Случайно» не нужен: биом и так случайный, по seed). Под ними — «Ресурсы»: что в этом биоме добывают
 * и что просят города, значками. Подсказки — только у самих значков: вложенные друг в друга всплывали
 * разом и накрывали одна другую.
 */
export function biomeRowHtml(biome: BiomeId): string {
  const cards = BIOME_LIST.map(
    (b) =>
      `<button class="card region ${biome === b.id ? 'active' : ''}" data-action="ng-biome" data-id="${b.id}" data-tip="${esc(b.pitch)}">${biomeSvg(b.id)}<span class="name">${esc(b.name)}</span></button>`,
  ).join('');
  const shown = BIOMES[biome];
  const icon = (c: CargoType) => `<span class="ng-cargo" data-tip="${esc(CARGO[c].name)}">${cargoIcon(c, 20, false)}</span>`;
  const raw = biomeRaw(shown.id, INDUSTRY_LIST).map(icon).join('');
  const towns = [...shown.towns, ...shown.extra].map(icon).join('');
  const strip = `<div class="ng-biome-strip"><span class="ng-res-label">Ресурсы</span>
    <span class="ng-biome-part"><span class="ng-part-ic" data-tip="Сырьё: что здесь добывают">⛏</span>${raw}</span>
    <span class="ng-biome-part"><span class="ng-part-ic" data-tip="Что просят города">${townIcon(18)}</span>${towns}</span></div>`;
  return `<div class="ng-row top"><span class="ng-label">Биом</span><div class="ng-region"><div class="cards ng-regions ng-biomes">${cards}</div>${strip}</div></div>`;
}

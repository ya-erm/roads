import { dist } from '../core/vec';
import type { RingSize } from '../game/roads';
import { platformCars, railStationFee, SAVE_VERSION, type Game, type Ledger, type Partner } from '../game/game';
import { TEMPLATES } from '../game/interchange';
import { defaultSaveName, type SaveEntry } from '../game/persist';
import { saveFileText } from '../game/saveFile';
import { addTemplates, fragmentToFile, getTemplate, hasRail, listTemplates, parseTemplateFile, templateFileName, templatesToFile } from '../game/templates';
import {
  AUTO_FLEET,
  carsOf,
  FleetVehicle,
  Line,
  LINE_COLORS,
  LineFolder,
  LineMode,
  MODELS,
  ModelId,
  modelName,
  modelsFor,
  renewOn,
  StopRule,
  vehicleCapacity,
  vehicleLoad,
} from '../game/transport';
import { BRUSH_SIZES, BrushSize, Controller, DRAW_MODES, Tool, TOOLS } from '../input/controller';
import type { TerraformMode } from '../world/terrain';
import { CARGO, CargoType, consumersOf, FREIGHT, producersOf } from '../world/cargo';
import { isBusTerminal, type Station, StationServes, stationTitle, TOWN_HISTORY, TownStyle } from '../world/entities';
import { lastTownNeed, townNeed } from '../world/townSupply';
import { footprintRadius } from '../world/spatial';
import { CONSTRUCTION, COST, ECONOMY, LIGHTS, MONTH_LENGTH, RAIL_STATION, STATION, STOP, STORAGE, TERM_SCALE, TRANSFER } from '../config';
import { durationText } from '../core/timeText';
import { isOneWay, KMH_PER_UNIT, LEVELS, limitAllowed, limitCapText, RAIL_SPEC, ROAD_PRESETS, RoadSpec, SPEED_LIMITS, specCost, specKmh, STRUCTURE } from '../world/roadTypes';
import {
  DEFAULT_SETTINGS,
  NEW_GAME_SETTINGS,
  INDUSTRY_DENSITY,
  IndustryDensity,
  MAP_SIZES,
  MapSize,
  MONEY_OPTIONS,
  RELIEF,
  Relief,
  WATER,
  WaterAmount,
  WorldSettings,
} from '../world/settings';
import { ARCHETYPE_LIST } from '../scenario/content';
import type { Scenario } from '../scenario/manager';
import { getBest, saveBest, slotOf } from '../scenario/records';
import type { ScenarioSettings } from '../scenario/types';
import { cargoIcon, townIcon, walkIcon } from './cargoIcons';
import { paxGone, paxGoneTo, paxPatience } from '../game/paxPatience';
import { fleetBar, fleetBarRoom } from './fleetBar';
import { type LineBack, lineBackFrom, lineCloseTarget } from './lineBack';
import { lineMoneyHtml } from './lineMoney';
import { linePaceHtml } from './linePace';
import { stopFoldHtml, stopPlaceHtml, toggleStop } from './routeStop';
import { chartHoverAt, distLabel, speedChartSvg, speedTipHtml } from './speedChartSvg';
import { travelTimeText } from './travelTime';
import { needsHeadHtml, type PaxNeed, paxNeedHtml, supplyBarHtml, supplyLineHtml, type TownNeed } from './supplyUi';
import { townPax } from '../game/townPax';
import {
  briefHtml,
  leftPanelHtml,
  leftTab,
  type LeftTab,
  modeTilesHtml,
  offerBannerHtml,
  recordRowHtml,
  RecordView,
  resultsHtml,
  scenarioOptionsHtml,
  toggleFold,
} from './scenarioUi';
import {
  autoSvg,
  renewSvg,
  bulldozeAreaSvg,
  bulldozeLaneSvg,
  bulldozePointSvg,
  chevronSvg,
  copySvg,
  crossingSvg,
  folderSvg,
  fragmentSvg,
  levelSvg,
  lineKindSvg,
  modelSvg,
  modeSvg,
  diamondSvg,
  templateSvg,
  freightCarSvg,
  passengerCarSvg,
  terminalStationSvg,
  throughStationSvg,
  stationPlaceSvg,
  drivewaySvg,
  platformLengthSvg,
  platformsSvg,
  baysSvg,
  baysSvgWidth,
  moveEndSvg,
  moveJointSvg,
  moveNodeSvg,
  bendSvg,
  handleSvg,
  cornerSvg,
  projectSvg,
  splitNodeSvg,
  platformPickSvg,
  trackMoveSvg,
  railSvg,
  ringSvg,
  roadSvg,
  speedSign,
  ledgerIcon,
  stationSvg,
  tracksSvg,
  signalSvg,
  oneWaySignalSvg,
  switchSvg,
  upgradeSvg,
  laneSvg,
  downloadSvg,
  downloadAllSvg,
  uploadSvg,
  railBadgeSvg,
  playSvg,
  saveSvg,
  savesSvg,
  newGameSvg,
  journalSvg,
  waterSvg,
  reliefSvg,
  biomeSvg,
} from './icons';
import { Minimap } from './minimap';
import { closeTimelapse, openTimelapse } from './timelapse';
import { syncTimelapseItem, timelapseSvg } from './timelapseButton';
import { type Pref, prefOn, setPref } from './prefs';
import { settingsHtml, settingsSvg } from './settingsMenu';
import { adviceOf, type Advice, type AdviceFix } from '../game/advisor';
import { stationWarnings } from '../game/stationWarnings';
import { storageSlots } from '../game/warehouses';
import { annexHtml } from './annexUi';
import { depositCardHtml, INDUSTRY_TOOL_SVG, industryModeRowHtml, industryOptionsHtml, industryRowsHtml, townRowsHtml } from './enterpriseUi';
import type { IndustryKind } from '../world/cargo';
import { adviceBadge, advisorHtml, bulbSvg, depotSvg } from './advisorUi';
import { bellSvg, newsBadge, newsHtml, newsTarget } from './newsUi';
import type { NewsKind, NewsRef } from '../game/news';
import type { Notice } from '../game/game';
import { lineJamsHtml, stationWarningsHtml } from './jamUi';
import { phasesHtml, phaseTurns } from './phasesUi';
import { addPhase, editedAfter, GREEN_MAX, GREEN_MIN, movePhase, removePhase, stepGreen, withLeftArrows } from '../lanes/lights';
import { installTips } from './tipFloat';
import { basePriceHtml, baseSvg, buildModeRowHtml, km as distText } from './constructionUi';
import { projectName } from '../game/construction';
import { projectCardHtml } from './projectCard';
import { baseCardHtml } from './baseCard';
import { crewCardHtml } from './crewCard';
import { workTrainCardHtml } from './workTrainCard';
import { carTripHtml } from './carTrip';
import { SERVICES } from '../game/services';
import { planPrice, projectMoneyWarning } from '../input/labels';
import { BIOME_LIST, BIOMES, biomeForSeed, cargoOnMap } from '../world/biomes';
import { biomeRowHtml, newGameDraft, type NewGameFrom, nextScenarioSettings, rulesHtml, withSeed } from './newGame';

/** Управление партией: сохранение и новая игра. */
export interface HudSession {
  hasProgress(): boolean;
  /** Автосохранение текущей партии. */
  save(): void;
  /**
   * Новая партия вместо текущей; текущая сначала сама уходит в сохранения. Не сохранилась — false и новая
   * не начата; force — начать и так.
   */
  newGame(settings: WorldSettings, force?: boolean): Promise<boolean>;
  /** Сохранение со своим именем, которому принадлежит текущая партия. */
  linked(): string | null;
  list(): Promise<SaveEntry[]>;
  /** Сохранить под именем; id — перезаписать это сохранение. */
  saveAs(name: string, id?: string): Promise<boolean>;
  load(id: string): Promise<boolean>;
  remove(id: string): Promise<void>;
  /** Скачать текущую партию файлом (например, чтобы отправить для отладки). */
  exportFile(): void;
  /** Скачать журнал партии (JSON Lines) — для разбора. */
  exportJournal(): void;
  /** Открыть партию из файла. */
  importFile(file: File): Promise<boolean>;
}

/** Форма слова для числа n: 1 партия, 2 партии, 5 партий. */
function plural(n: number, one: string, few: string, many: string): string {
  const d = n % 10;
  const dd = n % 100;
  if (d === 1 && dd !== 11) return one;
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return few;
  return many;
}

/** Карандаш для кнопок «Настроить»: остриём вниз-влево, корпус и грифель — два простых силуэта цвета текста. */
const PENCIL_ICON = `<svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true"><path d="M10 1.8 12.2 4 5.8 10.4 3.6 8.2ZM3 8.8 5.2 11 1.3 12.7Z" fill="currentColor"/></svg>`;

/** Силуэт карты с пропорциями сторон. */
function mapSvg(w: number, h: number): string {
  const k = 26 / Math.max(w, h);
  return `<svg class="map-mini" viewBox="0 0 28 28" width="28" height="28"><rect x="${14 - (w * k) / 2}" y="${14 - (h * k) / 2}" width="${w * k}" height="${h * k}" rx="2" fill="#d6e2bd" stroke="#8aa070"/>
    <path d="M${14 - (w * k) / 2 + 3} ${14 + (h * k) / 4}c4-6 8 2 ${w * k - 6}-4" stroke="#8cc3e6" stroke-width="2" fill="none"/></svg>`;
}

const STYLE_NAMES: Record<TownStyle, string> = {
  radial: 'радиально-кольцевой',
  organic: 'старый город',
  linear: 'вдоль дороги',
};

const ICONS: Record<Tool, string> = {
  select: '<svg viewBox="0 0 24 24"><path d="M5 3l12 9-5 1 3 6-2 1-3-6-4 4z" /></svg>',
  road: '<svg viewBox="0 0 24 24"><path d="M4 21 C6 12 10 8 20 4" /><path d="M9 21 C11 14 14 11 21 9" /></svg>',
  rail: '<svg viewBox="0 0 24 24"><path d="M8 2L5 22M16 2l3 20" /><path d="M6 6h12M5.5 11h13M5 16h14M4.5 20.5h15" /></svg>',
  lights:
    '<svg viewBox="0 0 24 24"><rect x="8" y="2" width="8" height="16" rx="3" /><circle cx="12" cy="6" r="1.4" /><circle cx="12" cy="10" r="1.4" /><circle cx="12" cy="14" r="1.4" /><path d="M12 18v4" /></svg>',
  // Развязка «ромб»: магистраль, дорога над ней и четыре съезда-въезда ромбом — не путать с перекрёстком.
  roundabout:
    '<svg viewBox="0 0 24 24"><path d="M9.6 2v20M14.4 2v20" /><path d="M2 12h20" /><path d="M9.6 4.5L4.6 12L9.6 19.5M14.4 4.5L19.4 12L14.4 19.5" /></svg>',
  station: '<svg viewBox="0 0 24 24"><rect x="3" y="8" width="18" height="10" rx="2" /><path d="M3 12h18M7 18v3M17 18v3M8 8V5h8v3" /></svg>',
  line: '<svg viewBox="0 0 24 24"><circle cx="5" cy="18" r="2.5" /><circle cx="19" cy="6" r="2.5" /><circle cx="12" cy="13" r="2" /><path d="M7 16.5l3.5-2.5M13.5 11.5l3.8-4" /></svg>',
  bulldoze:
    '<svg viewBox="0 0 24 24"><path d="M3 17h11l3-5h-6l-2-4H5z" /><circle cx="6" cy="19" r="2" /><circle cx="13" cy="19" r="2" /><path d="M17 12l4 6" /></svg>',
  // Холм с изолиниями.
  terrain: '<svg viewBox="0 0 24 24"><path d="M2 19l7-11 4 5 3-4 6 10z" /><path d="M6.5 14h5M14 14.5h4" /></svg>',
  industry: INDUSTRY_TOOL_SVG,
};

/** «Авто»: дорога по земле, сквозь холм — тоннелем, над лощиной — мостом. */
const AUTO_LEVEL_SVG = `<svg viewBox="0 0 48 36" width="48" height="36"><rect width="48" height="36" fill="#e3edd2"/>
  <path d="M0 22C6 22 8 8 15 8S22 22 26 26S36 30 40 24S46 20 48 20V36H0Z" fill="#c8a878"/>
  <path d="M0 22C6 22 8 8 15 8S22 22 26 26S36 30 40 24S46 20 48 20" stroke="#9bbf6f" stroke-width="2.5" fill="none"/>
  <path d="M2 17H8" stroke="#4b525c" stroke-width="3.5"/><path d="M8 17H21" stroke="#4b525c" stroke-width="3" stroke-dasharray="2.5 2"/>
  <path d="M21 17H46" stroke="#4b525c" stroke-width="3.5"/><path d="M30 18V28M38 18V25" stroke="#8a9099" stroke-width="2"/></svg>`;

/** Во сколько раз метр дороги дороже, чем на земле, — подпись на кнопках высоты. */
const LEVEL_COST: Record<number, number> = { [-1]: STRUCTURE.tunnel, 1: STRUCTURE.bridge, 2: STRUCTURE.overpass };

/** Картинки режимов кисти рельефа: профиль земли до (пунктир) и после. */
const TERRAIN_SVG: Record<TerraformMode, string> = {
  raise: '<svg viewBox="0 0 32 24"><path d="M2 18h28" stroke-dasharray="2 2"/><path d="M2 18c6 0 8-10 14-10s8 10 14 10" /><path d="M16 15V4M12.5 7.5L16 4l3.5 3.5" /></svg>',
  lower: '<svg viewBox="0 0 32 24"><path d="M2 8h28" stroke-dasharray="2 2"/><path d="M2 8c6 0 8 10 14 10s8-10 14-10" /><path d="M16 5v11M12.5 12.5L16 16l3.5-3.5" /></svg>',
  flatten: '<svg viewBox="0 0 32 24"><path d="M2 18c5 0 6-10 11-10s6 10 11 4 4-4 6-4" stroke-dasharray="2 2"/><path d="M2 14h28" /></svg>',
};

const SPEEDS = [
  { value: 0, label: '❚❚', title: 'Пауза (Пробел)' },
  { value: 1, label: '▶', title: 'Обычная скорость' },
  { value: 2, label: '▶▶', title: 'Быстро' },
  { value: 4, label: '▶▶▶', title: 'Очень быстро' },
];

/** Окна поверх карты: правила или брифинг, меню, новая игра, итоги сценария. */
const SCREENS = ['start', 'menu', 'newgame', 'results', 'news'] as const;
type ScreenName = (typeof SCREENS)[number];

const PRESET_HINTS: Record<string, string> = {
  dirt: 'Грунтовая: самая дешёвая и медленная, без асфальта. Подъезд к ферме или карьеру; потом — перестроить',
  street: 'Обычная двусторонняя улица: по полосе в каждую сторону',
  avenue: 'Широкий проспект: по две полосы в каждую сторону, быстрее улицы',
  oneway: 'Односторонняя: две полосы в одну сторону. Одна полоса — инструментом «Полоса»',
  road: 'Шоссе: загородная дорога по полосе в каждую сторону, быстрая, нужны плавные повороты',
  hw2: 'Магистраль: по две быстрые полосы в каждую сторону, нужны плавные повороты',
  mw2: 'Автомагистраль: по две полосы в каждую сторону, посередине барьер. Без левых поворотов и перекрёстков — подключайте развязками. Больше полос — в редакторе полос',
};

const MODE_HINTS: Record<string, string> = {
  straight: 'Прямая от точки до точки. Сама прилипает к «прямо» и 90°; зажать Cmd/Ctrl или Alt — не прилипать, Shift — шаг угла 15°',
  arc: 'Дуга: плавно продолжает дорогу по касательной',
  curve: 'Кривая по трём кликам: начало, изгиб, конец',
};

const LEVEL_HINTS: Record<number, string> = {
  [-1]: 'Тоннель: проходит под дорогами, водой и зданиями. Между уровнями строится пандус',
  0: 'Земля: обычная дорога. Через реку автоматически получится мост',
  1: 'Мост: проходит над дорогами на земле',
  2: 'Эстакада: второй ярус, над мостами',
};

function lanesLabel(spec: RoadSpec): string {
  return isOneWay(spec) ? `${spec.lanesF}→` : `${spec.lanesF}+${spec.lanesB}`;
}

/** Правила в панели «Ж/д» — по строке: значок и короткая подпись, полное пояснение — в подсказке, чтобы панель была низкой. */
/** inline — все правила одной строкой (под карточками). */
function railRules(rules: { svg: string; text: string; hint: string }[], inline = false): string {
  return `<div class="rules ${inline ? 'inline' : ''}">${rules.map((r) => `<div title="${r.hint}"><span class="rule-ic">${r.svg}</span><span>${r.text}</span></div>`).join('')}</div>`;
}

/** Условие отправления как одна из четырёх кнопок. */
type WaitId = 'auto' | 'full' | 'fullm' | 'none';

/** «Полная, но не дольше»: предел ожидания, секунд — 2 минуты (был месяц, когда месяц длился 2 минуты). */
const WAIT_CAP = TERM_SCALE * MONTH_LENGTH;

const WAIT_LABELS: Record<WaitId, string> = {
  auto: '⏳ Авто',
  full: '▣ Полная',
  fullm: `▣ Полная ≤ ${durationText(WAIT_CAP)}`,
  none: '→ Не ждать',
};

const WAIT_HINTS: Record<WaitId, string> = {
  auto: 'Пустой грузовик немного подождёт груз у производителя',
  full: 'Ждать полной загрузки сколько угодно',
  fullm: `Ждать полной загрузки, но не дольше ${durationText(WAIT_CAP)}`,
  none: 'Сразу в путь с тем, что успели погрузить',
};

const ruleWaitId = (r: StopRule): WaitId => (r.wait === 'full' ? (r.maxWait === null ? 'full' : 'fullm') : r.wait);

/** Вариант главной дороги с кнопки карточки перекрёстка (data-v) — как `mainPair` узла: null — «Авто», [] — равнозначный. */
const mainChoice = (v: string | undefined): number[] | null => (v === 'auto' || !v ? null : v === 'none' ? [] : v.split(',').map(Number));

const money = (n: number) => `$${Math.round(n).toLocaleString('ru-RU')}`;

/** Столбики «доход / расход» по месяцам — для компании и для линии. */
function incomeChart(months: { label: string; income: number; expense: number }[], H = 90): string {
  if (!months.length) return '<p class="muted">График появится после первого месяца.</p>';
  const max = Math.max(1, ...months.map((m) => Math.max(m.income, m.expense)));
  const W = 300;
  const bw = W / Math.max(12, months.length);
  const bars = months
    .map((m, i) => {
      const x = i * bw;
      const hi = (m.income / max) * (H - 14);
      const he = (m.expense / max) * (H - 14);
      return `<rect x="${x + 2}" y="${H - 12 - hi}" width="${bw / 2 - 2}" height="${hi}" rx="1.5" fill="#3fae6a"><title>${m.label}: доход ${money(m.income)}</title></rect>
        <rect x="${x + bw / 2}" y="${H - 12 - he}" width="${bw / 2 - 2}" height="${he}" rx="1.5" fill="#e5534b"><title>${m.label}: расход ${money(m.expense)}</title></rect>
        ${monthTick(x + bw / 2, H, m.label)}`;
    })
    .join('');
  return `<svg class="fin-chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${bars}</svg>`;
}

/** Подпись месяца под столбиком графика: «Май» из «Май 1962». */
const monthTick = (x: number, H: number, label: string) =>
  `<text x="${x}" y="${H - 2}" text-anchor="middle" font-size="8" fill="#7b8794">${label.split(' ')[0]}</text>`;

/**
 * Снабжение города одним грузом по месяцам: столбик цветом груза — сколько привезли (снизу штриховкой —
 * излишек прошлого месяца, засчитанный в этот), пунктир — норма месяца, ✓ — норма закрыта. Текущий (ещё
 * идущий) месяц бледнее.
 */
function supplyChart(months: { label: string; got: number; carried?: number; need: number; current?: boolean }[], color: string, H = 72): string {
  const W = 300;
  // Слева — число нормы у пунктира, сверху — место для галочки.
  const L = 16;
  const top = 11;
  const base = H - 12;
  const max = Math.max(1, ...months.map((m) => Math.max(m.got, m.need * 1.15)));
  const y = (v: number) => base - (v / max) * (base - top);
  const bw = (W - L) / Math.max(12, months.length);
  const hatch = `sup-hatch-${color.replace(/[^\w]/g, '')}`;
  const bars = months
    .map((m, i) => {
      const x = L + i * bw;
      const h = base - y(m.got);
      const hc = base - y(Math.min(m.carried ?? 0, m.got));
      const ok = m.got >= m.need;
      const carried = hc > 0 ? ` (${Math.round(m.carried!)} — излишек прошлого месяца)` : '';
      const tip = `${m.current ? 'Этот месяц' : m.label}: привезли ${Math.round(m.got)}${carried} из ${m.need}${ok ? ' ✓' : ''}`;
      return `<g${m.current ? ' opacity="0.4"' : ''} data-tip="${tip}"><rect x="${x}" y="0" width="${bw}" height="${H}" fill="transparent"/>
        ${h > hc ? `<rect x="${x + bw * 0.18}" y="${base - h}" width="${bw * 0.64}" height="${h - hc}" rx="1.5" fill="${color}"/>` : ''}
        ${hc > 0 ? `<rect x="${x + bw * 0.18}" y="${base - hc}" width="${bw * 0.64}" height="${hc}" fill="url(#${hatch})" stroke="${color}" stroke-width="0.8"/>` : ''}
        ${ok ? `<text x="${x + bw / 2}" y="${base - h - 2}" text-anchor="middle" font-size="9" font-weight="700" fill="#2e9d57">✓</text>` : ''}
        ${monthTick(x + bw / 2, H, m.label)}</g>`;
    })
    .join('');
  const defs = `<defs><pattern id="${hatch}" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
    <rect width="4" height="4" fill="#fff"/><rect width="2" height="4" fill="${color}"/></pattern></defs>`;
  // Пунктир нормы — отрезками с одинаковой нормой; последний тянется до края.
  let norm = '';
  for (let i = 0, start = 0; i < months.length; i++) {
    const last = i === months.length - 1;
    if (!last && months[i + 1].need === months[start].need) continue;
    const ny = y(months[start].need);
    norm += `<line x1="${L + start * bw}" x2="${last ? W : L + (i + 1) * bw}" y1="${ny}" y2="${ny}" stroke="#7b8794" stroke-dasharray="3 2"><title>Норма месяца: ${months[start].need}</title></line>`;
    start = i + 1;
  }
  const label = months.length ? `<text x="${L - 3}" y="${y(months[0].need) + 3}" text-anchor="end" font-size="8" fill="#7b8794">${months[0].need}</text>` : '';
  return `<svg class="fin-chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${defs}
    <line x1="${L}" x2="${W}" y1="${base}" y2="${base}" stroke="#dfe4ea"/>${bars}${norm}${label}</svg>`;
}
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Скачивает текст файлом name (как «Сохранить в файл» у партии). */
function downloadText(name: string, text: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export class Hud {
  private readonly q: <T extends HTMLElement>(sel: string) => T;
  private lastPanel = '';
  /** Кнопка мыши зажата над панелью: не перерисовываем, иначе клик потеряется. */
  private pressing = false;
  /** Скорость игры до открытия меню — к ней вернёмся по «Продолжить». */
  private speedBeforeMenu = 1;
  /** Окно «События»: скорость до него (вернётся при закрытии), фильтры по видам, с какой записи — новое, разметка. */
  private speedBeforeNews = 1;
  private readonly newsKinds = new Set<NewsKind>();
  private newsUnreadFrom = 0;
  private lastNews = '';
  private lastNewsBadge = '';
  private lastConfirm = '';
  /** Свой шаблон, который игрок собрался удалить: ждёт подтверждения в окне. */
  private deletingTemplate: string | null = null;
  /** Список линий свёрнут до заголовка (запоминается в браузере). */
  private linesCollapsed = localStorage.getItem('roads.linesCollapsed') === '1';
  /** График скорости в карточке линии раскрыт (для всех линий). */
  private speedChartOpen = localStorage.getItem('roads.speedChart') === '1';
  /** clientX курсора над графиком скорости (null — курсор не на графике): после перерисовки панели — подсказка там же. */
  private speedHoverX: number | null = null;
  /** Деньги в карточке линии раскрыты: под прибылью — доход / расходы, этот месяц, всего (для всех линий). */
  private lineMoneyOpen = localStorage.getItem('roads.lineMoney') === '1';
  private readonly minimap: Minimap;
  private lastOptions = '';
  private panelTimer = 0;

  private confirmNew = false;
  /** Сохранения со своими именами (последний прочитанный список). */
  private saves: SaveEntry[] = [];
  /** Ждём второго нажатия: `load:id` — загрузить без сохранения текущей, `del:id` — удалить. */
  private confirmSave: string | null = null;
  /** Линия, у которой открыта палитра цвета. */
  private colorsOpen: number | null = null;
  /** Остановка, у которой раскрыты условия. */
  private stopOpen: { line: number; i: number } | null = null;
  /** Потребности городов, раскрытые в диаграмму по месяцам: `город:груз`. */
  private readonly needsOpen = new Set<string>();
  /** Блок «Что нужно городу» свёрнут до одной строки — у всех городов (запоминается в браузере). */
  private needsFolded = localStorage.getItem('roads.needsFolded') === '1';
  /** Свёрнутые списки «Куда везти» (out) и «Откуда везти» (in) — у всех городов и предприятий (запоминается в браузере). */
  private readonly partnersFolded = new Set((localStorage.getItem('roads.partnersFolded') ?? '').split(',').filter(Boolean));
  /** Карточка маршрута открыта из панели города: крестик вернёт к нему. Сбрасывается, как только карточка закрылась. */
  private lineBack: LineBack | null = null;
  /** Папка, у которой сейчас открыто поле названия. */
  private renamingFolder: number | null = null;
  /** Линия, для которой в карточке открыто поле названия новой папки. */
  private addingFolderLine: number | null = null;
  /** Линия, для которой в карточке раскрыт выпадающий список папок. */
  private folderPickOpen: number | null = null;
  /** Станция, у которой в карточке открыто поле названия. */
  private renamingStation: number | null = null;
  /** База стройки, название которой правят в её карточке. */
  private renamingBase: number | null = null;
  /** Проект стройки, название которого правят в его карточке. */
  private renamingProject: number | null = null;
  /** Линия, которую тянут мышью на папку: пока тянем, панель не перерисовываем. */
  private dragLine: number | null = null;
  /** Покупку из карточки маршрута тянут на остановку: какую модель и на какую линию (см. bindBuyDrag). */
  private dragBuy: { line: number; model: ModelId } | null = null;
  /** Черновик параметров нового мира; биом в нём — по seed или выбранный игроком (см. withSeed). */
  private draft: WorldSettings = withSeed({ ...NEW_GAME_SETTINGS, relief: 'hills' }, DEFAULT_SETTINGS.seed);
  /** Последний выбор сценария на экране новой игры: возвращается, когда снова выбирают «Сценарий». */
  private scenarioOptions: ScenarioSettings = { difficulty: 'normal', challenge: false };
  /** Откуда открыли «Новую игру»: «Отмена» и Esc возвращают туда. */
  private newGameFrom: NewGameFrom = 'menu';
  /** Окно правил — стартовый экран первого запуска: «Начать» открывает «Новую игру», а не запускает время. */
  private intro = false;
  /** Новая игра уже создаётся (текущая партия сохраняется): повторные нажатия не в счёт. */
  private starting = false;
  /** Панель сценария свёрнута до заголовка (запоминается в браузере). */
  private scenarioCollapsed = localStorage.getItem('roads.scenarioCollapsed') === '1';
  /** Выбранная вкладка левой панели (запоминается в браузере); её нет в партии — показывается первая. */
  private leftTab: LeftTab = (['scenario', 'events', 'build', 'ideas'] as const).find((t) => t === localStorage.getItem('roads.leftTab')) ?? 'scenario';
  /** Задания, у которых в панели раскрыто «почему». */
  private readonly whyOpen = new Set<string>();
  /** «Следующий этап» нажат один раз: второе нажатие переводит этап. */
  private confirmAdvance = false;
  /** «🚜 Снести базу» в карточке базы нажат один раз (id базы): второе нажатие сносит. */
  private confirmRemoveBase: number | null = null;
  private lastScenario = '';
  /** Советник: скрытые игроком подсказки (до новой партии) и последняя разметка панели. */
  private readonly hiddenAdvice = new Set<string>();
  private lastAdvisor = '';
  private lastAdviceBadge = '';
  /** Скорость до итогового экрана — к ней вернёмся по «Продолжить». */
  private speedBeforeResults = 1;
  /** Рекорд уже записан для этого сценария (итоговый экран можно открыть снова). */
  private recordFor: Scenario | null = null;
  private record: RecordView = { best: null, previous: null, isNew: false };

  constructor(
    private readonly root: HTMLElement,
    private readonly controller: Controller,
    private readonly game: () => Game,
    private readonly session: HudSession,
  ) {
    root.innerHTML = `
      <div class="panel stats" data-action="finance" title="Финансы: доходы и расходы по статьям">
        <div class="stat"><span class="label">Деньги <span class="money-reserve hidden" data-reserve data-tip="В резерве стройки: деньги на счёте, но отложены на проекты — другие траты их не возьмут"></span></span><span class="value" data-money></span></div>
        <div class="stat"><span class="label">За месяц</span><span class="value small" data-balance></span></div>
        <div class="stat"><span class="label">Парк</span><span class="value small" data-fleet></span></div>
        <div class="stat day"><span class="label" data-date></span><div class="bar"><div data-month></div></div></div>
        <button class="advisor-btn" data-action="advisor" title="" data-tip="Советник: что мешает сети работать">${bulbSvg(22)}<b class="advice-badge hidden" data-advice-badge></b></button>
        <button class="advisor-btn news-btn" data-action="news" title="" data-tip="История уведомлений">${bellSvg(22)}<b class="advice-badge news-badge hidden" data-news-badge></b></button>
      </div>
      <div class="panel speed" data-speed></div>
      <div class="offer-banner hidden" data-offer-banner></div>
      <div class="notices" data-notices></div>
      <div class="panel options hidden" data-options></div>
      <div class="panel toolbar" data-tools></div>
      <div class="panel side" data-side></div>
      <div class="panel chains hidden" data-chains></div>
      <div class="panel finance hidden" data-finance></div>
      <div class="panel advisor hidden" data-advisor></div>
      <div class="panel scenario hidden" data-scenario></div>
      <div class="panel minimap-wrap" data-minimap></div>
      <div class="screen hidden" data-start><div class="modal start" data-start-body></div></div>
      <div class="screen hidden" data-results><div class="modal results" data-results-body></div></div>
      <div class="screen hidden" data-news><div class="modal news" data-news-body></div></div>
      <div class="screen hidden" data-menu>
        <div class="modal menu">
          <div data-menu-main>
            <button class="icon modal-close" data-action="resume" title="Закрыть (Esc)">✕</button>
            <h2>Меню</h2>
            <p class="muted" data-menu-info></p>
            <div class="menu-buttons">
              <button class="primary" data-action="resume">${playSvg(18)}Продолжить</button>
              <button class="menu-item" data-action="save-game">${saveSvg(22)}<span class="menu-text"><b>Сохранить</b><small data-save-target></small></span></button>
              <button class="menu-item" data-action="menu-saves">${savesSvg(22)}<span class="menu-text"><b>Загрузить</b><small data-saves-count></small></span><span class="menu-go">›</span></button>
              <button class="menu-item" data-action="new-game">${newGameSvg(22)}<span class="menu-text"><b>Новая игра</b><small>Другая карта, города, деньги</small></span><span class="menu-go">›</span></button>
              <button class="menu-item" data-action="export-journal" data-tip="Скачать журнал партии: стройка, маршруты, рейсы, производство, задания и события — для разбора">${journalSvg(22)}<span class="menu-text"><b>Журнал партии</b><small data-journal-count></small></span></button>
              <button class="menu-item" data-action="timelapse" data-timelapse-menu>${timelapseSvg(22)}<span class="menu-text"><b>Таймлапс партии</b><small></small></span></button>
              <button class="menu-item" data-action="menu-settings">${settingsSvg(22)}<span class="menu-text"><b>Настройки</b><small>Карта и задания без сроков</small></span><span class="menu-go">›</span></button>
            </div>
          </div>
          <div class="hidden" data-menu-settings>
            <button class="icon menu-back" data-action="menu-back" title="Назад в меню (Esc)">‹</button>
            <button class="icon modal-close" data-action="resume" title="Закрыть">✕</button>
            <h2>Настройки</h2>
            <div class="menu-buttons prefs" data-prefs></div>
          </div>
          <div class="hidden" data-menu-saves>
            <button class="icon menu-back" data-action="menu-back" title="Назад в меню (Esc)">‹</button>
            <button class="icon modal-close" data-action="resume" title="Закрыть">✕</button>
            <h2>Сохранения</h2>
            <div class="saves" data-saves></div>
            <div class="file-row">
              <button class="small with-ic" data-action="export-save" title="Скачать партию файлом — например, чтобы отправить его">${downloadSvg(15)}Сохранить в файл</button>
              <label class="small file-pick with-ic" title="Открыть партию из файла">${uploadSvg(15)}Открыть из файла<input type="file" accept=".json,.gz,application/json,application/gzip" data-import-save /></label>
            </div>
          </div>
        </div>
      </div>
      <div class="screen hidden" data-newgame><div class="modal newgame" data-newgame-body></div></div>
      <div class="screen hidden" data-confirm></div>
    `;
    this.q = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;

    const tools = this.q('[data-tools]');
    for (const t of TOOLS) {
      const b = document.createElement('button');
      b.className = 'tool';
      b.dataset.action = 'tool';
      b.dataset.id = t.id;
      b.innerHTML = `${ICONS[t.id]}<span class="name">${t.name}</span><kbd>${t.alt ?? t.key}</kbd>`;
      b.title = t.alt ? `${t.name} (${t.alt} или ${t.key})` : `${t.name} (${t.key})`;
      tools.appendChild(b);
    }
    const speed = this.q('[data-speed]');
    for (const s of SPEEDS) {
      const b = document.createElement('button');
      b.textContent = s.label;
      b.title = s.title;
      b.dataset.action = 'speed';
      b.dataset.v = String(s.value);
      speed.appendChild(b);
    }
    const chains = document.createElement('button');
    chains.textContent = 'Цепочки';
    chains.title = 'Что производят предприятия и что нужно городам (C)';
    chains.dataset.action = 'chains';
    speed.appendChild(chains);
    const heat = document.createElement('button');
    heat.textContent = 'Пробки';
    heat.title = 'Карта загрузки дорог (H)';
    heat.dataset.action = 'heatmap';
    speed.appendChild(heat);
    const limits = document.createElement('button');
    limits.textContent = 'Скорости';
    limits.dataset.tip = 'Разрешённая скорость на дорогах и ж/д путях и где её снижают повороты (V)';
    limits.dataset.action = 'speedmap';
    speed.appendChild(limits);
    const menu = document.createElement('button');
    menu.textContent = 'Меню';
    menu.title = 'Сохранение, новая игра и настройки';
    menu.dataset.action = 'menu';
    speed.appendChild(menu);

    this.minimap = new Minimap(this.q('[data-minimap]'), game, controller.camera);
    root.addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      // Партия из файла: открываем и закрываем меню.
      if (input.dataset.importSave !== undefined && input.files?.[0]) {
        void this.session.importFile(input.files[0]).then((ok) => {
          input.value = '';
          if (ok) this.hideScreens();
        });
        return;
      }
      // Шаблоны из файла — к своим.
      if (input.dataset.importTemplates !== undefined && input.files?.[0]) {
        const file = input.files[0];
        input.value = '';
        void this.importTemplates(file);
        return;
      }
      if (input.dataset.ngSeed === undefined) return;
      const v = Math.abs(Math.floor(Number(input.value.replace(/\D/g, '')))) || 1;
      // Другой seed — и биом тот, что даёт он (как у кубика).
      if (v !== this.draft.seed) this.draft = withSeed(this.draft, v);
      this.renderNewGame();
    });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyC' && !(e.target instanceof HTMLInputElement)) this.toggleChains();
    });
    // Esc закрывает меню (а из «Новой игры» возвращает в меню) — раньше, чем его увидит карта.
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.code !== 'Escape') return;
        if (!this.closeModal()) return;
        e.stopImmediatePropagation();
        e.preventDefault();
      },
      { capture: true },
    );
    // Клик мимо окна — то же, что Esc.
    for (const s of ['menu', 'newgame', 'news']) {
      this.q(`[data-${s}]`).addEventListener('click', (e) => {
        if (e.target === e.currentTarget) this.closeModal();
      });
    }
    this.q('[data-confirm]').addEventListener('click', (e) => {
      if (e.target !== e.currentTarget) return;
      if (this.deletingTemplate) this.closeModal();
      else this.controller.cancelArea();
    });
    root.addEventListener('click', (e) => this.onClick(e));
    // Подсказки data-tip — одной плавающей плашкой: не обрезаются панелями и краем экрана.
    installTips();
    // Курсор на варианте главной дороги — карта показывает его, пока курсор на кнопке.
    const mainChip = (t: EventTarget | null) => (t instanceof Element ? t.closest<HTMLElement>('[data-action="jn-main"]') : null);
    root.addEventListener('pointerover', (e) => {
      const el = mainChip(e.target);
      if (el) controller.mainHover = { node: Number(el.dataset.id), mainPair: mainChoice(el.dataset.v) };
    });
    root.addEventListener('pointerout', (e) => {
      const el = mainChip(e.target);
      if (el && el !== mainChip(e.relatedTarget)) controller.mainHover = null;
    });
    // Курсор на графике скорости линии — черта, точка и подсказка со скоростью на графике и та же точка на маршруте на карте.
    const speedSvg = (t: EventTarget | null) => (t instanceof Element ? t.closest<SVGSVGElement>('[data-speed-line] svg') : null);
    root.addEventListener('pointermove', (e) => {
      const svg = speedSvg(e.target);
      if (svg) this.speedHover(svg, e.clientX);
      else if (this.speedHoverX !== null || controller.chartPoint) this.speedHoverEnd(root.querySelector<SVGSVGElement>('[data-speed-line] svg'));
    });
    root.addEventListener('pointerout', (e) => {
      const svg = speedSvg(e.target);
      if (svg && !speedSvg(e.relatedTarget)) this.speedHoverEnd(svg);
    });
    // Курсор на машине в списке маршрута — карта подсвечивает её. Список перерисовывается прямо под курсором
    // (старая строка уходит без pointerout), поэтому решаем при каждом заходе на элемент — и на карту тоже.
    const vehRow = (t: EventTarget | null) => (t instanceof Element ? t.closest<HTMLElement>('[data-veh]') : null);
    document.addEventListener('pointerover', (e) => {
      const row = vehRow(e.target);
      controller.fleetHover = row ? Number(row.dataset.veh) : null;
    });
    document.addEventListener('pointerout', (e) => {
      if (!e.relatedTarget && vehRow(e.target)) controller.fleetHover = null;
    });
    // Карточка транспорта меняется каждый кадр (скорость): держим её, пока кнопка мыши зажата.
    this.q('[data-side]').addEventListener('pointerdown', () => (this.pressing = true));
    // Левая панель тоже обновляется сама (сроки, прогресс, стройка) — не перерисовываем её под нажатой кнопкой.
    this.q('[data-scenario]').addEventListener('pointerdown', () => (this.pressing = true));
    this.q('[data-offer-banner]').addEventListener('pointerdown', () => (this.pressing = true));
    // Плашка предложения — вверху между деньгами и кнопками скорости: следим за их шириной, правой панелью и окном.
    const place = new ResizeObserver(() => this.placeOfferBanner());
    for (const el of [root, this.q('.stats'), this.q('[data-speed]'), this.q('[data-side]')]) place.observe(el);
    window.addEventListener('pointerup', () => setTimeout(() => (this.pressing = false)));
    // Переименование линии: сохраняем по Enter или при уходе фокуса.
    root.addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      if (input.dataset.lineColor) {
        this.game().setLineColor(Number(input.dataset.lineColor), input.value);
        input.blur();
        this.sync(true);
        return;
      }
      if (!input.dataset.lineName) return;
      this.game().renameLine(Number(input.dataset.lineName), input.value);
      input.blur();
      this.sync(true);
    });
    root.addEventListener('keydown', (e) => {
      const input = e.target as HTMLInputElement;
      if (input.dataset?.lineName && e.key === 'Enter') input.blur();
      if (input.dataset?.lineName && e.key === 'Escape') {
        input.value = this.game().lines.get(Number(input.dataset.lineName))?.name ?? input.value;
        input.blur();
      }
      // Enter в поле имени сохранения — сохранить как новое.
      if (input.dataset?.saveName !== undefined && e.key === 'Enter') void this.session.saveAs(this.saveName()).then(() => this.renderSaves(true));
      if (input.dataset?.templateName !== undefined && e.key === 'Enter') this.saveUserTemplate();
    });
    this.bindFolders(root, this.q('[data-side]'));
    this.bindStationName(root);
    this.bindBaseName(root);
    this.bindProjectName(root);
    controller.onChange = () => this.sync(true);
    // Esc, когда на карте отменять нечего, — меню; поверх другого окна (правила, брифинг) — нет.
    controller.onMenu = () => {
      if (!this.anyScreen()) this.openMenu();
    };
    this.sync(true);
  }

  /** Название базы стройки в её карточке: клик открывает поле, Enter или уход фокуса — сохранить, Esc — отменить. */
  private bindBaseName(root: HTMLElement): void {
    root.addEventListener('keydown', (e) => {
      const input = e.target as HTMLInputElement;
      if (!input.dataset?.baseName) return;
      if (e.key === 'Escape') input.value = this.game().baseName(Number(input.dataset.baseName));
      if (e.key === 'Enter' || e.key === 'Escape') input.blur();
    });
    root.addEventListener('focusout', (e) => {
      const input = e.target as HTMLInputElement;
      if (!input.dataset?.baseName) return;
      this.game().renameBase(Number(input.dataset.baseName), input.value);
      this.renamingBase = null;
      this.lastScenario = '';
      // Пока идёт focusout, поле ещё считается активным — перерисуем карточку и строку базы следом.
      setTimeout(() => this.sync(true));
    });
  }

  /**
   * Название проекта стройки в его карточке: клик по нему или по ✎ открывает поле, Enter или уход фокуса — сохранить,
   * Esc — отменить; пустое — снова автоматическое (Game.renameProject).
   */
  private bindProjectName(root: HTMLElement): void {
    const project = (input: HTMLInputElement) => this.game().construction.projects.get(Number(input.dataset.projectName));
    root.addEventListener('keydown', (e) => {
      const input = e.target as HTMLInputElement;
      if (!input.dataset?.projectName) return;
      if (e.key === 'Escape') {
        const p = project(input);
        if (p) input.value = projectName(p);
      }
      if (e.key === 'Enter' || e.key === 'Escape') input.blur();
    });
    root.addEventListener('focusout', (e) => {
      const input = e.target as HTMLInputElement;
      if (!input.dataset?.projectName) return;
      this.game().renameProject(Number(input.dataset.projectName), input.value);
      this.renamingProject = null;
      this.lastScenario = '';
      // Пока идёт focusout, поле ещё считается активным — перерисуем карточку и строку проекта следом.
      setTimeout(() => this.sync(true));
    });
  }

  /**
   * Название станции в её карточке: клик по нему или по ✎ открывает поле (selectionHtml),
   * Enter или уход фокуса — сохранить, Esc — отменить. Клавиш из поля карта не видит (Controller.onKey).
   */
  private bindStationName(root: HTMLElement): void {
    root.addEventListener('keydown', (e) => {
      const input = e.target as HTMLInputElement;
      if (!input.dataset?.stationName) return;
      if (e.key === 'Escape') input.value = this.game().stations.get(Number(input.dataset.stationName))?.name ?? input.value;
      if (e.key === 'Enter' || e.key === 'Escape') input.blur();
    });
    root.addEventListener('focusout', (e) => {
      const input = e.target as HTMLInputElement;
      if (!input.dataset?.stationName) return;
      this.game().renameStation(Number(input.dataset.stationName), input.value);
      this.renamingStation = null;
      // Пока идёт focusout, поле ещё считается активным — перерисуем панель следом.
      setTimeout(() => this.sync(true));
    });
  }

  /**
   * Папки линий: переименование в поле (Enter или уход фокуса — сохранить, Esc — отменить),
   * двойной клик по названию и перетаскивание строки линии: на папку, в корень списка
   * или между строками — так меняется порядок линий.
   */
  private bindFolders(root: HTMLElement, side: HTMLElement): void {
    root.addEventListener('keydown', (e) => {
      const input = e.target as HTMLInputElement;
      if (input.dataset?.newFolderLine !== undefined) {
        // Esc — отмена: пустое значение при уходе фокуса новую папку не создаст.
        if (e.key === 'Escape') input.value = '';
        if (e.key === 'Enter' || e.key === 'Escape') input.blur();
        return;
      }
      if (!input.dataset?.folderName) return;
      if (e.key === 'Escape') input.value = this.game().folders.get(Number(input.dataset.folderName))?.name ?? input.value;
      if (e.key === 'Enter' || e.key === 'Escape') input.blur();
    });
    root.addEventListener('focusout', (e) => {
      const input = e.target as HTMLInputElement;
      if (input.dataset?.newFolderLine !== undefined) {
        const lineId = Number(input.dataset.newFolderLine);
        const name = input.value.trim();
        this.addingFolderLine = null;
        if (name) {
          const folder = this.game().createFolder(name);
          this.game().setLineFolder(lineId, folder.id);
        }
        setTimeout(() => this.sync(true));
        return;
      }
      if (!input.dataset?.folderName) return;
      this.game().renameFolder(Number(input.dataset.folderName), input.value);
      this.renamingFolder = null;
      // Пока идёт focusout, поле ещё считается активным — перерисуем панель следом.
      setTimeout(() => this.sync(true));
    });
    side.addEventListener('dblclick', (e) => {
      const title = (e.target as HTMLElement).closest<HTMLElement>('[data-folder-title]');
      if (!title) return;
      this.renamingFolder = Number(title.dataset.folderTitle);
      this.sync(true);
    });
    const marks = ['drop-over', 'drop-before', 'drop-after', 'dragged'];
    const clearOver = (keep = false) =>
      side.querySelectorAll(marks.map((m) => `.${m}`).join(',')).forEach((el) => el.classList.remove(...marks.slice(0, keep ? 3 : 4)));
    /**
     * Куда упадёт линия: над строкой — вставка до или после неё (по половине строки),
     * над заголовком папки или пустым местом — в конец папки или корня списка.
     */
    const targetOf = (e: DragEvent) => {
      const el = e.target as HTMLElement;
      const zone = el.closest<HTMLElement>('[data-folder-drop]');
      if (this.dragLine === null || !zone) return null;
      const folder = zone.dataset.folderDrop === 'root' ? null : Number(zone.dataset.folderDrop);
      const row = el.closest<HTMLElement>('[data-drag-line]');
      if (!row) return { folder, before: null, mark: zone, cls: 'drop-over' };
      const r = row.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      // «После строки» — это перед следующей строкой той же папки, а за последней — в конец.
      const next = (row.nextElementSibling as HTMLElement | null)?.dataset?.dragLine;
      const before = after ? (next ? Number(next) : null) : Number(row.dataset.dragLine);
      return { folder, before, mark: row, cls: after ? 'drop-after' : 'drop-before' };
    };
    side.addEventListener('dragstart', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('[data-drag-line]');
      if (!row || !e.dataTransfer) return;
      this.dragLine = Number(row.dataset.dragLine);
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', row.dataset.dragLine!);
      side.classList.add('dragging-line');
      row.classList.add('dragged');
    });
    side.addEventListener('dragover', (e) => {
      const t = targetOf(e);
      if (!t) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      if (!t.mark.classList.contains(t.cls)) {
        clearOver(true);
        t.mark.classList.add(t.cls);
      }
    });
    side.addEventListener('dragleave', (e) => {
      if (!side.contains(e.relatedTarget as Node | null)) clearOver(true);
    });
    side.addEventListener('drop', (e) => {
      const t = targetOf(e);
      if (!t) return;
      e.preventDefault();
      this.game().moveLine(this.dragLine!, t.folder, t.before);
    });
    // После перетаскивания pointerup не приходит — снимаем «зажатую кнопку» сами.
    side.addEventListener('dragend', () => {
      this.dragLine = null;
      this.pressing = false;
      side.classList.remove('dragging-line');
      clearOver();
      this.sync(true);
    });
    // Знак скорости из панели можно перетащить на дорогу — ограничение без перестройки.
    const options = this.q('[data-options]');
    // Полоса карточек с прокруткой вбок (data-hscroll, «Предприятие»): колесо мыши листает её вбок; трекпад
    // (горизонтальный жест) — как есть.
    options.addEventListener(
      'wheel',
      (e) => {
        const strip = (e.target as HTMLElement).closest<HTMLElement>('[data-hscroll]');
        if (!strip || strip.scrollWidth <= strip.clientWidth || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
        e.preventDefault();
        strip.scrollLeft += e.deltaY;
      },
      { passive: false },
    );
    options.addEventListener('dragstart', (e) => {
      const sign = (e.target as HTMLElement).closest<HTMLElement>('[data-drag-limit]');
      if (!sign || !e.dataTransfer) return;
      this.controller.dragLimit = Number(sign.dataset.dragLimit);
      // Любое действие: с Cmd / Ctrl (только участок) macOS разрешает лишь «переместить» или «ссылку» — см. dropEffectFor.
      e.dataTransfer.effectAllowed = 'all';
      e.dataTransfer.setData('text/plain', `speed:${sign.dataset.dragLimit}`);
      const img = sign.querySelector('svg');
      if (img) e.dataTransfer.setDragImage(img, 13, 13);
    });
    options.addEventListener('dragend', () => {
      this.pressing = false;
      this.controller.endLimitDrag();
    });
    this.bindBuyDrag(side);
  }

  /**
   * Карточку покупки в карточке маршрута можно перетащить на остановку в списке: машина начнёт работу
   * с неё, сразу. Пока тянем — силуэт машины под курсором, остановки маршрута обведены, а над той,
   * куда отпустится, — тот же силуэт со стрелкой отправления.
   */
  private bindBuyDrag(side: HTMLElement): void {
    let mark: HTMLElement | null = null;
    const stopOf = (e: DragEvent) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('.route .stop[data-i]');
      return row && this.dragBuy && Number(row.dataset.line) === this.dragBuy.line ? row : null;
    };
    const clear = () => {
      side.querySelectorAll('.buy-over').forEach((el) => el.classList.remove('buy-over'));
      mark?.remove();
    };
    side.addEventListener('dragstart', (e) => {
      const card = (e.target as HTMLElement).closest<HTMLElement>('[data-drag-buy]');
      const line = card && this.game().lines.get(Number(card.dataset.line));
      if (!card || !line || !e.dataTransfer) return;
      const model = card.dataset.dragBuy as ModelId;
      this.dragBuy = { line: line.id, model };
      // Панель не перерисовываем, пока тянем (pointerup после перетаскивания не придёт — снимаем в dragend).
      this.pressing = true;
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('text/plain', `buy:${model}`);
      const art = card.querySelector('svg');
      if (art) e.dataTransfer.setDragImage(art, art.clientWidth / 2, art.clientHeight / 2);
      mark = document.createElement('span');
      mark.className = 'buy-drop-mark';
      mark.innerHTML = `${modelSvg(model, line.color, 34, 16, this.game().tankLine(line))}<b>▶</b>`;
      card.classList.add('buy-dragged');
      card.closest('.detail')?.querySelector('.route')?.classList.add('buy-drop');
    });
    // Подсветка — по dragover (он идёт и над вложенными элементами строки): не над остановкой — снимаем.
    side.addEventListener('dragover', (e) => {
      if (!this.dragBuy) return;
      const row = stopOf(e);
      if (!row) return clear();
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      if (row.classList.contains('buy-over')) return;
      clear();
      row.classList.add('buy-over');
      if (mark) row.append(mark);
    });
    side.addEventListener('dragleave', (e) => {
      if (this.dragBuy && !side.contains(e.relatedTarget as Node | null)) clear();
    });
    side.addEventListener('drop', (e) => {
      const row = stopOf(e);
      if (!row || !this.dragBuy) return;
      e.preventDefault();
      const g = this.game();
      const v = g.buyVehicle(this.dragBuy.line, this.dragBuy.model, false, Number(row.dataset.i));
      if (!v) g.notify('Не хватает денег');
      else g.fitAutoRange(v.lineId);
    });
    side.addEventListener('dragend', () => {
      if (!this.dragBuy) return;
      this.dragBuy = null;
      this.pressing = false;
      clear();
      mark = null;
      side.querySelectorAll('.buy-dragged, .buy-drop').forEach((el) => el.classList.remove('buy-dragged', 'buy-drop'));
      this.sync(true);
    });
  }

  private onClick(e: MouseEvent): void {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    // Клик мимо выпадающего списка папок закрывает его (сам выбор — отдельным действием ниже).
    if (this.folderPickOpen !== null && !(e.target as HTMLElement).closest('.folder-pick')) {
      this.folderPickOpen = null;
      this.sync(true);
    }
    if (!el) return;
    const c = this.controller;
    const g = this.game();
    const d = el.dataset;
    if (d.action !== 'ng-create') this.confirmNew = false;
    if (d.action !== 'sc-advance') this.confirmAdvance = false;
    if (d.action !== 'base-remove') this.confirmRemoveBase = null;
    switch (d.action) {
      case 'begin':
        this.hideScreens();
        c.setSpeed(1);
        break;
      case 'ng-intro':
        // «Начать» на стартовом экране — «Новая игра», где уже выбран сценарий.
        this.openNewGame('start');
        break;
      case 'menu':
        this.openMenu();
        break;
      case 'resume':
        this.hideScreens();
        c.setSpeed(this.speedBeforeMenu);
        break;
      case 'save-game': {
        // Партия из сохранения — перезаписываем его; иначе — новое сохранение с именем по умолчанию.
        const id = this.session.linked();
        const entry = id ? this.saves.find((s) => s.id === id) : undefined;
        const name = entry?.name ?? this.defaultSaveName();
        void this.session.saveAs(name, entry?.id).then((ok) => this.refreshMenuMain(ok ? name : undefined));
        break;
      }
      case 'menu-saves':
        this.confirmSave = null;
        this.menuView('saves');
        void this.renderSaves(true);
        break;
      case 'menu-settings':
        this.menuView('settings');
        this.q('[data-prefs]').innerHTML = settingsHtml();
        break;
      case 'pref': {
        // Настройка интерфейса: сохраняется в браузере, карта перерисуется сама (подписка onPrefs).
        const id = d.id as Pref;
        setPref(id, !prefOn(id));
        this.q('[data-prefs]').innerHTML = settingsHtml();
        break;
      }
      case 'menu-back':
        this.confirmSave = null;
        this.menuView('main');
        void this.refreshMenuMain();
        break;
      case 'export-journal':
        this.session.exportJournal();
        break;
      case 'timelapse':
        // Серая кнопка (смотреть нечего) — объяснение в подсказке, окна нет.
        if (el.getAttribute('aria-disabled') !== 'true') openTimelapse(g);
        break;
      case 'export-save':
        this.session.exportFile();
        break;
      case 'save-new':
        void this.session.saveAs(this.saveName()).then(() => this.renderSaves());
        break;
      case 'save-load': {
        const id = d.id!;
        const linked = this.session.linked();
        // Текущая партия не в списке — загрузка её потеряет: просим нажать ещё раз.
        if (!linked && this.session.hasProgress() && this.confirmSave !== `load:${id}`) {
          this.confirmSave = `load:${id}`;
          void this.renderSaves();
          break;
        }
        this.confirmSave = null;
        const current = linked ? this.saves.find((s) => s.id === linked) : undefined;
        const before = current ? this.session.saveAs(current.name, current.id) : Promise.resolve(true);
        void before
          .then(() => this.session.load(id))
          .then((ok) => {
            if (!ok) return;
            this.hideScreens();
            c.setSpeed(this.speedBeforeMenu);
          });
        break;
      }
      case 'save-del':
        if (this.confirmSave !== `del:${d.id}`) {
          this.confirmSave = `del:${d.id}`;
          void this.renderSaves();
          break;
        }
        this.confirmSave = null;
        void this.session.remove(d.id!).then(() => this.renderSaves());
        break;
      case 'new-game':
        this.openNewGame('menu');
        break;
      case 'ng-cancel':
        this.closeNewGame();
        break;
      case 'ng-mode': {
        const next = { ...this.draft };
        if (d.id === 'scenario') next.scenario = { ...this.scenarioOptions };
        else delete next.scenario;
        this.draft = next;
        this.renderNewGame();
        break;
      }
      case 'ng-diff':
        this.setScenarioOption({ difficulty: d.id === 'easy' || d.id === 'hard' ? d.id : 'normal' });
        break;
      case 'ng-challenge':
        this.setScenarioOption({ challenge: !this.scenarioOptions.challenge });
        break;
      case 'ng-pick': {
        const pick = ARCHETYPE_LIST.find((a) => a.id === d.id)?.id;
        this.setScenarioOption({ pick });
        break;
      }
      case 'ng-set':
        this.draft = { ...this.draft, [d.key!]: d.key === 'money' ? Number(d.v) : d.v };
        this.renderNewGame();
        break;
      case 'ng-towns':
        this.draft = { ...this.draft, towns: Math.max(4, Math.min(20, this.draft.towns + Number(d.d))) };
        this.renderNewGame();
        break;
      case 'ng-seed':
        // Кубик: новый seed — и биом, который он даёт, даже если до этого биом выбирали сами.
        this.draft = withSeed(this.draft, Math.floor(Math.random() * 1e9));
        this.renderNewGame();
        break;
      case 'ng-biome': {
        const biome = BIOME_LIST.find((b) => b.id === d.id)?.id;
        if (biome) this.draft = { ...this.draft, biome };
        this.renderNewGame();
        break;
      }
      case 'ng-create':
        // Новая игра — сразу: текущая партия сама уходит в сохранения. Не сохранилась — кнопка спросит,
        // начинать ли без неё (confirmNew), и второе нажатие начнёт.
        this.startNewGame(this.draft, this.confirmNew, () => {
          this.confirmNew = true;
          this.renderNewGame();
        });
        break;
      case 'tool':
        c.setTool(d.id as Tool);
        break;
      case 'speed':
        c.setSpeed(Number(d.v));
        break;
      case 'heatmap':
        c.toggleHeatmap();
        break;
      case 'speedmap':
        c.toggleSpeedmap();
        break;
      case 'chains':
        this.toggleChains();
        break;
      case 'finance':
        this.toggleFinance();
        break;
      case 'advisor':
        this.toggleAdvisor();
        break;
      case 'news':
        this.openNews();
        break;
      case 'news-close':
        this.closeNews();
        break;
      case 'news-filter': {
        // «Все» — снять фильтры; значок вида — включить или выключить его.
        const kind = d.kind as NewsKind | '';
        if (!kind) this.newsKinds.clear();
        else if (!this.newsKinds.delete(kind)) this.newsKinds.add(kind);
        this.renderNews(true);
        break;
      }
      case 'news-go': {
        const e = g.news.entries.find((x) => x.n === Number(d.n));
        if (!e) break;
        this.closeNews();
        this.goTo(d.i !== undefined && e.refs ? [e.refs[Number(d.i)]] : [], e.at);
        break;
      }
      case 'advice-show':
        this.showAdvice(d.key!);
        break;
      case 'build-pause': {
        const p = g.construction.projects.get(Number(d.id));
        if (p) g.pauseProject(p.id, !p.paused);
        this.refreshLeft();
        break;
      }
      case 'build-cancel':
        g.cancelProject(Number(d.id));
        this.refreshLeft();
        break;
      case 'build-show': {
        // К проекту на карте — и его карточка справа (сроки, деньги, бригады).
        const info = g.construction.info(Number(d.id));
        if (info) {
          this.controller.showPlace(info.front ?? info.at, Math.max(60, Math.min(400, info.length / 3)));
          // Из карточки базы («стройки рядом») — закрытие карточки стройки вернёт к базе.
          if (c.selection?.type === 'base') c.selectFrom({ type: 'project', id: info.project.id });
          else c.select({ type: 'project', id: info.project.id });
        }
        break;
      }
      case 'project-reserve': {
        const problem = g.reserveProject(Number(d.id), d.on === '1');
        if (problem) g.notify(problem, '#e5534b');
        this.refreshLeft();
        break;
      }
      case 'project-priority':
        g.prioritizeProject(Number(d.id), d.on === '1');
        this.refreshLeft();
        break;
      case 'project-closure':
        // Перестройка: перекрытие по полосам (◐) или целиком (⛔) — src/game/rebuild.ts.
        g.setProjectClosure(Number(d.id), d.on === '1');
        this.refreshLeft();
        break;
      case 'project-rename':
        // Название — в карточке проекта: поле сразу (кнопку уже отпустили), иначе первые нажатия ушли бы карте.
        this.renamingProject = Number(d.id);
        this.pressing = false;
        break;
      case 'base-place':
        // «＋ База» — и с карточки проекта: ставим базу, а левая панель — на вкладке «Стройка» (кнопка там нажата).
        this.controller.startBase(!this.controller.placingBase);
        if (this.controller.placingBase) this.openLeftTab('build');
        this.refreshLeft();
        break;
      case 'left-tab': {
        // Вкладка левой панели; в свёрнутой — ещё и развернуть, чтобы было видно, что на ней.
        const tab = d.id as LeftTab;
        this.openLeftTab(tab);
        if (this.scenarioCollapsed) this.setLeftCollapsed(false);
        this.refreshLeft();
        break;
      }
      case 'base-hire': {
        const problem = g.hireBrigade(Number(d.id));
        if (problem) g.notify(problem, '#e5534b');
        this.refreshLeft();
        break;
      }
      case 'base-fire':
        g.dismissBrigade(Number(d.id));
        this.refreshLeft();
        break;
      case 'base-remove': {
        // Снос базы из её карточки — со второго нажатия (первое спрашивает «Точно? +$N, бригады → «…»»), как «Сносом».
        const id = Number(d.id);
        if (this.confirmRemoveBase !== id) {
          this.confirmRemoveBase = id;
          break;
        }
        this.confirmRemoveBase = null;
        const problem = g.removeBase(id);
        if (problem) g.notify(problem, '#e5534b');
        else c.select(null);
        this.refreshLeft();
        break;
      }
      case 'base-rename':
        // Название — в карточке базы: поле сразу (кнопку уже отпустили), иначе первые нажатия ушли бы карте.
        this.renamingBase = Number(d.id);
        this.pressing = false;
        break;
      case 'crew-show': {
        // Бригада: камера — к ней (в пути — к головной машине, на стройке — к краю работ) и её карточка справа (все
        // машины колонны подсвечены); из карточки базы или проекта — закрытие карточки бригады вернёт к ней.
        const id = Number(d.id);
        const where = g.brigadeWhere(id);
        if (where) {
          this.controller.showPlace(where.pos, 60);
          const same = c.selection?.type === 'crew' && c.selection.id === id;
          if (!same && (c.selection?.type === 'base' || c.selection?.type === 'project')) c.selectFrom({ type: 'crew', id });
          else if (!same) c.select({ type: 'crew', id });
        }
        break;
      }
      case 'worktrain-show':
        // Строительный поезд: камера — к нему и его карточка; из карточки проекта — закрытие вернёт к ней.
        c.showWorkTrain(Number(d.id));
        break;
      case 'crew-send':
        // «🎯 На стройку…»: выбор проекта кликом по карте (ещё раз или Esc — отмена).
        c.startCrewSend(Number(d.id), c.sendingCrew !== Number(d.id));
        break;
      case 'crew-to': {
        // Стройка из списка в карточке бригады: едет туда и закрепляется; нельзя — причина уведомлением.
        const problem = g.sendBrigade(Number(d.id), Number(d.p));
        if (problem) g.notify(problem, '#e5534b');
        else c.startCrewSend(Number(d.id), false);
        break;
      }
      case 'crew-auto':
        g.autoBrigade(Number(d.id));
        break;
      case 'deposit-show': {
        const dep = g.enterprises.deposit(Number(d.id));
        if (dep) this.controller.showPlace(dep.center, 120);
        break;
      }
      case 'dep-build': {
        // Добыча на месторождение из его карточки — как кликом инструментом «Предприятие»; поставили — её карточка.
        const dep = g.enterprises.deposit(Number(d.id));
        const problem = dep ? g.enterprises.build(dep.kind, dep.center, dep.angle) : 'Месторождения нет';
        if (problem) g.notify(problem, '#e5534b');
        else {
          const ind = g.industries[g.industries.length - 1];
          if (ind) c.select({ type: 'industry', id: ind.id });
        }
        break;
      }
      case 'base-show': {
        // К базе на карте — и её карточка справа (бригады, нанять и распустить, ближние стройки).
        const base = g.construction.crews.bases.get(Number(d.id));
        if (base) {
          this.controller.showPlace(base.fp.center, 80);
          c.select({ type: 'base', id: base.id });
        }
        break;
      }
      case 'advice-fix':
        this.fixAdvice(d.key!);
        break;
      case 'warn-fix':
        this.fixWarning(Number(d.id), d.key!);
        break;
      case 'advice-hide':
        this.hiddenAdvice.add(d.key!);
        this.lastAdvisor = '';
        break;
      case 'loan-take':
        g.takeLoan();
        this.lastFinance = '';
        break;
      case 'loan-repay':
        g.repayLoan();
        this.lastFinance = '';
        break;
      case 'sc-toggle':
        this.setLeftCollapsed(!this.scenarioCollapsed);
        this.refreshLeft();
        break;
      case 'sc-why':
        if (!this.whyOpen.delete(d.id!)) this.whyOpen.add(d.id!);
        break;
      case 'sc-fold': {
        // Выбор хранится в задании — сохраняется с партией и переживает перезагрузку страницы.
        const o = g.scenario?.objective(d.id!);
        if (o) toggleFold(o);
        break;
      }
      case 'sc-offer-show':
        this.showOffer(d.id);
        break;
      case 'sc-past': {
        const key = `ev:${d.id}`;
        if (!this.whyOpen.delete(key)) this.whyOpen.add(key);
        break;
      }
      case 'sc-accept':
      case 'sc-decline': {
        const sc = g.scenario;
        if (!sc || !d.id) break;
        if (d.action === 'sc-accept') sc.accept(d.id);
        else sc.decline(d.id);
        // Стартовый контракт можно принять прямо в брифинге — обновим его.
        if (!this.q('[data-start]').classList.contains('hidden')) this.renderStart();
        break;
      }
      case 'idea-take':
      case 'idea-later':
      case 'idea-drop': {
        // Идеи без сроков: взять, отложить на 10 мин, отказаться или бросить — без последствий.
        if (!d.id) break;
        if (d.action === 'idea-take') g.ideas.take(d.id);
        else if (d.action === 'idea-later') g.ideas.later(d.id);
        else g.ideas.drop(d.id);
        this.refreshLeft();
        break;
      }
      case 'sc-advance':
        // Незакрытые цели этапа засчитаются как невыполненные — переходим со второго нажатия.
        if (this.confirmAdvance) {
          this.confirmAdvance = false;
          g.scenario?.advancePhase();
        } else this.confirmAdvance = true;
        break;
      case 'sc-results':
        this.showResults();
        break;
      case 'sc-continue':
        this.continueAfterResults();
        break;
      case 'sc-replay':
        // Настройки уже с решённым архетипом и профилем: та же карта и тот же сценарий.
        this.startNewGame(g.settings);
        break;
      case 'sc-new': {
        // Другой регион — и биом по новому seed, как в окне «Новая игра» (без биома был бы мир старых версий).
        this.startNewGame(nextScenarioSettings(g.settings, Math.floor(Math.random() * 1e9)));
        break;
      }
      case 'town-streets': {
        const t = g.towns.find((x) => x.id === Number(d.id));
        if (t) t.autoStreets = t.autoStreets === false;
        this.sync(true);
        break;
      }
      case 'town-need': {
        // Строка потребности города раскрывается в диаграмму по месяцам и сворачивается обратно.
        const key = `${d.id}:${d.c}`;
        if (!this.needsOpen.delete(key)) this.needsOpen.add(key);
        break;
      }
      case 'toggle-needs':
        // «Что нужно городу» сворачивается до одной строки: значки грузов в кольцах заполнения.
        this.needsFolded = !this.needsFolded;
        localStorage.setItem('roads.needsFolded', this.needsFolded ? '1' : '0');
        break;
      case 'hint':
        // «?» в заголовке только показывает подсказку (data-tip): клик по нему блок не сворачивает.
        break;
      case 'toggle-partners': {
        // «Куда везти» / «Откуда везти» сворачиваются до заголовка со значками грузов.
        const dir = d.dir === 'out' ? 'out' : 'in';
        if (!this.partnersFolded.delete(dir)) this.partnersFolded.add(dir);
        localStorage.setItem('roads.partnersFolded', [...this.partnersFolded].join(','));
        break;
      }
      case 'chain-kind': {
        // Подсвечиваем все предприятия типа и показываем ближайшее к центру экрана.
        const list = g.industries.filter((i) => i.info.kind === d.kind);
        c.highlight = list.map((i) => i.id);
        const center = { x: c.camera.x, y: c.camera.y };
        const nearest = list.sort((a, b) => dist(a.fp.center, center) - dist(b.fp.center, center))[0];
        if (nearest) c.focus(nearest.fp.center, 0.35);
        break;
      }
      case 'focus': {
        const id = Number(d.id);
        if (d.type === 'town') {
          const t = g.towns.find((x) => x.id === id);
          if (t) c.focus(t.center, 0.35);
          c.select({ type: 'town', id });
        } else {
          const ind = g.industries.find((x) => x.id === id);
          if (ind) c.focus(ind.fp.center, 0.35);
          c.select({ type: 'industry', id });
        }
        c.selectLine(null);
        break;
      }
      case 'toggle-speed-chart':
        this.speedChartOpen = !this.speedChartOpen;
        localStorage.setItem('roads.speedChart', this.speedChartOpen ? '1' : '0');
        break;
      case 'toggle-line-money':
        this.lineMoneyOpen = !this.lineMoneyOpen;
        localStorage.setItem('roads.lineMoney', this.lineMoneyOpen ? '1' : '0');
        break;
      case 'toggle-lines':
        this.linesCollapsed = !this.linesCollapsed;
        localStorage.setItem('roads.linesCollapsed', this.linesCollapsed ? '1' : '0');
        break;
      case 'terrain-mode':
        c.setTerrainMode(d.id === 'lower' || d.id === 'flatten' ? d.id : 'raise');
        break;
      case 'brush-size':
        c.setBrushSize(d.id === 'small' || d.id === 'large' ? d.id : 'medium');
        break;
      case 'bulldoze-mode':
        c.setBulldozeMode(d.id === 'area' || d.id === 'lane' ? d.id : 'point');
        break;
      case 'area-confirm':
        c.confirmArea();
        break;
      case 'area-cancel':
        c.cancelArea();
        break;
      case 'template-kind':
        c.setTemplate(d.id === 'tee' || d.id === 'clover' ? d.id : 'diamond');
        break;
      case 'show-station': {
        const st = g.stations.get(Number(d.id));
        if (st) c.showPlace(st.fp.center, footprintRadius(st.fp));
        break;
      }
      case 'preset':
        c.setPreset(d.id!);
        break;
      case 'road-mode':
        c.setRoadMode(d.id === 'upgrade' || d.id === 'move' || d.id === 'lane' ? d.id : 'build');
        break;
      case 'junction-mode':
        c.setJunctionMode(d.id === 'template' || d.id === 'copy' ? d.id : 'ring');
        break;
      case 'user-template':
        c.setUserTemplate(d.id ?? null);
        break;
      case 'user-template-del':
        // Спрашиваем своим окном: схема шаблона, имя, «Отмена» и «Удалить».
        this.deletingTemplate = d.id ?? null;
        break;
      case 'user-template-dl': {
        const t = getTemplate(d.id ?? '');
        if (t) downloadText(templateFileName(t.name), templatesToFile([t]));
        break;
      }
      case 'templates-dl-all': {
        const all = listTemplates();
        if (all.length) downloadText(templateFileName(`Шаблоны развязок (${all.length})`), templatesToFile(all));
        break;
      }
      case 'tpl-del-yes':
        if (this.deletingTemplate) c.removeUserTemplate(this.deletingTemplate);
        this.deletingTemplate = null;
        break;
      case 'tpl-del-no':
        this.deletingTemplate = null;
        break;
      case 'paste-rotate':
        c.rotatePaste(Number(d.v));
        break;
      case 'clipboard-clear':
        c.clearClipboard();
        break;
      case 'template-save':
        this.saveUserTemplate();
        break;
      case 'template-save-file':
        this.saveClipboardFile();
        break;
      case 'rail-mode':
        c.setRailMode(d.id === 'station' || d.id === 'signal' || d.id === 'parallel' || d.id === 'move' ? d.id : 'track');
        break;
      case 'rail-tracks':
        c.setRailTracks(Number(d.v));
        break;
      case 'signal-oneway':
        c.setSignalOneWay(d.v === '1');
        break;
      case 'limit':
        c.setLimit(Number(d.v));
        break;
      case 'ring-lanes':
        c.setRingLanes(Number(d.v));
        break;
      case 'ring-size':
        c.setRingSize(d.id as RingSize);
        break;
      case 'lanes':
        c.setLanes(c.spec.lanesF + Number(d.f ?? 0), c.spec.lanesB + Number(d.b ?? 0));
        break;
      case 'mode':
        c.setMode(d.id as typeof c.drawMode);
        break;
      case 'project':
        c.toggleProject();
        break;
      case 'project-build':
        c.buildProject();
        break;
      case 'project-cancel':
        c.discardProject();
        break;
      case 'level':
        if (d.v === 'auto') c.setAutoLevel();
        else c.setLevel(Number(d.v));
        break;
      case 'new-line':
        c.setTool('line');
        break;
      case 'finish-line':
        c.finishLine();
        break;
      case 'cancel-line':
        c.cancelLine();
        c.setTool('select');
        break;
      case 'select-line':
        // Из панели города крестик карточки вернёт к ней, из других мест — просто закроет карточку.
        this.lineBack = lineBackFrom(c.selection, Number(d.id));
        c.selectLine(Number(d.id));
        c.select(null);
        break;
      case 'close-line': {
        const back = lineCloseTarget(this.lineBack, c.selectedLine, g.towns);
        this.lineBack = null;
        c.selectLine(null);
        if (back) c.select(back);
        break;
      }
      case 'st-tracks':
        c.setStationTracks(c.stationTracks + (Number(d.d) || 0));
        break;
      case 'st-length':
        c.setStationLength(c.stationLength + (Number(d.d) || 0) * RAIL_STATION.lengthStep);
        break;
      case 'st-terminal':
        c.setStationTerminal(d.v === '1');
        break;
      case 'st-side':
        c.setStationSide(d.v === '1');
        break;
      case 'st-driveway':
        c.setStationDriveway(c.stationDriveway + (Number(d.d) || 0) * STATION.drivewayRange.step);
        break;
      case 'st-drive': {
        // Карточка станции: выезд длиннее или короче — станция переезжает в его новый конец.
        const st = g.stations.get(Number(d.id));
        const now = st && g.stationDrivewayLen(st);
        if (!st || now === null || now === undefined) break;
        const problem = g.setStationDriveway(st.id, now + (Number(d.d) || 0) * STATION.drivewayRange.step);
        if (problem) g.notify(problem);
        break;
      }
      case 'new-serves':
        c.toggleStationServe(d.what === 'pax' ? 'pax' : 'cargo');
        break;
      case 'station-mode':
        // «База стройки» — тот же режим, что «＋ База» на вкладке «Стройка».
        if (d.id === 'base') c.startBase();
        else c.setStationMode(d.id === 'stop' || d.id === 'pax' || d.id === 'rail' ? d.id : 'cargo');
        break;
      case 'st-serves': {
        const st = g.stations.get(Number(d.id));
        if (st) g.setStationServes(st.id, { ...st.serves, [d.what === 'pax' ? 'pax' : 'cargo']: !st.serves[d.what === 'pax' ? 'pax' : 'cargo'] });
        break;
      }
      case 'st-bays': {
        const st = g.stations.get(Number(d.id));
        const problem = st && g.setStationBays(st.id, st.bays + Number(d.d));
        if (problem) g.notify(problem);
        break;
      }
      case 'st-depots': {
        // «−»: последний склад-здание, а у старых сохранений — пристройка.
        const st = g.stations.get(Number(d.id));
        const last = st?.warehouses?.[st.warehouses.length - 1];
        const problem = last ? g.removeWarehouse(last) : st && g.setStationDepots(st.id, (st.depots ?? 0) + Number(d.d));
        if (problem) g.notify(problem);
        break;
      }
      case 'ind-kind':
      case 'ind-build-for':
        // Инструмент «Предприятие» с этим видом (из панели или «🏗» в карточке города).
        c.setIndustryKind(d.id as IndustryKind);
        break;
      case 'ind-restore': {
        const ind = g.industries.find((i) => i.id === Number(d.id));
        const problem = ind ? g.enterprises.restore(ind) : 'Предприятия нет';
        if (problem) g.notify(problem, '#e5534b');
        break;
      }
      case 'ind-annex': {
        // Пристройку ставят на карте — зона вокруг предприятия видна, клик в ней ставит; повторно — отмена.
        const id = Number(d.id);
        if (c.placingAnnex === id) c.placingAnnex = null;
        else c.startAnnex(id);
        break;
      }
      case 'st-warehouse': {
        // «+»: склад ставят на карте — зона вокруг станции видна, клик в ней ставит здание; повторно — отмена.
        const id = Number(d.id);
        const st = g.stations.get(id);
        if (st && storageSlots(st) >= STORAGE.max) g.notify(`Больше ${STORAGE.max} складов нельзя`);
        else if (c.placingWarehouse === id) c.placingWarehouse = null;
        else c.startWarehouse(id);
        break;
      }
      case 'toggle-colors':
        this.colorsOpen = this.colorsOpen === Number(d.id) ? null : Number(d.id);
        break;
      case 'line-color':
        g.setLineColor(Number(d.id), d.color!);
        this.colorsOpen = null;
        break;
      case 'delete-line':
        g.deleteLine(Number(d.id));
        c.selectLine(null);
        break;
      case 'new-folder':
        // Новая папка сразу открывается для ввода названия.
        this.renamingFolder = g.createFolder().id;
        break;
      case 'toggle-folder':
        g.toggleFolder(Number(d.id));
        break;
      case 'rename-folder':
        this.renamingFolder = Number(d.id);
        break;
      case 'rename-station':
        this.renamingStation = Number(d.id);
        // Кнопку уже отпустили: поле — сразу (sync ниже), иначе первые нажатия успели бы уйти карте.
        this.pressing = false;
        break;
      case 'delete-folder':
        g.deleteFolder(Number(d.id));
        if (this.renamingFolder === Number(d.id)) this.renamingFolder = null;
        break;
      case 'folder-pick-toggle': {
        const line = Number(d.line);
        this.folderPickOpen = this.folderPickOpen === line ? null : line;
        break;
      }
      case 'line-folder': {
        // В другую папку линия встаёт последней; повторный клик по своей папке порядок не меняет.
        const to = d.folder ? Number(d.folder) : null;
        if ((g.lines.get(Number(d.line))?.folder ?? null) !== to) g.moveLine(Number(d.line), to);
        this.folderPickOpen = null;
        break;
      }
      case 'line-folder-new': {
        this.addingFolderLine = Number(d.line);
        this.folderPickOpen = null;
        break;
      }
      case 'buy': {
        const v = g.buyVehicle(Number(d.line), d.model as ModelId);
        if (!v) g.notify('Не хватает денег');
        // Купил сам сверх предела авто-парка — предел раздвигается.
        else g.fitAutoRange(v.lineId);
        break;
      }
      case 'sell': {
        const lineId = g.fleet.get(Number(d.id))?.lineId;
        g.sellVehicle(Number(d.id));
        if (lineId !== undefined) g.fitAutoRange(lineId);
        break;
      }
      case 'line-auto':
        g.setLineAuto(Number(d.id), { on: !g.lines.get(Number(d.id))?.auto?.on });
        break;
      case 'line-auto-renew': {
        const line = g.lines.get(Number(d.id));
        if (line) g.setLineAuto(line.id, { renew: !renewOn(line.auto) });
        break;
      }
      case 'auto-range': {
        const auto = g.lines.get(Number(d.id))?.auto;
        if (auto) g.setLineAuto(Number(d.id), d.what === 'min' ? { min: auto.min + Number(d.d) } : { max: auto.max + Number(d.d) });
        break;
      }
      case 'replace':
        if (!g.replaceVehicle(Number(d.id))) g.notify('Не хватает денег на замену');
        break;
      case 'dispatch-now':
        g.dispatchNow(Number(d.id));
        break;
      case 'line-spacing':
        g.setLineSpacing(Number(d.id), !!g.lines.get(Number(d.id))?.noSpacing);
        break;
      case 'cars': {
        const v = g.fleet.get(Number(d.id));
        if (v && !g.setTrainCars(v.id, carsOf(v) + Number(d.d))) g.notify(Number(d.d) > 0 ? 'Длиннее состав не поместится на платформы маршрута' : 'Меньше двух вагонов нельзя');
        break;
      }
      case 'notice-go': {
        // Уведомление с местом («Стройка закончена») или о предприятии, городе, маршруте — туда.
        const n: Notice | undefined = g.notices[Number(d.id)];
        if (n) this.goTo(n.refs ?? [], n.at);
        break;
      }
      case 'close-sel':
        // Открыта из другой карточки (стройка из карточки базы) — назад к той.
        c.closeSelection();
        break;
      case 'demolish': {
        const b = g.buildingById(Number(d.id));
        g.checkpoint('снос здания');
        if (b && g.demolishBuilding(b)) c.select(null);
        g.commit();
        break;
      }
      case 'move': {
        const b = g.buildingById(Number(d.id));
        if (b) c.startMove(b);
        break;
      }
      case 'move-station':
        // Ж/д станцию можно перенести и другим типом: data-terminal — конечной (1) или проходной (0).
        c.startStationMove(Number(d.id), d.terminal === undefined ? undefined : d.terminal === '1');
        break;
      case 'st-track': {
        const problem = g.addRailTrack(Number(d.id));
        if (problem) g.notify(problem);
        break;
      }
      case 'st-extend': {
        const problem = g.extendRailPlatforms(Number(d.id));
        if (problem) g.notify(problem);
        break;
      }
      case 'base-move':
        // Перенос строительной базы: площадка за курсором у дороги, клик — туда (Esc — отмена).
        c.startBaseMove(Number(d.id));
        break;
      case 'show-fleet':
        // Выбираем машину или поезд компании и переносим к нему камеру.
        c.select({ type: 'fleet', id: Number(d.id) });
        c.focusSelection();
        break;
      case 'toggle-follow':
        c.toggleFollow();
        break;
      case 'jn-lanes-edit':
        // Настраивать полосы на карте можно инструментом «Перекрёсток» — выбор перекрёстка остаётся.
        c.setTool('lights');
        break;
      case 'jn-ph-edit':
        // Фаза — править на перекрёстке: кликами по проездам на карте (controller.editPhase); та же ещё раз — готово.
        c.editPhase(Number(d.id), Number(d.i));
        break;
      case 'jn-lights':
      case 'jn-green':
      case 'jn-adaptive':
      case 'jn-main':
      case 'jn-lanes-reset':
      case 'jn-ph-add':
      case 'jn-ph-del':
      case 'jn-ph-move':
      case 'jn-ph-arrows':
      case 'jn-ph-auto': {
        // Настройки перекрёстка — тоже стройка: их можно отменить Ctrl+Z.
        const id = Number(d.id);
        const n = g.roads.net.nodes.get(id);
        if (!n) break;
        const i = Number(d.i);
        // Фаза, которую правят на карте, и сколько фаз до правки: номер правки едет вместе со своей фазой.
        const edited = c.phaseEdit?.node === id ? c.phaseEdit.i : null;
        const count = g.junctionInfo(id)?.phases.length ?? 0;
        g.checkpoint('настройка перекрёстка');
        if (d.action === 'jn-lights') g.toggleLights(id);
        else if (d.action === 'jn-lanes-reset') g.resetLanes(id);
        else if (d.action === 'jn-adaptive') g.setJunction(id, { adaptive: d.v === '1' });
        else if (d.action === 'jn-ph-add') g.editPhases(id, (s) => addPhase(s));
        else if (d.action === 'jn-ph-del') g.editPhases(id, (s) => removePhase(s, i));
        else if (d.action === 'jn-ph-move') g.editPhases(id, (s) => movePhase(s, i, Number(d.d)));
        else if (d.action === 'jn-ph-auto') g.resetPhases(id);
        else if (d.action === 'jn-ph-arrows') {
          // Левые повороты, что сейчас уступают встречным, — по фазам.
          const info = g.junctionInfo(id);
          const lefts = new Set(info ? phaseTurns(info).filter((t) => t.kind === 'left').map((t) => t.key) : []);
          g.editPhases(id, (s) => withLeftArrows(s, info?.phases.map((ph) => ph.yields.filter((k) => lefts.has(k))) ?? []));
        } else if (d.action === 'jn-green' && n.phases?.length) g.editPhases(id, (s) => stepGreen(s, i, Number(d.d)));
        else if (d.action === 'jn-green') {
          // Фазы «Авто» остаются «Авто»: меняется только их зелёный.
          const count = g.junctionInfo(id)?.phases.length ?? 0;
          const greens = Array.from({ length: count }, (_, k) => n.greens?.[k] ?? LIGHTS.green);
          greens[i] = Math.max(GREEN_MIN, Math.min(GREEN_MAX, greens[i] + Number(d.d)));
          g.setJunction(id, { greens });
        } else if (d.action === 'jn-main') {
          g.setJunction(id, { mainPair: mainChoice(d.v) });
        }
        g.commit();
        // Новую фазу — сразу править на перекрёстке (она в конце); переставили или убрали — правка за своей фазой;
        // «Авто» и стрелки налево меняют все фазы — правка закончена.
        if (d.action === 'jn-ph-add') c.editPhase(id, count, false);
        else if (edited !== null && (d.action === 'jn-ph-del' || d.action === 'jn-ph-move'))
          c.editPhase(id, editedAfter(edited, i, d.action === 'jn-ph-del' ? null : Number(d.d), count), false);
        else if (edited !== null && (d.action === 'jn-ph-auto' || d.action === 'jn-ph-arrows')) c.editPhase(id, null);
        break;
      }
      case 'stop-open':
        this.stopOpen = toggleStop(this.stopOpen, { line: Number(d.line), i: Number(d.i) });
        // Кнопку уже отпустили: раскрываем и сворачиваем сразу (sync ниже), а не со следующей перерисовкой панели.
        this.pressing = false;
        break;
      case 'stop-up':
      case 'stop-down': {
        const i = Number(d.i);
        const problem = g.moveLineStop(Number(d.line), i, d.action === 'stop-up' ? -1 : 1);
        if (problem) g.notify(problem);
        this.stopOpen = null;
        break;
      }
      case 'stop-del': {
        const problem = g.removeLineStop(Number(d.line), Number(d.i));
        if (problem) g.notify(problem);
        this.stopOpen = null;
        break;
      }
      case 'stop-add':
        c.startAddStop(Number(d.line));
        break;
      case 'stop-add-done':
        c.stopAddStop();
        break;
      case 'rule-wait':
      case 'rule-load':
      case 'rule-unload':
      case 'rule-platform': {
        const line = g.lines.get(Number(d.line));
        if (!line) break;
        const i = Number(d.i);
        const rule: StopRule = { ...g.stopRule(line, i) };
        if (d.action === 'rule-platform') {
          // Путь ж/д станции для этой остановки: номер или авто.
          if (d.v === 'auto') delete rule.platform;
          else rule.platform = Number(d.v);
        } else if (d.action === 'rule-wait') {
          const w = d.v as WaitId;
          rule.wait = w === 'fullm' ? 'full' : w;
          rule.maxWait = w === 'fullm' ? WAIT_CAP : null;
        } else if (d.action === 'rule-load') {
          if (d.c === 'auto') rule.load = 'auto';
          else {
            const list = rule.load === 'auto' ? [] : [...rule.load];
            const c = d.c as CargoType;
            rule.load = list.includes(c) ? list.filter((x) => x !== c) : [...list, c];
          }
        } else if (d.c === 'auto' || d.c === 'all') {
          rule.unload = d.c;
        } else {
          const list = Array.isArray(rule.unload) ? [...rule.unload] : [];
          const c = d.c as CargoType;
          const next = list.includes(c) ? list.filter((x) => x !== c) : [...list, c];
          rule.unload = next.length ? next : 'auto';
        }
        g.setStopRule(line.id, i, rule);
        break;
      }
    }
    this.sync(true);
  }

  private sync(force = false): void {
    const c = this.controller;
    const g = this.game();
    this.root.querySelectorAll<HTMLElement>('[data-action="tool"]').forEach((b) => {
      b.classList.toggle('active', b.dataset.id === c.tool);
      // «Предприятие» — только в партиях, где предприятия строит игрок.
      if (b.dataset.id === 'industry') b.classList.toggle('hidden', !g.enterprises.on);
    });
    this.root.querySelectorAll<HTMLElement>('[data-action="speed"]').forEach((b) => b.classList.toggle('active', Number(b.dataset.v) === g.speed));
    this.q('[data-action="heatmap"]').classList.toggle('active', c.heatmap);
    this.q('[data-action="speedmap"]').classList.toggle('active', c.speedmap);
    this.q('[data-action="chains"]').classList.toggle('active', !this.q('[data-chains]').classList.contains('hidden'));
    this.syncPause();
    this.renderOptions();
    this.renderConfirm();
    if (force) {
      this.renderSide();
      this.renderScenario();
    }
  }

  /** В испытании сценария кнопка паузы неактивна: нажатие только напомнит, что пауза — в меню. */
  private syncPause(): void {
    const pause = this.q<HTMLButtonElement>('[data-action="speed"][data-v="0"]');
    const lock = !!this.game().scenario?.challenge;
    if (pause.classList.contains('locked') === lock) return;
    pause.classList.toggle('locked', lock);
    pause.setAttribute('aria-disabled', String(lock));
    pause.title = lock ? 'Испытание: время не останавливается — пауза только в меню' : SPEEDS[0].title;
  }

  /** Переключатель режима — большие карточки с картинками. */
  /** grid — компактно: кнопки в две колонки, значок слева от названия. */
  /** key — горячая клавиша режима, видна на карточке: в сетке — справа, в большой карточке — рядом с названием, а не лишней строкой. */
  private kindSwitch(title: string, action: string, current: string, items: { id: string; name: string; svg: string; hint: string; key?: string }[], grid = false): string {
    return `<div class="opt-group"><div class="opt-title">${title}</div><div class="cards ${grid ? 'grid2' : ''}">${items
      .map((it) => {
        const kbd = it.key ? `<kbd>${it.key}</kbd>` : '';
        return `<button class="card ${grid ? 'row' : ''} ${current === it.id ? 'active' : ''}" data-action="${action}" data-id="${it.id}" data-tip="${it.key ? `${it.hint} (${it.key})` : it.hint}">
          ${it.svg}<span class="name">${it.name}${grid ? '' : kbd}</span>${grid ? kbd : ''}</button>`;
      })
      .join('')}</div></div>`;
  }

  private renderOptions(): void {
    const c = this.controller;
    const el = this.q('[data-options]');
    const show =
      c.tool === 'road' || c.tool === 'rail' || c.tool === 'station' || c.tool === 'roundabout' || c.tool === 'bulldoze' || c.tool === 'terrain' || c.tool === 'industry';
    el.classList.toggle('hidden', !show);
    if (!show) return;
    const html =
      c.tool === 'industry'
        ? industryOptionsHtml(this.game(), c.industryKind)
        : c.tool === 'station'
        ? this.stationOptionsHtml()
        : c.tool === 'rail'
          ? this.railOptionsHtml()
          : c.tool === 'roundabout'
            ? this.junctionOptionsHtml()
            : c.tool === 'bulldoze'
              ? this.bulldozeOptionsHtml()
              : c.tool === 'terrain'
                ? this.terrainOptionsHtml()
                : this.roadOptionsHtml();
    if (html !== this.lastOptions) {
      // Прокрученная вбок полоса карточек (data-hscroll) остаётся на месте, когда выбрали другую карточку.
      const scroll = el.querySelector<HTMLElement>('[data-hscroll]')?.scrollLeft ?? 0;
      el.innerHTML = html;
      this.lastOptions = html;
      const strip = el.querySelector<HTMLElement>('[data-hscroll]');
      if (strip) strip.scrollLeft = scroll;
    }
  }

  /** Рельеф: поднять, опустить или выровнять кистью; размер кисти. */
  private terrainOptionsHtml(): string {
    const c = this.controller;
    const mode = this.kindSwitch('Кисть', 'terrain-mode', c.terrainMode, [
      { id: 'raise', name: 'Поднять', svg: TERRAIN_SVG.raise, hint: 'Насыпать холм: зажмите и ведите' },
      { id: 'lower', name: 'Опустить', svg: TERRAIN_SVG.lower, hint: 'Срыть склон: ниже уровня воды не копается' },
      { id: 'flatten', name: 'Выровнять', svg: TERRAIN_SVG.flatten, hint: 'Выровнять к высоте там, где нажали — площадка под станцию или путь' },
    ]);
    const sizes = (Object.keys(BRUSH_SIZES) as BrushSize[])
      .map(
        (k) => `<button class="icon-btn ${c.brushSize === k ? 'active' : ''}" data-action="brush-size" data-id="${k}" title="Радиус ${BRUSH_SIZES[k]} м">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="${{ small: 4, medium: 7, large: 10 }[k]}" /></svg><span>${{ small: 'Малая', medium: 'Средняя', large: 'Большая' }[k]}</span></button>`,
      )
      .join('');
    const relief = this.game().terrain.hasRelief;
    const tip = relief
      ? 'Зажмите и ведите — земля меняется, пока кнопка нажата. Цена — за перемещённый грунт. Дороги и пути на склоне становятся дешевле и проходимее. Под предприятиями и станциями нельзя. Ctrl+Z — вернуть.'
      : 'В этом мире нет рельефа: он появляется в новой игре с параметром «Рельеф».';
    return `<div class="opt-row">${mode}<div class="opt-group"><div class="opt-title">Размер</div><div class="icons">${sizes}</div></div>
      <div class="opt-group narrow"><div class="opt-title">Как работать</div><p class="muted">${tip}</p></div></div>`;
  }

  /** Снос: по одному объекту (можно вести мышью) или рамкой. */
  private bulldozeOptionsHtml(): string {
    const c = this.controller;
    const sw = this.kindSwitch('Как сносим', 'bulldoze-mode', c.bulldozeMode, [
      { id: 'point', name: 'По одному', svg: bulldozePointSvg(), hint: 'Клик по дороге, дому или станции; можно вести мышью' },
      { id: 'area', name: 'Рамкой', svg: bulldozeAreaSvg(), hint: 'Растяните рамку — снесётся всё внутри' },
      { id: 'lane', name: 'Полосу', svg: bulldozeLaneSvg(), hint: 'Клик по крайней полосе — уберётся её участок до стыков (и съезд от него); Shift и протянуть — кусок' },
    ]);
    const tip =
      c.bulldozeMode === 'area'
        ? 'Зажмите и растяните рамку: красным подсветится всё, что снесётся. Если объектов много или есть станция — спросим. Ратуша и станции с маршрутами не сносятся. Ctrl+Z — вернуть.'
        : c.bulldozeMode === 'lane'
          ? 'Клик по крайней полосе дороги — она уберётся (вместе с продолжениями через стыки); съезд или въезд, куда она уходит, снесётся целиком. Shift и протяжка вдоль — только кусок полосы. Ctrl+Z — вернуть.'
          : 'Клик — снести дорогу, дом, станцию или базу стройки. Зажмите и ведите — сносится всё под курсором. Shift и протяжка вдоль дороги — только кусок между точками. Ctrl+Z — вернуть.';
    return `<div class="opt-row">${sw}<div class="opt-group narrow"><div class="opt-title">Как сносить</div><p class="muted">${tip}</p></div></div>`;
  }

  /** Окно «точно снести?» для большой рамки или «удалить шаблон?». */
  private renderConfirm(): void {
    const el = this.q('[data-confirm]');
    const tpl = this.deletingTemplate ? listTemplates().find((t) => t.id === this.deletingTemplate) : undefined;
    if (this.deletingTemplate && !tpl) this.deletingTemplate = null;
    if (tpl) {
      el.classList.remove('hidden');
      const html = `<div class="modal menu confirm">
          <button class="icon modal-close" data-action="tpl-del-no" title="Отмена (Esc)">✕</button>
          <h2>Удалить шаблон?</h2>
          <div class="confirm-tpl">${fragmentSvg(tpl.fragment, 120, 90)}<b>${esc(tpl.name)}</b></div>
          <p class="muted">Построенные по нему развязки останутся на карте — пропадёт только сам шаблон.</p>
          <div class="menu-buttons">
            <button class="secondary" data-action="tpl-del-no">Отмена</button>
            <button class="primary danger-fill" data-action="tpl-del-yes">Удалить</button>
          </div>
        </div>`;
      if (html !== this.lastConfirm) {
        el.innerHTML = html;
        this.lastConfirm = html;
      }
      return;
    }
    const p = this.controller.pendingArea;
    el.classList.toggle('hidden', !p);
    if (!p) {
      this.lastConfirm = '';
      return;
    }
    const c = p.contents;
    const chip = (icon: string, n: number, title: string) =>
      n ? `<span class="confirm-chip" title="${title}">${icon}<b>${n}</b></span>` : '';
    const html = `<div class="modal menu confirm">
        <button class="icon modal-close" data-action="area-cancel" title="Отмена (Esc)">✕</button>
        <h2>Снести всё в рамке?</h2>
        <div class="confirm-chips">
          ${chip(roadSvg({ cls: 'street', lanesF: 1, lanesB: 1 }, 40, 18), c.segs.length, 'Участки дорог и путей')}
          ${chip('🏠', c.buildings.length, 'Дома')}
          ${chip(stationSvg('road', 24), c.stations.length, 'Станции')}
        </div>
        <p class="muted">Вернём за дороги ${money(c.refund)}${c.cost ? `, снос домов стоит ${money(c.cost)}` : ''}. Отменить можно Ctrl+Z.</p>
        <div class="menu-buttons">
          <button class="secondary" data-action="area-cancel">Отмена</button>
          <button class="primary danger-fill" data-action="area-confirm">Снести</button>
        </div>
      </div>`;
    if (html !== this.lastConfirm) {
      el.innerHTML = html;
      this.lastConfirm = html;
    }
  }

  /** Форма и высота — общие для дорог и путей. */
  private shapeHtml(): string {
    const c = this.controller;
    // «Проект» — переключатель в заголовке «Формы» и плашка над панелью: панель не шире и не выше, чем без него.
    return `${this.projectBarHtml()}<div class="opt-group"><div class="opt-title">Форма <kbd>Q</kbd>${this.projectChipHtml()}</div><div class="icons">${DRAW_MODES.map(
      (m) => `<button class="icon-btn ${c.drawMode === m.id ? 'active' : ''}" data-action="mode" data-id="${m.id}" title="${MODE_HINTS[m.id]}">
        ${modeSvg(m.id)}<span>${m.name}</span></button>`,
    ).join('')}</div></div>
    <div class="opt-group"><div class="opt-title" title="−/+ — конец дороги на 2 м выше или ниже начала («Авто»), [ ] — тоннель, земля, мост">Высота <kbd>−</kbd><kbd>+</kbd></div><div class="icons">${
      c.netKind === 'road'
        ? `<button class="icon-btn ${c.autoLevel ? 'active' : ''}" data-action="level" data-v="auto" title="Авто: дорога по земле, а где круто — мост или тоннель сам. −/+ — конец выше или ниже начала: если так конец отходит от земли больше чем на 6 м — мост или тоннель, иначе конец остаётся на земле">
        ${AUTO_LEVEL_SVG}<span>Авто${c.autoLevel && c.roadTools.rise !== null ? ` ${c.roadTools.rise > 0 ? '+' : ''}${c.roadTools.rise} м` : ''}</span></button>`
        : ''
    }${LEVELS.filter((l) => l.level <= 1).map(
      (l) => `<button class="icon-btn ${!c.autoLevel && c.level === l.level ? 'active' : ''}" data-action="level" data-v="${l.level}" title="${LEVEL_HINTS[l.level]}">
        ${levelSvg(l.level)}<span>${l.name}${LEVEL_COST[l.level] ? ` ×${LEVEL_COST[l.level]}` : ''}</span></button>`,
    ).join('')}</div></div>`;
  }

  /** Переключатель «Проект» — значок с подписью в строке заголовка «Формы» (не занимает места в панели). */
  private projectChipHtml(): string {
    const c = this.controller;
    const rail = c.netKind === 'rail';
    const hint =
      c.tool === 'road' && c.roadMode === 'move'
        ? 'Проект (P): сначала спроектировать перенос — тяните узлы, перья и середины сколько угодно, дорога пока как есть; потом построить разом'
        : c.tool === 'road' && c.roadMode === 'lane'
          ? 'Проект (P): сначала спланировать полосы, съезды и въезды — сколько угодно, дорога пока как есть; потом построить разом'
          : `Проект (P): нарисовать ${rail ? 'пути' : 'дорогу'} целиком, настроить узлы и перья, потом построить разом. Пока не построен — бесплатно`;
    // Проект дорог один на «Строить», «Двигать» и «Полосу»: смена режима его не выключает.
    const shared = rail ? '' : '. Проект общий: в «Строить», «Двигать» и «Полосе» — те же участки и правки, смена режима его не выключает';
    return `<button class="opt-chip ${c.projectOn ? 'active' : ''}" data-action="project" title="${hint}${shared}">
      ${projectSvg(20, 15)}<span>Проект</span><kbd>P</kbd></button>`;
  }

  /**
   * Проект включён — плашка над панелью, одной строкой: сколько участков и метров, цена, что не так,
   * «Построить» и «Отменить»; пустой — как рисовать (подробности — в title).
   */
  private projectBarHtml(): string {
    const c = this.controller;
    // Проект дорог — общий у «Строить», «Двигать» и «Полосы»: одна плашка, те же участки и правки в любом из них.
    const kept = c.projectKept;
    if (!c.projectOn && !kept) return '';
    const { segs, edits, plan } = c.projectSummary();
    // Что в проекте: новые участки и правки построенных дорог.
    const parts = [segs ? `${segs} уч. · ${Math.round(plan.length)} м` : '', edits ? `${edits} ${edits === 1 ? 'правка' : edits < 5 ? 'правки' : 'правок'} дорог` : ''].filter(Boolean).join(' · ');
    if (kept) {
      // «Перестроить» в проект не входит: строит сразу, а проект ждёт (не пропал).
      const hint = 'Перестройка в проект не входит — клик по дороге перестраивает её сразу. Проект сохранён: N, M, L или P — вернуться к нему';
      const what = parts ? `${parts} — сохранён` : 'пуст';
      return `<div class="project-bar" title="${hint}">${projectSvg(30, 22)}<b>Проект</b><span class="muted">${what} · «Перестроить» — вне проекта · N, M, L — к проекту</span></div>`;
    }
    if (!segs && !edits) {
      const mode = c.tool === 'road' ? c.roadMode : 'build';
      const hint =
        mode === 'move'
          ? 'Тяните узлы, перья и середины дорог — перенос рисуется проектом, а дорога остаётся как есть. Тот же проект — в «Строить» и «Полосе». Ctrl+Z — шаг назад, Ctrl+Y — вперёд, Enter — построить'
          : mode === 'lane'
            ? 'Тяните полосы, съезды и въезды или кликайте по точкам — они рисуются проектом, а дорога остаётся как есть. Тот же проект — в «Строить» и «Двигать». Ctrl+Z — шаг назад, Ctrl+Y — вперёд, Enter — построить'
            : 'Кликайте по точкам — участки рисуются, но не строятся и не стоят денег. Узлы (квадраты) и перья тяните мышью, середину участка — выгнуть, клик по ней — новый узел. Построенную дорогу тоже можно тянуть — её правка войдёт в проект. Delete — убрать узел, Ctrl+Z — шаг назад, Ctrl+Y — вперёд, Enter — построить';
      const what = mode === 'move' ? 'тяните узлы и перья · дорога пока как есть' : mode === 'lane' ? 'тяните полосы и съезды · дорога пока как есть' : 'кликайте по точкам · узлы и перья — тянуть';
      return `<div class="project-bar" title="${hint}">${projectSvg(30, 22)}<b>Проект</b><span class="muted">${what} · Enter — построить</span></div>`;
    }
    const raze = plan.demolish.length ? ` · снос ${plan.demolish.length} зд.` : '';
    const reason = esc(plan.reason ?? 'Так не построить');
    // Невалидное в проекте рисуется и правится, но построить — только исправленное.
    const why = plan.ok ? '' : `<span class="project-why" title="Сначала исправьте: ${reason}">⚠ Сначала исправьте: ${reason}</span>`;
    // Перенос или укороченная полоса бывает дешевле, чем было, — тогда возврат, с плюсом.
    // «Со строительством» — цена всего проекта и сколько строить (платится по готовым метрам).
    const price = plan.road?.project ? planPrice({ cost: plan.cost, project: plan.road.project }) : plan.cost < 0 ? `+${money(-plan.cost)}` : money(plan.cost);
    // Проект дороже свободных денег — строить можно (платится по готовым метрам), но жёлтым: пойдёт по мере денег.
    const short = plan.ok && plan.road?.project ? projectMoneyWarning({ cost: plan.cost, project: plan.road.project }, this.game().budget) : null;
    const warn = short ? `<span class="project-short" data-tip="Проект дороже свободных денег: заложить можно — стройка платит за готовые метры и встаёт, пока денег нет">${short}</span>` : '';
    return `<div class="project-bar">${projectSvg(30, 22)}<b>Проект</b><span class="muted">${parts}${raze}</span>
      <b class="project-total ${plan.ok ? (short ? 'warn' : '') : 'bad'}">${price}</b>${why}${warn}
      <button class="primary small" data-action="project-build" ${plan.ok ? '' : 'disabled'} title="${plan.ok ? 'Построить весь проект — новые участки и правки дорог (Enter). Ctrl+Z — отменить стройку' : `Сначала исправьте: ${reason}`}">Построить</button>
      <button class="small" data-action="project-cancel" title="Стереть проект — и участки, и правки дорог (Ctrl+Z вернёт)">Отменить</button></div>`;
  }

  /** Развязки: кольцо на перекрёстке, готовый или свой шаблон, копия куска дорог. */
  private junctionOptionsHtml(): string {
    const c = this.controller;
    const sw = this.kindSwitch('Что ставим', 'junction-mode', c.junctionMode, [
      { id: 'ring', name: 'Кольцо', svg: ringSvg(0.5, 1), hint: 'Кольцо на месте перекрёстка' },
      { id: 'template', name: 'Шаблон', svg: diamondSvg(48, 36), hint: 'Готовая или своя развязка в один клик' },
      { id: 'copy', name: 'Копия', svg: copySvg(48, 36), hint: 'Скопировать дороги рамкой и вставить с поворотом' },
    ]);
    if (c.junctionMode === 'template') {
      const own = !!c.userTemplate;
      const cards = TEMPLATES.map(
        (t) => `<button class="card ${!own && c.templateKind === t.id ? 'active' : ''}" data-action="template-kind" data-id="${t.id}" title="${t.hint}">
          ${templateSvg(t.id, 64, 48)}<span class="name">${t.name}</span><small>${t.short}</small></button>`,
      ).join('');
      // Свои шаблоны: с путями — со значком пути; у каждого — скачать файлом и удалить.
      const mine = listTemplates()
        .map((t) => {
          const rail = hasRail(t.fragment);
          return `<div class="card user-tpl ${c.userTemplate === t.id ? 'active' : ''}" data-action="user-template" data-id="${t.id}" title="Свой шаблон «${esc(t.name)}»${rail ? ' — с ж/д путями' : ''}">
            ${fragmentSvg(t.fragment, 64, 48)}<span class="name">${esc(t.name)}</span>
            ${rail ? `<span class="tpl-rail" title="С ж/д путями">${railBadgeSvg()}</span>` : ''}
            <button class="icon tpl-dl" data-action="user-template-dl" data-id="${t.id}" title="Скачать шаблон файлом">${downloadSvg(14)}</button>
            <button class="icon tpl-del" data-action="user-template-del" data-id="${t.id}" title="Удалить шаблон">✕</button></div>`;
        })
        .join('');
      // Файлы: все свои — одним файлом; открыть шаблоны из файла (добавятся к своим).
      const files = `<span class="tpl-files">${mine ? `<button class="icon" data-action="templates-dl-all" title="Скачать все свои шаблоны одним файлом">${downloadAllSvg(16)}</button>` : ''}
        <label class="icon file-pick tpl-open" title="Открыть шаблоны из файла — добавятся к своим">${uploadSvg(15)}<input type="file" accept=".json,.gz,application/json,application/gzip" data-import-templates /></label></span>`;
      const ownGroup = mine
        ? `<div class="opt-group"><div class="opt-title">Свои ${files}</div><div class="cards">${mine}</div></div>`
        : `<div class="opt-group narrow"><div class="opt-title">Свои ${files}</div><p class="muted">Скопируйте удачную развязку (режим «Копия») и сохраните её шаблоном — она появится здесь.</p></div>`;
      const tip = own
        ? 'Клик — поставить. Повернуть: R — на 15°, Shift+колесо или протяжка — на любой угол. На дороге того же класса или на пути ложится вдоль (Alt — нет), дороги и пути под рамкой заменяются.'
        : 'Наведите на прямой участок магистрали — или в чистое поле: тогда магистраль построится вместе с развязкой (R — повернуть). Для магистрали берётся выбранный тип дороги, если это магистраль. Концы дорог подключите к своей сети. Не понравилось — Ctrl+Z.';
      return `<div class="opt-row">${sw}<div class="opt-group"><div class="opt-title">Шаблон</div><div class="cards">${cards}</div></div>${ownGroup}
        <div class="opt-group narrow"><div class="opt-title">Как ставить <kbd>R</kbd></div><p class="muted">${tip}</p></div></div>`;
    }
    if (c.junctionMode === 'copy') return this.copyOptionsHtml(sw);
    return this.ringOptionsHtml(sw);
  }

  /** Копия: рамкой — что скопировать; скопированное — схемой, поворотом и кнопкой «в шаблоны». */
  private copyOptionsHtml(sw: string): string {
    const frag = this.controller.clipboard;
    if (!frag) {
      return `<div class="opt-row">${sw}<div class="opt-group narrow"><div class="opt-title">Как копировать</div>
        <p class="muted">Зажмите и растяните рамку: синим подсветится, что попадёт в копию. Дороги и ж/д пути режутся по рамке, кольца берутся целиком, настройки перекрёстков, стрелки, мосты и сигналы — вместе с ними.</p></div></div>`;
    }
    const rail = frag.rail?.segs.length ?? 0;
    return `<div class="opt-row">${sw}
      <div class="opt-group"><div class="opt-title">Скопировано</div><div class="cards"><div class="card active user-tpl">${fragmentSvg(frag, 64, 48)}<span class="name">${frag.corridors.length + rail} уч.</span>${rail ? `<span class="tpl-rail" title="С ж/д путями">${railBadgeSvg()}</span>` : ''}</div></div></div>
      <div class="opt-group"><div class="opt-title">Поворот <kbd>R</kbd></div><div class="icons">
        <button class="icon-btn" data-action="paste-rotate" data-v="-1" title="На 15° против часовой (Shift+R)">↺<span>−15°</span></button>
        <button class="icon-btn" data-action="paste-rotate" data-v="1" title="На 15° по часовой (R)">↻<span>+15°</span></button>
        <button class="icon-btn" data-action="clipboard-clear" title="Скопировать другое (Esc)">${copySvg(30, 22)}<span>Новая рамка</span></button>
      </div></div>
      <div class="opt-group"><div class="opt-title">В свои шаблоны</div><div class="save-new"><input class="line-name" data-template-name maxlength="30" placeholder="Моя развязка" />
        <button class="small" data-action="template-save">Сохранить</button></div>
        <button class="small with-ic tpl-save-file" data-action="template-save-file" title="Скачать скопированное файлом шаблона — открывается в «Шаблон» кнопкой «Открыть из файла»">${downloadSvg(15)}Сохранить в файл</button></div>
      <div class="opt-group narrow"><div class="opt-title">Как вставлять</div><p class="muted">Клик — вставить (хоть много раз). Повернуть на любой угол — Shift+колесо или протяжка от точки вставки. На дороге того же класса или на пути ложится вдоль (Alt — нет), дороги и пути под рамкой заменяются.</p></div></div>`;
  }

  /** Скопированное — в свои шаблоны под именем из поля. */
  private saveUserTemplate(): void {
    const input = this.q<HTMLInputElement>('[data-template-name]');
    const name = input?.value.trim() || 'Моя развязка';
    if (!this.controller.saveClipboard(name)) {
      this.game().notify('Не хватило места для шаблона');
      return;
    }
    if (input) input.value = '';
    this.game().notify(`Шаблон «${name}» сохранён — он в разделе «Шаблон»`);
  }

  /** Скопированное — файлом шаблона под именем из поля (пусто — «Моя развязка»); в свои не добавляется. */
  private saveClipboardFile(): void {
    const frag = this.controller.clipboard;
    if (!frag) return;
    const { fileName, text } = fragmentToFile(this.q<HTMLInputElement>('[data-template-name]')?.value ?? '', frag);
    downloadText(fileName, text);
  }

  /**
   * Шаблоны из файла — к своим (занятое имя — с суффиксом); битый или чужой файл — уведомлением. Один шаблон сразу
   * выбран. Файл может быть и в gzip: так доска задач отдаёт схему участка из баг-репорта («…-area.json.gz»).
   */
  private async importTemplates(file: File): Promise<void> {
    const g = this.game();
    const bad = (text: string) => g.notify(text, '#e5534b');
    if (file.size > 20 * 1024 * 1024) return bad('Слишком большой файл для шаблонов');
    const text = await saveFileText(file).catch(() => null);
    if (text === null) return bad('Файл не прочитать');
    const parsed = parseTemplateFile(text);
    if ('error' in parsed) return bad(parsed.error);
    const added = addTemplates(parsed.templates);
    if (!added) return bad('Не хватило места для шаблонов');
    const skipped = parsed.skipped ? ` · битых пропущено: ${parsed.skipped}` : '';
    g.notify(added.length === 1 ? `Шаблон «${added[0].name}» добавлен в свои${skipped}` : `Шаблонов добавлено в свои: ${added.length}${skipped}`);
    if (added.length === 1) this.controller.setUserTemplate(added[0].id);
    else this.controller.setJunctionMode('template');
  }

  /** Кольцо: число полос и размер — картинками. */
  private ringOptionsHtml(sw: string): string {
    const c = this.controller;
    const sizes: { id: RingSize; name: string; k: number }[] = [
      { id: 'small', name: 'Малое', k: 0 },
      { id: 'medium', name: 'Среднее', k: 0.5 },
      { id: 'large', name: 'Большое', k: 1 },
    ];
    const lanes = [1, 2, 3]
      .map(
        (n) => `<button class="icon-btn ${c.ring.lanes === n ? 'active' : ''}" data-action="ring-lanes" data-v="${n}" title="${n} ${n === 1 ? 'полоса' : 'полосы'} по кольцу">
          ${ringSvg(0.5, n)}<span>${n} ${n === 1 ? 'полоса' : 'полосы'}</span></button>`,
      )
      .join('');
    const size = sizes
      .map(
        (s) => `<button class="icon-btn ${c.ring.size === s.id ? 'active' : ''}" data-action="ring-size" data-id="${s.id}" title="${s.name} кольцо: больше места для въездов и машин">
          ${ringSvg(s.k, c.ring.lanes)}<span>${s.name}</span></button>`,
      )
      .join('');
    return `<div class="opt-row">${sw}<div class="opt-group"><div class="opt-title">Полосы кольца</div><div class="icons">${lanes}</div></div>
      <div class="opt-group"><div class="opt-title">Размер</div><div class="icons">${size}</div></div>
      <div class="opt-group narrow"><div class="opt-title">Как ставить</div><p class="muted">Кликните по перекрёстку — он станет кольцом с выбранным числом полос. Если примыкают широкие дороги, кольцо будет больше.</p></div></div>`;
  }

  /** Ж/д станция — одинаково в инструментах «Ж/д» и «Станция»: платформы, с чем работает, как ставить. */
  private railStationOptionsHtml(sw: string): string {
    const c = this.controller;
    const n = c.stationTracks;
    // Сколько путей с платформами — счётчиком «− N +» со схемой, как посты погрузки у автостанции.
    const tracks = `<span class="stepper bays tracks" title="Путей с платформами: ${n}">
      <button data-action="st-tracks" data-d="-1" ${n > RAIL_STATION.minTracks ? '' : 'disabled'} title="Меньше путей">−</button><b>${platformsSvg(n)}<span>${n}</span></b><button
        data-action="st-tracks" data-d="1" ${n < RAIL_STATION.maxTracks ? '' : 'disabled'} title="Больше путей">+</button></span>`;
    // Длина платформ — тоже счётчиком: схема с вагонами и метры; рядом — два значка: сколько пассажирских
    // и сколько грузовых вагонов встанет (тот же предел, что у состава в карточке поезда).
    const L = c.stationLength;
    const fit = platformCars(L);
    const length = `<span class="stepper bays tracks" title="Длина платформ: ${L} м">
      <button data-action="st-length" data-d="-1" ${L > RAIL_STATION.minLength ? '' : 'disabled'} title="Короче на ${RAIL_STATION.lengthStep} м">−</button><b>${platformLengthSvg(L, RAIL_STATION.maxLength)}<span>${L} м</span></b><button
        data-action="st-length" data-d="1" ${L < RAIL_STATION.maxLength ? '' : 'disabled'} title="Длиннее на ${RAIL_STATION.lengthStep} м">+</button></span>`;
    const cars = `<span class="cars-fit"><span class="car pax" title="Пассажирских вагонов встанет: ${fit.passenger}">${passengerCarSvg(20)}<b>${fit.passenger}</b></span><span
      class="car freight" title="Грузовых вагонов встанет: ${fit.freight}">${freightCarSvg(20)}<b>${fit.freight}</b></span></span>`;
    const params = `<div class="st-params"><span class="lbl3">Пути</span>${tracks}
      <span class="lbl3">Длина</span><span class="st-len">${length}${cars}</span></div>`;
    // Проходная или конечная — двумя значками-схемами прямо в заголовке: панель не становится выше.
    const end = c.stationTerminal;
    const kind = `<span class="st-kind">${[
      { on: false, svg: throughStationSvg(30), hint: 'Проходная: пути насквозь, поезда идут дальше' },
      { on: true, svg: terminalStationSvg(30), hint: 'Конечная (тупиковая): пути кончаются упорами, поезд разворачивается и уходит обратно' },
    ]
      .map((k) => `<button class="${end === k.on ? 'active' : ''}" data-action="st-terminal" data-v="${k.on ? 1 : 0}" title="${k.hint}">${k.svg}</button>`)
      .join('')}</span>`;
    // Как ставить — строкой правил под настройками, цена — в заголовке платформ (как у дороги): панель низкая и не уходит под миникарту.
    return `<div class="opt-row">${sw}<div class="opt-group"><div class="opt-title">Платформы <span class="price-tag">от ${money(railStationFee(n, L))}</span>${kind}</div>${params}</div>
      <div class="opt-group"><div class="opt-title">Работает с</div>${this.servesHtml(c.stationServes, 'new-serves')}</div></div>
      ${railRules(
        [
          end
            ? { svg: terminalStationSvg(32), text: 'У тупика пути или в поле — пути кончатся упорами', hint: 'Подведите к концу пути: платформы дойдут до тупика, там встанут упоры. В чистом поле путь с горловиной построится сам — его свободный конец подключите к своей линии' }
            : { svg: railSvg(40, 20), text: 'На прямом пути или в поле — путь построится сам', hint: 'Ставьте на прямой участок пути или в чистом поле — тогда путь построится вместе со станцией' },
          end
            ? { svg: '⇄', text: 'Поезд разворачивается и уходит обратно', hint: 'Поезд въезжает до упора, а уезжает в обратную сторону: локомотив — с другой стороны. Удобно в конце линии' }
            : n === 1
              ? { svg: platformsSvg(1), text: 'Один путь — встречные здесь не разъедутся', hint: 'Платформа прямо на главном пути: поезда встают по одному, встречному негде разъехаться — для промежуточной остановки или маршрута с одним поездом' }
              : { svg: platformsSvg(2), text: 'Пути с платформами — поезда разъезжаются', hint: 'Рядом будут пути с платформами, чтобы поезда разъезжались' },
          { svg: '↻', text: `<kbd>R</kbd> — повернуть · охват ${RAIL_STATION.catchment} м`, hint: `R — повернуть. Охват ${RAIL_STATION.catchment} м` },
        ],
        true,
      )}`;
  }

  /** Отдельный инструмент «Ж/д»: путь или вокзал. */
  private railOptionsHtml(): string {
    const c = this.controller;
    const sw = this.kindSwitch('Что строим', 'rail-mode', c.railMode, [
      { id: 'track', name: 'Путь', svg: railSvg(76, 34), hint: 'Ж/д путь: прямые, дуги, мосты и тоннели', key: 'N' },
      { id: 'parallel', name: 'Пристроить', svg: tracksSvg(2, true), hint: 'Зажмите на пути и тяните вдоль: рядом ляжет второй путь' },
      { id: 'station', name: 'Станция', svg: stationSvg('rail', 34), hint: 'Ж/д станция с двумя платформами: на пути или в чистом поле' },
      { id: 'signal', name: 'Сигнал', svg: signalSvg(), hint: 'Делит путь на блоки: несколько поездов едут друг за другом' },
      { id: 'move', name: 'Двигать', svg: trackMoveSvg('node'), hint: 'Тяните узел — пути следом; середину пути — выгнуть; перо — угол в узле', key: 'M' },
    ]);
    if (c.railMode === 'move') {
      // Что можно тянуть — картинками: узел, тупик, середину и перо; станция стоит на месте.
      const what = [
        { svg: trackMoveSvg('node'), name: 'Узел', small: 'пути следом' },
        { svg: trackMoveSvg('end'), name: 'Тупик', small: 'увести конец' },
        { svg: trackMoveSvg('bend'), name: 'Середина', small: 'выгнуть' },
        { svg: trackMoveSvg('handle'), name: 'Перо', small: 'угол в узле' },
      ]
        .map((x) => `<div class="card">${x.svg}<span class="name">${x.name}</span><small>${x.small}</small></div>`)
        .join('');
      // Правила — строкой под карточками: справа им не хватает места до миникарты.
      return `<div class="opt-row">${sw}<div class="opt-group"><div class="opt-title">Что тянуть</div><div class="cards">${what}</div></div></div>
        ${railRules(
          [
            { svg: switchSvg(), text: 'В стрелке и стыке пути поворачивают вместе, <kbd>Shift</kbd> — только этот', hint: 'В стрелке и стыке пути поворачивают вместе, Shift — только этот' },
            { svg: stationSvg('rail', 22), text: 'Станция и её стрелки стоят на месте', hint: 'Станция и её стрелки стоят на месте' },
          ],
          true,
        )}`;
    }
    if (c.railMode === 'signal') {
      // Тип сигнала картинкой: обычный (блок в обе стороны) или без встречного — со знаком «въезд запрещён».
      const kind = [
        { on: false, svg: signalSvg(), name: 'Обычный', hint: 'Делит путь на блоки; поезда ездят мимо в обе стороны' },
        { on: true, svg: oneWaySignalSvg(), name: 'Без встречного', hint: 'Поезда едут мимо только по стрелке, навстречу маршрут не проложат (как в Transport Fever)' },
      ]
        .map(
          (k) => `<button class="icon-btn ${c.signalOneWay === k.on ? 'active' : ''}" data-action="signal-oneway" data-v="${k.on ? 1 : 0}" title="${k.hint}">
          ${k.svg}<span>${k.name}</span></button>`,
        )
        .join('');
      return `<div class="opt-row">${sw}<div class="opt-group"><div class="opt-title">Сигнал <span class="price-tag">${money(COST.signal)} за штуку</span></div><div class="icons">${kind}</div></div>
        <div class="opt-group"><div class="opt-title">Как ставить сигналы</div>${railRules([
          { svg: signalSvg(), text: 'Клик у пути — сигнал, ещё клик — снять', hint: 'Клик рядом с путём: сигнал встанет для поездов, у которых курсор справа по ходу. Повторный клик — снять' },
          { svg: railSvg(40, 20), text: 'Блок — путь до следующего сигнала', hint: 'Без сигналов поезд занимает весь путь до станции. С сигналами — только участок до следующего сигнала' },
          { svg: oneWaySignalSvg(), text: 'Двухпутка — сигналы без встречного', hint: 'Двухпутка: на каждом пути сигналы без встречного в его сторону — поезда сами выберут свой путь' },
          { svg: '⚠️', text: 'Однопутка — обычные в одну сторону', hint: 'На однопутке обычные сигналы ставьте только в одну сторону — иначе встречные поезда могут упереться друг в друга' },
        ])}</div></div>`;
    }
    if (c.railMode === 'station') return this.railStationOptionsHtml(sw);
    if (c.railMode === 'parallel') {
      return `<div class="opt-row">${sw}<div class="opt-group"><div class="opt-title">Пристроить путь</div>${railRules([
        { svg: tracksSvg(2, true), text: 'Зажмите на пути и тяните вдоль — рядом ляжет второй', hint: 'Зажмите на пути и тяните вдоль него — рядом, со стороны курсора, ляжет второй путь до точки, где отпустите' },
        { svg: switchSvg(), text: 'Путь — до ближайшей стрелки, соединить — стрелкой', hint: 'Путь идёт по участкам до ближайшей стрелки. Соединить пути — стрелкой, инструментом «Путь»' },
      ])}</div></div>`;
    }
    // Как у дороги — два низких ряда, не шире миникарты: режим и правила пути, под ними настройки (путей с ценой, форма, высота).
    const rules = `<div class="opt-group"><div class="opt-title">Ж/д путь · ${speedSign(specKmh(RAIL_SPEC), 16)}</div>${railRules([
      { svg: railSvg(40, 20), text: 'Один путь — поезда ходят по очереди', hint: 'Один путь — поезда ходят по очереди, автоблокировка не пустит встречный' },
      { svg: tracksSvg(2, true), text: 'Начните сбоку от пути — второй рядом', hint: 'Начните сбоку от пути — второй ляжет рядом' },
      { svg: switchSvg(), text: 'Ответвление — только плавной стрелкой', hint: 'Ответвление — только плавной стрелкой, под небольшим углом' },
      { svg: crossingSvg(), text: 'Переезд с дорогой — под углом от 30°', hint: 'Переезд с дорогой — под углом от 30°, шлагбаум закрывается перед поездом' },
    ])}</div>`;
    // Сколько путей класть сразу: один или два рядом (ось — по курсору).
    const count = [1, 2]
      .map(
        (n) => `<button class="icon-btn ${c.railTracks === n ? 'active' : ''}" data-action="rail-tracks" data-v="${n}" title="${n === 1 ? 'Один путь' : 'Два пути рядом: курсор — ось между ними'}">
          ${tracksSvg(n)}<span>${n === 1 ? '1 путь' : '2 пути'}</span></button>`,
      )
      .join('');
    return `<div class="opt-row">${sw}${rules}</div>
      <div class="opt-row"><div class="opt-group"><div class="opt-title">Путей <span class="price-tag">≈ ${money(specCost(RAIL_SPEC) * 100)} за 100 м</span></div><div class="icons">${count}</div></div>${this.shapeHtml()}</div>`;
  }

  /** «Работает с»: пассажиры и/или груз — две карточки-переключателя. */
  private servesHtml(serves: StationServes, action: string, id = ''): string {
    const card = (what: 'pax' | 'cargo', icon: string, name: string, hint: string) =>
      `<button class="card ${serves[what] ? 'active' : ''}" data-action="${action}" data-what="${what}" data-id="${id}" title="${hint}">
        ${icon}<span class="name">${name}</span></button>`;
    return `<div class="cards serves">${card('pax', cargoIcon('passengers', 28), 'Пассажиры', 'Жители садятся и выходят здесь')}${card(
      'cargo',
      cargoIcon('goods', 28),
      'Груз',
      'Грузы предприятий и поставки в город',
    )}</div>`;
  }

  private stationOptionsHtml(): string {
    const c = this.controller;
    const g = this.game();
    // «Со строительством» — ещё и строительная база (как «＋ База» на вкладке «Стройка»).
    const base = g.buildMode
      ? [{ id: 'base', name: 'База стройки', svg: baseSvg(34, 26), hint: 'Строительная база у дороги: с неё бригады едут строить. Цена — справа' }]
      : [];
    const sw = this.kindSwitch(
      'Что ставим',
      'station-mode',
      c.placingBase ? 'base' : c.stationMode,
      [
        { id: 'cargo', name: 'Автостанция', svg: stationSvg('cargo', 34), hint: 'Для грузов: грузовики, заезд и посты погрузки' },
        { id: 'pax', name: 'Автовокзал', svg: stationSvg('pax', 34), hint: 'Для пассажиров: междугородние и городские автобусы' },
        { id: 'stop', name: 'Остановка', svg: stationSvg('stop', 34), hint: 'Автобусная остановка прямо на улице — для маршрутов по городу' },
        { id: 'rail', name: 'Ж/д станция', svg: stationSvg('rail', 34), hint: 'Вокзал с платформами: на пути или в чистом поле (как в инструменте «Ж/д»)' },
        ...base,
      ],
      true,
    );
    if (c.placingBase) {
      const tip = `База встаёт у дороги со стороны курсора, ворота — на ближайший узел. С неё бригады едут строить: сами — на стройки ближе ${distText(CONSTRUCTION.serviceRadius)} (круг на карте). Дома под площадкой снесём (красные) — за доплату.`;
      return `<div class="opt-row">${sw}<div class="opt-group narrow"><div class="opt-title">Как ставить</div><p class="muted">${tip}</p>
        <div class="base-prices">${basePriceHtml(g)}</div></div></div>`;
    }
    if (c.stationMode === 'stop') {
      const tip = `Остановка встаёт у края улицы со стороны курсора: автобусы останавливаются прямо в полосе. Только пассажиры, охват ${STOP.catchment} м, ${STOP.bays} места для автобусов. Не ближе ${STOP.gap} м к перекрёстку. В маршруте её можно смешивать с автовокзалами.`;
      return `<div class="opt-row">${sw}<div class="opt-group narrow"><div class="opt-title">Как ставить</div><p class="muted">${tip}</p>
        <div class="price">${money(STOP.cost)}</div></div></div>`;
    }
    if (c.stationMode === 'rail') return this.railStationOptionsHtml(sw);
    const pax = c.stationMode === 'pax';
    const side = c.stationSide;
    // Как ставить — двумя значками-схемами в заголовке: в конце выезда или вдоль дороги с карманом.
    const how = `<span class="st-kind">${[
      { on: false, svg: stationPlaceSvg('end', 30), hint: 'В конце выезда: от дороги к станции — выезд-тупик, его длину выбираете' },
      { on: true, svg: stationPlaceSvg('side', 30), hint: 'Вдоль дороги: у края улицы — карман, посты выходят прямо на него; машины не разворачиваются, а едут дальше' },
    ]
      .map((k) => `<button class="${side === k.on ? 'active' : ''}" data-action="st-side" data-v="${k.on ? 1 : 0}" data-tip="${k.hint}">${k.svg}</button>`)
      .join('')}</span>`;
    // Длина выезда — счётчиком «− схема N м +», как длина платформ у ж/д станции.
    const R = STATION.drivewayRange;
    const L = c.stationDriveway;
    const length = side
      ? ''
      : `<div class="st-params"><span class="lbl3">Выезд</span><span class="stepper bays tracks" data-tip="Длина выезда от кромки дороги: ${L} м · [ и ] — короче и длиннее">
      <button data-action="st-driveway" data-d="-1" ${L > R.min ? '' : 'disabled'} data-tip="Короче на ${R.step} м · [">−</button><b>${drivewaySvg(L, R.max)}<span>${L} м</span></b><button
        data-action="st-driveway" data-d="1" ${L < R.max ? '' : 'disabled'} data-tip="Длиннее на ${R.step} м · ]">+</button></span></div>`;
    const where = side
      ? `вдоль улицы со стороны курсора, не у перекрёстка; у края — карман`
      : `у дороги, прямо у перекрёстка или вплотную к ${pax ? 'городу' : 'предприятию'} — с той стороны, где курсор`;
    const tip = `${pax ? 'Автовокзал' : 'Автостанция'} ${where}. Дома под ней снесём (красные). Охват ${STATION.catchment} м, ${pax ? 'перроны' : 'посты'} добавляются в карточке.`;
    return `<div class="opt-row">${sw}<div class="opt-group narrow"><div class="opt-title">Как ставить${how}</div>${length}<p class="muted">${tip}</p>
      <div class="price">${money(COST.station)}</div></div></div>`;
  }

  private roadOptionsHtml(): string {
    const c = this.controller;
    const s = c.spec;
    const sw = this.kindSwitch('Действие', 'road-mode', c.roadMode, [
      { id: 'build', name: 'Строить', svg: modeSvg('arc'), hint: 'Новая дорога по точкам', key: 'N' },
      { id: 'lane', name: 'Полоса', svg: laneSvg(), hint: 'Кликайте по точкам, как путь: от края вдоль дороги — полоса, в сторону — съезд, из поля к краю — въезд; конец полосы можно тянуть. Esc — закончить', key: 'L' },
      { id: 'upgrade', name: 'Перестроить', svg: upgradeSvg(), hint: 'Клик по дороге — заменить её выбранным типом, полосами и скоростью', key: 'U' },
      { id: 'move', name: 'Двигать', svg: moveNodeSvg(), hint: 'Тяните узел — дороги следом; середину дороги — выгнуть; конец въезда или съезда у дороги — вдоль неё; угол перекрёстка — наружу, скруглить поворот. Cmd/Ctrl — без прилипания', key: 'M' },
    ], true);
    if (c.roadMode === 'move') {
      // Что можно тянуть — картинками: узел (дороги следом), тупик (продлить, примкнуть), примыкание въезда или
      // съезда (вдоль дороги), середину, перо и угол перекрёстка (скруглить поворот).
      const what = [
        { svg: moveNodeSvg(), name: 'Узел', small: 'дороги следом' },
        { svg: moveEndSvg(), name: 'Тупик', small: 'продлить, примкнуть' },
        { svg: moveJointSvg(), name: 'Примыкание', small: 'вдоль дороги' },
        { svg: bendSvg(), name: 'Середина', small: 'изогнуть дугой' },
        { svg: handleSvg(), name: 'Перо', small: 'угол у узла' },
        { svg: cornerSvg(), name: 'Угол', small: 'скруглить поворот' },
      ]
        .map((x) => `<div class="card">${x.svg}<span class="name">${x.name}</span><small>${x.small}</small></div>`)
        .join('');
      // «Проект» — тот же значок в заголовке и плашка над панелью: перенос сначала проектом, потом — разом.
      // Правила — строкой под карточками (как у «Ж/д → Двигать»): абзацем справа панель заходила под миникарту.
      return `${this.projectBarHtml()}<div class="opt-row">${sw}<div class="opt-group"><div class="opt-title">Что тянуть${this.projectChipHtml()}</div><div class="cards">${what}</div></div></div>
        ${railRules(
          [
            // Подписи — коротко (все четыре в одну строку не шире карточек), полностью — в title.
            { svg: moveNodeSvg(), text: 'Изгиб — на прямую', hint: 'Изгиб у прямой между соседями встаёт ровно на неё; с зажатым Cmd/Ctrl — нет, узел ровно за курсором' },
            { svg: moveEndSvg(), text: 'Тупик на дороге — примыкает', hint: 'Тупик, отпущенный на другой дороге, примыкает к ней; с зажатым Cmd/Ctrl — нет, остаётся тупиком' },
            { svg: handleSvg(), text: 'Стык — сосед следом, <kbd>Shift</kbd> — излом', hint: 'Перья видны у дороги под курсором; в стыке соседняя дорога поворачивает следом, Shift — излом' },
            {
              svg: splitNodeSvg(),
              text: 'Клик — узел, <kbd>Delete</kbd> — убрать',
              hint: 'Клик по дороге (без протяжки) — узел в этой точке: форма та же, его можно тянуть и к нему примыкать. Delete у стыка двух дорог — узел прочь, они сольются в одну. Ctrl+Z — вернуть',
            },
          ],
          true,
        )}`;
    }
    // Знаки быстрее потолка выбранного типа (грунтовка — 40, улица — 80, проспект — 100) — неактивны: клик не выбирает
    // (уведомление — почему), но тянуть на другую дорогу можно — там проверка по её классу. У «Полосы» класс — от дороги,
    // к которой её ведут, — все знаки доступны, при стройке скорость обрежется по её потолку.
    const capName = ROAD_PRESETS.find((p) => p.id === c.presetId && p.spec.cls === s.cls)?.name;
    const drag = 'перетащите знак на дорогу — сменить скорость без перестройки; Cmd/Ctrl — только этот участок';
    const limits = SPEED_LIMITS.map((v) => {
      const off = c.roadMode !== 'lane' && !limitAllowed(s.cls, v);
      const tip = off ? `${limitCapText(s.cls, capName)} · знак можно перетащить на дорогу быстрее` : `Ограничение ${v} км/ч · ${drag}`;
      return `<button class="limit ${specKmh(s) === v ? 'active' : ''}${off ? ' off' : ''}" data-action="limit" data-v="${v}" draggable="true" data-drag-limit="${v}"
          ${off ? 'aria-disabled="true"' : ''} data-tip="${tip}">${speedSign(v, 26)}</button>`;
    }).join('');
    if (c.roadMode === 'lane') {
      // Полоса — всегда одна, ширина и класс — как у дороги, от которой её ведут: выбирать нечего, кроме скорости.
      // «Проект» — тот же значок в заголовке и плашка над панелью: полосы сначала проектом, потом — разом.
      return `${this.projectBarHtml()}<div class="opt-row">${sw}<div class="opt-group"><div class="opt-title">Скорость</div><div class="limits">${limits}</div></div>
        <div class="opt-group narrow"><div class="opt-title">Полоса${this.projectChipHtml()}</div>
        <p class="muted">Кликайте по точкам, как путь: от края вдоль дороги — полоса, в сторону — съезд, из поля к краю — въезд. С точки на конце дороги — однополосная из этой полосы.</p></div></div>`;
    }
    const presets = ROAD_PRESETS.map(
      (p) => `<button class="card ${c.presetId === p.id ? 'active' : ''}" data-action="preset" data-id="${p.id}"
        data-tip="${PRESET_HINTS[p.id] ?? p.name}">${roadSvg(p.spec, 64, 26)}<span class="name">${p.name}</span>
        <small>${lanesLabel(p.spec)} · ${specKmh(p.spec)} км/ч</small></button>`,
    ).join('');
    const stepper = (key: 'f' | 'b', value: number, arrow: string, title: string) =>
      `<span class="stepper" title="${title}"><button data-action="lanes" data-${key}="-1">−</button>
        <b>${arrow} ${value}</b><button data-action="lanes" data-${key}="1">+</button></span>`;
    // Полосы в одну строку: встречные — схема — попутные; цена — в заголовке.
    const lanes = `<div class="lane-editor">
        ${stepper('b', s.lanesB, '←', 'Полосы во встречном направлении (0 — односторонняя)')}
        <div class="lane-preview">${roadSvg(s, 104, 36)}</div>
        ${stepper('f', s.lanesF, '→', 'Полосы в направлении строительства')}
      </div>`;
    const tail =
      c.roadMode === 'build'
        ? this.shapeHtml()
        : // Проект дорог в «Перестроить» не правится, но хранится — плашка над панелью об этом.
          `${this.projectBarHtml()}<div class="opt-group narrow"><div class="opt-title">Перестроить</div>
          <p class="muted">Кликните по дороге, чтобы заменить её выбранным типом, полосами и скоростью. Повторный клик по односторонней дороге разворачивает её.</p></div>`;
    return `<div class="opt-row">${sw}<div class="opt-group wide"><div class="opt-title">Тип дороги</div><div class="cards">${presets}</div></div></div>
      <div class="opt-row"><div class="opt-group"><div class="opt-title">Полосы <span class="price-tag">≈ ${money(specCost(s) * 100)} за 100 м</span></div>${lanes}</div>
        <div class="opt-group"><div class="opt-title">Скорость</div><div class="limits">${limits}</div></div>${tail}</div>`;
  }

  private renderSide(): void {
    // Пока игрок вводит название линии, не перерисовываем панель.
    if (document.activeElement instanceof HTMLInputElement && this.q('[data-side]').contains(document.activeElement)) return;
    if (this.pressing || this.dragLine !== null) return;
    const html = this.sideHtml();
    // Карточку станции закрыли раньше, чем открылось поле, — при следующем выборе станции оно не нужно.
    if (this.renamingStation !== null && !html.includes('data-station-name')) this.renamingStation = null;
    if (this.renamingBase !== null && !html.includes('data-base-name')) this.renamingBase = null;
    // Карточку базы закрыли (или выбрали другое кликом по карте), не подтвердив снос, — вопрос снимается.
    if (this.confirmRemoveBase !== null && !html.includes('bc-remove confirm')) this.confirmRemoveBase = null;
    if (this.renamingProject !== null && !html.includes('data-project-name')) this.renamingProject = null;
    if (html !== this.lastPanel) {
      const side = this.q('[data-side]');
      side.innerHTML = html;
      this.lastPanel = html;
      // Курсор стоит на графике скорости: на новом рисунке черта и подсказка — там же (pointerout не придёт).
      if (this.speedHoverX !== null) {
        const svg = side.querySelector<SVGSVGElement>('[data-speed-line] svg');
        if (svg) this.speedHover(svg, this.speedHoverX);
        else this.speedHoverEnd(null);
      }
      // Открыли кликом по значку предупреждения — блок с объяснением на виду.
      side.querySelector('.station-warnings.flash')?.scrollIntoView({ block: 'nearest' });
      // Новую или переименовываемую папку (и название станции) сразу открываем для ввода.
      const input = side.querySelector<HTMLInputElement>('[data-folder-name], [data-station-name], [data-base-name], [data-project-name], [data-new-folder-line]');
      input?.focus();
      input?.select();
    }
  }

  private sideHtml(): string {
    const c = this.controller;
    const g = this.game();
    const parts: string[] = [];
    // Карточку закрыли не крестиком (выбрали другое, Esc, удалили маршрут) — к городу больше не возвращаемся.
    if (this.lineBack && c.selectedLine !== this.lineBack.line) this.lineBack = null;
    // Дополнение маршрута: показываем карточку этой линии, клики по станциям добавляют их.
    if (c.tool === 'line' && c.addStopTo !== null && g.lines.has(c.addStopTo)) return this.lineHtml(c.addStopTo);
    if (c.tool === 'line') {
      const names = c.lineDraft.map((id) => esc(g.stations.get(id)?.name ?? '?'));
      parts.push(`<section><h3>Новый маршрут</h3>
        <p class="muted">${names.length ? names.join(' → ') : 'Кликните по станциям в порядке следования.'}</p>
        <div class="actions"><button class="primary small" data-action="finish-line" ${names.length < 2 ? 'disabled' : ''}>Готово</button>
        <button class="small" data-action="cancel-line">Отмена</button></div></section>`);
      return parts.join('');
    }
    const line = c.selectedLine !== null ? g.lines.get(c.selectedLine) : undefined;
    // Открыт маршрут — только он: список всех маршрутов под ним сбивает с толку.
    if (line) return [...parts, this.lineHtml(line.id)].join('');
    if (c.selection) parts.push(this.selectionHtml());
    parts.push(this.linesListHtml());
    return parts.join('');
  }

  /**
   * Список линий; если выбрана станция — только линии через неё, если предприятие или город — только
   * их линии, если машина компании — только её линия, у машины жителя списка нет.
   * Общий список — с папками: сначала папки, за ними линии без папки.
   */
  private linesListHtml(): string {
    const g = this.game();
    const sel = this.controller.selection;
    // У машины жителя линий нет, а у машины компании её линия уже есть в карточке. У проекта стройки и базы маршрутов
    // нет — список всех маршрутов под их карточкой только отвлекает.
    if (sel?.type === 'vehicle' || sel?.type === 'fleet' || sel?.type === 'project' || sel?.type === 'base' || sel?.type === 'crew' || sel?.type === 'workTrain' || sel?.type === 'deposit') return '';
    // Выбрана станция, предприятие или город — только их маршруты, без папок.
    const station = sel?.type === 'station' ? g.stations.get(sel.id) : undefined;
    const industry = sel?.type === 'industry' ? g.industries.find((i) => i.id === sel.id) : undefined;
    const town = sel?.type === 'town' ? g.towns.find((t) => t.id === sel.id) : undefined;
    const own = station ? g.stationLines(station.id) : industry ? g.industryLines(industry.id) : town ? g.townLines(town.id) : null;
    const list = own ?? [...g.lines.values()];
    const title = station ? 'Маршруты станции' : industry ? 'Маршруты предприятия' : town ? 'Маршруты города' : 'Маршруты';
    const empty = station
      ? 'Через эту станцию маршруты не проходят.'
      : industry
        ? 'К этому предприятию маршруты не ходят.'
        : town
          ? 'Через остановки и станции этого города маршруты не ходят.'
          : 'Пока нет маршрутов. Постройте две станции и соедините их маршрутом.';
    const rows = own
      ? list.map((l) => this.lineRowHtml(l)).join('')
      : [...g.folders.values()].map((f) => this.folderHtml(f)).join('') +
        g
          .folderLines(null)
          .map((l) => this.lineRowHtml(l, true))
          .join('');
    const folderBtn = own
      ? ''
      : `<button class="small with-ic" data-action="new-folder" title="Папка для маршрутов: перетащите в неё строки маршрутов">${folderSvg(15)}Папка</button>`;
    // Заголовок сворачивает весь список; кнопки — рядом с ним, наверху.
    const collapsed = this.linesCollapsed;
    const head = `<header class="lines-head">
        <button class="lines-toggle" data-action="toggle-lines" title="${collapsed ? 'Развернуть' : 'Свернуть'} список">
          <span class="caret ${collapsed ? 'closed' : ''}">${chevronSvg()}</span><h3>${title}</h3>${list.length ? `<span class="muted">${list.length}</span>` : ''}</button>
        <button class="small" data-action="new-line" title="Новый маршрут">+ Маршрут</button>${folderBtn}</header>`;
    return `<section class="lines-list" ${own ? '' : 'data-folder-drop="root"'}>${head}${
      collapsed ? '' : rows || `<p class="muted">${empty}</p>`
    }</section>`;
  }

  /** Папка в списке: значок, название, сводка по линиям (число, прибыль) и вложенные линии. */
  private folderHtml(f: LineFolder): string {
    const lines = this.game().folderLines(f.id);
    const profit = lines.reduce((s, l) => s + l.revenueLast - l.costLast, 0);
    const renaming = this.renamingFolder === f.id;
    const name = renaming
      ? `<input class="line-name folder-name" data-folder-name="${f.id}" value="${esc(f.name)}" maxlength="40" />`
      : `<span class="folder-title" data-folder-title="${f.id}" title="Двойной клик — переименовать">${esc(f.name)}</span>`;
    // Свёрнутая папка показывает цвета своих линий.
    const dots = f.collapsed ? `<span class="folder-dots">${lines.slice(0, 6).map((l) => `<i style="background:${l.color}"></i>`).join('')}</span>` : '';
    const body = f.collapsed
      ? ''
      : `<div class="folder-lines">${lines.map((l) => this.lineRowHtml(l, true)).join('') || '<p class="muted small-note">Перетащите сюда строку маршрута</p>'}</div>`;
    // Карандаш — сразу за названием, сводка и ✕ — у правого края.
    const pencil = renaming
      ? ''
      : `<button class="icon pencil" data-action="rename-folder" data-id="${f.id}" title="Переименовать">✎</button><span class="folder-fill"></span>`;
    return `<div class="folder ${f.collapsed ? 'collapsed' : ''}" data-folder-drop="${f.id}">
      <div class="folder-row" ${renaming ? '' : `data-action="toggle-folder" data-id="${f.id}"`} title="${f.collapsed ? 'Развернуть' : 'Свернуть'}">
        <span class="caret ${f.collapsed ? 'closed' : ''}">${chevronSvg(10)}</span>${folderSvg(16, !f.collapsed)}${name}${pencil}${dots}
        <small>${lines.length} мрш.</small><small class="${profit >= 0 ? 'pos' : 'neg'}">${money(profit)}</small>${lines.some((l) => l.problem) ? '<b class="warn">!</b>' : ''}
        <button class="icon" data-action="delete-folder" data-id="${f.id}" title="Удалить папку — маршруты останутся в списке">✕</button>
      </div>${body}</div>`;
  }

  /** Значок линии цвета линии: автобус, грузовик или поезд. */
  private lineIcon(l: Line, w = 20): string {
    return lineKindSvg(this.game().lineVehicleKind(l), l.color, w);
  }

  /** Строка линии; в общем списке её можно перетащить на папку или в другое место списка. */
  private lineRowHtml(l: Line, draggable = false): string {
    const profit = l.revenueLast - l.costLast;
    // Перетаскиваемая строка — div: кнопки перетаскиваются не во всех браузерах.
    const tag = draggable ? 'div' : 'button';
    const drag = draggable
      ? ` draggable="true" data-drag-line="${l.id}" title="Перетащите, чтобы поменять порядок${this.game().folders.size ? ' или переложить в папку' : ''}"`
      : '';
    return `<${tag} class="line-row ${this.controller.selectedLine === l.id ? 'active' : ''}" data-action="select-line" data-id="${l.id}"${drag}>
      ${this.lineIcon(l)}<span>${esc(l.name)}</span><small${l.auto?.on ? ' title="Авто: сейчас / сколько можно докупить"' : ''}>${l.vehicles.length}${l.auto?.on ? `/${l.auto.max}` : ''} маш.</small>
      <small class="${profit >= 0 ? 'pos' : 'neg'}">${money(profit)}</small>${this.lineWarn(l)}</${tag}>`;
  }

  /**
   * Склад станции: полоска заполнения «лежит / помещается» (красная, когда почти полон) и у автостанции —
   * пристройки-склады «−» и «+» (с ценой или причиной, почему нельзя).
   */
  private storageRowHtml(st: Station): string {
    const g = this.game();
    const stored = Math.round(g.stationStored(st));
    const room = g.stationStorage(st);
    const share = Math.min(1, stored / room);
    const bar = `<span class="store-bar ${g.stationFull(st) ? 'full' : ''}" data-tip="На складе ${stored} из ${room} ед.: продукция предприятий и груз для пересадки"><i style="width:${(share * 100).toFixed(1)}%"></i></span><b class="store-num">${stored} / ${room}</b>`;
    if (st.kind !== 'road') return `<div class="icon-row store-row"><span class="lbl2">${depotSvg(16)} Склад</span>${bar}</div>`;
    // «+» — поставить склад-здание рядом (режим размещения на карте), «−» — снести последний (или пристройку старого сохранения).
    const slots = storageSlots(st);
    const placing = this.controller.placingWarehouse === st.id;
    const full = slots >= STORAGE.max;
    const plusTip = full ? `Больше ${STORAGE.max} складов нельзя` : placing ? 'Кликните на карте рядом со станцией · Esc — отмена' : `Поставить склад рядом со станцией: +${STORAGE.per} ед. места · ${money(STORAGE.cost)}`;
    const last = st.warehouses?.[st.warehouses.length - 1];
    const lessProblem = last ? g.warehouseRemoveProblem(last) : (st.depots ?? 0) > 0 ? (g.stationDepotsPlan(st.id, (st.depots ?? 0) - 1).reason ?? null) : 'Складов нет';
    const minusTip = lessProblem ?? `Снести склад · вернём ${money(STORAGE.cost * COST.refundRatio)}`;
    return `<div class="icon-row store-row"><span class="lbl2">${depotSvg(16)} Склад</span>${bar}
      <span class="stepper depots"><button data-action="st-depots" data-id="${st.id}" data-d="-1" class="${lessProblem ? 'off' : ''}" ${slots ? '' : 'disabled'} data-tip="${esc(minusTip)}">−</button><b data-tip="Складов: ${slots} из ${STORAGE.max}">${slots}</b><button
        data-action="st-warehouse" data-id="${st.id}" class="${full ? 'off' : placing ? 'active' : ''}" data-tip="${esc(plusTip)}" data-tip-end>+</button></span></div>`;
  }

  /**
   * Перевалка с соседними станциями (game/transfer.ts): по строке на соседа — его название (клик — показать) и
   * что перекладывается: «⬅» груз с его склада заберут маршруты отсюда, «➡» — со склада этой станции заберут его маршруты.
   */
  private transferRowHtml(st: Station): string {
    const g = this.game();
    return g
      .transferFlows(st)
      .map(({ near, flows }) => {
        const chips = flows.length
          ? flows
              .map((f) => {
                const here = f.to === st;
                const tip = `${CARGO[f.cargo].name}: ${f.amount} ед. на складе «${f.from.name}» заберёт ${f.lines.length > 1 ? 'маршруты' : 'маршрут'} ${f.lines
                  .map((l) => `«${l.name}»`)
                  .join(', ')}`;
                return `<span class="chip-ic transfer-chip ${f.amount ? '' : 'idle'}" data-tip="${esc(tip)}"><span class="arrow">${here ? '⬅' : '➡'}</span>${cargoIcon(
                  f.cargo,
                  18,
                )}<b>${f.amount}</b></span>`;
              })
              .join('')
          : `<span class="muted" data-tip="${esc(
              `Груз, который другая линия выгрузит на склад «${near.name}», заберут маршруты отсюда — и наоборот`,
            )}">—</span>`;
        return `<div class="icon-row transfer-row"><span class="lbl2" data-tip="Перевалка: соседняя станция ближе ${TRANSFER.reach} м — груз с её склада заберут маршруты отсюда">⇄ Перевалка</span>
          <button class="place-link" data-action="show-station" data-id="${near.id}">${esc(near.name)}</button>${chips}</div>`;
      })
      .join('');
  }

  /** «!» у строки маршрута: проблема линии, станция не того вида или совет советника (с его заголовком в подсказке). */
  private lineWarn(l: Line): string {
    const advice = this.advice().find((a) => a.line === l.id && a.level !== 'tip');
    if (advice) return `<b class="warn" data-tip="${esc(advice.title)} — подробнее в «Советах»" data-tip-end>!</b>`;
    return l.problem || this.lineMissing(l) || this.game().lineGap(l) ? '<b class="warn">!</b>' : '';
  }

  /** На какой-то станции маршрута его транспорту нечего делать — та же «!», что и у проблем маршрута. */
  private lineMissing(l: Line): boolean {
    const g = this.game();
    return l.stops.some((_, i) => g.stopMissing(l, i) !== null);
  }

  /** Значок, название и сводка папки (цвета и число линий) — без кнопок редактирования, для выпадающего списка. */
  private folderMetaHtml(f: LineFolder): string {
    const lines = this.game().folderLines(f.id);
    const dots = lines.length ? `<span class="folder-dots">${lines.slice(0, 6).map((l) => `<i style="background:${l.color}"></i>`).join('')}</span>` : '';
    return `${folderSvg(16)}<span class="folder-pick-name">${esc(f.name)}</span>${dots}<small>${lines.length} мрш.</small>`;
  }

  /**
   * Папка линии в карточке: кнопка с текущей папкой (значок, название, сводка) раскрывает список
   * остальных папок и «+ Новая папка» — последним пунктом, который даёт ввести название.
   */
  private folderPickHtml(line: Line): string {
    if (this.addingFolderLine === line.id) {
      return `<div class="folder-pick" title="Папка в списке маршрутов"><div class="folder-pick-row">${folderSvg(16)}
        <input class="line-name folder-name" data-new-folder-line="${line.id}" placeholder="Название папки" maxlength="40" /></div></div>`;
    }
    const g = this.game();
    const current = line.folder !== undefined ? g.folders.get(line.folder) : undefined;
    const noneBody = `${folderSvg(16)}<span class="folder-pick-name">Без папки</span>`;
    const toggle = `<button class="folder-pick-current" data-action="folder-pick-toggle" data-line="${line.id}">${
      current ? this.folderMetaHtml(current) : noneBody
    }${chevronSvg(10)}</button>`;
    if (this.folderPickOpen !== line.id) return `<div class="folder-pick" title="Папка в списке маршрутов">${toggle}</div>`;
    const option = (id: number | null, body: string) =>
      `<button class="folder-pick-opt ${(line.folder ?? null) === id ? 'active' : ''}" data-action="line-folder" data-line="${line.id}" data-folder="${id ?? ''}">${body}</button>`;
    const options = option(null, noneBody) + [...g.folders.values()].map((f) => option(f.id, this.folderMetaHtml(f))).join('');
    return `<div class="folder-pick open" title="Папка в списке маршрутов">${toggle}<div class="folder-pick-list">${options}
      <button class="folder-pick-opt new" data-action="line-folder-new" data-line="${line.id}">+ Новая папка</button></div></div>`;
  }

  /**
   * Маршрут линии: станции по порядку с условиями отправления, погрузки и выгрузки.
   * Клик по номеру или названию показывает станцию на карте; по остальной строке — раскрывает настройку
   * остановки, повторный — сворачивает.
   */
  private routeHtml(line: Line): string {
    const g = this.game();
    const n = line.stops.length;
    const adding = this.controller.addStopTo === line.id;
    const rows = line.stops
      .map((sid, i) => {
        const st = g.stations.get(sid);
        const rule = g.stopRule(line, i);
        const open = this.stopOpen?.line === line.id && this.stopOpen.i === i;
        const loadIcons = rule.load === 'auto' ? '' : `<span class="rl">⬆${rule.load.length ? rule.load.map((c) => cargoIcon(c, 14)).join('') : '✕'}</span>`;
        const unloadIcons =
          rule.unload === 'auto' ? '' : rule.unload === 'all' ? '<span class="rl">⬇ склад</span>' : `<span class="rl">⬇${rule.unload.map((c) => cargoIcon(c, 14)).join('')}</span>`;
        // Выбранный путь ж/д станции — номером на значке.
        const plat = g.stopPlatform(line, i);
        const platIcon = plat !== null && st ? `<span class="rl" title="Путь станции">🛤${st.platforms.indexOf(plat) + 1}</span>` : '';
        const btn = (action: string, label: string, title: string, disabled = false) =>
          `<button class="icon" data-action="${action}" data-line="${line.id}" data-i="${i}" title="${title}" ${disabled ? 'disabled' : ''}>${label}</button>`;
        // Станция не работает с тем, что возит линия: значок с тем, чего не хватает, — клик включает.
        const missing = st ? g.stopMissing(line, i) : null;
        const warn = missing
          ? `<button class="stop-warn" data-action="st-serves" data-id="${st!.id}" data-what="${missing}" data-tip-end data-tip="${
              missing === 'cargo'
                ? 'Станция не работает с грузом: грузовикам здесь нечего взять и некому сдать. Нажмите — включить груз'
                : 'Станция не работает с пассажирами: здесь никто не сядет и не выйдет. Нажмите — включить пассажиров'
            }">⚠${cargoIcon(missing === 'cargo' ? 'goods' : 'passengers', 14)}</button>`
          : '';
        // Номер и название — показать станцию на карте; плашка со стрелкой и остальная строка раскрывают
        // настройку остановки и повторным кликом сворачивают.
        const fold = open ? 'Свернуть настройку остановки' : 'Настроить остановку';
        return `<div class="stop ${open ? 'open' : ''}" data-action="stop-open" data-line="${line.id}" data-i="${i}" title="${fold}">
          ${stopPlaceHtml(i, st?.id ?? null, st ? (st.kind === 'rail' ? '🚉 ' : '') + esc(st.name) : '?')}${warn}
          <button class="rule-chip" data-action="stop-open" data-line="${line.id}" data-i="${i}" title="${fold}">${WAIT_LABELS[ruleWaitId(rule)]}${platIcon}${loadIcons}${unloadIcons}${stopFoldHtml(open)}</button>
          ${btn('stop-up', '↑', 'Раньше', i === 0)}${btn('stop-down', '↓', 'Позже', i === n - 1)}${btn('stop-del', '✕', 'Убрать из маршрута', n <= 2)}
        </div>${open ? this.stopRuleHtml(line, i, rule) : ''}`;
      })
      .join('');
    return `<div class="route"><div class="route-head"><span class="lbl2">Остановки</span>
      <button class="small ${adding ? 'primary' : ''}" data-action="${adding ? 'stop-add-done' : 'stop-add'}" data-line="${line.id}">${adding ? 'Готово' : '+ Станция'}</button></div>
      ${adding ? '<p class="tip">Кликайте по станциям на карте — они добавятся в конец маршрута.</p>' : ''}
      ${rows}</div>`;
  }

  /** Настройка остановки: отправление, погрузка, выгрузка — кнопками и значками грузов. */
  private stopRuleHtml(line: Line, i: number, rule: StopRule): string {
    const attrs = `data-line="${line.id}" data-i="${i}"`;
    const waitId = ruleWaitId(rule);
    const waits = (Object.keys(WAIT_LABELS) as WaitId[])
      .map((w) => `<button class="opt ${waitId === w ? 'active' : ''}" data-action="rule-wait" ${attrs} data-v="${w}" title="${WAIT_HINTS[w]}">${WAIT_LABELS[w]}</button>`)
      .join('');
    // Только грузы этой карты (у каждого биома свои) и уже выбранные.
    const onMap = new Set(cargoOnMap(this.game().industries, this.game().towns));
    const cargoChips = (action: string, list: CargoType[] | null) =>
      FREIGHT.filter((c) => onMap.has(c) || list?.includes(c)).map(
        (c) => `<button class="cargo-chip ${list?.includes(c) ? 'active' : ''}" data-action="${action}" ${attrs} data-c="${c}" title="${CARGO[c].name}">${cargoIcon(c, 20)}</button>`,
      ).join('');
    const loadList = rule.load === 'auto' ? null : rule.load;
    const unloadList = Array.isArray(rule.unload) ? rule.unload : null;
    // Ж/д станция: на какой путь вставать — схемой путей с номерами; «Авто» — на свободный.
    const st = this.game().stations.get(line.stops[i]);
    const count = st?.kind === 'rail' ? st.platforms.length : 0;
    const pick = rule.platform !== undefined && rule.platform !== null && rule.platform < count ? rule.platform : null;
    const platforms =
      count > 1
        ? `<div class="rule-row"><span class="lbl2">Путь</span><div class="opts">${[null, ...Array.from({ length: count }, (_, k) => k)]
            .map(
              (k) => `<button class="opt plat ${pick === k ? 'active' : ''}" data-action="rule-platform" ${attrs} data-v="${k ?? 'auto'}" title="${
                k === null ? 'Авто: на любой свободный путь' : `Путь ${k + 1}${k === 0 && !st?.terminal ? ' — сквозной' : ''}`
              }">${platformPickSvg(count, k)}${k === null ? 'Авто' : k + 1}</button>`,
            )
            .join('')}</div></div>`
        : '';
    return `<div class="stop-rule">
      <div class="rule-row"><span class="lbl2">Отправление</span><div class="opts">${waits}</div></div>${platforms}
      <div class="rule-row"><span class="lbl2">Грузить</span><div class="opts">
        <button class="opt ${rule.load === 'auto' ? 'active' : ''}" data-action="rule-load" ${attrs} data-c="auto" title="То, что примут дальше по маршруту">Авто</button>
        ${cargoChips('rule-load', loadList)}</div></div>
      <div class="rule-row"><span class="lbl2">Выгружать</span><div class="opts">
        <button class="opt ${rule.unload === 'auto' ? 'active' : ''}" data-action="rule-unload" ${attrs} data-c="auto" title="Только тому, кто здесь принимает груз">Авто</button>
        <button class="opt ${rule.unload === 'all' ? 'active' : ''}" data-action="rule-unload" ${attrs} data-c="all" title="Всё, что везём: получателю, а остальное — на склад станции для другого маршрута">Всё на склад</button>
        ${cargoChips('rule-unload', unloadList)}</div></div>
    </div>`;
  }

  /** Подсказка крестика карточки маршрута: открыта из панели города — крестик вернёт к нему. */
  private closeLineTitle(lineId: number): string {
    const g = this.game();
    const back = lineCloseTarget(this.lineBack, lineId, g.towns);
    const town = back?.type === 'town' ? g.towns.find((t) => t.id === back.id) : undefined;
    return town ? ` title="Назад к городу «${esc(town.name)}»"` : ' title="Закрыть"';
  }

  private lineHtml(id: number): string {
    const g = this.game();
    const line = g.lines.get(id)!;
    const vehicles = line.vehicles
      .map((vid) => {
        const v = g.fleet.get(vid);
        if (!v) return '';
        const m = MODELS[v.model];
        const st = g.stations.get(line.stops[v.stop]);
        // Выжидает интервал за предыдущей машиной линии — с обратным отсчётом.
        const hold = g.spacingLeft(v);
        // Значок-кнопка сразу после отсчёта — отправить, не дожидаясь срока.
        const dispatchIcon = `<button class="icon dispatch" data-action="dispatch-now" data-id="${v.id}" data-tip="Отправить сейчас, не дожидаясь интервала">▶</button>`;
        const state =
          v.state === 'driving'
            ? `едет на ${esc(st?.name ?? '?')}`
            : hold !== null
              ? `<span class="hold" title="Ждёт интервала за предыдущей машиной маршрута, чтобы машины шли равномерно">⏱ ждёт интервала ${Math.ceil(hold)} с</span>${dispatchIcon} ${esc(st?.name ?? '?')}`
              : v.state === 'loading'
                ? `${v.enter ? 'заезжает' : 'погрузка'}: ${esc(st?.name ?? '?')}`
                : `ждёт: ${esc(st?.name ?? '?')}`;
        const load = vehicleLoad(v);
        const what = v.cargo ? cargoIcon(v.cargo, 14) : load ? cargoIcon('passengers', 14) : ' пусто';
        // Замена на модель новее, когда она вышла.
        // Замена — на месте, там же, где машина едет или стоит; заказанная ждёт места сзади на дороге.
        const next = g.replacementFor(v);
        const tank = g.isTanker(v);
        const replace = v.upgradeTo
          ? `<button class="small replace" disabled title="Новая ${modelName(v.upgradeTo, tank)} длиннее, а сзади вплотную машина — заменится, как только освободится место">⟳ ждёт места</button>`
          : next
            ? `<button class="small replace" data-action="replace" data-id="${v.id}" title="Заменить на месте: продать за ${money(g.saleValue(v))} и купить ${modelName(next, tank)} за ${money(MODELS[next].price)} — поедет дальше оттуда же, с тем же грузом">⟳ ${modelName(
                next,
                tank,
              )}</button>`
            : '';
        // Длина состава: вагоны добавляются и снимаются, пока помещаются на платформы линии.
        const cars =
          m.mode === 'rail'
            ? `<span class="stepper cars" title="Вагонов в составе (до ${g.maxCars(v)} — по длине платформ)"><button data-action="cars" data-id="${v.id}" data-d="-1">−</button><b>🚃 ${carsOf(
                v,
              )}</b><button data-action="cars" data-id="${v.id}" data-d="1">+</button></span>`
            : '';
        return `<div class="veh" data-veh="${v.id}"><div><div class="veh-head"><b>${esc(g.vehicleTitle(v))}</b> <small class="nowrap">· ${load}/${vehicleCapacity(v)}${what}</small></div><small>${state}</small></div>
          ${cars}${replace}
          <button class="icon" title="Показать" data-action="show-fleet" data-id="${v.id}">◎</button>
          <button class="icon" title="Продать за ${money(g.saleValue(v))}" data-action="sell" data-id="${v.id}">✕</button></div>`;
      })
      .join('');
    // Палитра открывается по клику на кружок цвета линии.
    // Второй ряд — цвета грузов (со значком груза): маршрут легко покрасить под то, что он возит.
    const cargoSwatches = (Object.keys(CARGO) as CargoType[])
      .map(
        (t) => `<button class="swatch cargo ${CARGO[t].color === line.color ? 'active' : ''}" title="${CARGO[t].name}" data-action="line-color" data-id="${line.id}" data-color="${CARGO[t].color}">${cargoIcon(t, 20, false)}</button>`,
      )
      .join('');
    const palette =
      this.colorsOpen === line.id
        ? `<div class="swatches" title="Цвет маршрута">${LINE_COLORS.map(
            (c) => `<button class="swatch ${c === line.color ? 'active' : ''}" style="background:${c}" data-action="line-color" data-id="${line.id}" data-color="${c}"></button>`,
          ).join('')}<label class="swatch custom" title="Свой цвет"><input type="color" data-line-color="${line.id}" value="${line.color}" /></label></div>
          <div class="swatches cargo-swatches" title="Цвета грузов">${cargoSwatches}</div>`
        : '';
    const interval = g.lineInterval(line);
    const kind = g.lineKind(line);
    // Маршрут только наливных грузов: грузовики на нём — автоцистерны (так и на карточках покупки).
    const tank = kind === 'freight' && g.tankLine(line);
    const speed = this.lineSpeedHtml(line);
    // Между станциями нет готовой дороги: купить можно, но машина будет ждать на станции — значок на карточках покупки.
    const gap = g.lineGap(line);
    const vehicleWord = g.lineMode(line) === 'rail' ? 'поезд' : 'машину';
    // Время в пути — круг маршрута со стоянками (тот же, от которого считается интервал): минуты и секунды.
    const lap = g.lineLap(line);
    const travel = lap
      ? `<span title="Круг маршрута со стоянками: от первой станции через все остановки и обратно${
          line.lap ? '' : ' — прикидка, пока машины не проехали круг'
        }">Время в пути</span><b>${travelTimeText(lap)}</b>`
      : '';
    return `<section class="detail"><header><button class="line-dot" style="background:${line.color}" data-action="toggle-colors" data-id="${line.id}" title="Сменить цвет"></button>
        <input class="line-name" data-line-name="${line.id}" value="${esc(line.name)}" title="Нажмите, чтобы переименовать" maxlength="60" />
        <button class="icon" data-action="close-line"${this.closeLineTitle(line.id)}>✕</button></header>
      ${palette}
      ${this.folderPickHtml(line)}
      ${this.routeHtml(line)}
      ${line.problem || gap ? `<p class="warn">${esc(line.problem || gap!)}</p>` : ''}
      ${lineJamsHtml(g.lineJams(line))}
      ${g
        .lineAdvice(line)
        .map((a) => `<p class="tip">${esc(a)}</p>`)
        .join('')}
      <div class="kv">${lineMoneyHtml(line, this.lineMoneyOpen)}
        <span>Перевезено</span><b>${line.carriedLast}</b>
        ${linePaceHtml(g, line)}
        <span>Загрузка рейсов</span><b>${line.loadLast === undefined || line.loadLast === null ? '—' : `${Math.round(line.loadLast * 100)}%`}</b>
        ${speed ? speed.row : ''}
        ${travel}
        ${
          interval
            ? `<span title="С первой станции машины уходят через столько: круг маршрута / число машин">Интервал${line.noSpacing ? ': выключен' : ''}</span><b>${
                line.noSpacing ? '' : `<i class="kv-clock">⏱</i> ${Math.round(interval)} с `
              }<button class="icon toggle-spacing" data-action="line-spacing" data-id="${line.id}" title="${
                line.noSpacing ? 'Включить интервал: машины будут выжидать очередь на первой станции' : 'Выключить интервал: машины будут уезжать с первой станции сразу, как готовы'
              }">${line.noSpacing ? '▶' : '✕'}</button></b>`
            : ''
        }</div>
      ${speed?.chart ?? ''}
      ${line.history?.length ? `<div class="line-chart">${incomeChart(line.history.map((h) => ({ label: h.label, income: h.revenue, expense: h.cost })), 70)}</div>` : ''}
      ${this.autoFleetHtml(line)}
      <div class="buy">${modelsFor(g.lineMode(line), g.modelOpen)
        // Грузовому маршруту — только грузовой транспорт, пассажирскому — пассажирский; смешанному — любой.
        .filter((m) => !kind || MODELS[m].carries === kind)
        .map(
          // Клик — машина выедет с первой остановки; перетащить на остановку маршрута — сразу с неё (bindBuyDrag).
          (m) => `<button class="buy-card${gap ? ' no-road' : ''}" data-action="buy" data-line="${line.id}" data-model="${m}" draggable="true" data-drag-buy="${m}" data-tip="${
            gap ? `⚠ ${esc(gap)} — купленная машина будет ждать на станции · ` : ''
          }Вместимость ${MODELS[m].capacity} · содержание ${money(MODELS[m].running)}/мес · перетащите на остановку ▶ — выедет с неё">
            ${gap ? '<i class="buy-warn">⚠</i>' : ''}${modelSvg(m, line.color, undefined, undefined, tank)}<span>+ ${modelName(m, tank)}</span><small>${MODELS[m].capacity} мест · ${money(
              MODELS[m].price,
            )}</small></button>`,
        )
        .join('')}${kind ? this.nextModelHtml(g.lineMode(line), kind, tank) : ''}</div>
      <div class="vehicles">${
        vehicles ||
        `<p class="muted">${
          gap
            ? line.auto?.on
              ? `Авто-парк купит ${vehicleWord}, когда до станций будет готовая дорога.`
              : `Сначала соедините станции дорогой — без неё ${vehicleWord} не уедет со станции.`
            : line.auto?.on
              ? `Пока транспорт не нужен — авто-парк купит ${vehicleWord}, когда появится груз или пассажиры.`
              : `Купите ${vehicleWord}, чтобы маршрут заработал.`
        }</p>`
      }</div>
      <div class="actions"><button class="small danger" data-action="delete-line" data-id="${line.id}">Удалить маршрут</button></div></section>`;
  }

  /**
   * Следующая модель, которой ещё нет в продаже, — серой карточкой с замком: когда откроется (в сценарии —
   * на каком этапе, в песочнице — с какого года).
   */
  private nextModelHtml(mode: LineMode, carries: 'freight' | 'passengers', tank = false): string {
    const g = this.game();
    const next = (Object.keys(MODELS) as ModelId[])
      .filter((id) => MODELS[id].mode === mode && MODELS[id].carries === carries && !g.modelOpen(id))
      .sort((a, b) => MODELS[a].tier - MODELS[b].tier)[0];
    if (!next) return '';
    const m = MODELS[next];
    const when = g.scenario?.running ? `этап ${'ABC'[m.tier - 1]}` : `с ${g.modelYear(next)} г.`;
    const tip = g.scenario?.running ? `Откроется на этапе ${'ABC'[m.tier - 1]} сценария` : `Появится в продаже в ${g.modelYear(next)} году`;
    // Карточка последняя в ряду, у края панели — подсказка выровнена по правому краю.
    return `<div class="buy-card locked" data-tip-end data-tip="${tip} · вместимость ${m.capacity} · ${money(m.price)}">
      ${modelSvg(next, '#aab3bc', undefined, undefined, tank)}<span>🔒 ${modelName(next, tank)}</span><small>${when}</small></div>`;
  }

  /**
   * Средняя скорость круга маршрута — строкой с треугольником; раскрыт — под сводкой график скорости А→Б→А
   * с легендой: скорость, предел, рельеф, длина и время круга в пути.
   */
  /**
   * Курсор над графиком скорости в clientX: черта и точка на графике, рядом — своя подсказка со скоростью
   * (сразу, без задержки браузерной title), а на карте — точка маршрута и скорость в ней.
   */
  private speedHover(svg: SVGSVGElement, clientX: number): void {
    const g = this.game();
    const box = svg.closest<HTMLElement>('[data-speed-line]');
    const line = g.lines.get(Number(box?.dataset.speedLine));
    const chart = line && g.lineSpeedChart(line);
    const rect = svg.getBoundingClientRect();
    if (!box || !line || !chart || rect.width <= 0) {
      this.speedHoverEnd(svg);
      return;
    }
    this.speedHoverX = clientX;
    const vb = svg.viewBox.baseVal;
    const h = chartHoverAt(chart, (clientX - rect.left) / rect.width, vb.width, vb.height);
    const cx = h.x.toFixed(1);
    const cursor = svg.querySelector('.speed-cursor');
    cursor?.setAttribute('x1', cx);
    cursor?.setAttribute('x2', cx);
    cursor?.setAttribute('visibility', 'visible');
    const dot = svg.querySelector('.speed-dot');
    dot?.setAttribute('cx', cx);
    dot?.setAttribute('cy', h.y.toFixed(1));
    dot?.setAttribute('visibility', 'visible');
    const tip = box.querySelector<HTMLElement>('.speed-tip');
    if (tip) {
      const names = line.stops.map((sid) => esc(g.stations.get(sid)?.name ?? '?'));
      tip.innerHTML = speedTipHtml(h, names, line.color);
      tip.hidden = false;
      // Сбоку от черты — справа, у правого края — слева; по высоте — у точки, не ниже рисунка.
      const b = box.getBoundingClientRect();
      const px = rect.left - b.left + (h.x / vb.width) * rect.width;
      const py = rect.top - b.top + (h.y / vb.height) * rect.height;
      const w = tip.offsetWidth;
      const th = tip.offsetHeight;
      tip.style.left = `${px + 10 + w <= b.width ? px + 10 : Math.max(0, px - 10 - w)}px`;
      tip.style.top = `${Math.max(0, Math.min(rect.bottom - b.top - th, py - th / 2))}px`;
    }
    const pos = { x: chart.x[h.i], y: chart.y[h.i] };
    this.controller.chartPoint = Number.isFinite(pos.x) && Number.isFinite(pos.y) ? { pos, color: line.color, kmh: h.kmh } : null;
  }

  /** Курсор ушёл с графика скорости: прячем черту, точку и подсказку, а на карте — точку маршрута. */
  private speedHoverEnd(svg: SVGSVGElement | null): void {
    this.speedHoverX = null;
    this.controller.chartPoint = null;
    if (!svg) return;
    svg.querySelector('.speed-cursor')?.setAttribute('visibility', 'hidden');
    svg.querySelector('.speed-dot')?.setAttribute('visibility', 'hidden');
    const tip = svg.closest('[data-speed-line]')?.querySelector<HTMLElement>('.speed-tip');
    if (tip) tip.hidden = true;
  }

  private lineSpeedHtml(line: Line): { row: string; chart: string } | null {
    const g = this.game();
    const chart = g.lineSpeedChart(line);
    if (!chart) return null;
    const open = this.speedChartOpen;
    const kmh = Math.round(chart.avg * KMH_PER_UNIT);
    const tip = `${open ? 'Свернуть' : 'Развернуть'} график скорости по маршруту: ограничения, повороты, подъёмы и спуски`;
    const row = `<span>Средняя скорость</span><b><button class="speed-toggle" data-action="toggle-speed-chart" title="${tip}">${kmh} км/ч<span class="caret ${
      open ? '' : 'closed'
    }">${chevronSvg(10)}</span></button></b>`;
    if (!open) return { row, chart: '' };
    const names = line.stops.map((sid) => esc(g.stations.get(sid)?.name ?? '?'));
    const legend = `<div class="speed-legend"><span><i class="lg-v" style="background:${line.color}"></i>скорость</span><span><i class="lg-cap"></i>предел</span>${
      chart.z.some((z) => z !== chart.z[0]) ? '<span><i class="lg-z"></i>рельеф</span>' : ''
    }<span class="lg-sum" title="Длина круга и время в пути без стоянок">${distLabel(chart.length)} · ⏱ ${Math.round(chart.time)} с</span></div>`;
    return {
      row,
      chart: `<div class="line-chart" data-speed-line="${line.id}">${speedChartSvg(chart, line.color, names)}<div class="speed-tip" hidden></div>${legend}</div>`,
    };
  }

  /**
   * Авто-парк — один блок: в заголовке выключатель и «от − N + до − M +»,
   * под ним число машин сейчас и ряд машин: цветные — на маршруте,
   * серые — сколько ещё может докупить; черта — минимум.
   */
  private autoFleetHtml(line: Line): string {
    const g = this.game();
    const auto = line.auto;
    const on = !!auto?.on;
    const tip = 'Авто: игра сама докупает транспорт, когда груз копится, а машины уходят полными, и продаёт лишний, когда ездит полупустым';
    const attrs = `data-action="line-auto" data-id="${line.id}" title="${tip}"`;
    const title = `<button class="auto-title" ${attrs}>${autoSvg()} Авто</button>`;
    const toggle = `<button class="auto-toggle" ${attrs}><span class="switch ${on ? 'on' : ''}"><i></i></span></button>`;
    if (!auto || !on) return `<div class="auto-box"><div class="auto-head">${title}${toggle}</div></div>`;
    const n = line.vehicles.length;
    const top = AUTO_FLEET.maxVehicles;
    // Минимум — до 0 (авто-парк может убрать все машины, пока они не нужны), максимум — до 1.
    const step = (what: 'min' | 'max', value: number, title: string) =>
      `<span class="stepper" title="${title}"><button data-action="auto-range" data-id="${line.id}" data-what="${what}" data-d="-1" ${
        value > (what === 'min' ? 0 : 1) ? '' : 'disabled'
      }>−</button><b>${value}</b><button
        data-action="auto-range" data-id="${line.id}" data-what="${what}" data-d="1" ${value < top ? '' : 'disabled'}>+</button></span>`;
    const kind = g.lineVehicleKind(line);
    // Покупка ждёт денег — значок, пока их не хватает (на паузе игрок мог уже взять кредит).
    const funds = auto.noMoney ? g.autoFunds(line) : null;
    // Дороги между станциями нет (или она ещё строится) — машины не покупает, пока маршрут не станет проезжим.
    const gap = g.lineGap(line);
    const flagList = [
      gap ? `<span class="auto-flag warn" data-tip="Ждёт дорогу: ${esc(gap)} — машины купит, когда по маршруту можно будет проехать" data-tip-end>🚧</span>` : '',
      funds && !funds.ok
        ? `<span class="auto-flag warn" data-tip="Ждёт денег на машину: нужно ${money(funds.need)}, на счёте ${money(funds.have)}" data-tip-end>💸</span>`
        : '',
      auto.sell !== undefined ? '<span class="auto-flag" title="Продаст лишний транспорт, когда он опустеет">▼</span>' : '',
    ].filter(Boolean);
    const flags = flagList.join('');
    const renew = this.autoRenewHtml(line);
    // Значки — сколько поместится в ряд, остальные — «+N» в конце.
    const { shown, more } = fleetBar(n, auto.max, fleetBarRoom(this.q('[data-side]').clientWidth), flagList.length);
    // Минимум 0 — черта перед первой машиной: держать не обязан ни одной.
    let slots = auto.min === 0 && shown ? '<i class="min-mark" title="Минимум 0: может убрать все машины, пока они не нужны"></i>' : '';
    for (let i = 1; i <= shown; i++) {
      slots += `<span class="slot">${lineKindSvg(kind, i <= n ? line.color : '#cfd6dd', 18)}</span>`;
      if (i === auto.min && i < shown) slots += '<i class="min-mark" title="Минимум"></i>';
    }
    if (more) {
      const busy = Math.max(0, n - shown);
      const tip = busy ? `Ещё ${busy} на маршруте${more > busy ? ` и ${more - busy} можно докупить` : ''}` : `Ещё ${more} можно докупить`;
      slots += `<small class="auto-more" title="${tip}">+${more}</small>`;
    }
    return `<div class="auto-box on"><div class="auto-head">${title}
        <span class="auto-range"><span class="lbl3">от</span>${step('min', auto.min, 'Не меньше')}<span class="lbl3">до</span>${step('max', auto.max, 'Не больше')}</span>${renew}${toggle}</div>
      <div class="auto-bar" title="На маршруте ${n} · от ${auto.min} до ${auto.max}"><b class="auto-now" title="Сейчас на маршруте">${n}</b>${slots}${flags}</div></div>`;
  }

  /**
   * Выключатель модернизации в авто-парке: значок замены со стрелкой вверх — зелёный, когда включена, серый
   * и перечёркнутый — выключена. Идёт замена — сколько старых машин осталось, ждёт денег — значок тревоги.
   */
  private autoRenewHtml(line: Line): string {
    const g = this.game();
    const on = renewOn(line.auto);
    const status = on ? g.renewStatus(line) : null;
    const left = status?.old.length ?? 0;
    const to = status?.to ? modelName(status.to, g.tankLine(line)) : '';
    const broke = !!status?.funds && !status.funds.ok;
    const tip = !on
      ? 'Модернизация выключена: машины так и ездят старой модели, докупаются такие же. Нажмите — включить'
      : left
        ? `Модернизация: меняет на ${to} — осталось ${left} · по одной, когда машина стоит на станции; новые вместительнее — лишние продаст${
            broke ? ` · ждёт денег: нужно ${money(status!.funds!.need)}` : ''
          } · нажмите — выключить`
        : 'Модернизация: выйдет модель новее — авто-парк заменит ею машины маршрута по одной, когда машина стоит на станции, и будет докупать уже новую. Нажмите — выключить';
    return `<button class="auto-renew${on ? ' on' : ''}${left ? ' busy' : ''}" data-action="line-auto-renew" data-id="${line.id}" data-tip="${esc(tip)}" data-tip-end>${renewSvg(on)}${
      left ? `<b>${left}</b>${broke ? '<i>💸</i>' : ''}` : ''
    }</button>`;
  }

  private selectionHtml(): string {
    const g = this.game();
    const sel = this.controller.selection!;
    const head = (title: string, sub = '') =>
      `<header><h3>${esc(title)}</h3><button class="icon" data-action="close-sel">✕</button></header>${sub ? `<p class="muted">${sub}</p>` : ''}`;
    if (sel.type === 'project') return projectCardHtml(g, sel.id, this.renamingProject === sel.id);
    if (sel.type === 'base') return baseCardHtml(g, sel.id, this.renamingBase === sel.id, this.confirmRemoveBase === sel.id);
    if (sel.type === 'crew') return crewCardHtml(g, sel.id, { following: this.controller.following, picking: this.controller.sendingCrew === sel.id });
    if (sel.type === 'workTrain') return workTrainCardHtml(g, sel.id, { following: this.controller.following });
    if (sel.type === 'deposit') {
      const d = g.enterprises.deposit(sel.id);
      const partners = d && d.used === undefined ? this.partnersHtml(g.partners(g.enterprises.depositProbe(d), 3)) : '';
      return depositCardHtml(g, sel.id, partners);
    }
    if (sel.type === 'station') {
      const st = g.stations.get(sel.id);
      if (!st) return '';
      let pax = 0;
      for (const n of st.passengers.values()) pax += n;
      const waiting = [
        ...FREIGHT.filter((c) => (st.cargo[c] ?? 0) >= 1).map((c) => [c, Math.floor(st.cargo[c] ?? 0)] as const),
        ...(pax ? [['passengers', pax] as const] : []),
      ];
      const suppliesAll = [...new Set(g.industries.filter((i) => st.industryIds.includes(i.id)).map((i) => i.info.produces))];
      const towns = st.townIds.map((id) => g.towns.find((t) => t.id === id)?.name).filter(Boolean).join(', ');
      const kind =
        st.industryId !== null
          ? 'Станция предприятия · '
          : st.kind === 'rail'
            ? st.terminal
              ? 'Конечная ж/д станция · '
              : 'Ж/д станция · '
            : st.kind === 'stop'
              ? 'Автобусная остановка · '
              : `${stationTitle(st.serves)} · `;
      const busy =
        st.kind === 'rail'
          ? `платформ занято ${st.platforms.filter((p) => g.rail.isReserved(p)).length} из ${st.platforms.length} · ${Math.round(g.net.segments.get(st.platforms[0])?.length ?? 0)} м`
          : st.kind === 'stop'
            ? `автобусов ${st.occupied.length} из ${st.bays}`
            : `${isBusTerminal(st) ? 'у перронов автобусов' : 'постов занято'} ${g.stationBays(st).filter(Boolean).length} из ${st.bays}`;
      const supplies = st.serves.cargo ? suppliesAll : [];
      // Куда едут пассажиры: станция назначения (клик — показать), сколько ждут и какие линии туда ходят.
      const routes = g.paxRoutes(st);
      const dests = [...new Set([...routes.keys(), ...st.passengers.keys()])]
        .map((sid) => ({ sid, n: Math.floor(st.passengers.get(sid) ?? 0), lines: routes.get(sid) ?? [] }))
        .filter((d) => g.stations.has(d.sid))
        .sort((a, b) => b.n - a.n);
      const most = Math.max(1, ...dests.map((d) => d.n));
      const paxRows = dests
        .map((d) => {
          const to = g.stations.get(d.sid)!;
          const lines = d.lines
            .map((l) => `<button class="line-kind-btn" data-action="select-line" data-id="${l.id}" title="${esc(l.name)}">${this.lineIcon(l, 18)}</button>`)
            .join('');
          // Ушли к этой остановке, не дождавшись места (paxPatience.ts): ближние уходят первыми, дальние ждут.
          const gone = paxGoneTo(st, d.sid);
          const km = dist(st.fp.center, to.fp.center) / 1000;
          const walked = gone
            ? `<span class="pax-gone" data-tip="Ушли за месяц, не дождавшись места: ${gone}. Ехать ${km.toFixed(1)} км — ждут до ${Math.round(
                paxPatience(km * 1000),
              )} с">${walkIcon(14)}${gone}</span>`
            : '';
          return `<div class="pax-row">${lines}<span class="arrow">→</span>
            <button class="place-link" data-action="show-station" data-id="${to.id}" title="Показать на карте">${esc(to.name)}</button>
            <span class="pax-bar"><i style="width:${(d.n / most) * 100}%"></i></span><b>${d.n}</b>${walked}</div>`;
        })
        .join('');
      const goneAll = paxGone(st);
      const goneHead = goneAll
        ? `<span class="pax-gone" data-tip="Ушли за месяц пешком или иначе: очередь длинная, а в автобусах мало мест. Ждут те, кому ехать далеко">${walkIcon(
            14,
          )}${goneAll}</span>`
        : '';
      const paxBlock =
        st.serves.pax && (pax || dests.length)
          ? `<div class="rule-row"><span class="lbl2">${cargoIcon('passengers', 16)} Куда едут пассажиры ${goneHead}</span>${paxRows}</div>`
          : st.serves.pax && st.catchPop > 0
            ? `<p class="muted">${cargoIcon('passengers', 14)} Пассажиры появятся, когда отсюда пойдёт автобус или пассажирский поезд.</p>`
            : '';
      const freightWaiting = waiting.filter(([c]) => c !== 'passengers');
      // Посты погрузки автостанции: картинка станции с постами, «−» и «+» (с ценой или причиной, почему нельзя).
      // Под картинку держим место на максимум постов: иначе с каждым постом «+» уезжает вправо из-под курсора.
      let baysRow = '';
      if (st.kind === 'road') {
        // У автовокзала посты — места у перронов: автобус встаёт между двумя перронами.
        const terminal = isBusTerminal(st);
        const more = g.stationBaysPlan(st.id, st.bays + 1);
        const plusTip = more.ok ? `${terminal ? 'Добавить перрон' : 'Добавить пост погрузки'} · ${money(STATION.bayCost)}` : (more.reason ?? '');
        baysRow = `<div class="icon-row"><span class="lbl2">${terminal ? 'Перроны' : 'Посты погрузки'}</span>
          <span class="stepper bays"><button data-action="st-bays" data-id="${st.id}" data-d="-1" ${st.bays > STATION.minBays ? '' : 'disabled'}
            data-tip="${terminal ? 'Убрать перрон' : 'Убрать пост'} · вернём ${money(STATION.bayCost * COST.refundRatio)}">−</button><b><i class="bays-pic" style="width:${baysSvgWidth(
              STATION.maxBays,
            )}px">${baysSvg(st.bays, g.stationBays(st), 22, terminal)}</i><span>${st.bays}</span></b><button
            data-action="st-bays" data-id="${st.id}" data-d="1" class="${more.ok ? '' : 'off'}" data-tip="${esc(plusTip)}">+</button></span>
          ${more.ok ? `<span class="muted">+${money(STATION.bayCost)}</span>` : ''}</div>`;
        // Длина выезда — «− схема N м +»: станция переезжает в новый конец выезда (нельзя — причина всплывёт).
        const L = g.stationDrivewayLen(st);
        const R = STATION.drivewayRange;
        if (L !== null) {
          baysRow += `<div class="icon-row"><span class="lbl2">Выезд</span>
          <span class="stepper bays tracks"><button data-action="st-drive" data-id="${st.id}" data-d="-1" ${L > R.min ? '' : 'disabled'}
            data-tip="Выезд короче на ${R.step} м — станция ближе к дороге">−</button><b data-tip="Длина выезда от кромки дороги: ${L} м">${drivewaySvg(L, R.max)}<span>${L} м</span></b><button
            data-action="st-drive" data-id="${st.id}" data-d="1" ${L < R.max ? '' : 'disabled'} data-tip="Выезд длиннее на ${R.step} м — станция дальше от дороги">+</button></span></div>`;
        } else if (st.side) {
          baysRow += `<div class="icon-row"><span class="lbl2">Как стоит</span><b class="st-kind" data-tip="Вдоль дороги: посты выходят прямо на карман у края улицы">${stationPlaceSvg('side', 24)}</b></div>`;
        }
      }
      // Пути ж/д станции: схема платформ и «+» — достроить ещё один путь (с ценой или причиной, почему нельзя).
      if (st.kind === 'rail') {
        const more = g.railTrackPlan(st.id);
        const n = st.platforms.length;
        // Со стороны здания не помещается — новый путь ляжет с другой стороны от путей.
        const where = more.side === -1 ? ' с другой стороны от путей' : '';
        const plusTip = more.ok ? `Достроить путь с платформой${where} · ${money(more.cost)}` : (more.reason ?? '');
        baysRow = `<div class="icon-row"><span class="lbl2">Пути</span>
          <span class="stepper bays tracks"><b>${platformsSvg(n)}<span>${n}</span></b><button
            data-action="st-track" data-id="${st.id}" class="${more.ok ? '' : 'off'}" data-tip="${esc(plusTip)}">+</button></span>
          ${more.ok ? `<span class="muted">+${money(more.cost)}</span>` : ''}</div>`;
        // Длина платформ: схема с вагонами, метры и «+» — удлинить на шаг (с ценой или причиной, почему нельзя);
        // рядом — сколько пассажирских и грузовых вагонов встанет (предел состава, как при постановке).
        const ext = g.railExtendPlan(st.id);
        const L = ext.length;
        const fit = platformCars(L);
        const extTip = ext.ok ? `Удлинить платформы до ${ext.next} м · ${money(ext.cost)}` : (ext.reason ?? '');
        baysRow += `<div class="icon-row len-row"><span class="lbl2">Длина</span>
          <span class="stepper bays tracks len"><b data-tip="Длина платформ: ${L} м">${platformLengthSvg(L, RAIL_STATION.maxLength)}<span>${L} м</span></b><button
            data-action="st-extend" data-id="${st.id}" class="${ext.ok ? '' : 'off'}" data-tip="${esc(extTip)}">+</button></span>
          <span class="cars-fit"><span class="car pax" data-tip="Пассажирских вагонов встанет: ${fit.passenger}">${passengerCarSvg(18)}<b>${fit.passenger}</b></span><span
            class="car freight" data-tip="Грузовых вагонов встанет: ${fit.freight}">${freightCarSvg(18)}<b>${fit.freight}</b></span></span>
          ${ext.ok ? `<span class="muted">+${money(ext.cost)}</span>` : ''}</div>`;
      }
      const storageRow = st.kind === 'stop' ? '' : this.storageRowHtml(st);
      // Остановка — только для пассажиров: переключать нечего.
      const servesRow = st.kind === 'stop' ? '' : `<div class="serves-row"><span class="lbl2">Работает с</span>${this.servesHtml(st.serves, 'st-serves', String(st.id))}</div>`;
      // Название — переименовать: клик по нему или по ✎ за ним открывает поле ввода.
      const title =
        this.renamingStation === st.id
          ? `<input class="line-name station-name" data-station-name="${st.id}" value="${esc(st.name)}" maxlength="40" />`
          : `<h3 class="station-title" data-action="rename-station" data-id="${st.id}" title="Нажмите, чтобы переименовать">${esc(st.name)}</h3>
            <button class="icon pencil" data-action="rename-station" data-id="${st.id}" title="Переименовать">✎</button>`;
      return `<section class="detail"><header class="station-head">${title}<button class="icon" data-action="close-sel">✕</button></header>
        <p class="muted">${kind}${busy}</p>
        ${stationWarningsHtml(g, st.id, stationWarnings(g, st), this.controller.warnFocusOn(st.id))}
        ${servesRow}
        ${baysRow}
        ${storageRow}
        ${
          st.serves.cargo || freightWaiting.length
            ? `<div class="icon-row"><span class="lbl2">Груз ждёт</span>${
                freightWaiting.length
                  ? freightWaiting.map(([c, n]) => `<span class="chip-ic">${cargoIcon(c, 18)}<b>${n}</b></span>`).join('')
                  : '<span class="muted">ничего</span>'
              }</div>`
            : ''
        }
        ${this.transferRowHtml(st)}
        ${paxBlock}
        <div class="icon-row"><span class="lbl2">Отправляет</span>${
          supplies.length ? supplies.map((c) => cargoIcon(c, 20)).join('') : pax || st.catchPop ? cargoIcon('passengers', 20) : '<span class="muted">—</span>'
        }</div>
        <div class="icon-row"><span class="lbl2">Принимает</span>${
          st.accepts.size ? [...st.accepts].map((c) => cargoIcon(c, 20)).join('') : '<span class="muted">—</span>'
        }</div>
        <p class="muted">${towns ? `Город: ${esc(towns)} · ` : ''}жителей в охвате ${st.catchPop}</p>
        <div class="actions">${
          st.kind === 'rail'
            ? `<button class="small" data-action="move-station" data-id="${st.id}" data-tip="Станция встанет на другой путь с теми же путями и платформами; маршруты через неё сохранятся">Переместить</button><button
                class="small st-retype" data-action="move-station" data-id="${st.id}" data-terminal="${st.terminal ? 0 : 1}"
                data-tip="${st.terminal ? 'Перенести проходной: пути насквозь, поезда идут дальше' : 'Перенести конечной: к тупику пути или в поле, пути кончатся упорами'}">${
                  st.terminal ? throughStationSvg(26) : terminalStationSvg(26)
                }<span>${st.terminal ? 'Проходной' : 'Конечной'}</span></button>`
            : `<button class="small" data-action="move-station" data-id="${st.id}" title="Станция встанет у другой дороги; маршруты через неё сохранятся">Переместить</button>`
        }</div></section>`;
    }
    if (sel.type === 'industry') {
      const ind = g.industries.find((i) => i.id === sel.id);
      if (!ind) return '';
      const info = ind.info;
      const recipe = `${info.accepts.map((c) => cargoIcon(c, 26)).join('<span class="plus">+</span>')}${
        info.accepts.length ? '<span class="arrow">→</span>' : ''
      }${cargoIcon(info.produces, 30)}`;
      const stock = info.accepts.length
        ? `<div class="icon-row"><span class="lbl2">На складе</span>${info.accepts
            .map((c) => `<span class="chip-ic">${cargoIcon(c, 18)}<b>${Math.floor(ind.stock[c] ?? 0)}</b></span>`)
            .join('')}</div>`
        : '';
      return `<section class="detail">${head(ind.name)}
        <div class="recipe">${recipe}</div>
        <p class="muted">${
          info.accepts.length > 1
            ? 'Работает, только когда привезли все виды сырья.'
            : info.accepts.length
              ? 'Перерабатывает сырьё, которое ему привозят.'
              : 'Добывает сырьё, когда рядом есть станция с маршрутом.'
        }</p>
        ${stock}
        <div class="kv"><span>Уровень производства</span><b>×${ind.level ?? 1} · до ${g.industryRate(ind)}/мес</b>
          <span>Произведено (прош. мес.)</span><b>${ind.producedLast}</b><span>В этом месяце</span><b>${ind.producedMonth}</b></div>
        <div class="level-bar" title="Растёт, если продукцию регулярно вывозят; падает, если предприятие долго не обслуживают">
          <div style="width:${(((ind.level ?? 1) - 1) / 3) * 100}%"></div></div>
        ${industryRowsHtml(g, ind)}
        ${ind.ruin || ind.build ? '' : annexHtml(ind, this.controller.placingAnnex === ind.id)}
        <p class="tip">Инструментом «Станция» наведите на предприятие: станция встанет вплотную к той стороне, куда указывает курсор, и выезд будет смотреть туда же.</p>
        ${this.partnersHtml(g.partners(ind, 3))}</section>`;
    }
    if (sel.type === 'building') {
      const b = g.buildingById(sel.id);
      if (!b) return '';
      const town = g.townOf(b);
      const kind = b.kind === 'landmark' ? 'Ратуша' : b.kind === 'com' ? 'Офисы и магазины' : 'Жилой дом';
      const people = b.kind === 'res' ? `${b.floors * 14} жителей` : b.kind === 'com' ? `${b.floors * 4} рабочих мест` : 'центр города';
      const moveCost = Math.round(g.demolishCost(b.id) * 0.6) || 3000;
      return `<section class="detail">${head(kind, `${b.floors} эт. · ${people}`)}
        ${town ? `<button class="partner" data-action="focus" data-type="town" data-id="${town.id}">${townIcon(18)}<span>${esc(town.name)}</span><small>${town.population} жит.</small></button>` : ''}
        <div class="actions">
          <button class="small" data-action="move" data-id="${b.id}">Перенести · ${money(moveCost)}</button>
          ${b.kind !== 'landmark' ? `<button class="small danger" data-action="demolish" data-id="${b.id}">Снести · ${money(g.demolishCost(b.id))}</button>` : ''}
        </div>
        <p class="muted">Перенесённое здание встанет вдоль ближайшей улицы. Дорога, проложенная через дома, снесёт их сама.</p></section>`;
    }
    if (sel.type === 'town') {
      const t = g.towns.find((x) => x.id === sel.id);
      if (!t) return '';
      // Норма растёт с населением (world/townSupply.ts): у этого месяца — по нынешнему, у прошлого — его собственная.
      const need = townNeed(t.population);
      const lastNeed = lastTownNeed(t);
      const demands: TownNeed[] = t.demands.map((c) => ({
        cargo: c,
        now: t.supplied[c] ?? 0,
        carried: t.carried?.[c] ?? 0,
        last: t.lastSupplied[c] ?? 0,
        lastNeed,
      }));
      // Свёрнутый блок — одной строкой в заголовке (needsHeadHtml), строки потребностей не нужны.
      const rows = this.needsFolded
        ? ''
        : demands
            .map(({ cargo: c, now, carried, last }) => {
              const open = this.needsOpen.has(`${t.id}:${c}`);
              // Закрытые месяцы и текущий — последним, всего не больше 12 столбиков.
              const months = [
                ...(t.supplyHistory ?? [])
                  .slice(-(TOWN_HISTORY - 1))
                  .map((m) => ({ label: m.label, got: m.got[c] ?? 0, carried: m.carried?.[c] ?? 0, need: m.need })),
                { label: g.dateLabel, got: now, carried, need, current: true },
              ];
              const chart = open ? `<div class="need-chart">${supplyChart(months, CARGO[c].color)}</div>` : '';
              return `<div class="need" data-action="town-need" data-id="${t.id}" data-c="${c}" data-tip="${open ? 'Свернуть' : 'По месяцам'}">${cargoIcon(c, 24)}<div><b>${CARGO[c].name}</b>
            ${supplyBarHtml(now, carried, need, CARGO[c].color)}
            <small>${supplyLineHtml(now, carried, last, need, CARGO[c].color, lastNeed)}</small></div>
            <span class="caret ${open ? '' : 'closed'}">${chevronSvg(10)}</span></div>${chart}`;
            })
            .join('');
      // Пассажиры: хотят ездить по городу и в другие города, сколько довезли линии (game/townPax.ts).
      const tp = townPax(g, t);
      const pax: PaxNeed = {
        ...tp,
        linesHtml: tp.lines
          .map((l) => `<button class="line-kind-btn" data-action="select-line" data-id="${l.id}" data-tip="${esc(l.name)}">${this.lineIcon(l, 16)}</button>`)
          .join(''),
        dests: tp.dests.map((d) => ({
          town: d.town,
          name: g.towns.find((x) => x.id === d.town)?.name ?? 'за город',
          now: d.now,
          waiting: d.waiting,
          linked: d.lines.length > 0 || d.now > 0,
        })),
      };
      const paxRow = this.needsFolded ? '' : paxNeedHtml(pax);
      const faces = { good: '😊', ok: '😐', bad: '😠' };
      const reviews = g
        .townReviews(t)
        .map((r) => `<div class="review ${r.mood}"><span class="face">${faces[r.mood]}</span><span>${esc(r.text)}</span></div>`)
        .join('');
      const auto = t.autoStreets !== false;
      const streets = `<button class="switch-row" data-action="town-streets" data-id="${t.id}" title="Когда вдоль улиц тесно, город сам прокладывает новые и застраивает их">
          <span>🏘️ Строить улицы автоматически</span><span class="switch ${auto ? 'on' : ''}"><i></i></span></button>`;
      return `<section class="detail">${head(t.name, `${t.population} жителей · ${STYLE_NAMES[t.style]}`)}
        ${streets}
        ${townRowsHtml(g, t)}
        <h4>Что говорят жители</h4>${reviews}
        ${needsHeadHtml(demands, need, this.needsFolded, pax)}${rows}${paxRow}
        ${this.partnersHtml(g.partners(t, 2))}</section>`;
    }
    if (sel.type === 'junction') return this.junctionHtml(sel.id);
    const follow = `<button class="small ${this.controller.following ? 'primary' : ''}" data-action="toggle-follow">${
      this.controller.following ? '◉ Камера следует' : '◎ Следовать'
    } <kbd>F</kbd></button>`;
    if (sel.type === 'fleet') {
      const fleet = g.fleet.get(sel.id);
      if (!fleet) return `<section class="detail">${head('Транспорт')}<p class="muted">Продан.</p></section>`;
      const fsim = g.fleetSim(fleet);
      const train = g.fleetTrain(fleet);
      const v = fsim?.v ?? train?.v ?? 0;
      const trip = fsim ? `<span>В пути</span><b>${Math.round(fsim.tripTime)} с, стоял ${Math.round(fsim.stoppedTime)} с</b>` : '';
      return this.fleetCardHtml(fleet, Math.round(v * KMH_PER_UNIT), follow, trip);
    }
    const sim = g.traffic.vehicles.get(sel.simId);
    if (!sim) return `<section class="detail">${head('Машина')}<p class="muted">Доехала.</p></section>`;
    const speed = Math.round(sim.v * KMH_PER_UNIT);
    // Самосвал строительной бригады: чья, куда едет и что строит.
    const crew = g.crewOfSim(sim.id);
    if (crew !== undefined) {
      const b = g.construction.crews.brigades.get(crew);
      const where = g.brigadeWhere(crew);
      const n = b ? g.construction.crews.of(b.base).indexOf(b) + 1 : 0;
      return `<section class="detail">${head(`🚚 Строительная бригада${n ? ` ${n}` : ''}`, b ? `база «${esc(g.baseName(b.base))}»` : undefined)}
      <div class="kv near"><span>Сейчас</span><b>${esc(where?.text ?? '')}</b><span>Скорость</span><b>${speed} км/ч</b><span>Стоял в пробках</span><b>${Math.round(sim.stoppedTime)} с</b></div>
      <div class="actions">${follow}</div></section>`;
    }
    // Спецмашина города: скорая, полиция, пожарная — с мигалкой или без.
    const service = g.serviceOfSim(sim.id);
    if (service) {
      const info = SERVICES[service];
      return `<section class="detail">${head(`${info.icon} ${info.name}`, sim.siren ? '🚨 С мигалкой — ей уступают дорогу' : 'Без мигалки')}
      ${carTripHtml(g, sim.id)}
      <div class="kv near"><span>Скорость</span><b>${speed} км/ч</b><span>В пути</span><b>${Math.round(sim.tripTime)} с</b><span>Стоял в пробках</span><b>${Math.round(sim.stoppedTime)} с</b></div>
      <div class="actions">${follow}</div></section>`;
    }
    return `<section class="detail">${head('Машина жителя')}
      ${carTripHtml(g, sim.id)}
      <div class="kv near"><span>Скорость</span><b>${speed} км/ч</b><span>В пути</span><b>${Math.round(sim.tripTime)} с</b><span>Стоял в пробках</span><b>${Math.round(sim.stoppedTime)} с</b></div>
      <div class="actions">${follow}</div></section>`;
  }

  /**
   * Карточка перекрёстка: светофор и его фазы (правят на карте), главная дорога и связи полос (тоже на карте).
   * Подъезды подписаны сторонами света и стрелками.
   */
  private junctionHtml(id: number): string {
    const g = this.game();
    const info = g.junctionInfo(id);
    const head = `<header><h3>Перекрёсток</h3><button class="icon" data-action="close-sel">✕</button></header>`;
    if (!info) return `<section class="detail">${head}<p class="muted">Перекрёстка больше нет.</p></section>`;
    const n = info.node;
    const lights = n.control === 'lights';
    const check = g.lightsPlan(id);
    const toggle = `<button class="small ${lights ? 'primary' : ''}" data-action="jn-lights" data-id="${id}" ${check.ok ? '' : 'disabled'} title="${esc(check.reason ?? '')}">
      🚦 ${lights ? `Светофор включён · убрать +${money(-check.cost)}` : `Поставить светофор · ${money(check.cost)}`}</button>`;
    const attrs = `data-id="${id}"`;
    let control = '';
    if (lights) {
      const adaptive = n.adaptive !== false;
      // Фазы — плитками со схемой перекрёстка (src/ui/phasesUi.ts); выбранную правят на карте, отказ дать зелёный
      // мигает и здесь, пока не прошло время.
      const pc = this.controller;
      const flash = pc.phaseFlash && pc.phaseFlash.until > performance.now() ? pc.phaseFlash : null;
      control = `<div class="rule-row"><span class="lbl2">Режим</span><div class="opts">
          <button class="opt ${adaptive ? 'active' : ''}" data-action="jn-adaptive" ${attrs} data-v="1" title="Пропускает пустые фазы и держит зелёный, пока никто не ждёт">Умный</button>
          <button class="opt ${!adaptive ? 'active' : ''}" data-action="jn-adaptive" ${attrs} data-v="0" title="Строго по кругу с заданным временем">По таймеру</button></div></div>
        ${phasesHtml(info, id, flash, pc.phaseEdit?.node === id ? pc.phaseEdit.i : null)}`;
    } else if ((n.roundabout ?? null) === null && info.approaches.length >= 3) {
      const manual = n.mainPair;
      const isAuto = manual === undefined || manual === null;
      const isNone = !!manual && manual.length === 0;
      const same = (p: [number, number]) => !!manual && manual.length === 2 && manual.includes(p[0]) && manual.includes(p[1]);
      const now = info.mainNow.map((s) => info.label(s).name).join('–');
      // Значок «Главная дорога» — как жёлтая подсветка и ромбы у въездов на карте.
      const sign = `<svg width="13" height="13" viewBox="0 0 14 14" style="vertical-align:-2px" aria-hidden="true"><path d="M7 .8 13.2 7 7 13.2.8 7Z" fill="#fff" stroke="#1f2933"/><path d="M7 3.6 10.4 7 7 10.4 3.6 7Z" fill="#f5b800"/></svg>`;
      control = `<div class="rule-row"><span class="lbl2">${sign} Главная дорога ${isAuto && now ? `(сейчас ${now})` : ''}</span><div class="opts">
        <button class="opt ${isAuto ? 'active' : ''}" data-action="jn-main" ${attrs} data-v="auto" title="Самая прямая и широкая дорога">Авто</button>
        ${info.pairs
          .map((p) => `<button class="opt ${same(p.segs) ? 'active' : ''}" data-action="jn-main" ${attrs} data-v="${p.segs.join(',')}">${p.name}</button>`)
          .join('')}
        <button class="opt ${isNone ? 'active' : ''}" data-action="jn-main" ${attrs} data-v="none" title="Все уступают по очереди, кто раньше подъехал">Равнозначный</button></div></div>`;
    }
    // Связи полос настраиваются на карте в два шага: белый кружок — въезд, оранжевые — куда с него ехать (так же
    // убирают и возвращают повороты: отдельных кнопок запрета нет). В правке фазы меток полос на карте нет.
    const c = this.controller;
    const second = !!c.laneFrom;
    const steps =
      c.tool === 'lights' && !c.phaseEdit
        ? `<span class="lane-step ${second ? '' : 'now'}" title="Кликните на карте белый кружок — полосу въезда"><b>1</b><i class="lane-dot in"></i></span>
          <span class="lane-arrow">➜</span>
          <span class="lane-step ${second ? 'now' : ''}" title="Оранжевые кружки — куда с неё ехать; повторный клик убирает связь"><b>2</b><i class="lane-dot out"></i></span>`
        : `<button class="small lanes-edit" data-action="jn-lanes-edit" data-tip="Включить инструмент «Перекрёсток» и кликать по полосам">${PENCIL_ICON} Настроить</button>`;
    const lanes = `<div class="rule-row lanes-row"><span class="lbl2">Полосы ${info.customLanes ? `· своих: ${info.customLanes}` : '· авто'}</span>
      <div class="lane-steps">${steps}
        <button class="small" data-action="jn-lanes-reset" ${attrs} ${info.customLanes ? '' : 'disabled'} data-tip="Все полосы — снова автоматически" data-tip-end>↺ Сбросить полосы</button></div></div>`;
    return `<section class="detail">${head}
      <p class="muted">${info.approaches.map((a) => `${a.compass.arrow} ${a.compass.name}`).join(' · ')}</p>
      <div class="actions">${toggle}</div>
      ${control}
      ${lanes}</section>`;
  }

  /** Карточка машины или поезда компании: что везёт (значком и словом), куда едет, прибыль. */
  private fleetCardHtml(v: FleetVehicle, speed: number, follow: string, extra = ''): string {
    const g = this.game();
    const line = g.lines.get(v.lineId);
    const st = line && g.stations.get(line.stops[v.stop]);
    // Название станции — ссылка: камера покажет её на карте, выбор транспорта останется.
    const where = st ? `<button class="place-link" data-action="show-station" data-id="${st.id}" title="Показать на карте">${esc(st.name)}</button>` : '?';
    const hold = g.spacingLeft(v);
    const dispatchIcon = `<button class="icon dispatch" data-action="dispatch-now" data-id="${v.id}" title="Отправить сейчас, не дожидаясь интервала">▶</button>`;
    const state =
      v.state === 'driving'
        ? `едет на ${where}`
        : hold !== null
          ? `<span class="hold" title="Ждёт интервала за предыдущей машиной маршрута, чтобы машины шли равномерно">⏱ ждёт интервала ${Math.ceil(hold)} с</span>${dispatchIcon} ${where}`
          : v.state === 'loading'
            ? `${v.enter ? 'заезжает на пост' : 'погрузка'}: ${where}`
            : `ждёт отправления: ${where}`;
    const load = vehicleLoad(v);
    const cargo = v.cargo
      ? `<span class="chip-ic">${cargoIcon(v.cargo, 20)}<b>${CARGO[v.cargo].name}</b></span>`
      : load
        ? `<span class="chip-ic">${cargoIcon('passengers', 20)}<b>Пассажиры</b></span>`
        : '<span class="muted">пусто</span>';
    // Машина сбоку — как на карточке покупки: грузовик с наливным грузом — автоцистерна.
    const tank = g.isTanker(v);
    const model = MODELS[v.model];
    const art =
      model.mode === 'road'
        ? `<div class="icon-row"><span class="lbl2">Машина</span><span data-tip="${modelName(v.model, tank)} · вместимость ${model.capacity}">${modelSvg(v.model, line?.color, undefined, undefined, tank)}</span></div>`
        : '';
    return `<section class="detail"><header><h3>${esc(g.vehicleTitle(v))}</h3><button class="icon" data-action="close-sel">✕</button></header>
      ${line ? `<button class="line-row" data-action="select-line" data-id="${line.id}">${this.lineIcon(line)}<span>${esc(line.name)}</span></button>` : ''}
      ${art}
      <div class="icon-row"><span class="lbl2">Везёт</span>${cargo}<b>${load}/${vehicleCapacity(v)}</b></div>
      <div class="kv near"><span>Сейчас</span><b>${state}</b><span>Скорость</span><b>${speed} км/ч</b>
        <span title="За прошлый месяц">Прибыль</span><b>${money(v.profitLast)}</b>${extra}</div>
      <div class="actions">${follow}</div></section>`;
  }

  private showScreen(name: ScreenName): void {
    for (const s of SCREENS) this.q(`[data-${s}]`).classList.toggle('hidden', s !== name);
  }

  private hideScreens(): void {
    for (const s of SCREENS) this.q(`[data-${s}]`).classList.add('hidden');
  }

  /** Открыто ли какое-нибудь окно. */
  private anyScreen(): boolean {
    return SCREENS.some((s) => !this.q(`[data-${s}]`).classList.contains('hidden'));
  }

  /** Закрывает открытое окно: меню — продолжить игру, «Новая игра» — назад туда, откуда открыли, итоги — продолжить. */
  private closeModal(): boolean {
    // Таймлапс — поверх итогов и меню: Esc закрывает сначала его.
    if (closeTimelapse()) return true;
    if (this.deletingTemplate) {
      this.deletingTemplate = null;
      this.renderConfirm();
      return true;
    }
    if (!this.q('[data-newgame]').classList.contains('hidden')) {
      this.closeNewGame();
      return true;
    }
    if (!this.q('[data-results]').classList.contains('hidden')) {
      this.continueAfterResults();
      return true;
    }
    if (!this.q('[data-news]').classList.contains('hidden')) {
      this.closeNews();
      return true;
    }
    const inSection = ['[data-menu-saves]', '[data-menu-settings]'].some((s) => !this.q(s).classList.contains('hidden'));
    if (inSection && !this.q('[data-menu]').classList.contains('hidden')) {
      this.menuView('main');
      void this.refreshMenuMain();
      return true;
    }
    if (!this.q('[data-menu]').classList.contains('hidden')) {
      this.hideScreens();
      this.controller.setSpeed(this.speedBeforeMenu);
      return true;
    }
    return false;
  }

  /** «Новая игра» закрыта без создания мира: назад в меню или в окно правил, откуда её открыли. */
  private closeNewGame(): void {
    this.confirmNew = false;
    if (this.newGameFrom === 'start') this.showScreen('start');
    else this.showMenu();
  }

  /** Открывает «Новую игру»: со стартового экрана — сразу сценарий, из меню — режим текущей партии. */
  private openNewGame(from: NewGameFrom): void {
    const d = newGameDraft(this.game().settings, from, this.scenarioOptions, Math.floor(Math.random() * 1e9));
    this.draft = d.settings;
    this.scenarioOptions = d.scenario;
    this.newGameFrom = from;
    this.confirmNew = false;
    this.showScreen('newgame');
    this.renderNewGame();
  }

  /**
   * Начинает новую партию в один клик: текущая сначала сама уходит в сохранения. Не сохранилась — onFail
   * (окно «Новой игры» спросит, начинать ли без неё); force — начать и так.
   */
  private startNewGame(settings: WorldSettings, force = false, onFail?: () => void): void {
    if (this.starting) return;
    this.starting = true;
    void this.session
      .newGame(settings, force)
      .then((ok) => {
        if (ok) this.showWelcome();
        else onFail?.();
      })
      .finally(() => (this.starting = false));
  }

  /**
   * Окно перед стартом только что созданного мира: в песочнице — правила, в сценарии — брифинг.
   * intro — стартовый экран первого запуска: «Начать» в правилах открывает «Новую игру».
   */
  showWelcome(intro = false): void {
    this.intro = intro;
    this.controller.setSpeed(0, true);
    this.renderStart();
    this.showScreen('start');
  }

  private renderStart(): void {
    const g = this.game();
    const body = this.q('[data-start-body]');
    body.classList.toggle('brief', !!g.scenario);
    // Брифинг прокручивается внутри окна: после «Принять» в открытом окне стартовый контракт остаётся на месте.
    const open = !this.q('[data-start]').classList.contains('hidden');
    const scroll = open ? (body.querySelector('[data-brief-scroll]')?.scrollTop ?? 0) : 0;
    body.innerHTML = g.scenario ? briefHtml(g) : rulesHtml(this.intro);
    const el = body.querySelector('[data-brief-scroll]');
    if (el) el.scrollTop = scroll;
  }

  /** Итоговый экран сценария: игра на паузе, результат записывается в рекорды один раз за партию. */
  private showResults(): void {
    const g = this.game();
    const sc = g.scenario;
    if (!sc?.state.score) return;
    if (this.q('[data-results]').classList.contains('hidden')) this.speedBeforeResults = g.speed || 1;
    this.controller.setSpeed(0, true);
    if (this.recordFor !== sc) {
      this.recordFor = sc;
      const slot = slotOf(g.settings);
      // Итоги уже видели (экран открыт снова после перезагрузки) — рекорд только показываем.
      this.record = !slot
        ? { best: null, previous: null, isNew: false }
        : sc.state.seen
          ? { best: getBest(slot), previous: null, isNew: false }
          : saveBest(slot, sc.state.score);
    }
    this.q('[data-results-body]').innerHTML = resultsHtml(g, this.record);
    this.showScreen('results');
  }

  /** Сценарий закончился, итоги ещё не показаны и другие окна закрыты — показать. */
  private checkResults(): void {
    const sc = this.game().scenario;
    if (!sc || sc.running || sc.state.seen || this.anyScreen()) return;
    this.showResults();
  }

  /** «Продолжить в песочнице»: итоги просмотрены, игра идёт дальше без заданий. */
  private continueAfterResults(): void {
    const sc = this.game().scenario;
    if (sc && !sc.running) sc.state.seen = true;
    this.hideScreens();
    this.controller.setSpeed(this.speedBeforeResults);
    this.lastScenario = '';
  }

  /** Сложность, испытание или регион сценария на экране новой игры. */
  private setScenarioOption(patch: Partial<ScenarioSettings>): void {
    const next: ScenarioSettings = { ...this.scenarioOptions, ...patch };
    if (!next.pick) delete next.pick;
    this.scenarioOptions = next;
    this.draft = { ...this.draft, scenario: { ...next } };
    this.renderNewGame();
  }

  /** Кнопка «Меню» или Esc: пауза, меню; закрытое меню вернёт прежнюю скорость. */
  private openMenu(): void {
    this.speedBeforeMenu = this.game().speed || 1;
    this.controller.setSpeed(0, true);
    this.showMenu();
  }

  private showMenu(): void {
    const g = this.game();
    const s = g.settings;
    this.q('[data-menu-info]').textContent = `${g.dateLabel} · ${BIOMES[g.terrain.biome].name.toLowerCase()}, карта «${MAP_SIZES[s.size].name.toLowerCase()}», ${g.towns.length} городов · seed ${s.seed}`;
    const n = g.journal.entries.length;
    this.q('[data-journal-count]').textContent = `${n.toLocaleString('ru-RU')} ${plural(n, 'запись', 'записи', 'записей')} · скачать для разбора`;
    syncTimelapseItem(this.q('[data-timelapse-menu]'), g);
    this.confirmSave = null;
    this.menuView('main');
    this.showScreen('menu');
    void this.refreshMenuMain();
  }

  /** Меню: главное (продолжить, сохранить, разделы), раздел сохранений или настроек. */
  private menuView(view: 'main' | 'saves' | 'settings'): void {
    this.q('[data-menu-main]').classList.toggle('hidden', view !== 'main');
    this.q('[data-menu-saves]').classList.toggle('hidden', view !== 'saves');
    this.q('[data-menu-settings]').classList.toggle('hidden', view !== 'settings');
  }

  /** Подписи в главном меню: куда запишет «Сохранить» и сколько сохранений в разделе. */
  private async refreshMenuMain(saved?: string): Promise<void> {
    this.saves = await this.session.list().catch(() => []);
    const linked = this.session.linked();
    const entry = linked ? this.saves.find((x) => x.id === linked) : undefined;
    this.q('[data-save-target]').textContent = saved ? `✓ Сохранено: «${saved}»` : entry ? `Поверх «${entry.name}»` : 'Новым сохранением';
    this.q('[data-save-target]').classList.toggle('done', !!saved);
    const n = this.saves.length;
    this.q('[data-saves-count]').textContent = n ? `${n} ${plural(n, 'партия', 'партии', 'партий')} · файлы` : 'Пока нет · открыть из файла';
  }

  /** Имя для нового сохранения: из поля, иначе — крупнейший город и дата. */
  private saveName(): string {
    return this.q<HTMLInputElement>('[data-save-name]')?.value.trim() || this.defaultSaveName();
  }

  private defaultSaveName(): string {
    return defaultSaveName(this.game());
  }

  /** Список сохранений со своими именами: загрузить, удалить; текущее отмечено. fresh — новое имя в поле. */
  private async renderSaves(fresh = false): Promise<void> {
    const el = this.q('[data-saves]');
    const typed = fresh ? '' : (this.q<HTMLInputElement>('[data-save-name]')?.value ?? '');
    this.saves = await this.session.list().catch(() => []);
    const linked = this.session.linked();
    const when = (t: number) => new Date(t).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const rows = this.saves
      .map((s) => {
        const old = s.version !== SAVE_VERSION;
        const load =
          this.confirmSave === `load:${s.id}`
            ? `<button class="small danger-fill" data-action="save-load" data-id="${s.id}" title="Текущая партия не сохранена в список и пропадёт">Точно загрузить?</button>`
            : `<button class="small" data-action="save-load" data-id="${s.id}" ${old ? 'disabled title="Сохранение от другой версии игры"' : ''}>Загрузить</button>`;
        const del =
          this.confirmSave === `del:${s.id}`
            ? `<button class="small danger-fill" data-action="save-del" data-id="${s.id}">Удалить?</button>`
            : `<button class="icon" data-action="save-del" data-id="${s.id}" title="Удалить сохранение">✕</button>`;
        return `<div class="save-row ${s.id === linked ? 'current' : ''}">
          <div class="save-info"><b>${esc(s.name)}</b><small>${esc(s.summary)} · ${when(s.savedAt)}${s.id === linked ? ' · текущая партия' : ''}</small></div>
          ${load}${del}</div>`;
      })
      .join('');
    el.innerHTML = `<div class="save-new"><input class="line-name" data-save-name maxlength="40" placeholder="${esc(this.defaultSaveName())}" value="${esc(typed)}" />
        <button class="small" data-action="save-new">Сохранить как новое</button></div>
      <div class="save-list">${rows || '<p class="muted">Своих сохранений пока нет: «Сохранить» в меню запишет партию сюда.</p>'}</div>`;
  }

  /** Форма параметров нового мира. */
  private renderNewGame(): void {
    const d = this.draft;
    const chips = <T extends string | number>(key: string, current: T, options: { v: T; name: string; hint?: string }[]) =>
      options
        .map(
          (o) =>
            `<button class="ng-chip ${o.v === current ? 'active' : ''}" data-action="ng-set" data-key="${key}" data-v="${o.v}">${o.name}${
              o.hint ? `<small>${o.hint}</small>` : ''
            }</button>`,
        )
        .join('');
    const sizes = (Object.keys(MAP_SIZES) as MapSize[]).map((k) => {
      const m = MAP_SIZES[k];
      return { v: k, name: `${mapSvg(m.w, m.h)}${m.name}`, hint: `${((m.w * 0.6) / 1000).toFixed(1)} × ${((m.h * 0.6) / 1000).toFixed(1)} км` };
    });
    // В сценарии города, предприятия и капитал задаёт регион — эти строки скрыты.
    const sc = d.scenario;
    const slot = sc ? slotOf(d) : null;
    const sandboxRows = `<div class="ng-row"><span class="ng-label">Города</span>
        <span class="stepper big"><button data-action="ng-towns" data-d="-1">−</button><b>${townIcon(18)} ${d.towns}</b><button data-action="ng-towns" data-d="1">+</button></span></div>
      <div class="ng-row"><span class="ng-label">Предприятия</span><div class="ng-options">${chips(
        'industries',
        d.industries,
        (Object.keys(INDUSTRY_DENSITY) as IndustryDensity[]).map((k) => ({ v: k, name: INDUSTRY_DENSITY[k].name })),
      )}</div></div>`;
    const capitalRow = `<div class="ng-row"><span class="ng-label">Капитал</span><div class="ng-options">${chips(
      'money',
      d.money,
      MONEY_OPTIONS.map((o) => ({ v: o.value, name: o.name, hint: money(o.value) })),
    )}</div></div>`;
    const body = this.q('[data-newgame-body]');
    body.classList.toggle('wide', !!sc);
    body.innerHTML = `
      <h2>Новая игра</h2>
      <div class="ng-row"><span class="ng-label">Режим</span>${modeTilesHtml(!!sc)}</div>
      ${sc ? scenarioOptionsHtml(sc) : ''}
      <div class="ng-row"><span class="ng-label">Карта</span><div class="ng-options">${chips('size', d.size, sizes)}</div></div>
      ${biomeRowHtml(d.biome ?? biomeForSeed(d.seed))}
      ${sc ? '' : sandboxRows}
      <div class="ng-row"><span class="ng-label">Вода</span><div class="ng-options">${chips(
        'water',
        d.water,
        (Object.keys(WATER) as WaterAmount[]).map((k) => ({ v: k, name: `${waterSvg(k)}${WATER[k].name}` })),
      )}</div></div>
      <div class="ng-row"><span class="ng-label">Рельеф</span><div class="ng-options">${chips(
        'relief',
        d.relief ?? 'hills',
        (Object.keys(RELIEF) as Relief[]).map((k) => ({ v: k, name: `${reliefSvg(k)}${RELIEF[k].name}` })),
      )}</div></div>
      ${sc ? '' : capitalRow}
      ${buildModeRowHtml(d.construction)}
      ${industryModeRowHtml(d.industryMode)}
      <div class="ng-row"><span class="ng-label">Seed</span>
        <input class="ng-seed" data-ng-seed value="${d.seed}" inputmode="numeric" />
        <button class="secondary small" data-action="ng-seed" data-tip="Случайный мир">🎲</button></div>
      ${slot ? recordRowHtml(getBest(slot)) : ''}
      <div class="actions ng-actions">
        <button class="secondary" data-action="ng-cancel">Отмена</button>
        <button class="primary ${this.confirmNew ? 'danger-fill' : ''}" data-action="ng-create">${
          this.confirmNew ? 'Партия не сохранилась. Начать всё равно?' : sc ? 'Начать сценарий' : 'Создать мир'
        }</button>
      </div>`;
  }

  /**
   * Списки «куда везти» и «откуда везти» с переходом к партнёру. Заголовок сворачивает список:
   * у свёрнутого — число партнёров и значки их грузов.
   */
  private partnersHtml(list: Partner[]): string {
    const row = (p: Partner) => `<button class="partner" data-action="focus" data-type="${p.ref.type}" data-id="${p.ref.id}">
        ${cargoIcon(p.cargo, 18)}${p.ref.type === 'town' ? townIcon(18) : ''}<span>${esc(p.name)}</span><small>${(p.distance * 0.0006).toFixed(1)} км</small></button>`;
    const block = (dir: 'out' | 'in', title: string) => {
      const items = list.filter((p) => p.direction === dir);
      if (!items.length) return '';
      const folded = this.partnersFolded.has(dir);
      const icons = folded ? `<span class="fold-icons">${[...new Set(items.map((p) => p.cargo))].map((c) => cargoIcon(c, 16)).join('')}</span>` : '';
      return `<button class="fold-head" data-action="toggle-partners" data-dir="${dir}" title="${folded ? 'Развернуть' : 'Свернуть'} список">
          <h4>${title}</h4><span class="fold-count">${items.length}</span>${icons}<span class="caret ${folded ? 'closed' : ''}">${chevronSvg(10)}</span></button>${
            folded ? '' : items.map(row).join('')
          }`;
    };
    return block('out', 'Куда везти') + block('in', 'Откуда везти');
  }

  toggleChains(): void {
    const el = this.q('[data-chains]');
    const show = el.classList.contains('hidden');
    el.classList.toggle('hidden', !show);
    if (show) el.innerHTML = this.chainsHtml();
    else this.controller.highlight = [];
    if (show) this.q('[data-advisor]').classList.add('hidden');
    this.sync();
    this.renderScenario();
  }

  // ---------- Советник ----------

  /** Советы, которые игрок не скрыл. */
  private advice(): Advice[] {
    return adviceOf(this.game()).filter((a) => !this.hiddenAdvice.has(a.key));
  }

  /** Окно «События»: пауза на время чтения, всё в нём — прочитано; новое с прошлого раза — подсвечено. */
  openNews(): void {
    if (!this.q('[data-news]').classList.contains('hidden')) return;
    const g = this.game();
    this.speedBeforeNews = g.speed;
    this.controller.setSpeed(0, true);
    const unread = g.news.entries.length - g.news.unread;
    this.newsUnreadFrom = g.news.entries[unread]?.n ?? Infinity;
    this.showScreen('news');
    this.renderNews(true);
  }

  /** Закрыть «События» — время идёт с прежней скоростью. */
  closeNews(): void {
    if (this.q('[data-news]').classList.contains('hidden')) return;
    this.q('[data-news]').classList.add('hidden');
    this.controller.setSpeed(this.speedBeforeNews, true);
  }

  /** Число непрочитанного на колокольчике; окно открыто — его записи (новое, пока оно открыто, — сразу прочитано). */
  private renderNews(force = false): void {
    const g = this.game();
    const open = !this.q('[data-news]').classList.contains('hidden');
    if (open) g.news.markRead();
    const badge = newsBadge(g.news.unread);
    if (badge !== this.lastNewsBadge) {
      this.lastNewsBadge = badge;
      const b = this.q('[data-news-badge]');
      b.textContent = badge;
      b.classList.toggle('hidden', !badge);
      b.parentElement!.dataset.tip = badge ? `История уведомлений: новых — ${badge}` : 'История уведомлений';
    }
    if (!open) return;
    const html = newsHtml(g, { kinds: this.newsKinds, unreadFrom: this.newsUnreadFrom });
    if (!force && html === this.lastNews) return;
    this.lastNews = html;
    const body = this.q('[data-news-body]');
    const list = body.querySelector('.news-list');
    const scroll = list?.scrollTop ?? 0;
    body.innerHTML = html;
    // Перерисовка (новая запись, фильтр) — список остаётся на месте.
    if (!force) body.querySelector('.news-list')!.scrollTop = scroll;
  }

  /**
   * К объекту из уведомления или записи «Событий»: первый, что ещё есть на карте, — камера к нему и его карточка
   * (предприятие, город, станция, маршрут, проект, база); таких нет — к месту at.
   */
  private goTo(refs: readonly NewsRef[], at?: Notice['at']): void {
    const g = this.game();
    const c = this.controller;
    for (const ref of refs) {
      const t = newsTarget(g, ref);
      if (!t) continue;
      c.showPlace(t.pos, t.r);
      if (ref.type === 'line') {
        c.select(null);
        c.selectLine(ref.id);
      } else {
        c.select({ type: ref.type, id: ref.id });
      }
      return;
    }
    if (at) c.showPlace(at.pos, at.r);
  }

  /** Панель советника — на месте «Финансов» и «Цепочек» (они закрываются), панель сценария прячется. */
  toggleAdvisor(): void {
    const el = this.q('[data-advisor]');
    const show = el.classList.contains('hidden');
    el.classList.toggle('hidden', !show);
    if (show) {
      this.q('[data-finance]').classList.add('hidden');
      if (!this.q('[data-chains]').classList.contains('hidden')) this.toggleChains();
    }
    this.lastAdvisor = '';
    this.renderAdvisor();
    this.renderScenario();
  }

  /** Число на кнопке «Советы» и, если панель открыта, сама панель. */
  private renderAdvisor(): void {
    const list = this.advice();
    const badge = adviceBadge(list);
    const key = `${badge.n}:${badge.level}`;
    if (key !== this.lastAdviceBadge) {
      this.lastAdviceBadge = key;
      const b = this.q('[data-advice-badge]');
      b.textContent = String(badge.n);
      b.className = `advice-badge ${badge.level ?? ''} ${badge.n ? '' : 'hidden'}`;
      const btn = b.parentElement!;
      btn.dataset.tip = badge.n ? `Советник: ${badge.n} — что мешает сети работать` : 'Советник: что мешает сети работать';
    }
    const el = this.q('[data-advisor]');
    if (el.classList.contains('hidden') || this.pressing) return;
    const html = advisorHtml(this.game(), list);
    if (html !== this.lastAdvisor) {
      el.innerHTML = html;
      this.lastAdvisor = html;
    }
  }

  /** «Показать»: камера к месту совета; маршрут — выбрать, предприятие — выделить. */
  private showAdvice(key: string): void {
    const a = this.advice().find((x) => x.key === key);
    if (!a?.at) return;
    const c = this.controller;
    const st = a.station !== undefined ? this.game().stations.get(a.station) : undefined;
    const ind = a.industry !== undefined ? this.game().industries.find((i) => i.id === a.industry) : undefined;
    c.showPlace(a.at, st ? footprintRadius(st.fp) : ind ? footprintRadius(ind.fp) : 60);
    if (ind) c.select({ type: 'industry', id: ind.id });
    else if (a.line !== undefined) c.selectLine(a.line);
  }

  /** Быстрое действие совета: купить или продать машину, поднять максимум авто-парка, добавить пост, взять кредит. */
  private fixAdvice(key: string): void {
    const fix = this.advice().find((x) => x.key === key)?.fix;
    if (fix) this.applyFix(fix);
  }

  /** Быстрое действие предупреждения из карточки станции (то же, что у советника, и «+1 пост» у очереди «нет мест»). */
  private fixWarning(station: number, key: string): void {
    const st = this.game().stations.get(station);
    const fix = st && stationWarnings(this.game(), st).find((w) => w.key === key)?.fix;
    if (fix) this.applyFix(fix);
  }

  private applyFix(fix: AdviceFix): void {
    const g = this.game();
    switch (fix.kind) {
      case 'route': {
        // Новый маршрут — уже с этой станцией первой: дальше клик по получателю.
        const c = this.controller;
        c.setTool('line');
        c.lineDraft = [fix.station];
        c.onChange();
        break;
      }
      case 'buy': {
        const line = g.lines.get(fix.line);
        const v = line && g.buyVehicle(line.id, g.autoModel(line));
        if (!v) g.notify('Не хватает денег');
        else g.fitAutoRange(v.lineId);
        break;
      }
      case 'sell': {
        const line = g.lines.get(fix.line);
        const v = line && g.spareOf(line);
        if (v) {
          g.sellVehicle(v.id);
          g.fitAutoRange(fix.line);
        }
        break;
      }
      case 'autoMax': {
        const auto = g.lines.get(fix.line)?.auto;
        if (auto) g.setLineAuto(fix.line, { max: auto.max + 2 });
        break;
      }
      case 'bay': {
        const st = g.stations.get(fix.station);
        const problem = st && g.setStationBays(st.id, st.bays + 1);
        if (problem) g.notify(problem);
        break;
      }
      case 'depot':
        // «+ склад» — ставим здание склада рядом со станцией: режим размещения на карте.
        this.controller.startWarehouse(fix.station);
        break;
      case 'loan':
        if (!g.takeLoan()) g.notify('Кредит уже на пределе');
        this.lastFinance = '';
        break;
      case 'base':
        // «＋ База» советника: ставим базу, а на месте советника — вкладка «Стройка» с нажатой «＋ База».
        this.controller.startBase();
        this.openLeftTab('build', true);
        this.refreshLeft();
        break;
    }
    this.lastAdvisor = '';
  }

  /** Панель цепочек: для каждого груза — кто производит и кому он нужен. */
  private chainsHtml(): string {
    const g = this.game();
    const chip = (kind: string, cargo: CargoType, name: string, count: number) =>
      `<button class="ind-chip" data-action="chain-kind" data-kind="${kind}" title="Показать на карте (${count} шт.)">${cargoIcon(cargo, 18)}${esc(name)}</button>`;
    // Только грузы и предприятия этой карты: у каждого биома свои цепочки. Сырьё — первым.
    const present = new Set(g.industries.map((i) => i.info.kind));
    const isRaw = (c: CargoType) => producersOf(c).every((t) => !t.accepts.length);
    const cargo = cargoOnMap(g.industries, g.towns).sort((a, b) => Number(isRaw(b)) - Number(isRaw(a)));
    const rows = cargo.map((c) => {
      const producers = producersOf(c)
        .filter((t) => present.has(t.kind))
        .map((t) => chip(t.kind, t.produces, t.name, g.industries.filter((i) => i.info.kind === t.kind).length))
        .join('');
      const consumers = consumersOf(c)
        .filter((t) => present.has(t.kind))
        .map((t) => chip(t.kind, t.produces, t.name, g.industries.filter((i) => i.info.kind === t.kind).length));
      const towns = g.towns
        .filter((t) => t.demands.includes(c))
        .map((t) => `<button class="ind-chip town" data-action="focus" data-type="town" data-id="${t.id}">${townIcon(18)}${esc(t.name)}</button>`);
      return `<div class="chain-row"><div class="cell">${producers}</div>
        <div class="cargo-cell">${cargoIcon(c, 28)}<span>${CARGO[c].name}</span></div>
        <div class="cell">${[...consumers, ...towns].join('') || '<span class="muted">—</span>'}</div></div>`;
    }).join('');
    const biome = BIOMES[g.terrain.biome];
    return `<header><h3>Цепочки производства</h3><span class="chain-biome" data-tip="${esc(biome.pitch)}">${biomeSvg(biome.id, 32, 22)}${esc(biome.name)}</span><button class="icon" data-action="chains">✕</button></header>
      <p class="muted">Слева — кто производит груз, справа — куда его везти. Сырьё нужно заводам, готовая продукция — городам.
      Клик по названию подсветит предприятия на карте.</p>
      <div class="chain-head"><span>Производит</span><span>Груз</span><span>Принимает</span></div>${rows}`;
  }

  update(realDt: number): void {
    const g = this.game();
    this.minimap.update(realDt);
    this.q('[data-money]').textContent = money(g.money);
    this.q('[data-money]').classList.toggle('negative', g.money < 0);
    // Резерв стройки — рядом с подписью «Деньги»: «🔒 $40 000» (на счёте, но отложено на проекты).
    const reserved = g.reserved;
    const res = this.q('[data-reserve]');
    const resText = reserved > 0 ? `🔒 ${money(reserved)}` : '';
    if (res.textContent !== resText) {
      res.textContent = resText;
      res.classList.toggle('hidden', !resText);
    }
    const balance = g.incomeMonth - g.expensesMonth;
    const bal = this.q('[data-balance]');
    bal.textContent = `${balance >= 0 ? '+' : ''}${money(balance)}`;
    bal.classList.toggle('negative', balance < 0);
    this.q('[data-fleet]').textContent = `${g.fleet.size} / жит. ${g.citizenCars}`;
    this.q('[data-date]').textContent = g.dateLabel;
    this.q('[data-month]').style.width = `${g.monthProgress * 100}%`;

    const notices = this.q('[data-notices]');
    const key = g.notices.map((n) => n.text + Math.floor(n.age)).join('|');
    if (notices.dataset.key !== key) {
      notices.dataset.key = key;
      notices.innerHTML = g.notices
        .map((n, i) =>
          // С местом (достроенная улица) или объектом (предприятие, город, маршрут) — кнопкой: клик ведёт туда.
          n.at || n.refs?.some((r) => newsTarget(g, r))
            ? `<div class="notice go" data-action="notice-go" data-id="${i}" data-tip="Показать на карте" style="opacity:${Math.min(1, (6 - n.age) / 1.5)};${n.color ? `border-left-color:${n.color}` : ''}">${esc(n.text)} <span class="notice-go-ic">📍</span></div>`
            : `<div class="notice" style="opacity:${Math.min(1, (6 - n.age) / 1.5)};${n.color ? `border-left-color:${n.color}` : ''}">${esc(n.text)}</div>`,
        )
        .join('');
    }
    this.renderNews();
    this.panelTimer -= realDt;
    if (this.panelTimer <= 0) {
      this.panelTimer = 0.3;
      this.renderSide();
      this.renderFinance();
      this.renderAdvisor();
      this.renderScenario();
      this.renderOfferBanner();
      this.syncPause();
      this.checkResults();
      // Проект: цена и «хватит ли денег» меняются и без кликов (доход, рост городов).
      if (this.controller.projectOn) this.renderOptions();
    }
  }

  private lastOfferBanner = '';

  /** Плашка предложения вверху — напоминает о предложениях на вкладке «События»; пока она есть, уведомления опускаются под неё. */
  private renderOfferBanner(): void {
    if (this.pressing) return;
    const el = this.q('[data-offer-banner]');
    const html = offerBannerHtml(this.game());
    if (html === this.lastOfferBanner) return;
    this.lastOfferBanner = html;
    el.innerHTML = html;
    el.classList.toggle('hidden', !html);
    this.root.classList.toggle('has-offer-banner', !!html);
  }

  /**
   * Плашка предложения — вверху между панелью денег и кнопками скорости (границы — в --ob-left и --ob-right).
   * Если там тесно, она спускается во второй ряд, до правой панели (класс offer-low, граница — --ob-low-right);
   * негде и там — прячется (offer-none): предложения остаются на вкладке «События».
   */
  private placeOfferBanner(): void {
    const box = this.root.getBoundingClientRect();
    const stats = this.q('.stats').getBoundingClientRect();
    const speed = this.q('[data-speed]').getBoundingClientRect();
    const side = this.q('[data-side]').getBoundingClientRect();
    const left = Math.round(stats.right - box.left + 14);
    const right = Math.round(box.right - speed.left + 14);
    const lowRight = Math.round(box.right - (side.width ? side.left : speed.left) + 14);
    this.root.style.setProperty('--ob-left', `${left}px`);
    this.root.style.setProperty('--ob-right', `${right}px`);
    this.root.style.setProperty('--ob-low-right', `${lowRight}px`);
    const low = box.width - left - right < 400;
    this.root.classList.toggle('offer-low', low);
    // Во втором ряду плашка начинается за панелью сценария (358px — см. .offer-low .offer-banner).
    this.root.classList.toggle('offer-none', low && box.width - 358 - lowRight < 300);
  }

  /**
   * С плашки вверху — к предложениям на вкладке «События» левой панели: «Финансы», «Цепочки» и советника закрыть
   * (они на её месте), раскрыть подробности предложения (без id — просто к списку) и коротко подсветить, где оно.
   */
  private showOffer(id?: string): void {
    this.openLeftTab('events', true);
    if (id) this.whyOpen.add(id);
    this.refreshLeft();
    this.renderScenario();
    const panel = this.q('[data-scenario]');
    const card = id ? panel.querySelector<HTMLElement>(`[data-offer="${id}"]`) : null;
    const target = card ?? panel.querySelector<HTMLElement>('.sc-offers') ?? panel;
    target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    target.classList.remove('flash');
    void target.offsetWidth;
    target.classList.add('flash');
    target.addEventListener('animationend', () => target.classList.remove('flash'), { once: true });
  }

  /** Левую панель перерисовать сразу: клик уже отпущен, ждать следующего обновления (0,3 с) незачем. */
  private refreshLeft(): void {
    this.pressing = false;
    this.lastScenario = '';
  }

  /**
   * Вкладка левой панели (запоминается). reveal — показать саму панель: «Финансы», «Цепочки» и советник на её
   * месте закрываются.
   */
  private openLeftTab(tab: LeftTab, reveal = false): void {
    this.leftTab = tab;
    localStorage.setItem('roads.leftTab', tab);
    if (reveal) {
      this.q('[data-finance]').classList.add('hidden');
      this.q('[data-advisor]').classList.add('hidden');
      if (!this.q('[data-chains]').classList.contains('hidden')) this.toggleChains();
    }
  }

  /** Свернуть левую панель до заголовка, вкладок и компактной строки (запоминается). */
  private setLeftCollapsed(on: boolean): void {
    this.scenarioCollapsed = on;
    localStorage.setItem('roads.scenarioCollapsed', on ? '1' : '0');
  }

  toggleFinance(): void {
    const el = this.q('[data-finance]');
    el.classList.toggle('hidden');
    if (!el.classList.contains('hidden')) this.q('[data-advisor]').classList.add('hidden');
    this.lastFinance = '';
    this.renderFinance();
    this.renderScenario();
  }

  /** Вкладка, которую левая панель показывала в прошлый раз: сменилась — прокрутка к началу. */
  private shownTab: LeftTab | null = null;

  /**
   * Левая панель под деньгами — вкладки «Сценарий», «События» и «Стройка» (leftPanelHtml): есть, если в партии
   * сценарий или стройка. «Финансы», «Цепочки» и советник открываются на том же месте — пока они открыты, панель
   * спрятана.
   */
  private renderScenario(): void {
    const el = this.q('[data-scenario]');
    const g = this.game();
    // Настройка «Задания без сроков» (Меню → Настройки) — в игру: выключили — идей нет, вкладки тоже.
    g.ideas.setEnabled(prefOn('ideas'));
    const tab = leftTab(g, this.leftTab);
    const show =
      tab !== null &&
      this.q('[data-finance]').classList.contains('hidden') &&
      this.q('[data-chains]').classList.contains('hidden') &&
      this.q('[data-advisor]').classList.contains('hidden');
    el.classList.toggle('hidden', !show);
    if (!show || this.pressing) return;
    const sel = this.controller.selection;
    const html = leftPanelHtml(g, {
      collapsed: this.scenarioCollapsed,
      open: this.whyOpen,
      confirmAdvance: this.confirmAdvance,
      tab,
      build: { placing: this.controller.placingBase, project: sel?.type === 'project' ? sel.id : null, base: sel?.type === 'base' ? sel.id : null },
    });
    if (html !== this.lastScenario) {
      el.innerHTML = html;
      this.lastScenario = html;
      if (tab !== this.shownTab) el.scrollTop = 0;
      this.shownTab = tab;
    }
  }

  private lastFinance = '';

  private renderFinance(): void {
    const el = this.q('[data-finance]');
    if (el.classList.contains('hidden')) return;
    const html = this.financeHtml();
    if (html !== this.lastFinance) {
      el.innerHTML = html;
      this.lastFinance = html;
    }
  }

  /**
   * Финансы: статьи доходов и расходов за этот и прошлый месяц, график за год
   * и линии от самой прибыльной до самой убыточной — чтобы сразу видеть, куда уходят деньги.
   */
  private financeHtml(): string {
    const g = this.game();
    const last = g.history[g.history.length - 1];
    const rows: { kind: keyof Ledger; name: string; sign: 1 | -1 }[] = [
      { kind: 'transport', name: 'Перевозки', sign: 1 },
      { kind: 'sales', name: 'Продажа и возврат за снос', sign: 1 },
      { kind: 'vehicles', name: 'Содержание транспорта', sign: -1 },
      { kind: 'roads', name: 'Ремонт дорог и путей', sign: -1 },
      { kind: 'build', name: 'Строительство', sign: -1 },
      { kind: 'purchases', name: 'Покупка транспорта', sign: -1 },
      { kind: 'interest', name: 'Проценты по кредиту', sign: -1 },
      ...(g.scenario
        ? [
            { kind: 'grants' as const, name: 'Награды и субсидии', sign: 1 as const },
            { kind: 'fines' as const, name: 'Штрафы', sign: -1 as const },
          ]
        : g.ideas.state.done || g.ledger.grants || last?.ledger?.grants
          ? // Песочница: награды заданий без сроков (scenario/ideas.ts) — той же статьёй.
            [{ kind: 'grants' as const, name: 'Награды и субсидии', sign: 1 as const }]
          : []),
    ];
    const cell = (v: number | undefined, sign: number) =>
      v === undefined ? '<td class="muted">—</td>' : `<td class="${v === 0 ? 'muted' : sign > 0 ? 'pos' : 'neg'}">${v === 0 ? '0' : `${sign > 0 ? '+' : '−'}${money(v).replace('$', '$')}`}</td>`;
    const table = rows
      .map((r) => `<tr><td class="ic">${ledgerIcon(r.kind, 20)}</td><td>${r.name}</td>${cell(g.ledger[r.kind], r.sign)}${cell(last?.ledger?.[r.kind], r.sign)}</tr>`)
      .join('');
    const netNow = g.incomeMonth - g.expensesMonth;
    const netLast = last ? last.income - last.expenses : undefined;
    const total = (v: number | undefined) => (v === undefined ? '<td class="muted">—</td>' : `<td class="${v >= 0 ? 'pos' : 'neg'}"><b>${v >= 0 ? '+' : '−'}${money(Math.abs(v))}</b></td>`);
    const chart = incomeChart(g.history.slice(-12).map((m) => ({ label: m.label, income: m.income, expense: m.expenses })));
    const lines = [...g.lines.values()]
      .map((l) => ({ l, p: l.revenueLast - l.costLast }))
      .sort((a, b) => b.p - a.p)
      .map(
        ({ l, p }) => `<button class="line-row" data-action="select-line" data-id="${l.id}">${this.lineIcon(l)}<span>${esc(l.name)}</span>
          <small class="${p >= 0 ? 'pos' : 'neg'}">${p >= 0 ? '+' : '−'}${money(Math.abs(p))}</small></button>`,
      )
      .join('');
    return `<header><h3>Финансы</h3><button class="icon" data-action="finance">✕</button></header>
      <table class="ledger"><tr><th></th><th></th><th>Этот месяц</th><th>Прошлый</th></tr>${table}
        <tr class="sum"><td></td><td>Итого</td>${total(netNow)}${total(netLast)}</tr></table>
      <h4>Кредит</h4>
      <div class="loan"><div><b>${money(g.loan)}</b> <span class="muted">из ${money(g.loanMax)} · ${Math.round(ECONOMY.loanRate * 100)}% в месяц = ${money(
        g.loan * ECONOMY.loanRate,
      )}</span></div>
        <div class="actions"><button class="small" data-action="loan-take" ${g.loan >= g.loanMax ? 'disabled' : ''}>Взять ${money(ECONOMY.loanStep)}</button>
        <button class="small" data-action="loan-repay" ${g.loan <= 0 || g.freeMoney < Math.min(ECONOMY.loanStep, g.loan) ? 'disabled' : ''}>Погасить ${money(
          Math.min(ECONOMY.loanStep, g.loan || ECONOMY.loanStep),
        )}</button></div></div>
      <h4>За год <span class="legend"><i style="background:#3fae6a"></i>доход <i style="background:#e5534b"></i>расход</span></h4>${chart}
      <h4>Маршруты по прибыли за прошлый месяц</h4>${lines || '<p class="muted">Маршрутов пока нет.</p>'}`;
  }

  reset(): void {
    this.lastPanel = '';
    this.lastScenario = '';
    this.lastOfferBanner = '';
    this.whyOpen.clear();
    this.confirmAdvance = false;
    this.hiddenAdvice.clear();
    this.lastAdvisor = '';
    this.lastAdviceBadge = '';
    this.q('[data-chains]').classList.add('hidden');
    this.q('[data-finance]').classList.add('hidden');
    this.q('[data-advisor]').classList.add('hidden');
    this.minimap.reset();
    this.sync(true);
  }
}

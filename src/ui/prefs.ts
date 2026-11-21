/**
 * Настройки интерфейса игрока (Меню → Настройки): как показывать карту, а не каким будет мир (это — настройки мира,
 * src/world/settings.ts). Хранятся в браузере — localStorage 'roads.prefs', JSON-объект `{ имя: вкл }`, общие для всех
 * партий. Новая настройка — одна строка в PREFS (название, пояснение, значок, как по умолчанию) и имя в `Pref`;
 * раздел меню (src/ui/settingsMenu.ts) покажет её сам. Ни от чего в игре не зависит (кроме «Задания без сроков»:
 * её Hud передаёт в `game.ideas`); без браузера (тесты) и с битым хранилищем — всё как по умолчанию.
 */
import { asRecord, readJson, writeJson } from '../core/store';

export type Pref = 'junctionMarks' | 'mapCache' | 'ideas' | 'pedestrians';

/** Описание настройки — строка в разделе «Настройки». */
export interface PrefInfo {
  id: Pref;
  name: string;
  /** Коротко, что меняет, — под названием. */
  hint: string;
  /** Значок слева (SVG). */
  icon: string;
  /** Как без выбора игрока. */
  default: boolean;
}

/** Значок разметки перекрёстков: косой перекрёсток, пустой асфальт в острых углах заштрихован, поворот — пунктиром. */
export function junctionMarksSvg(w = 32, h = 24): string {
  const hatch = (xs: number[], cx: number) =>
    xs.map((x) => {
      const d = (Math.abs(x - cx) / 10) * 3;
      return `<path d="M${x} ${18 - d}V${18 + d}" stroke="#f2c94c" stroke-width="1.3"/>`;
    });
  return `<svg viewBox="0 0 48 36" width="${w}" height="${h}" aria-hidden="true">
    <path d="M3 30L45 6M3 6L45 30" stroke="#646b76" stroke-width="9" stroke-linecap="round"/>
    <path d="M9 18L19 15V21Z M39 18L29 15V21Z" fill="none" stroke="#f2c94c" stroke-width="1.1" stroke-linejoin="round"/>
    ${[...hatch([12, 15, 18], 9), ...hatch([30, 33, 36], 39)].join('')}
    <path d="M6 28.5Q24 17 42 28.5" fill="none" stroke="#fff" stroke-width="1.4" stroke-dasharray="2.5 2"/>
  </svg>`;
}

/** Значок кэша карты: карта плитками 2×2 — дорога и дом, одна плитка готова (сплошная), над ней машина. */
export function mapCacheSvg(w = 32, h = 24): string {
  return `<svg viewBox="0 0 48 36" width="${w}" height="${h}" aria-hidden="true">
    <rect x="4" y="3" width="19" height="14" rx="2" fill="#cfe0b8"/>
    <rect x="25" y="3" width="19" height="14" rx="2" fill="#cfe0b8"/>
    <rect x="4" y="19" width="19" height="14" rx="2" fill="#cfe0b8"/>
    <rect x="25" y="19" width="19" height="14" rx="2" fill="#cfe0b8" stroke="#2f80ed" stroke-width="1.6" stroke-dasharray="3 2"/>
    <path d="M4 22H44" stroke="#646b76" stroke-width="5"/>
    <rect x="9" y="7" width="8" height="6" fill="#d98c5f"/>
    <rect x="31" y="7" width="7" height="6" fill="#d98c5f"/>
    <rect x="12" y="20.4" width="6" height="3.2" rx="1" fill="#f2c94c"/>
  </svg>`;
}

/** Значок заданий без сроков: чашка с паром — «когда будет удобно». */
export function ideasSvg(w = 32, h = 24): string {
  return `<svg viewBox="0 0 48 36" width="${w}" height="${h}" aria-hidden="true">
    <path d="M17 4Q14 7 17 10Q20 13 17 16M24 3Q21 6 24 9Q27 12 24 15M31 4Q28 7 31 10Q34 13 31 16" fill="none" stroke="#b9a58a" stroke-width="1.8" stroke-linecap="round"/>
    <path d="M10 18H38V22Q38 32 24 32Q10 32 10 22Z" fill="#c98a4b"/>
    <path d="M38 20.5Q44 20.5 44 24.5Q44 28.5 37 28" fill="none" stroke="#c98a4b" stroke-width="2.6"/>
    <path d="M14 21H34" stroke="#f3d9b5" stroke-width="1.6" stroke-linecap="round"/>
  </svg>`;
}

/** Все настройки — по порядку в разделе меню. */
export const PREFS: readonly PrefInfo[] = [
  {
    id: 'pedestrians',
    name: 'Пешеходы',
    hint: 'Жители ходят по тротуарам и переходам. Выключите, чтобы снизить нагрузку на игру',
    icon: '<svg viewBox="0 0 48 36" width="32" height="24" aria-hidden="true"><circle cx="26" cy="6" r="4" fill="#ce9067"/><path d="m18 19 5-7 4 7 6 3m-10-9-2 10-7 9m8-10 7 10" fill="none" stroke="#4278a6" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    default: true,
  },
  {
    id: 'junctionMarks',
    name: 'Разметка перекрёстков',
    hint: 'Штриховка пустого асфальта и направляющие на больших перекрёстках',
    icon: junctionMarksSvg(),
    default: true,
  },
  {
    id: 'mapCache',
    name: 'Кэш карты',
    hint: 'Дороги и дома рисуются заранее плитками — кадр легче. Выключите, если карта рисуется с ошибками',
    icon: mapCacheSvg(),
    default: true,
  },
  {
    id: 'ideas',
    name: 'Задания без сроков',
    hint: 'В песочнице и после сценария иногда предлагать дело по ходу игры — без срока и штрафа',
    icon: ideasSvg(),
    default: true,
  },
];

const KEY = 'roads.prefs';

const isPref = (s: string): s is Pref => PREFS.some((p) => p.id === s);

/** Что игрок выбрал и сохранил; битое или чужое значение — ничего. */
function readChosen(): Partial<Record<Pref, boolean>> {
  const out: Partial<Record<Pref, boolean>> = {};
  for (const [k, v] of Object.entries(asRecord(readJson(KEY)))) if (isPref(k) && typeof v === 'boolean') out[k] = v;
  return out;
}

/**
 * Выбор игрока: из хранилища — при загрузке и при смене в другой вкладке; setPref — сюда и в хранилище (не вышло
 * записать — выбор действует до перезагрузки). Настройку спрашивают каждый кадр: хранилище каждый раз не читаем.
 */
let chosen = readChosen();
/** Только на этой странице (`overridePref`): главнее всего. */
const overrides = new Map<Pref, boolean>();
const defaults = new Map(PREFS.map((p) => [p.id, p.default]));
const listeners = new Set<() => void>();

function changed(): void {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch (e) {
      console.error(e);
    }
  }
}

/** Настройка включена: выбор игрока (сохранённый или в этой загрузке), иначе — как по умолчанию. */
export function prefOn(name: Pref): boolean {
  return overrides.get(name) ?? chosen[name] ?? defaults.get(name) ?? false;
}

/**
 * Включить/выключить: сохраняется в localStorage 'roads.prefs' (и для других вкладок), подписчикам — сразу.
 * Временное значение страницы (`overridePref`) снимается: выбор игрока в меню — главнее.
 */
export function setPref(name: Pref, on: boolean): void {
  overrides.delete(name);
  chosen = { ...chosen, [name]: on };
  writeJson(KEY, chosen);
  changed();
}

/**
 * Включить/выключить только на этой странице до перезагрузки — без сохранения: игра в другой вкладке и после
 * перезагрузки его не видит (тестовые страницы, например /test/junctions).
 */
export function overridePref(name: Pref, on: boolean): void {
  overrides.set(name, on);
  changed();
}

/** Подписка на смену настроек; возвращает отписку. */
export function onPrefs(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

// Настройки поменяли в другой вкладке — здесь тоже.
try {
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => {
      if (e.key !== KEY && e.key !== null) return;
      chosen = readChosen();
      changed();
    });
  }
} catch {
  // Без окна — без подписки.
}

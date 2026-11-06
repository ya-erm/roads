/**
 * Настройки интерфейса игрока (Меню → Настройки): как показывать карту, а не каким будет мир (это — настройки мира,
 * src/world/settings.ts). Хранятся в браузере — localStorage 'roads.prefs', JSON-объект `{ имя: вкл }`, общие для всех
 * партий. Новая настройка — одна строка в PREFS (название, пояснение, значок, как по умолчанию) и имя в `Pref`;
 * раздел меню (src/ui/settingsMenu.ts) покажет её сам. Ни от чего в игре не зависит; без браузера (тесты) и с битым
 * хранилищем — всё как по умолчанию.
 */

export type Pref = 'junctionMarks' | 'mapCache';

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

/** Все настройки — по порядку в разделе меню. */
export const PREFS: readonly PrefInfo[] = [
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
];

const KEY = 'roads.prefs';
/** Прежнее хранилище (его писал только переключатель тестовой страницы): не читаем, при записи убираем. */
const LEGACY_KEY = 'roads.flags';

const isPref = (s: string): s is Pref => PREFS.some((p) => p.id === s);

/** Хранилище браузера или null (тесты в node, запрещённое хранилище). */
function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Что игрок выбрал и сохранил; битое или чужое значение — ничего. */
function readStored(): Partial<Record<Pref, boolean>> {
  const out: Partial<Record<Pref, boolean>> = {};
  try {
    const raw = storage()?.getItem(KEY);
    const obj: unknown = raw ? JSON.parse(raw) : null;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
    for (const [k, v] of Object.entries(obj)) if (isPref(k) && typeof v === 'boolean') out[k] = v;
  } catch {
    // Битое значение — как будто не выбирали.
  }
  return out;
}

/** Только на этой странице (`overridePref`): главнее всего. */
const overrides = new Map<Pref, boolean>();
/** Выбор `setPref` в этой загрузке — на случай, если хранилище недоступно: сохранённое (и из других вкладок) главнее. */
const session = new Map<Pref, boolean>();
/** Итог; null — пересчитать (настройку спрашивают каждый кадр — читать хранилище каждый раз незачем). */
let state: Map<Pref, boolean> | null = null;
const listeners = new Set<() => void>();

function compute(): Map<Pref, boolean> {
  const stored = readStored();
  return new Map(PREFS.map((p) => [p.id, overrides.get(p.id) ?? stored[p.id] ?? session.get(p.id) ?? p.default]));
}

function changed(): void {
  state = null;
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
  state ??= compute();
  return state.get(name) ?? false;
}

/**
 * Включить/выключить: сохраняется в localStorage 'roads.prefs' (и для других вкладок), подписчикам — сразу.
 * Временное значение страницы (`overridePref`) снимается: выбор игрока в меню — главнее.
 */
export function setPref(name: Pref, on: boolean): void {
  overrides.delete(name);
  session.set(name, on);
  const stored = readStored();
  stored[name] = on;
  try {
    const s = storage();
    s?.setItem(KEY, JSON.stringify(stored));
    s?.removeItem(LEGACY_KEY);
  } catch {
    // Хранилище недоступно или переполнено — настройка всё равно переключена до перезагрузки.
  }
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
      if (e.key === KEY || e.key === null) changed();
    });
  }
} catch {
  // Без окна — без подписки.
}

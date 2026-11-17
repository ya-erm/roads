import { TOWN_SCALE } from '../config';
import { hash } from '../core/math';
import { dist, type Vec } from '../core/vec';
import type { HouseForm, Town, TownBuilding, TownDistrict } from './entities';
import type { Footprint } from './spatial';

/**
 * Типы застройки: как выглядит дом города — по месту в городе (см. docs/DESIGN.md, «Застройка городов»).
 *
 * Жители — по дому (settlePeople): в частном доме 3–6 человек, на даче 2–4, в многоквартирном — сколько помещается
 * в его корпус на проектных этажах (по длине корпуса и этажам генерации floors). Жители города — сумма по домам.
 * Выбор детерминирован: место в городе, ярус города (Town.tier) и хеш от id дома, без генератора случайных чисел
 * партии; старые сохранения получают типы и жильцов при загрузке по своим же данным.
 *
 * - Село: частные дома с участками; в большом селе — 1–3 небольших двухэтажных многоквартирных дома у центра;
 *   магазин, склад на краю, храм в центре.
 * - Город: у центра — дома старого центра вдоль улиц и кварталы с дворами-колодцами; дальше — частный сектор,
 *   на самом краю — дачи; гаражи и склады у края; ратуша на площади, школа, больница, рынок.
 * - Новый район (сетка улиц, Town.district): панельные дома с дворами — соседние участки вдоль улицы при
 *   генерации сливаются в один длинный дом (mergeBlocks), этажей — сколько было у слитых, жителей столько же.
 * - Большой город: ещё пятиэтажки вдоль проспектов в среднем кольце и редкие высотки; церковь, вторая школа.
 */

export type TownTier = 'village' | 'town' | 'city';

/**
 * С какого населения село вырастает в город, а город — в большой (Town.tier растёт, но не убывает). Население — по
 * жильцам домов (частный дом — 3–6 человек), поэтому пороги ниже прежних LEGACY_TIER.
 */
export const TOWN_TIER = { town: 1000, city: 6000 } as const;
/**
 * Прежние пороги — когда население считалось по 14 жителей на этаж каждого дома: по ним — ярус городов старых
 * сохранений (у них нет tier, население в сохранении — прежнее) и тестовых сцен без tier.
 */
export const LEGACY_TIER = { town: 2600, city: 7000 } as const;

/** Ярус города: свой (Town.tier) или, у старых сохранений и тестовых сцен, — по населению и прежним порогам. */
export function townTier(town: Pick<Town, 'population' | 'style'> & { tier?: TownTier }): TownTier {
  if (town.tier) return town.tier;
  if (town.population >= LEGACY_TIER.city) return 'city';
  if (town.population >= LEGACY_TIER.town || town.style === 'radial') return 'town';
  return 'village';
}

/** Ярус нового города по размеру генерации (worldgen.townSizes: 1 — малый, 2 — средний, 3 — крупный). */
export function tierOfSize(size: number, style: Town['style']): TownTier {
  if (size >= 3) return 'city';
  return size >= 2 || style === 'radial' ? 'town' : 'village';
}

/** Город дорос до следующего яруса (TOWN_TIER) — ярус растёт; вниз — нет. */
export function growTier(town: Town): void {
  const tier = townTier(town);
  if (tier === 'village' && town.population >= TOWN_TIER.town) town.tier = 'town';
  else if (tier === 'town' && town.population >= TOWN_TIER.city) town.tier = 'city';
  else town.tier = tier;
}

/** Точка внутри рамки нового района (с запасом margin). */
export function inDistrict(d: TownDistrict | undefined, p: Vec, margin = 0): boolean {
  if (!d) return false;
  const c = Math.cos(d.angle);
  const s = Math.sin(d.angle);
  const dx = p.x - d.x;
  const dy = p.y - d.y;
  const u = dx * c + dy * s;
  const v = -dx * s + dy * c;
  return u >= d.u0 - margin && u <= d.u1 + margin && v >= d.v0 - margin && v <= d.v1 + margin;
}

/** Масштаб застройки (config.TOWN_SCALE): участки во столько раз крупнее прежних 22–30 м. */
const S = TOWN_SCALE;

/** Широкий участок — «большой» дом генерации (51–70 м по улице; обычный — 35–48). */
const BIG_W = 31 * S;

/** Тип без места в городе — для домов, которым его не выбрали (тестовые сцены, недозагруженные сохранения). */
export function formOf(b: Pick<TownBuilding, 'form' | 'kind' | 'floors' | 'fp'>): HouseForm {
  if (b.form) return b.form;
  if (b.kind === 'landmark') return 'hall';
  if (b.kind === 'com') return b.fp.w >= BIG_W ? 'office' : 'shop';
  if (b.fp.w >= BIG_W) return 'courtyard';
  return b.floors >= 3 ? 'townhouse' : 'cottage';
}

/** Мощёная площадь вокруг ратуши и храма (render/houseArt: hall, temple) — шире участка на столько метров с каждой стороны. */
export const LANDMARK_YARD = { hall: 7, temple: 6 } as const;

/** Насколько рисунок участка дома выходит за его контур, м: площадь у ратуши и храма; у прочих — нет. */
export function yardOf(b: Pick<TownBuilding, 'form' | 'kind' | 'floors' | 'fp'>): number {
  const form = formOf(b);
  return form === 'hall' || form === 'temple' ? LANDMARK_YARD[form] : 0;
}

/** Название типа — для карточки дома. */
export const FORM_NAMES: Record<HouseForm, string> = {
  cottage: 'Частный дом',
  dacha: 'Дача',
  walkup: 'Многоквартирный дом',
  townhouse: 'Дом старого центра',
  courtyard: 'Квартал с двором',
  slab: 'Панельный дом',
  tower: 'Высотка',
  shop: 'Магазин',
  store: 'Сельский магазин',
  office: 'Офисы',
  market: 'Рынок',
  school: 'Школа',
  hospital: 'Больница',
  church: 'Церковь',
  garages: 'Гаражи',
  warehouse: 'Склад',
  fuel: 'АЗС',
  depot: 'Оптовая база',
  hall: 'Ратуша',
  temple: 'Храм',
};

/** Насколько дом от центра: 0 — в центре, 1 — на краю плотной застройки (дальше — больше 1). */
export function edgeOf(town: Pick<Town, 'center' | 'radius'>, p: Vec): number {
  return dist(p, town.center) / Math.max(1, town.radius);
}

/**
 * Тип дома по месту (без «единственных» — школы, больницы, рынка, церкви: их выбирает pickPublic).
 * k — хеш от id дома: доли типов в одном кольце.
 */
export function placeForm(town: Pick<Town, 'center' | 'radius' | 'population' | 'style' | 'district'>, b: TownBuilding): HouseForm {
  const tier = townTier(town);
  const edge = edgeOf(town, b.fp.center);
  const k = hash(b.id, 7);
  const big = b.fp.w >= BIG_W;
  if (b.kind === 'landmark') return tier === 'village' ? 'temple' : 'hall';
  const district = tier !== 'village' && inDistrict(town.district, b.fp.center);
  if (b.kind === 'com') {
    if (district) return 'shop';
    if (tier === 'village') return edge > 0.75 && k < 0.45 ? 'warehouse' : 'store';
    if (edge > 0.7) return k < 0.55 ? 'garages' : 'warehouse';
    if (edge < 0.5) return big || k < 0.45 ? 'office' : 'shop';
    return big && k < 0.4 ? 'office' : 'shop';
  }
  // Не слитый в панельный дом участок нового района — малоэтажный дом под скатной крышей (слитые — уже 'slab').
  if (district) return big && b.floors >= 3 ? 'slab' : 'townhouse';
  if (tier === 'village') return 'cottage';
  if (big) return tier === 'city' && b.floors >= 4 && k < 0.5 ? 'slab' : 'courtyard';
  if (edge > 0.95 && b.floors === 1 && k < 0.45) return 'dacha';
  const core = tier === 'city' ? 0.5 : 0.38;
  if (edge < core) return 'townhouse';
  if (edge < core + 0.2) return b.floors >= 2 ? (k < 0.45 ? 'townhouse' : roomyLot(b.fp) ? 'walkup' : 'cottage') : 'cottage';
  return 'cottage';
}

/** Общественные здания: сколько нужно городу и где им лучше стоять (доля радиуса от центра). */
interface PublicNeed {
  form: HouseForm;
  count: (tier: TownTier, pop: number, townId: number) => number;
  /** Лучшее расстояние от центра — в долях радиуса. */
  at: number;
}

const PUBLIC: PublicNeed[] = [
  { form: 'market', count: (t) => (t === 'village' ? 0 : 1), at: 0.15 },
  { form: 'school', count: (t, pop) => (t === 'city' ? Math.min(3, 1 + Math.floor(pop / 6000)) : 1), at: 0.5 },
  { form: 'hospital', count: (t) => (t === 'village' ? 0 : 1), at: 0.6 },
  { form: 'church', count: (t, _pop, id) => (t === 'city' ? 1 : t === 'town' && hash(id, 3) < 0.5 ? 1 : 0), at: 0.3 },
];

/** Что можно отдать под общественное здание: обычные магазины и конторы. */
const CONVERTIBLE: ReadonlySet<HouseForm> = new Set(['shop', 'office', 'store']);

/**
 * Школа, больница, рынок, церковь — нужное число на город по его размеру: из магазинов и контор (kind 'com':
 * рабочие места те же), что ближе к своему кольцу, — предпочтительно на большом участке. Уже стоящие — в счёт.
 */
export function pickPublic(town: Town): void {
  const tier = townTier(town);
  const pool = town.buildings.filter((b) => b.kind === 'com' && CONVERTIBLE.has(formOf(b)));
  for (const need of PUBLIC) {
    let have = town.buildings.reduce((n, b) => n + (b.form === need.form ? 1 : 0), 0);
    const want = need.count(tier, town.population, town.id);
    while (have < want && pool.length) {
      let best = 0;
      let score = Infinity;
      for (let i = 0; i < pool.length; i++) {
        const b = pool[i];
        const s = Math.abs(edgeOf(town, b.fp.center) - need.at) - (b.fp.w >= BIG_W ? 0.2 : 0) + hash(b.id, 5) * 0.05;
        if (s < score) {
          score = s;
          best = i;
        }
      }
      pool[best].form = need.form;
      pool.splice(best, 1);
      have++;
    }
  }
}

/**
 * Типы домам города, у которых их ещё нет (новые и из старых сохранений), общественные здания по размеру города и
 * жильцы новым домам (settlePeople).
 */
export function zoneTown(town: Town): void {
  for (const b of town.buildings) if (!b.form) b.form = placeForm(town, b);
  pickPublic(town);
  settlePeople(town);
}

// ---------- Жители по домам ----------

/** Жителей на «этаж» дома генерации (TownBuilding.floors): столько дом приносит городу, когда появляется. */
export const RES_PER_FLOOR = 14;
/** Рабочих мест на этаж делового дома. */
export const JOBS_PER_FLOOR = 4;

/** Жители жилого дома: свои (people) или, пока их не разложили, — по этажам генерации; у прочих — 0. */
export function residentsOf(b: Pick<TownBuilding, 'kind' | 'floors' | 'people'>): number {
  return b.kind === 'res' ? (b.people ?? b.floors * RES_PER_FLOOR) : 0;
}

/** Сколько живёт в частном доме и на даче: от и до (по хешу дома). */
const PRIVATE: Partial<Record<HouseForm, readonly [number, number]>> = { cottage: [3, 6], dacha: [2, 4] };

/**
 * Многоквартирные дома: сколько жильцов на этаж (по размеру участка — сколько подъездов и квартир на площадке
 * поместится в корпус, что рисует houseArt) и сколько этажей у дома по проекту (из этажей генерации floors).
 */
interface Stack {
  per: (fp: Footprint) => number;
  design: (floors: number) => number;
}

const clampInt = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(x)));
/** Длина корпуса панельного дома: вдоль улицы или (узкий глубокий участок) вглубь. */
const slabLength = (fp: Footprint) => (fp.w >= fp.h * 0.8 || fp.h < 30 * S ? fp.w - 3 : fp.h - 5);

/**
 * Вместимость — по участку в прежнем масштабе (÷ TOWN_SCALE): участки крупнее, а квартир на этаже и жителей в доме —
 * столько же, сколько было (дома просторнее, а не многолюднее).
 */
const STACKS: Partial<Record<HouseForm, Stack>> = {
  // Двух-трёхэтажный дом на 1–3 подъезда: квартиры по 2–3 на площадке.
  walkup: { per: (fp) => clampInt((fp.w / S) * 0.6, 8, 24), design: (f) => (f >= 3 ? 3 : 2) },
  townhouse: { per: (fp) => clampInt((fp.w / S) * 0.6, 8, 24), design: (f) => clampInt(f + 1, 2, 4) },
  courtyard: { per: (fp) => clampInt(((fp.w + fp.h) / S) * 0.45, 16, 50), design: (f) => clampInt(f, 3, 5) },
  slab: { per: (fp) => clampInt((slabLength(fp) / S) * 0.55, 12, 90), design: (f) => clampInt(f, 5, 12) },
  tower: { per: () => 18, design: (f) => clampInt(f, 9, 16) },
};
/** Выше стольких этажей дом не рисуется, сколько бы в нём ни жило (на случай старых и тестовых данных). */
const TOP: Partial<Record<HouseForm, number>> = { walkup: 4, townhouse: 5, courtyard: 6, slab: 16, tower: 25 };

/** Участок, где встанет многоквартирный дом, а не тесная двухэтажка на 36 жителей: широкий и не мелкий. */
export const roomyLot = (fp: Footprint) => fp.w >= 22 * S && fp.w * fp.h >= 480 * S * S;

/**
 * Этажей у жилого дома — по его жильцам и типу: у частного дома 1 или 2 (мансарда у семьи побольше), у дачи 1, у
 * многоквартирного — сколько нужно жильцам, но не ниже проекта. У деловых и ратуши — этажи генерации.
 */
export function storeysOf(b: Pick<TownBuilding, 'id' | 'kind' | 'floors' | 'people' | 'form' | 'fp'>): number {
  if (b.kind !== 'res') return b.floors;
  const form = formOf(b);
  const people = residentsOf(b);
  if (form === 'cottage') return people >= 5 || (people >= 4 && hash(b.id, 33) < 0.4) ? 2 : 1;
  if (form === 'dacha') return 1;
  const s = STACKS[form];
  if (!s) return b.floors;
  return Math.max(s.design(b.floors), Math.min(TOP[form] ?? 25, Math.ceil(people / s.per(b.fp) - 0.15)));
}

/** Квартир в жилом доме: в частном и на даче — одна семья, в многоквартирном — по 2,6 человека на квартиру. */
export function flatsOf(b: Pick<TownBuilding, 'kind' | 'floors' | 'people' | 'form' | 'fp'>): number {
  if (b.kind !== 'res' || PRIVATE[formOf(b)]) return 1;
  return Math.max(2, Math.round(residentsOf(b) / 2.6));
}

/** Сколько живёт в частном доме или на даче (по хешу дома). */
function privateFolk(b: TownBuilding): number {
  const [lo, hi] = PRIVATE[formOf(b)]!;
  return lo + Math.floor(hash(b.id, 31) * (hi - lo + 1));
}

/**
 * Жильцы многоквартирного дома: вместимость проектных этажей, заселённая на 80–95 % (по хешу дома). Неизвестный
 * тип — по прежним 14 на этаж генерации.
 */
function stackFolk(b: TownBuilding): number {
  const s = STACKS[formOf(b)];
  if (!s) return b.floors * RES_PER_FLOOR;
  return Math.max(4, Math.round(s.per(b.fp) * s.design(b.floors) * (0.8 + 0.15 * hash(b.id, 35))));
}

/** Сколько небольших многоквартирных домов у центра села: по числу жилых домов — у большого села 1–3, у малого нет. */
export function villageFlats(houses: number): number {
  return houses >= 80 ? 3 : houses >= 55 ? 2 : houses >= 35 ? 1 : 0;
}

/** Номер правила расселения: у городов сохранений с другим (или без него) жильцы раскладываются заново при загрузке. */
export const SETTLE_RULE = 2;

/**
 * Жильцы новым жилым домам города (и всем — при генерации и у старых сохранений): в частном доме 3–6 человек, на
 * даче 2–4, в многоквартирном — вместимость его проектных этажей (stackFolk). Жители города — сумма по домам.
 * Село — частные дома: многоквартирных не больше villageFlats у самого центра на просторных участках (лишние из
 * старых сохранений снова частные). Детерминировано; уже расселённые дома не меняются.
 */
export function settlePeople(town: Town): void {
  const fresh = town.buildings.filter((b) => b.kind === 'res' && b.people === undefined);
  if (!fresh.length) return;
  if (townTier(town) === 'village') {
    const res = town.buildings.filter((b) => b.kind === 'res');
    let left = villageFlats(res.length) - res.filter((b) => b.people !== undefined && b.form === 'walkup').length;
    // Кандидаты — у центра (до 0,45 радиуса), на просторном участке; ближние — первыми.
    const rank = (b: TownBuilding) => edgeOf(town, b.fp.center);
    const order = fresh.filter((b) => b.form === 'walkup' || (PRIVATE[formOf(b)] && rank(b) < 0.45 && roomyLot(b.fp))).sort((x, y) => rank(x) - rank(y) || x.id - y.id);
    const flats = new Set<TownBuilding>();
    for (const b of order) {
      if (left <= 0) break;
      if (!roomyLot(b.fp) || rank(b) >= 0.45) continue;
      flats.add(b);
      left--;
    }
    for (const b of fresh) {
      if (flats.has(b)) {
        // Небольшой — двухэтажный.
        b.form = 'walkup';
        b.floors = Math.min(b.floors, 2);
      } else if (b.form === 'walkup') b.form = 'cottage';
    }
  }
  for (const b of fresh) b.people = PRIVATE[formOf(b)] ? privateFolk(b) : stackFolk(b);
}

// ---------- Новый район: соседние участки — в один панельный дом ----------

/** Цвета панельных домов: стены и плоская крыша. */
const PANEL_COLORS: [string, string][] = [
  ['#e8e4dc', '#8e9398'],
  ['#ece6d6', '#9a958c'],
  ['#dfe3e6', '#7f8a94'],
  ['#efe2d2', '#a0907f'],
  ['#e4e8e0', '#868d86'],
];

/** Длиннее стольких метров один дом не сливается. */
const SLAB_MAX = 140 * S;
/** Девятиэтажка на участке короче этого — башня (точечный дом), а не длинный корпус. */
const TOWER_SHORT = 45 * S;
/** Башня — от стольких этажей. */
const TOWER_FLOORS = 8;
/** Между соседними участками по улице не больше стольких метров — они в одном ряду (пропущенный узкий участок — тоже). */
const ROW_GAP = 24 * S;

export interface BlockOps {
  /** Дом может войти в панельный (жилой, в новом районе или у проспекта большого города). */
  eligible(b: TownBuilding): boolean;
  /** Слитый контур встаёт: не на дороге и не на чужих строениях (слитые уже убраны из индекса). */
  fits(fp: Footprint): boolean;
  /** Индекс строений: убрать и вернуть. */
  remove(b: TownBuilding): void;
  add(b: TownBuilding): void;
}

interface Unit {
  front: TownBuilding;
  rears: TownBuilding[];
}

/** Координаты точки в осях дома f: x — вдоль улицы, y — поперёк. */
function local(f: Footprint, p: Vec): Vec {
  const c = Math.cos(f.angle);
  const s = Math.sin(f.angle);
  const dx = p.x - f.center.x;
  const dy = p.y - f.center.y;
  return { x: dx * c + dy * s, y: -dx * s + dy * c };
}

const parallel = (a: Footprint, b: Footprint) => Math.cos(a.angle - b.angle) > 0.997;

/** b — дом второго ряда за f (fillStreet ставит его сразу после переднего). */
function isRear(f: TownBuilding, b: TownBuilding): boolean {
  if (!parallel(f.fp, b.fp) || (f.face ?? -1) !== (b.face ?? -1)) return false;
  const q = local(f.fp, b.fp.center);
  return Math.abs(q.x) < f.fp.w / 2 && Math.abs(q.y) >= f.fp.h / 2 + 2;
}

/** b — следующий участок того же ряда вдоль улицы: фасады на одной линии, зазор между ними узкий. */
function nextInRow(f: TownBuilding, b: TownBuilding): boolean {
  if (!parallel(f.fp, b.fp) || (f.face ?? -1) !== (b.face ?? -1)) return false;
  const face = f.face ?? -1;
  const q = local(f.fp, b.fp.center);
  const line = q.y + (face * b.fp.h) / 2 - (face * f.fp.h) / 2;
  const gap = Math.abs(q.x) - (f.fp.w + b.fp.w) / 2;
  return Math.abs(line) < 3.5 && gap >= -0.5 && gap <= ROW_GAP;
}

/** Общий прямоугольник домов в осях первого. */
export function union(first: Footprint, list: readonly Pick<TownBuilding, 'fp'>[]): Footprint {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const b of list) {
    const c = Math.cos(b.fp.angle);
    const s = Math.sin(b.fp.angle);
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      const lx = (sx * b.fp.w) / 2;
      const ly = (sy * b.fp.h) / 2;
      const q = local(first, { x: b.fp.center.x + lx * c - ly * s, y: b.fp.center.y + lx * s + ly * c });
      x0 = Math.min(x0, q.x);
      x1 = Math.max(x1, q.x);
      y0 = Math.min(y0, q.y);
      y1 = Math.max(y1, q.y);
    }
  }
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const c = Math.cos(first.angle);
  const s = Math.sin(first.angle);
  return { center: { x: first.center.x + cx * c - cy * s, y: first.center.y + cx * s + cy * c }, w: x1 - x0, h: y1 - y0, angle: first.angle };
}

/**
 * Соседние жилые участки вдоль улицы (с домами второго ряда за ними) сливаются в один панельный дом: этажей —
 * сумма этажей слитых (жителей ровно столько же). Этажность ряда — ~5, в большом городе у трети рядов ~9, у пятой
 * части — «на высотку» (башня от TOWER_FLOORS этажей); этажи ряда делятся между домами поровну. Один участок без
 * второго ряда и дом меньше трёх этажей не сливаются. id, узел выезда и сторона улицы — у первого.
 * Порядок домов — как у fillStreet: по улице, дом второго ряда — сразу за своим. Возвращает число новых домов.
 */
export function mergeBlocks(town: Town, ops: BlockOps): number {
  const city = townTier(town) === 'city';
  const runs: Unit[][] = [];
  let run: Unit[] = [];
  let prev: TownBuilding | null = null;
  let last: Unit | null = null;
  const close = () => {
    if (run.length) runs.push(run);
    run = [];
    last = null;
  };
  for (const b of town.buildings) {
    const ok = b.kind === 'res' && ops.eligible(b);
    if (prev && isRear(prev, b) && (!last || last.front !== prev)) {
      // Второй ряд за домом, который в панельный не идёт, — тоже не идёт.
      continue;
    }
    if (!ok) {
      close();
      prev = b;
      continue;
    }
    if (last && isRear(last.front, b)) {
      last.rears.push(b);
      continue;
    }
    const unit: Unit = { front: b, rears: [] };
    if (!last || !nextInRow(run[run.length - 1].front, b)) close();
    run.push(unit);
    last = unit;
    prev = b;
  }
  close();

  const merged = new Map<TownBuilding, TownBuilding>();
  const gone = new Set<TownBuilding>();
  for (const units of runs) {
    // Пока ряд разбирается — его дома вне индекса: проверка места видит только чужое и уже слитые дома.
    const all = units.flatMap((u) => [u.front, ...u.rears]);
    for (const b of all) ops.remove(b);
    const used = new Set<TownBuilding>();
    // Этажность ряда — по первому дому; этажи ряда делятся между домами поровну (без короткого остатка в конце).
    const h = hash(units[0].front.id, 11);
    const target = city && h < 0.2 ? 12 : city && h < 0.5 ? 9 : 5;
    const max = SLAB_MAX;
    const sum = all.reduce((n, b) => n + b.floors, 0);
    const goal = sum / Math.max(1, Math.round(sum / target)) - 0.5;
    let i = 0;
    while (i < units.length) {
      const first = units[i].front;
      let members: TownBuilding[] = [];
      // Участок нового дома: передние дома и те дома второго ряда, с которыми общий контур встаёт. Жильцы домов
      // второго ряда, что в контур не вошли, всё равно переезжают в новый дом — их место остаётся двором.
      let area: TownBuilding[] = [];
      let floors = 0;
      // Участки — по одному, пока набирается этажей и общий контур встаёт.
      while (i < units.length && floors < goal) {
        const u = units[i];
        if (area.length && union(first.fp, [...area, u.front]).w > max) break;
        const deep = [...area, u.front, ...u.rears];
        const plain = [...area, u.front];
        const take = ops.fits(union(first.fp, deep)) ? deep : ops.fits(union(first.fp, plain)) ? plain : null;
        if (!take) break;
        area = take;
        members = [...members, u.front, ...u.rears];
        floors = members.reduce((n, b) => n + b.floors, 0);
        i++;
      }
      if (!members.length) {
        i++;
        continue;
      }
      if (floors < 3 || members.length < 2) continue;
      const fp = union(first.fp, area);
      const [color, roof] = PANEL_COLORS[Math.floor(hash(first.id, 13) * PANEL_COLORS.length)];
      // Башня — где ряд набирал на высотку, или девятиэтажка на коротком участке: точечный дом, а не длинный корпус.
      const tall = floors >= TOWER_FLOORS && (target >= 12 || fp.w < TOWER_SHORT);
      const block: TownBuilding = { ...first, fp, floors, form: tall ? 'tower' : 'slab', color, roof };
      ops.add(block);
      merged.set(first, block);
      for (const b of members) {
        used.add(b);
        if (b !== first) gone.add(b);
      }
    }
    for (const b of all) if (!used.has(b)) ops.add(b);
  }
  if (!merged.size) return 0;
  town.buildings = town.buildings.filter((b) => !gone.has(b)).map((b) => merged.get(b) ?? b);
  return merged.size;
}

/** Высоток на город (вместе с теми, что вышли из рядов): у большого — 1–3 по хешу города, у города — 0–1, у села — нет. */
export function towerQuota(town: Pick<Town, 'id' | 'population' | 'style'> & { tier?: TownTier }): number {
  const tier = townTier(town);
  if (tier === 'city') return 1 + Math.floor(hash(town.id, 21) * 3);
  // Город — не маленький кольцевой (тот город и при малом населении).
  if (tier === 'town' && (town.tier || town.population >= LEGACY_TIER.town)) return hash(town.id, 22) < 0.6 ? 1 : 0;
  return 0;
}

/** Этажность высотки из двух панельных домов спиной к спине. */
const BACK_TO_BACK = { min: 9, max: 13 };
/** Между задними сторонами двух домов квартала — не дальше стольких метров (дворы, без улицы между ними). */
const BACK_GAP = 28 * S;

export interface TowerOps extends Pick<BlockOps, 'fits' | 'remove' | 'add'> {
  /** На другой стороне улицы перед домом есть застройка: улица не останется пустой с обеих сторон. */
  fronted(b: TownBuilding): boolean;
}

/**
 * Высотки нового района: два панельных дома одного квартала, что стоят спиной к спине (участки соседних улиц, между
 * ними только дворы), сливаются в один участок от улицы до улицы с башней и общим двором. Этажей — сумма двух
 * (9–13), жителей ровно столько же. Улиц это не трогает: участок не задевает ни одну (fits), а напротив каждого из
 * двух фасадов, через улицу, есть дома (fronted) — улица не останется пустой. Не больше towerQuota на город.
 * Возвращает число новых высоток.
 */
export function mergeTowers(town: Town, ops: TowerOps): number {
  let left = towerQuota(town) - town.buildings.filter((b) => b.form === 'tower').length;
  if (left <= 0 || !town.district) return 0;
  const slabs = town.buildings.filter((b) => b.form === 'slab' && b.kind === 'res' && inDistrict(town.district, b.fp.center));
  type Pair = { a: TownBuilding; b: TownBuilding; key: number };
  const pairs: Pair[] = [];
  for (let i = 0; i < slabs.length; i++) {
    for (let j = i + 1; j < slabs.length; j++) {
      const a = slabs[i];
      const b = slabs[j];
      const floors = a.floors + b.floors;
      if (floors < BACK_TO_BACK.min || floors > BACK_TO_BACK.max) continue;
      if (Math.abs(Math.cos(a.fp.angle - b.fp.angle)) < 0.99) continue;
      const q = local(a.fp, b.fp.center);
      // b — за спиной у a: по другую сторону от улицы a, сразу за его задней границей.
      const back = -(a.face ?? -1);
      if (q.y * back <= 0) continue;
      const gap = Math.abs(q.y) - (a.fp.h + b.fp.h) / 2;
      if (gap < -1 || gap > BACK_GAP) continue;
      // Улица b — с его дальней от a стороны: тогда они спиной друг к другу.
      const bq = local(b.fp, a.fp.center);
      if (bq.y * (b.face ?? -1) > 0) continue;
      const overlap = Math.min(a.fp.w / 2, q.x + b.fp.w / 2) - Math.max(-a.fp.w / 2, q.x - b.fp.w / 2);
      if (overlap < 0.6 * Math.min(a.fp.w, b.fp.w)) continue;
      pairs.push({ a, b, key: hash(a.id * 7919 + b.id, 23) });
    }
  }
  pairs.sort((x, y) => x.key - y.key);
  const used = new Set<TownBuilding>();
  const merged = new Map<TownBuilding, TownBuilding>();
  for (const { a, b } of pairs) {
    if (left <= 0) break;
    if (used.has(a) || used.has(b) || !ops.fronted(a) || !ops.fronted(b)) continue;
    const fp = union(a.fp, [a, b]);
    ops.remove(a);
    ops.remove(b);
    if (!ops.fits(fp)) {
      ops.add(a);
      ops.add(b);
      continue;
    }
    const tower: TownBuilding = { ...a, fp, floors: a.floors + b.floors, form: 'tower' };
    ops.add(tower);
    merged.set(a, tower);
    used.add(a).add(b);
    left--;
  }
  if (!merged.size) return 0;
  town.buildings = town.buildings.filter((x) => !used.has(x) || merged.has(x)).map((x) => merged.get(x) ?? x);
  return merged.size;
}

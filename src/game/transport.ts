import { MONTH_SCALE, START_YEAR } from '../config';
import { clamp } from '../core/math';
import { add, cubicBezier, dist, dot, norm, rightNormal, scale, sub, type Vec } from '../core/vec';
import type { TrainSpec } from '../sim/rail';
import { KMH_PER_UNIT, LANE_W } from '../world/roadTypes';
import type { VehicleSpec } from '../sim/vehicle';
import type { CargoType } from '../world/cargo';
import type { PassengerGroup } from '../world/entities';
import type { Footprint } from '../world/spatial';

export type ModelId =
  | 'truck'
  | 'truck2'
  | 'truck3'
  | 'bus'
  | 'bus2'
  | 'bus3'
  | 'freightTrain'
  | 'freightTrain2'
  | 'passengerTrain'
  | 'passengerTrain2';
/** Чем ездит линия: по дорогам или по рельсам. */
export type LineMode = 'road' | 'rail';

interface ModelBase {
  id: ModelId;
  name: string;
  carries: 'freight' | 'passengers';
  capacity: number;
  price: number;
  /** Расходы на содержание в месяц. */
  running: number;
  /** С какого года модель продаётся. */
  year: number;
  /** Ступень модели: 1 — с начала игры, 2 и 3 — новее. В сценарии ступени открывают этапы B и C. */
  tier: ModelTier;
}

export type ModelTier = 1 | 2 | 3;

/**
 * Год выхода модели в игре по году её эпохи: месяц длится втрое дольше прежнего (MONTH_SCALE), поэтому
 * отрезок от начала игры сжат во столько же раз — новые модели выходят через то же реальное время, что раньше.
 */
const era = (year: number) => START_YEAR + Math.round((year - START_YEAR) / MONTH_SCALE);

export interface RoadModel extends ModelBase {
  mode: 'road';
  spec: VehicleSpec;
}

export interface RailModel extends ModelBase {
  mode: 'rail';
  train: Omit<TrainSpec, 'color'>;
}

export type VehicleModel = RoadModel | RailModel;

/**
 * Модели по эпохам: со временем появляются вместительнее и выгоднее в содержании
 * (на единицу груза). Скорость грузовиков — ≈90 км/ч, автобусов — ≈100 км/ч.
 */
export const MODELS: Record<ModelId, VehicleModel> = {
  truck: {
    id: 'truck',
    mode: 'road',
    name: 'Грузовик',
    carries: 'freight',
    capacity: 16,
    price: 22_000,
    running: 1_100 * MONTH_SCALE,
    year: START_YEAR,
    tier: 1,
    spec: { kind: 'truck', body: 'van', length: 11, width: 4.6, maxSpeed: 41, accel: 6, color: '#e07b39' },
  },
  truck2: {
    id: 'truck2',
    mode: 'road',
    name: 'Грузовик II',
    carries: 'freight',
    capacity: 24,
    price: 32_000,
    running: 1_400 * MONTH_SCALE,
    year: era(1972),
    tier: 2,
    // Тягач с полуприцепом: на поворотах гнётся в седле (sim/body).
    spec: { kind: 'truck', body: 'semi', length: 12.5, width: 4.8, maxSpeed: 41, accel: 6.5, color: '#e07b39' },
  },
  truck3: {
    id: 'truck3',
    mode: 'road',
    name: 'Фура',
    carries: 'freight',
    capacity: 36,
    price: 48_000,
    running: 1_900 * MONTH_SCALE,
    year: era(1986),
    tier: 3,
    spec: { kind: 'truck', body: 'longSemi', length: 18, width: 5, maxSpeed: 41, accel: 6, color: '#e07b39' },
  },
  bus: {
    id: 'bus',
    mode: 'road',
    name: 'Автобус',
    carries: 'passengers',
    capacity: 30,
    price: 26_000,
    running: 1_300 * MONTH_SCALE,
    year: START_YEAR,
    tier: 1,
    spec: { kind: 'bus', body: 'microbus', length: 10.5, width: 4.6, maxSpeed: 45, accel: 6, color: '#3b7dd8' },
  },
  bus2: {
    id: 'bus2',
    mode: 'road',
    name: 'Автобус II',
    carries: 'passengers',
    capacity: 40,
    price: 34_000,
    running: 1_500 * MONTH_SCALE,
    year: era(1974),
    tier: 2,
    spec: { kind: 'bus', body: 'cityBus', length: 14, width: 4.8, maxSpeed: 45, accel: 6.5, color: '#3b7dd8' },
  },
  bus3: {
    id: 'bus3',
    mode: 'road',
    name: 'Автобус III',
    carries: 'passengers',
    capacity: 60,
    price: 50_000,
    running: 2_000 * MONTH_SCALE,
    year: era(1988),
    tier: 3,
    // Сочленённый: две секции с гармошкой, гнётся посередине (sim/body).
    spec: { kind: 'bus', body: 'articBus', length: 18, width: 4.8, maxSpeed: 45, accel: 5.5, color: '#3b7dd8' },
  },
  freightTrain: {
    id: 'freightTrain',
    mode: 'rail',
    name: 'Грузовой поезд',
    carries: 'freight',
    capacity: 120,
    price: 240_000,
    running: 8_000 * MONTH_SCALE,
    year: START_YEAR,
    tier: 1,
    // 100 км/ч — быстрее грузовиков, но медленнее пассажирского.
    train: { kind: 'freight', cars: 6, carLength: 17, maxSpeed: 100 / KMH_PER_UNIT, accel: 2.2, brake: 3.5 },
  },
  freightTrain2: {
    id: 'freightTrain2',
    mode: 'rail',
    name: 'Тяжёлый грузовой',
    carries: 'freight',
    capacity: 180,
    price: 320_000,
    running: 10_000 * MONTH_SCALE,
    year: era(1978),
    tier: 2,
    train: { kind: 'freight', cars: 8, carLength: 17, maxSpeed: 110 / KMH_PER_UNIT, accel: 2.4, brake: 3.5 },
  },
  passengerTrain: {
    id: 'passengerTrain',
    mode: 'rail',
    name: 'Пассажирский поезд',
    carries: 'passengers',
    capacity: 180,
    price: 260_000,
    running: 8_500 * MONTH_SCALE,
    year: START_YEAR,
    tier: 1,
    train: { kind: 'passenger', cars: 5, carLength: 20, maxSpeed: 120 / KMH_PER_UNIT, accel: 2.6, brake: 4 },
  },
  passengerTrain2: {
    id: 'passengerTrain2',
    mode: 'rail',
    name: 'Скорый поезд',
    carries: 'passengers',
    capacity: 240,
    price: 360_000,
    running: 11_000 * MONTH_SCALE,
    year: era(1982),
    tier: 3,
    train: { kind: 'passenger', cars: 6, carLength: 20, maxSpeed: 120 / KMH_PER_UNIT, accel: 3.2, brake: 4.5 },
  },
};

/** Продаётся ли модель: открыта (см. Game.modelOpen) или — числом — вышла к этому году. */
export type ModelOpen = number | ((id: ModelId) => boolean);

const isOpen = (id: ModelId, open: ModelOpen) => (typeof open === 'number' ? MODELS[id].year <= open : open(id));

/** Модели для линии этого вида, которые уже продаются. */
export const modelsFor = (mode: LineMode, open: ModelOpen = Infinity): ModelId[] =>
  (Object.keys(MODELS) as ModelId[]).filter((id) => MODELS[id].mode === mode && isOpen(id, open));

/** Самая новая модель того же вида и назначения из тех, что продаются. */
export function newestLike(model: ModelId, open: ModelOpen): ModelId {
  const m = MODELS[model];
  return modelsFor(m.mode, open)
    .filter((id) => MODELS[id].carries === m.carries)
    .sort((a, b) => MODELS[b].tier - MODELS[a].tier || MODELS[b].year - MODELS[a].year)[0];
}

export const LINE_COLORS = ['#e5534b', '#4a8fe7', '#3fae6a', '#e9b52f', '#9a6be0', '#2fb8b3', '#e07b39', '#d45d9a'];

/**
 * Правила остановки: сколько ждать, что грузить и что выгружать.
 * auto — как раньше: грузим то, что примут дальше по маршруту, выгружаем там, где принимают.
 */
export interface StopRule {
  /** auto — ждать груз, если он здесь ожидается; full — до полной загрузки; none — не ждать. */
  wait: 'auto' | 'full' | 'none';
  /** Предел ожидания полной загрузки, секунд; null — без предела. */
  maxWait: number | null;
  load: 'auto' | CargoType[];
  /** all и список — выгрузить на склад станции, даже если здесь груз не принимают. */
  unload: 'auto' | 'all' | CargoType[];
  /**
   * Ж/д станция: на какой путь вставать — номер платформы по порядку (с 0, как в station.platforms).
   * Нет или null (старые сохранения) — авто: любая свободная платформа.
   */
  platform?: number | null;
}

export const DEFAULT_RULE: StopRule = { wait: 'auto', maxWait: null, load: 'auto', unload: 'auto' };

export interface Line {
  id: number;
  name: string;
  color: string;
  /** В старых сохранениях нет — значит, автомобильная. */
  mode?: LineMode;
  stops: number[];
  /** Правила остановок, по индексу в stops; нет — по умолчанию. */
  rules?: (StopRule | null)[];
  vehicles: number[];
  /**
   * Когда маршрут создан, в месяцах игры с долей (9.5 — середина десятого месяца; в старых сохранениях — целый
   * номер месяца или нет вовсе): по нему сценарий узнаёт маршруты, построенные с начала этапа.
   */
  created?: number;
  revenueMonth: number;
  revenueLast: number;
  revenueTotal: number;
  costMonth: number;
  costLast: number;
  carriedMonth: number;
  carriedLast: number;
  problem: string | null;
  /** Средняя загрузка при отправлении (0…1): за этот месяц — сумма и число рейсов, за прошлый — итог. */
  loadSumMonth?: number;
  departuresMonth?: number;
  loadLast?: number | null;
  /** Помесячная история для графика: доход и расходы (до 12 месяцев). */
  history?: { label: string; revenue: number; cost: number }[];
  /** Папка в списке линий; нет — линия в корне списка. */
  folder?: number;
  /** Авто-парк: игра сама докупает и продаёт машины в пределах min…max. Нет (старые сохранения) — выключен. */
  auto?: LineAuto;
  /** Время круга (от отправления с первой станции до следующего), секунд, — среднее по рейсам; нет — ещё не измерено. */
  lap?: number;
  /**
   * Интервал между отправлениями выключен: машины уезжают с первой станции, как только готовы. Новые маршруты
   * создаются с выключенным (true), false — игрок включил. Нет (сохранения до этого) — включён, как было.
   */
  noSpacing?: boolean;
  /** Когда машина линии последний раз отправилась с первой станции (игровое время). */
  departedAt?: number;
  /**
   * Загрузка с начала окна statsFrom (игровое время; окно — не короче месяца и круга линии), по станциям (id):
   * сумма загрузки при отправлении, сумма оставшегося ждать (в вместимостях машины), число рейсов.
   */
  stopLoads?: Record<number, [number, number, number]>;
  statsFrom?: number;
  /**
   * Итог прошлого окна для авто-парка: загрузка при отправлении с самой загруженной станции, сколько груза
   * остаётся ждать (в машинах) и прибыль за окно; null — рейсов не было.
   */
  demandLast?: { load: number; left: number; profit: number } | null;
}

/** Авто-парк линии. */
export interface LineAuto {
  on: boolean;
  /** Не меньше стольких машин; 0 — может убрать с линии все, пока они не нужны. */
  min: number;
  max: number;
  /** Окон подряд машины ездят полупустыми. */
  low?: number;
  /** Решено продать лишнюю (игровое время решения): продаётся первая опустевшая. */
  sell?: number;
  /** Последняя покупка не удалась — не хватило денег. */
  noMoney?: boolean;
}

/**
 * Пороги авто-парка: докупаем, если с самой загруженной станции машины уходят почти полными, а груза
 * остаётся ждать хотя бы на полмашины; продаём, если несколько окон подряд уходят полупустыми.
 * Линии без машин (минимум 0) возвращаем машину, когда за круг набралось бы хотя бы на wake машины —
 * выше порога продажи, чтобы не покупать и не продавать её по кругу.
 */
export const AUTO_FLEET = { maxVehicles: 50, defaultMax: 10, full: 0.8, leftBehind: 0.5, low: 0.4, lowWindows: 2, wake: 0.6 };

/** Папка для группировки линий в списке. */
export interface LineFolder {
  id: number;
  name: string;
  /** Свёрнута в списке: линии внутри скрыты. */
  collapsed?: boolean;
}

export type FleetState = 'loading' | 'departing' | 'driving';

export interface FleetVehicle {
  id: number;
  name: string;
  model: ModelId;
  lineId: number;
  /** Индекс остановки: где стоим (loading/departing) или куда едем (driving). */
  stop: number;
  state: FleetState;
  simId: number | null;
  /** Автобус миновал узел остановки и доезжает до места — центром напротив неё; там начнёт посадку. */
  boarding?: boolean;
  /** Поезд в симуляции железной дороги. */
  trainId?: number | null;
  cargo: CargoType | null;
  amount: number;
  loadedAt: number | null;
  /** Когда погрузили (игровое время) — для надбавки за скорость доставки. */
  loadedTime?: number;
  /** Груз взят со склада пересадки — скорость всего пути неизвестна, без надбавки. */
  fromStore?: boolean;
  passengers: PassengerGroup[];
  timer: number;
  /** Сколько секунд пустой грузовик уже ждёт груз на станции. */
  waited: number;
  /** Месяц покупки (игровой) — для возраста и износа. */
  boughtMonth?: number;
  /** Вагонов в поезде (если игрок менял длину состава). */
  cars?: number;
  /** Груз, выгруженный на этой остановке, — его не грузим обратно в тот же заход. */
  dropped?: CargoType | null;
  /** Занимает ли пост на станции. */
  inBay: boolean;
  /** Номер поста на автостанции, который заняла машина. */
  bay?: number;
  /** Заезд с выезда на пост автостанции: пока он идёт, погрузка не начинается. */
  enter?: BayEntry;
  profitMonth: number;
  profitLast: number;
  /** Новая, ещё не уезжала с первой станции: выжидает интервал целиком. */
  fresh?: boolean;
  /** Когда последний раз уехала с первой станции — для времени круга. */
  lapAt?: number;
  /** Сколько секунд этого круга простояла ради интервала — во время круга не входят. */
  lapHeld?: number;
  /** Ждёт интервала на первой станции: с какого и до какого игрового времени. */
  holdFrom?: number;
  holdUntil?: number;
  /** Игрок велел отправиться немедленно, не дожидаясь интервала; одноразовый флаг. */
  releaseHold?: boolean;
  /** Заказана замена на эту модель: новая длиннее, а сзади на дороге вплотную сосед — заменится, как освободится место. */
  upgradeTo?: ModelId;
}

/** Откуда машина заезжает на пост: нос и курс там, где она сошла с дороги, её скорость и сколько секунд уже едет. */
export interface BayEntry {
  pos: Vec;
  dir: Vec;
  v0: number;
  t: number;
}

/** Нос и курс машины. */
export interface Pose {
  pos: Vec;
  dir: Vec;
}

/** Середина поста bay по ширине площадки, от её центра (как на рисунке станции). */
function bayX(fp: Footprint, bays: number, bay: number): number {
  const bw = (fp.w - 10) / bays;
  return -fp.w / 2 + 5 + bay * bw + (bw - 2) / 2;
}

/** Бокс поста bay на рисунке автостанции: от середины здания до ворот (front — см. bayFront). */
export function bayBox(fp: Footprint, bays: number, bay: number, front: 1 | -1 = 1): Footprint {
  const u = { x: Math.cos(fp.angle), y: Math.sin(fp.angle) };
  const n = { x: -u.y * front, y: u.x * front };
  const hh = fp.h / 2;
  const w = (fp.w - 10) / bays - 2;
  return { center: add(fp.center, add(scale(u, bayX(fp, bays, bay)), scale(n, (hh - 1) / 2))), w, h: hh + 1, angle: fp.angle };
}

/**
 * С какой стороны площадки ворота постов — там, где узел выезда gate: +1 — локальная +y
 * (автостанция у дороги), −1 — локальная −y (грузовой двор у предприятия повёрнут наоборот).
 */
export function bayFront(fp: Footprint, gate: Vec): 1 | -1 {
  const d = sub(gate, fp.center);
  return dot(d, { x: -Math.sin(fp.angle), y: Math.cos(fp.angle) }) >= 0 ? 1 : -1;
}

/**
 * Пост погрузки автостанции: куда встаёт нос машины длиной length и куда она смотрит.
 * Выезд — со стороны front площадки (см. bayFront), машина заезжает вглубь, целиком под навес.
 */
export function bayPose(fp: Footprint, bays: number, bay: number, length: number, front: 1 | -1 = 1): Pose {
  const u = { x: Math.cos(fp.angle), y: Math.sin(fp.angle) };
  const n = { x: -u.y * front, y: u.x * front };
  const y = clamp(fp.h / 2 - length - 0.5, -fp.h / 2 + 1, -1);
  return { pos: add(fp.center, add(scale(u, bayX(fp, bays, bay)), scale(n, y))), dir: scale(n, -1) };
}

/**
 * Место i-го из count автобусов на посадке у остановки: вдоль бордюра, в крайней полосе улицы
 * (она — в сторону узла road), носом по ходу (остановка справа). Нет узла — улица с локальной +y.
 */
export function stopBerth(fp: Footprint, road: Vec | undefined, i: number, count: number): Pose {
  const u = { x: Math.cos(fp.angle), y: Math.sin(fp.angle) };
  const toRoad = road ? sub(road, fp.center) : { x: -u.y, y: u.x };
  const l = Math.hypot(toRoad.x, toRoad.y) || 1;
  const n = { x: toRoad.x / l, y: toRoad.y / l };
  const along = (i - (count - 1) / 2) * 14;
  return { pos: add(add(fp.center, scale(u, along)), scale(n, fp.h / 2 + 2 + LANE_W / 2)), dir: dot(rightNormal(u), n) < 0 ? u : scale(u, -1) };
}

/** Свободный пост, ближайший к точке p: машина сворачивает к ближнему. Свободных нет — следующий номер за последним. */
export function nearestBay(fp: Footprint, bays: number, taken: Set<number>, p: Vec): number {
  const x = dot(sub(p, fp.center), { x: Math.cos(fp.angle), y: Math.sin(fp.angle) });
  let best = -1;
  for (let i = 0; i < bays; i++) {
    if (!taken.has(i) && (best < 0 || Math.abs(bayX(fp, bays, i) - x) < Math.abs(bayX(fp, bays, best) - x))) best = i;
  }
  if (best >= 0) return best;
  let i = bays;
  while (taken.has(i)) i++;
  return i;
}

/**
 * Где машина длиной length на заезде к посту to: плавная кривая от точки съезда с дороги,
 * скорость — от той, с какой съехала, до остановки на посту; кузов тянется за носом по кривой.
 * done — машина уже на посту.
 */
export function entryPose(e: BayEntry, to: Pose, length: number): Pose & { done: boolean } {
  const k = Math.max(dist(e.pos, to.pos) * 0.4, 2);
  const c1 = add(e.pos, scale(e.dir, k));
  const c2 = sub(to.pos, scale(to.dir, k));
  const pts: Vec[] = [];
  const cum = [0];
  for (let i = 0; i <= 16; i++) {
    pts.push(cubicBezier(e.pos, c1, c2, to.pos, i / 16));
    if (i) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  }
  const total = Math.max(0.1, cum[16]);
  /** Точка кривой на расстоянии s от съезда; до него — позади, на прямой съезда. */
  const at = (s: number): Vec => {
    if (s <= 0) return add(e.pos, scale(e.dir, s));
    let i = 1;
    while (i < 16 && cum[i] < s) i++;
    const f = clamp((s - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]), 0, 1);
    return add(pts[i - 1], scale(sub(pts[i], pts[i - 1]), f));
  };
  const T = clamp(total / 7, 1.2, 4);
  const u = clamp(e.t / T, 0, 1);
  // Кубический сплайн пути: в начале — скорость съезда, на посту — ноль.
  const m0 = clamp((e.v0 * T) / total, 0, 2);
  const s = total * ((u * u * u - 2 * u * u + u) * m0 + (3 * u * u - 2 * u * u * u));
  const pos = at(s);
  const dir = norm(sub(pos, at(s - length * 0.7)));
  return { pos, dir: dir.x || dir.y ? dir : e.dir, done: e.t >= T };
}

/** Вагонов в составе: своё число или по умолчанию для модели (у машин — 1). */
export function carsOf(v: FleetVehicle): number {
  const m = MODELS[v.model];
  return m.mode === 'rail' ? (v.cars ?? m.train.cars) : 1;
}

/** Вместимость с учётом длины состава. */
export function vehicleCapacity(v: FleetVehicle): number {
  const m = MODELS[v.model];
  return m.mode === 'rail' ? Math.round((m.capacity * carsOf(v)) / m.train.cars) : m.capacity;
}

export function vehicleLoad(v: FleetVehicle): number {
  return v.cargo ? v.amount : v.passengers.reduce((s, g) => s + g.count, 0);
}

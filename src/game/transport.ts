import type { TrainSpec } from '../sim/rail';
import { KMH_PER_UNIT } from '../world/roadTypes';
import type { VehicleSpec } from '../sim/vehicle';
import type { CargoType } from '../world/cargo';
import type { PassengerGroup } from '../world/entities';

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
}

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
    running: 1_100,
    year: 1960,
    spec: { kind: 'truck', length: 11, width: 4.6, maxSpeed: 41, accel: 6, color: '#e07b39' },
  },
  truck2: {
    id: 'truck2',
    mode: 'road',
    name: 'Грузовик II',
    carries: 'freight',
    capacity: 24,
    price: 32_000,
    running: 1_400,
    year: 1972,
    spec: { kind: 'truck', length: 12.5, width: 4.8, maxSpeed: 41, accel: 6.5, color: '#e07b39' },
  },
  truck3: {
    id: 'truck3',
    mode: 'road',
    name: 'Фура',
    carries: 'freight',
    capacity: 36,
    price: 48_000,
    running: 1_900,
    year: 1986,
    spec: { kind: 'truck', length: 16, width: 5, maxSpeed: 41, accel: 6, color: '#e07b39' },
  },
  bus: {
    id: 'bus',
    mode: 'road',
    name: 'Автобус',
    carries: 'passengers',
    capacity: 30,
    price: 26_000,
    running: 1_300,
    year: 1960,
    spec: { kind: 'bus', length: 12, width: 4.8, maxSpeed: 45, accel: 6, color: '#3b7dd8' },
  },
  bus2: {
    id: 'bus2',
    mode: 'road',
    name: 'Автобус II',
    carries: 'passengers',
    capacity: 40,
    price: 34_000,
    running: 1_500,
    year: 1974,
    spec: { kind: 'bus', length: 12.5, width: 4.8, maxSpeed: 45, accel: 6.5, color: '#3b7dd8' },
  },
  bus3: {
    id: 'bus3',
    mode: 'road',
    name: 'Сочленённый автобус',
    carries: 'passengers',
    capacity: 60,
    price: 50_000,
    running: 2_000,
    year: 1988,
    spec: { kind: 'bus', length: 18, width: 4.8, maxSpeed: 45, accel: 5.5, color: '#3b7dd8' },
  },
  freightTrain: {
    id: 'freightTrain',
    mode: 'rail',
    name: 'Грузовой поезд',
    carries: 'freight',
    capacity: 120,
    price: 240_000,
    running: 8_000,
    year: 1960,
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
    running: 10_000,
    year: 1978,
    train: { kind: 'freight', cars: 8, carLength: 17, maxSpeed: 110 / KMH_PER_UNIT, accel: 2.4, brake: 3.5 },
  },
  passengerTrain: {
    id: 'passengerTrain',
    mode: 'rail',
    name: 'Пассажирский поезд',
    carries: 'passengers',
    capacity: 180,
    price: 260_000,
    running: 8_500,
    year: 1960,
    train: { kind: 'passenger', cars: 5, carLength: 20, maxSpeed: 120 / KMH_PER_UNIT, accel: 2.6, brake: 4 },
  },
  passengerTrain2: {
    id: 'passengerTrain2',
    mode: 'rail',
    name: 'Скорый поезд',
    carries: 'passengers',
    capacity: 240,
    price: 360_000,
    running: 11_000,
    year: 1982,
    train: { kind: 'passenger', cars: 6, carLength: 20, maxSpeed: 120 / KMH_PER_UNIT, accel: 3.2, brake: 4.5 },
  },
};

/** Модели для линии этого вида, которые уже продаются в этом году. */
export const modelsFor = (mode: LineMode, year = Infinity): ModelId[] =>
  (Object.keys(MODELS) as ModelId[]).filter((id) => MODELS[id].mode === mode && MODELS[id].year <= year);

/** Самая новая модель того же вида и назначения, доступная в этом году. */
export function newestLike(model: ModelId, year: number): ModelId {
  const m = MODELS[model];
  return modelsFor(m.mode, year)
    .filter((id) => MODELS[id].carries === m.carries)
    .sort((a, b) => MODELS[b].year - MODELS[a].year)[0];
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
}

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
  profitMonth: number;
  profitLast: number;
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

export type RoadClass = 'street' | 'avenue' | 'highway' | 'motorway' | 'rail';

/** Классы автодорог (без железной дороги) — для панели выбора. */
export const ROAD_CLASS_IDS: RoadClass[] = ['street', 'avenue', 'highway', 'motorway'];

export interface RoadClassInfo {
  id: RoadClass;
  name: string;
  /** Ограничение скорости по умолчанию, км/ч. */
  limit: number;
  minRadius: number;
  /** Цена за единицу длины на одну полосу. */
  cost: number;
}

export const ROAD_CLASSES: Record<RoadClass, RoadClassInfo> = {
  street: { id: 'street', name: 'Улица', limit: 40, minRadius: 12, cost: 7 },
  avenue: { id: 'avenue', name: 'Проспект', limit: 60, minRadius: 26, cost: 9 },
  highway: { id: 'highway', name: 'Магистраль', limit: 90, minRadius: 70, cost: 13 },
  motorway: { id: 'motorway', name: 'Автомагистраль', limit: 120, minRadius: 150, cost: 17 },
  rail: { id: 'rail', name: 'Ж/д путь', limit: 120, minRadius: 110, cost: 45 },
};

/** Знаки ограничения скорости, которые можно поставить на дорогу. */
export const SPEED_LIMITS = [40, 60, 80, 90, 100, 120];
/** км/ч в одной единице скорости симуляции. */
export const KMH_PER_UNIT = 2.2;

/** Ограничение скорости дороги, км/ч: своё или по умолчанию для её класса. */
export const specKmh = (s: RoadSpec) => s.limit ?? ROAD_CLASSES[s.cls].limit;
/** Ограничение скорости в единицах симуляции. */
export const specSpeed = (s: RoadSpec) => specKmh(s) / KMH_PER_UNIT;

/** Быстрые дороги: вдоль них не строят дома и станции. */
export const isTrunk = (cls: RoadClass) => cls === 'highway' || cls === 'motorway';

/**
 * Автомагистраль с движением в обе стороны: направления разделены барьером,
 * поворотов налево через него нет, пересечения — только на разных уровнях.
 */
export const isDivided = (s: RoadSpec) => s.cls === 'motorway' && s.lanesF > 0 && s.lanesB > 0;
/** Ширина разделительной полосы с барьером. */
export const MEDIAN = 4;

/** Один железнодорожный путь (движение в обе стороны по очереди). */
export const RAIL_SPEC: RoadSpec = { cls: 'rail', lanesF: 1, lanesB: 1 };
export const RAIL_HALF = 5.5;
/** Горизонтальная длина подъёма на один уровень для рельсов — поезда любят пологие уклоны. */
export const RAIL_LEVEL_RUN = 130;

export const isRail = (s: RoadSpec) => s.cls === 'rail';
/** Максимальный угол, под которым поезд проходит узел (стрелка или продолжение пути). */
export const RAIL_SWITCH_ANGLE = 0.55;

export interface RoadSpec {
  cls: RoadClass;
  /** Полосы по направлению a→b. */
  lanesF: number;
  /** Полосы по направлению b→a. Для односторонних 0. */
  lanesB: number;
  /** Ограничение скорости, км/ч; нет — по умолчанию для класса. */
  limit?: number;
}

export interface RoadPreset {
  id: string;
  name: string;
  short: string;
  spec: RoadSpec;
}

/** От самой простой к самой быстрой; больше полос — в редакторе полос. */
export const ROAD_PRESETS: RoadPreset[] = [
  { id: 'oneway', name: 'Односторонняя', short: '1→', spec: { cls: 'street', lanesF: 1, lanesB: 0 } },
  { id: 'street', name: 'Улица', short: '1+1', spec: { cls: 'street', lanesF: 1, lanesB: 1 } },
  { id: 'avenue', name: 'Проспект', short: '2+2', spec: { cls: 'avenue', lanesF: 2, lanesB: 2 } },
  { id: 'road', name: 'Шоссе', short: '1+1', spec: { cls: 'highway', lanesF: 1, lanesB: 1 } },
  { id: 'hw2', name: 'Магистраль', short: '2+2', spec: { cls: 'highway', lanesF: 2, lanesB: 2 } },
  { id: 'mw2', name: 'Автомагистраль', short: '2‖2', spec: { cls: 'motorway', lanesF: 2, lanesB: 2 } },
];

export const MAX_LANES = 4;
export const LANE_W = 7;
export const ROAD_MARGIN = 1.5;
/** Горизонтальная длина, нужная для подъёма на один уровень. */
export const LEVEL_RUN = 70;

export const LEVELS = [
  { level: -1, name: 'Тоннель' },
  { level: 0, name: 'Земля' },
  { level: 1, name: 'Мост' },
  { level: 2, name: 'Эстакада' },
];

export const totalLanes = (s: RoadSpec) => s.lanesF + s.lanesB;
export const isOneWay = (s: RoadSpec) => s.lanesB === 0 || s.lanesF === 0;

/** Смещение полосы вправо от направления движения. index 0 — крайняя левая. */
export function laneOffset(spec: RoadSpec, count: number, index: number): number {
  if (isOneWay(spec)) return (index - (count - 1) / 2) * LANE_W;
  return (index + 0.5) * LANE_W + medianHalf(spec);
}

/** Половина разделительной полосы (0, если её нет). */
export const medianHalf = (spec: RoadSpec) => (isDivided(spec) ? MEDIAN / 2 : 0);

/** Полуширины проезжей части слева и справа от оси (в системе a→b). */
export function roadEdges(spec: RoadSpec): { left: number; right: number } {
  if (spec.cls === 'rail') return { left: RAIL_HALF, right: RAIL_HALF };
  if (isOneWay(spec)) {
    const half = (totalLanes(spec) * LANE_W) / 2 + ROAD_MARGIN;
    return { left: half, right: half };
  }
  const m = medianHalf(spec);
  return { left: spec.lanesB * LANE_W + ROAD_MARGIN + m, right: spec.lanesF * LANE_W + ROAD_MARGIN + m };
}

export const halfWidth = (spec: RoadSpec) => {
  const e = roadEdges(spec);
  return Math.max(e.left, e.right);
};

export function specCost(spec: RoadSpec): number {
  if (spec.cls === 'rail') return ROAD_CLASSES.rail.cost;
  return ROAD_CLASSES[spec.cls].cost * totalLanes(spec);
}

export const sameSpec = (a: RoadSpec, b: RoadSpec) =>
  a.cls === b.cls && a.lanesF === b.lanesF && a.lanesB === b.lanesB && specKmh(a) === specKmh(b);

export type RoadClass = 'dirt' | 'street' | 'avenue' | 'highway' | 'motorway' | 'rail';

/** Классы автодорог (без железной дороги), от самой простой: грунтовая — только стартовые просёлки (world/startRoads.ts). */
export const ROAD_CLASS_IDS: RoadClass[] = ['dirt', 'street', 'avenue', 'highway', 'motorway'];

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
  // Просёлок: самая дешёвая и медленная, без асфальта и разметки. Строит её только мир на старте — к предприятиям и от
  // городов за край карты (world/startRoads.ts); игрок сносит и перестраивает её, как любую дорогу.
  dirt: { id: 'dirt', name: 'Грунтовая', limit: 30, minRadius: 12, cost: 2 },
  street: { id: 'street', name: 'Улица', limit: 40, minRadius: 12, cost: 7 },
  avenue: { id: 'avenue', name: 'Проспект', limit: 60, minRadius: 26, cost: 9 },
  highway: { id: 'highway', name: 'Магистраль', limit: 90, minRadius: 70, cost: 13 },
  motorway: { id: 'motorway', name: 'Автомагистраль', limit: 120, minRadius: 150, cost: 17 },
  rail: { id: 'rail', name: 'Ж/д путь', limit: 120, minRadius: 110, cost: 45 },
};

/**
 * Во сколько раз метр полотна дороже, чем на земле: мост (уровень 1), эстакада (2), тоннель (−1),
 * мост через воду. Пандусы между уровнями — по промежуточной высоте.
 */
export const STRUCTURE = { bridge: 8, overpass: 10, tunnel: 14, water: 9, underWater: 6 };

/** Множитель цены в точке полотна на высоте h (уровень), water — под ней вода. */
export function structureFactor(h: number, water: boolean): number {
  if (h < -0.25) return 1 + (STRUCTURE.tunnel - 1) * Math.min(-h, 1) + (water ? STRUCTURE.underWater : 0);
  const up = h > 0.25 ? 1 + (STRUCTURE.bridge - 1) * Math.min(h, 1) + (STRUCTURE.overpass - STRUCTURE.bridge) * Math.max(0, Math.min(1, h - 1)) : 1;
  return water ? Math.max(up, STRUCTURE.water) : up;
}

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
/** Между осями соседних путей (двухпутка, путь рядом). */
export const TRACK_GAP = 13;
/** Горизонтальная длина подъёма на один уровень для рельсов — поезда любят пологие уклоны. */
export const RAIL_LEVEL_RUN = 130;

export const isRail = (s: RoadSpec) => s.cls === 'rail';
/** Грунтовая дорога — без асфальта и разметки. */
export const isDirt = (cls: RoadClass) => cls === 'dirt';
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
  // Одна полоса в одну сторону — это «Полоса»; односторонняя дорога — две.
  { id: 'oneway', name: 'Односторонняя', short: '2→', spec: { cls: 'street', lanesF: 2, lanesB: 0 } },
  { id: 'street', name: 'Улица', short: '1+1', spec: { cls: 'street', lanesF: 1, lanesB: 1 } },
  { id: 'avenue', name: 'Проспект', short: '2+2', spec: { cls: 'avenue', lanesF: 2, lanesB: 2 } },
  { id: 'road', name: 'Шоссе', short: '1+1', spec: { cls: 'highway', lanesF: 1, lanesB: 1 } },
  { id: 'hw2', name: 'Магистраль', short: '2+2', spec: { cls: 'highway', lanesF: 2, lanesB: 2 } },
  { id: 'mw2', name: 'Автомагистраль', short: '2‖2', spec: { cls: 'motorway', lanesF: 2, lanesB: 2 } },
];

/** Что строится, пока игрок не выбрал другой тип, — шоссе. */
export const DEFAULT_PRESET_ID = 'road';
export const defaultPreset = (): RoadPreset => ROAD_PRESETS.find((p) => p.id === DEFAULT_PRESET_ID)!;

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

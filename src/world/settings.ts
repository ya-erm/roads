/** Параметры новой игры. */
export interface WorldSettings {
  seed: number;
  size: MapSize;
  towns: number;
  industries: IndustryDensity;
  money: number;
  water: WaterAmount;
  /**
   * Версия генератора местности: мир из сохранения должен получиться тем же.
   * 1 (нет поля) — реки независимые и могут пересекаться, 2 — притоки впадают в реки.
   */
  terrainVersion?: number;
}

export const TERRAIN_VERSION = 2;

export type MapSize = 'small' | 'medium' | 'large';
export type IndustryDensity = 'few' | 'normal' | 'many';
export type WaterAmount = 'dry' | 'normal' | 'wet';

export const MAP_SIZES: Record<MapSize, { name: string; w: number; h: number }> = {
  small: { name: 'Маленькая', w: 6400, h: 4300 },
  medium: { name: 'Средняя', w: 9600, h: 6400 },
  large: { name: 'Большая', w: 12800, h: 8500 },
};

export const INDUSTRY_DENSITY: Record<IndustryDensity, { name: string; k: number }> = {
  few: { name: 'Мало', k: 0.6 },
  normal: { name: 'Обычно', k: 1 },
  many: { name: 'Много', k: 1.5 },
};

export const WATER: Record<WaterAmount, { name: string; rivers: [number, number]; lakes: [number, number] }> = {
  dry: { name: 'Сухо', rivers: [1, 1], lakes: [1, 2] },
  normal: { name: 'Обычно', rivers: [2, 3], lakes: [3, 5] },
  wet: { name: 'Много воды', rivers: [3, 4], lakes: [5, 8] },
};

export const MONEY_OPTIONS = [
  { value: 300_000, name: 'Скромно' },
  { value: 600_000, name: 'Обычно' },
  { value: 1_500_000, name: 'Богато' },
];

export const DEFAULT_SETTINGS: WorldSettings = {
  seed: 1,
  size: 'medium',
  towns: 10,
  industries: 'normal',
  money: 600_000,
  water: 'normal',
  terrainVersion: TERRAIN_VERSION,
};

/** Размеры городов: немного крупных, больше средних, остальные маленькие. */
export function townSizes(count: number): number[] {
  const big = Math.max(1, Math.round(count * 0.2));
  const mid = Math.round(count * 0.4);
  return Array.from({ length: count }, (_, i) => (i < big ? 3 : i < big + mid ? 2 : 1));
}

/** Во сколько раз площадь карты больше средней — чтобы масштабировать леса и предприятия. */
export function areaFactor(s: WorldSettings): number {
  const m = MAP_SIZES[s.size];
  return (m.w * m.h) / (MAP_SIZES.medium.w * MAP_SIZES.medium.h);
}

import type { ScenarioSettings } from '../scenario/types';
import type { BiomeId } from './biomes';

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
  /**
   * Рельеф местности: равнина, холмы или горы. Нет поля — старое сохранение, рельеф плоский
   * (высота всюду 0), чтобы старые партии не ломались.
   */
  relief?: Relief;
  /**
   * Биом: какие предприятия и цепочки на карте, что просят города и как выглядит земля (src/world/biomes.ts).
   * Нет поля — старое сохранение: средняя полоса с прежним набором предприятий.
   */
  biome?: BiomeId;
  /** Биом выбран «по seed» — следующая партия по этим настройкам тоже выберет его по seed. */
  biomeBySeed?: boolean;
  /** Режим сценария; нет — песочница. */
  scenario?: ScenarioSettings;
  /**
   * Строительство дорог: «Мгновенно» (нет поля — так же, старые партии) или «Со строительством» — дорога сначала
   * проект, потом стройка со временем (src/game/construction.ts).
   */
  construction?: BuildMode;
  /** Стройматериалы: нужны ли стройке (только вместе со строительством). Нет поля — не нужны. */
  materials?: MaterialsMode;
}

export type BuildMode = 'instant' | 'build';
export type MaterialsMode = 'none' | 'needed';

export const BUILD_MODES: Record<BuildMode, { name: string; hint: string }> = {
  instant: { name: 'Мгновенно', hint: 'Дорога готова сразу после клика' },
  build: { name: 'Со строительством', hint: 'Дорога — сначала проект, потом стройка: участок за участком, деньги — за каждый готовый метр' },
};

export const MATERIALS_MODES: Record<MaterialsMode, { name: string; hint: string }> = {
  none: { name: 'Не нужны', hint: 'Стройке хватает денег' },
  needed: { name: 'Нужны', hint: 'Стройке нужны стройматериалы или камень со склада базы' },
};

/**
 * Как генерировать карту под архетип сценария. Без профиля генерация та же, что в песочнице.
 */
export interface WorldProfile {
  /** Доли крупных и средних городов (остальные — маленькие). */
  big: number;
  mid: number;
  /** Наименьший зазор между городами. */
  gap: number;
  /** Тяга городов к общему центру: 0 — по всей карте, 1 — плотной группой. */
  cluster: number;
  /** Множители числа сырьевых предприятий и заводов. */
  raw: number;
  plants: number;
  /** Заводы встают ближе к поставщикам своего сырья: 0…1. */
  affinity: number;
  /** Предприятия тянутся к крупнейшему городу (логистический узел): 0…1. */
  hub: number;
}

export const TERRAIN_VERSION = 2;

export type MapSize = 'small' | 'medium' | 'large';
export type IndustryDensity = 'few' | 'normal' | 'many';
export type WaterAmount = 'dry' | 'normal' | 'wet';
export type Relief = 'plains' | 'hills' | 'mountains';

/** Амплитуда высоты рельефа (м по обе стороны от нуля) и сколько метров между изолиниями. */
export const RELIEF: Record<Relief, { name: string; amplitude: number; contour: number }> = {
  plains: { name: 'Равнина', amplitude: 14, contour: 4 },
  hills: { name: 'Холмы', amplitude: 55, contour: 10 },
  mountains: { name: 'Горы', amplitude: 150, contour: 20 },
};

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

/** Размеры городов: немного крупных, больше средних, остальные маленькие (доли — по профилю сценария). */
export function townSizes(count: number, shares: { big: number; mid: number } = { big: 0.2, mid: 0.4 }): number[] {
  const big = Math.max(1, Math.round(count * shares.big));
  const mid = Math.round(count * shares.mid);
  return Array.from({ length: count }, (_, i) => (i < big ? 3 : i < big + mid ? 2 : 1));
}

/** Во сколько раз площадь карты больше средней — чтобы масштабировать леса и предприятия. */
export function areaFactor(s: WorldSettings): number {
  const m = MAP_SIZES[s.size];
  return (m.w * m.h) / (MAP_SIZES.medium.w * MAP_SIZES.medium.h);
}

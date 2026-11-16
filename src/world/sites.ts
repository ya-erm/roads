/**
 * Правила места под предприятие при генерации мира: рельеф, берег, сколько предприятий вида в биоме. Общие для
 * готовых предприятий (worldgen.ts) и месторождений режима «Строит игрок» (deposits.ts).
 */
import type { Rng } from '../core/rng';
import type { Vec } from '../core/vec';
import { industryShare } from './biomes';
import type { IndustryKind } from './cargo';
import type { WorldSettings } from './settings';
import { Footprint, footprintRadius } from './spatial';
import type { Terrain } from './terrain';

/** Предприятия хотят относительно ровное место (уклон рельефа, м/м); города — см. townSites. */
export const FLAT_SLOPE = 0.18;
/** Шахты, рудники и карьеры тяготеют к склонам холмов. */
export const MINING_KINDS = new Set<IndustryKind>(['coalmine', 'ironmine', 'quarry', 'gemmine', 'coppermine', 'goldmine']);
const HILL_SLOPE = 0.035;

/** Рыбаки — на берегу (до воды не дальше стольких единиц от края участка); остальным «у воды» — до SHORE_FAR. */
const SHORE_NEAR = 120;
const SHORE_FAR = 450;
/** После стольких попыток место у воды не требуется: на сухой карте предприятие всё равно встанет. */
const SHORE_ATTEMPTS = 90;

/**
 * Предприятию нужно место у воды (рыбаки — всегда, в биоме — его виды «у воды»): берег не дальше reach
 * от края участка. Без требования — всегда да.
 */
export function shoreFits(terrain: Terrain, fp: Footprint, attempt: number, nearWater: ReadonlySet<IndustryKind>, kind: IndustryKind): boolean {
  if (attempt >= SHORE_ATTEMPTS) return true;
  if (kind === 'fishery') return terrain.isWater(fp.center, footprintRadius(fp) + SHORE_NEAR);
  return !nearWater.has(kind) || terrain.isWater(fp.center, footprintRadius(fp) + SHORE_FAR);
}

/**
 * Место рыбакам: каждая вторая попытка, пока берег обязателен (shoreFits), — не наугад по карте, а рядом со случайной
 * точкой реки или берега озера: в стороне от воды на радиус участка r и ещё 20–100 м. Города крупнее (TOWN_SCALE) и
 * стоят на реках — наугад свободный берег находился редко, рыбаки вставали в поле. Остальные попытки и сухая карта —
 * null: место наугад, как прежде.
 */
export function shoreSpot(terrain: Terrain, rng: Rng, kind: IndustryKind, attempt: number, r: number): Vec | null {
  if (kind !== 'fishery' || attempt >= SHORE_ATTEMPTS || attempt % 2 === 0) return null;
  const { rivers, lakes } = terrain;
  if (!rivers.length && !lakes.length) return null;
  const k = rng.int(0, rivers.length + lakes.length);
  let p: Vec;
  let a: number;
  let off: number;
  if (k < rivers.length) {
    const river = rivers[k];
    p = river.points[rng.int(0, river.points.length)];
    a = rng.range(0, Math.PI * 2);
    off = river.width / 2;
  } else {
    // От края озера — наружу.
    const lake = lakes[k - rivers.length];
    a = rng.range(0, Math.PI * 2);
    p = { x: lake.center.x + Math.cos(a) * lake.radius, y: lake.center.y + Math.sin(a) * lake.radius };
    off = 0;
  }
  const d = off + r + rng.range(20, 100);
  const clampTo = (v: number, size: number) => Math.max(300, Math.min(size - 300, v));
  return { x: clampTo(p.x + Math.cos(a) * d, terrain.width), y: clampTo(p.y + Math.sin(a) * d, terrain.height) };
}

/** Сколько предприятий вида поставить: по множителю биома (0 — ни одного), но если вид есть — хотя бы одно. */
export function industryCount(settings: WorldSettings, kind: IndustryKind, base: number): number {
  const share = industryShare(settings, kind);
  return share > 0 ? Math.max(1, Math.round(base * share)) : 0;
}

/** Место для завода — ровное; для шахты, рудника, карьера — на склоне холма.
 *  Без рельефа (старые миры) slopeAt всюду 0 и это условие ничего не отсеивает. Порог мягко
 *  растёт (для равнинных) или падает (для холмистых) с номером попытки — на крутом мире место
 *  всё равно найдётся. */
export function terrainFits(terrain: Terrain, p: Vec, attempt: number, mining = false): boolean {
  if (!terrain.hasRelief) return true;
  const slope = terrain.slopeAt(p);
  return mining ? slope >= HILL_SLOPE * Math.max(0, 1 - attempt / 100) : slope <= FLAT_SLOPE * (1 + attempt / 50);
}

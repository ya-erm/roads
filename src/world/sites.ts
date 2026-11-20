/**
 * Правила места под предприятие при генерации мира: рельеф, берег, сколько предприятий вида в биоме. Общие для
 * готовых предприятий (worldgen.ts) и месторождений режима «Строит игрок» (deposits.ts).
 */
import type { Rng } from '../core/rng';
import type { Vec } from '../core/vec';
import { industryShare } from './biomes';
import type { IndustryKind } from './cargo';
import { sitePoint } from './industrySites';
import type { WorldSettings } from './settings';
import { type Footprint, type Plot, footprintRadius } from './spatial';
import { HEIGHT_CELL, type Terrain } from './terrain';

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

/** Общая площадка под корпусами, полями и внутренними проездами. */
function industryGround(fp: Footprint): Footprint {
  if (!fp.parts) return fp;
  const points = fp.parts.flat();
  const l = Math.min(...points.map((p) => p.x));
  const r = Math.max(...points.map((p) => p.x));
  const t = Math.min(...points.map((p) => p.y));
  const b = Math.max(...points.map((p) => p.y));
  return { center: sitePoint(fp, [(l + r) / 2, (t + b) / 2]), angle: fp.angle, w: (r - l) * fp.w, h: (b - t) * fp.h };
}

function groundHeights(terrain: Pick<Terrain, 'heightAt'>, area: Footprint): { spread: number; mean: number } {
  const nx = Math.max(2, Math.ceil(area.w / 36));
  const ny = Math.max(2, Math.ceil(area.h / 36));
  let lo = Infinity;
  let hi = -Infinity;
  let sum = 0;
  for (let i = 0; i <= nx; i++) {
    for (let j = 0; j <= ny; j++) {
      const h = terrain.heightAt(sitePoint(area, [i / nx - 0.5, j / ny - 0.5]));
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
      sum += h;
    }
  }
  return { spread: hi - lo, mean: sum / ((nx + 1) * (ny + 1)) };
}

export function industryReliefSpread(terrain: Terrain, fp: Footprint): number {
  return groundHeights(terrain, industryGround(fp)).spread;
}

const RECTANGLE: Plot = [{ x: -0.5, y: -0.5 }, { x: 0.5, y: -0.5 }, { x: 0.5, y: 0.5 }, { x: -0.5, y: 0.5 }];

/** Смотрим на перепад по всей территории. Чем дольше ищем, тем больше допустимый перепад. */
export function terrainFits(terrain: Pick<Terrain, 'hasRelief' | 'heightAt'>, fp: Footprint, attempt: number): boolean {
  if (!terrain.hasRelief) return true;
  const area = industryGround(fp);
  return groundHeights(terrain, area).spread <= 5 + Math.max(area.w, area.h) * 0.025 + Math.min(18, attempt / 7);
}

/** Выравниваем уже выбранный участок. Проверка clear бережёт существующие дороги и соседние постройки. */
export function levelIndustryGround(terrain: Terrain, fp: Footprint, clear: (work: Footprint) => boolean): void {
  if (!terrain.hasRelief) return;
  const area = industryGround(fp);
  const { spread, mean } = groundHeights(terrain, area);
  if (spread < 3) return;
  const w = area.w + 2 * HEIGHT_CELL;
  const h = area.h + 2 * HEIGHT_CELL;
  const preferred = Math.max(60, spread * 3.5);
  const short = Math.max(32, spread * 2.5);
  for (const r of [preferred, short]) {
    const extent = 2 * (r + HEIGHT_CELL);
    const work = { ...area, w: w + extent, h: h + extent, parts: [RECTANGLE] };
    if (!terrain.inBounds(work.center, footprintRadius(work)) || !clear(work)) continue;
    terrain.terraform({
      x: area.center.x, y: area.center.y, r, mode: 'flatten', amount: 1.9,
      target: Math.max(mean, terrain.waterLevel + 1), area: { w, h, angle: area.angle },
    });
    return;
  }
}

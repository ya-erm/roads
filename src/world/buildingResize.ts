import { dist, dot, sub, type Vec } from '../core/vec';
import type { TownBuilding } from './entities';
import { lotFrame } from './houseAccess';
import type { Footprint } from './spatial';

export const BUILDING_SIZE = {
  step: 2,
  width: { min: 28, max: 240 },
  depth: { min: 28, max: 200 },
};

export interface BuildingCorner {
  side: -1 | 1;
  edge: 'front' | 'back';
  pos: Vec;
}

export function buildingCorners(b: Pick<TownBuilding, 'fp' | 'face'>): BuildingCorner[] {
  const at = lotFrame(b);
  const { w, h } = b.fp;
  return [
    { side: -1, edge: 'front', pos: at(-w / 2, -h / 2) },
    { side: 1, edge: 'front', pos: at(w / 2, -h / 2) },
    { side: -1, edge: 'back', pos: at(-w / 2, h / 2) },
    { side: 1, edge: 'back', pos: at(w / 2, h / 2) },
  ];
}

export function buildingCornerAt(corners: BuildingCorner[], at: Vec, radius: number): BuildingCorner | undefined {
  let closest: BuildingCorner | undefined;
  for (const corner of corners) {
    const d = dist(corner.pos, at);
    if (d > radius) continue;
    radius = d;
    closest = corner;
  }
  return closest;
}

function snapSize(current: number, change: number, limits: { min: number; max: number }): number {
  const step = BUILDING_SIZE.step;
  // У старых и сгенерированных зданий размер может быть дробным или за пределами редактора.
  // Тянем от фактического размера, без скачка к сетке.
  const minSteps = Math.min(0, Math.ceil((limits.min - current) / step));
  const maxSteps = Math.max(0, Math.floor((limits.max - current) / step));
  return current + Math.max(minSteps, Math.min(maxSteps, Math.round(change / step))) * step;
}

/** Край вдоль улицы и противоположная сторона стоят на месте. Дальние углы меняют ещё и глубину. */
export function resizeBuildingFootprint(b: Pick<TownBuilding, 'fp' | 'face'>, corner: BuildingCorner, drag: Vec): Footprint {
  const { fp } = b;
  const at = lotFrame(b);
  const dw = dot(drag, sub(at(1, 0), fp.center)) * corner.side;
  const dh = corner.edge === 'back' ? dot(drag, sub(at(0, 1), fp.center)) : 0;
  const w = snapSize(fp.w, dw, BUILDING_SIZE.width);
  const h = snapSize(fp.h, dh, BUILDING_SIZE.depth);
  return { ...fp, w, h, center: at(corner.side * (w - fp.w) / 2, (h - fp.h) / 2) };
}

export function buildingResizeCursor(b: Pick<TownBuilding, 'fp'>, corner: BuildingCorner): string {
  const diagonal = corner.edge === 'back' ? Math.atan2(corner.side, 1) : 0;
  const index = ((Math.round((b.fp.angle + diagonal) / (Math.PI / 4)) % 4) + 4) % 4;
  return ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][index];
}

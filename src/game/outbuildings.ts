/**
 * Постройки рядом с основным зданием — склады станций и пристройки предприятий: игрок ставит их мышью в небольшой
 * зоне вокруг «хозяина». Общая геометрия: зона, контур постройки по оси хозяина, целиком ли она в зоне.
 * Проверки площадки (вода, дома, дороги, край карты) — Game.outbuildingProblem.
 */
import { dist, type Vec } from '../core/vec';
import { footprintCorners, footprintRadius, type Footprint } from '../world/spatial';

/** Докуда от центра хозяина можно ставить постройку: его «радиус» и ещё zone. */
export function outbuildingZone(owner: Footprint, zone: number): number {
  return footprintRadius(owner) + zone;
}

/** Постройка w×h с центром в p — по оси хозяина, «в ряд» с ним. */
export function outbuildingFootprint(owner: Footprint, p: Vec, w: number, h: number): Footprint {
  return { center: { x: p.x, y: p.y }, w, h, angle: owner.angle };
}

/** Постройка целиком в зоне хозяина. */
export function inOutbuildingZone(owner: Footprint, zone: number, fp: Footprint): boolean {
  const r = outbuildingZone(owner, zone);
  return footprintCorners(fp).every((c) => dist(c, owner.center) <= r);
}

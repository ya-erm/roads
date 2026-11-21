import { closestOnSegment, dist, dot, lerp, norm, segmentIntersection, sub, type Vec } from '../core/vec';
import type { LaneNet } from '../lanes/model';
import { inPolygon, junctionPlate, lotOutline } from '../world/lotClear';
import { footprintRadius, pointInFootprint, type Footprint } from '../world/spatial';
import { sideHalfAt } from '../world/worldgen';

export interface Footpath {
  id: number;
  a: Vec;
  b: Vec;
}

export const FOOTPATH = { width: 2, minLength: 2, pricePerMetre: 18 };
const EPS = 0.015;

export function pathFootprint(a: Vec, b: Vec): Footprint {
  return { center: lerp(a, b, 0.5), w: dist(a, b), h: FOOTPATH.width, angle: Math.atan2(b.y - a.y, b.x - a.x) };
}

/** Фактическая кромка со стороны дорожки: на улице с односторонней парковкой ширина обочин различается. */
export function pathCrossesRoad(net: LaneNet, fp: Footprint, outline = lotOutline(fp, 3)): boolean {
  const r = footprintRadius(fp) + 40;
  for (const c of net.corridorsNear(fp.center, r)) {
    for (const q of outline) {
      const near = c.lut.closest(q);
      if (Math.abs(net.heightAt(c, near.s)) > 0.6) continue;
      const t = c.lut.tangentAt(near.s);
      const side = t.x * (q.y - near.point.y) - t.y * (q.x - near.point.x);
      if (near.d < sideHalfAt(c, near.s, side)) return true;
    }
  }
  for (const n of net.nodesNear(fp.center, r)) {
    if (n.level) continue;
    const plate = junctionPlate(net, n);
    if (plate && (outline.some(p => inPolygon(p, plate)) || plate.some(p => pointInFootprint(p, fp)))) return true;
  }
  return false;
}

export function nearestFootpath(paths: readonly Footpath[], p: Vec, radius: number) {
  let nearest: { path: Footpath; pos: Vec; d: number } | undefined;
  for (const path of paths) {
    const { point, d } = closestOnSegment(p, path.a, path.b);
    if (d <= radius && (!nearest || d < nearest.d)) nearest = { path, pos: point, d };
  }
  return nearest;
}

/** Наложение на одной прямой запрещено, торец к торцу — можно. */
export function overlapsFootpath(paths: readonly Footpath[], a: Vec, b: Vec): boolean {
  const axis = norm(sub(b, a));
  const length = dist(a, b);
  const side = { x: -axis.y, y: axis.x };
  return paths.some(path => {
    const u = sub(path.a, a);
    const v = sub(path.b, a);
    if (Math.abs(dot(u, side)) > EPS || Math.abs(dot(v, side)) > EPS) return false;
    const start = dot(u, axis);
    const end = dot(v, axis);
    return Math.min(length, Math.max(start, end)) - Math.max(0, Math.min(start, end)) > EPS;
  });
}

/** Обе линии получают общий узел в каждом пересечении, в том числе на концах Т-образной развилки. */
export function joinFootpath(paths: readonly Footpath[], a: Vec, b: Vec, nextId: () => number): Footpath[] {
  const result: Footpath[] = [];
  const cuts: Vec[] = [a, b];
  for (const path of paths) {
    // Точку привязки к середине могут отдалить от оси погрешности округления.
    const hit = segmentIntersection(a, b, path.a, path.b)?.point
      ?? [a, b].find(p => closestOnSegment(p, path.a, path.b).d < EPS)
      ?? [path.a, path.b].find(p => closestOnSegment(p, a, b).d < EPS);
    if (!hit) {
      result.push(path);
      continue;
    }
    const join = [path.a, path.b, a, b].find(p => dist(p, hit) < EPS) ?? hit;
    cuts.push(join);
    if (dist(join, path.a) < EPS || dist(join, path.b) < EPS) result.push(path);
    else result.push({ ...path, b: join }, { id: nextId(), a: join, b: path.b });
  }
  cuts.sort((p, q) => dist(a, p) - dist(a, q));
  let start = cuts[0];
  for (const end of cuts.slice(1)) {
    if (dist(start, end) < EPS) continue;
    result.push({ id: nextId(), a: start, b: end });
    start = end;
  }
  return result;
}

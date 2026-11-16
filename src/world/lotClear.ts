import { closestOnSegment, type Vec } from '../core/vec';
import { junctionCuts, plateOutline } from '../lanes/geometry';
import type { LaneNet } from '../lanes/model';
import { type Footprint, footprintRadius, pointInFootprint } from './spatial';
import { halfAtS } from './worldgen';

/**
 * Участок (дом с двором или площадью, парк) не заходит на дороги ближе edge к фактическому краю асфальта — по той же
 * геометрии, что рисуется полотно и тротуар (lanes/geometry): вдоль полотна — край полос в каждой точке (halfAtS: у
 * широкой дороги и на уширении край дальше от оси), у перекрёстка — контур площадки со скруглениями углов
 * (plateOutline). Тоннели — под землёй, не мешают. Перенос дома и парка (Game.movePlan, Game.parkMovePlan): edge —
 * дальний край тротуара (roadTypes.WALK_EDGE), участок не налезает ни на асфальт, ни на тротуар.
 */
export function lotClearOfRoads(net: LaneNet, fp: Footprint, edge: number): boolean {
  const R = footprintRadius(fp);
  const pts = lotOutline(fp, 3);
  const under = (c: { a: number; b: number }) => net.node(c.a).level < 0 && net.node(c.b).level < 0;
  for (const c of net.corridorsNear(fp.center, R + edge + 40)) {
    if (under(c)) continue;
    for (const q of pts) {
      const hit = c.lut.closest(q);
      if (hit.d < halfAtS(c, hit.s) + edge) return false;
    }
    // Ось внутри участка (тупик, что кончается в глубине участка): контур её не заметил бы.
    for (let s = 0; s <= c.length; s += 3) if (pointInFootprint(c.lut.pointAt(Math.min(s, c.length)), fp, edge)) return false;
  }
  for (const n of net.nodesNear(fp.center, R + edge + 40)) {
    if (n.level < 0 || n.kind !== 'junction' || net.ends(n).length < 2) continue;
    const ends = net.ends(n);
    const plate = plateOutline(
      net,
      n,
      junctionCuts(
        net,
        ends.map((e) => e.corridor),
        [n],
      ),
    )?.poly;
    if (!plate || plate.length < 3) continue;
    for (const q of plate) if (pointInFootprint(q, fp, edge)) return false;
    for (const q of pts) if (inPolygon(q, plate) || polyDist(q, plate) < edge) return false;
  }
  return true;
}

/** Точки контура участка через step м (и углы). */
export function lotOutline(fp: Footprint, step: number): Vec[] {
  const c = Math.cos(fp.angle);
  const s = Math.sin(fp.angle);
  const nx = Math.max(1, Math.ceil(fp.w / step));
  const ny = Math.max(1, Math.ceil(fp.h / step));
  const out: Vec[] = [];
  const put = (u: number, v: number) => out.push({ x: fp.center.x + u * c - v * s, y: fp.center.y + u * s + v * c });
  for (let i = 0; i <= nx; i++) {
    const u = (i / nx - 0.5) * fp.w;
    put(u, -fp.h / 2);
    put(u, fp.h / 2);
  }
  for (let j = 1; j < ny; j++) {
    const v = (j / ny - 0.5) * fp.h;
    put(-fp.w / 2, v);
    put(fp.w / 2, v);
  }
  return out;
}

/** Точки внутри участка сеткой через step м (середины клеток). */
export function lotGrid(fp: Footprint, step: number): Vec[] {
  const c = Math.cos(fp.angle);
  const s = Math.sin(fp.angle);
  const nx = Math.max(1, Math.round(fp.w / step));
  const ny = Math.max(1, Math.round(fp.h / step));
  const out: Vec[] = [];
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const u = ((i + 0.5) / nx - 0.5) * fp.w;
      const v = ((j + 0.5) / ny - 0.5) * fp.h;
      out.push({ x: fp.center.x + u * c - v * s, y: fp.center.y + u * s + v * c });
    }
  }
  return out;
}

function inPolygon(p: Vec, poly: readonly Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function polyDist(p: Vec, poly: readonly Vec[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) best = Math.min(best, closestOnSegment(p, poly[i], poly[(i + 1) % poly.length]).d);
  return best;
}

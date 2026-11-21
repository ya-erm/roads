import { splitBezier, type Cubic } from '../core/bezier';
import { add, closestOnSegment, cross, dist, dot, lerp, norm, segmentIntersection, sub, type Vec } from '../core/vec';
import type { LaneNet } from '../lanes/model';
import { inPolygon, junctionPlate, lotOutline } from '../world/lotClear';
import { footprintRadius, pointInFootprint, type Footprint } from '../world/spatial';
import { sideHalfAt } from '../world/worldgen';

export interface Footpath {
  id: number;
  parkId?: number;
  width?: number;
  a: Vec;
  b: Vec;
  shape?: FootpathShape;
  /** От дворового прохода наследуются покрытие и его ширина. Без поля — обычная мощёная дорожка игрока. */
  surface?: 'paved' | 'path';
  /** Стоимость исходного прохода, построенного городом, вычитается из возврата при сносе. */
  cityCost?: number;
}

export type FootpathShape = { kind: 'arc'; through: Vec } | { kind: 'curve'; c1: Vec; c2: Vec } | { kind: 'polyline'; via: Vec[] };
type PathGeometry = Omit<Footpath, 'id'>;
export const FOOTPATH = { width: 2, minLength: 2, pricePerMetre: 18 };
export const WALK_W = { paved: 1.6, path: 1.2 } as const;

export function footpathWidth(path: Pick<Footpath, 'surface' | 'width'>): number {
  return path.width ?? (path.surface ? WALK_W[path.surface] : FOOTPATH.width);
}
const EPS = 0.015;
const PRECISION = 0.06;
const lines = new WeakMap<PathGeometry, Vec[]>();
type Bounds = { x0: number; x1: number; y0: number; y1: number };
const bounds = new WeakMap<PathGeometry, Bounds>();

/** Все проверки, отрисовка и пешеходы используют одну ось дорожки. У старых сохранений это отрезок. */
export function footpathPoints(path: PathGeometry): Vec[] {
  const cached = lines.get(path);
  if (cached) return cached;
  const { a, b, shape } = path;
  const points = [a];
  if (shape?.kind === 'polyline') {
    points.push(...shape.via, b);
  } else if (shape?.kind === 'curve') {
    const flatten = (c: Cubic, depth: number) => {
      if (depth < 11 && Math.max(closestOnSegment(c.p1, c.p0, c.p3).d, closestOnSegment(c.p2, c.p0, c.p3).d) > PRECISION) {
        const [left, right] = splitBezier(c, 0.5);
        flatten(left, depth + 1);
        flatten(right, depth + 1);
      } else points.push(c.p3);
    };
    flatten({ p0: a, p1: shape.c1, p2: shape.c2, p3: b }, 0);
  } else if (shape?.kind === 'arc') {
    const u = sub(shape.through, a);
    const v = sub(b, a);
    const det = 2 * cross(u, v);
    if (Math.abs(det) > 1e-6) {
      const uu = dot(u, u), vv = dot(v, v);
      const center = add(a, { x: (uu * v.y - vv * u.y) / det, y: (vv * u.x - uu * v.x) / det });
      const radius = dist(center, a);
      const arcTo = (from: Vec, to: Vec) => {
        const start = Math.atan2(from.y - center.y, from.x - center.x);
        let angle = Math.atan2(to.y - center.y, to.x - center.x) - start;
        if (angle * det < 0) angle += Math.sign(det) * 2 * Math.PI;
        const step = 2 * Math.acos(Math.max(-1, 1 - PRECISION / radius));
        const count = Math.min(2048, Math.max(1, Math.ceil(Math.abs(angle) / step)));
        for (let i = 1; i < count; i++) {
          const t = start + angle * i / count;
          points.push({ x: center.x + radius * Math.cos(t), y: center.y + radius * Math.sin(t) });
        }
        points.push(to);
      };
      arcTo(a, shape.through);
      arcTo(shape.through, b);
    } else points.push(b);
  } else points.push(b);
  lines.set(path, points);
  return points;
}

export function footpathLength(path: PathGeometry): number {
  const line = footpathPoints(path);
  return line.reduce((sum, p, i) => i ? sum + dist(line[i - 1], p) : sum, 0);
}

export function footpathParts(path: PathGeometry): Footprint[] {
  const line = footpathPoints(path);
  return line.slice(1).map((p, i) => pathFootprint(line[i], p, footpathWidth(path)));
}

export function footpathBounds(path: PathGeometry) {
  const cached = bounds.get(path);
  if (cached) return cached;
  const line = footpathPoints(path);
  const box = { x0: path.a.x, x1: path.a.x, y0: path.a.y, y1: path.a.y };
  for (const p of line) {
    box.x0 = Math.min(box.x0, p.x);
    box.x1 = Math.max(box.x1, p.x);
    box.y0 = Math.min(box.y0, p.y);
    box.y1 = Math.max(box.y1, p.y);
  }
  bounds.set(path, box);
  return box;
}

export function footpathInBox(path: Footpath, x0: number, y0: number, x1: number, y1: number): boolean {
  const points = footpathPoints(path);
  const corners = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  if (points.some(p => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1)) return true;
  return points.slice(1).some((b, i) => corners.some((c, j) => segmentIntersection(points[i], b, c, corners[(j + 1) % 4])));
}

export function pathFootprint(a: Vec, b: Vec, width = FOOTPATH.width): Footprint {
  return { center: lerp(a, b, 0.5), w: dist(a, b), h: width, angle: Math.atan2(b.y - a.y, b.x - a.x) };
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
    const box = footpathBounds(path);
    if (p.x < box.x0 - radius || p.x > box.x1 + radius || p.y < box.y0 - radius || p.y > box.y1 + radius) continue;
    const line = footpathPoints(path);
    for (let i = 1; i < line.length; i++) {
      const { point, d } = closestOnSegment(p, line[i - 1], line[i]);
      if (d <= radius && (!nearest || d < nearest.d)) nearest = { path, pos: point, d };
    }
  }
  return nearest;
}

/** Наложение на одной прямой запрещено, торец к торцу — можно. */
function overlap(a: Vec, b: Vec, c: Vec, d: Vec): boolean {
  const axis = norm(sub(b, a));
  const length = dist(a, b);
  const side = { x: -axis.y, y: axis.x };
  const u = sub(c, a);
  const v = sub(d, a);
  if (Math.abs(dot(u, side)) > EPS || Math.abs(dot(v, side)) > EPS) return false;
  const start = dot(u, axis);
  const end = dot(v, axis);
  return Math.min(length, Math.max(start, end)) - Math.max(0, Math.min(start, end)) > EPS;
}

export function overlapsFootpath(paths: readonly Footpath[], geometry: PathGeometry): boolean {
  const line = footpathPoints(geometry);
  const box = footpathBounds(geometry);
  return paths.some(path => {
    const otherBox = footpathBounds(path);
    if (box.x0 > otherBox.x1 + EPS || box.x1 < otherBox.x0 - EPS || box.y0 > otherBox.y1 + EPS || box.y1 < otherBox.y0 - EPS) return false;
    const other = footpathPoints(path);
    for (let i = 1; i < line.length; i++) for (let j = 1; j < other.length; j++) {
      if (overlap(line[i - 1], line[i], other[j - 1], other[j])) return true;
    }
    return false;
  });
}

/** Разрезается только граф. При выборе и сносе любая ветвь кривой относится к той же самой дорожке. */
export function footpathNetwork(paths: readonly PathGeometry[]): { a: Vec; b: Vec }[] {
  const segments = paths.flatMap(path => {
    const line = footpathPoints(path);
    return line.slice(1).map((b, i) => {
      const a = line[i];
      return { a, b, minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), cuts: [a, b] };
    });
  }).sort((a, b) => a.minX - b.minX);
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    for (let j = i + 1; j < segments.length && segments[j].minX <= s.maxX + EPS; j++) {
      const t = segments[j];
      if (Math.max(s.a.y, s.b.y) + EPS < Math.min(t.a.y, t.b.y) || Math.max(t.a.y, t.b.y) + EPS < Math.min(s.a.y, s.b.y)) continue;
      const hit = segmentIntersection(s.a, s.b, t.a, t.b)?.point
        ?? [s.a, s.b].find(p => closestOnSegment(p, t.a, t.b).d < EPS)
        ?? [t.a, t.b].find(p => closestOnSegment(p, s.a, s.b).d < EPS);
      if (hit) {
        s.cuts.push(hit);
        t.cuts.push(hit);
      }
    }
  }
  return segments.flatMap(({ a, cuts }) => {
    cuts.sort((p, q) => dist(a, p) - dist(a, q));
    return cuts.slice(1).flatMap((b, i) => dist(cuts[i], b) > EPS ? [{ a: cuts[i], b }] : []);
  });
}

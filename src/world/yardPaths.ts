import { TOWN_SCALE } from '../config';
import { hash } from '../core/math';
import type { Vec } from '../core/vec';
import type { Footpath } from '../game/footpaths';
import type { Town, TownBuilding } from './entities';
import { LOT_SETBACK } from './houseAccess';
import { SIDEWALK } from './roadTypes';
import type { Footprint } from './spatial';
import { townTier } from './townForms';

/** Промежуток между домами ряда, в который помещается дорожка, м. */
const GAP = { min: 2.2, max: 11 };

/** Координаты точки p в осях участка f (x — вдоль улицы, y — поперёк) и обратно. */
function toLocal(f: Footprint, p: Vec): Vec {
  const c = Math.cos(f.angle);
  const s = Math.sin(f.angle);
  const dx = p.x - f.center.x;
  const dy = p.y - f.center.y;
  return { x: dx * c + dy * s, y: -dx * s + dy * c };
}
export function plotPoint(f: Footprint, x: number, y: number): [number, number] {
  const c = Math.cos(f.angle);
  const s = Math.sin(f.angle);
  return [f.center.x + x * c - y * s, f.center.y + x * s + y * c];
}

const parallel = (a: Footprint, b: Footprint) => Math.cos(a.angle - b.angle) > 0.997;
const rowHouse = (b: TownBuilding) => b.kind !== 'landmark' && b.form !== 'tower';

const cache = new WeakMap<Town, { layout: number; buildings: TownBuilding[]; count: number; reach: number; paths: Footpath[] }>();

/** У каждого дома по одному боковому проходу и подходу сзади. Их ID устойчивы при росте города и загрузке. */
export function yardPaths(town: Town, layout: number): Footpath[] {
  const side = townTier(town) === 'village' ? SIDEWALK.path : SIDEWALK.paved;
  const reach = LOT_SETBACK - side.from - side.w + 0.5;
  const old = cache.get(town);
  if (old && old.layout === layout && old.buildings === town.buildings && old.count === town.buildings.length && old.reach === reach) return old.paths;
  const paths: Footpath[] = [];
  const list = town.buildings.filter(rowHouse);
  const near = (a: TownBuilding, b: TownBuilding, d: number) => Math.abs(a.fp.center.x - b.fp.center.x) < d && Math.abs(a.fp.center.y - b.fp.center.y) < d;
  // Соседи — по клеткам сетки CELL м (в масштабе участков, TOWN_SCALE): не каждый дом с каждым.
  const CELL = 70 * TOWN_SCALE;
  const grid = new Map<string, TownBuilding[]>();
  const cellOf = (x: number, y: number) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
  for (const b of list) {
    const k = cellOf(b.fp.center.x, b.fp.center.y);
    const cell = grid.get(k);
    if (cell) cell.push(b);
    else grid.set(k, [b]);
  }
  const around = (b: TownBuilding) => {
    const cx = Math.floor(b.fp.center.x / CELL);
    const cy = Math.floor(b.fp.center.y / CELL);
    const res: TownBuilding[] = [];
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) res.push(...(grid.get(`${cx + i},${cy + j}`) ?? []));
    return res;
  };
  const rearOf = new Map<TownBuilding, TownBuilding>();
  for (const f of list) {
    const face = f.face ?? -1;
    const frontY = face * (f.fp.h / 2 + reach);
    let rightGap: { at: number; x: number; back: number } | null = null;
    for (const b of around(f)) {
      if (b === f || !near(f, b, (f.fp.w + b.fp.w) / 2 + f.fp.h + b.fp.h + GAP.max) || !parallel(f.fp, b.fp) || (b.face ?? -1) !== face) continue;
      const q = toLocal(f.fp, b.fp.center);
      // Дом второго ряда за f: позади, напротив его середины.
      if (Math.abs(q.x) < f.fp.w / 2 && q.y * face < 0 && Math.abs(q.y) >= f.fp.h / 2 + 2 && Math.abs(q.y) - (f.fp.h + b.fp.h) / 2 < 12) {
        if (!rearOf.has(b)) rearOf.set(b, f);
        continue;
      }
      // Сосед по ряду: фасады на одной линии, между ними — промежуток.
      const line = q.y + (face * b.fp.h) / 2 - (face * f.fp.h) / 2;
      if (Math.abs(line) > 3.5) continue;
      const gap = Math.abs(q.x) - (f.fp.w + b.fp.w) / 2;
      if (gap < GAP.min || gap > GAP.max || q.x < 0) continue;
      // Промежуток справа — на совести f (слева — у соседа); глубина — до задней стороны глубокого из двух.
      if (!rightGap || q.x < rightGap.at) rightGap = { at: q.x, x: f.fp.w / 2 + gap / 2, back: Math.max(f.fp.h / 2, -face * q.y + b.fp.h / 2) };
    }
    // Дорожка — у части промежутков, по хешу.
    if (rightGap && hash(f.id, 41) < 0.45) {
      const [x0, y0] = plotPoint(f.fp, rightGap.x, frontY);
      const [x1, y1] = plotPoint(f.fp, rightGap.x, -face * (rightGap.back - 1.5));
      paths.push({ id: -(f.id * 2 + 2), a: { x: x0, y: y0 }, b: { x: x1, y: y1 } });
    }
  }
  // К дому второго ряда — по промежутку у переднего дома и вдоль его задней стороны.
  for (const [r, f] of rearOf) {
    const face = f.face ?? -1;
    const q = toLocal(f.fp, r.fp.center);
    const doorY = q.y + (face * r.fp.h) / 2;
    const midY = (doorY + -face * (f.fp.h / 2)) / 2;
    const sx = hash(r.id, 43) < 0.5 ? -1 : 1;
    const sideX = sx * (f.fp.w / 2 + 1.6);
    const pts = [
      [q.x, doorY],
      [q.x, midY],
      [sideX, midY],
      [sideX, face * (f.fp.h / 2 + reach)],
    ];
    const line = pts.map(([x, y]) => {
      const [px, py] = plotPoint(f.fp, x, y);
      return { x: px, y: py };
    });
    paths.push({ id: -(r.id * 2 + 3), a: line[0], b: line[3], shape: { kind: 'polyline', via: line.slice(1, -1) } });
  }
  cache.set(town, { layout, buildings: town.buildings, count: town.buildings.length, reach, paths });
  return paths;
}

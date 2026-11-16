import { hash } from '../core/math';
import type { Vec } from '../core/vec';
import type { Town, TownBuilding } from '../world/entities';
import type { Footprint } from '../world/spatial';
import { townTier } from '../world/townForms';
import { Art } from './industryArt';
import { parkGates, SIDEWALK } from './parkArt';
import { type Box, grow } from './tileCache';
import { paths } from './townDecor';

/**
 * Пешеходные дорожки внутри кварталов города — только картинка (на дороги, движение и стройку не влияют), рисуются
 * под дорогами и домами, в плитки кэша карты:
 * - между соседними домами одного ряда — по промежутку от тротуара в глубину квартала (к дворам, огородам, домам
 *   второго ряда; где позади ничего нет — у части промежутков, по хешу);
 * - к дому второго ряда — от тротуара по промежутку рядом с передним домом и вдоль его задней стороны к крыльцу;
 * - от входов парка или сквера — до тротуара ближней улицы.
 * Считается раз на список домов и парков города (renderer), а не в каждой плитке.
 */

export interface TownWalks {
  townId: number;
  /** Ломаные (x, y по очереди). */
  paths: number[][];
  /** Мощёные (город) или утоптанные (село). */
  paved: boolean;
  box: Box;
  sig: string;
}

/** Ширина дорожки, м. */
export const WALK_W = { paved: 1.6, path: 1.2 } as const;
/** Дома стоят в 5 м от края полотна (worldgen.fillStreet): дорожка от участка доходит до тротуара. */
const SETBACK = 5;
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
function toWorld(f: Footprint, x: number, y: number): [number, number] {
  const c = Math.cos(f.angle);
  const s = Math.sin(f.angle);
  return [f.center.x + x * c - y * s, f.center.y + x * s + y * c];
}

const parallel = (a: Footprint, b: Footprint) => Math.cos(a.angle - b.angle) > 0.997;
const rowHouse = (b: TownBuilding) => b.kind !== 'landmark' && b.form !== 'tower';

/**
 * Дорожки города town. curb — сколько метров от точки до края ближнего полотна (∞ — далеко): по нему дорожка от входа
 * в парк доходит до тротуара.
 */
export function townWalks(town: Town, curb: (p: Vec) => number): TownWalks | null {
  const paved = townTier(town) !== 'village';
  const side = paved ? SIDEWALK.paved : SIDEWALK.path;
  // До тротуара от участка: SETBACK − (from + w) — газон; дорожка заходит на тротуар на полметра.
  const reach = SETBACK - side.from - side.w + 0.5;
  const out: number[][] = [];
  const list = town.buildings.filter(rowHouse);
  const near = (a: TownBuilding, b: TownBuilding, d: number) => Math.abs(a.fp.center.x - b.fp.center.x) < d && Math.abs(a.fp.center.y - b.fp.center.y) < d;
  // Соседи — по клеткам сетки CELL м: не каждый дом с каждым.
  const CELL = 60;
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
      const [x0, y0] = toWorld(f.fp, rightGap.x, frontY);
      const [x1, y1] = toWorld(f.fp, rightGap.x, -face * (rightGap.back - 1.5));
      out.push([x0, y0, x1, y1]);
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
    out.push(pts.flatMap(([x, y]) => toWorld(f.fp, x, y)));
  }
  // От входов парка — до тротуара ближней улицы, не дальше 16 м.
  for (const p of town.parks ?? []) {
    for (const g of parkGates(p)) {
      const start = { x: g.x, y: g.y };
      for (let d = 0; d <= 16; d += 1) {
        const q = { x: g.x + g.ux * d, y: g.y + g.uy * d };
        if (curb(q) <= side.from + side.w * 0.6) {
          if (d > 0.5) out.push([start.x, start.y, q.x, q.y]);
          break;
        }
      }
    }
  }
  if (!out.length) return null;
  let box: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const p of out) for (let i = 0; i < p.length; i += 2) box = { x0: Math.min(box.x0, p[i]), y0: Math.min(box.y0, p[i + 1]), x1: Math.max(box.x1, p[i]), y1: Math.max(box.y1, p[i + 1]) };
  const sig = `${paved}|${out.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(';')}`;
  return { townId: town.id, paths: out, paved, box: grow(box, 2), sig };
}

const WALK_PAVED = 'rgba(214,208,196,0.95)';
const WALK_PAVED_EDGE = 'rgba(150,142,128,0.5)';
const WALK_EARTH = 'rgba(204,188,150,0.85)';
const WALK_EARTH_EDGE = 'rgba(160,146,116,0.3)';

/** Дорожки кварталов в рамке view — под дорогами и домами; издали (lod 0) их не видно. */
export function drawTownWalks(ctx: CanvasRenderingContext2D, list: readonly TownWalks[], view: Box, zoom: number): void {
  const a = new Art(ctx, { id: 0, fp: { center: { x: 0, y: 0 }, w: 1, h: 1, angle: 0 } }, zoom, 0, 0, 'still');
  if (!a.lod) return;
  a.pass = 0;
  for (const w of list) {
    if (w.box.x1 < view.x0 || w.box.x0 > view.x1 || w.box.y1 < view.y0 || w.box.y0 > view.y1) continue;
    const width = w.paved ? WALK_W.paved : WALK_W.path;
    paths(a, w.paths, width, w.paved ? WALK_PAVED : WALK_EARTH, w.paved ? WALK_PAVED_EDGE : WALK_EARTH_EDGE);
  }
}

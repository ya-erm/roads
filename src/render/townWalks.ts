import { hash } from '../core/math';
import type { Vec } from '../core/vec';
import type { Town, TownBuilding } from '../world/entities';
import { LOT_SETBACK } from '../world/houseAccess';
import type { Footprint } from '../world/spatial';
import { townTier } from '../world/townForms';
import { houseAccess } from './houseArt';
import { Art } from './industryArt';
import { parkGates } from './parkArt';
import { drawSidewalks, SIDEWALK, type Sidewalk, WALK_LOOK } from './sidewalks';
import { type Box, grow } from './tileCache';
import { paths } from './townDecor';

/**
 * Пешеходные дорожки и съезды города вне участков домов — только картинка (на дороги, движение и стройку не
 * влияют), рисуются под дорогами и домами, в плитки кэша карты:
 * - между соседними домами одного ряда — по промежутку от тротуара в глубину квартала (к дворам, огородам, домам
 *   второго ряда; где позади ничего нет — у части промежутков, по хешу);
 * - к дому второго ряда — от тротуара по промежутку рядом с передним домом и вдоль его задней стороны к крыльцу;
 * - от входов парка или сквера — до тротуара ближней улицы;
 * - от участка через газон и тротуар до полотна — дорожки к крыльцам и съезды к стоянкам и гаражам (houseArt.houseAccess):
 *   край у полотна закрывает асфальт дороги, а не съезд ложится поверх неё.
 * Дорожки — непрозрачные, цветом тротуара (sidewalks.WALK_LOOK), и слоем под ним (drawTownWalks).
 * Считается раз на список домов и парков города (renderer), а не в каждой плитке.
 */

export interface TownWalks {
  townId: number;
  /** Ломаные дорожек (x, y по очереди). */
  paths: number[][];
  /** Дорожки к крыльцам от участка до тротуара: отрезок (x0, y0, x1, y1) и ширина; цвет — тротуара города. */
  fronts: { pts: number[]; w: number }[];
  /** Съезды от участка до полотна: многоугольник (x, y по очереди) и цвет. */
  drives: { pts: number[]; color: string }[];
  /** Мощёные (город) или утоптанные (село). */
  paved: boolean;
  box: Box;
  sig: string;
}

/** Ширина дорожки, м. */
export const WALK_W = { paved: 1.6, path: 1.2 } as const;
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

/** Выходы дома к улице (дорожки к крыльцам, съезды) — в мире, от края участка через газон и тротуар. */
function accessOf(b: TownBuilding, reach: number, fronts: TownWalks['fronts'], drives: TownWalks['drives']): void {
  // Оси сцены дома: дом с face = 1 повёрнут на пол-оборота (как в houseArt).
  const angle = (b.face ?? -1) === 1 ? b.fp.angle + Math.PI : b.fp.angle;
  const f: Footprint = { center: b.fp.center, w: b.fp.w, h: b.fp.h, angle };
  for (const a of houseAccess(b)) {
    const edge = a.side * (b.fp.h / 2);
    if (a.kind === 'path') {
      fronts.push({ pts: [...toWorld(f, a.x, edge), ...toWorld(f, a.x, edge + a.side * reach)], w: a.w });
      continue;
    }
    // Съезд — до полотна и чуть под него; у бордюра — раструб на метр шире с каждой стороны.
    const curb = a.side * (b.fp.h / 2 + LOT_SETBACK + 0.6);
    const flare = a.side * (b.fp.h / 2 + LOT_SETBACK - 1.6);
    const hw = a.w / 2;
    const pts = [
      [a.x - hw, edge],
      [a.x + hw, edge],
      [a.x + hw, flare],
      [a.x + hw + 1.2, curb],
      [a.x - hw - 1.2, curb],
      [a.x - hw, flare],
    ].flatMap(([x, y]) => toWorld(f, x, y));
    drives.push({ pts, color: a.color });
  }
}

/**
 * Дорожки и съезды города town. curb — сколько метров от точки до края ближнего полотна (∞ — далеко): по нему
 * дорожка от входа в парк доходит до тротуара.
 */
export function townWalks(town: Town, curb: (p: Vec) => number): TownWalks | null {
  const paved = townTier(town) !== 'village';
  const side = paved ? SIDEWALK.paved : SIDEWALK.path;
  // До тротуара от участка: LOT_SETBACK − (from + w) — газон; дорожка заходит на тротуар на полметра.
  const reach = LOT_SETBACK - side.from - side.w + 0.5;
  const out: number[][] = [];
  const fronts: TownWalks['fronts'] = [];
  const drives: TownWalks['drives'] = [];
  const list = town.buildings.filter(rowHouse);
  // Дом второго ряда выходит к улице дорожкой в обход переднего (ниже), не напрямую.
  for (const b of town.buildings) if (b.kind !== 'landmark' && !b.rear) accessOf(b, reach, fronts, drives);
  const near = (a: TownBuilding, b: TownBuilding, d: number) => Math.abs(a.fp.center.x - b.fp.center.x) < d && Math.abs(a.fp.center.y - b.fp.center.y) < d;
  // Соседи — по клеткам сетки CELL м: не каждый дом с каждым.
  const CELL = 70;
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
  if (!out.length && !fronts.length && !drives.length) return null;
  let box: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const all = [...out, ...fronts.map((f) => f.pts), ...drives.map((d) => d.pts)];
  for (const p of all) for (let i = 0; i < p.length; i += 2) box = { x0: Math.min(box.x0, p[i]), y0: Math.min(box.y0, p[i + 1]), x1: Math.max(box.x1, p[i]), y1: Math.max(box.y1, p[i + 1]) };
  const sig = `${paved}|${all.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(';')}`;
  return { townId: town.id, paths: out, fronts, drives, paved, box: grow(box, 2), sig };
}

/**
 * Тротуары (sidewalks — render/sidewalks.ts), дорожки кварталов, дорожки к крыльцам и съезды в рамке view — под
 * дорогами и домами; издали (lod 0) их не видно. Дорожки — цветом тротуара (WALK_LOOK) и слоем под ним: сначала все
 * кромки (дорожек, потом тротуаров), потом заливки дорожек, поверх — заливка тротуаров. Скруглённый конец и кромка
 * дорожки не ложатся на тротуар, а его кромку на стыке закрывает заливка дорожки — одно покрытие. Съезды (асфальт) —
 * поверх тротуара: пересекают его.
 */
export function drawTownWalks(ctx: CanvasRenderingContext2D, list: readonly TownWalks[], view: Box, zoom: number, sidewalks: readonly Sidewalk[] = []): void {
  const a = new Art(ctx, { id: 0, fp: { center: { x: 0, y: 0 }, w: 1, h: 1, angle: 0 } }, zoom, 0, 0, 'still');
  if (!a.lod) return;
  a.pass = 0;
  const c = ctx;
  const seen = list.filter((w) => !(w.box.x1 < view.x0 || w.box.x0 > view.x1 || w.box.y1 < view.y0 || w.box.y0 > view.y1));
  // Ломаные дорожек всех городов — одной обводкой на вид (мощёные, утоптанные).
  const kinds = ([true, false] as const).map((paved) => ({ paved, list: seen.filter((w) => w.paved === paved).flatMap((w) => w.paths) })).filter((k) => k.list.length);
  const walkPaths = (part: 'edge' | 'fill') => {
    for (const k of kinds) {
      const look = k.paved ? WALK_LOOK.paved : WALK_LOOK.path;
      paths(a, k.list, k.paved ? WALK_W.paved : WALK_W.path, look.fill, look.edge, part);
    }
  };
  walkPaths('edge');
  drawSidewalks(ctx, sidewalks, view, zoom, 'edge');
  walkPaths('fill');
  c.lineCap = 'butt';
  for (const w of seen) {
    // За участком — цветом тротуара города (в селе — утоптанная), а не дорожки в участке: с тротуаром одно покрытие.
    c.strokeStyle = w.paved ? WALK_LOOK.paved.fill : WALK_LOOK.path.fill;
    for (const f of w.fronts) {
      c.lineWidth = f.w;
      c.beginPath();
      c.moveTo(f.pts[0], f.pts[1]);
      c.lineTo(f.pts[2], f.pts[3]);
      c.stroke();
    }
  }
  drawSidewalks(ctx, sidewalks, view, zoom, 'fill');
  for (const w of seen) {
    for (const d of w.drives) {
      c.fillStyle = d.color;
      c.beginPath();
      c.moveTo(d.pts[0], d.pts[1]);
      for (let i = 2; i < d.pts.length; i += 2) c.lineTo(d.pts[i], d.pts[i + 1]);
      c.closePath();
      c.fill();
    }
  }
}

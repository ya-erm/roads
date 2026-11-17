import { TOWN_SCALE } from '../config';
import { hash } from '../core/math';
import type { Vec } from '../core/vec';
import type { Town, TownBuilding } from '../world/entities';
import { LOT_SETBACK } from '../world/houseAccess';
import { LOT } from '../world/parkingLots';
import { LOT_ASPHALT } from './lotArt';
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
  /**
   * Съезды от участка до полотна: многоугольник (x, y по очереди) и цвет; mouth — понижение бордюра: раструб у кромки,
   * рисуется поверх полотна (drawDriveMouths).
   */
  drives: { pts: number[]; color: string; mouth?: number[] }[];
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

/** Как далеко от точки до кромки полотна (curbGap) и есть ли там бордюр (не грунтовка). */
export interface WalkRoads {
  gap(p: Vec): number;
  kerb(p: Vec): boolean;
}

/**
 * Раструб съезда у полотна: начинается за столько метров до кромки и шире съезда на столько с каждой стороны; у
 * широкого съезда (ряд мест с улицы, карман) — уже: между соседними кусками кармана остаётся проход к дорожке.
 */
const FLARE = { from: 1.6, wide: 1.2, row: 0.4, rowFrom: 10 };
/** Съезд заходит под асфальт полотна на столько; понижение бордюра — на столько в асфальт поверх его кромки. */
const UNDER = 0.6;
const LIP = 0.4;

/**
 * Съезд в осях участка f (x — середина, w — ширина) с края участка edge к улице со стороны side — через газон и тротуар
 * до кромки полотна (по roads: и тогда, когда участок отступил от улицы дальше LOT_SETBACK — ужат полосой стоянки,
 * поставлен дальше тротуара); у кромки — раструб и понижение бордюра (mouth — поверх полотна, его бордюр закрыт
 * асфальтом съезда: машина выезжает на улицу по съезду, а не из-под бордюра).
 */
function driveTo(f: Footprint, x: number, w: number, edge: number, side: 1 | -1, color: string, roads: WalkRoads, drives: TownWalks['drives']): void {
  const [ex, ey] = toWorld(f, x, edge);
  const gap = roads.gap({ x: ex, y: ey });
  // Полотна рядом нет (снесли) — съезд обычной длины, без понижения бордюра.
  const near = gap > 0.5 && gap < 15;
  const road = edge + side * (near ? gap : LOT_SETBACK);
  const hw = w / 2;
  const at = (pts: number[][]) => pts.flatMap(([px, py]) => toWorld(f, px, py));
  const flare = road - side * FLARE.from;
  const fw = hw + (w >= FLARE.rowFrom ? FLARE.row : FLARE.wide);
  const pts = at([
    [x - hw, edge],
    [x + hw, edge],
    [x + hw, flare],
    [x + fw, road + side * UNDER],
    [x - fw, road + side * UNDER],
    [x - hw, flare],
  ]);
  const drive: TownWalks['drives'][number] = { pts, color };
  if (near && roads.kerb({ x: ex, y: ey })) {
    drive.mouth = at([
      [x - hw, flare],
      [x + hw, flare],
      [x + fw, road],
      [x + fw, road + side * LIP],
      [x - fw, road + side * LIP],
      [x - fw, road],
    ]);
  }
  drives.push(drive);
}

/** Выходы дома к улице (дорожки к крыльцам, съезды) — в мире, от края участка через газон и тротуар. */
function accessOf(b: TownBuilding, reach: number, fronts: TownWalks['fronts'], drives: TownWalks['drives'], roads: WalkRoads): void {
  // Оси сцены дома: дом с face = 1 повёрнут на пол-оборота (как в houseArt).
  const angle = (b.face ?? -1) === 1 ? b.fp.angle + Math.PI : b.fp.angle;
  const f: Footprint = { center: b.fp.center, w: b.fp.w, h: b.fp.h, angle };
  for (const a of houseAccess(b)) {
    const edge = a.side * (b.fp.h / 2);
    if (a.kind === 'path') {
      fronts.push({ pts: [...toWorld(f, a.x, edge), ...toWorld(f, a.x, edge + a.side * reach)], w: a.w });
      continue;
    }
    driveTo(f, a.x, a.w, edge, a.side, a.color, roads, drives);
  }
}

/** Заезды к воротам площадок-стоянок без тупика-выезда (у большой заезд — сама дорога): от края площадки до полотна. */
function lotAccess(town: Town, roads: WalkRoads, drives: TownWalks['drives']): void {
  for (const l of town.lots ?? []) {
    if (l.removed || l.nodes?.length) continue;
    for (const g of l.gates) driveTo(l.fp, g.x, LOT.gateW, -l.fp.h / 2, -1, LOT_ASPHALT, roads, drives);
  }
}

/**
 * Дорожки и съезды города town. curb — сколько метров от точки до края ближнего полотна (∞ — далеко): по нему
 * дорожка от входа в парк доходит до тротуара, а съезд — до полотна; kerb — у полотна там бордюр (не грунтовка):
 * у съезда — понижение бордюра.
 */
export function townWalks(town: Town, curb: (p: Vec) => number, kerb: (p: Vec) => boolean = () => true): TownWalks | null {
  const paved = townTier(town) !== 'village';
  const side = paved ? SIDEWALK.paved : SIDEWALK.path;
  // До тротуара от участка: LOT_SETBACK − (from + w) — газон; дорожка заходит на тротуар на полметра.
  const reach = LOT_SETBACK - side.from - side.w + 0.5;
  const out: number[][] = [];
  const fronts: TownWalks['fronts'] = [];
  const drives: TownWalks['drives'] = [];
  const list = town.buildings.filter(rowHouse);
  const roads: WalkRoads = { gap: curb, kerb };
  // Дом второго ряда выходит к улице дорожкой в обход переднего (ниже), не напрямую.
  for (const b of town.buildings) if (b.kind !== 'landmark' && !b.rear) accessOf(b, reach, fronts, drives, roads);
  lotAccess(town, roads, drives);
  // Участок отступил от улицы дальше обычного (полоса стоянки ужала его — world/curbSqueeze.ts, угловой — с двух
  // улиц): дорожка к крыльцу тянется дальше, до тротуара.
  const onWalk = side.from + side.w - 0.5;
  for (const f of fronts) {
    const gap = curb({ x: f.pts[2], y: f.pts[3] });
    if (!(gap > onWalk + 0.5 && gap < 15)) continue;
    const dx = f.pts[2] - f.pts[0];
    const dy = f.pts[3] - f.pts[1];
    const l = Math.hypot(dx, dy) || 1;
    f.pts[2] += (dx / l) * (gap - onWalk);
    f.pts[3] += (dy / l) * (gap - onWalk);
  }
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
  const all = [...out, ...fronts.map((f) => f.pts), ...drives.flatMap((d) => (d.mouth ? [d.pts, d.mouth] : [d.pts]))];
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
      poly(c, d.pts);
      c.fill();
    }
  }
}

function poly(c: CanvasRenderingContext2D, pts: readonly number[]): void {
  c.beginPath();
  c.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1]);
  c.closePath();
}

/** Цвет понижения бордюра у съезда: светлая черта бетона по кромке полотна поперёк съезда. */
const LOWERED = 'rgba(196,194,186,0.55)';

/**
 * Понижение бордюра у съездов в рамке view — поверх полотен (после сети, LaneRenderer): бордюр полотна лежит снаружи
 * его асфальта, и без этого съезд упирался бы в него, а машина выезжала бы из-под него. Асфальт съезда — до кромки
 * асфальта полотна, по ней — светлая черта понижения.
 */
export function drawDriveMouths(ctx: CanvasRenderingContext2D, list: readonly TownWalks[], view: Box, zoom: number): void {
  const a = new Art(ctx, { id: 0, fp: { center: { x: 0, y: 0 }, w: 1, h: 1, angle: 0 } }, zoom, 0, 0, 'still');
  if (!a.lod) return;
  for (const w of list) {
    if (w.box.x1 < view.x0 || w.box.x0 > view.x1 || w.box.y1 < view.y0 || w.box.y0 > view.y1) continue;
    for (const d of w.drives) {
      const m = d.mouth;
      if (!m) continue;
      ctx.fillStyle = d.color;
      poly(ctx, m);
      ctx.fill();
      // Черта понижения — по кромке асфальта полотна (точки 2 и 5 раструба — у кромки).
      ctx.strokeStyle = LOWERED;
      ctx.lineWidth = 0.35;
      ctx.beginPath();
      ctx.moveTo(m[4], m[5]);
      ctx.lineTo(m[10], m[11]);
      ctx.stroke();
    }
  }
}

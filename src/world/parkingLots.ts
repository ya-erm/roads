import type { Vec } from '../core/vec';
import type { LotGate, LotGateMode, ParkingLot } from './entities';
import { LOT_SETBACK, lotFrame, type Driveway, type LotRect } from './houseAccess';
import { STALL_STOP } from './shopLots';
import { LANE_W, ROAD_MARGIN } from './roadTypes';
import type { Footprint } from './spatial';
import { YARD_AISLE, YARD_GATE, YARD_STALL } from './yardLots';

/**
 * Площадки-стоянки (docs/PARKING.md, этап 3): раскладка мест, проездов и ворот — общая для рисунка, инструмента и игры.
 * Без генератора случайных чисел: всё — по размеру участка и воротам.
 *
 * Оси участка — как у дома (houseAccess.lotFrame, face не задан): начало — в середине, x — вдоль улицы, улица — со
 * стороны −y. Места — под прямым углом, 4,6 × 8,5 ед. (≈ 2,8 × 5,1 м; единица карты — 0,6 м), как во дворах, проезд —
 * 7 ед. (≈ 4,2 м). Глубина — модулем: 1 ряд с проездом (проезд у улицы), 2 ряда с проездом между ними, 4 ряда с двумя
 * проездами. Ширина — шагом места: 7 + n · 4,6, где 7 — поперечный проезд у главных ворот (первых): через него от ворот
 * к проездам; мест в ряду — ⌊(W − 7)/4,6⌋ = n. Прочие ворота срезают места переднего ряда (у 2 и 4 рядов).
 * Больше LOT.big мест — ворота через узел: тупик-выезд заходит на площадку до первого проезда, и места переднего ряда
 * под его полосами (LOT.stubHalf от оси ворот) убраны — там проезд площадки её покрытием.
 *
 *   глубина   | ширина | мест
 *   15,5 (1)  | 30,0   | 5
 *   24 (2)    | 34,6   | 12
 *   24 (2)    | 66,8   | 24 — 26 больше LOT.big: ворота — через узел, 2 места под тупиком-выездом
 *   48 (4)    | 53,0   | 38 — 40 без 2 под тупиком-выездом
 */
export const LOT = {
  stall: YARD_STALL,
  aisle: YARD_AISLE,
  /** Ширина ворот, ед. — во всю ширину проезда. */
  gateW: YARD_AISLE,
  /** Ворота — не ближе стольких ед. к перекрёстку (концу полотна). */
  corner: 17,
  /** Больше стольких мест — ворота примкнуты к дорогам (тупик-выезд, логика узлов); иначе заезд, как во двор. */
  big: 24,
  /**
   * Тупик-выезд большой площадки — 2 полосы по LANE_W: полосы — по столько ед. от оси ворот (под ними на площадке до
   * узла мест нет); асфальт с кромкой — до stubEdge (на столько у края площадки нет бордюра).
   */
  stubHalf: LANE_W,
  stubEdge: LANE_W + ROAD_MARGIN,
  /** Мест в ряду: от и до. */
  cols: { min: 2, max: 30 },
  /** Цена: за ворота и за место, $; содержание — доля цены в месяц. */
  gateCost: 1000,
  stallCost: 200,
  upkeep: 0.02,
  /** Места у цели поездки — площадки не дальше стольких ед. (≈ 200 м). */
  near: 330,
  /** Поворот площадки свободной постановкой (Alt) и ручкой — шагом, рад (15°). */
  turn: Math.PI / 12,
  /** Площадка встаёт за тротуаром: край участка — в стольких ед. от края полотна (как дома, LOT_SETBACK). */
  setback: LOT_SETBACK,
} as const;

/** Рядов мест: 1, 2 или 4. */
export type LotRows = 1 | 2 | 4;
export const LOT_ROWS: readonly LotRows[] = [1, 2, 4];

/** Глубина площадки по числу рядов, ед. */
export function lotDepth(rows: LotRows): number {
  const { d } = LOT.stall;
  return rows === 1 ? LOT.aisle + d : rows === 2 ? 2 * d + LOT.aisle : 4 * d + 2 * LOT.aisle;
}

/** Ширина площадки по числу мест в ряду, ед. */
export function lotWidth(cols: number): number {
  return LOT.aisle + cols * LOT.stall.w;
}

/** Мест в ряду по ширине участка. */
export function lotCols(w: number): number {
  return Math.max(0, Math.floor((w - LOT.aisle) / LOT.stall.w + 1e-6));
}

/** Рядов по глубине участка (ближайший модуль). */
export function lotRows(h: number): LotRows {
  let best: LotRows = 1;
  for (const r of LOT_ROWS) if (Math.abs(lotDepth(r) - h) < Math.abs(lotDepth(best) - h)) best = r;
  return best;
}

/** Середина ворот на шаге сетки: k-й шаг (0…cols) от левого края — поперечный проезд не режет места пополам. */
export function gateX(w: number, k: number): number {
  return -w / 2 + LOT.aisle / 2 + k * LOT.stall.w;
}

/** Ближайший шаг сетки ворот к x (по оси участка). */
export function snapGate(w: number, x: number): number {
  const n = lotCols(w);
  const k = Math.max(0, Math.min(n, Math.round((x + w / 2 - LOT.aisle / 2) / LOT.stall.w)));
  return gateX(w, k);
}

/** Ворота по умолчанию: одни, в обе стороны, у середины. */
export function defaultGates(w: number): LotGate[] {
  return [{ x: snapGate(w, 0), mode: 'both' }];
}

/** Место площадки в мире: середина, нос машины на месте и курс (от проезда вглубь), ряд и номер. */
export interface LotStall {
  pos: Vec;
  nose: Vec;
  dir: Vec;
  row: number;
  /** Прямоугольник в осях участка (рисунок). */
  rect: LotRect;
}

/** Раскладка площадки: места по порядку (ряд за рядом, слева направо), проезды и поперечный проезд — в осях участка. */
export interface LotLayout {
  stalls: LotStall[];
  aisles: LotRect[];
  cross: LotRect | null;
  /** Где у ворот тупик-выезд упирается в проезд (ось участка: y), если ворота через узел. */
  nodeY: number;
  /** Ворота через узел: мест больше LOT.big (до вычета тех, что под тупиками-выездами, — они убраны из stalls). */
  big: boolean;
}

type Shape = Pick<ParkingLot, 'fp' | 'gates'>;

/** Ряды (y низа, откуда въезд) и проезды по числу рядов. */
function bands(h: number, rows: LotRows): { rows: { y: number; open: 'y-' | 'y+' }[]; aisles: number[] } {
  const { d } = LOT.stall;
  const a = LOT.aisle;
  const y0 = -h / 2;
  if (rows === 1) return { rows: [{ y: y0 + a, open: 'y-' }], aisles: [y0] };
  if (rows === 2)
    return {
      rows: [
        { y: y0, open: 'y+' },
        { y: y0 + d + a, open: 'y-' },
      ],
      aisles: [y0 + d],
    };
  return {
    rows: [
      { y: y0, open: 'y+' },
      { y: y0 + d + a, open: 'y-' },
      { y: y0 + 2 * d + a, open: 'y+' },
      { y: y0 + 3 * d + 2 * a, open: 'y-' },
    ],
    aisles: [y0 + d, y0 + 3 * d + a],
  };
}

const layouts = new WeakMap<object, { sig: string; layout: LotLayout }>();

/** Раскладка площадки (кэш — по участку и воротам). */
export function lotLayout(lot: Shape): LotLayout {
  const sig = `${lot.fp.center.x},${lot.fp.center.y},${lot.fp.w},${lot.fp.h},${lot.fp.angle}|${lot.gates.map((g) => g.x).join(',')}`;
  const hit = layouts.get(lot);
  if (hit && hit.sig === sig) return hit.layout;
  const layout = computeLayout(lot);
  layouts.set(lot, { sig, layout });
  return layout;
}

function computeLayout(lot: Shape): LotLayout {
  const { w: W, h: H } = lot.fp;
  const rows = lotRows(H);
  const n = lotCols(W);
  const { w: sw, d: sd } = LOT.stall;
  const at = lotFrame({ fp: lot.fp });
  const b = bands(H, rows);
  const main = lot.gates[0]?.x ?? gateX(W, Math.round(n / 2));
  // Поперечный проезд — у главных ворот: места левее и правее него, по шагу сетки.
  const k0 = Math.max(0, Math.min(n, Math.round((main + W / 2 - LOT.aisle / 2) / sw)));
  const cx0 = -W / 2 + k0 * sw;
  const xs: number[] = [];
  for (let k = 0; k < n; k++) xs.push(k < k0 ? -W / 2 + k * sw : -W / 2 + LOT.aisle + k * sw);
  // Прочие ворота — проезд через передний ряд (у одного ряда впереди — проезд, резать нечего).
  const cuts = rows === 1 ? [] : lot.gates.slice(1).map((g) => [g.x - LOT.gateW / 2, g.x + LOT.gateW / 2]);
  const stalls: LotStall[] = [];
  b.rows.forEach((r, i) => {
    for (const x of xs) {
      if (i === 0 && cuts.some(([a, c]) => x + sw > a + 0.05 && x < c - 0.05)) continue;
      const cx = x + sw / 2;
      const front = r.open === 'y-' ? r.y : r.y + sd;
      const far = r.open === 'y-' ? r.y + sd : r.y;
      const s = r.open === 'y-' ? 1 : -1;
      const nose = at(cx, far - s * STALL_STOP);
      const back = at(cx, front);
      const len = Math.hypot(nose.x - back.x, nose.y - back.y) || 1;
      stalls.push({
        pos: at(cx, r.y + sd / 2),
        nose,
        dir: { x: (nose.x - back.x) / len, y: (nose.y - back.y) / len },
        row: i,
        rect: { x, y: r.y, w: sw, h: sd },
      });
    }
  });
  const aisles = b.aisles.map((y) => ({ x: -W / 2, y, w: W, h: LOT.aisle }));
  const cross = rows === 1 ? null : { x: cx0, y: -H / 2, w: LOT.aisle, h: H };
  const nodeY = b.aisles[0] + LOT.aisle / 2;
  const big = stalls.length > LOT.big;
  // Большая: тупик-выезд от края до узла в первом проезде — под его полосами мест нет (машины едут по ним).
  const under = (r: LotRect) => r.y < nodeY - 0.05 && lot.gates.some((g) => r.x + r.w > g.x - LOT.stubHalf + 0.05 && r.x < g.x + LOT.stubHalf - 0.05);
  return { stalls: big ? stalls.filter((s) => !under(s.rect)) : stalls, aisles, cross, nodeY, big };
}

/** Мест на площадке. */
export function lotStallCount(lot: Shape): number {
  return lotLayout(lot).stalls.length;
}

/** Ворота через узел графа (больше LOT.big мест — считая и те, что потом убраны под тупики-выезды). */
export function lotIsBig(lot: Shape): boolean {
  return lotLayout(lot).big;
}

/** Цена площадки: ворота и места, $. */
export function lotCost(lot: Shape): number {
  return lot.gates.length * LOT.gateCost + lotStallCount(lot) * LOT.stallCost;
}

/** Содержание площадки игрока, $ в месяц. */
export function lotUpkeep(lot: Shape): number {
  return Math.round(lotCost(lot) * LOT.upkeep);
}

/** Въезд через ворота gate (как в ворота двора, Driveway.garage): от бордюра (край участка − LOT_SETBACK) внутрь. */
export function lotGateDriveway(lot: Pick<ParkingLot, 'id' | 'fp'>, gate: Pick<LotGate, 'x'>): Driveway {
  const at = lotFrame({ fp: lot.fp });
  const y0 = -lot.fp.h / 2;
  const curb = at(gate.x, y0 - LOT.setback);
  const g = at(gate.x, y0 + YARD_GATE);
  const len = Math.hypot(g.x - curb.x, g.y - curb.y) || 1;
  const dir = { x: (g.x - curb.x) / len, y: (g.y - curb.y) / len };
  return { building: lot.id, curb, gate: g, dir, width: LOT.gateW, spot: at(gate.x, y0 + LOT.aisle / 2), garage: true };
}

/** Где у ворот gate кончается тупик-выезд (узел) и где он начинается у улицы — в мире. */
export function lotGateNode(lot: Pick<ParkingLot, 'fp' | 'gates'>, gate: Pick<LotGate, 'x'>): { node: Vec; curb: Vec } {
  const at = lotFrame({ fp: lot.fp });
  return { node: at(gate.x, lotLayout(lot).nodeY), curb: at(gate.x, -lot.fp.h / 2 - LOT.setback) };
}

/** Узлы ворот больших площадок (концы тупиков-выездов) всех городов — без разворота на карте: дальше проезд площадки. */
export function lotGateNodes(towns: readonly { lots?: readonly ParkingLot[] }[]): Set<number> {
  const ids = new Set<number>();
  for (const t of towns) for (const l of t.lots ?? []) if (!l.removed) for (const n of l.nodes ?? []) if (n >= 0) ids.add(n);
  return ids;
}

/** Можно ли через ворота въехать / выехать. */
export const gateIn = (m: LotGateMode): boolean => m !== 'out';
export const gateOut = (m: LotGateMode): boolean => m !== 'in';

/** Участок площадки: середина края у улицы (ось −y) и единичная нормаль от улицы. */
export function lotFront(fp: Footprint): { mid: Vec; n: Vec; t: Vec } {
  const c = Math.cos(fp.angle);
  const s = Math.sin(fp.angle);
  const n = { x: -s, y: c };
  return { mid: { x: fp.center.x - (n.x * fp.h) / 2, y: fp.center.y - (n.y * fp.h) / 2 }, n, t: { x: c, y: s } };
}

/** Угол участка, у которого улица со стороны −y, по нормали от улицы n. */
export function lotAngle(n: Vec): number {
  return Math.atan2(-n.x, n.y);
}

/** Точка p в осях участка. */
export function lotLocal(fp: Footprint, p: Vec): Vec {
  const c = Math.cos(fp.angle);
  const s = Math.sin(fp.angle);
  const dx = p.x - fp.center.x;
  const dy = p.y - fp.center.y;
  return { x: dx * c + dy * s, y: -dx * s + dy * c };
}

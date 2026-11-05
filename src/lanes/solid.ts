import { KMH_PER_UNIT, ROAD_CLASSES } from '../world/roadTypes';
import { Corridor, End, LaneNet } from './model';

/** Сплошная сама — на столько секунд пути по дороге (на быстрой длиннее), но не короче и не длиннее этого, м. */
const SOLID_TIME = 0.3;
const SOLID_MIN = 10;
const SOLID_MAX = 15;

/**
 * Длина сплошной, которую дорога рисует сама: перед развилкой полос в разные полотна, после вливания и на последних
 * метрах перед перекрёстком. Ровно на ней и запрещено перестраиваться (граф движения, `autoSolids`).
 */
export function solidLength(c: Corridor): number {
  const v = (c.limit ?? ROAD_CLASSES[c.cls].limit) / KMH_PER_UNIT;
  return Math.round(Math.max(SOLID_MIN, Math.min(SOLID_MAX, v * SOLID_TIME)));
}

/**
 * Где линия между соседними попутными полосами i и j полотна c сплошная сама, отрезками [от, до] по оси: у стыка,
 * где они расходятся в разные полотна (развилка, съезд, вливание), и у перекрёстка, к которому они едут (после
 * обреза s0 у конца a, до обреза s1 у конца b; на кольце — нет, там перестраиваются). Сплошная, заданная игроком,
 * — отдельно (`solid` у полосы).
 */
export function autoSolids(net: LaneNet, c: Corridor, i: number, j: number, s0: number, s1: number): [number, number][] {
  const A = c.lanes[i];
  const B = c.lanes[j];
  if (!A || !B || A.flow !== B.flow) return [];
  const L = solidLength(c);
  const splits = (end: End) => {
    const n = net.node(end === 'a' ? c.a : c.b);
    if (n.kind !== 'seam' || net.isDeadEnd(n)) return false;
    if (!net.reaches(c, A, end) || !net.reaches(c, B, end)) return false;
    return net.across(c, i, end)?.corridor.id !== net.across(c, j, end)?.corridor.id;
  };
  const toJunction = (end: End) => !c.ring && A.flow === (end === 'b' ? 1 : -1) && net.node(end === 'a' ? c.a : c.b).kind === 'junction';
  const res: [number, number][] = [];
  if (splits('a')) res.push([0, L]);
  if (splits('b')) res.push([c.length - L, c.length]);
  if (toJunction('a')) res.push([s0, s0 + L]);
  if (toJunction('b')) res.push([s1 - L, s1]);
  return res;
}

/**
 * Машина на полосе — от хвоста (s − length) до места, где она пересечёт линию (s + ahead: перестроение не мгновенное),
 * — рядом со сплошной из zones (отрезки по полосе): перестраиваться через неё нельзя.
 */
export function onSolid(zones: readonly (readonly [number, number])[] | undefined, s: number, length: number, ahead = 0): boolean {
  return !!zones?.some(([u, v]) => s + ahead >= u && s - length <= v);
}

/**
 * Сколько в начале и в конце связи длиной len перестраиваться нельзя (между какими-нибудь из её полос сплошная
 * у стыка или перекрёстка) — на столько меньше на ней места для перестроений.
 */
export function solidEnds(lanes: readonly { solidZones?: [number, number][] }[], len: number): [number, number] {
  let head = 0;
  let tail = 0;
  for (const l of lanes) {
    for (const [u, v] of l.solidZones ?? []) {
      if (u <= 0.5) head = Math.max(head, v);
      if (v >= len - 0.5) tail = Math.max(tail, len - u);
    }
  }
  return [head, tail];
}

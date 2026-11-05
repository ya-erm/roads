import { dist, dot, scale, sub, Vec } from '../core/vec';
import { KMH_PER_UNIT, LANE_W, ROAD_CLASSES } from '../world/roadTypes';
import {
  awayAt,
  awaySign,
  CORNER_CUT_MAX,
  CORNER_R_MAX,
  cornerCurb,
  cutCap,
  type CutLimit,
  edgePoint,
  filletArea,
  filletPath,
  filletRadius,
  JunctionCorner,
  junctionCorners,
  laneShare,
  nodeCuts,
  pointOff,
  sFrom,
} from './geometry';
import { laneSpeed, turnSpeed } from './graph';
import { CorridorEnd, LaneNet, LaneNode, LaneSlot } from './model';

/**
 * Скругление углов перекрёстка («Дорога → Двигать»): за угол между соседними подъездами тянут — радиус бордюра
 * растёт, обрезы обоих подъездов (стоп-линии) отходят до начала дуги, правый поворот вдоль угла идёт по дуге.
 * Радиус хранится в узле на пару полотен (`LaneNode.corners`).
 */

/** Ручка угла перекрёстка: тянут за середину бордюра. */
export interface CornerHandle {
  node: number;
  corner: JunctionCorner;
  /** Середина бордюра угла сейчас — за неё берут. */
  pos: Vec;
  /** Бордюр угла сейчас: от кромки подъезда a до кромки b. */
  curb: Vec[];
  /** Радиус, заданный игроком; нет — угол как выходит сам. */
  radius?: number;
  /** Каким радиусом угол скруглён сам (по ширине дорог), м. */
  auto: number;
  /** Самый большой радиус: дальше обрезы подъездов упираются в предел (`cutCap`). */
  max: number;
  /** Что держит радиус на пределе: `radius` — CORNER_R_MAX, иначе — что держит обрез подъезда (`cutCap`). */
  limit: CornerLimit;
}

export type CornerLimit = 'radius' | CutLimit;

/** Самый большой радиус угла k и что его держит: обрезы обоих подъездов — не дальше предела, радиус — не больше CORNER_R_MAX. */
export function cornerMax(net: LaneNet, k: JunctionCorner): { max: number; limit: CornerLimit } {
  const a = cutCap(net, k.a);
  const b = cutCap(net, k.b);
  const ra = a.cap - k.da;
  const rb = b.cap - k.db;
  const room = Math.max(0, Math.min(ra, rb)) * Math.tan(k.theta / 2);
  if (room >= CORNER_R_MAX) return { max: CORNER_R_MAX, limit: 'radius' };
  return { max: room, limit: ra <= rb ? a.why : b.why };
}

/** Почему угол дальше не скруглить — подсказка у курсора на пределе. */
export function cornerLimitText(limit: CornerLimit): string {
  if (limit === 'radius') return `больше ${CORNER_R_MAX} м нельзя`;
  if (limit === 'stop') return `стоп-линия дальше ${CORNER_CUT_MAX} м от перекрёстка`;
  if (limit === 'junction') return 'упирается в соседний перекрёсток';
  return 'упирается в узел на дороге';
}

/** Ручки всех углов перекрёстка n, которые можно скруглить (у кольца — нет). */
export function cornerHandles(net: LaneNet, n: LaneNode): CornerHandle[] {
  if (n.kind !== 'junction' || (n.roundabout ?? null) !== null) return [];
  const ends = net.ends(n);
  const corners = junctionCorners(net, n, ends);
  if (!corners.length) return [];
  const cuts = nodeCuts(net, n, ends);
  // Без настроек — какими обрезы выходят сами: по ним радиус «само».
  const plain = n.corners ? nodeCuts(net, { ...n, corners: undefined }, ends) : cuts;
  return corners.map((k) => {
    const r = n.corners?.[k.key];
    const radius = r && r > 0 ? r : undefined;
    // Бордюр угла — как на площадке перекрёстка: дуга до ближнего из обрезов.
    const A = edgePoint(k.a, cuts[k.ia], 1);
    const B = edgePoint(k.b, cuts[k.ib], -1);
    const curb = cornerCurb(A.p, A.away, B.p, B.away);
    const auto = Math.max(0, Math.min(plain[k.ia] - k.da, plain[k.ib] - k.db)) * Math.tan(k.theta / 2);
    const { max, limit } = cornerMax(net, k);
    return { node: n.id, corner: k, pos: curb.mid, curb: [A.p, ...curb.pts, B.p], radius, auto, max, limit };
  });
}

/** Ручка угла под курсором: ближайшая к p не дальше r среди углов перекрёстков рядом. */
export function cornerHandleAt(net: LaneNet, p: Vec, r: number, skip: (n: LaneNode) => boolean = () => false): CornerHandle | null {
  let best: CornerHandle | null = null;
  let bestD = r;
  for (const n of net.nodesNear(p, 160)) {
    if (n.kind !== 'junction' || skip(n)) continue;
    for (const h of cornerHandles(net, n)) {
      const d = dist(h.pos, p);
      if (d <= bestD) [best, bestD] = [h, d];
    }
  }
  return best;
}

/**
 * Какой радиус даст ручка h, если её дотянуть до p: середина дуги бордюра — там, где курсор (по биссектрисе угла),
 * не больше предела. Не дальше, чем угол скруглён сам, — 0: снова само.
 */
export function cornerRadiusAt(h: CornerHandle, p: Vec): number {
  const r = Math.min(h.max, filletRadius(dot(sub(p, h.corner.apex), h.corner.out), h.corner.theta));
  return r <= h.auto + 0.5 ? 0 : Math.round(r);
}

/** Радиус скругления угла key перекрёстка id, м; 0 — снова само. false — узла нет. */
export function setCornerRadius(net: LaneNet, id: number, key: string, r: number): boolean {
  const n = net.nodes.get(id);
  if (!n || n.kind !== 'junction') return false;
  // Объект — новый: копии сети (предпросмотр, отмена) делят прежний.
  const next = { ...(n.corners ?? {}) };
  if (r > 0) next[key] = Math.round(r);
  else delete next[key];
  if (Object.keys(next).length) n.corners = next;
  else delete n.corners;
  net.version++;
  return true;
}

/** Цена асфальта на скруглённых игроком углах перекрёстка: площадь от вершины угла до дуги × цена полосы на метр ширины. */
export function cornerCost(net: LaneNet, n: LaneNode): number {
  if (!n.corners || n.kind !== 'junction') return 0;
  let cost = 0;
  for (const k of junctionCorners(net, n)) {
    const r = Math.min(n.corners[k.key] ?? 0, cornerMax(net, k).max);
    if (!(r > 0)) continue;
    const price = Math.min(ROAD_CLASSES[k.a.corridor.cls].cost, ROAD_CLASSES[k.b.corridor.cls].cost) / LANE_W;
    cost += filletArea(r, k.theta) * price;
  }
  return Math.round(cost);
}

/** Крайняя к углу полоса подъезда e: toward — едет к узлу; side — сторона угла от направления «от узла» (1 — справа). */
function edgeLane(e: CorridorEnd, d: number, toward: boolean, side: 1 | -1): LaneSlot | null {
  const c = e.corridor;
  const flow = (e.end === 'b') === toward ? 1 : -1;
  const s = sFrom(c, e.end, d);
  let best: LaneSlot | null = null;
  let bestV = -Infinity;
  for (const l of c.lanes) {
    if (l.flow !== flow || laneShare(c, l, s) < 0.5) continue;
    const v = l.offset * awaySign(e.end) * side;
    if (v > bestV) [best, bestV] = [l, v];
  }
  return best;
}

/**
 * Правый поворот вдоль угла k: с крайней правой полосы подъезда b на крайнюю правую подъезда a — как поедут машины
 * (прямо, по дуге, снова прямо). r — радиус дуги, kmh — скорость поворота; mid — середина дуги и направление там.
 * null — такого поворота нет (односторонние, полос нет).
 */
export function cornerTurn(net: LaneNet, n: LaneNode, k: JunctionCorner): { points: Vec[]; r: number; kmh: number; mid: { pos: Vec; dir: Vec } } | null {
  const ends = net.ends(n);
  const cuts = nodeCuts(net, n, ends);
  const ca = k.a.corridor;
  const cb = k.b.corridor;
  const inLane = edgeLane(k.b, cuts[k.ib], true, -1);
  const outLane = edgeLane(k.a, cuts[k.ia], false, 1);
  if (!inLane || !outLane) return null;
  const sb = sFrom(cb, k.b.end, cuts[k.ib]);
  const sa = sFrom(ca, k.a.end, cuts[k.ia]);
  const from = { pos: pointOff(cb, sb, inLane.offset), dir: scale(awayAt(cb, k.b.end, cuts[k.ib]), -1) };
  const to = { pos: pointOff(ca, sa, outLane.offset), dir: awayAt(ca, k.a.end, cuts[k.ia]) };
  const arc = filletPath(from, to);
  if (!arc) return null;
  const kmh = Math.min(laneSpeed(ca), laneSpeed(cb), turnSpeed(arc.r)) * KMH_PER_UNIT;
  return { points: arc.points, r: arc.r, kmh, mid: arc.mid };
}

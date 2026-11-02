import { Cubic, CurveLUT, intersectCurves, splitBezier } from '../core/bezier';
import { add, dist, dot, norm, rightNormal, scale, sub, Vec } from '../core/vec';
import { LANE_W, RoadClass } from '../world/roadTypes';
import { edgesAt, laneBand } from './geometry';
import { Corridor, Flow, LaneNet, LaneNode, LaneSlot, LAT_EPS, NodeKind, slot } from './model';

/** Начало или конец новой дороги: узел (тупик или перекрёсток), место на полотне или чистое поле. */
export type Anchor =
  | { kind: 'node'; node: number; pos: Vec }
  | { kind: 'corridor'; corridor: number; s: number; pos: Vec }
  | { kind: 'free'; pos: Vec };

/** Что под курсором: тупик или перекрёсток рядом, иначе полотно, иначе чистое поле. */
export function anchorAt(net: LaneNet, p: Vec, radius: number): Anchor {
  let best: LaneNode | null = null;
  let bestD = radius;
  for (const n of net.nodes.values()) {
    if (n.kind === 'seam' && !net.isDeadEnd(n)) continue;
    const d = dist(n.pos, p);
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  if (best) return { kind: 'node', node: best.id, pos: best.pos };
  const c = corridorUnder(net, p, radius * 0.5);
  if (c) {
    const hit = c.lut.closest(p);
    // У самого конца полотна — его узел, если к нему можно примкнуть.
    for (const [end, s] of [
      [c.a, 0],
      [c.b, c.length],
    ] as const) {
      const n = net.node(end);
      if (Math.abs(hit.s - s) < 12 && (n.kind === 'junction' || net.isDeadEnd(n))) return { kind: 'node', node: n.id, pos: n.pos };
    }
    const s = Math.max(12, Math.min(c.length - 12, hit.s));
    return { kind: 'corridor', corridor: c.id, s, pos: c.lut.pointAt(s) };
  }
  return { kind: 'free', pos: { ...p } };
}

/** Полотно, на асфальте которого точка (с запасом margin). */
export function corridorUnder(net: LaneNet, p: Vec, margin = 0): Corridor | null {
  let best: Corridor | null = null;
  let bestD = Infinity;
  for (const c of net.corridors.values()) {
    const hit = c.lut.closest(p);
    const e = edgesAt(c, hit.s);
    if (!e) continue;
    const d = dot(sub(p, hit.point), rightNormal(c.lut.tangentAt(hit.s)));
    const out = Math.max(e[0] - 1.5 - d, d - e[1] - 1.5, 0);
    if (out <= margin && out + hit.d * 0.01 < bestD) {
      bestD = out + hit.d * 0.01;
      best = c;
    }
  }
  return best;
}

/** Полоса полотна под точкой. */
export function laneUnder(net: LaneNet, p: Vec): { corridor: Corridor; lane: number; s: number } | null {
  const c = corridorUnder(net, p);
  if (!c) return null;
  const hit = c.lut.closest(p);
  const d = dot(sub(p, hit.point), rightNormal(c.lut.tangentAt(hit.s)));
  let best = -1;
  let bestD = Infinity;
  c.lanes.forEach((l, i) => {
    const b = laneBand(c, l, hit.s);
    if (!b) return;
    const off = d < b[0] ? b[0] - d : d > b[1] ? d - b[1] : 0;
    if (off < bestD) {
      bestD = off;
      best = i;
    }
  });
  return best >= 0 && bestD < 2 ? { corridor: c, lane: best, s: hit.s } : null;
}

/**
 * Разрезает полотно в s: стык (касательный к оси — полосы продолжаются как были) или перекрёсток.
 * Полосы делятся по своим отрезкам.
 */
export function splitCorridor(net: LaneNet, c: Corridor, s: number, kind: NodeKind): { node: LaneNode; first: Corridor; second: Corridor } {
  const t = c.lut.tAt(s);
  const [c1, c2] = splitBezier(c.curve, t);
  const node = kind === 'seam' ? net.addSeam(c1.p3, c.lut.tangentAt(s), net.node(c.a).level) : net.addJunction(c1.p3, net.node(c.a).level);
  const L = c.length;
  const lanes1 = c.lanes.filter((l) => l.from < s - 0.5).map((l) => ({ ...l, to: l.to >= s - 0.01 ? Infinity : l.to }));
  const lanes2 = c.lanes
    .filter((l) => l.to > s + 0.5)
    .map((l) => ({ ...l, from: l.from <= s + 0.01 ? 0 : l.from - s, to: l.to >= L - 0.01 ? Infinity : l.to - s }));
  const { a, b, portA, portB, cls } = c;
  net.removeCorridor(c.id, true);
  const first = net.addCorridor(a, node.id, { cls, lanes: lanes1, portA, curve: c1 });
  const second = net.addCorridor(node.id, b, { cls, lanes: lanes2, portB, curve: c2 });
  return { node, first, second };
}

export interface RoadOptions {
  cls: RoadClass;
  lanes: LaneSlot[];
  /** Точка, через которую выгнуть дорогу (дуга); нет — прямая или плавное продолжение тупика. */
  control?: Vec;
}

interface RoadEnd {
  node: LaneNode;
  /** Со стороны какой стороны стыка ляжет полотно; у перекрёстка нет. */
  side?: 1 | -1;
}

/**
 * Дорога между якорями. Тупик продолжается со свободной стороны (полосы совпали — стык, нет — узел
 * становится перекрёстком), середина полотна режется перекрёстком, в чистом поле ставится тупик.
 * Где новая дорога пересекает другие, ставятся перекрёстки. Возвращает новые полотна.
 */
export function buildRoad(net: LaneNet, A: Anchor, B: Anchor, o: RoadOptions): Corridor[] {
  if (dist(A.pos, B.pos) < 12) return [];
  if (A.kind === 'node' && B.kind === 'node' && A.node === B.node) return [];
  // Сначала — направления у концов: продолжение тупика задаёт касательную, иначе — к точке изгиба или к другому концу.
  const tangentAt = (x: Anchor, toward: Vec, start: boolean): Vec => {
    if (x.kind === 'node') {
      const n = net.node(x.node);
      if (n.kind === 'seam') {
        const free = -net.ends(n)[0].side as 1 | -1;
        return scale(n.dir, start ? free : -free);
      }
    }
    return norm(start ? sub(toward, x.pos) : sub(x.pos, toward));
  };
  const t0 = tangentAt(A, o.control ?? B.pos, true);
  const t3 = tangentAt(B, o.control ?? A.pos, false);
  const start = resolveEnd(net, A, t0, true, o.lanes);
  const end = resolveEnd(net, B, t3, false, o.lanes);
  const p0 = start.node.pos;
  const p3 = end.node.pos;
  const h0 = o.control ? (dist(p0, o.control) * 2) / 3 : dist(p0, p3) / 3;
  const h3 = o.control ? (dist(p3, o.control) * 2) / 3 : dist(p0, p3) / 3;
  const curve: Cubic = { p0, p1: add(p0, scale(t0, h0)), p2: sub(p3, scale(t3, h3)), p3 };
  return chain(net, start, end, curve, o);
}

/** Узел у конца новой дороги. dir — направление дороги в этой точке (по ходу от начала к концу). */
function resolveEnd(net: LaneNet, x: Anchor, dir: Vec, start: boolean, lanes: LaneSlot[]): RoadEnd {
  if (x.kind === 'node') {
    const n = net.node(x.node);
    if (n.kind === 'junction') return { node: n };
    const side = -net.ends(n)[0].side as 1 | -1;
    // Полосы новой дороги в стыке — те же, что у тупика? Тогда это продолжение, иначе — перекрёсток.
    const along = start ? side : -side;
    const mine = lanes.map((l) => `${Math.round(l.offset * along * 2)}:${l.flow * along > 0}`).sort();
    const theirs = net
      .ends(n)
      .flatMap((e) => e.corridor.lanes.filter((l) => net.reaches(e.corridor, l, e.end)).map((l) => net.laneAtSeam(e, l)))
      .map((l) => `${Math.round(l.lat * 2)}:${l.forward}`)
      .sort();
    if (mine.join() === theirs.join()) return { node: n, side };
    if (net.ends(n).every((e) => Math.abs(e.port) < LAT_EPS)) n.kind = 'junction';
    return { node: n };
  }
  if (x.kind === 'corridor') return { node: splitCorridor(net, net.corridor(x.corridor), x.s, 'junction').node };
  // Чистое поле — тупик: стык по направлению дороги, полотно у начала спереди, у конца — сзади.
  return { node: net.addSeam(x.pos, dir), side: start ? 1 : -1 };
}

/** Кладёт кривую от start до end; где она пересекает другие полотна, ставит перекрёстки. */
function chain(net: LaneNet, start: RoadEnd, end: RoadEnd, curve: Cubic, o: RoadOptions): Corridor[] {
  const made: Corridor[] = [];
  let from = start;
  let rest = curve;
  const touches = (c: Corridor, n: LaneNode) => c.a === n.id || c.b === n.id;
  for (let guard = 0; guard < 24; guard++) {
    const lut = new CurveLUT(rest);
    let hit: { t: number; c: Corridor; s: number } | null = null;
    for (const c of net.corridors.values()) {
      if (touches(c, from.node) || touches(c, end.node) || made.includes(c)) continue;
      for (const h of intersectCurves(lut, c.lut)) {
        if (h.s1 < 10 || h.s1 > lut.length - 10) continue;
        if (!hit || h.t1 < hit.t) hit = { t: h.t1, c, s: h.s2 };
      }
    }
    if (!hit) break;
    // У самого конца другого полотна — его перекрёсток, иначе режем полотно новым перекрёстком.
    const nearA = hit.s < 10 && net.node(hit.c.a).kind === 'junction';
    const nearB = hit.s > hit.c.length - 10 && net.node(hit.c.b).kind === 'junction';
    const J = nearA ? net.node(hit.c.a) : nearB ? net.node(hit.c.b) : splitCorridor(net, hit.c, hit.s, 'junction').node;
    const [head, tail] = splitBezier(rest, hit.t);
    made.push(net.addCorridor(from.node.id, J.id, { cls: o.cls, lanes: o.lanes, curve: head }));
    from = { node: J };
    rest = tail;
  }
  made.push(net.addCorridor(from.node.id, end.node.id, { cls: o.cls, lanes: o.lanes, curve: rest }));
  return made;
}

// ---------- Полоса ----------

/** Место у края полотна, куда встанет новая полоса вплотную к крайней. */
export interface EdgeHit {
  corridor: number;
  s: number;
  /** 1 — справа от оси (по a→b), −1 — слева. */
  side: 1 | -1;
  /** Смещение оси новой полосы. */
  offset: number;
  pos: Vec;
}

/** Край полотна у точки: курсор на месте будущей полосы рядом с крайней. */
export function edgeAt(net: LaneNet, p: Vec, tol = 4.5): EdgeHit | null {
  let best: EdgeHit | null = null;
  let bestD = tol;
  for (const c of net.corridors.values()) {
    const hit = c.lut.closest(p);
    if (hit.d > 60 || hit.s < 1 || hit.s > c.length - 1) continue;
    const e = edgesAt(c, hit.s);
    if (!e) continue;
    const d = dot(sub(p, hit.point), rightNormal(c.lut.tangentAt(hit.s)));
    for (const side of [1, -1] as const) {
      const offset = side > 0 ? e[1] + LANE_W / 2 : e[0] - LANE_W / 2;
      if (Math.abs(d - offset) < bestD) {
        bestD = Math.abs(d - offset);
        best = { corridor: c.id, s: hit.s, side, offset, pos: add(hit.point, scale(rightNormal(c.lut.tangentAt(hit.s)), offset)) };
      }
    }
  }
  return best;
}

/**
 * Черновик полосы, которую ведут мышью. Начали у края полотна — полоса прилипает к нему и идёт вдоль,
 * пока курсор рядом (host.s0 → s1); увели в сторону — дальше съезд к depart. Начали в поле и довели до
 * края — въезд: полоса вливается в полотно в s0 и идёт вдоль него до s1.
 */
export interface LaneDraft {
  start: Anchor;
  host: { corridor: number; side: 1 | -1; offset: number; s0: number; s1: number } | null;
  /** Полоса пришла на край из поля (въезд). */
  merge: boolean;
  /** Куда уходит съезд после края; null — полоса кончается на краю. */
  depart: Anchor | null;
  /** Курсор, пока полоса не дошла до края. */
  end: Anchor;
}

/** Черновик полосы от точки p. */
export function startLane(net: LaneNet, p: Vec, radius: number): LaneDraft {
  const edge = edgeAt(net, p);
  if (edge) {
    return { start: { kind: 'free', pos: edge.pos }, host: { ...edge, s0: edge.s, s1: edge.s }, merge: false, depart: null, end: { kind: 'free', pos: edge.pos } };
  }
  const a = anchorAt(net, p, radius);
  return { start: a, host: null, merge: false, depart: null, end: a };
}

/** Курсор сдвинулся: полоса идёт вдоль края, отрывается от него или прилипает. */
export function dragLane(net: LaneNet, d: LaneDraft, p: Vec, radius: number): LaneDraft {
  if (d.depart) return { ...d, depart: anchorAt(net, p, radius) };
  if (d.host) {
    const c = net.corridors.get(d.host.corridor);
    if (!c) return d;
    const hit = c.lut.closest(p);
    const lat = dot(sub(p, hit.point), rightNormal(c.lut.tangentAt(hit.s)));
    // Курсор у линии полосы — она тянется вдоль края; ушёл в сторону — дальше съезд.
    if (Math.abs(lat - d.host.offset) < 10 && hit.s > 1 && hit.s < c.length - 1) return { ...d, host: { ...d.host, s1: hit.s } };
    return { ...d, depart: anchorAt(net, p, radius) };
  }
  const edge = edgeAt(net, p);
  if (edge && dist(edge.pos, d.start.pos) > 30) return { ...d, host: { ...edge, s0: edge.s, s1: edge.s }, merge: true };
  return { ...d, end: anchorAt(net, p, radius) };
}

/**
 * Строит полосу по черновику. Вдоль края — полоса полотна (с отгонами на концах); съезд и въезд —
 * отдельные полотна в одну полосу, стык ставится там, где полоса отходит от края или приходит к нему.
 */
export function applyLane(net: LaneNet, d: LaneDraft, cls: RoadClass): boolean {
  if (!d.host) {
    // Полоса в чистом поле — односторонняя дорога в одну полосу.
    return buildRoad(net, d.start, d.end, { cls, lanes: [slot(0, 1)] }).length > 0;
  }
  const c = net.corridors.get(d.host.corridor);
  if (!c) return false;
  const { offset } = d.host;
  // Направление движения по полосе — куда её вели вдоль полотна; если почти не вели — куда ушёл съезд.
  let ds = d.host.s1 - d.host.s0;
  if (Math.abs(ds) < 1) {
    const target = d.depart?.pos ?? d.start.pos;
    const t = c.lut.tangentAt(d.host.s0);
    ds = dot(sub(target, c.lut.pointAt(d.host.s0)), t) * (d.depart ? 1 : -1);
  }
  const flow: Flow = ds >= 0 ? 1 : -1;
  const lo = Math.min(d.host.s0, d.host.s1);
  const hi = Math.max(d.host.s0, d.host.s1);
  if (!d.merge && !d.depart) {
    if (hi - lo < 5) return false;
    net.setLanes(c, [...c.lanes, { offset, flow, from: lo, to: hi }]);
    return true;
  }
  // Въезд — в начале пути вдоль края, съезд — в конце (по ходу движения); на оси это lo или hi.
  const inAtLo = flow > 0;
  const cutLo = inAtLo ? d.merge : !!d.depart;
  const cutHi = inAtLo ? !!d.depart : d.merge;
  // Режем полотно стыками: сначала у большего s, потом у меньшего; полоса — в части между ними.
  let host = c;
  let base = 0;
  let seamLo: LaneNode | null = null;
  let seamHi: LaneNode | null = null;
  if (cutHi) {
    const r = splitCorridor(net, host, hi, 'seam');
    seamHi = r.node;
    host = r.first;
  }
  if (cutLo) {
    const r = splitCorridor(net, host, lo, 'seam');
    seamLo = r.node;
    host = r.second;
    base = lo;
  }
  // До стыков полоса идёт на полную ширину и продолжается за ними, у свободных концов — отгон.
  net.setLanes(host, [...host.lanes, { offset, flow, from: seamLo ? 0 : lo - base, to: seamHi ? Infinity : hi - base }]);
  const seamIn = inAtLo ? seamLo : seamHi;
  const seamOut = inAtLo ? seamHi : seamLo;
  // Съезд уходит от стыка по ходу движения, въезд приходит к стыку против хода.
  const branch = (seam: LaneNode, out: boolean, other: Anchor) => {
    const side: 1 | -1 = (out ? flow : -flow) as 1 | -1;
    const lanes = [slot(0, 1)];
    if (out) {
      const end = resolveBranchEnd(net, other, sub(other.pos, net.portPos(seam, offset)), false, lanes);
      const t0 = scale(seam.dir, side);
      const p0 = net.portPos(seam, offset);
      const p3 = end.node.pos;
      const h = dist(p0, p3) / 3;
      const t3 = end.side ? scale(end.node.dir, -end.side) : norm(sub(p3, add(p0, scale(t0, h))));
      net.addCorridor(seam.id, end.node.id, { cls, lanes, portA: offset, curve: { p0, p1: add(p0, scale(t0, h)), p2: sub(p3, scale(t3, h)), p3 } });
    } else {
      const begin = resolveBranchEnd(net, other, sub(net.portPos(seam, offset), other.pos), true, lanes);
      const p3 = net.portPos(seam, offset);
      const t3 = scale(seam.dir, -side);
      const p0 = begin.node.pos;
      const h = dist(p0, p3) / 3;
      const t0 = begin.side ? scale(begin.node.dir, begin.side) : norm(sub(sub(p3, scale(t3, h)), p0));
      net.addCorridor(begin.node.id, seam.id, { cls, lanes, portB: offset, curve: { p0, p1: add(p0, scale(t0, h)), p2: sub(p3, scale(t3, h)), p3 } });
    }
  };
  if (seamOut && d.depart) branch(seamOut, true, d.depart);
  if (seamIn) branch(seamIn, false, d.start);
  return true;
}

function resolveBranchEnd(net: LaneNet, x: Anchor, dir: Vec, start: boolean, lanes: LaneSlot[]): RoadEnd {
  return resolveEnd(net, x, norm(dir), start, lanes);
}

// ---------- Правка ----------

/** Сносит полотно; перекрёсток, у которого осталась одна дорога, становится её тупиком. */
export function bulldoze(net: LaneNet, id: number): void {
  const c = net.corridors.get(id);
  if (!c) return;
  const ends = [c.a, c.b];
  net.removeCorridor(id);
  for (const nid of ends) {
    const n = net.nodes.get(nid);
    if (!n || n.kind !== 'junction' || net.ends(n).length !== 1) continue;
    const e = net.ends(n)[0];
    n.kind = 'seam';
    n.dir = scale(e.away, -1);
  }
}

/** Разворачивает полосу. */
export function flipLane(net: LaneNet, c: Corridor, i: number): void {
  net.setLanes(
    c,
    c.lanes.map((l, k) => (k === i ? { ...l, flow: -l.flow as Flow } : l)),
  );
}

/** Убирает полосу; последнюю — вместе с полотном. */
export function removeLane(net: LaneNet, c: Corridor, i: number): void {
  if (c.lanes.length <= 1) bulldoze(net, c.id);
  else net.setLanes(c, c.lanes.filter((_, k) => k !== i));
}

/** Сплошная или пунктир между полосой и её соседом справа (по оси полотна — с бо́льшим смещением). */
export function toggleSolid(net: LaneNet, c: Corridor, i: number): void {
  net.setLanes(
    c,
    c.lanes.map((l, k) => (k === i ? { ...l, solid: !l.solid } : l)),
  );
}

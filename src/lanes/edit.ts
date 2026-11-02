import { arcCubic, circleArc, Cubic, CurveLUT, intersectCurves, splitBezier } from '../core/bezier';
import { add, cross, dist, dot, len, norm, rightNormal, scale, sub, Vec } from '../core/vec';
import { LANE_W, RoadClass } from '../world/roadTypes';
import { edgesAt, laneBand } from './geometry';
import { Corridor, End, Flow, LaneNet, LaneNode, LaneSlot, LAT_EPS, NodeKind, oneWay, renameArm, slot } from './model';

/** Начало или конец новой дороги: узел (тупик или перекрёсток), место на полотне или чистое поле. */
export type Anchor =
  | { kind: 'node'; node: number; pos: Vec }
  | { kind: 'corridor'; corridor: number; s: number; pos: Vec }
  /** level — высота нового узла: −1 тоннель, 0 земля, 1 мост, 2 эстакада. */
  | { kind: 'free'; pos: Vec; level?: number };

/** Правка невозможна — причина для игрока. */
export class EditError extends Error {}

/**
 * Что под курсором: тупик или перекрёсток рядом, иначе полотно, иначе чистое поле.
 * level — высота, на которой строим: где узлы и полотна друг над другом, берём на ней; новый узел — на ней.
 */
export function anchorAt(net: LaneNet, p: Vec, radius: number, level?: number): Anchor {
  let best: LaneNode | null = null;
  let bestD = Infinity;
  for (const n of net.nodesNear(p, radius)) {
    // Стык посреди дороги притягивает, только если из него выйдет перекрёсток (не съезд, не сужение).
    if (n.kind === 'seam' && !net.isDeadEnd(n) && !net.ends(n).every((e) => Math.abs(e.port) < LAT_EPS)) continue;
    const d = dist(n.pos, p);
    const score = d + (level === undefined ? 0 : Math.abs(n.level - level) * radius);
    if (d < radius && score < bestD) {
      bestD = score;
      best = n;
    }
  }
  if (best) return { kind: 'node', node: best.id, pos: best.pos };
  const c = corridorUnder(net, p, radius * 0.5, level);
  if (c) {
    const hit = c.lut.closest(p);
    // У самого конца полотна — его узел, если к нему можно примкнуть. «Самый конец» — по радиусу магнита
    // (он сжимается при приближении), но не меньше 8 м: короче полотно не бывает.
    const edge = Math.min(12, Math.max(8, radius));
    for (const [end, s] of [
      [c.a, 0],
      [c.b, c.length],
    ] as const) {
      const n = net.node(end);
      if (Math.abs(hit.s - s) < edge && (n.kind === 'junction' || net.isDeadEnd(n))) return { kind: 'node', node: n.id, pos: n.pos };
    }
    const s = Math.max(edge, Math.min(c.length - edge, hit.s));
    return { kind: 'corridor', corridor: c.id, s, pos: c.lut.pointAt(s) };
  }
  return { kind: 'free', pos: { ...p }, level: level ?? 0 };
}

/**
 * Полотно, на асфальте которого точка (с запасом margin). Где полотна друг над другом — на высоте
 * level, без неё — верхнее (его и видно).
 */
export function corridorUnder(net: LaneNet, p: Vec, margin = 0, level?: number): Corridor | null {
  let best: Corridor | null = null;
  let bestD = Infinity;
  for (const c of net.corridorsNear(p, margin + 40)) {
    const hit = c.lut.closest(p);
    const h = net.heightAt(c, hit.s);
    const e = edgesAt(c, hit.s);
    if (!e) continue;
    const d = dot(sub(p, hit.point), rightNormal(c.lut.tangentAt(hit.s)));
    const out = Math.max(e[0] - 1.5 - d, d - e[1] - 1.5, 0);
    const score = out + hit.d * 0.01 + (level === undefined ? -h * 0.5 : Math.abs(h - level) * 5);
    if (out <= margin && score < bestD) {
      bestD = score;
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
  const level = net.heightAt(c, s);
  const node = kind === 'seam' ? net.addSeam(c1.p3, c.lut.tangentAt(s), level) : net.addJunction(c1.p3, level);
  const L = c.length;
  const lanes1 = c.lanes.filter((l) => l.from < s - 0.5).map((l) => ({ ...l, to: l.to >= s - 0.01 ? Infinity : l.to }));
  const lanes2 = c.lanes
    .filter((l) => l.to > s + 0.5)
    .map((l) => ({ ...l, from: l.from <= s + 0.01 ? 0 : l.from - s, to: l.to >= L - 0.01 ? Infinity : l.to - s }));
  const { a, b, portA, portB, cls, limit, ring } = c;
  net.removeCorridor(c.id, true);
  const first = net.addCorridor(a, node.id, { cls, lanes: lanes1, portA, curve: c1, limit, ring });
  const second = net.addCorridor(node.id, b, { cls, lanes: lanes2, portB, curve: c2, limit, ring });
  // Настройки перекрёстков на концах (запреты, главная, связи полос) — на новые куски.
  if (a !== b) {
    renameArm(net.node(a), c.id, first.id);
    renameArm(net.node(b), c.id, second.id);
  }
  // Новый въезд на кольцо — тоже узел кольца.
  if (ring) node.roundabout = net.node(a).roundabout ?? null;
  return { node, first, second };
}

export interface RoadOptions {
  cls: RoadClass;
  lanes: LaneSlot[];
  /** Ограничение скорости, км/ч. */
  limit?: number;
  /** Точка, через которую выгнуть дорогу (дуга); нет — прямая или плавное продолжение тупика. */
  control?: Vec;
  /**
   * Излом у тупика: дорога выходит не по касательной, а в сторону конца (тупик становится
   * перекрёстком). Нет — тупик продолжается плавно.
   */
  kink?: boolean;
  /** Дуга окружности по касательной к тупику: конец дороги смотрит по дуге, а не вдоль хорды. */
  arc?: boolean;
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
  // С изломом (kink) дорога из тупика идёт прямо к цели, если та не точно по касательной.
  const chordDir = (x: Anchor, toward: Vec, start: boolean) => norm(start ? sub(toward, x.pos) : sub(x.pos, toward));
  const seamDir = (x: Anchor, start: boolean): Vec | null => {
    if (x.kind !== 'node') return null;
    const n = net.node(x.node);
    if (n.kind !== 'seam' || !net.isDeadEnd(n)) return null;
    const free = -net.ends(n)[0].side as 1 | -1;
    return scale(n.dir, start ? free : -free);
  };
  const kinked = (x: Anchor, toward: Vec, start: boolean) => {
    const d = seamDir(x, start);
    return !!o.kink && !!d && dot(d, chordDir(x, toward, start)) < Math.cos(0.05);
  };
  const tangentAt = (x: Anchor, toward: Vec, start: boolean): Vec =>
    kinked(x, toward, start) ? chordDir(x, toward, start) : (seamDir(x, start) ?? chordDir(x, toward, start));
  let t0 = tangentAt(A, o.control ?? B.pos, true);
  let t3 = tangentAt(B, o.control ?? A.pos, false);
  const kinkA = kinked(A, o.control ?? B.pos, true);
  let kinkB = kinked(B, o.control ?? A.pos, false);
  // Дуга: окружность по касательной к тупику в начале (или в конце) — конец смотрит по дуге;
  // тупики с обеих сторон — плавно в оба. Тупик в конце, смотрящий не туда, — излом (перекрёсток).
  let arc: Cubic | null = null;
  if (o.arc && !o.control) {
    const chord = dist(A.pos, B.pos);
    const tA = seamDir(A, true);
    const back = seamDir(B, false);
    const tB = back && dot(back, sub(B.pos, A.pos)) > chord * 0.2 ? back : null;
    if (back && !tB) {
      kinkB = true;
      t3 = chordDir(B, A.pos, false);
    }
    if (tA && tB) arc = { p0: A.pos, p1: add(A.pos, scale(tA, chord * 0.4)), p2: sub(B.pos, scale(tB, chord * 0.4)), p3: B.pos };
    else if (tA) arc = arcCubic(A.pos, tA, B.pos);
    else if (tB) {
      const r = arcCubic(B.pos, scale(tB, -1), A.pos);
      arc = r && { p0: r.p3, p1: r.p2, p2: r.p1, p3: r.p0 };
    }
    if (!arc && (tA || tB)) throw new EditError('Слишком крутой поворот');
    if (arc) {
      t0 = norm(sub(arc.p1, arc.p0));
      t3 = norm(sub(arc.p3, arc.p2));
    }
  }
  const start = resolveEnd(net, A, t0, true, o.lanes, kinkA);
  const end = resolveEnd(net, B, t3, false, o.lanes, kinkB);
  const p0 = start.node.pos;
  const p3 = end.node.pos;
  const h0 = arc ? dist(arc.p0, arc.p1) : o.control ? (dist(p0, o.control) * 2) / 3 : dist(p0, p3) / 3;
  const h3 = arc ? dist(arc.p3, arc.p2) : o.control ? (dist(p3, o.control) * 2) / 3 : dist(p0, p3) / 3;
  const curve: Cubic = { p0, p1: add(p0, scale(t0, h0)), p2: sub(p3, scale(t3, h3)), p3 };
  return chain(net, start, end, curve, o);
}

/**
 * Узел у конца новой дороги. dir — направление дороги в этой точке (по ходу от начала к концу).
 * kink — из тупика под углом: он становится перекрёстком.
 */
function resolveEnd(net: LaneNet, x: Anchor, dir: Vec, start: boolean, lanes: LaneSlot[], kink = false): RoadEnd {
  if (x.kind === 'node') {
    const n = net.node(x.node);
    if (n.kind === 'junction') return { node: n };
    // Стык, занятый с обеих сторон, — ответвление из него делает перекрёсток.
    if (!net.isDeadEnd(n)) {
      if (net.ends(n).every((e) => Math.abs(e.port) < LAT_EPS)) n.kind = 'junction';
      return { node: n };
    }
    const side = -net.ends(n)[0].side as 1 | -1;
    // Полосы новой дороги в стыке — те же, что у тупика? Тогда это продолжение, иначе — перекрёсток.
    const along = start ? side : -side;
    const mine = lanes.map((l) => `${Math.round(l.offset * along * 2)}:${l.flow * along > 0}`).sort();
    const theirs = net
      .ends(n)
      .flatMap((e) => e.corridor.lanes.filter((l) => net.reaches(e.corridor, l, e.end)).map((l) => net.laneAtSeam(e, l)))
      .map((l) => `${Math.round(l.lat * 2)}:${l.forward}`)
      .sort();
    if (!kink && mine.join() === theirs.join()) return { node: n, side };
    if (net.ends(n).every((e) => Math.abs(e.port) < LAT_EPS)) n.kind = 'junction';
    return { node: n };
  }
  if (x.kind === 'corridor') return { node: splitCorridor(net, net.corridor(x.corridor), x.s, 'junction').node };
  // Чистое поле — тупик: стык по направлению дороги, полотно у начала спереди, у конца — сзади.
  return { node: net.addSeam(x.pos, dir, x.level ?? 0), side: start ? 1 : -1 };
}

/**
 * Кладёт кривую от start до end; где она пересекает другие полотна на той же высоте, ставит перекрёстки,
 * где выше или ниже — проходит мостом или тоннелем.
 */
function chain(net: LaneNet, start: RoadEnd, end: RoadEnd, curve: Cubic, o: RoadOptions): Corridor[] {
  const made: Corridor[] = [];
  let from = start;
  let rest = curve;
  const touches = (c: Corridor, n: LaneNode) => c.a === n.id || c.b === n.id;
  const h0 = start.node.level;
  const h1 = end.node.level;
  const total = new CurveLUT(curve).length;
  let passed = 0;
  for (let guard = 0; guard < 24; guard++) {
    const lut = new CurveLUT(rest);
    let hit: { t: number; c: Corridor; s: number; s1: number } | null = null;
    const xs = lut.points.map((p) => p.x);
    const ys = lut.points.map((p) => p.y);
    for (const c of net.corridorsInBox(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys))) {
      if (touches(c, from.node) || touches(c, end.node) || made.includes(c)) continue;
      for (const h of intersectCurves(lut, c.lut)) {
        if (h.s1 < 10 || h.s1 > lut.length - 10) continue;
        // Разные высоты — мост или тоннель, перекрёстка нет.
        const mine = h0 + ((h1 - h0) * (passed + h.s1)) / total;
        const dh = Math.abs(mine - net.heightAt(c, h.s2));
        if (dh >= 0.75) continue;
        if (dh >= 0.3) throw new EditError('Мало места по высоте');
        if (h0 !== h1 || !net.isFlat(c)) throw new EditError('Перекрёсток на подъёме');
        if (c.cls === 'motorway' || o.cls === 'motorway') throw new EditError('Автомагистраль пересекается только мостом или тоннелем');
        if (c.ring) throw new EditError('Нельзя пересекать кольцо');
        if (!hit || h.t1 < hit.t) hit = { t: h.t1, c, s: h.s2, s1: h.s1 };
      }
    }
    if (!hit) break;
    passed += hit.s1;
    // У самого конца другого полотна — его перекрёсток, иначе режем полотно новым перекрёстком.
    const nearA = hit.s < 10 && net.node(hit.c.a).kind === 'junction';
    const nearB = hit.s > hit.c.length - 10 && net.node(hit.c.b).kind === 'junction';
    const J = nearA ? net.node(hit.c.a) : nearB ? net.node(hit.c.b) : splitCorridor(net, hit.c, hit.s, 'junction').node;
    const [head, tail] = splitBezier(rest, hit.t);
    made.push(net.addCorridor(from.node.id, J.id, { cls: o.cls, lanes: o.lanes, limit: o.limit, curve: head }));
    from = { node: J };
    rest = tail;
  }
  made.push(net.addCorridor(from.node.id, end.node.id, { cls: o.cls, lanes: o.lanes, limit: o.limit, curve: rest }));
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
  for (const c of net.corridorsNear(p, 60)) {
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

/** Узел двух дорог, который тянут к прямой между их дальними концами, встаёт на неё — изгиб выпрямляется. */
export function alignNode(net: LaneNet, id: number, p: Vec, radius: number): Vec {
  const n = net.nodes.get(id);
  if (!n || n.corridors.length !== 2) return p;
  const [a, b] = net.ends(n).map((e) => net.node(e.end === 'a' ? e.corridor.b : e.corridor.a).pos);
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 < 1) return p;
  const t = dot(sub(p, a), ab) / l2;
  if (t <= 0 || t >= 1) return p;
  const q = add(a, scale(ab, t));
  return dist(q, p) < radius ? q : p;
}

/**
 * Тупик примыкает к другой дороге: к перекрёстку, к тупику (того же профиля и по ходу — продолжение,
 * стык; иначе — перекрёсток) или к середине полотна (там новый перекрёсток). Узел тупика пропадает.
 * false — так не примкнуть.
 */
export function joinDeadEnd(net: LaneNet, id: number, target: Anchor): boolean {
  const D = net.nodes.get(id);
  if (!D || !net.isDeadEnd(D) || D.corridors.length !== 1 || target.kind === 'free') return false;
  const c = net.corridor(D.corridors[0]);
  if (c.a === c.b || (target.kind === 'corridor' && target.corridor === c.id)) return false;
  if (target.kind === 'node' && (target.node === c.a || target.node === c.b)) return false;
  const J = target.kind === 'corridor' ? splitCorridor(net, net.corridor(target.corridor), target.s, 'junction').node : net.node(target.node);
  if (J.level !== D.level) return false;
  // Сначала дорога тянется концом в узел, потом конец переходит к нему.
  net.moveNode(D.id, J.pos);
  const atA = c.a === D.id;
  const cv = { ...c.curve };
  if (J.kind === 'seam') {
    const ends = net.ends(J);
    const free = net.isDeadEnd(J) ? (-ends[0].side as 1 | -1) : null;
    const away = scale(J.dir, free ?? 1);
    const along = atA ? free ?? 1 : -(free ?? 1);
    const mine = c.lanes.filter((l) => net.reaches(c, l, atA ? 'a' : 'b')).map((l) => `${Math.round(l.offset * along * 2)}:${l.flow * along > 0}`);
    const theirs = ends.flatMap((e) => e.corridor.lanes.filter((l) => net.reaches(e.corridor, l, e.end)).map((l) => net.laneAtSeam(e, l)));
    const arrive = norm(sub(atA ? cv.p1 : cv.p2, J.pos));
    const continues =
      free !== null &&
      !ends[0].port &&
      dot(arrive, away) > Math.cos(Math.PI / 6) &&
      mine.sort().join() === theirs.map((l) => `${Math.round(l.lat * 2)}:${l.forward}`).sort().join();
    if (continues) {
      // Продолжение: касательная — по стыку.
      const h = dist(atA ? cv.p1 : cv.p2, J.pos);
      if (atA) cv.p1 = add(J.pos, scale(away, h));
      else cv.p2 = add(J.pos, scale(away, h));
    } else if (ends.every((e) => Math.abs(e.port) < LAT_EPS)) J.kind = 'junction';
    else return false;
  }
  D.corridors = [];
  net.removeNode(D.id);
  if (atA) {
    c.a = J.id;
    c.portA = 0;
  } else {
    c.b = J.id;
    c.portB = 0;
  }
  J.corridors.push(c.id);
  net.setCurve(c, cv);
  return true;
}

// ---------- Перья ----------

/** Перо — управляющая точка полотна у конца end: тянешь — меняется угол дороги у этого конца. */
export interface Handle {
  corridor: number;
  end: End;
}

/** Где перо: конец полотна (anchor) и управляющая точка (pos). */
export function handlePoints(c: Corridor, end: End): { anchor: Vec; pos: Vec } {
  return end === 'a' ? { anchor: c.curve.p0, pos: c.curve.p1 } : { anchor: c.curve.p3, pos: c.curve.p2 };
}

/** Перья полотна и, в стыках на его концах, перья продолжающих его полотен (partner). */
export function handlesOf(net: LaneNet, id: number): (Handle & { partner: boolean })[] {
  const c = net.corridors.get(id);
  if (!c) return [];
  const res: (Handle & { partner: boolean })[] = [];
  for (const end of ['a', 'b'] as const) {
    res.push({ corridor: id, end, partner: false });
    const n = net.node(end === 'a' ? c.a : c.b);
    if (n.kind !== 'seam') continue;
    for (const e of net.ends(n)) if (e.corridor.id !== id) res.push({ corridor: e.corridor.id, end: e.end, partner: true });
  }
  return res;
}

/**
 * Тянет перо в p. У перекрёстка меняется только эта дорога. Стык поворачивается целиком — касательная
 * у него общая, перья остальных полотен в нём идут следом. kink — излом: стык становится перекрёстком.
 */
export function dragHandle(net: LaneNet, h: Handle, p: Vec, kink = false): boolean {
  const c = net.corridors.get(h.corridor);
  if (!c) return false;
  const atA = h.end === 'a';
  const n = net.node(atA ? c.a : c.b);
  const { anchor, pos } = handlePoints(c, h.end);
  const to = sub(p, anchor);
  if (len(to) < 2) return false;
  if (n.kind === 'seam' && kink && !net.isDeadEnd(n) && net.ends(n).every((e) => Math.abs(e.port) < LAT_EPS)) n.kind = 'junction';
  if (n.kind === 'junction' || c.a === c.b) {
    const cv = { ...c.curve };
    if (atA) cv.p1 = { ...p };
    else cv.p2 = { ...p };
    net.setCurve(c, cv);
    return true;
  }
  // Стык поворачивается на угол, на который повернулось перо.
  const from = sub(pos, anchor);
  const theta = Math.atan2(cross(from, to), dot(from, to));
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const rot = (v: Vec): Vec => ({ x: v.x * cos - v.y * sin, y: v.x * sin + v.y * cos });
  const arms = net.ends(n).map((e) => ({ e, ...handlePoints(e.corridor, e.end) }));
  n.dir = rot(n.dir);
  for (const { e, anchor: a0, pos: p0 } of arms) {
    const end = net.portPos(n, e.port);
    const mine = e.corridor.id === c.id && e.end === h.end;
    const arm = mine ? scale(norm(rot(from)), len(to)) : rot(sub(p0, a0));
    const cv = { ...e.corridor.curve };
    if (e.end === 'a') {
      cv.p0 = end;
      cv.p1 = add(end, arm);
    } else {
      cv.p3 = end;
      cv.p2 = add(end, arm);
    }
    net.setCurve(e.corridor, cv);
  }
  return true;
}

// ---------- Кольцо ----------

/** Где полотно от конца end отходит от точки center на R (по прямой); длина от конца. null — не отходит. */
export function distanceAlong(c: Corridor, end: End, center: Vec, R: number): number | null {
  for (let s = 0; s <= c.length; s += 1) {
    if (dist(c.lut.pointAt(end === 'a' ? s : c.length - s), center) >= R) return s;
  }
  return null;
}

/**
 * Кольцо вместо перекрёстка id: дороги режутся на радиусе R, их куски внутри убираются, въезды
 * соединяются дугами против часовой стрелки на экране (полосы lanes, полотна ring). Узлы кольца
 * помечаются id перекрёстка — по нему игра находит центр.
 */
export function buildRing(net: LaneNet, id: number, R: number, lanes: number): void {
  const n = net.node(id);
  const center = { ...n.pos };
  const entries: { node: LaneNode; angle: number }[] = [];
  for (const e of net.ends(n)) {
    const c = net.corridor(e.corridor.id);
    const along = distanceAlong(c, e.end, center, R);
    if (along === null || c.length - along < 12) throw new EditError('Мало места');
    const res = splitCorridor(net, c, e.end === 'a' ? along : c.length - along, 'junction');
    net.removeCorridor((e.end === 'a' ? res.first : res.second).id, true);
    entries.push({ node: res.node, angle: Math.atan2(res.node.pos.y - center.y, res.node.pos.x - center.x) });
  }
  if (entries.length < 2) throw new EditError('Нужен перекрёсток');
  net.removeNode(id);
  entries.sort((a, b) => b.angle - a.angle);
  for (const e of entries) e.node.roundabout = id;
  const at = (a: number) => ({ x: center.x + Math.cos(a) * R, y: center.y + Math.sin(a) * R });
  for (let i = 0; i < entries.length; i++) {
    const from = entries[i];
    const to = entries[(i + 1) % entries.length];
    let arc = from.angle - to.angle;
    if (arc <= 0) arc += Math.PI * 2;
    const steps = Math.max(1, Math.ceil(arc / (Math.PI / 2)));
    let prev = from.node;
    for (let k = 1; k <= steps; k++) {
      const a0 = from.angle - (arc * (k - 1)) / steps;
      const a1 = from.angle - (arc * k) / steps;
      let next: LaneNode;
      if (k === steps) next = to.node;
      else {
        // Угол убывает — по ходу движения касательная (sin a, −cos a).
        next = net.addSeam(at(a1), { x: Math.sin(a1), y: -Math.cos(a1) });
        next.roundabout = id;
      }
      const curve = { ...circleArc(center, R, a0, a1), p0: prev.pos, p3: next.pos };
      net.addCorridor(prev.id, next.id, { cls: 'street', lanes: oneWay(lanes), curve, ring: true });
      prev = next;
    }
  }
}

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

/** Где полотно внутри рамки: отрезки оси [s0, s1]. */
export function insideRuns(c: Corridor, inside: (p: Vec) => boolean): [number, number][] {
  const runs: [number, number][] = [];
  const step = 2;
  // Граница между s0 и s1 (внутри и снаружи) — делением пополам.
  const edge = (s0: number, s1: number) => {
    const in0 = inside(c.lut.pointAt(s0));
    for (let k = 0; k < 12; k++) {
      const m = (s0 + s1) / 2;
      if (inside(c.lut.pointAt(m)) === in0) s0 = m;
      else s1 = m;
    }
    return (s0 + s1) / 2;
  };
  let start: number | null = null;
  let prev = 0;
  for (let s = 0; s <= c.length + step; s += step) {
    const at = Math.min(s, c.length);
    const isIn = inside(c.lut.pointAt(at));
    if (isIn && start === null) start = at > 0 ? edge(prev, at) : 0;
    if (!isIn && start !== null) {
      runs.push([start, edge(prev, at)]);
      start = null;
    }
    prev = at;
    if (at === c.length) break;
  }
  if (start !== null) runs.push([start, c.length]);
  return runs.filter(([a, b]) => b - a > 1);
}

/**
 * Снос рамкой: полотна целиком внутри сносятся, задетые краем — режутся по рамке, и сносится
 * то, что внутри (снаружи остаются тупики). Возвращает, сколько кусков снесено.
 */
export function bulldozeBox(net: LaneNet, x0: number, y0: number, x1: number, y1: number): number {
  const inside = (p: Vec) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
  const MIN = 10;
  let removed = 0;
  for (const c0 of net.corridorsInBox(x0, y0, x1, y1)) {
    let c: Corridor | null = net.corridors.get(c0.id) ?? null;
    if (!c) continue;
    // С конца к началу: разрез у бо́льшего s не сдвигает координаты меньших.
    for (const [sa, sb] of insideRuns(c, inside).reverse()) {
      if (!c) break;
      let piece = c;
      let rest: Corridor | null = null;
      if (sb < c.length - MIN) piece = splitCorridor(net, piece, sb, 'seam').first;
      if (sa > MIN) {
        const r = splitCorridor(net, piece, sa, 'seam');
        rest = r.first;
        piece = r.second;
      }
      bulldoze(net, piece.id);
      removed++;
      c = rest;
    }
  }
  return removed;
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

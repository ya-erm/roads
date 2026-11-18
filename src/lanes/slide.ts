import { arcCubic, bezPoint, Cubic, minRadius, reverseCubic, splitBezier } from '../core/bezier';
import { add, cross, dist, norm, scale, sub, Vec } from '../core/vec';
import { EditError, splitCorridor } from './edit';
import { pointOff } from './geometry';
import { Corridor, CorridorEnd, Flow, LaneNet, LaneNode, LaneSlot, LAT_EPS, renameArm, taperLen } from './model';

// ---------- Примыкание вдоль дороги ----------

/**
 * Примыкание — стык посреди дороги, к которому сбоку (боковым портом) подходят ответвления: въезды и съезды.
 * back и front — сама дорога по обе стороны стыка (сзади и спереди по `dir`), branches — ответвления.
 */
export interface BranchSeam {
  node: LaneNode;
  back: CorridorEnd;
  front: CorridorEnd;
  branches: CorridorEnd[];
}

/** Ближе этого (м) к соседним узлам дороги примыкание не сдвинуть: куску дороги до них нужна длина. */
export const SLIDE_GAP = 15;

/** Узел — примыкание, которое можно двигать вдоль дороги; иначе null. */
export function branchSeam(net: LaneNet, n: LaneNode): BranchSeam | null {
  if (n.kind !== 'seam' || (n.roundabout ?? null) !== null) return null;
  const ends = net.ends(n);
  const through = ends.filter((e) => Math.abs(e.port) < LAT_EPS);
  const branches = ends.filter((e) => Math.abs(e.port) >= LAT_EPS);
  const back = through.find((e) => e.side < 0);
  const front = through.find((e) => e.side > 0);
  if (through.length !== 2 || !back || !front || !branches.length) return null;
  // Петли и дорога, что обоими концами приходит в один узел, — не двигаем.
  if (new Set(ends.map((e) => e.corridor.id)).size !== ends.length) return null;
  if (back.corridor.ring || front.corridor.ring || farNode(back) === farNode(front)) return null;
  return { node: n, back, front, branches };
}

/** Дальний от стыка узел полотна. */
const farNode = (e: CorridorEnd) => (e.end === 'a' ? e.corridor.b : e.corridor.a);

/** Насколько можно сдвинуть примыкание, м вдоль дороги: назад (отрицательное) и вперёд по `dir` стыка. */
export function slideRange(j: BranchSeam): [number, number] {
  return [-Math.max(0, j.back.corridor.length - SLIDE_GAP), Math.max(0, j.front.corridor.length - SLIDE_GAP)];
}

/** Точка дороги в u от стыка (плюс — вперёд по `dir`), сдвинутая вбок на lat (вправо по `dir`). */
export function roadPoint(j: BranchSeam, u: number, lat = 0): Vec {
  const e = u >= 0 ? j.front : j.back;
  const c = e.corridor;
  const d = Math.min(c.length, Math.abs(u));
  return pointOff(c, e.end === 'a' ? d : c.length - d, lat * e.along);
}

/** Куда встанет примыкание, если тянуть его к p: ближайшее место на дороге (u от стыка, в пределах slideRange). */
export function slideTarget(j: BranchSeam, p: Vec): number {
  const [lo, hi] = slideRange(j);
  let best = 0;
  let bestD = Infinity;
  for (const e of [j.back, j.front]) {
    const hit = e.corridor.lut.closest(p);
    if (hit.d >= bestD) continue;
    bestD = hit.d;
    best = e.side * (e.end === 'a' ? hit.s : e.corridor.length - hit.s);
  }
  return Math.max(lo, Math.min(hi, best));
}

/** Соседнее примыкание на той же дороге: тянут к его узлу или к концу любой из его веток. */
export function slideJoinTarget(net: LaneNet, j: BranchSeam, p: Vec, radius = SLIDE_GAP): BranchSeam | null {
  let best: BranchSeam | null = null;
  let distance = radius;
  for (const e of [j.back, j.front]) {
    const target = branchSeam(net, net.node(farNode(e)));
    if (!target || ![target.back, target.front].some((o) => o.corridor.id === e.corridor.id)) continue;
    const shared = net.end(e.corridor, e.end === 'a' ? 'b' : 'a');
    const sign = e.along * shared.along;
    const spots = [target.node.pos, ...target.branches.map((b) => net.portPos(target.node, b.port)), ...j.branches.map((b) => net.portPos(target.node, b.port * sign))];
    const d = Math.min(...spots.map((q) => dist(q, p)));
    if (d < distance) {
      best = target;
      distance = d;
    }
  }
  return best;
}

/** Где ответвления окажутся, если тянуть примыкание к p: их концы (боковые порты) на новом месте. */
export function slidePorts(j: BranchSeam, p: Vec): Vec[] {
  const u = slideTarget(j, p);
  return j.branches.map((b) => roadPoint(j, u, b.port));
}

/** Куда можно сдвинуть примыкание — точки вдоль дороги с шагом step там, где примыкает ответвление. */
export function slideTrack(j: BranchSeam, step = 8): Vec[] {
  const [lo, hi] = slideRange(j);
  const lat = j.branches[0].port;
  const n = Math.max(1, Math.round((hi - lo) / step));
  return Array.from({ length: n + 1 }, (_, i) => roadPoint(j, lo + ((hi - lo) * i) / n, lat));
}

/**
 * Примыкание id сдвигается вдоль дороги к точке p: дорога остаётся, где была (её режет новый стык, прежний
 * сливается обратно, если куски — одна кривая), ответвления уходят к новому стыку — их концы едут следом,
 * форма — самая плавная до другого конца (на длинном въезде поворот плавнее). Полосы разгона и торможения
 * (и отгоны у стыка) едут вместе с примыканием той же длины; сквозные полосы дороги остаются как были.
 * false — двигать нечего или некуда.
 */
export function slideSeam(net: LaneNet, id: number, p: Vec, radius = SLIDE_GAP): boolean {
  const n = net.nodes.get(id);
  const j = n ? branchSeam(net, n) : null;
  if (!j) return false;
  const target = slideJoinTarget(net, j, p, radius);
  if (target) {
    mergeSeams(net, j, target);
    return true;
  }
  const u = slideTarget(j, p);
  if (Math.abs(u) < 1) return false;
  shiftSeam(net, j, u);
  return true;
}

/** Полоса дороги около стыка в координате u (от стыка вдоль `dir`): ±Infinity — доходит до дальнего узла. */
interface Run {
  lat: number;
  fwd: boolean;
  lo: number;
  hi: number;
  solid?: boolean;
  park?: true;
  /** Номера полосы на исходных полотнах — чтобы у полотна полосы шли в прежнем порядке. */
  src: Map<number, number>;
}

/** Два примыкания становятся одним; короткое полотно между ними не превращается в нулевое. */
function mergeSeams(net: LaneNet, j: BranchSeam, target: BranchSeam): void {
  const into = [j.back, j.front].find((e) => farNode(e) === target.node.id)!;
  const other = into === j.front ? j.back : j.front;
  const atTarget = net.end(into.corridor, into.end === 'a' ? 'b' : 'a');
  const beyond = [target.back, target.front].find((e) => e.corridor.id !== into.corridor.id)!;
  const sign = (into.along * atTarget.along) as 1 | -1;
  if (j.branches.some((b) => target.branches.some((o) => Math.abs(b.port * sign - o.port) < LAT_EPS))) {
    throw new EditError('Здесь уже есть примыкание этой полосы');
  }
  const u = into.side * into.corridor.length;
  const uOf = new Map<number, number>([
    [j.node.id, 0],
    [target.node.id, u],
    [farNode(other), other.side * other.corridor.length],
    [farNode(beyond), u + into.side * beyond.corridor.length],
  ]);
  const road = [other.corridor, into.corridor, beyond.corridor];
  const runs = mergeLaneRuns(net, j, road, uOf, u);
  for (const b of j.branches) moveBranch(net, b, target.node, sign);
  const Y = other.corridor;
  const C = into.corridor;
  const toS = other.end === 'b' ? Y.curve : reverseCubic(Y.curve);
  const fromS = into.end === 'a' ? C.curve : reverseCubic(C.curve);
  const whole = Y.cls === C.cls && Y.limit === C.limit ? joinCubics(toS, fromS) : null;
  if (whole) {
    // Настройки целевого узла относятся теперь к объединённому полотну.
    renameArm(target.node, C.id, Y.id);
    net.removeCorridor(C.id, true);
    j.node.corridors = j.node.corridors.filter((id) => id !== Y.id);
    target.node.corridors.push(Y.id);
    if (other.end === 'b') Y.b = target.node.id;
    else Y.a = target.node.id;
    net.setCurve(Y, other.end === 'b' ? whole : reverseCubic(whole));
    if (!j.node.corridors.length) net.removeNode(j.node.id);
  }
  // Если исходные куски не одна кривая, прежний узел остаётся простым швом дороги.
  for (const c of road) if (net.corridors.has(c.id)) net.setLanes(c, lanesFor(c, c.id, runs, uOf));
}

/**
 * Полосы на трёх полотнах вокруг сливаемых узлов — в общей продольной координате.
 * Едут только отгоны веток исходного узла; полосы целевого примыкания остаются на месте.
 */
function mergeLaneRuns(net: LaneNet, j: BranchSeam, road: Corridor[], uOf: Map<number, number>, delta: number): Run[] {
  const min = Math.min(...uOf.values());
  const max = Math.max(...uOf.values());
  const runs: Run[] = [];
  for (const c of road) {
    const ua = uOf.get(c.a)!;
    const ub = uOf.get(c.b)!;
    const sign: Flow = ub > ua ? 1 : -1;
    c.lanes.forEach((l, i) => {
      const x = ua + sign * l.from;
      const y = ua + sign * Math.min(l.to, c.length);
      let lo = Math.min(x, y);
      let hi = Math.max(x, y);
      if (lo <= min + 0.01) lo = -Infinity;
      if (hi >= max - 0.01) hi = Infinity;
      let run: Run = { lat: l.offset * sign, fwd: l.flow * sign > 0, lo, hi, solid: l.solid, park: l.park, src: new Map([[c.id, i]]) };
      // Куски одной полосы через соседний узел — одна полоса, включая её конечный отгон за ним.
      for (let k = runs.length - 1; k >= 0; k--) {
        const r = runs[k];
        if (Math.abs(r.lat - run.lat) >= LAT_EPS || r.fwd !== run.fwd || !!r.solid !== !!run.solid || !!r.park !== !!run.park || r.lo > run.hi + 0.5 || run.lo > r.hi + 0.5) continue;
        run = { ...run, lo: Math.min(r.lo, run.lo), hi: Math.max(r.hi, run.hi), src: new Map([...r.src, ...run.src]) };
        runs.splice(k, 1);
      }
      runs.push(run);
    });
  }
  const owned = j.branches.flatMap((e) => e.corridor.lanes.map((l) => net.laneAtSeam(e, l)));
  const pending = new Set(runs);
  for (const r of runs) {
    if (!pending.delete(r)) continue;
    const group = [r];
    let lo = r.lo;
    let hi = r.hi;
    // Разные настройки сплошной остаются отдельными кусками, но перемещаются вместе со всей полосой.
    for (let grew = true; grew;) {
      grew = false;
      for (const o of pending) {
        if (Math.abs(o.lat - r.lat) >= LAT_EPS || o.fwd !== r.fwd || !!o.park !== !!r.park || o.lo > hi + 0.5 || lo > o.hi + 0.5) continue;
        pending.delete(o);
        group.push(o);
        lo = Math.min(lo, o.lo);
        hi = Math.max(hi, o.hi);
        grew = true;
      }
    }
    if (!owned.some((o) => Math.abs(o.lat - r.lat) < LAT_EPS && o.forward === r.fwd)) continue;
    // Сквозная полоса не двигается вместе с ответвлением.
    if (lo < -0.01 && hi > 0.01) continue;
    const taper = taperLen(lo >= 0 ? j.front.corridor.cls : j.back.corridor.cls);
    if (Math.min(Math.abs(lo), Math.abs(hi)) > taper + 2) continue;
    for (const piece of group) {
      piece.lo += delta;
      piece.hi += delta;
    }
  }
  return runs;
}

function shiftSeam(net: LaneNet, j: BranchSeam, u: number): void {
  const S = j.node;
  const runs = laneRuns(net, j, u);
  const into = u > 0 ? j.front : j.back;
  const other = u > 0 ? j.back : j.front;
  const parent = into.corridor;
  const uOf = new Map<number, number>([
    [farNode(j.back), -j.back.corridor.length],
    [farNode(j.front), j.front.corridor.length],
    [S.id, 0],
  ]);
  // Новый стык режет дорогу там, куда тянули.
  const d = Math.abs(u);
  const r = splitCorridor(net, parent, into.end === 'a' ? d : parent.length - d, 'seam');
  const N = r.node;
  uOf.set(N.id, u);
  const near = into.end === 'a' ? r.first : r.second;
  const far = into.end === 'a' ? r.second : r.first;
  // dir нового стыка — по оси разрезанного полотна: против `dir` прежнего, если полотно смотрит назад.
  const sgn = into.along;
  for (const b of j.branches) moveBranch(net, b, N, sgn);
  // Прежний стык — теперь просто шов дороги: куски одной кривой (того же класса и скорости) сливаются обратно.
  const Y = other.corridor;
  const toS = other.end === 'b' ? Y.curve : reverseCubic(Y.curve);
  const fromS = near.a === S.id ? near.curve : reverseCubic(near.curve);
  const whole = Y.cls === near.cls && Y.limit === near.limit ? joinCubics(toS, fromS) : null;
  const through: { c: Corridor; parent: number }[] = [{ c: Y, parent: Y.id }];
  if (whole) {
    net.removeCorridor(near.id, true);
    S.corridors = S.corridors.filter((x) => x !== Y.id);
    N.corridors.push(Y.id);
    if (other.end === 'b') {
      Y.b = N.id;
      Y.portB = 0;
      net.setCurve(Y, whole);
    } else {
      Y.a = N.id;
      Y.portA = 0;
      net.setCurve(Y, reverseCubic(whole));
    }
    if (!S.corridors.length) net.removeNode(S.id);
  } else through.push({ c: near, parent: parent.id });
  through.push({ c: far, parent: parent.id });
  for (const t of through) net.setLanes(t.c, lanesFor(t.c, t.parent, runs, uOf));
}

/**
 * Полосы дороги по обе стороны стыка — отрезками в u; сквозные (доходят до стыка с обеих сторон) — одним.
 * Полосы, что у стыка начинаются или кончаются (разгона после въезда, торможения перед съездом, отгон сразу у
 * стыка), сдвигаются на u вместе с ним; дальний конец, доходящий до соседнего узла, остаётся там.
 */
function laneRuns(net: LaneNet, j: BranchSeam, u: number): Run[] {
  type Piece = Run & { side: 1 | -1; atSeam: boolean; nearTaper: boolean };
  const pieces: Piece[] = [];
  for (const e of [j.back, j.front]) {
    const c = e.corridor;
    const L = c.length;
    const T = taperLen(c.cls);
    c.lanes.forEach((l, i) => {
      const [d0, d1] = e.end === 'a' ? [l.from, Math.min(l.to, L)] : [L - Math.min(l.to, L), L - l.from];
      const atSeam = net.reaches(c, l, e.end);
      const atFar = net.reaches(c, l, e.end === 'a' ? 'b' : 'a');
      const { lat, forward } = net.laneAtSeam(e, l);
      const nearU = atSeam ? 0 : e.side * d0;
      const farU = e.side * (atFar ? Infinity : d1);
      pieces.push({
        lat,
        fwd: forward,
        lo: Math.min(nearU, farU),
        hi: Math.max(nearU, farU),
        solid: l.solid,
        park: l.park,
        src: new Map([[c.id, i]]),
        side: e.side,
        atSeam,
        nearTaper: !atSeam && d0 <= T + 2,
      });
    });
  }
  const runs: Run[] = [];
  const used = new Set<Piece>();
  const same = (x: Piece, y: Piece) => x.fwd === y.fwd && !!x.park === !!y.park && Math.abs(x.lat - y.lat) < LAT_EPS;
  for (const b of pieces) {
    if (b.side > 0 || !b.atSeam) continue;
    const f = pieces.find((x) => x.side > 0 && x.atSeam && !used.has(x) && same(x, b));
    if (!f) continue;
    used.add(b).add(f);
    runs.push({ lat: b.lat, fwd: b.fwd, lo: b.lo, hi: f.hi, solid: b.solid, park: b.park, src: new Map([...b.src, ...f.src]) });
  }
  const LB = j.back.corridor.length;
  const LF = j.front.corridor.length;
  for (const x of pieces) {
    if (used.has(x)) continue;
    let { lo, hi } = x;
    if (x.atSeam || x.nearTaper) {
      // Конец у стыка едет с ним; другой — тоже (та же длина), если не доходит до соседнего узла. Отгону — место.
      if (x.side > 0) {
        lo += u;
        if (Number.isFinite(hi)) hi = Math.min(hi + u, Math.max(lo + 5, LF - taperLen(j.front.corridor.cls)));
      } else {
        hi += u;
        if (Number.isFinite(lo)) lo = Math.max(lo + u, Math.min(hi - 5, -LB + taperLen(j.back.corridor.cls)));
      }
    }
    runs.push({ lat: x.lat, fwd: x.fwd, lo, hi, solid: x.solid, src: x.src });
  }
  return runs;
}

/** Полосы полотна c (кусок дороги между узлами с координатами u из uOf) по отрезкам runs; parent — чьи это были полосы. */
function lanesFor(c: Corridor, parent: number, runs: Run[], uOf: Map<number, number>): LaneSlot[] {
  const ua = uOf.get(c.a)!;
  const ub = uOf.get(c.b)!;
  const lo = Math.min(ua, ub);
  const hi = Math.max(ua, ub);
  const sgn: Flow = ub > ua ? 1 : -1;
  const sAt = (x: number) => ((x - ua) / (ub - ua)) * c.length;
  const res: { lane: LaneSlot; order: number }[] = [];
  runs.forEach((r, k) => {
    const a = Math.max(r.lo, lo);
    const b = Math.min(r.hi, hi);
    if (b - a <= 0.5) return;
    const reachLo = r.lo <= lo + 0.01;
    const reachHi = r.hi >= hi - 0.01;
    const [atA, atB] = sgn > 0 ? [reachLo, reachHi] : [reachHi, reachLo];
    const s0 = Math.min(sAt(a), sAt(b));
    const s1 = Math.max(sAt(a), sAt(b));
    const lane: LaneSlot = { offset: r.lat * sgn, flow: (r.fwd ? sgn : -sgn) as Flow, from: atA ? 0 : s0, to: atB ? Infinity : s1 };
    if (r.solid) lane.solid = true;
    if (r.park) lane.park = true;
    res.push({ lane, order: r.src.get(parent) ?? 1000 + k });
  });
  return res.sort((x, y) => x.order - y.order).map((x) => x.lane);
}

/**
 * Ответвление b переходит из своего стыка в стык N: конец — в тот же боковой порт (sgn — смотрит ли `dir` N
 * так же, как прежний), касательная — по N. Другой конец на месте; форма — самая плавная (см. branchCurve).
 */
function moveBranch(net: LaneNet, b: CorridorEnd, N: LaneNode, sgn: 1 | -1): void {
  const k = b.corridor;
  const atA = b.end === 'a';
  const port = b.port * sgn;
  const end = net.portPos(N, port);
  const { curve, dead } = branchCurve(net, k, atA, end, scale(N.dir, b.side * sgn));
  const deadSide = dead ? net.ends(dead)[0].side : 1;
  const old = net.node(atA ? k.a : k.b);
  old.corridors = old.corridors.filter((x) => x !== k.id);
  N.corridors.push(k.id);
  if (atA) {
    k.a = N.id;
    k.portA = port;
  } else {
    k.b = N.id;
    k.portB = port;
  }
  net.setCurve(k, atA ? curve : reverseCubic(curve));
  // Тупик на другом конце смотрит туда же, куда теперь ответвление.
  if (dead) dead.dir = scale(net.ends(dead)[0].away, deadSide);
}

/**
 * Новая форма ответвления k от его нового конца end (касательная away — от дороги) до другого конца. Там
 * перекрёсток или свободный тупик — дугой окружности, как при постройке съезда (тупик повернётся следом, dead);
 * стык (ответвление продолжает другую дорогу) — направление там прежнее, а перья — такой длины, чтобы поворот
 * был плавнее всего (наибольший наименьший радиус).
 */
function branchCurve(net: LaneNet, k: Corridor, atA: boolean, end: Vec, away: Vec): { curve: Cubic; dead: LaneNode | null } {
  const cv = k.curve;
  const [farCtl, farPt] = atA ? [cv.p2, cv.p3] : [cv.p1, cv.p0];
  const far = net.node(atA ? k.b : k.a);
  const farPort = atA ? k.portB : k.portA;
  const dead = net.isDeadEnd(far) && far.corridors.length === 1 && Math.abs(farPort) < LAT_EPS ? far : null;
  const arc = dead || far.kind === 'junction' ? arcCubic(end, away, farPt) : null;
  if (arc) return { curve: { ...arc, p0: end, p3: farPt }, dead };
  const back = norm(sub(farCtl, farPt));
  const chord = dist(end, farPt);
  // Ответвление уходит от дороги без возврата: вбок от неё — всё дальше (иначе вдоль дороги — лишняя полоса).
  const side = Math.sign(cross(away, sub(farPt, end))) || 1;
  const leaves = (q: Cubic) => {
    let was = 0;
    for (let i = 1; i <= 24; i++) {
      const lat = cross(away, sub(bezPoint(q, i / 24), end)) * side;
      if (lat < was - 0.05) return false;
      was = lat;
    }
    return true;
  };
  let best: { q: Cubic; r: number; ok: boolean } | null = null;
  for (let i = 1; i <= 12; i++) {
    for (let m = 1; m <= 12; m++) {
      const q = { p0: end, p1: add(end, scale(away, chord * i * 0.06)), p2: add(farPt, scale(back, chord * m * 0.06)), p3: farPt };
      const x = { q, r: minRadius(q, 24), ok: leaves(q) };
      if (!best || (x.ok && !best.ok) || (x.ok === best.ok && x.r > best.r)) best = x;
    }
  }
  return { curve: best!.q, dead: null };
}

/**
 * Две кривые, гладко продолжающие друг друга (конец первой — начало второй), — куски одной кубической
 * (как после splitBezier)? Тогда она целиком, иначе null.
 */
export function joinCubics(c1: Cubic, c2: Cubic, tol = 0.05): Cubic | null {
  const a = dist(c1.p2, c1.p3);
  const b = dist(c2.p0, c2.p1);
  if (dist(c1.p3, c2.p0) > tol || a < 1e-6 || b < 1e-6) return null;
  const t = a / (a + b);
  if (t < 1e-3 || t > 1 - 1e-3) return null;
  const q: Cubic = { p0: c1.p0, p1: add(c1.p0, scale(sub(c1.p1, c1.p0), 1 / t)), p2: add(c2.p3, scale(sub(c2.p2, c2.p3), 1 / (1 - t))), p3: c2.p3 };
  const [x, y] = splitBezier(q, t);
  const close = (u: Cubic, v: Cubic) => dist(u.p0, v.p0) < tol && dist(u.p1, v.p1) < tol && dist(u.p2, v.p2) < tol && dist(u.p3, v.p3) < tol;
  return close(x, c1) && close(y, c2) ? q : null;
}

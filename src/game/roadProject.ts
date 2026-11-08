import { GRADE } from '../config';
import { arcCubic, Cubic, CurveLUT, quadToCubic, reverseCubic, splitBezier, straightCubic } from '../core/bezier';
import { add, dist, dot, len, norm, scale, sub, Vec } from '../core/vec';
import { deckHeight } from '../input/roadtools';
import { Anchor, anchorAt, buildRoad, EditError } from '../lanes/edit';
import { setDecks, zAlong } from '../lanes/deck';
import { Flow, LaneNet, profileOf } from '../lanes/model';
import { edgesAt } from '../lanes/geometry';
import { laneSpeed } from '../lanes/graph';
import { curveLimits, curveZones } from '../lanes/speedProfile';
import type { Network } from '../world/network';
import { isOneWay, isRail, KMH_PER_UNIT, LEVEL_RUN, roadEdges, ROAD_MARGIN, type RoadSpec, specSpeed } from '../world/roadTypes';
import { Builder, type DrawMode, type NetKind, type Plan, type RoadRequest, type Snap } from './build';
import type { Game } from './game';
import { autoLevels, designProfile, PROFILE_STEP } from './grade';
import { cloneNetwork } from './railFragment';
import { type NetEdit, onOldAxis, RoadBuilder, type RoadPlan, shortOfMoney } from './roadbuild';

/**
 * Проект дороги или пути: нарисованные, но не построенные участки. Узлы и перья (управляющие точки кривых)
 * правятся сколько угодно, деньги не тратятся; «Построить» прокладывает весь проект теми же строителями,
 * что и обычная стройка (те же проверки и цена), одним шагом для Ctrl+Z.
 */

export type End = 'a' | 'b';

export interface ProjectNode {
  id: number;
  pos: Vec;
  /** Высота свободного узла: −1 тоннель, 0 земля, 1 мост (у примкнувшего — как у того, к чему примкнул). */
  level: number;
  /** Узел примыкает к тому, что уже построено (узел, середина дороги или пути): при стройке — туда. */
  attach: boolean;
}

export interface ProjectSeg {
  id: number;
  a: number;
  b: number;
  /** Перья: управляющие точки кривой у начала (p1) и у конца (p2). */
  p1: Vec;
  p2: Vec;
  spec: RoadSpec;
  /** «Авто» (дороги): где насыпь или выемка глубже допустимой — мост или тоннель сам. */
  auto?: boolean;
  /** Односторонняя — навстречу ходу проекта (от b к a). */
  reverse?: boolean;
}

export interface Project {
  nodes: ProjectNode[];
  segs: ProjectSeg[];
  next: number;
}

export const emptyProject = (): Project => ({ nodes: [], segs: [], next: 1 });
export const copyProject = (p: Project): Project => structuredClone(p);

/** Перо короче не бывает: у него должно быть направление. */
const MIN_HANDLE = 1;
/** Перья в узле по одной прямой с точностью до этого угла — узел гладкий, перо соседа поворачивается следом. */
const SMOOTH = Math.cos((4 * Math.PI) / 180);

export function nodeOf(p: Project, id: number): ProjectNode {
  const n = p.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`Узел проекта ${id} не найден`);
  return n;
}

export function segOf(p: Project, id: number): ProjectSeg | undefined {
  return p.segs.find((s) => s.id === id);
}

export function segCurve(p: Project, s: ProjectSeg): Cubic {
  return { p0: nodeOf(p, s.a).pos, p1: s.p1, p2: s.p2, p3: nodeOf(p, s.b).pos };
}

export function segsAt(p: Project, id: number): ProjectSeg[] {
  return p.segs.filter((s) => s.a === id || s.b === id);
}

export function addNode(p: Project, pos: Vec, level = 0, attach = false): ProjectNode {
  const n: ProjectNode = { id: p.next++, pos: { ...pos }, level, attach };
  p.nodes.push(n);
  return n;
}

/** Участок от узла a до узла b по форме curve (её концы — где угодно: перья сдвигаются к узлам). null — некуда. */
export function addSeg(p: Project, a: number, b: number, curve: Cubic, spec: RoadSpec, extra: { auto?: boolean; reverse?: boolean } = {}): ProjectSeg | null {
  if (a === b) return null;
  const A = nodeOf(p, a).pos;
  const B = nodeOf(p, b).pos;
  if (dist(A, B) < 1) return null;
  const s: ProjectSeg = { id: p.next++, a, b, p1: add(A, sub(curve.p1, curve.p0)), p2: add(B, sub(curve.p2, curve.p3)), spec: { ...spec } };
  if (extra.auto) s.auto = true;
  if (extra.reverse) s.reverse = true;
  p.segs.push(s);
  return s;
}

/** Перо участка у конца end: откуда (узел) и куда. */
export function handleOf(p: Project, s: ProjectSeg, end: End): { anchor: Vec; pos: Vec } {
  return end === 'a' ? { anchor: nodeOf(p, s.a).pos, pos: s.p1 } : { anchor: nodeOf(p, s.b).pos, pos: s.p2 };
}

function setHandle(s: ProjectSeg, end: End, pos: Vec): void {
  if (end === 'a') s.p1 = { ...pos };
  else s.p2 = { ...pos };
}

/** Направление из узла вдоль пера участка (наружу от узла). */
function handleDir(p: Project, s: ProjectSeg, end: End): Vec {
  const h = handleOf(p, s, end);
  const d = sub(h.pos, h.anchor);
  if (len(d) > 1e-6) return norm(d);
  // Перо в самом узле — к другому концу.
  return norm(sub(nodeOf(p, end === 'a' ? s.b : s.a).pos, h.anchor));
}

/** Гладкий узел: ровно два участка, перья по одной прямой навстречу друг другу — как стык дороги. */
export function smoothPair(p: Project, id: number): [{ seg: ProjectSeg; end: End }, { seg: ProjectSeg; end: End }] | null {
  const at = segsAt(p, id);
  if (at.length !== 2) return null;
  const [x, y] = at.map((s) => ({ seg: s, end: (s.a === id ? 'a' : 'b') as End }));
  if (x.seg === y.seg) return null;
  return dot(handleDir(p, x.seg, x.end), handleDir(p, y.seg, y.end)) < -SMOOTH ? [x, y] : null;
}

/** Куда «прямо» из узла: продолжение единственного участка проекта, что в него приходит. */
export function continuation(p: Project, id: number): Vec | null {
  const at = segsAt(p, id);
  if (at.length !== 1) return null;
  const s = at[0];
  return scale(handleDir(p, s, s.a === id ? 'a' : 'b'), -1);
}

/** Узел — на новое место: перья его участков едут вместе с ним. attach — примкнёт ли он к построенному. */
export function moveNode(p: Project, id: number, pos: Vec, attach?: boolean): void {
  const n = nodeOf(p, id);
  const d = sub(pos, n.pos);
  for (const s of segsAt(p, id)) {
    if (s.a === id) s.p1 = add(s.p1, d);
    if (s.b === id) s.p2 = add(s.p2, d);
  }
  n.pos = { ...pos };
  if (attach !== undefined) n.attach = attach;
}

/**
 * Перо участка — в точку pos. В узле из двух участков перо соседа встаёт на одну прямую с этим (длина
 * прежняя): гладкий узел поворачивается целиком, излом снова становится гладким. kink (Shift) — только это
 * перо: излом появляется или остаётся.
 */
export function moveHandle(p: Project, segId: number, end: End, pos: Vec, kink = false): void {
  const s = segOf(p, segId);
  if (!s) return;
  const id = end === 'a' ? s.a : s.b;
  const anchor = nodeOf(p, id).pos;
  const at = segsAt(p, id);
  const other = kink || at.length !== 2 ? null : at.find((x) => x.id !== segId);
  let to = pos;
  if (dist(to, anchor) < MIN_HANDLE) to = add(anchor, scale(handleDir(p, s, end), MIN_HANDLE));
  setHandle(s, end, to);
  if (!other) return;
  const oe: End = other.a === id ? 'a' : 'b';
  const l = dist(handleOf(p, other, oe).pos, anchor);
  setHandle(other, oe, sub(anchor, scale(norm(sub(to, anchor)), l)));
}

/** Узел из двух участков: гладкий (перья на одной прямой) или излом; другой узел — null. */
export function jointKind(p: Project, id: number): 'smooth' | 'kink' | null {
  if (segsAt(p, id).length !== 2) return null;
  return smoothPair(p, id) ? 'smooth' : 'kink';
}

/**
 * Изогнуть участок через точку target (дуга второго порядка, концы на месте). В гладком узле направление
 * пера прежнее — меняется только его длина, чтобы сосед продолжал участок без излома.
 */
export function bendSeg(p: Project, segId: number, target: Vec): void {
  const s = segOf(p, segId);
  if (!s) return;
  const { p0, p3 } = segCurve(p, s);
  const q = sub(scale(target, 2), scale(add(p0, p3), 0.5));
  const keep = (end: End, h: Vec, from: Vec): Vec => {
    if (!smoothPair(p, end === 'a' ? s.a : s.b)) return h;
    const t = handleDir(p, s, end);
    return add(from, scale(t, Math.max(8, dot(sub(h, from), t))));
  };
  const p1 = keep('a', add(p0, scale(sub(q, p0), 2 / 3)), p0);
  const p2 = keep('b', add(p3, scale(sub(q, p3), 2 / 3)), p3);
  s.p1 = p1;
  s.p2 = p2;
}

/** Новый узел на участке в точке t (0…1): участок делится на два той же формы. */
export function splitSeg(p: Project, segId: number, t: number): ProjectNode | null {
  const s = segOf(p, segId);
  if (!s || t <= 0.02 || t >= 0.98) return null;
  const [c1, c2] = splitBezier(segCurve(p, s), t);
  const A = nodeOf(p, s.a);
  const B = nodeOf(p, s.b);
  const n = addNode(p, c1.p3, A.level === B.level ? A.level : 0);
  const second: ProjectSeg = { ...s, id: p.next++, a: n.id, b: s.b, p1: c2.p1, p2: c2.p2, spec: { ...s.spec } };
  s.b = n.id;
  s.p1 = c1.p1;
  s.p2 = c1.p2;
  p.segs.splice(p.segs.indexOf(s) + 1, 0, second);
  return n;
}

/** Убрать узел вместе с его участками; узлы, что из-за этого остались без участков, — тоже. */
export function removeNode(p: Project, id: number): void {
  const lost = new Set(segsAt(p, id).flatMap((s) => [s.a, s.b]));
  p.segs = p.segs.filter((s) => s.a !== id && s.b !== id);
  const used = new Set(p.segs.flatMap((s) => [s.a, s.b]));
  p.nodes = p.nodes.filter((n) => n.id !== id && (used.has(n.id) || !lost.has(n.id)));
}

/** Узел from сливается с узлом into (замкнуть, соединить ветки): его участки идут в into, лишние — уходят. */
export function mergeNode(p: Project, from: number, into: number): void {
  if (from === into) return;
  const target = nodeOf(p, into).pos;
  moveNode(p, from, target);
  for (const s of p.segs) {
    if (s.a === from) s.a = into;
    if (s.b === from) s.b = into;
  }
  const seen = new Set<string>();
  p.segs = p.segs.filter((s) => {
    if (s.a === s.b) return false;
    const key = s.a < s.b ? `${s.a}:${s.b}` : `${s.b}:${s.a}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  p.nodes = p.nodes.filter((n) => n.id !== from);
}

/** Узел проекта у точки (в радиусе r), кроме skip. */
export function nodeAt(p: Project, pos: Vec, r: number, skip?: number): ProjectNode | null {
  let best: ProjectNode | null = null;
  let bestD = r;
  for (const n of p.nodes) {
    const d = dist(n.pos, pos);
    if (n.id !== skip && d <= bestD) {
      bestD = d;
      best = n;
    }
  }
  return best;
}

/** Перо у точки (в радиусе r). */
export function handleAt(p: Project, pos: Vec, r: number): { seg: number; end: End } | null {
  let best: { seg: number; end: End } | null = null;
  let bestD = r;
  for (const s of p.segs) {
    for (const end of ['a', 'b'] as const) {
      const d = dist(handleOf(p, s, end).pos, pos);
      if (d <= bestD) {
        bestD = d;
        best = { seg: s.id, end };
      }
    }
  }
  return best;
}

/** Участок под точкой: ось ближе r (r — функция полуширины участка, чтобы попадать по всей ширине дороги). */
export function segAt(p: Project, pos: Vec, r: (s: ProjectSeg) => number): { seg: ProjectSeg; t: number; point: Vec } | null {
  let best: { seg: ProjectSeg; t: number; point: Vec } | null = null;
  let bestD = Infinity;
  for (const s of p.segs) {
    const hit = new CurveLUT(segCurve(p, s)).closest(pos);
    if (hit.d <= r(s) && hit.d < bestD) {
      bestD = hit.d;
      best = { seg: s, t: hit.t, point: hit.point };
    }
  }
  return best;
}

export function projectLength(p: Project): number {
  return p.segs.reduce((sum, s) => sum + new CurveLUT(segCurve(p, s)).length, 0);
}

/**
 * Форма нового участка от a до b, как в инструменте стройки: прямая, дуга или кривая через control. dir —
 * продолжение того, что приходит в a, arrive — куда участок должен прийти в b, чтобы гладко продолжиться тем,
 * что из b уже выходит (как дуга между двумя тупиками). Дуга и кривая идут по ним без излома; прямая — прямая.
 */
export function draftCurve(a: Vec, b: Vec, mode: DrawMode, dir: Vec | null, control: Vec | null, arrive: Vec | null = null): Cubic {
  const chord = dist(a, b);
  if (mode === 'curve' && control) {
    // Перья — к точке изгиба; у продолжения и примыкания — по их направлению той же длины.
    const c = quadToCubic(a, control, b);
    return { p0: a, p1: dir ? add(a, scale(dir, dist(a, c.p1))) : c.p1, p2: arrive ? sub(b, scale(arrive, dist(b, c.p2))) : c.p2, p3: b };
  }
  if (mode !== 'arc') return straightCubic(a, b);
  // Приходить в b «задом наперёд» гладко не выйдет — тогда в b излом (перекрёсток).
  const tB = arrive && dot(arrive, sub(b, a)) > chord * 0.2 ? arrive : null;
  if (dir && tB) return { p0: a, p1: add(a, scale(dir, chord * 0.4)), p2: sub(b, scale(tB, chord * 0.4)), p3: b };
  if (dir) return arcCubic(a, dir, b) ?? { p0: a, p1: add(a, scale(dir, chord * 0.4)), p2: add(b, scale(sub(a, b), 1 / 3)), p3: b };
  if (tB) {
    const r = arcCubic(b, scale(tB, -1), a);
    if (r) return reverseCubic(r);
  }
  return straightCubic(a, b);
}

/** Перо участка у конца end — по направлению dir (от узла), длина прежняя: стык становится гладким. */
export function alignHandle(p: Project, segId: number, end: End, dir: Vec): void {
  const s = segOf(p, segId);
  if (!s) return;
  const h = handleOf(p, s, end);
  setHandle(s, end, add(h.anchor, scale(norm(dir), Math.max(MIN_HANDLE, dist(h.pos, h.anchor)))));
}

/**
 * Стык двух участков в узле — гладкий: перо участка moved встаёт навстречу перу соседа (длина прежняя).
 * Только если узел — ровно два участка и перья смотрят в разные стороны (иначе это разворот, а не стык).
 */
export function smoothJoint(p: Project, id: number, moved: number): boolean {
  const at = segsAt(p, id);
  if (at.length !== 2) return false;
  const mine = at.find((s) => s.id === moved);
  const other = at.find((s) => s.id !== moved);
  if (!mine || !other) return false;
  const endOf = (s: ProjectSeg): End => (s.a === id ? 'a' : 'b');
  const d = handleDir(p, other, endOf(other));
  if (dot(handleDir(p, mine, endOf(mine)), d) >= 0) return false;
  alignHandle(p, mine.id, endOf(mine), scale(d, -1));
  return true;
}

/**
 * Знаки скорости на поворотах проекта дороги — там же, где их поставят на построенной дороге: перед изгибом,
 * который снижает скорость, справа по ходу (у двусторонней — для обоих направлений). pos — на оси, dir — ход,
 * side — от оси до кромки с той стороны, куда ставить знак.
 */
export function projectCurveSigns(p: Project): CurveSign[] {
  const out: CurveSign[] = [];
  for (const s of p.segs) {
    if (isRail(s.spec)) continue;
    const e = roadEdges(s.spec);
    const back = isOneWay(s.spec) && !!s.reverse;
    curveSigns(new CurveLUT(segCurve(p, s)), specSpeed(s.spec), e, !back, !isOneWay(s.spec) || back, out);
  }
  return out;
}

/** Знак скорости перед поворотом: на оси, по ходу, от оси до кромки с той стороны, км/ч. */
export interface CurveSign {
  pos: Vec;
  dir: Vec;
  side: number;
  kmh: number;
}

/** Знаки на поворотах полотен ids сети net (проект перемещения: дороги в новом положении). */
/**
 * Полотна построенной сети before, чьи знаки на поворотах в проекте (сеть after) уже не те: полотно поменяло
 * форму или ушло, а на его месте дороги нет. Разрезанное проектом (перекрёсток на нём) — на месте, его знаки верны.
 * Пока проект не построен, их знаки — бледно: они старые, новые — в стиле проекта.
 */
export function staleSignCorridors(before: LaneNet, after: LaneNet): Set<number> {
  const out = new Set<number>();
  for (const c of before.corridors.values()) {
    if (after.corridors.get(c.id)?.rev === c.rev) continue;
    if (!onOldAxis(after, c)) out.add(c.id);
  }
  return out;
}

/**
 * Полотна правки (changed в сети after), у которых форма новая — не на оси того, что построено в before: их
 * знаки на поворотах считаем заново (протяжка в «Двигать» — каждый кадр, только они). Разрезанные куски старой
 * дороги — на её оси, их знаки и так верны.
 */
export function freshSignCorridors(before: LaneNet, after: LaneNet, changed: number[]): number[] {
  return changed.filter((id) => {
    const c = after.corridors.get(id);
    return !!c && !onOldAxis(before, c);
  });
}

export function corridorCurveSigns(net: LaneNet, ids: number[]): CurveSign[] {
  const out: CurveSign[] = [];
  for (const id of ids) {
    const c = net.corridors.get(id);
    if (!c || c.ring || !c.lanes.length) continue;
    const e = edgesAt(c, c.length / 2);
    const edges = { left: (e ? -e[0] : 0) + ROAD_MARGIN, right: (e ? e[1] : 0) + ROAD_MARGIN };
    curveSigns(c.lut, laneSpeed(c), edges, c.lanes.some((l) => l.flow > 0), c.lanes.some((l) => l.flow < 0), out);
  }
  return out;
}

/** Знаки на кривой lut с разрешённой скоростью speed: по ходу (fwd) — справа, навстречу (back) — с другой кромки. */
function curveSigns(lut: CurveLUT, speed: number, e: { left: number; right: number }, fwd: boolean, back: boolean, out: CurveSign[]): void {
  const L = lut.length;
  for (const zone of curveZones(curveLimits(lut, speed), speed, KMH_PER_UNIT)) {
    if (fwd) {
      const at = Math.max(0, zone.from - 15);
      out.push({ pos: lut.pointAt(at), dir: lut.tangentAt(at), side: e.right, kmh: zone.kmh });
    }
    // Навстречу изгиб начинается с его дальнего (по оси) конца.
    if (back) {
      const at = Math.min(L, zone.to + 15);
      out.push({ pos: lut.pointAt(at), dir: scale(lut.tangentAt(at), -1), side: e.left, kmh: zone.kmh });
    }
  }
}

// ---------- Проект → дороги ----------

/** Ближайший узел сети у точки (в 2 м): туда легли концы участка. */
function nodeNear(net: LaneNet, pos: Vec): number | undefined {
  return net
    .nodesNear(pos, 2)
    .sort((x, y) => dist(x.pos, pos) - dist(y.pos, pos))[0]?.id;
}

/**
 * «Авто» на участке формы curve: где полотну по профилю нужна насыпь или выемка глубже допустимой — мост или
 * тоннель с пандусами (как у обычной стройки в «Авто»). levels — смены высоты по пути (доля длины и уровень),
 * start и end — уровни концов (у свободного конца «Авто» может поднять его на мост). Слишком круто — причина.
 */
export function autoLevelsAlong(
  curve: Cubic,
  ground: (p: Vec) => number,
  start: { level: number; fixed: boolean },
  end: { level: number; fixed: boolean },
): { levels: { at: number; level: number }[]; start: number; end: number; zAt: (p: Vec) => number } | { reason: string } {
  const lut = new CurveLUT(curve);
  const L = lut.length;
  const n = Math.max(2, Math.ceil(L / PROFILE_STEP) + 1);
  const ds = L / (n - 1);
  const h = new Float64Array(n);
  for (let i = 0; i < n; i++) h[i] = ground(lut.pointAt(ds * i));
  const h0 = Number.isNaN(h[0]) ? 0 : h[0];
  const h1 = Number.isNaN(h[n - 1]) ? h0 : h[n - 1];
  const prof = designProfile(h, ds, GRADE.road, { start: h0 + deckHeight(start.level), end: h1 + deckHeight(end.level) }, GRADE.smooth);
  if (prof.steep) return { reason: `Подъём круче ${Math.round(GRADE.road * 100)}% — ведите дорогу длиннее` };
  const pts = autoLevels(prof.z, h, ds, GRADE.roadDepth, LEVEL_RUN + 10, { start: start.fixed ? start.level : undefined, end: end.fixed ? end.level : undefined });
  // Отметка полотна по проекту — узлам моста и тоннеля (setDecks), чтобы их уклон был уклоном профиля.
  const zAt = zAlong(Array.from({ length: n }, (_, i) => lut.pointAt(ds * i)), prof.z);
  return { levels: pts.slice(1, -1).map((q) => ({ at: q.s / L, level: q.level })), start: pts[0].level, end: pts[pts.length - 1].level, zAt };
}

/**
 * Прокладывает первые count участков проекта на сети net — теми же правками, что и обычная стройка дороги
 * (buildRoad): узлы проекта, примкнувшие к построенному, — к его узлам и дорогам, общие узлы участков — одним
 * узлом сети. Не выходит — EditError с причиной.
 */
export function layRoadProject(net: LaneNet, p: Project, ground: ((q: Vec) => number) | null, count = p.segs.length): void {
  const placed = new Map<number, number>();
  const anchor = (n: ProjectNode): Anchor => {
    const id = placed.get(n.id);
    const at = id !== undefined ? net.nodes.get(id) : undefined;
    if (at) return { kind: 'node', node: at.id, pos: at.pos };
    if (n.attach) {
      const a = anchorAt(net, n.pos, 3, n.level);
      if (a.kind !== 'free') return a;
    }
    return { kind: 'free', pos: n.pos, level: n.level };
  };
  const levelOf = (a: Anchor): number =>
    a.kind === 'node' ? net.node(a.node).level : a.kind === 'corridor' ? Math.round(net.heightAt(net.corridor(a.corridor), a.s)) : (a.level ?? 0);
  for (const s of p.segs.slice(0, count)) {
    const A0 = anchor(nodeOf(p, s.a));
    const B0 = anchor(nodeOf(p, s.b));
    const c = segCurve(p, s);
    const curve: Cubic = { p0: A0.pos, p1: add(A0.pos, sub(c.p1, c.p0)), p2: add(B0.pos, sub(c.p2, c.p3)), p3: B0.pos };
    const profile = profileOf(s.spec);
    if (s.reverse && isOneWay(s.spec)) profile.lanes = profile.lanes.map((l) => ({ ...l, flow: -l.flow as Flow }));
    let A = A0;
    let B = B0;
    let levels: { at: number; level: number }[] | undefined;
    let zAt: ((p: Vec) => number) | null = null;
    if (s.auto && ground) {
      const res = autoLevelsAlong(curve, ground, { level: levelOf(A0), fixed: A0.kind !== 'free' }, { level: levelOf(B0), fixed: B0.kind !== 'free' });
      if ('reason' in res) throw new EditError(res.reason);
      if (A0.kind === 'free') A = { ...A0, level: res.start };
      if (B0.kind === 'free') B = { ...B0, level: res.end };
      if (res.levels.length) levels = res.levels;
      zAt = res.zAt;
    }
    const had = zAt ? new Set(net.nodes.keys()) : null;
    if (!buildRoad(net, A, B, { ...profile, curve, levels }).length) throw new EditError('Слишком коротко');
    // Новые узлы моста и тоннеля — на отметке профиля (как у обычной стройки «Авто»).
    if (zAt && had && ground) setDecks(net, (x) => !had.has(x.id), zAt, ground);
    for (const [id, pos] of [
      [s.a, A.pos],
      [s.b, B.pos],
    ] as const) {
      const node = nodeNear(net, pos);
      if (node !== undefined) placed.set(id, node);
    }
  }
}

// ---------- Проект → пути ----------

/** Что вышло из раскладки путей проекта: план каждого проверенного участка, где не вышло и почему, цена. */
export interface RailLay {
  plans: Map<number, Plan>;
  bad: number | null;
  reason?: string;
  cost: number;
  /** Сколько участков построено. */
  built: number;
}

/**
 * Кладёт пути проекта участок за участком строителем builder на его сети net — так же, как обычная стройка
 * пути (Builder.build со всеми проверками); общие узлы участков — одним узлом. Первый участок, который не
 * выходит, останавливает раскладку (bad).
 */
export function layRailProject(builder: Builder, net: Network, p: Project): RailLay {
  const placed = new Map<number, number>();
  const out: RailLay = { plans: new Map(), bad: null, cost: 0, built: 0 };
  const snap = (n: ProjectNode): Snap => {
    const id = placed.get(n.id);
    const at = id !== undefined ? net.nodes.get(id) : undefined;
    if (at) return { kind: 'node', nodeId: at.id, pos: at.pos, level: at.level };
    if (n.attach) {
      const s = builder.snap(n.pos, n.level, 3);
      if (s.kind !== 'free') return s;
    }
    return { kind: 'free', pos: { ...n.pos }, level: n.level };
  };
  for (const s of p.segs) {
    const start = snap(nodeOf(p, s.a));
    const end = snap(nodeOf(p, s.b));
    const c = segCurve(p, s);
    const curve: Cubic = { p0: start.pos, p1: add(start.pos, sub(c.p1, c.p0)), p2: add(end.pos, sub(c.p2, c.p3)), p3: end.pos };
    const req: RoadRequest = { start, end, spec: s.spec, mode: 'straight', curve };
    const plan = builder.plan(req);
    out.plans.set(s.id, plan);
    const res = plan.ok ? builder.build(req) : null;
    if (!res) {
      out.bad = s.id;
      out.reason = plan.reason ?? 'Нельзя построить путь';
      return out;
    }
    out.cost += plan.cost;
    out.built++;
    placed.set(s.a, res.startNode);
    placed.set(s.b, res.endNode);
  }
  return out;
}

// ---------- Проект в игре ----------

/** Что получится из проекта: можно ли, цена, участок с бедой и предпросмотр. */
export interface ProjectPlan {
  ok: boolean;
  reason?: string;
  /** Сколько стоит весь проект (если он посчитался). */
  cost: number;
  length: number;
  /** Участок, на котором стройка не выходит (null — всё в порядке или не хватает денег). */
  bad: number | null;
  /** Дороги: сеть с проектом (или с той его частью, что выходит) — для предпросмотра. */
  road: RoadPlan | null;
  /** Пути: планы проверенных участков. */
  rails: Map<number, Plan>;
  /** Дома под снос. */
  demolish: number[];
}

/** Строитель дорог для предпросмотра: без лимита денег (деньги сверяем сами — это не беда участка). */
function previewRoads(g: Game): RoadBuilder {
  return new RoadBuilder({
    roads: g.roads,
    budget: Infinity,
    isWater: (q, m) => g.isWater(q, m),
    inBounds: (q, m) => g.inBounds(q, m),
    ground: () => g.ground(),
    obstaclesAt: (q, r) => g.obstaclesAt(q, r),
    // Расширение улицы проектом: навесы и строительные базы отодвигаются, как при стройке сразу (там — сама игра).
    shoveStops: (n, c, d) => g.shoveStops(n, c, d),
    demolishCost: (id) => g.demolishCost(id),
    demolish: () => {},
    spend: () => {},
    refund: () => {},
    networkChanged: () => {},
    railConflict: (n, c) => g.railConflict(n, c),
    projectId: () => g.projectId(),
  });
}

/**
 * Проект дорог одной правкой сети: сперва правки построенных дорог (edits — перенос узлов, перья, изгибы, как в
 * «Двигать»), потом первые count участков проекта — уже на сети с этими правками.
 */
export function roadProjectEdit(p: Project, ground: ((q: Vec) => number) | null, edits: NetEdit[] = [], count = p.segs.length): NetEdit {
  return (net) => {
    for (const e of edits) if (e(net) === false) return false;
    if (count > 0) layRoadProject(net, p, ground, count);
    return edits.length > 0 || count > 0;
  };
}

/** Проект дорог: весь целиком; не выходит — первый участок, на котором ломается (делением пополам). */
function roadProjectPlan(g: Game, p: Project, length: number, edits: NetEdit[] = [], shove = false): ProjectPlan {
  const b = previewRoads(g);
  const ground = g.ground();
  const lay = (count: number) => b.plan(roadProjectEdit(p, ground, edits, count), { shove, project: true });
  const full = lay(p.segs.length);
  if (full.ok) {
    // «Со строительством» новые участки — проект: денег должно хватать только на то, что платится сразу (cost).
    const reason = shortOfMoney(full.cost, g.budget, full.project) ? 'Не хватает денег' : undefined;
    return { ok: !reason, reason, cost: full.cost, length, bad: null, road: full, rails: new Map(), demolish: full.demolish };
  }
  // Не выходят уже правки построенных дорог — участки тут ни при чём.
  const base = edits.length ? lay(0) : null;
  if (base && !base.ok) {
    return { ok: false, reason: base.reason ?? 'Так не построить', cost: full.net ? full.cost : base.cost, length, bad: null, road: base.net ? base : null, rails: new Map(), demolish: base.demolish };
  }
  // Первый участок, с которым проект уже не строится: всё до него — в предпросмотре как есть.
  let lo = 0;
  let hi = p.segs.length;
  let good: RoadPlan | null = base;
  let failed = full;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const plan = lay(mid);
    if (plan.ok) {
      lo = mid;
      good = plan;
    } else {
      hi = mid;
      failed = plan;
    }
  }
  if (lo > 0 && !good) good = lay(lo);
  return {
    ok: false,
    reason: failed.reason ?? 'Так не построить',
    cost: full.net ? full.cost : (good?.cost ?? 0),
    length,
    bad: p.segs[hi - 1]?.id ?? null,
    road: good,
    rails: new Map(),
    demolish: good?.demolish ?? [],
  };
}

/** Проект путей: раскладка на копии сети путей (дома, снесённые одним участком, другим уже не мешают). */
function railProjectPlan(g: Game, p: Project, length: number): ProjectPlan {
  const sim = cloneNetwork(g.net);
  const razed = new Set<number>();
  const builder = new Builder({
    net: sim,
    budget: Infinity,
    isWater: (q, m) => g.isWater(q, m),
    inBounds: (q, m) => g.inBounds(q, m),
    ground: () => g.ground(),
    obstaclesAt: (q, r) => g.obstaclesAt(q, r).filter((o) => !razed.has(o.id)),
    demolishCost: (id) => g.demolishCost(id),
    demolish: (ids) => ids.forEach((id) => razed.add(id)),
    spend: () => {},
    refund: () => {},
    networkChanged: () => {},
    roadConflict: (lut, levelAt, hw) => g.roadConflict(lut, levelAt, hw),
  });
  const res = layRailProject(builder, sim, p);
  const reason = res.reason ?? (res.cost > g.budget ? 'Не хватает денег' : undefined);
  const cost = [...res.plans.values()].reduce((sum, x) => sum + x.cost, 0);
  return { ok: !reason, reason, cost, length, bad: res.bad, road: null, rails: res.plans, demolish: [...razed] };
}

/** Что получится из проекта и сколько он стоит — ничего не строя и не тратя. */
export function projectPlan(g: Game, kind: NetKind, p: Project, edits: NetEdit[] = [], shove = false): ProjectPlan {
  const length = projectLength(p);
  const road = kind === 'road' ? edits : [];
  if (!p.segs.length && !road.length) return { ok: false, reason: 'Проект пуст', cost: 0, length, bad: null, road: null, rails: new Map(), demolish: [] };
  return kind === 'rail' ? railProjectPlan(g, p, length) : roadProjectPlan(g, p, length, road, shove);
}

/**
 * Строит проект целиком одним шагом для Ctrl+Z: те же строители и проверки, деньги списываются; у дорог —
 * вместе с правками построенных дорог (edits; shove — среди них расширение дороги «Полосой»: дома отодвигаются,
 * а не сносятся). Не выходит — ничего не строится; ответ — причина (null — построен).
 */
export function buildProject(g: Game, kind: NetKind, p: Project, edits: NetEdit[] = [], shove = false): string | null {
  if (!p.segs.length && !(kind === 'road' && edits.length)) return 'Проект пуст';
  if (kind === 'road') {
    const ground = g.ground();
    const plan = g.roadBuilder.plan(roadProjectEdit(p, ground, edits), { shove, project: true });
    if (!plan.ok) return plan.reason ?? 'Так не построить';
    g.checkpoint('проект дороги');
    g.roadBuilder.apply(plan);
    if (shove) for (const id of plan.changed) g.roadWidened(id);
    g.commit();
    return null;
  }
  const pre = railProjectPlan(g, p, 0);
  if (!pre.ok) return pre.reason ?? 'Так не построить';
  g.checkpoint('проект пути');
  const res = layRailProject(g.builder, g.net, p);
  g.commit();
  // Не вышло посередине (чего на копии не было) — уже уложенное откатываем.
  if (res.bad !== null) {
    if (res.built) g.undo(false);
    return res.reason ?? 'Так не построить';
  }
  return null;
}

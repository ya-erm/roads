import { arcCubic, circleArc, Cubic, CurveLUT, intersectCurves, splitBezier, straightCubic } from '../core/bezier';
import { add, cross, dist, dot, len, norm, rightNormal, scale, sub, Vec } from '../core/vec';
import { CONSTRUCTION } from '../config';
import { LANE_W, RoadClass } from '../world/roadTypes';
import { nodeDeck } from './deck';
import { edgesAt, laneBand, pointOff } from './geometry';
import { Corridor, CorridorBuild, CorridorEnd, End, Flow, LaneNet, LaneNode, LaneSlot, LAT_EPS, NodeKind, oneWay, renameArm, slot, taperLen } from './model';

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
    // Стык посреди дороги притягивает, только если из него выйдет перекрёсток (не съезд, не сужение) или
    // с одной его стороны дорога не продолжается (там только въезд или съезд) — её можно продолжить, как тупик.
    if (n.kind === 'seam' && openSeamSide(net, n) === null && !net.ends(n).every((e) => Math.abs(e.port) < LAT_EPS)) continue;
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
      if (Math.abs(hit.s - s) < edge && (n.kind === 'junction' || openSeamSide(net, n) !== null)) return { kind: 'node', node: n.id, pos: n.pos };
    }
    const s = Math.max(edge, Math.min(c.length - edge, hit.s));
    return { kind: 'corridor', corridor: c.id, s, pos: c.lut.pointAt(s) };
  }
  return { kind: 'free', pos: { ...p }, level: level ?? 0 };
}

/**
 * Сторона стыка (1 — спереди по dir), где дорога не продолжается и её можно продолжить, как из тупика:
 * пустая сторона тупика или сторона, где только ответвления (въезд, съезд) — дорогу за ними снесли.
 * У стыка посреди дороги — null.
 */
export function openSeamSide(net: LaneNet, n: LaneNode): 1 | -1 | null {
  if (n.kind !== 'seam') return null;
  const ends = net.ends(n);
  const sides = [1, -1] as const;
  return sides.find((s) => !ends.some((e) => e.side === s)) ?? sides.find((s) => !ends.some((e) => e.side === s && Math.abs(e.port) < LAT_EPS)) ?? null;
}

/**
 * Полотно, на асфальте которого точка (с запасом margin). Где полотна друг над другом — на высоте
 * level, без неё — верхнее (его и видно).
 */
export function corridorUnder(net: LaneNet, p: Vec, margin = 0, level?: number, skip?: (c: Corridor) => boolean): Corridor | null {
  let best: Corridor | null = null;
  let bestD = Infinity;
  for (const c of net.corridorsNear(p, margin + 40)) {
    if (skip?.(c)) continue;
    const hit = c.lut.closest(p);
    const h = net.heightAt(c, hit.s);
    const e = edgesAt(c, hit.s);
    if (!e) continue;
    const d = dot(sub(p, hit.point), rightNormal(c.lut.tangentAt(hit.s)));
    // За концом полотна (на продолжении оси) — уже не на нём: сбоку там 0, а вдоль — сколько угодно.
    // Допуск гасит ошибку округления: точно на полотне hit.d и |d| совпадают лишь приближённо.
    const beyond = Math.sqrt(Math.max(0, hit.d * hit.d - d * d - 0.01));
    const out = Math.max(e[0] - 1.5 - d, d - e[1] - 1.5, beyond, 0);
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
    if (!laneBand(c, l, hit.s)) return;
    // По всей ширине полосы — и на отгоне, где сама она уже узкая (иначе в её кончик не попасть).
    const off = Math.max(0, Math.abs(d - l.offset) - LANE_W / 2);
    if (off < bestD) {
      bestD = off;
      best = i;
    }
  });
  return best >= 0 && bestD < 1.5 ? { corridor: c, lane: best, s: hit.s } : null;
}

/** Конец пристроенной полосы под курсором (её отгон или рядом с ним): какая полоса, какой конец, где курсор на оси. */
export function laneEndAt(net: LaneNet, p: Vec): { corridor: Corridor; lane: number; end: 'from' | 'to'; s: number } | null {
  const on = laneUnder(net, p);
  if (!on) return null;
  const c = on.corridor;
  const l = c.lanes[on.lane];
  if (Math.abs(l.offset) < 0.01) return null;
  const T = taperLen(c.cls) + 12;
  if (l.from > 0.01 && Math.abs(on.s - l.from) < T) return { corridor: c, lane: on.lane, end: 'from', s: on.s };
  if (l.to < c.length - 0.01 && Math.abs(on.s - l.to) < T) return { corridor: c, lane: on.lane, end: 'to', s: on.s };
  return null;
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
  // Мост или тоннель с заданной высотой: новый узел — на той же высоте, что полотно в этом месте.
  const [A, B] = [net.node(c.a), net.node(c.b)];
  if (level !== 0 && (A.deck !== undefined || B.deck !== undefined)) node.deck = nodeDeck(A) + (nodeDeck(B) - nodeDeck(A)) * (s / c.length);
  const L = c.length;
  const lanes1 = c.lanes.filter((l) => l.from < s - 0.5).map((l) => ({ ...l, to: l.to >= s - 0.01 ? Infinity : l.to }));
  const lanes2 = c.lanes
    .filter((l) => l.to > s + 0.5)
    .map((l) => ({ ...l, from: l.from <= s + 0.01 ? 0 : l.from - s, to: l.to >= L - 0.01 ? Infinity : l.to - s }));
  const { a, b, portA, portB, cls, limit, ring } = c;
  net.removeCorridor(c.id, true);
  const first = net.addCorridor(a, node.id, { cls, lanes: lanes1, portA, curve: c1, limit, ring });
  const second = net.addCorridor(node.id, b, { cls, lanes: lanes2, portB, curve: c2, limit, ring });
  // Строящееся полотно — оба куска тоже стройка того же проекта: готовое делится по месту разреза.
  if (c.build) {
    const [b1, b2] = splitBuild(c.build, L, first.length);
    first.build = b1;
    second.build = b2;
  }
  // Настройки перекрёстков на концах (запреты, главная, связи полос) — на новые куски.
  if (a !== b) {
    renameArm(net.node(a), c.id, first.id);
    renameArm(net.node(b), c.id, second.id);
  }
  // Новый въезд на кольцо — тоже узел кольца.
  if (ring) node.roundabout = net.node(a).roundabout ?? null;
  return { node, first, second };
}

/**
 * Стройка полотна длиной L, разрезанного так, что первый кусок — длиной s: готовое (done метров от конца a или,
 * с fromB, от b) делится между кусками. Готовый целиком кусок остаётся стройкой с done = длина — его откроет
 * стройка в следующий такт (и засчитает в проект).
 */
export function splitBuild(b: CorridorBuild, L: number, s: number): [CorridorBuild, CorridorBuild] {
  const rest = Math.max(0, L - s);
  // Отсчёт от a: первый кусок получает готовое первым; от b — второй.
  const near = b.fromB ? rest : s;
  const far = b.fromB ? s : rest;
  const mk = (done: number, stages?: [number, number, number]): CorridorBuild => ({
    project: b.project,
    done,
    ...(b.fromB ? { fromB: true } : {}),
    ...(stages ? { stages } : {}),
  });
  // У этапов свой ход (CorridorBuild.stages): каждый делится по месту разреза, готовое куска — по долям этапов (сумма
  // кусков — то же, что было: заплаченное не теряется и не платится дважды).
  if (b.stages) {
    const s0 = b.stages.map((x) => Math.min(near, Math.max(0, x))) as [number, number, number];
    const s1 = b.stages.map((x) => Math.min(far, Math.max(0, x - near))) as [number, number, number];
    const w = CONSTRUCTION.stages;
    const work = (st: number[], len: number) => (st.every((x) => x >= len - 1e-9) ? len : st.reduce((sum, x, k) => sum + w[k] * x, 0));
    const nearDone = work(s0, near);
    const farDone = Math.max(0, b.done - nearDone);
    return b.fromB ? [mk(farDone, s1), mk(nearDone, s0)] : [mk(nearDone, s0), mk(farDone, s1)];
  }
  const nearDone = Math.min(near, b.done);
  const farDone = Math.min(far, Math.max(0, b.done - near));
  return b.fromB ? [mk(farDone), mk(nearDone)] : [mk(nearDone), mk(farDone)];
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
  /**
   * Смены высоты по пути («Авто»: пандусы, мост, тоннель): at — доля длины от начала (по порядку), level —
   * уровень стыка там. Дорога в плане та же, что без них, — куски одной кривой, а не каждый своей.
   */
  levels?: { at: number; level: number }[];
  /**
   * Готовая форма (проект дороги): перья p1, p2 — как задал игрок, концы — у узлов (перья едут за ними).
   * Перо у тупика почти вдоль него — дорога продолжает тупик, заметно в сторону — излом (перекрёсток).
   */
  curve?: Cubic;
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
    const free = openSeamSide(net, n);
    if (free === null) return null;
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
  let kinkA = kinked(A, o.control ?? B.pos, true);
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
  // Готовая форма (проект): направления — по перьям; перо у тупика почти вдоль него — продолжение, иначе излом.
  const fixed = o.curve;
  if (fixed) {
    const d0 = dist(fixed.p0, fixed.p1) > 1e-6 ? norm(sub(fixed.p1, fixed.p0)) : chordDir(A, B.pos, true);
    const d3 = dist(fixed.p3, fixed.p2) > 1e-6 ? norm(sub(fixed.p3, fixed.p2)) : chordDir(B, A.pos, false);
    const s0 = seamDir(A, true);
    const s3 = seamDir(B, false);
    kinkA = !!s0 && dot(s0, d0) < Math.cos(0.05);
    kinkB = !!s3 && dot(s3, d3) < Math.cos(0.05);
    t0 = s0 && !kinkA ? s0 : d0;
    t3 = s3 && !kinkB ? s3 : d3;
  }
  const start = resolveEnd(net, A, t0, true, o.lanes, kinkA);
  const end = resolveEnd(net, B, t3, false, o.lanes, kinkB);
  const p0 = start.node.pos;
  const p3 = end.node.pos;
  const h0 = fixed ? dist(fixed.p0, fixed.p1) : arc ? dist(arc.p0, arc.p1) : o.control ? (dist(p0, o.control) * 2) / 3 : dist(p0, p3) / 3;
  const h3 = fixed ? dist(fixed.p3, fixed.p2) : arc ? dist(arc.p3, arc.p2) : o.control ? (dist(p3, o.control) * 2) / 3 : dist(p0, p3) / 3;
  const curve: Cubic = { p0, p1: add(p0, scale(t0, h0)), p2: sub(p3, scale(t3, h3)), p3 };
  if (!o.levels?.length) return chain(net, start, end, curve, o);
  // Смены высоты — стыки на самой кривой: каждый кусок — её часть, форма дуги и касательные на стыках те же.
  const lut = new CurveLUT(curve);
  const made: Corridor[] = [];
  let from = start;
  let rest = curve;
  let done = 0;
  for (const q of o.levels) {
    const s = q.at * lut.length;
    const t = lut.tAt(s);
    if (t <= done + 1e-6 || t >= 1 - 1e-6) continue;
    const [head, tail] = splitBezier(rest, (t - done) / (1 - done));
    const node = net.addSeam(head.p3, lut.tangentAt(s), q.level);
    made.push(...chain(net, from, { node, side: -1 }, head, o));
    from = { node, side: 1 };
    rest = tail;
    done = t;
  }
  made.push(...chain(net, from, end, rest, o));
  return made;
}

/**
 * Узел у конца новой дороги. dir — направление дороги в этой точке (по ходу от начала к концу).
 * kink — из тупика под углом: он становится перекрёстком.
 */
function resolveEnd(net: LaneNet, x: Anchor, dir: Vec, start: boolean, lanes: LaneSlot[], kink = false): RoadEnd {
  if (x.kind === 'node') {
    const n = net.node(x.node);
    if (n.kind === 'junction') return { node: n };
    const side = openSeamSide(net, n);
    // Стык, занятый с обеих сторон, — ответвление из него делает перекрёсток.
    if (side === null) {
      if (net.ends(n).every((e) => Math.abs(e.port) < LAT_EPS)) n.kind = 'junction';
      return { node: n };
    }
    // Полосы новой дороги в стыке — те же, что у дороги с той стороны (кроме ушедших в ответвления)? Тогда это
    // продолжение, иначе — перекрёсток.
    const along = start ? side : -side;
    const mine = lanes.map((l) => `${Math.round(l.offset * along * 2)}:${l.flow * along > 0}`).sort();
    const theirs = net
      .ends(n)
      .filter((e) => e.side !== side)
      .flatMap((e) =>
        e.corridor.lanes.filter((l, i) => net.reaches(e.corridor, l, e.end) && !net.across(e.corridor, i, e.end)).map((l) => net.laneAtSeam(e, l)),
      )
      .map((l) => `${Math.round(l.lat * 2)}:${l.forward}`)
      .sort();
    if (!kink && mine.join() === theirs.join()) return { node: n, side };
    if (net.ends(n).every((e) => Math.abs(e.port) < LAT_EPS)) n.kind = 'junction';
    // Въезд или съезд в стыке перекрёстком не станет — дорога продолжает его как есть.
    else return { node: n, side };
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
  /** Тянут конец уже пристроенной полосы (её номер на полотне host, какой конец и где он был). */
  grab?: { lane: number; end: 'from' | 'to'; at: number };
}

/** Черновик полосы от точки p. С конца уже пристроенной полосы — тянется сам этот конец (удлинить, укоротить). */
export function startLane(net: LaneNet, p: Vec, radius: number): LaneDraft {
  const at = laneEndAt(net, p);
  if (at) {
    const c = at.corridor;
    const l = c.lanes[at.lane];
    const pos = pointOff(c, at.s, l.offset);
    const host = { corridor: c.id, side: (l.offset > 0 ? 1 : -1) as 1 | -1, offset: l.offset, s0: at.s, s1: at.s };
    const grab = { lane: at.lane, end: at.end, at: at.end === 'from' ? l.from : l.to };
    return { start: { kind: 'free', pos }, host, merge: false, depart: null, end: { kind: 'free', pos }, grab };
  }
  const edge = edgeAt(net, p);
  if (edge) {
    return { start: { kind: 'free', pos: edge.pos }, host: { ...edge, s0: edge.s, s1: edge.s }, merge: false, depart: null, end: { kind: 'free', pos: edge.pos } };
  }
  const a = anchorAt(net, p, radius);
  return { start: a, host: null, merge: false, depart: null, end: a };
}

/** Курсор от линии полосы дальше этого — полоса отходит от края (съезд). */
const DEPART_LAT = 14;

/**
 * Курсор сдвинулся: полоса идёт вдоль края, отрывается от него или прилипает. Отошла и вернулась
 * к линии полосы дальше по дороге — снова тянется вдоль края (длинная полоса торможения на изгибе).
 */
export function dragLane(net: LaneNet, d: LaneDraft, p: Vec, radius: number): LaneDraft {
  // Конец пристроенной полосы ходит вдоль дороги за курсором — в сторону не уводится.
  if (d.grab && d.host) {
    const c = net.corridors.get(d.host.corridor);
    return c ? { ...d, host: { ...d.host, s1: c.lut.closest(p).s } } : d;
  }
  if (d.host && !d.merge) {
    const c = net.corridors.get(d.host.corridor);
    if (!c) return d;
    const hit = c.lut.closest(p);
    const lat = dot(sub(p, hit.point), rightNormal(c.lut.tangentAt(hit.s)));
    const along = hit.s > 1 && hit.s < c.length - 1;
    // Курсор у линии полосы — она тянется вдоль края; ушёл в сторону — дальше съезд от того места, где была.
    if (Math.abs(lat - d.host.offset) < DEPART_LAT && along) return { ...d, host: { ...d.host, s1: hit.s }, depart: null };
    return { ...d, depart: anchorAt(net, p, radius) };
  }
  if (d.depart) return { ...d, depart: anchorAt(net, p, radius) };
  if (d.host) {
    const c = net.corridors.get(d.host.corridor);
    if (!c) return d;
    const hit = c.lut.closest(p);
    const lat = dot(sub(p, hit.point), rightNormal(c.lut.tangentAt(hit.s)));
    // Въезд: полоса разгона тянется вдоль края, пока курсор у её линии; ушёл в сторону — дальше съезд.
    if (Math.abs(lat - d.host.offset) < DEPART_LAT && hit.s > 1 && hit.s < c.length - 1) return { ...d, host: { ...d.host, s1: hit.s } };
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
  if (d.grab) return moveLaneEnd(net, c, d.grab, d.host.s1 - d.host.s0);
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
    placeLane(net, c, { offset, flow, from: lo, to: hi });
    return true;
  }
  // Въезд — в начале пути вдоль края, съезд — в конце (по ходу движения); на оси это lo или hi.
  const inAtLo = flow > 0;
  const cutLo = inAtLo ? d.merge : !!d.depart;
  const cutHi = inAtLo ? !!d.depart : d.merge;
  // Режем полотно стыками: сначала у большего s, потом у меньшего; полоса — в части между ними. Рядом со стыком,
  // который уже есть (там другое ответвление), не режем заново — ответвляемся в нём: съезд и въезд в одном узле,
  // без короткого куска дороги между ними.
  const seamNear = (end: End, s: number): LaneNode | null => {
    if (end === 'a' ? s > SEAM_SNAP : s < c.length - SEAM_SNAP) return null;
    const n = net.node(end === 'a' ? c.a : c.b);
    return n.kind === 'seam' && !net.isDeadEnd(n) ? n : null;
  };
  let host = c;
  let base = 0;
  let seamHi = cutHi ? seamNear('b', hi) : null;
  let seamLo = cutLo ? seamNear('a', lo) : null;
  if (cutHi && !seamHi) {
    const r = splitCorridor(net, host, hi, 'seam');
    seamHi = r.node;
    host = r.first;
  }
  if (cutLo) {
    if (!seamLo) {
      const r = splitCorridor(net, host, lo, 'seam');
      seamLo = r.node;
      host = r.second;
      base = lo;
    }
  }
  // До стыков полоса идёт на полную ширину и продолжается за ними, у свободных концов — отгон; такая же
  // полоса тут уже есть — сливаются.
  mergeLane(net, host, { offset, flow, from: seamLo ? 0 : lo - base, to: seamHi ? Infinity : hi - base });
  // У полосы в стыке не два продолжения: за съездом (до въезда) та же полоса, шедшая насквозь, — с отгона.
  if (seamHi) taperThrough(net, host, 'b', offset, flow);
  if (seamLo) taperThrough(net, host, 'a', offset, flow);
  const seamIn = inAtLo ? seamLo : seamHi;
  const seamOut = inAtLo ? seamHi : seamLo;
  // Съезд уходит от стыка по ходу движения, въезд приходит к стыку против хода. Стык, который уже был, может
  // смотреть против оси этого полотна — тогда и стороны, и место поперёк у него обратные.
  const branch = (seam: LaneNode, out: boolean, other: Anchor) => {
    const at = net.end(host, seam === seamHi ? 'b' : 'a');
    const sgn = dot(seam.dir, host.lut.tangentAt(at.end === 'a' ? 0 : host.length)) >= 0 ? 1 : -1;
    const port = offset * sgn;
    const side: 1 | -1 = ((out ? flow : -flow) * sgn) as 1 | -1;
    const lanes = [slot(0, 1)];
    // Свободный конец — дугой окружности от стыка: при заданном направлении у стыка это самый большой радиус
    // (съезд на поворот не заворачивает круто сразу у дороги), а тупик на конце смотрит по дуге, как у инструмента
    // «Дуга». Конец в тупике со своим направлением — кривой по обоим.
    const free = other.kind === 'free';
    if (out) {
      const t0 = scale(seam.dir, side);
      const p0 = net.portPos(seam, port);
      const arcTo = free ? arcCubic(p0, t0, other.pos) : null;
      const end = resolveBranchEnd(net, other, arcTo ? sub(arcTo.p3, arcTo.p2) : sub(other.pos, p0), false, lanes);
      const p3 = end.node.pos;
      const h = dist(p0, p3) / 3;
      const arc = arcTo ?? (end.side ? null : arcCubic(p0, t0, p3));
      const t3 = end.side ? scale(end.node.dir, -end.side) : norm(sub(p3, add(p0, scale(t0, h))));
      const curve = arc ?? { p0, p1: add(p0, scale(t0, h)), p2: sub(p3, scale(t3, h)), p3 };
      net.addCorridor(seam.id, end.node.id, { cls, lanes, portA: port, curve: { ...curve, p0, p3 } });
    } else {
      const p3 = net.portPos(seam, port);
      const t3 = scale(seam.dir, -side);
      // Въезд — та же дуга, построенная от стыка назад.
      const backTo = free ? arcCubic(p3, scale(t3, -1), other.pos) : null;
      const begin = resolveBranchEnd(net, other, backTo ? sub(backTo.p2, backTo.p3) : sub(p3, other.pos), true, lanes);
      const p0 = begin.node.pos;
      const h = dist(p0, p3) / 3;
      const back = backTo ?? (begin.side ? null : arcCubic(p3, scale(t3, -1), p0));
      const t0 = begin.side ? scale(begin.node.dir, begin.side) : norm(sub(sub(p3, scale(t3, h)), p0));
      const curve = back ? { p0: back.p3, p1: back.p2, p2: back.p1, p3: back.p0 } : { p0, p1: add(p0, scale(t0, h)), p2: sub(p3, scale(t3, h)), p3 };
      net.addCorridor(begin.node.id, seam.id, { cls, lanes, portB: port, curve: { ...curve, p0, p3 } });
    }
  };
  if (seamOut && d.depart) branch(seamOut, true, d.depart);
  if (seamIn) branch(seamIn, false, d.start);
  return true;
}

/** Ответвление ставим в стык, который уже есть, если он ближе этого (м): съезд и въезд в одном узле. */
const SEAM_SNAP = 15;

/**
 * Полоса (offset, flow) полотна host у стыка на конце end теперь уходит в ответвление или приходит из него:
 * такая же полоса за стыком по продолжению дороги, шедшая насквозь, начинается (кончается) отгоном.
 */
function taperThrough(net: LaneNet, host: Corridor, end: End, offset: number, flow: Flow): void {
  const e = net.end(host, end);
  const me = net.laneAtSeam(e, { offset, flow, from: 0, to: host.length });
  for (const o of net.ends(e.node)) {
    if (o.side === e.side || Math.abs(o.port) >= LAT_EPS) continue;
    const oc = o.corridor;
    const T = taperLen(oc.cls);
    const lanes = oc.lanes.map((l) => {
      if (!net.reaches(oc, l, o.end)) return l;
      const it = net.laneAtSeam(o, l);
      if (it.forward !== me.forward || Math.abs(it.lat - me.lat) >= LAT_EPS) return l;
      if (o.end === 'a') return l.to > T + 5 ? { ...l, from: T } : l;
      return l.from < oc.length - T - 5 ? { ...l, to: oc.length - T } : l;
    });
    if (lanes.some((l, i) => l !== oc.lanes[i])) net.setLanes(oc, lanes);
  }
}

/**
 * Конец пристроенной полосы сдвигается на delta вдоль оси: полоса длиннее или короче. Дотянули до стыка,
 * за которым она продолжается, — стыкуется без отгона; до другого куска той же полосы на этом полотне
 * (внахлёст или отгоны сошлись) — сливается с ним в один. false — так не сдвинуть (короче 5 м, не сдвинули).
 */
function moveLaneEnd(net: LaneNet, c: Corridor, grab: NonNullable<LaneDraft['grab']>, delta: number): boolean {
  const l = c.lanes[grab.lane];
  if (!l || Math.abs(delta) < 1) return false;
  const T = taperLen(c.cls);
  let next: LaneSlot;
  if (grab.end === 'from') {
    let from = Math.max(0, Math.min(l.to - 5, grab.at + delta));
    if (from < T + 15 && joinAcross(net, c, { ...l, from: 0 }, 'a')) from = 0;
    next = { ...l, from };
  } else {
    let to = Math.min(c.length, Math.max(l.from + 5, grab.at + delta));
    if (to > c.length - T - 15 && joinAcross(net, c, { ...l, to: c.length }, 'b')) to = Infinity;
    next = { ...l, to };
  }
  mergeLane(net, c, next, grab.lane);
  return true;
}

/**
 * Новая полоса вдоль края: рядом с такой же (то же смещение и направление) — сливается с ней в одну (так полосу
 * продолжают); у стыка, за которым такая же полоса продолжается или кончается рядом, — доходит до стыка
 * без отгона и стыкуется с ней.
 */
function placeLane(net: LaneNet, c: Corridor, lane: LaneSlot): void {
  const T = taperLen(c.cls);
  let l = { ...lane };
  if (l.from > 0.01 && l.from < T + 15 && joinAcross(net, c, l, 'a')) l = { ...l, from: 0 };
  if (l.to < c.length - 0.01 && l.to > c.length - T - 15 && joinAcross(net, c, l, 'b')) l = { ...l, to: Infinity };
  mergeLane(net, c, l);
}

/**
 * Полоса на полотно; рядом с такой же (то же смещение и направление, внахлёст или впритык) — одна, подлиннее.
 * Дотянулась до нескольких кусков той же полосы (между ними был разрыв) — все они сливаются в один.
 * skip — номер этой же полосы на полотне (её конец сдвинули): она встаёт на своё место уже как l.
 */
function mergeLane(net: LaneNet, c: Corridor, l: LaneSlot, skip = -1): void {
  const T = taperLen(c.cls);
  let span = { from: l.from, to: l.to };
  const joined: number[] = [];
  for (let grew = true; grew; ) {
    grew = false;
    c.lanes.forEach((o, i) => {
      if (i === skip || joined.includes(i) || Math.abs(o.offset - l.offset) >= 0.5 || o.flow !== l.flow) return;
      if (o.from > span.to + 2 * T || span.from > o.to + 2 * T) return;
      span = { from: Math.min(span.from, o.from), to: Math.max(span.to, o.to) };
      joined.push(i);
      grew = true;
    });
  }
  // Слитая полоса — на месте первого куска (номера прочих полос зря не сдвигаются).
  const keep = skip >= 0 ? skip : joined.length ? Math.min(...joined) : -1;
  const lane = { ...(keep >= 0 && keep !== skip ? c.lanes[keep] : l), ...span };
  const lanes = c.lanes.flatMap((o, i) => (i === keep ? [lane] : joined.includes(i) ? [] : [o]));
  net.setLanes(c, keep >= 0 ? lanes : [...lanes, lane]);
}

/**
 * Есть ли за стыком на конце end полосы l такая же полоса (поперёк там же, едет туда же). Если та кончается
 * отгоном у самого стыка — дотягивает её до стыка. true — полосе l есть с чем состыковаться.
 */
function joinAcross(net: LaneNet, c: Corridor, l: LaneSlot, end: End): boolean {
  const e = net.end(c, end);
  if (e.node.kind !== 'seam' || net.isDeadEnd(e.node)) return false;
  const mine = net.laneAtSeam(e, l);
  for (const o of net.ends(e.node)) {
    if (o.side === e.side) continue;
    const oc = o.corridor;
    const k = oc.lanes.findIndex((ol) => {
      const it = net.laneAtSeam(o, ol);
      return it.forward === mine.forward && Math.abs(it.lat - mine.lat) < LAT_EPS;
    });
    if (k < 0) continue;
    const ol = oc.lanes[k];
    if (!net.reaches(oc, ol, o.end)) {
      const gap = o.end === 'a' ? ol.from : oc.length - ol.to;
      if (gap > taperLen(oc.cls) + 15) continue;
      net.setLanes(oc, oc.lanes.map((x, j) => (j !== k ? x : o.end === 'a' ? { ...x, from: 0 } : { ...x, to: Infinity })));
    }
    return true;
  }
  return false;
}

// ---------- Полоса по точкам (как путь) ----------

/** Полоса торможения перед съездом, если её ещё нет. */
const DECEL = 60;
/** Насколько близко к полосе у конца дороги надо кликнуть, чтобы начать с неё (м). */
const PORT_PICK = 3;
/** Полоса разгона после въезда (дальше её тянут следующими точками). */
const ACCEL = 80;

/**
 * Конец полосы, которую ведут по точкам (как конец пути): на краю дороги или на её полосе — дальше полоса идёт
 * вдоль (offset — место поперёк, flow — куда едут; нет — по ходу первой точки), либо в узле или в поле — дальше
 * однополосная дорога, съезд на неё или въезд на дорогу.
 */
export type LaneTip =
  | { kind: 'edge'; corridor: number; offset: number; s: number; flow?: Flow }
  | { kind: 'point'; anchor: Anchor }
  /** Полоса у конца дороги (тупик или стык, где дорога не продолжается): место поперёк port, едут ли наружу. */
  | { kind: 'port'; node: number; port: number; out: boolean };

/** Полоса у конца дороги, с которой можно начать однополосную — как путь от конца пути. */
export interface LanePort {
  node: number;
  port: number;
  out: boolean;
  pos: Vec;
}

/**
 * Полосы у концов дорог рядом с p (тупики и стыки, где дорога с одной стороны не продолжается): каждая — отдельно,
 * как концы путей. Полоса, которая уже ушла в ответвление, не в счёт; сошедшая на нет отгоном у самого конца — в счёт
 * (с неё начнут вторую однополосную).
 */
export function lanePortsNear(net: LaneNet, p: Vec, radius: number): LanePort[] {
  const res: LanePort[] = [];
  for (const n of net.nodesNear(p, radius)) {
    const side = openSeamSide(net, n);
    if (side === null) continue;
    const ends = net.ends(n);
    const taken = ends.filter((e) => e.side === side).map((e) => e.port);
    for (const e of ends) {
      if (e.side === side) continue;
      const c = e.corridor;
      const T = taperLen(c.cls) + 1;
      c.lanes.forEach((l, i) => {
        const near = e.end === 'a' ? l.from <= T : l.to >= c.length - T;
        if (!near || (net.reaches(c, l, e.end) && net.across(c, i, e.end))) return;
        const at = net.laneAtSeam(e, l);
        if (taken.some((t) => Math.abs(t - at.lat) < LAT_EPS)) return;
        res.push({ node: n.id, port: at.lat, out: at.forward === side > 0, pos: net.portPos(n, at.lat) });
      });
    }
  }
  return res;
}

/** Однополосная из полосы у конца дороги (как путь от конца пути): дугой по ходу дороги наружу, к q. */
function fromPort(net: LaneNet, tip: Extract<LaneTip, { kind: 'port' }>, q: Vec, cls: RoadClass, radius: number): LaneTip {
  const n = net.nodes.get(tip.node);
  const side = n ? openSeamSide(net, n) : null;
  if (!n || side === null) throw new EditError('Так не построить');
  // Полоса, сошедшая на нет у самого конца, снова доходит до него.
  for (const e of net.ends(n)) {
    if (e.side === side) continue;
    const c = e.corridor;
    const lanes = c.lanes.map((l) => (Math.abs(net.laneAtSeam(e, l).lat - tip.port) < LAT_EPS ? (e.end === 'a' ? { ...l, from: 0 } : { ...l, to: Infinity }) : l));
    if (lanes.some((l, i) => l !== c.lanes[i])) net.setLanes(c, lanes);
  }
  const t0 = scale(n.dir, side);
  const p0 = net.portPos(n, tip.port);
  const other = anchorAt(net, q, radius);
  const lanes = [slot(0, tip.out ? 1 : -1)];
  const arcTo = other.kind === 'free' ? arcCubic(p0, t0, other.pos) : null;
  const end = resolveBranchEnd(net, other, arcTo ? sub(arcTo.p3, arcTo.p2) : sub(other.pos, p0), false, lanes);
  const p3 = end.node.pos;
  const h = dist(p0, p3) / 3;
  const arc = arcTo ?? (end.side ? null : arcCubic(p0, t0, p3));
  const t3 = end.side ? scale(end.node.dir, -end.side) : norm(sub(p3, add(p0, scale(t0, h))));
  const curve = arc ?? { p0, p1: add(p0, scale(t0, h)), p2: sub(p3, scale(t3, h)), p3 };
  net.addCorridor(n.id, end.node.id, { cls, lanes, portA: tip.port, sideA: side, curve: { ...curve, p0, p3 } });
  // Остальные полосы у этого конца теперь никуда не ведут — сходят на нет отгоном.
  taperDeadLanes(net, [n.id]);
  return { kind: 'point', anchor: { kind: 'node', node: end.node.id, pos: end.node.pos } };
}

/** Крайняя ли полоса полотна (снаружи на её отрезке других нет). */
function isEdgeLane(c: Corridor, l: LaneSlot): boolean {
  return c.lanes.every((o) => o === l || o.to <= l.from || o.from >= l.to || (l.offset > 0 ? o.offset < l.offset : o.offset > l.offset));
}

/**
 * Куда поедут по новой полосе offset, пристроенной к полотну c в s: как по соседней полосе с этой стороны
 * (у края двусторонней — попутно, у односторонней — как вся дорога); полос нет — по правостороннему движению.
 * reverse — наоборот, встречная.
 */
export function newLaneFlow(c: Corridor, offset: number, s: number, reverse = false): Flow {
  const T = taperLen(c.cls);
  const score = (l: LaneSlot) => Math.abs(l.offset - offset) + (s >= l.from - T && s <= l.to + T ? 0 : 1000);
  const near = c.lanes.reduce<LaneSlot | null>((best, l) => (!best || score(l) < score(best) ? l : best), null);
  const flow: Flow = near ? near.flow : offset >= 0 ? 1 : -1;
  return reverse ? (-flow as Flow) : flow;
}

/** С чего начинается полоса у точки p: конец или середина пристроенной полосы, край дороги, узел или поле. */
export function laneTipAt(net: LaneNet, p: Vec, radius: number): LaneTip {
  // У самого конца дороги — её полоса: дальше однополосная из неё, как путь от конца пути.
  const port = lanePortsNear(net, p, 30)
    .map((x) => ({ x, d: dist(x.pos, p) }))
    .filter((o) => o.d < PORT_PICK)
    .sort((u, v) => u.d - v.d)[0]?.x;
  if (port) return { kind: 'port', node: port.node, port: port.port, out: port.out };
  const end = laneEndAt(net, p);
  if (end) {
    const l = end.corridor.lanes[end.lane];
    return { kind: 'edge', corridor: end.corridor.id, offset: l.offset, flow: l.flow, s: end.end === 'from' ? l.from : Math.min(l.to, end.corridor.length) };
  }
  const on = laneUnder(net, p);
  const l = on?.corridor.lanes[on.lane];
  if (on && l && Math.abs(l.offset) > 0.01 && isEdgeLane(on.corridor, l)) return { kind: 'edge', corridor: on.corridor.id, offset: l.offset, flow: l.flow, s: on.s };
  const e = edgeAt(net, p);
  if (e) return { kind: 'edge', corridor: e.corridor, offset: e.offset, s: e.s };
  return { kind: 'point', anchor: anchorAt(net, p, radius) };
}

/** Где на карте конец полосы. */
export function laneTipPos(net: LaneNet, tip: LaneTip): Vec | null {
  if (tip.kind === 'point') return tip.anchor.pos;
  if (tip.kind === 'port') {
    const n = net.nodes.get(tip.node);
    return n ? net.portPos(n, tip.port) : null;
  }
  const c = net.corridors.get(tip.corridor);
  return c ? pointOff(c, Math.max(0, Math.min(c.length, tip.s)), tip.offset) : null;
}

/**
 * Следующий кусок полосы от конца tip к точке q (как следующий участок пути):
 * - q у линии этой же полосы — полоса вдоль дороги (через стыки — дальше по продолжению дороги);
 * - q в стороне — съезд отсюда (если полосы сюда ещё нет — с полосой торможения);
 * - конец в узле или в поле, q у края дороги — въезд с полосой разгона; иначе — однополосная дорога.
 * Возвращает новый конец и что построено (для подписи). Нельзя — EditError.
 * Новая полоса у края едет по ходу движения с этой стороны дороги, куда бы её ни тянули (newLaneFlow);
 * reverse — встречная. У однополосной reverse — навстречу ходу постройки.
 */
export function laneStep(net: LaneNet, tip: LaneTip, q: Vec, cls: RoadClass, radius: number, reverse = false): { tip: LaneTip; what: string } {
  if (tip.kind === 'edge') {
    const c = net.corridor(tip.corridor);
    const t = tip.flow ? tip : { ...tip, flow: newLaneFlow(c, tip.offset, tip.s, reverse) };
    if (laneAlong(net, t, q)) return { tip: alongLane(net, c, t, q), what: 'Полоса' };
    return { tip: exitFrom(net, c, t, q, cls, radius), what: 'Съезд' };
  }
  if (tip.kind === 'port') return { tip: fromPort(net, tip, q, cls, radius), what: 'Однополосная' };
  const e = edgeAt(net, q);
  if (e) return { tip: entryTo(net, tip, e, cls), what: 'Въезд' };
  const to = anchorAt(net, q, radius);
  const built = buildRoad(net, tip.anchor, to, { cls, lanes: [slot(0, reverse ? -1 : 1)], arc: true });
  if (!built.length) throw new EditError('Так не построить');
  return { tip: { kind: 'point', anchor: nodeNear(net, built, to.pos) }, what: 'Однополосная' };
}

/** q — у линии полосы от конца tip (и дальше, за стыками — по продолжению дороги), а не в стороне от неё. */
export function laneAlong(net: LaneNet, tip: Extract<LaneTip, { kind: 'edge' }>, q: Vec): boolean {
  let c = net.corridors.get(tip.corridor);
  let offset = tip.offset;
  for (let guard = 0; c && guard < 12; guard++) {
    const hit = c.lut.closest(q);
    const end: End | null = hit.s >= c.length - 0.5 ? 'b' : hit.s <= 0.5 ? 'a' : null;
    const next = end ? continuation(net, c, end, q) : null;
    if (!end || !next) return Math.abs(dot(sub(q, hit.point), rightNormal(c.lut.tangentAt(hit.s))) - offset) < DEPART_LAT;
    const me = net.laneAtSeam(net.end(c, end), { offset, flow: 1, from: 0, to: c.length });
    c = next.corridor;
    offset = (me.lat - next.port) * next.along;
  }
  return false;
}

/** Узел построенного у точки p (конец съезда или дороги) — якорем для следующего куска. */
function nodeNear(net: LaneNet, built: Corridor[], p: Vec): Anchor {
  const ids = new Set(built.flatMap((c) => [c.a, c.b]));
  const n = [...ids].map((id) => net.node(id)).sort((x, y) => dist(x.pos, p) - dist(y.pos, p))[0];
  return { kind: 'node', node: n.id, pos: n.pos };
}

/**
 * Полоса вдоль дороги от конца tip к проекции q; за конец полотна — через стык в продолжающее дорогу полотно
 * (место поперёк то же). Направление — tip.flow или по ходу к q (reverse — навстречу). Возвращает новый конец.
 */
function alongLane(net: LaneNet, c0: Corridor, tip: Extract<LaneTip, { kind: 'edge' }>, q: Vec): Extract<LaneTip, { kind: 'edge' }> {
  let c = c0;
  let offset = tip.offset;
  let s0 = tip.s;
  let flow: Flow = tip.flow ?? newLaneFlow(c0, tip.offset, tip.s);
  for (let guard = 0; guard < 12; guard++) {
    const s1 = c.lut.closest(q).s;
    const dir = Math.sign(s1 - s0) || 1;
    const f = flow;
    const end: End = dir > 0 ? 'b' : 'a';
    // Дальше конца полотна — в продолжение дороги за стыком, если q ближе к нему.
    const next = s1 >= c.length - 0.5 || s1 <= 0.5 ? continuation(net, c, end, q) : null;
    if (!next) {
      const lo = Math.min(s0, s1);
      const hi = Math.max(s0, s1);
      if (hi - lo < 5) throw new EditError('Протяните вдоль дороги подальше');
      placeLane(net, c, { offset, flow: f, from: lo, to: hi });
      return { kind: 'edge', corridor: c.id, offset, s: s1, flow: f };
    }
    // До стыка — на полную ширину, за ним — с начала полотна-продолжения.
    placeLane(net, c, dir > 0 ? { offset, flow: f, from: s0, to: Infinity } : { offset, flow: f, from: 0, to: s0 });
    const me = net.laneAtSeam(net.end(c, end), { offset, flow: f, from: 0, to: c.length });
    c = next.corridor;
    offset = (me.lat - next.port) * next.along;
    flow = ((me.forward ? 1 : -1) * next.along) as Flow;
    s0 = next.end === 'a' ? 0 : c.length;
  }
  throw new EditError('Слишком далеко');
}

/** Продолжение дороги за стыком на конце end полотна c (то, что ближе к q); нет стыка или продолжения — null. */
function continuation(net: LaneNet, c: Corridor, end: End, q: Vec): CorridorEnd | null {
  const e = net.end(c, end);
  if (e.node.kind !== 'seam' || net.isDeadEnd(e.node)) return null;
  const others = net.ends(e.node).filter((o) => o.side !== e.side && Math.abs(o.port) < LAT_EPS);
  const best = others.sort((x, y) => x.corridor.lut.closest(q).d - y.corridor.lut.closest(q).d)[0];
  // q ближе к своему полотну, чем к продолжению, — не переходим.
  return best && best.corridor.lut.closest(q).d < c.lut.closest(q).d ? best : null;
}

/** Съезд от конца tip к q (по ходу полосы); полосы до этого места нет — с полосой торможения. Новый конец — у q. */
function exitFrom(net: LaneNet, c0: Corridor, tip: Extract<LaneTip, { kind: 'edge' }>, q: Vec, cls: RoadClass, radius: number): LaneTip {
  const t = c0.lut.tangentAt(tip.s);
  const fwd: Flow = dot(sub(q, c0.lut.pointAt(tip.s)), t) >= 0 ? 1 : -1;
  if (fwd !== (tip.flow ?? fwd)) throw new EditError('Съезд уходит только по ходу движения полосы');
  // Сразу за стыком — съезд из этого стыка, полоса торможения — перед ним (как у другого ответвления там же).
  const at = nearSeam(net, c0, tip.s, tip.offset, fwd, -1) ?? { c: c0, s: tip.s, offset: tip.offset, flow: fwd };
  const { c, offset, flow } = at;
  const has = c.lanes.some((l) => Math.abs(l.offset - offset) < 0.5 && l.flow === flow && l.from <= at.s + 1 && l.to >= at.s - 1);
  const s0 = Math.max(0, Math.min(c.length, at.s - flow * (has ? 1 : DECEL)));
  const depart = anchorAt(net, q, radius);
  const pos = pointOff(c, s0, offset);
  const draft: LaneDraft = {
    start: { kind: 'free', pos },
    host: { corridor: c.id, side: offset > 0 ? 1 : -1, offset, s0, s1: at.s },
    merge: false,
    depart,
    end: depart,
  };
  if (!applyLane(net, draft, cls)) throw new EditError('Так не построить');
  const n = net.nodesNear(depart.pos, radius + 6).sort((x, y) => dist(x.pos, depart.pos) - dist(y.pos, depart.pos))[0];
  if (!n) throw new EditError('Так не построить');
  return { kind: 'point', anchor: { kind: 'node', node: n.id, pos: n.pos } };
}

/** Въезд от конца tip (узел или поле) на край дороги e: стык, дальше — полоса разгона. Новый конец — её конец. */
function entryTo(net: LaneNet, tip: Extract<LaneTip, { kind: 'point' }>, e: EdgeHit, cls: RoadClass): LaneTip {
  const c0 = net.corridor(e.corridor);
  // Едут туда, куда смотрели, подъезжая: по оси — в сторону от точки, откуда пришли.
  const f0: Flow = dot(sub(e.pos, tip.anchor.pos), c0.lut.tangentAt(e.s)) >= 0 ? 1 : -1;
  // Перед самым стыком — въезд в этот стык, полоса разгона — за ним (как у другого ответвления там же).
  const { c, s, offset, flow: f } = nearSeam(net, c0, e.s, e.offset, f0, 1) ?? { c: c0, s: e.s, offset: e.offset, flow: f0 };
  const s1 = Math.max(0, Math.min(c.length, s + f * ACCEL));
  if (Math.abs(s1 - s) < 20) throw new EditError('Мало места для полосы разгона');
  const draft: LaneDraft = {
    start: tip.anchor,
    host: { corridor: c.id, side: offset > 0 ? 1 : -1, offset, s0: s, s1 },
    merge: true,
    depart: null,
    end: tip.anchor,
  };
  if (!applyLane(net, draft, cls)) throw new EditError('Так не построить');
  // Конец полосы разгона — там, где её можно тянуть дальше.
  const at = add(c.lut.pointAt(s1), scale(rightNormal(c.lut.tangentAt(s1)), offset));
  const back = laneTipAt(net, at, 4);
  return back.kind === 'edge' ? back : { kind: 'point', anchor: anchorAt(net, at, 4) };
}

/**
 * Место s на полосе (offset, flow) у самого стыка со стороны ahead (1 — по ходу движения, −1 — позади):
 * то же место по ту сторону стыка, на продолжении дороги. Стыка рядом нет — null.
 */
function nearSeam(net: LaneNet, c: Corridor, s: number, offset: number, flow: Flow, ahead: 1 | -1): { c: Corridor; s: number; offset: number; flow: Flow } | null {
  const end: End = flow * ahead > 0 ? 'b' : 'a';
  if ((end === 'b' ? c.length - s : s) > SEAM_SNAP) return null;
  const e = net.end(c, end);
  if (e.node.kind !== 'seam' || net.isDeadEnd(e.node)) return null;
  const next = net.ends(e.node).find((o) => o.side !== e.side && Math.abs(o.port) < LAT_EPS);
  if (!next) return null;
  const me = net.laneAtSeam(e, { offset, flow, from: 0, to: c.length });
  const nc = next.corridor;
  return { c: nc, s: next.end === 'a' ? 0 : nc.length, offset: (me.lat - next.port) * next.along, flow: ((me.forward ? 1 : -1) * next.along) as Flow };
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
 * Излом из двух дорог (перекрёсток без ответвлений, полосы одной продолжают полосы другой) — снова стык:
 * перо соседа встаёт на одну прямую с пером h, длина прежняя; настройки перекрёстка уходят. false — так
 * нельзя (не две дороги, полосы не сходятся, кольцо): узел остаётся изломом. apply = false — только проверить.
 */
export function smoothCorner(net: LaneNet, h: Handle, apply = true): boolean {
  const c = net.corridors.get(h.corridor);
  if (!c || c.a === c.b) return false;
  const n = net.node(h.end === 'a' ? c.a : c.b);
  if (n.kind !== 'junction' || (n.roundabout ?? null) !== null) return false;
  const ends = net.ends(n);
  if (ends.length !== 2 || ends.some((e) => Math.abs(e.port) >= LAT_EPS)) return false;
  const mine = ends.find((e) => e.corridor.id === c.id && e.end === h.end);
  const other = ends.find((e) => e !== mine);
  if (!mine || !other) return false;
  // Стык смотрит по перу h: эта дорога — с его стороны (+1), соседняя — с другой; полосы должны совпасть.
  const keys = (e: CorridorEnd, side: 1 | -1) => {
    const along = e.end === 'a' ? side : -side;
    return e.corridor.lanes
      .filter((l) => net.reaches(e.corridor, l, e.end))
      .map((l) => `${Math.round(l.offset * along * 2)}:${l.flow * along > 0}`)
      .sort()
      .join();
  };
  if (keys(mine, 1) !== keys(other, -1)) return false;
  if (!apply) return true;
  const { anchor, pos } = handlePoints(c, h.end);
  const d = norm(sub(pos, anchor));
  const o = handlePoints(other.corridor, other.end);
  const cv = { ...other.corridor.curve };
  const arm = add(o.anchor, scale(d, -Math.max(2, dist(o.pos, o.anchor))));
  if (other.end === 'a') cv.p1 = arm;
  else cv.p2 = arm;
  net.setCurve(other.corridor, cv);
  n.kind = 'seam';
  n.dir = d;
  for (const k of ['control', 'mainPair', 'bans', 'greens', 'phases', 'adaptive', 'lanes', 'corners'] as const) delete n[k];
  return true;
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
  // Без Shift излом из двух дорог снова становится стыком: перо соседа — на одну прямую с этим.
  else if (!kink && n.kind === 'junction') smoothCorner(net, h);
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

// ---------- Куски развязок ----------

/** Кусок шаблона развязки: откуда и куда (с высотами), профиль и форма (нет — прямая). */
export interface Piece {
  from: Vec;
  fromLevel: number;
  to: Vec;
  toLevel: number;
  o: RoadOptions;
  curve?: Cubic;
}

/** Длина полосы торможения перед съездом и разгона после въезда. */
const AUX = 110;

/** Где на полотне-хозяине (магистрали) лежит точка p на высоте level; null — не на нём или у самого узла. */
function hostAt(net: LaneNet, p: Vec, level: number, isHost: (c: Corridor) => boolean): { c: Corridor; s: number } | null {
  let best: { c: Corridor; s: number } | null = null;
  let bestD = 2;
  for (const c of net.corridorsNear(p, 10)) {
    if (!isHost(c)) continue;
    const hit = c.lut.closest(p);
    if (hit.d >= bestD || hit.s < 15 || c.length - hit.s < 15) continue;
    if (Math.abs(net.heightAt(c, hit.s) - level) >= 0.5) continue;
    best = { c, s: hit.s };
    bestD = hit.d;
  }
  return best;
}

/** Где встаёт вспомогательная полоса направления flow: сразу за крайней сквозной полосой справа по ходу. */
function auxOffset(c: Corridor, flow: Flow): number {
  const through = c.lanes.filter((l) => l.flow === flow && l.from <= 0.01 && l.to >= c.length - 0.01);
  if (!through.length) throw new EditError('Съезд против движения');
  return flow > 0 ? Math.max(...through.map((l) => l.offset)) + LANE_W : Math.min(...through.map((l) => l.offset)) - LANE_W;
}

/** Вспомогательная полоса; рядом с такой же — сливается с ней (полоса переплетения между въездом и съездом). */
function addAux(net: LaneNet, c: Corridor, lane: LaneSlot): void {
  const lanes = [...c.lanes];
  const i = lanes.findIndex((l) => Math.abs(l.offset - lane.offset) < 0.5 && l.flow === lane.flow && l.from <= lane.to + 40 && lane.from <= l.to + 40);
  if (i >= 0) lanes[i] = { ...lanes[i], from: Math.min(lanes[i].from, lane.from), to: Math.max(lanes[i].to, lane.to) };
  else lanes.push(lane);
  net.setLanes(c, lanes);
}

/** Стык магистрали в точке p (там уже крепится другой съезд) — к нему же крепимся и мы. */
function hostSeamAt(net: LaneNet, p: Vec, level: number, isHost: (c: Corridor) => boolean): LaneNode | null {
  for (const n of net.nodesNear(p, 2)) {
    if (n.kind !== 'seam' || Math.abs(n.level - level) >= 0.5 || dist(n.pos, p) >= 2) continue;
    if (net.ends(n).some((e) => !e.port && isHost(e.corridor))) return n;
  }
  return null;
}

/**
 * Съезд с полотна (out) или въезд на него в стыке seam по ходу flow: перед съездом — полоса торможения,
 * после въезда — разгона; ответвление крепится к стыку боковым портом этой полосы.
 */
function attachAtSeam(net: LaneNet, seam: LaneNode, flow: Flow, out: boolean, isHost: (c: Corridor) => boolean): { node: LaneNode; port: number } {
  // До стыка по ходу движения — полотно, чьё тело позади (side = −flow), после — впереди.
  const hostEnds = net.ends(seam).filter((e) => !e.port && isHost(e.corridor));
  const before = hostEnds.find((e) => e.side === -flow);
  const after = hostEnds.find((e) => e.side === flow);
  const mine = out ? before : after;
  if (!mine) throw new EditError('Съезд не на магистрали');
  const piece = mine.corridor;
  const offset = auxOffset(piece, flow);
  // Полоса примыкает к стыку на полную ширину, другим концом — отгоном.
  const L = piece.length;
  addAux(net, piece, mine.end === 'b' ? { offset, flow, from: Math.max(1, L - AUX), to: Infinity } : { offset, flow, from: 0, to: Math.min(L - 1, AUX) });
  // По ту сторону стыка полоса не продолжается: съезд уводит её, въезд её начинает.
  const other = out ? after : before;
  if (other) {
    const c = other.corridor;
    const touches = (l: LaneSlot) => (other.end === 'b' ? l.to >= c.length - 0.01 : l.from <= 0.01);
    const drop = (l: LaneSlot) => Math.abs(l.offset - offset) < 0.5 && l.flow === flow && touches(l);
    if (c.lanes.some(drop)) net.setLanes(c, c.lanes.filter((l) => !drop(l)));
  }
  return { node: seam, port: offset };
}

/**
 * Кусок развязки. Конец односторонней ветки на магистрали (isHost) — съезд или въезд по полосе;
 * на другой дороге — перекрёсток; у тупика того же профиля — продолжение; иначе — новый тупик.
 * Форма — заданная, касательные у стыков — по стыку.
 */
export function buildPiece(net: LaneNet, piece: Piece, isHost: (c: Corridor) => boolean): void {
  const curve = piece.curve ?? straightCubic(piece.from, piece.to);
  const ramp = piece.o.lanes.every((l) => l.flow > 0);
  const t0 = norm(sub(curve.p1, curve.p0));
  const t3 = norm(sub(curve.p3, curve.p2));
  const end = (p: Vec, level: number, dir: Vec, start: boolean): { node: LaneNode; port: number; tangent: Vec } => {
    // На магистрали: в её стыке (там уже крепится другой съезд) или посреди полотна — новым стыком.
    let seam = ramp ? hostSeamAt(net, p, level, isHost) : null;
    if (!seam && ramp) {
      const host = hostAt(net, p, level, isHost);
      if (host) seam = splitCorridor(net, host.c, host.s, 'seam').node;
    }
    if (seam) {
      const flow: Flow = dot(dir, seam.dir) >= 0 ? 1 : -1;
      const a = attachAtSeam(net, seam, flow, start, isHost);
      return { ...a, tangent: scale(seam.dir, flow) };
    }
    const anchor = anchorAt(net, p, 6, level);
    const r = resolveEnd(net, anchor.kind === 'free' ? { ...anchor, level } : anchor, dir, start, piece.o.lanes);
    const tangent = r.side ? scale(r.node.dir, start ? r.side : -r.side) : dir;
    return { node: r.node, port: 0, tangent };
  };
  const a = end(piece.from, piece.fromLevel, t0, true);
  const b = end(piece.to, piece.toLevel, t3, false);
  if (a.node.id === b.node.id) throw new EditError('Так не построить');
  const p0 = net.portPos(a.node, a.port);
  const p3 = net.portPos(b.node, b.port);
  const h0 = piece.curve ? dist(curve.p0, curve.p1) : dist(p0, p3) / 3;
  const h3 = piece.curve ? dist(curve.p3, curve.p2) : dist(p0, p3) / 3;
  net.addCorridor(a.node.id, b.node.id, {
    cls: piece.o.cls,
    lanes: piece.o.lanes,
    limit: piece.o.limit,
    portA: a.port,
    portB: b.port,
    curve: { p0, p1: add(p0, scale(a.tangent, h0)), p2: sub(p3, scale(b.tangent, h3)), p3 },
  });
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
  return bulldozeInside(net, (p) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1, x0, y0, x1, y1);
}

/** Снос того, что внутри области inside (она — в рамке x0…y1); как bulldozeBox. */
export function bulldozeInside(net: LaneNet, inside: (p: Vec) => boolean, x0: number, y0: number, x1: number, y1: number): number {
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

/**
 * Снос пристроенной полосы i полотна c по участкам, как пути (только крайней — посередине дороги дыры не будет):
 * убирается её кусок на этом полотне, однополосная дорога — целиком. Съезд или въезд, который ответвляется прямо
 * от этого куска, без него ни к чему — сносится тоже. Куски полосы за стыками остаются и сходят на нет отгоном.
 * Возвращает, сколько полос и полотен убрано.
 */
export function removeEdgeLane(net: LaneNet, c0: Corridor, i0: number): number {
  const lane0 = c0.lanes[i0];
  if (!lane0) throw new EditError('Нет полосы');
  if (c0.lanes.length > 1 && !isEdgeLane(c0, lane0)) throw new EditError('Снести можно только крайнюю полосу');
  const nodes = new Set([c0.a, c0.b]);
  const razed = new Set<number>();
  const single = c0.lanes.length === 1;
  if (single) razed.add(c0.id);
  else {
    for (const end of ['a', 'b'] as const) {
      const x = net.across(c0, i0, end);
      // Ответвление (стык сбоку от оси), а не продолжение той же дороги.
      if (x && x.corridor.lanes.length === 1 && Math.abs(net.end(x.corridor, x.end).port) >= LAT_EPS) razed.add(x.corridor.id);
    }
    net.setLanes(c0, c0.lanes.filter((l) => l !== lane0));
  }
  for (const id of razed) {
    const c = net.corridor(id);
    nodes.add(c.a).add(c.b);
    bulldoze(net, id);
  }
  taperDeadLanes(net, [...nodes].filter((id) => net.nodes.has(id)));
  return (single ? 0 : 1) + razed.size;
}

/** Куски короче этого при сносе куска не оставляем: снос доходит до конца полотна или полосы. */
const SPAN_MIN = 10;

/** Снос куска полотна между s0 и s1: по краям — стыки (снаружи остаются тупики), кусок между ними сносится. */
export function bulldozeSpan(net: LaneNet, c: Corridor, s0: number, s1: number): void {
  let lo = Math.min(s0, s1);
  let hi = Math.max(s0, s1);
  if (lo < SPAN_MIN) lo = 0;
  if (hi > c.length - SPAN_MIN) hi = c.length;
  if (hi - lo < SPAN_MIN) throw new EditError('Протяните вдоль дороги подальше');
  let piece = c;
  if (hi < c.length) piece = splitCorridor(net, piece, hi, 'seam').first;
  if (lo > 0) piece = splitCorridor(net, piece, lo, 'seam').second;
  bulldoze(net, piece.id);
}

/**
 * Снос куска полосы между s0 и s1 (крайней — посередине дороги дыры не будет): до и после него полоса остаётся
 * и сходит на нет отгонами. Весь кусок на полотне — как removeEdgeLane (со съездом, если он от него).
 */
export function removeLaneSpan(net: LaneNet, c: Corridor, i: number, s0: number, s1: number): void {
  const l = c.lanes[i];
  if (!l) throw new EditError('Нет полосы');
  const T = taperLen(c.cls);
  const lo = Math.min(s0, s1);
  const hi = Math.max(s0, s1);
  if (hi - lo < SPAN_MIN) throw new EditError('Протяните вдоль полосы подальше');
  const pieces: LaneSlot[] = [];
  if (lo - T - l.from > SPAN_MIN) pieces.push({ ...l, to: lo - T });
  if (Math.min(l.to, c.length) - (hi + T) > SPAN_MIN) pieces.push({ ...l, from: hi + T });
  if (!pieces.length) {
    removeEdgeLane(net, c, i);
    return;
  }
  if (c.lanes.length > 1 && !isEdgeLane(c, l)) throw new EditError('Снести можно только крайнюю полосу');
  net.setLanes(c, [...c.lanes.filter((_, k) => k !== i), ...pieces]);
  // Полоса больше не доходит до стыка — соседняя, что её продолжала, тоже сходит на нет.
  taperDeadLanes(net, [c.a, c.b]);
}

/**
 * Полосы, которые упираются в стык и не продолжаются за ним (дорогу перестроили, у соседа другой профиль), —
 * кончаются отгоном перед стыком, как на настоящей дороге при смене числа полос. Полосе, которой на отгон
 * не хватает места (полотно короче отгона), на этом полотне не быть совсем: она уходит с него, а доходила
 * до другого конца — там обрывается её продолжение и сходит на нет дальше. Единственную полосу полотна
 * не трогаем (тогда проверка правки скажет, что полосы не сходятся).
 */
export function taperDeadLanes(net: LaneNet, nodeIds: number[]): void {
  const nodes = new Set(nodeIds);
  // Сужение полосы у одного полотна может оборвать продолжавшую её полосу соседа — повторяем, пока меняется.
  for (let pass = 0; pass < 100; pass++) {
    let changed = false;
    for (const id of [...nodes]) {
      const n = net.nodes.get(id);
      if (!n || n.kind !== 'seam' || net.isDeadEnd(n)) continue;
      for (const e of net.ends(n)) {
        const c = e.corridor;
        const T = taperLen(c.cls);
        const far = e.end === 'a' ? 'b' : 'a';
        const lanes: LaneSlot[] = [];
        let cut = false;
        c.lanes.forEach((l, i) => {
          if (!net.reaches(c, l, e.end) || net.across(c, i, e.end)) {
            lanes.push(l);
            return;
          }
          cut = true;
          const tapered = e.end === 'a' ? { ...l, from: Math.max(l.from, T) } : { ...l, to: Math.min(l.to, c.length - T) };
          if (tapered.to - tapered.from >= 5) lanes.push(tapered);
          else if (net.reaches(c, l, far)) nodes.add(far === 'a' ? c.a : c.b);
        });
        if (!cut || !lanes.length) continue;
        net.setLanes(c, lanes);
        changed = true;
      }
    }
    if (!changed) return;
  }
}

/** Сплошная или пунктир между полосой и её соседом справа (по оси полотна — с бо́льшим смещением). */
export function toggleSolid(net: LaneNet, c: Corridor, i: number): void {
  net.setLanes(
    c,
    c.lanes.map((l, k) => (k === i ? { ...l, solid: !l.solid } : l)),
  );
}

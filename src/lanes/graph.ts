import { CAR_WIDTH } from '../config';
import { add, angleDiff, angleOf, cubicBezier, dist, dot, scale, segSegDist, sub, Vec } from '../core/vec';
import type { Vehicle } from '../sim/vehicle';
import { assignLanes, type ConflictKind } from '../world/network';
import { KMH_PER_UNIT, ROAD_CLASSES } from '../world/roadTypes';
import { junctionCuts, pointOff } from './geometry';
import { Corridor, End, Flow, LaneNet, LaneNode } from './model';

/**
 * Связь — отрезок полотна, на котором набор полос одного направления не меняется.
 * Полотно режется на связи там, где полоса начинается или кончается, и у перекрёстков.
 */
export interface GLink {
  id: number;
  corridor: number;
  flow: Flow;
  /** Отрезок оси полотна. */
  s0: number;
  s1: number;
  length: number;
  speed: number;
  /** Узел, из которого связь выходит / в который входит; null — граница внутри полотна. */
  fromNode: number | null;
  toNode: number | null;
  /** Полосы слева направо по ходу движения. */
  lanes: GLane[];
}

export interface GLane {
  id: number;
  link: number;
  /** Номер слева направо по ходу движения. */
  index: number;
  /** Полоса полотна. */
  laneIdx: number;
  /** Смещение от оси полотна вправо по a→b. */
  offset: number;
  /** Смещение вправо по ходу движения. */
  side: number;
  length: number;
  speed: number;
  /** От головной машины к хвосту. */
  vehicles: Vehicle[];
}

/**
 * Переход с полосы на полосу. Продолжение той же полосы (граница связей внутри полотна или стык) —
 * без длины и без очереди; манёвр в перекрёстке или развороте в тупике — по кривой, с конфликтами.
 */
export interface GMove {
  key: string;
  /** Узел манёвра; у продолжения — null. */
  node: number | null;
  cont: boolean;
  inLane: number;
  outLane: number;
  inLink: number;
  outLink: number;
  points: Vec[];
  cum: number[];
  length: number;
  speed: number;
  dirIn: Vec;
  dirOut: Vec;
  conflicts: Map<string, ConflictKind>;
  /** Для пересечений: где на этом манёвре зона, общая с другим, [начало, конец] по длине. */
  zones: Map<string, [number, number]>;
  vehicles: Vehicle[];
}

/** Перекрёсток или тупик во время движения: кто проезжает, кто ждёт, кто главный. */
export interface GNode {
  id: number;
  pos: Vec;
  priorityLanes: Set<number>;
  reserved: Vehicle[];
  waiting: Vehicle[];
}

export const laneSpeed = (c: Corridor) => ROAD_CLASSES[c.cls].limit / KMH_PER_UNIT;
export const moveKey = (inLane: number, outLane: number) => `${inLane}>${outLane}`;

/** Граф движения по сети полос: связи, полосы, переходы, состояние перекрёстков. */
export class LaneGraph {
  readonly links = new Map<number, GLink>();
  readonly lanes = new Map<number, GLane>();
  readonly moves = new Map<string, GMove>();
  readonly movesFrom = new Map<number, GMove[]>();
  readonly movesInto = new Map<number, GMove[]>();
  readonly linkNext = new Map<number, Set<number>>();
  readonly linkPrev = new Map<number, Set<number>>();
  /** Переходы между парой связей, ключ `${из}>${в}`. */
  readonly transitions = new Map<string, GMove[]>();
  readonly outLinks = new Map<number, GLink[]>();
  readonly inLinks = new Map<number, GLink[]>();
  readonly nodes = new Map<number, GNode>();
  /** Связи каждого полотна по ходу оси. */
  private readonly byCorridor = new Map<number, { flow: Flow; links: GLink[] }[]>();
  private nextId = 1;

  constructor(readonly net: LaneNet) {
    const cuts = junctionCuts(net);
    for (const c of net.corridors.values()) this.buildCorridor(c, ...cuts.get(c.id)!);
    for (const c of net.corridors.values()) this.linkSeams(c);
    for (const n of net.nodes.values()) {
      if (n.kind === 'junction') this.buildJunction(n);
      else if (net.isDeadEnd(n)) this.buildDeadEnd(n);
    }
    this.buildIndexes();
  }

  /** Положение на полосе: u — пройдено от начала полосы по ходу движения. */
  lanePose(lane: GLane, u: number): { pos: Vec; dir: Vec } {
    const link = this.links.get(lane.link)!;
    const c = this.net.corridor(link.corridor);
    const s = link.flow > 0 ? link.s0 + u : link.s1 - u;
    return { pos: pointOff(c, s, lane.offset), dir: scale(c.lut.tangentAt(s), link.flow) };
  }

  /** s на оси полотна для положения u на полосе. */
  axisS(lane: GLane, u: number): number {
    const link = this.links.get(lane.link)!;
    return link.flow > 0 ? link.s0 + u : link.s1 - u;
  }

  /** Полоса связи по полосе полотна. */
  laneOf(link: GLink, laneIdx: number): GLane | undefined {
    return link.lanes.find((l) => l.laneIdx === laneIdx);
  }

  static pointOnMove(m: GMove, s: number): { pos: Vec; dir: Vec } {
    const pts = m.points;
    const target = Math.max(0, Math.min(m.cum[m.cum.length - 1], s));
    let i = 1;
    while (i < pts.length - 1 && m.cum[i] < target) i++;
    const segLen = m.cum[i] - m.cum[i - 1];
    const t = segLen > 1e-6 ? (target - m.cum[i - 1]) / segLen : 0;
    const a = pts[i - 1];
    const b = pts[i];
    const l = dist(a, b);
    const pos = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    return { pos, dir: l > 1e-6 ? scale(sub(b, a), 1 / l) : m.dirOut };
  }

  // ---------- Построение ----------

  /** Режет полотно на связи по местам, где полосы начинаются и кончаются. */
  private buildCorridor(c: Corridor, cutA: number, cutB: number): void {
    const s0 = cutA;
    const s1 = c.length - cutB;
    const marks = [s0, s1];
    for (const l of c.lanes) for (const x of [l.from, l.to]) if (x > s0 + 0.5 && x < s1 - 0.5) marks.push(x);
    marks.sort((x, y) => x - y);
    const cuts = marks.filter((x, i) => i === 0 || x - marks[i - 1] > 0.5);
    const speed = laneSpeed(c);
    const groups: { flow: Flow; links: GLink[] }[] = [];
    for (const flow of [1, -1] as const) {
      const links: GLink[] = [];
      for (let k = 0; k + 1 < cuts.length; k++) {
        const [a, b] = [cuts[k], cuts[k + 1]];
        const present = c.lanes.map((l, i) => ({ l, i })).filter(({ l }) => l.flow === flow && l.from <= a + 0.5 && l.to >= b - 0.5);
        const first = k === 0;
        const last = k + 2 === cuts.length;
        const link: GLink = {
          id: this.nextId++,
          corridor: c.id,
          flow,
          s0: a,
          s1: b,
          length: b - a,
          speed,
          fromNode: flow > 0 ? (first ? c.a : null) : last ? c.b : null,
          toNode: flow > 0 ? (last ? c.b : null) : first ? c.a : null,
          lanes: [],
        };
        // Слева направо по ходу: по a→b левее — меньшее смещение, против — большее.
        present.sort((x, y) => (x.l.offset - y.l.offset) * flow);
        link.lanes = present.map(({ l, i }, index) => ({
          id: this.nextId++,
          link: link.id,
          index,
          laneIdx: i,
          offset: l.offset,
          side: l.offset * flow,
          length: link.length,
          speed,
          vehicles: [],
        }));
        links.push(link);
      }
      // Пустые связи (нет полос этого направления) не нужны, но порядок по оси сохраняем.
      const kept = links.filter((l) => l.lanes.length);
      for (const l of kept) {
        this.links.set(l.id, l);
        for (const lane of l.lanes) this.lanes.set(lane.id, lane);
      }
      groups.push({ flow, links: kept });
      // Внутри полотна полоса продолжается в следующую связь.
      const along = flow > 0 ? kept : [...kept].reverse();
      for (let k = 0; k + 1 < along.length; k++) {
        const from = along[k];
        const to = along[k + 1];
        if (Math.abs((flow > 0 ? from.s1 : from.s0) - (flow > 0 ? to.s0 : to.s1)) > 0.6) continue;
        for (const lane of from.lanes) {
          const next = this.laneOf(to, lane.laneIdx);
          if (next) this.addCont(lane, from, next, to);
        }
      }
    }
    this.byCorridor.set(c.id, groups);
  }

  /** Связь полотна у конца end в направлении flow: первая или последняя по оси. */
  private endLink(c: Corridor, end: End, flow: Flow): GLink | undefined {
    const links = this.byCorridor.get(c.id)?.find((g) => g.flow === flow)?.links ?? [];
    const link = end === 'a' ? links[0] : links[links.length - 1];
    if (!link) return undefined;
    // Связь должна доходить до конца полотна.
    return (end === 'a' ? link.s0 < 0.6 : link.s1 > c.length - 0.6) ? link : undefined;
  }

  /** Полосы, уходящие из полотна через стык, продолжаются полосами по ту сторону. */
  private linkSeams(c: Corridor): void {
    for (const end of ['a', 'b'] as const) {
      const n = this.net.node(end === 'a' ? c.a : c.b);
      if (n.kind !== 'seam' || this.net.isDeadEnd(n)) continue;
      // Уходят через конец b полосы по ходу оси, через конец a — против.
      const flow: Flow = end === 'b' ? 1 : -1;
      const from = this.endLink(c, end, flow);
      if (!from) continue;
      for (const lane of from.lanes) {
        const it = this.net.across(c, lane.laneIdx, end);
        if (!it) continue;
        // По ту сторону полоса уходит от стыка: на конце a — по оси, на конце b — против.
        const to = this.endLink(it.corridor, it.end, it.end === 'a' ? 1 : -1);
        const next = to && this.laneOf(to, it.lane);
        if (to && next) this.addCont(lane, from, next, to);
      }
    }
  }

  private addCont(inLane: GLane, inLink: GLink, outLane: GLane, outLink: GLink): void {
    const a = this.lanePose(inLane, inLane.length);
    const b = this.lanePose(outLane, 0);
    this.addMove({
      key: moveKey(inLane.id, outLane.id),
      node: null,
      cont: true,
      inLane: inLane.id,
      outLane: outLane.id,
      inLink: inLink.id,
      outLink: outLink.id,
      points: [a.pos, b.pos],
      cum: [0, 0],
      length: 0,
      speed: Math.min(inLane.speed, outLane.speed),
      dirIn: a.dir,
      dirOut: b.dir,
      conflicts: new Map(),
      zones: new Map(),
      vehicles: [],
    });
  }

  private addMove(m: GMove): void {
    this.moves.set(m.key, m);
  }

  private nodeState(n: LaneNode): GNode {
    let g = this.nodes.get(n.id);
    if (!g) {
      g = { id: n.id, pos: n.pos, priorityLanes: new Set(), reserved: [], waiting: [] };
      this.nodes.set(n.id, g);
    }
    return g;
  }

  /** Манёвры перекрёстка: полосы въездов распределяются по выездам, как раньше; главная дорога — самая прямая и широкая. */
  private buildJunction(n: LaneNode): void {
    const state = this.nodeState(n);
    const ins = [...this.links.values()].filter((l) => l.toNode === n.id);
    const outs = [...this.links.values()].filter((l) => l.fromNode === n.id);
    const list: GMove[] = [];
    for (const inL of ins) {
      const inDir = this.lanePose(inL.lanes[0], inL.length).dir;
      const exits = outs
        .filter((o) => o.corridor !== inL.corridor)
        .map((o) => ({ link: o, theta: angleDiff(angleOf(inDir), angleOf(this.lanePose(o.lanes[0], 0).dir)) }))
        .filter((e) => Math.abs(e.theta) < 2.6)
        .sort((a, b) => b.theta - a.theta);
      if (!exits.length) continue;
      const pairs = assignLanes(
        inL.lanes.length,
        exits.map((e) => ({ count: e.link.lanes.length, theta: e.theta, uTurn: false })),
      );
      exits.forEach((e, k) => {
        for (const [fromRight, outFromRight] of pairs[k]) {
          list.push(this.turn(n.id, inL, inL.lanes[inL.lanes.length - 1 - fromRight], e.link, e.link.lanes[e.link.lanes.length - 1 - outFromRight]));
        }
      });
    }
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const kind = conflictKind(list[i], list[j]);
        if (!kind) continue;
        list[i].conflicts.set(list[j].key, kind);
        list[j].conflicts.set(list[i].key, kind);
        if (kind !== 'cross') continue;
        list[i].zones.set(list[j].key, conflictZone(list[i], list[j]));
        list[j].zones.set(list[i].key, conflictZone(list[j], list[i]));
      }
    }
    // Главная: самая прямая и вместительная пара подъездов; если главные все — приоритета нет.
    const main = this.mainPair(n);
    if (main) {
      for (const l of ins) if (main.includes(l.corridor)) for (const lane of l.lanes) state.priorityLanes.add(lane.id);
      if (ins.every((l) => main.includes(l.corridor))) state.priorityLanes.clear();
    }
  }

  private mainPair(n: LaneNode): [number, number] | null {
    const ends = this.net.ends(n);
    if (ends.length < 3) return null;
    let best: [number, number] | null = null;
    let bestScore = -Infinity;
    for (let i = 0; i < ends.length; i++) {
      for (let j = i + 1; j < ends.length; j++) {
        const deviation = Math.PI - Math.acos(Math.max(-1, Math.min(1, dot(ends[i].away, ends[j].away))));
        if (deviation > 0.6) continue;
        const cap = (c: Corridor) => c.lanes.length * laneSpeed(c);
        const score = cap(ends[i].corridor) + cap(ends[j].corridor) - deviation * 40;
        if (score > bestScore) {
          bestScore = score;
          best = [ends[i].corridor.id, ends[j].corridor.id];
        }
      }
    }
    return best;
  }

  /** Тупик: разворот с левой полосы въезда на левую полосу выезда того же полотна. */
  private buildDeadEnd(n: LaneNode): void {
    this.nodeState(n);
    const ins = [...this.links.values()].filter((l) => l.toNode === n.id);
    const outs = [...this.links.values()].filter((l) => l.fromNode === n.id);
    for (const inL of ins) {
      const out = outs.find((o) => o.corridor === inL.corridor);
      if (out) this.turn(n.id, inL, inL.lanes[0], out, out.lanes[0]);
    }
  }

  /** Манёвр по кривой от конца полосы въезда к началу полосы выезда. */
  private turn(node: number, inL: GLink, inLane: GLane, outL: GLink, outLane: GLane): GMove {
    const a = this.lanePose(inLane, inLane.length);
    const b = this.lanePose(outLane, 0);
    const chord = dist(a.pos, b.pos);
    const uTurn = dot(a.dir, b.dir) < -0.95;
    const k = uTurn ? Math.max(chord * 0.9, 7) : chord * 0.45;
    const p1 = add(a.pos, scale(a.dir, k));
    const p2 = sub(b.pos, scale(b.dir, k));
    const points: Vec[] = [];
    for (let i = 0; i <= 10; i++) points.push(cubicBezier(a.pos, p1, p2, b.pos, i / 10));
    const cum = [0];
    for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + dist(points[i - 1], points[i]));
    const length = Math.max(0.3, cum[cum.length - 1]);
    const theta = Math.abs(angleDiff(angleOf(a.dir), angleOf(b.dir)));
    let speed = Math.min(inLane.speed, outLane.speed);
    if (theta > 0.15) {
      const r = Math.max(2, chord / (2 * Math.max(0.15, Math.sin(theta / 2))));
      speed = Math.min(speed, Math.max(5, Math.sqrt(9 * r)));
    }
    const m: GMove = {
      key: moveKey(inLane.id, outLane.id),
      node,
      cont: false,
      inLane: inLane.id,
      outLane: outLane.id,
      inLink: inL.id,
      outLink: outL.id,
      points,
      cum,
      length,
      speed,
      dirIn: a.dir,
      dirOut: b.dir,
      conflicts: new Map(),
      zones: new Map(),
      vehicles: [],
    };
    this.addMove(m);
    return m;
  }

  private buildIndexes(): void {
    for (const l of this.links.values()) {
      if (l.fromNode !== null) push(this.outLinks, l.fromNode, l);
      if (l.toNode !== null) push(this.inLinks, l.toNode, l);
    }
    for (const m of this.moves.values()) {
      push(this.movesFrom, m.inLane, m);
      push(this.movesInto, m.outLane, m);
      if (!this.linkNext.has(m.inLink)) this.linkNext.set(m.inLink, new Set());
      if (!this.linkPrev.has(m.outLink)) this.linkPrev.set(m.outLink, new Set());
      this.linkNext.get(m.inLink)!.add(m.outLink);
      this.linkPrev.get(m.outLink)!.add(m.inLink);
      push(this.transitions, `${m.inLink}>${m.outLink}`, m);
    }
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function conflictKind(a: GMove, b: GMove): ConflictKind | null {
  if (a.outLane === b.outLane) return 'merge';
  if (a.inLane === b.inLane) return 'diverge';
  return polylineDistance(a.points, b.points) < CAR_WIDTH * 0.9 ? 'cross' : null;
}

/** Где на манёвре a он проходит ближе CAR_WIDTH·0.9 к манёвру b: [начало, конец] по длине a. */
function conflictZone(a: GMove, b: GMove): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  const steps = Math.max(8, Math.ceil(a.length));
  for (let i = 0; i <= steps; i++) {
    const s = (a.length * i) / steps;
    const p = LaneGraph.pointOnMove(a, s).pos;
    if (polylineDistance([p, p], b.points) < CAR_WIDTH * 0.9) {
      lo = Math.min(lo, s);
      hi = Math.max(hi, s);
    }
  }
  return lo <= hi ? [lo, hi] : [0, a.length];
}

function polylineDistance(a: Vec[], b: Vec[]): number {
  let best = Infinity;
  for (let i = 0; i < a.length - 1; i++) {
    for (let j = 0; j < b.length - 1; j++) {
      best = Math.min(best, segSegDist(a[i], a[i + 1], b[j], b[j + 1]));
      if (best === 0) return 0;
    }
  }
  return best;
}

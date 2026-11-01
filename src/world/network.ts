import { CAR_WIDTH, LIGHTS } from '../config';
import { Cubic, CurveLUT, reverseCubic, splitBezier } from '../core/bezier';
import { add, angleDiff, angleOf, cubicBezier, dist, dot, scale, segSegDist, sub, Vec } from '../core/vec';
import type { Vehicle } from '../sim/vehicle';
import { halfWidth, isDivided, isOneWay, laneOffset, MAX_LANES, RAIL_HALF, RoadSpec, specSpeed, totalLanes } from './roadTypes';

export type NodeControl = 'none' | 'lights';

export interface LightState {
  /** Фазы — списки входящих полос, которым одновременно горит зелёный. */
  phases: number[][];
  phase: number;
  timer: number;
  clearing: boolean;
}

export interface RoadNode {
  id: number;
  pos: Vec;
  /** Уровень высоты: −1 тоннель, 0 земля, 1 мост, 2 эстакада. */
  level: number;
  segments: number[];
  /** Узел-подъезд здания или станции, его нельзя удалить. */
  buildingId: number | null;
  control: NodeControl;
  lights: LightState | null;
  roundabout: number | null;
  radius: number;
  /** Входящие полосы главной дороги: остальные им уступают. */
  priorityLanes: Set<number>;
  reserved: Vehicle[];
  waiting: Vehicle[];
  /** Переезд закрыт: подходит поезд, машины ждут. */
  crossingClosed: boolean;
  /**
   * Главная дорога, выбранная игроком: пара участков; [] — равнозначный перекрёсток;
   * нет — выбирается автоматически.
   */
  mainPair?: number[] | null;
  /** Запрещённые повороты: `${участок въезда}>${участок выезда}`. */
  bans?: string[];
  /**
   * Связи полос, заданные игроком: `${участок въезда}.${полоса справа}>${участок выезда}.${полоса справа}`.
   * Полоса въезда, у которой есть хоть одна связь, едет только по своим связям (запреты поворотов
   * её не касаются); остальные полосы распределяются автоматически.
   */
  lanes?: string[];
  /** Длительность зелёного по фазам светофора, секунд. */
  greens?: number[];
  /** Светофор пропускает пустые фазы и продлевает зелёный, если никто не ждёт. По умолчанию да. */
  adaptive?: boolean;
  /**
   * Ж/д сигналы в узле: участки, на выезд к которым стоит сигнал. Сигнал односторонний —
   * его видят только поезда, едущие из узла на этот участок.
   */
  signals?: number[];
}

export interface Segment {
  id: number;
  a: number;
  b: number;
  curve: Cubic;
  lut: CurveLUT;
  length: number;
  spec: RoadSpec;
  ring: boolean;
  /** Растёт при каждом пересчёте полос сегмента — по нему рендер обновляет кэш. */
  rev: number;
  /** Путь — платформа вокзала с этим id. */
  platform?: number;
}

/** Направленная половина сегмента (все полосы одного направления). */
export interface Link {
  id: number;
  seg: number;
  dir: 0 | 1;
  from: number;
  to: number;
  /** Полосы слева направо по ходу движения. */
  lanes: Lane[];
  length: number;
  speed: number;
}

export interface Lane {
  id: number;
  link: number;
  seg: number;
  dir: 0 | 1;
  index: number;
  from: number;
  to: number;
  offset: number;
  /** Отступ от начального узла вдоль оси (радиус перекрёстка). */
  sStart: number;
  length: number;
  speed: number;
  start: Vec;
  end: Vec;
  startDir: Vec;
  endDir: Vec;
  /** Упорядочены от головной машины к хвосту. */
  vehicles: Vehicle[];
}

export type ConflictKind = 'merge' | 'cross' | 'diverge';

export interface SplitRecord {
  oldSeg: number;
  oldLength: number;
  first: number;
  second: number;
  /** Длина первой части вдоль оси. */
  at: number;
}

export interface Movement {
  key: string;
  node: number;
  inLane: number;
  outLane: number;
  inLink: number;
  outLink: number;
  points: Vec[];
  cum: number[];
  length: number;
  speed: number;
  /** Направления полос въезда и выезда — для коротких манёвров на стыках. */
  dirIn: Vec;
  dirOut: Vec;
  conflicts: Map<string, ConflictKind>;
  vehicles: Vehicle[];
}

export interface NetworkSave {
  nextNodeId: number;
  nextSegId: number;
  nodes: Pick<
    RoadNode,
    'id' | 'pos' | 'level' | 'buildingId' | 'control' | 'roundabout' | 'mainPair' | 'bans' | 'lanes' | 'greens' | 'adaptive' | 'signals'
  >[];
  segments: Pick<Segment, 'id' | 'a' | 'b' | 'curve' | 'spec' | 'ring' | 'platform'>[];
}

export const linkId = (seg: number, dir: 0 | 1) => seg * 2 + dir;
export const laneIdOf = (seg: number, dir: 0 | 1, index: number) => seg * MAX_LANES * 2 + dir * MAX_LANES + index;
export const movementKey = (inLane: number, outLane: number) => `${inLane}>${outLane}`;

/** Связь полос в узле: полоса i участка въезда ведёт на полосу j участка выезда (обе считаются справа). */
export interface LaneLink {
  inSeg: number;
  i: number;
  outSeg: number;
  j: number;
}
export const laneLinkKey = (l: LaneLink) => `${l.inSeg}.${l.i}>${l.outSeg}.${l.j}`;
export function parseLaneLink(key: string): LaneLink | null {
  const m = /^(\d+)\.(\d+)>(\d+)\.(\d+)$/.exec(key);
  return m ? { inSeg: Number(m[1]), i: Number(m[2]), outSeg: Number(m[3]), j: Number(m[4]) } : null;
}

const GRID = 160;
const cellKey = (x: number, y: number) => `${x}:${y}`;

export class Network {
  readonly nodes = new Map<number, RoadNode>();
  readonly segments = new Map<number, Segment>();
  readonly links = new Map<number, Link>();
  readonly lanes = new Map<number, Lane>();
  readonly movements = new Map<string, Movement>();
  readonly nodeMovements = new Map<number, Movement[]>();
  readonly movesFrom = new Map<number, Movement[]>();
  readonly movesInto = new Map<number, Movement[]>();
  readonly outLinks = new Map<number, Link[]>();
  readonly inLinks = new Map<number, Link[]>();
  /** Переходы между связями: linkNext[a] — куда можно попасть из a. */
  readonly linkNext = new Map<number, Set<number>>();
  readonly linkPrev = new Map<number, Set<number>>();
  /** Манёвры между парой связей, ключ `${from}>${to}`. */
  readonly transitions = new Map<string, Movement[]>();
  /** Разрезания сегментов с прошлой проверки машин: нужны, чтобы перенести машины. */
  pendingSplits: SplitRecord[] = [];
  version = 0;
  private nextNodeId = 1;
  private nextSegId = 1;
  /** Узлы, вокруг которых нужно пересчитать полосы и манёвры. */
  private readonly dirty = new Set<number>();
  private readonly removedSegs = new Set<number>();
  private readonly removedNodes = new Set<number>();
  private readonly segGrid = new Map<string, Set<number>>();
  private readonly segCells = new Map<number, string[]>();
  private readonly nodeGrid = new Map<string, Set<number>>();

  // ---------- Сохранение ----------

  serialize(): NetworkSave {
    return {
      nextNodeId: this.nextNodeId,
      nextSegId: this.nextSegId,
      nodes: [...this.nodes.values()].map((n) => ({
        id: n.id,
        pos: n.pos,
        level: n.level,
        buildingId: n.buildingId,
        control: n.control,
        roundabout: n.roundabout,
        mainPair: n.mainPair,
        bans: n.bans,
        lanes: n.lanes,
        greens: n.greens,
        adaptive: n.adaptive,
        signals: n.signals,
      })),
      segments: [...this.segments.values()].map((s) => ({
        id: s.id,
        a: s.a,
        b: s.b,
        curve: s.curve,
        spec: s.spec,
        ring: s.ring,
        platform: s.platform,
      })),
    };
  }

  /**
   * Заменяет всю сеть снимком (отмена строительства). Счётчики id не откатываются,
   * чтобы новые узлы и участки не получили номера уже удалённых.
   */
  replaceWith(data: NetworkSave): void {
    const nextNode = this.nextNodeId;
    const nextSeg = this.nextSegId;
    for (const m of [
      this.nodes,
      this.segments,
      this.links,
      this.lanes,
      this.movements,
      this.nodeMovements,
      this.movesFrom,
      this.movesInto,
      this.outLinks,
      this.inLinks,
      this.linkNext,
      this.linkPrev,
      this.transitions,
      this.segGrid,
      this.segCells,
      this.nodeGrid,
    ] as Map<unknown, unknown>[]) {
      m.clear();
    }
    this.pendingSplits = [];
    this.dirty.clear();
    this.removedSegs.clear();
    this.removedNodes.clear();
    this.load(data);
    this.nextNodeId = Math.max(nextNode, data.nextNodeId);
    this.nextSegId = Math.max(nextSeg, data.nextSegId);
  }

  /** Загружает сохранённую сеть в пустую сеть. */
  load(data: NetworkSave): void {
    for (const nd of data.nodes) {
      const node: RoadNode = {
        ...nd,
        segments: [],
        lights: null,
        radius: 0,
        priorityLanes: new Set(),
        reserved: [],
        waiting: [],
        crossingClosed: false,
      };
      this.nodes.set(node.id, node);
      this.indexNode(node, true);
      this.dirty.add(node.id);
    }
    for (const sd of data.segments) {
      const lut = new CurveLUT(sd.curve);
      const seg: Segment = { ...sd, lut, length: lut.length, rev: 0 };
      this.segments.set(seg.id, seg);
      this.node(seg.a).segments.push(seg.id);
      this.node(seg.b).segments.push(seg.id);
      this.indexSegment(seg);
    }
    this.nextNodeId = data.nextNodeId;
    this.nextSegId = data.nextSegId;
    this.rebuild();
  }

  // ---------- Пространственный индекс ----------

  private indexNode(n: RoadNode, add: boolean): void {
    const key = cellKey(Math.floor(n.pos.x / GRID), Math.floor(n.pos.y / GRID));
    if (add) {
      if (!this.nodeGrid.has(key)) this.nodeGrid.set(key, new Set());
      this.nodeGrid.get(key)!.add(n.id);
    } else {
      this.nodeGrid.get(key)?.delete(n.id);
    }
  }

  private indexSegment(s: Segment): void {
    this.unindexSegment(s.id);
    const c = s.curve;
    const pad = halfWidth(s.spec);
    const x0 = Math.floor((Math.min(c.p0.x, c.p1.x, c.p2.x, c.p3.x) - pad) / GRID);
    const x1 = Math.floor((Math.max(c.p0.x, c.p1.x, c.p2.x, c.p3.x) + pad) / GRID);
    const y0 = Math.floor((Math.min(c.p0.y, c.p1.y, c.p2.y, c.p3.y) - pad) / GRID);
    const y1 = Math.floor((Math.max(c.p0.y, c.p1.y, c.p2.y, c.p3.y) + pad) / GRID);
    const keys: string[] = [];
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const key = cellKey(x, y);
        if (!this.segGrid.has(key)) this.segGrid.set(key, new Set());
        this.segGrid.get(key)!.add(s.id);
        keys.push(key);
      }
    }
    this.segCells.set(s.id, keys);
  }

  private unindexSegment(id: number): void {
    for (const key of this.segCells.get(id) ?? []) this.segGrid.get(key)?.delete(id);
    this.segCells.delete(id);
  }

  /** Сегменты, чьи габариты задевают прямоугольник. */
  segmentsInBox(x0: number, y0: number, x1: number, y1: number): Segment[] {
    const ids = new Set<number>();
    for (let x = Math.floor(x0 / GRID); x <= Math.floor(x1 / GRID); x++) {
      for (let y = Math.floor(y0 / GRID); y <= Math.floor(y1 / GRID); y++) {
        for (const id of this.segGrid.get(cellKey(x, y)) ?? []) ids.add(id);
      }
    }
    return [...ids].map((id) => this.segments.get(id)!).filter(Boolean);
  }

  segmentsNear(p: Vec, r: number): Segment[] {
    return this.segmentsInBox(p.x - r, p.y - r, p.x + r, p.y + r);
  }

  nodesNear(p: Vec, r: number): RoadNode[] {
    const result: RoadNode[] = [];
    for (let x = Math.floor((p.x - r) / GRID); x <= Math.floor((p.x + r) / GRID); x++) {
      for (let y = Math.floor((p.y - r) / GRID); y <= Math.floor((p.y + r) / GRID); y++) {
        for (const id of this.nodeGrid.get(cellKey(x, y)) ?? []) {
          const n = this.nodes.get(id);
          if (n && dist(n.pos, p) <= r) result.push(n);
        }
      }
    }
    return result;
  }

  // ---------- Узлы и сегменты ----------

  addNode(pos: Vec, level = 0, buildingId: number | null = null): RoadNode {
    const node: RoadNode = {
      id: this.nextNodeId++,
      pos: { ...pos },
      level,
      segments: [],
      buildingId,
      control: 'none',
      lights: null,
      roundabout: null,
      radius: 0,
      priorityLanes: new Set(),
      reserved: [],
      waiting: [],
      crossingClosed: false,
    };
    this.nodes.set(node.id, node);
    this.indexNode(node, true);
    this.dirty.add(node.id);
    return node;
  }

  deleteNode(id: number): void {
    const n = this.nodes.get(id);
    if (!n) return;
    for (const sid of [...n.segments]) this.removeSegment(sid, false);
    this.indexNode(n, false);
    this.nodes.delete(id);
    this.dirty.delete(id);
    this.removedNodes.add(id);
  }

  isRailSeg(id: number): boolean {
    return this.segment(id).spec.cls === 'rail';
  }

  /** Автодорожные сегменты узла (без рельсов). */
  roadSegs(n: RoadNode): number[] {
    return n.segments.filter((id) => !this.isRailSeg(id));
  }

  railSegs(n: RoadNode): number[] {
    return n.segments.filter((id) => this.isRailSeg(id));
  }

  /** Переезд: в узле сходятся и рельсы, и дорога. */
  isCrossing(n: RoadNode): boolean {
    let road = false;
    let rail = false;
    for (const id of n.segments) {
      if (this.isRailSeg(id)) rail = true;
      else road = true;
    }
    return road && rail;
  }

  /** Помечает узел для пересчёта (например, после смены светофора). */
  touch(nodeId: number): void {
    this.dirty.add(nodeId);
  }

  node(id: number): RoadNode {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`Узел ${id} не найден`);
    return n;
  }

  segment(id: number): Segment {
    const s = this.segments.get(id);
    if (!s) throw new Error(`Сегмент ${id} не найден`);
    return s;
  }

  findNodeNear(p: Vec, radius: number, filter?: (n: RoadNode) => boolean): RoadNode | null {
    let best: RoadNode | null = null;
    let bestD = radius;
    for (const n of this.nodesNear(p, radius)) {
      if (filter && !filter(n)) continue;
      const d = dist(n.pos, p);
      if (d <= bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  }

  findSegmentNear(
    p: Vec,
    radius: number,
    filter?: (s: Segment) => boolean,
  ): { seg: Segment; s: number; t: number; point: Vec; d: number } | null {
    let best: { seg: Segment; s: number; t: number; point: Vec; d: number } | null = null;
    for (const seg of this.segmentsNear(p, radius + 30)) {
      if (filter && !filter(seg)) continue;
      const hit = seg.lut.closest(p);
      const limit = radius + halfWidth(seg.spec);
      if (hit.d <= limit && (!best || hit.d < best.d)) best = { seg, ...hit };
    }
    return best;
  }

  segmentBetween(a: number, b: number): Segment | null {
    for (const sid of this.node(a).segments) {
      const s = this.segment(sid);
      if ((s.a === a && s.b === b) || (s.a === b && s.b === a)) return s;
    }
    return null;
  }

  addSegment(a: number, b: number, curve: Cubic, spec: RoadSpec, ring = false): Segment {
    let from = a;
    let to = b;
    let c = curve;
    let sp = { ...spec };
    if (sp.lanesF === 0) {
      [from, to] = [b, a];
      c = reverseCubic(curve);
      sp = { ...sp, lanesF: sp.lanesB, lanesB: 0 };
    }
    const lut = new CurveLUT(c);
    const seg: Segment = { id: this.nextSegId++, a: from, b: to, curve: c, lut, length: lut.length, spec: sp, ring, rev: 0 };
    this.segments.set(seg.id, seg);
    this.node(from).segments.push(seg.id);
    this.node(to).segments.push(seg.id);
    this.indexSegment(seg);
    this.dirty.add(from);
    this.dirty.add(to);
    return seg;
  }

  /** Меняет параметры сегмента, сохраняя геометрию. */
  setSpec(segId: number, spec: RoadSpec): void {
    const s = this.segment(segId);
    if (spec.lanesF === 0) {
      this.reverseSegment(segId);
      s.spec = { ...spec, lanesF: spec.lanesB, lanesB: 0 };
    } else {
      s.spec = { ...spec };
    }
    this.indexSegment(s);
    this.dirty.add(s.a);
    this.dirty.add(s.b);
  }

  reverseSegment(segId: number): void {
    const s = this.segment(segId);
    [s.a, s.b] = [s.b, s.a];
    s.curve = reverseCubic(s.curve);
    s.lut = new CurveLUT(s.curve);
    s.length = s.lut.length;
    // У двусторонней дороги полосы меняются местами, у односторонней меняется направление.
    if (s.spec.lanesB > 0) s.spec = { ...s.spec, lanesF: s.spec.lanesB, lanesB: s.spec.lanesF };
    this.dirty.add(s.a);
    this.dirty.add(s.b);
  }

  /** Переставляет узел в новую точку. Форму его участков задаёт вызывающий — reshapeSegment. */
  moveNode(nodeId: number, pos: Vec): void {
    const n = this.node(nodeId);
    this.indexNode(n, false);
    // Новый объект: старой точкой могут пользоваться кривые участков.
    n.pos = { ...pos };
    this.indexNode(n, true);
    this.dirty.add(nodeId);
  }

  /**
   * Новая форма участка с теми же концами и тем же id: настройки узлов (запреты поворотов,
   * главная дорога), маршруты и машины на нём остаются как были.
   */
  reshapeSegment(segId: number, curve: Cubic): void {
    const s = this.segment(segId);
    s.curve = curve;
    s.lut = new CurveLUT(curve);
    s.length = s.lut.length;
    this.indexSegment(s);
    this.dirty.add(s.a);
    this.dirty.add(s.b);
  }

  /** Делит сегмент в параметре t и возвращает новый узел. */
  splitSegment(segId: number, t: number): RoadNode {
    return this.splitSegmentDetailed(segId, t).node;
  }

  splitSegmentDetailed(segId: number, t: number): { node: RoadNode; first: Segment; second: Segment } {
    const s = this.segment(segId);
    const [c1, c2] = splitBezier(s.curve, t);
    const level = this.levelAt(s, s.lut.sAtT(t));
    const node = this.addNode(c1.p3, Math.round(level));
    this.removeSegment(segId, false);
    const first = this.addSegment(s.a, node.id, c1, s.spec, s.ring);
    const second = this.addSegment(node.id, s.b, c2, s.spec, s.ring);
    this.pendingSplits.push({ oldSeg: s.id, oldLength: s.length, first: first.id, second: second.id, at: first.length });
    // Настройки концов (сигналы, запреты поворотов, главная дорога) ссылались на старый участок —
    // теперь у каждого конца свой кусок.
    this.renameSegAt(s.a, s.id, first.id);
    this.renameSegAt(s.b, s.id, second.id);
    return { node, first, second };
  }

  /**
   * Лежат ли участки a и b по разные стороны автомагистрали, проходящей через узел.
   * Тогда проезд между ними пересекал бы барьер.
   */
  private acrossMedian(nodeId: number, a: number, b: number): boolean {
    if (a === b) return false;
    const sa = this.segment(a);
    const sb = this.segment(b);
    if (isDivided(sa.spec) || isDivided(sb.spec)) return false;
    const n = this.node(nodeId);
    const main = n.segments.find((id) => isDivided(this.segment(id).spec));
    if (main === undefined) return false;
    const m = this.dirFrom(nodeId, main);
    const side = (id: number) => {
      const d = this.dirFrom(nodeId, id);
      return d.x * -m.y + d.y * m.x;
    };
    return side(a) * side(b) < 0;
  }

  /** В настройках узла заменяет участок from на to. */
  private renameSegAt(nodeId: number, from: number, to: number): void {
    const n = this.nodes.get(nodeId);
    if (!n) return;
    if (n.signals) n.signals = n.signals.map((id) => (id === from ? to : id));
    if (n.mainPair) n.mainPair = n.mainPair.map((id) => (id === from ? to : id));
    if (n.bans) {
      n.bans = n.bans.map((key) =>
        key
          .split('>')
          .map((id) => (Number(id) === from ? String(to) : id))
          .join('>'),
      );
    }
    if (n.lanes) {
      const rename = (id: number) => (id === from ? to : id);
      n.lanes = n.lanes.map((key) => {
        const l = parseLaneLink(key);
        return l ? laneLinkKey({ ...l, inSeg: rename(l.inSeg), outSeg: rename(l.outSeg) }) : key;
      });
    }
  }

  removeSegment(segId: number, cleanupNodes = true): void {
    const s = this.segments.get(segId);
    if (!s) return;
    this.segments.delete(segId);
    this.unindexSegment(segId);
    this.removedSegs.add(segId);
    for (const nid of [s.a, s.b]) {
      const n = this.nodes.get(nid);
      if (!n) continue;
      n.segments = n.segments.filter((id) => id !== segId);
      this.dirty.add(nid);
      if (cleanupNodes && n.segments.length === 0 && n.buildingId === null) this.deleteNode(nid);
    }
  }

  /** Высота (уровень) сегмента в точке s вдоль оси. */
  levelAt(seg: Segment, s: number): number {
    const la = this.node(seg.a).level;
    const lb = this.node(seg.b).level;
    if (la === lb) return la;
    const t = Math.max(0, Math.min(1, s / seg.length));
    return la + (lb - la) * t;
  }

  isFlat(seg: Segment): boolean {
    return this.node(seg.a).level === this.node(seg.b).level;
  }

  /** Направление сегмента, выходящее из узла. */
  dirFrom(nodeId: number, segId: number): Vec {
    const s = this.segment(segId);
    if (s.a === nodeId) return s.lut.tangentAt(0);
    return scale(s.lut.tangentAt(s.length), -1);
  }

  /** Положение на полосе: s — пройденное от начала полосы расстояние. */
  lanePose(lane: Lane, s: number): { pos: Vec; dir: Vec } {
    const seg = this.segment(lane.seg);
    const travel = lane.sStart + s;
    const cs = lane.dir === 0 ? travel : seg.length - travel;
    const p = seg.lut.pointAt(cs);
    let t = seg.lut.tangentAt(cs);
    if (lane.dir === 1) t = scale(t, -1);
    return { pos: { x: p.x - t.y * lane.offset, y: p.y + t.x * lane.offset }, dir: t };
  }

  /** Высота машины на полосе. */
  laneLevel(lane: Lane, s: number): number {
    const seg = this.segment(lane.seg);
    const travel = lane.sStart + s;
    return this.levelAt(seg, lane.dir === 0 ? travel : seg.length - travel);
  }

  // ---------- Пересчёт ----------

  /**
   * Пересчитывает полосы, манёвры, конфликты и приоритеты вокруг изменённых узлов.
   * Манёвры в узле зависят только от его радиуса и примыкающих сегментов,
   * поэтому остальная сеть не трогается.
   */
  rebuild(): void {
    this.version++;
    const dirty = [...this.dirty].map((id) => this.nodes.get(id)).filter((n): n is RoadNode => !!n);
    this.dirty.clear();

    for (const id of this.removedNodes) this.dropNodeMovements(id);
    this.removedNodes.clear();
    for (const segId of this.removedSegs) this.dropSegmentLanes(segId);
    this.removedSegs.clear();

    for (const n of dirty) this.computeRadius(n);
    const touched = new Set<Segment>();
    for (const n of dirty) for (const sid of n.segments) touched.add(this.segment(sid));
    for (const s of touched) this.rebuildSegmentLanes(s);
    const nodesToIndex = new Set<number>();
    for (const s of touched) {
      nodesToIndex.add(s.a);
      nodesToIndex.add(s.b);
    }
    for (const n of dirty) nodesToIndex.add(n.id);
    for (const id of nodesToIndex) this.rebuildNodeLinks(id);
    for (const n of dirty) this.rebuildNodeMovements(n);
    this.rebuildIndexes();
    for (const n of dirty) this.rebuildControl(n);
  }

  private dropNodeMovements(nodeId: number): void {
    for (const m of this.nodeMovements.get(nodeId) ?? []) this.movements.delete(m.key);
    this.nodeMovements.delete(nodeId);
    this.inLinks.delete(nodeId);
    this.outLinks.delete(nodeId);
  }

  private dropSegmentLanes(segId: number): void {
    for (const dir of [0, 1] as const) {
      this.links.delete(linkId(segId, dir));
      for (let i = 0; i < MAX_LANES; i++) this.lanes.delete(laneIdOf(segId, dir, i));
    }
  }

  private computeRadius(n: RoadNode): void {
    // Радиус узла нужен только автодорогам; рельсы соединяются в точке.
    const segs = this.roadSegs(n).map((id) => this.segment(id));
    const deg = segs.length;
    // На переезде машины останавливаются перед рельсами.
    const crossingGap = segs.length && segs.length < n.segments.length ? RAIL_HALF + 6 : 0;
    if (deg <= 1) {
      n.radius = crossingGap;
      return;
    }
    const minLen = Math.min(...segs.map((s) => s.length));
    const maxHw = Math.max(0, ...segs.map((s) => halfWidth(s.spec)));
    const dirs = segs.map((s) => angleOf(this.dirFrom(n.id, s.id))).sort((a, b) => a - b);
    let minGap = Math.PI * 2;
    for (let i = 0; i < dirs.length; i++) {
      const next = i + 1 < dirs.length ? dirs[i + 1] : dirs[0] + Math.PI * 2;
      minGap = Math.min(minGap, next - dirs[i]);
    }
    let r: number;
    if (deg === 2) {
      const turn = Math.PI - minGap;
      const sameLanes = this.continuousLanes(n.id, segs[0], segs[1]);
      if (turn < 0.08 && sameLanes) r = 0;
      else r = maxHw * Math.tan(Math.min(1.2, turn) / 2) * 1.3 + (sameLanes ? 2 : 10);
    } else {
      r = maxHw / Math.tan(Math.max(0.35, minGap) / 2) + 4;
    }
    n.radius = Math.max(crossingGap, Math.min(r, 70, minLen * 0.42));
  }

  /** Совпадает ли число полос по каждому направлению при проезде через узел. */
  private continuousLanes(nodeId: number, s1: Segment, s2: Segment): boolean {
    const inOut = (s: Segment) => (s.b === nodeId ? [s.spec.lanesF, s.spec.lanesB] : [s.spec.lanesB, s.spec.lanesF]);
    const [in1, out1] = inOut(s1);
    const [in2, out2] = inOut(s2);
    return in1 === out2 && in2 === out1 && s1.spec.cls === s2.spec.cls;
  }

  private rebuildSegmentLanes(s: Segment): void {
    s.rev++;
    if (s.spec.cls === 'rail') {
      // У рельсов нет автомобильных полос.
      this.dropSegmentLanes(s.id);
      return;
    }
    const speed = specSpeed(s.spec);
    for (const dir of [0, 1] as const) {
      const count = dir === 0 ? s.spec.lanesF : s.spec.lanesB;
      const id = linkId(s.id, dir);
      for (let i = count; i < MAX_LANES; i++) this.lanes.delete(laneIdOf(s.id, dir, i));
      if (count === 0) {
        this.links.delete(id);
        continue;
      }
      const from = dir === 0 ? s.a : s.b;
      const to = dir === 0 ? s.b : s.a;
      const rFrom = this.node(from).radius;
      const rTo = this.node(to).radius;
      const length = Math.max(0.5, s.length - rFrom - rTo);
      let link = this.links.get(id);
      if (!link) {
        link = { id, seg: s.id, dir, from, to, lanes: [], length, speed };
        this.links.set(id, link);
      }
      Object.assign(link, { from, to, length, speed, lanes: [] });
      for (let i = 0; i < count; i++) {
        const lid = laneIdOf(s.id, dir, i);
        let lane = this.lanes.get(lid);
        if (!lane) {
          lane = {
            id: lid,
            link: id,
            seg: s.id,
            dir,
            index: i,
            from,
            to,
            offset: 0,
            sStart: 0,
            length: 0,
            speed,
            start: { x: 0, y: 0 },
            end: { x: 0, y: 0 },
            startDir: { x: 1, y: 0 },
            endDir: { x: 1, y: 0 },
            vehicles: [],
          };
          this.lanes.set(lid, lane);
        }
        Object.assign(lane, { from, to, speed, offset: laneOffset(s.spec, count, i), sStart: rFrom, length });
        const a = this.lanePose(lane, 0);
        const b = this.lanePose(lane, length);
        Object.assign(lane, { start: a.pos, startDir: a.dir, end: b.pos, endDir: b.dir });
        link.lanes.push(lane);
      }
    }
  }

  private rebuildNodeLinks(nodeId: number): void {
    const n = this.nodes.get(nodeId);
    if (!n) return;
    const ins: Link[] = [];
    const outs: Link[] = [];
    for (const sid of n.segments) {
      for (const dir of [0, 1] as const) {
        const link = this.links.get(linkId(sid, dir));
        if (!link) continue;
        if (link.from === n.id) outs.push(link);
        if (link.to === n.id) ins.push(link);
      }
    }
    this.inLinks.set(n.id, ins);
    this.outLinks.set(n.id, outs);
  }

  /**
   * Куда в принципе можно проехать со связи inL через узел, без учёта запретов игрока.
   * Выезды отсортированы справа налево, theta — угол поворота.
   */
  turnExits(n: RoadNode, inL: Link): { link: Link; theta: number }[] {
    const outs = this.outLinks.get(n.id) ?? [];
    const deadEnd = this.roadSegs(n).length === 1;
    const inDir = inL.lanes[0].endDir;
    const inDivided = isDivided(this.segment(inL.seg).spec);
    return (
      outs
        .filter((o) => o.seg !== inL.seg || deadEnd)
        .map((o) => ({ link: o, theta: angleDiff(angleOf(inDir), angleOf(o.lanes[0].startDir)) }))
        // Через барьер автомагистрали налево не повернуть — только направо, съездами;
        // и не развернуться на крутом съезде в обратную сторону.
        .filter(
          (e) =>
            e.link.seg === inL.seg ||
            !(inDivided || isDivided(this.segment(e.link.seg).spec)) ||
            (e.theta >= -0.5 && e.theta <= 2.2),
        )
        // Со съезда по одну сторону автомагистрали нельзя попасть на съезд по другую — это пересечение в уровне.
        .filter((e) => !this.acrossMedian(n.id, inL.seg, e.link.seg))
        // На односторонний съезд и с него — не разворотом: съезд, отходящий под острым углом, только для попутных.
        .filter(
          (e) =>
            e.link.seg === inL.seg ||
            Math.abs(e.theta) <= 2.5 ||
            !(isOneWay(this.segment(inL.seg).spec) || isOneWay(this.segment(e.link.seg).spec)),
        )
        .sort((a, b) => b.theta - a.theta)
    );
  }

  /**
   * Связи полос узла, которые сейчас можно применить: по связи въезда — полоса справа → её выезды.
   * Записи об исчезнувших участках и полосах выбрасываются; связи на недоступный сейчас выезд
   * остаются, но не действуют.
   */
  private customLanes(n: RoadNode, ins: Link[]): Map<number, Map<number, { link: Link; lane: Lane }[]>> {
    const result = new Map<number, Map<number, { link: Link; lane: Lane }[]>>();
    if (!n.lanes?.length) return result;
    const outs = this.outLinks.get(n.id) ?? [];
    const kept: string[] = [];
    const exitsOf = new Map<number, Set<number>>();
    for (const key of n.lanes) {
      const l = parseLaneLink(key);
      const inL = l && ins.find((x) => x.seg === l.inSeg);
      const outL = l && outs.find((x) => x.seg === l.outSeg);
      if (!l || !inL || !outL || l.i >= inL.lanes.length || l.j >= outL.lanes.length) continue;
      kept.push(key);
      if (!exitsOf.has(inL.id)) exitsOf.set(inL.id, new Set(this.turnExits(n, inL).map((e) => e.link.id)));
      if (!exitsOf.get(inL.id)!.has(outL.id)) continue;
      if (!result.has(inL.id)) result.set(inL.id, new Map());
      const byLane = result.get(inL.id)!;
      if (!byLane.has(l.i)) byLane.set(l.i, []);
      byLane.get(l.i)!.push({ link: outL, lane: outL.lanes[outL.lanes.length - 1 - l.j] });
    }
    if (kept.length !== n.lanes.length) n.lanes = kept.length ? kept : undefined;
    return result;
  }

  private rebuildNodeMovements(n: RoadNode): void {
    const old = this.nodeMovements.get(n.id) ?? [];
    const alive = new Set<string>();
    const list: Movement[] = [];
    const ins = this.inLinks.get(n.id) ?? [];
    const custom = this.customLanes(n, ins);
    const addMovement = (inL: Link, inLane: Lane, outL: Link, outLane: Lane) => {
      const key = movementKey(inLane.id, outLane.id);
      if (alive.has(key)) return;
      alive.add(key);
      const geom = this.movementGeometry(inLane, outLane);
      let m = this.movements.get(key);
      if (!m) {
        m = {
          key,
          node: n.id,
          inLane: inLane.id,
          outLane: outLane.id,
          inLink: inL.id,
          outLink: outL.id,
          vehicles: [],
          conflicts: new Map(),
          ...geom,
        };
        this.movements.set(key, m);
      } else {
        Object.assign(m, geom, { node: n.id, inLink: inL.id, outLink: outL.id, conflicts: new Map() });
      }
      list.push(m);
    };
    for (const inL of ins) {
      // Повороты, запрещённые игроком.
      const exits = this.turnExits(n, inL).filter((e) => !n.bans?.includes(`${inL.seg}>${e.link.seg}`));
      const own = custom.get(inL.id);
      if (exits.length) {
        const pairs = assignLanes(
          inL.lanes.length,
          exits.map((e) => ({ count: e.link.lanes.length, theta: e.theta, uTurn: e.link.seg === inL.seg })),
        );
        exits.forEach((e, k) => {
          for (const [fromRight, outFromRight] of pairs[k]) {
            // Полосу, настроенную игроком, ведут только её собственные связи.
            if (own?.has(fromRight)) continue;
            addMovement(inL, inL.lanes[inL.lanes.length - 1 - fromRight], e.link, e.link.lanes[e.link.lanes.length - 1 - outFromRight]);
          }
        });
      }
      for (const [fromRight, targets] of own ?? []) {
        for (const t of targets) addMovement(inL, inL.lanes[inL.lanes.length - 1 - fromRight], t.link, t.lane);
      }
    }
    for (const m of old) if (!alive.has(m.key)) this.movements.delete(m.key);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const kind = conflictKind(list[i], list[j]);
        if (kind) {
          list[i].conflicts.set(list[j].key, kind);
          list[j].conflicts.set(list[i].key, kind);
        }
      }
    }
    this.nodeMovements.set(n.id, list);
  }

  /** Индексы манёвров по полосам и связям — дешёвый полный пересчёт. */
  private rebuildIndexes(): void {
    this.movesFrom.clear();
    this.movesInto.clear();
    this.linkNext.clear();
    this.linkPrev.clear();
    this.transitions.clear();
    for (const list of this.nodeMovements.values()) {
      for (const m of list) {
        if (!this.movesFrom.has(m.inLane)) this.movesFrom.set(m.inLane, []);
        if (!this.movesInto.has(m.outLane)) this.movesInto.set(m.outLane, []);
        this.movesFrom.get(m.inLane)!.push(m);
        this.movesInto.get(m.outLane)!.push(m);
        if (!this.linkNext.has(m.inLink)) this.linkNext.set(m.inLink, new Set());
        if (!this.linkPrev.has(m.outLink)) this.linkPrev.set(m.outLink, new Set());
        this.linkNext.get(m.inLink)!.add(m.outLink);
        this.linkPrev.get(m.outLink)!.add(m.inLink);
        const tKey = `${m.inLink}>${m.outLink}`;
        if (!this.transitions.has(tKey)) this.transitions.set(tKey, []);
        this.transitions.get(tKey)!.push(m);
      }
    }
  }

  private movementGeometry(inL: Lane, outL: Lane): Pick<Movement, 'points' | 'cum' | 'length' | 'speed' | 'dirIn' | 'dirOut'> {
    const p0 = inL.end;
    const p3 = outL.start;
    const chord = dist(p0, p3);
    const uTurn = dot(inL.endDir, outL.startDir) < -0.95;
    const k = uTurn ? Math.max(chord * 0.9, 7) : chord * 0.45;
    const p1 = add(p0, scale(inL.endDir, k));
    const p2 = sub(p3, scale(outL.startDir, k));
    const points: Vec[] = [];
    const steps = chord < 1 ? 1 : 10;
    for (let i = 0; i <= steps; i++) points.push(cubicBezier(p0, p1, p2, p3, i / steps));
    const cum = [0];
    for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + dist(points[i - 1], points[i]));
    const length = Math.max(0.3, cum[cum.length - 1]);
    const theta = Math.abs(angleDiff(angleOf(inL.endDir), angleOf(outL.startDir)));
    let speed = Math.min(inL.speed, outL.speed);
    if (theta > 0.15) {
      const r = Math.max(2, chord / (2 * Math.max(0.15, Math.sin(theta / 2))));
      speed = Math.min(speed, Math.max(5, Math.sqrt(9 * r)));
    }
    return { points, cum, length, speed, dirIn: inL.endDir, dirOut: outL.startDir };
  }

  private rebuildControl(n: RoadNode): void {
    const ins = this.inLinks.get(n.id) ?? [];
    n.priorityLanes = new Set();
    const ringIns = ins.filter((l) => this.segment(l.seg).ring);
    if (ringIns.length > 0 && ringIns.length < ins.length) {
      for (const l of ringIns) for (const lane of l.lanes) n.priorityLanes.add(lane.id);
    } else if (this.roadSegs(n).length >= 3 && n.control !== 'lights') {
      // Главная дорога: выбранная игроком (если оба участка ещё на месте) или самая прямая и широкая.
      const roads = this.roadSegs(n);
      const manual = n.mainPair;
      const valid = manual && manual.length === 2 && manual.every((id) => roads.includes(id));
      const main = manual && manual.length === 0 ? null : valid ? (manual as [number, number]) : this.mainRoad(n);
      if (main) {
        for (const l of ins) {
          if (main.includes(l.seg)) for (const lane of l.lanes) n.priorityLanes.add(lane.id);
        }
        // Если все входы главные (например, слияние двух одинаковых дорог), приоритет не нужен.
        if (ins.every((l) => main.includes(l.seg))) n.priorityLanes.clear();
      }
    }
    if (n.control === 'lights' && this.roadSegs(n).length >= 3) {
      const phases = groupPhases(ins);
      if (!n.lights || n.lights.phases.length !== phases.length) {
        n.lights = { phases, phase: 0, timer: LIGHTS.green, clearing: false };
      } else {
        n.lights.phases = phases;
      }
    } else {
      n.control = 'none';
      n.lights = null;
    }
  }

  /** Главная дорога через узел: самая прямая и вместительная пара сегментов. */
  private mainRoad(n: RoadNode): [number, number] | null {
    let best: [number, number] | null = null;
    let bestScore = -Infinity;
    const segs = this.roadSegs(n).map((id) => this.segment(id));
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        const d1 = this.dirFrom(n.id, segs[i].id);
        const d2 = this.dirFrom(n.id, segs[j].id);
        const deviation = Math.PI - Math.acos(Math.max(-1, Math.min(1, dot(d1, d2))));
        if (deviation > 0.6) continue;
        const cap = (s: Segment) => totalLanes(s.spec) * specSpeed(s.spec);
        const score = cap(segs[i]) + cap(segs[j]) - deviation * 40;
        if (score > bestScore) {
          bestScore = score;
          best = [segs[i].id, segs[j].id];
        }
      }
    }
    return best;
  }

  /** Точка на манёвре по пройденному расстоянию. */
  static pointOnMovement(m: Movement, s: number): { pos: Vec; dir: Vec } {
    const pts = m.points;
    const target = Math.max(0, Math.min(m.cum[m.cum.length - 1], s));
    let i = 1;
    while (i < pts.length - 1 && m.cum[i] < target) i++;
    const segLen = m.cum[i] - m.cum[i - 1];
    const t = segLen > 1e-6 ? (target - m.cum[i - 1]) / segLen : 0;
    const a = pts[i - 1];
    const b = pts[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l = Math.hypot(dx, dy);
    const pos = { x: a.x + dx * t, y: a.y + dy * t };
    // На стыке манёвр почти нулевой длины, и направление отрезка между концами полос
    // случайно (бывает поперёк дороги) — плавно переходим от полосы въезда к выезду.
    if (m.length < 3 || l < 0.5) {
      const k = m.length > 1e-6 ? target / m.length : 0;
      const x = m.dirIn.x + (m.dirOut.x - m.dirIn.x) * k;
      const y = m.dirIn.y + (m.dirOut.y - m.dirIn.y) * k;
      const n = Math.hypot(x, y);
      return { pos, dir: n > 1e-6 ? { x: x / n, y: y / n } : m.dirOut };
    }
    return { pos, dir: { x: dx / l, y: dy / l } };
  }
}

/**
 * Распределяет входящие полосы по выездам.
 * Выезды отсортированы справа налево, полосы считаются справа.
 * Возвращает для каждого выезда пары [входящая полоса справа, исходящая полоса справа].
 */
export function assignLanes(
  inCount: number,
  exits: { count: number; theta: number; uTurn: boolean }[],
): [number, number][][] {
  const k = exits.length;
  let straight = -1;
  let bestAbs = 0.6;
  exits.forEach((e, i) => {
    if (!e.uTurn && Math.abs(e.theta) < bestAbs) {
      bestAbs = Math.abs(e.theta);
      straight = i;
    }
  });
  return exits.map((e, j) => {
    if (e.uTurn) return [[inCount - 1, e.count - 1]];
    let lo: number;
    let hi: number;
    if (j === straight) {
      lo = 0;
      hi = inCount - 1;
    } else {
      lo = Math.floor((j * inCount) / k);
      hi = Math.max(lo, Math.ceil(((j + 1) * inCount) / k) - 1);
    }
    const m = hi - lo + 1;
    const p = e.count;
    const pairs: [number, number][] = [];
    for (let i = 0; i < m; i++) {
      if (m <= p) {
        const a = Math.floor((i * p) / m);
        const b = Math.max(a, Math.ceil(((i + 1) * p) / m) - 1);
        for (let o = a; o <= b; o++) pairs.push([lo + i, o]);
      } else {
        pairs.push([lo + i, Math.floor((i * p) / m)]);
      }
    }
    return pairs;
  });
}

function conflictKind(a: Movement, b: Movement): ConflictKind | null {
  if (a.outLane === b.outLane) return 'merge';
  if (a.inLane === b.inLane) return 'diverge';
  return polylineDistance(a.points, b.points) < CAR_WIDTH * 0.9 ? 'cross' : null;
}

/** Группирует входящие связи в фазы: встречные направления едут вместе. */
function groupPhases(ins: Link[]): number[][] {
  const left = [...ins];
  const phases: number[][] = [];
  while (left.length) {
    const first = left.shift()!;
    const d1 = first.lanes[0].endDir;
    let bestIdx = -1;
    let bestDot = -0.7;
    left.forEach((l, i) => {
      const d = dot(d1, l.lanes[0].endDir);
      if (d < bestDot) {
        bestDot = d;
        bestIdx = i;
      }
    });
    const group = [first];
    if (bestIdx >= 0) group.push(left.splice(bestIdx, 1)[0]);
    phases.push(group.flatMap((l) => l.lanes.map((lane) => lane.id)));
  }
  return phases;
}

function polylineDistance(a: Vec[], b: Vec[]): number {
  let best = Infinity;
  for (let i = 0; i < a.length - 1; i++) {
    for (let j = 0; j < b.length - 1; j++) {
      const d = segSegDist(a[i], a[i + 1], b[j], b[j + 1]);
      if (d < best) best = d;
      if (best === 0) return 0;
    }
  }
  return best;
}

import { Cubic, CurveLUT, splitBezier } from '../core/bezier';
import { dist, scale, Vec } from '../core/vec';
import { halfWidth, RoadSpec } from './roadTypes';

/**
 * Сеть железной дороги: участки путей между узлами (стрелки, концы, сигналы, подъезды вокзалов).
 * Автодороги — отдельная сеть полос (`src/lanes`).
 */

export interface RoadNode {
  id: number;
  pos: Vec;
  /** Уровень высоты: −1 тоннель, 0 земля, 1 мост, 2 эстакада. */
  level: number;
  segments: number[];
  /** Узел-подъезд станции, его нельзя удалить. */
  buildingId: number | null;
  /**
   * Ж/д сигналы в узле: участки, на выезд к которым стоит сигнал. Сигнал односторонний —
   * его видят только поезда, едущие из узла на этот участок.
   */
  signals?: number[];
  /**
   * Какие из сигналов узла запрещают встречное движение (как в Transport Fever): поезд не проедет
   * в узел по этому участку — против сигнала. Остальные сигналы делят путь на блоки в обе стороны.
   */
  oneWay?: number[];
}

export interface Segment {
  id: number;
  a: number;
  b: number;
  curve: Cubic;
  lut: CurveLUT;
  length: number;
  spec: RoadSpec;
  /** Растёт при каждом изменении участка или его узлов — по нему рендер обновляет кэш. */
  rev: number;
  /** Путь — платформа вокзала с этим id. */
  platform?: number;
}

export interface SplitRecord {
  oldSeg: number;
  oldLength: number;
  first: number;
  second: number;
  /** Длина первой части вдоль оси. */
  at: number;
}

export interface NetworkSave {
  nextNodeId: number;
  nextSegId: number;
  nodes: Pick<RoadNode, 'id' | 'pos' | 'level' | 'buildingId' | 'signals' | 'oneWay'>[];
  segments: Pick<Segment, 'id' | 'a' | 'b' | 'curve' | 'spec' | 'platform'>[];
}

const GRID = 160;
const cellKey = (x: number, y: number) => `${x}:${y}`;

export class Network {
  readonly nodes = new Map<number, RoadNode>();
  readonly segments = new Map<number, Segment>();
  /** Разрезания сегментов с прошлой проверки поездов: нужны, чтобы перенести поезда. */
  pendingSplits: SplitRecord[] = [];
  version = 0;
  private nextNodeId = 1;
  private nextSegId = 1;
  /** Узлы, участки которых изменились с прошлого rebuild. */
  private readonly dirty = new Set<number>();
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
        signals: n.signals,
        ...(n.oneWay?.length ? { oneWay: n.oneWay } : {}),
      })),
      segments: [...this.segments.values()].map((s) => ({ id: s.id, a: s.a, b: s.b, curve: s.curve, spec: s.spec, platform: s.platform })),
    };
  }

  /**
   * Заменяет всю сеть снимком (отмена строительства). Счётчики id не откатываются,
   * чтобы новые узлы и участки не получили номера уже удалённых.
   */
  replaceWith(data: NetworkSave): void {
    const nextNode = this.nextNodeId;
    const nextSeg = this.nextSegId;
    for (const m of [this.nodes, this.segments, this.segGrid, this.segCells, this.nodeGrid] as Map<unknown, unknown>[]) m.clear();
    this.pendingSplits = [];
    this.dirty.clear();
    this.load(data);
    this.nextNodeId = Math.max(nextNode, data.nextNodeId);
    this.nextSegId = Math.max(nextSeg, data.nextSegId);
  }

  /** Загружает сохранённую сеть в пустую сеть (поля прежних версий — настройки перекрёстков и т. п. — пропускаются). */
  load(data: NetworkSave): void {
    for (const nd of data.nodes) {
      const node: RoadNode = { id: nd.id, pos: nd.pos, level: nd.level, buildingId: nd.buildingId, segments: [] };
      if (nd.signals) node.signals = nd.signals;
      // Старые сохранения — без поля: все сигналы обычные.
      if (nd.oneWay?.length) node.oneWay = nd.oneWay;
      this.nodes.set(node.id, node);
      this.indexNode(node, true);
      this.dirty.add(node.id);
    }
    for (const sd of data.segments) {
      const lut = new CurveLUT(sd.curve);
      const seg: Segment = { id: sd.id, a: sd.a, b: sd.b, curve: sd.curve, spec: sd.spec, lut, length: lut.length, rev: 0 };
      if (sd.platform !== undefined) seg.platform = sd.platform;
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
    const node: RoadNode = { id: this.nextNodeId++, pos: { ...pos }, level, segments: [], buildingId };
    this.nodes.set(node.id, node);
    this.indexNode(node, true);
    this.dirty.add(node.id);
    return node;
  }

  /** Переносит узел; формы его участков меняют отдельно (setCurve), концы — в новом месте. */
  moveNode(id: number, pos: Vec): void {
    const n = this.node(id);
    this.indexNode(n, false);
    n.pos = { ...pos };
    this.indexNode(n, true);
    this.dirty.add(id);
  }

  /** Новая форма участка (концы — в его узлах): длина и индекс заново, поезда подстроятся (RailSim.validate). */
  setCurve(segId: number, curve: Cubic): void {
    const s = this.segment(segId);
    s.curve = curve;
    s.lut = new CurveLUT(curve);
    s.length = s.lut.length;
    this.indexSegment(s);
    this.dirty.add(s.a);
    this.dirty.add(s.b);
  }

  deleteNode(id: number): void {
    const n = this.nodes.get(id);
    if (!n) return;
    for (const sid of [...n.segments]) this.removeSegment(sid, false);
    this.indexNode(n, false);
    this.nodes.delete(id);
    this.dirty.delete(id);
  }

  isRailSeg(id: number): boolean {
    return this.segment(id).spec.cls === 'rail';
  }

  railSegs(n: RoadNode): number[] {
    return n.segments.filter((id) => this.isRailSeg(id));
  }

  /** Помечает узел для пересчёта (например, после смены сигнала). */
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

  addSegment(a: number, b: number, curve: Cubic, spec: RoadSpec): Segment {
    const lut = new CurveLUT(curve);
    const seg: Segment = { id: this.nextSegId++, a, b, curve, lut, length: lut.length, spec: { ...spec }, rev: 0 };
    this.segments.set(seg.id, seg);
    this.node(a).segments.push(seg.id);
    this.node(b).segments.push(seg.id);
    this.indexSegment(seg);
    this.dirty.add(a);
    this.dirty.add(b);
    return seg;
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
    const first = this.addSegment(s.a, node.id, c1, s.spec);
    const second = this.addSegment(node.id, s.b, c2, s.spec);
    this.pendingSplits.push({ oldSeg: s.id, oldLength: s.length, first: first.id, second: second.id, at: first.length });
    // Сигналы на концах ссылались на старый участок — теперь у каждого конца свой кусок.
    this.renameSegAt(s.a, s.id, first.id);
    this.renameSegAt(s.b, s.id, second.id);
    return { node, first, second };
  }

  /** В сигналах узла заменяет участок from на to. */
  private renameSegAt(nodeId: number, from: number, to: number): void {
    const n = this.nodes.get(nodeId);
    if (n?.signals) n.signals = n.signals.map((id) => (id === from ? to : id));
    if (n?.oneWay) n.oneWay = n.oneWay.map((id) => (id === from ? to : id));
  }

  removeSegment(segId: number, cleanupNodes = true): void {
    const s = this.segments.get(segId);
    if (!s) return;
    this.segments.delete(segId);
    this.unindexSegment(segId);
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

  /** После правок: новая версия сети, у участков изменившихся узлов — новая ревизия (рендер перерисует). */
  rebuild(): void {
    this.version++;
    for (const id of this.dirty) {
      for (const sid of this.nodes.get(id)?.segments ?? []) {
        const s = this.segments.get(sid);
        if (s) s.rev++;
      }
    }
    this.dirty.clear();
  }
}

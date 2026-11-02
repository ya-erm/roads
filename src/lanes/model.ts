import { Cubic, CurveLUT } from '../core/bezier';
import { add, dist, dot, len, norm, rightNormal, scale, sub, Vec } from '../core/vec';
import { LANE_W, RoadClass } from '../world/roadTypes';

/** Кривая — прямой отрезок: управляющие точки на хорде, между концами. */
function isStraight(cv: Cubic): boolean {
  const chord = sub(cv.p3, cv.p0);
  const l = len(chord);
  if (l < 1e-6) return false;
  const u = scale(chord, 1 / l);
  return [cv.p1, cv.p2].every((p) => {
    const d = sub(p, cv.p0);
    const along = dot(d, u);
    return Math.abs(d.x * u.y - d.y * u.x) < 0.5 && along > 0 && along < l;
  });
}

/** Направление движения по полосе: 1 — по ходу оси полотна (a→b), −1 — против. */
export type Flow = 1 | -1;
export type End = 'a' | 'b';

/** Полоса полотна. */
export interface LaneSlot {
  /** Смещение оси полосы от оси полотна, вправо по ходу a→b. */
  offset: number;
  flow: Flow;
  /** Где полоса на полную ширину, м вдоль оси; за пределами — отгон (см. `taperLen`) или ничего. */
  from: number;
  to: number;
  /** Линия к соседней полосе с бо́льшим смещением — сплошная: через неё не перестраиваются. */
  solid?: boolean;
}

/** Полотно: ось между двумя узлами и полосы вдоль неё. */
export interface Corridor {
  id: number;
  a: number;
  b: number;
  /** Сдвиг конца оси вбок от точки стыка (вправо по `dir` стыка); у перекрёстка 0. */
  portA: number;
  portB: number;
  curve: Cubic;
  lut: CurveLUT;
  length: number;
  cls: RoadClass;
  lanes: LaneSlot[];
  /** Участок кольца: на его узлах кольцо — главное. */
  ring?: boolean;
  /** Ограничение скорости, км/ч; нет — по умолчанию для класса. */
  limit?: number;
  /** Растёт при каждой правке полотна — по нему отрисовка узнаёт, что пересчитать. */
  rev: number;
}

export type NodeKind = 'seam' | 'junction';

/**
 * Узел. Стык — поперечное сечение: все его полотна касаются `dir`, каждое со своим сдвигом вбок;
 * полосы соединяются по совпадению поперечной координаты. Перекрёсток — точка, полотна подходят
 * к ней осью под любыми углами.
 */
export interface LaneNode {
  id: number;
  kind: NodeKind;
  pos: Vec;
  /** Направление стыка (у перекрёстка не используется). */
  dir: Vec;
  level: number;
  corridors: number[];
  // ---------- Настройки перекрёстка ----------
  /** Светофор. */
  control?: 'lights';
  /** Главная дорога — пара полотен; [] — равнозначный; нет — выбирается сама. */
  mainPair?: number[] | null;
  /** Запрещённые повороты: `${полотно въезда}>${полотно выезда}`. */
  bans?: string[];
  /** Длительность зелёного по фазам светофора, с. */
  greens?: number[];
  /** Светофор пропускает пустые фазы. По умолчанию да. */
  adaptive?: boolean;
  /** Узел кольца с этим центром (id из списка колец игры). */
  roundabout?: number | null;
  /**
   * Связи полос, заданные игроком (laneKey). Полоса въезда, у которой есть хоть одна связь, едет
   * только по своим связям; остальные распределяются сами.
   */
  lanes?: string[];
}

/** Связь полос на перекрёстке: полоса i (справа) полотна from → полоса j (справа) полотна to. */
export interface LaneLink {
  from: number;
  i: number;
  to: number;
  j: number;
}

export const laneKey = (l: LaneLink) => `${l.from}.${l.i}>${l.to}.${l.j}`;

export function parseLaneKey(key: string): LaneLink | null {
  const m = /^(\d+)\.(\d+)>(\d+)\.(\d+)$/.exec(key);
  return m ? { from: Number(m[1]), i: Number(m[2]), to: Number(m[3]), j: Number(m[4]) } : null;
}

/** Полотно from у узла теперь называется to (его разрезали): настройки перекрёстка — на новое имя. */
export function renameArm(n: LaneNode, from: number, to: number): void {
  const swap = (x: number) => (x === from ? to : x);
  if (n.bans) n.bans = n.bans.map((k) => k.split('>').map((x) => swap(Number(x))).join('>'));
  if (n.mainPair) n.mainPair = n.mainPair.map(swap);
  if (n.lanes) {
    n.lanes = n.lanes.map((k) => {
      const l = parseLaneKey(k);
      return l ? laneKey({ ...l, from: swap(l.from), to: swap(l.to) }) : k;
    });
  }
}

/** Конец полотна в узле. */
export interface CorridorEnd {
  corridor: Corridor;
  end: End;
  node: LaneNode;
  /** Точка оси на конце. */
  pos: Vec;
  /** Направление от узла вдоль полотна. */
  away: Vec;
  /** 1 — ось a→b в узле смотрит по `dir` стыка, −1 — против. */
  along: 1 | -1;
  /** Сторона стыка: 1 — спереди (полотно уходит по `dir`), −1 — сзади. */
  side: 1 | -1;
  port: number;
}

/** Длина отгона: на столько вдоль оси полоса расширяется от нуля до полной ширины. */
export const TAPER: Record<RoadClass, number> = { street: 25, avenue: 35, highway: 70, motorway: 90, rail: 0 };
export const taperLen = (cls: RoadClass) => TAPER[cls];

/** Поперечные координаты в стыке совпадают с такой точностью. */
export const LAT_EPS = 0.5;

export const slot = (offset: number, flow: Flow, from = 0, to = Infinity): LaneSlot => ({ offset, flow, from, to });

/** Полосы как у прежней дороги: f по ходу (справа), b против; median — ширина разделительной полосы. */
export function twoWay(f: number, b: number, median = 0): LaneSlot[] {
  const m = median / 2;
  const res: LaneSlot[] = [];
  for (let i = 0; i < b; i++) res.push(slot(-(m + LANE_W / 2 + i * LANE_W), -1));
  for (let i = 0; i < f; i++) res.push(slot(m + LANE_W / 2 + i * LANE_W, 1));
  return res;
}

/** n полос в одну сторону, ось полотна посередине. */
export function oneWay(n: number, flow: Flow = 1): LaneSlot[] {
  return Array.from({ length: n }, (_, i) => slot((i - (n - 1) / 2) * LANE_W, flow));
}

export interface CorridorOptions {
  portA?: number;
  portB?: number;
  cls: RoadClass;
  lanes: LaneSlot[];
  limit?: number;
  ring?: boolean;
  /** Своя форма; концы всё равно ставятся в узлы. */
  curve?: Cubic;
  /** Направление выхода из перекрёстка a / входа в перекрёсток b; по умолчанию — по хорде. */
  dirA?: Vec;
  dirB?: Vec;
  /** С какой стороны стыка лежит полотно (1 — спереди по `dir`); по умолчанию — со стороны другого конца. */
  sideA?: 1 | -1;
  sideB?: 1 | -1;
}

/** Сеть полос для сохранения и отмены. */
export interface LaneNetSave {
  nextId: number;
  nodes: Omit<LaneNode, 'corridors'>[];
  corridors: Omit<Corridor, 'lut' | 'length' | 'rev'>[];
}

/** Ячейка сетки поиска «что рядом». */
const CELL = 160;
const cellKey = (x: number, y: number) => x * 100003 + y;

export class LaneNet {
  readonly nodes = new Map<number, LaneNode>();
  readonly corridors = new Map<number, Corridor>();
  /** Растёт при любом изменении — по нему отрисовка обновляет кэш. */
  version = 0;
  private nextId = 1;
  private nextRev = 1;
  /** Сетка поиска: ячейка → полотна, задевающие её (по рамке кривой с запасом на ширину). */
  private grid = new Map<number, Set<number>>();
  private cellsOf = new Map<number, number[]>();
  private nodeGrid = new Map<number, Set<number>>();

  addSeam(pos: Vec, dir: Vec, level = 0): LaneNode {
    return this.addNode('seam', pos, norm(dir), level);
  }

  addJunction(pos: Vec, level = 0): LaneNode {
    return this.addNode('junction', pos, { x: 1, y: 0 }, level);
  }

  private addNode(kind: NodeKind, pos: Vec, dir: Vec, level: number): LaneNode {
    const n: LaneNode = { id: this.nextId++, kind, pos: { ...pos }, dir, level, corridors: [] };
    this.nodes.set(n.id, n);
    this.indexNode(n, true);
    this.version++;
    return n;
  }

  // ---------- Сетка поиска ----------

  private indexCorridor(c: Corridor, add: boolean): void {
    if (!add) {
      for (const k of this.cellsOf.get(c.id) ?? []) this.grid.get(k)?.delete(c.id);
      this.cellsOf.delete(c.id);
      return;
    }
    const pts = [c.curve.p0, c.curve.p1, c.curve.p2, c.curve.p3];
    const pad = 40;
    const x0 = Math.floor((Math.min(...pts.map((p) => p.x)) - pad) / CELL);
    const x1 = Math.floor((Math.max(...pts.map((p) => p.x)) + pad) / CELL);
    const y0 = Math.floor((Math.min(...pts.map((p) => p.y)) - pad) / CELL);
    const y1 = Math.floor((Math.max(...pts.map((p) => p.y)) + pad) / CELL);
    const keys: number[] = [];
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const k = cellKey(x, y);
        let set = this.grid.get(k);
        if (!set) this.grid.set(k, (set = new Set()));
        set.add(c.id);
        keys.push(k);
      }
    }
    this.cellsOf.set(c.id, keys);
  }

  private indexNode(n: LaneNode, add: boolean): void {
    const k = cellKey(Math.floor(n.pos.x / CELL), Math.floor(n.pos.y / CELL));
    if (add) {
      let set = this.nodeGrid.get(k);
      if (!set) this.nodeGrid.set(k, (set = new Set()));
      set.add(n.id);
    } else this.nodeGrid.get(k)?.delete(n.id);
  }

  /** Полотна, которые могут быть ближе r к точке (точно — проверяет вызывающий). */
  corridorsNear(p: Vec, r: number): Corridor[] {
    return this.corridorsInBox(p.x - r, p.y - r, p.x + r, p.y + r);
  }

  corridorsInBox(x0: number, y0: number, x1: number, y1: number): Corridor[] {
    const ids = new Set<number>();
    for (let x = Math.floor(x0 / CELL); x <= Math.floor(x1 / CELL); x++) {
      for (let y = Math.floor(y0 / CELL); y <= Math.floor(y1 / CELL); y++) for (const id of this.grid.get(cellKey(x, y)) ?? []) ids.add(id);
    }
    return [...ids].map((id) => this.corridors.get(id)!).filter(Boolean);
  }

  /** Узлы не дальше r от точки. */
  nodesNear(p: Vec, r: number): LaneNode[] {
    const res: LaneNode[] = [];
    for (let x = Math.floor((p.x - r) / CELL); x <= Math.floor((p.x + r) / CELL); x++) {
      for (let y = Math.floor((p.y - r) / CELL); y <= Math.floor((p.y + r) / CELL); y++) {
        for (const id of this.nodeGrid.get(cellKey(x, y)) ?? []) {
          const n = this.nodes.get(id);
          if (n && dist(n.pos, p) <= r) res.push(n);
        }
      }
    }
    return res;
  }

  node(id: number): LaneNode {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`Нет узла ${id}`);
    return n;
  }

  corridor(id: number): Corridor {
    const c = this.corridors.get(id);
    if (!c) throw new Error(`Нет полотна ${id}`);
    return c;
  }

  /** Точка стыка со сдвигом вбок. */
  portPos(n: LaneNode, port: number): Vec {
    return port ? add(n.pos, scale(rightNormal(n.dir), port)) : n.pos;
  }

  /**
   * Полотно между узлами. Без своей формы — кривая, касательная к стыкам (у перекрёстка —
   * по хорде или dirA/dirB). Полосы без `to` идут до конца полотна.
   */
  addCorridor(a: number, b: number, o: CorridorOptions): Corridor {
    const A = this.node(a);
    const B = this.node(b);
    const portA = A.kind === 'seam' ? (o.portA ?? 0) : 0;
    const portB = B.kind === 'seam' ? (o.portB ?? 0) : 0;
    const p0 = this.portPos(A, portA);
    const p3 = this.portPos(B, portB);
    let curve = o.curve ? { ...o.curve, p0, p3 } : null;
    if (!curve) {
      const chord = sub(p3, p0);
      const h = len(chord) / 3;
      // Тело полотна со стороны sideA от стыка a; у b — со стороны sideB, значит въезжает в b против неё.
      const side = (n: LaneNode, given: 1 | -1 | undefined, toward: Vec) => given ?? (dot(n.dir, toward) >= 0 ? 1 : -1);
      const t0 = A.kind === 'seam' ? scale(A.dir, side(A, o.sideA, chord)) : norm(o.dirA ?? chord);
      const t3 = B.kind === 'seam' ? scale(B.dir, -side(B, o.sideB, scale(chord, -1))) : norm(o.dirB ?? chord);
      curve = { p0, p1: add(p0, scale(t0, h)), p2: sub(p3, scale(t3, h)), p3 };
    }
    const lut = new CurveLUT(curve);
    const c: Corridor = {
      id: this.nextId++,
      a,
      b,
      portA,
      portB,
      curve,
      lut,
      length: lut.length,
      cls: o.cls,
      lanes: o.lanes.map((l) => ({ ...l, from: Math.max(0, l.from), to: Math.min(lut.length, l.to) })),
      rev: this.nextRev++,
    };
    if (o.limit !== undefined) c.limit = o.limit;
    if (o.ring) c.ring = true;
    this.corridors.set(c.id, c);
    this.indexCorridor(c, true);
    A.corridors.push(c.id);
    if (b !== a) B.corridors.push(c.id);
    this.version++;
    return c;
  }

  /** Убирает полотно; узлы, у которых не осталось полотен, — тоже (если не keepNodes). */
  removeCorridor(id: number, keepNodes = false): void {
    const c = this.corridors.get(id);
    if (!c) return;
    this.indexCorridor(c, false);
    this.corridors.delete(id);
    for (const nid of [c.a, c.b]) {
      const n = this.nodes.get(nid);
      if (!n) continue;
      n.corridors = n.corridors.filter((x) => x !== id);
      if (!n.corridors.length && !keepNodes) this.removeNode(nid);
    }
    this.version++;
  }

  /** Убирает узел (его полотна должны быть уже убраны). */
  removeNode(id: number): void {
    const n = this.nodes.get(id);
    if (!n) return;
    this.indexNode(n, false);
    this.nodes.delete(id);
    this.version++;
  }

  /** Полотно поменялось без смены формы (класс, кольцо) — отрисовке пора пересчитать. */
  touch(c: Corridor): void {
    c.rev = this.nextRev++;
    this.version++;
  }

  /** Новая форма полотна: отрезки полос растягиваются вместе с ним. */
  setCurve(c: Corridor, curve: Cubic): void {
    const old = c.length;
    this.indexCorridor(c, false);
    c.curve = curve;
    c.lut = new CurveLUT(curve);
    c.length = c.lut.length;
    this.indexCorridor(c, true);
    const k = c.length / old;
    c.lanes = c.lanes.map((l) => ({ ...l, from: l.from <= 0.01 ? 0 : l.from * k, to: l.to >= old - 0.01 ? c.length : l.to * k }));
    this.touch(c);
  }

  setLanes(c: Corridor, lanes: LaneSlot[]): void {
    c.lanes = lanes.map((l) => ({ ...l, from: Math.max(0, l.from), to: Math.min(c.length, l.to) }));
    this.touch(c);
  }

  /**
   * Двигает узел, концы его полотен — следом. У стыка с дорогами по обе стороны касательная общая —
   * управляющие точки сдвигаются вместе с ним. Прямые полотна у перекрёстков и тупиков остаются прямыми
   * (от стыка на дальнем конце — плавно выгибаются к узлу), изогнутые держат форму; тупики поворачиваются вслед за дорогой.
   */
  moveNode(id: number, pos: Vec): void {
    const n = this.node(id);
    const delta = sub(pos, n.pos);
    const pinned = (m: LaneNode) => m.kind === 'seam' && !this.isDeadEnd(m);
    const ends = this.ends(n);
    const straight = new Set(ends.filter((e) => isStraight(e.corridor.curve)).map((e) => e.corridor.id));
    // Тупики одной дороги (этот узел и дальние концы) и с какой стороны у них дорога — до переноса.
    const deadSide = new Map<LaneNode, 1 | -1>();
    for (const m of [n, ...ends.map((e) => this.node(e.end === 'a' ? e.corridor.b : e.corridor.a))]) {
      if (!this.isDeadEnd(m) || m.corridors.length !== 1) continue;
      const [me] = this.ends(m);
      if (!me.port) deadSide.set(m, me.side);
    }
    this.indexNode(n, false);
    n.pos = { ...pos };
    this.indexNode(n, true);
    const done = new Set<number>();
    for (const e of ends) {
      const c = e.corridor;
      if (done.has(c.id)) continue;
      done.add(c.id);
      const cv = { ...c.curve };
      // Петля из узла в него же — сдвигается целиком.
      if (c.a === c.b) {
        this.setCurve(c, { p0: add(cv.p0, delta), p1: add(cv.p1, delta), p2: add(cv.p2, delta), p3: add(cv.p3, delta) });
        continue;
      }
      const atA = e.end === 'a';
      const far = this.node(atA ? c.b : c.a);
      const near = add(atA ? cv.p0 : cv.p3, delta);
      const farPt = atA ? cv.p3 : cv.p0;
      const farCtl = atA ? cv.p2 : cv.p1;
      let nearCtl: Vec;
      if (pinned(n) || e.port) nearCtl = add(atA ? cv.p1 : cv.p2, delta);
      else if (straight.has(c.id) && !pinned(far) && !(atA ? c.portB : c.portA)) {
        // Прямая так и остаётся прямой: управляющие точки — на трети хорды.
        const third = scale(sub(farPt, near), 1 / 3);
        nearCtl = add(near, third);
        if (atA) cv.p2 = sub(farPt, third);
        else cv.p1 = sub(farPt, third);
      } else if (straight.has(c.id)) nearCtl = add(near, scale(sub(farCtl, near), 0.5));
      else nearCtl = add(atA ? cv.p1 : cv.p2, delta);
      if (atA) {
        cv.p0 = near;
        cv.p1 = nearCtl;
      } else {
        cv.p3 = near;
        cv.p2 = nearCtl;
      }
      this.setCurve(c, cv);
    }
    // Тупик смотрит туда же, куда его дорога.
    for (const [m, side] of deadSide) m.dir = scale(this.ends(m)[0].away, side);
    this.version++;
  }

  toJSON(): LaneNetSave {
    return {
      nextId: this.nextId,
      nodes: [...this.nodes.values()].map(({ corridors: _, ...n }) => ({ ...n, pos: { ...n.pos }, dir: { ...n.dir } })),
      corridors: [...this.corridors.values()].map(({ lut: _l, length: _n, rev: _r, ...c }) => ({ ...c, curve: { ...c.curve }, lanes: c.lanes.map((l) => ({ ...l })) })),
    };
  }

  static fromJSON(data: LaneNetSave): LaneNet {
    const net = new LaneNet();
    net.nextId = data.nextId;
    for (const n of data.nodes) {
      const node = { ...n, pos: { ...n.pos }, dir: { ...n.dir }, corridors: [] };
      net.nodes.set(n.id, node);
      net.indexNode(node, true);
    }
    for (const c of data.corridors) {
      const lut = new CurveLUT(c.curve);
      const corridor: Corridor = { ...c, curve: { ...c.curve }, lut, length: lut.length, lanes: c.lanes.map((l) => ({ ...l })), rev: net.nextRev++ };
      net.corridors.set(c.id, corridor);
      net.indexCorridor(corridor, true);
      net.node(c.a).corridors.push(c.id);
      if (c.b !== c.a) net.node(c.b).corridors.push(c.id);
    }
    net.version = 1;
    return net;
  }

  /**
   * Копия для предпросмотра: свои объекты узлов и полотен, но общие (неизменяемые) кривые,
   * таблицы длин и списки полос — копировать большую сеть дёшево. Правки копии заменяют эти
   * поля целиком, не трогая оригинал. Номера ревизий сохраняются — отрисовка переиспользует кэш.
   */
  clone(): LaneNet {
    const net = new LaneNet();
    net.nextId = this.nextId;
    net.nextRev = this.nextRev;
    net.version = this.version;
    for (const [id, n] of this.nodes) net.nodes.set(id, { ...n, corridors: [...n.corridors] });
    for (const [id, c] of this.corridors) net.corridors.set(id, { ...c });
    for (const [k, set] of this.grid) net.grid.set(k, new Set(set));
    for (const [id, keys] of this.cellsOf) net.cellsOf.set(id, keys);
    for (const [k, set] of this.nodeGrid) net.nodeGrid.set(k, new Set(set));
    return net;
  }

  /** Конец полотна: где, куда смотрит, с какой стороны стыка. */
  end(c: Corridor, end: End): CorridorEnd {
    const node = this.node(end === 'a' ? c.a : c.b);
    const s = end === 'a' ? 0 : c.length;
    const t = c.lut.tangentAt(s);
    const away = end === 'a' ? t : scale(t, -1);
    return {
      corridor: c,
      end,
      node,
      pos: c.lut.pointAt(s),
      away,
      along: dot(t, node.dir) >= 0 ? 1 : -1,
      side: dot(away, node.dir) >= 0 ? 1 : -1,
      port: end === 'a' ? c.portA : c.portB,
    };
  }

  ends(n: LaneNode): CorridorEnd[] {
    const res: CorridorEnd[] = [];
    for (const id of n.corridors) {
      const c = this.corridor(id);
      // Петля из узла в него же — два конца.
      if (c.a === n.id) res.push(this.end(c, 'a'));
      if (c.b === n.id) res.push(this.end(c, 'b'));
    }
    return res;
  }

  /** Полоса доходит до конца полотна на полную ширину. */
  reaches(c: Corridor, lane: LaneSlot, end: End): boolean {
    return end === 'a' ? lane.from <= 0.01 : lane.to >= c.length - 0.01;
  }

  /** Полоса на конце в стыке: поперечная координата и едет ли она по `dir` стыка. */
  laneAtSeam(e: CorridorEnd, lane: LaneSlot): { lat: number; forward: boolean } {
    return { lat: e.port + lane.offset * e.along, forward: lane.flow * e.along > 0 };
  }

  /**
   * Продолжение полосы через стык на конце end: полоса по другую сторону стыка с той же
   * поперечной координатой и тем же направлением движения. Нет стыка или продолжения — null.
   */
  across(c: Corridor, laneIdx: number, end: End): { corridor: Corridor; lane: number; end: End } | null {
    const lane = c.lanes[laneIdx];
    if (!lane || !this.reaches(c, lane, end)) return null;
    const e = this.end(c, end);
    if (e.node.kind !== 'seam') return null;
    const me = this.laneAtSeam(e, lane);
    for (const o of this.ends(e.node)) {
      if (o.side === e.side) continue;
      const oc = o.corridor;
      for (let i = 0; i < oc.lanes.length; i++) {
        if (!this.reaches(oc, oc.lanes[i], o.end)) continue;
        const it = this.laneAtSeam(o, oc.lanes[i]);
        if (it.forward === me.forward && Math.abs(it.lat - me.lat) < LAT_EPS) return { corridor: oc, lane: i, end: o.end };
      }
    }
    return null;
  }

  /** Высота полотна в точке оси s: от уровня узла a к уровню узла b (пандус) — равномерно. */
  heightAt(c: Corridor, s: number): number {
    const la = this.node(c.a).level;
    const lb = this.node(c.b).level;
    return la + (lb - la) * Math.max(0, Math.min(1, s / c.length));
  }

  /** Полотно без подъёма: оба конца на одном уровне. */
  isFlat(c: Corridor): boolean {
    return this.node(c.a).level === this.node(c.b).level;
  }

  /** Тупик: у стыка занята только одна сторона. */
  isDeadEnd(n: LaneNode): boolean {
    if (n.kind !== 'seam') return false;
    const sides = new Set(this.ends(n).map((e) => e.side));
    return sides.size === 1;
  }

  /**
   * Что не так с сетью: полоса упирается в стык без продолжения, полотно не касается стыка,
   * дыра в профиле. Пусто — всё в порядке.
   */
  problems(): string[] {
    const res: string[] = [];
    for (const c of this.corridors.values()) {
      for (const end of ['a', 'b'] as const) {
        const e = this.end(c, end);
        if (e.node.kind !== 'seam') continue;
        if (Math.abs(dot(e.away, e.node.dir)) < 0.999) res.push(`Полотно ${c.id} не касается стыка ${e.node.id}`);
        if (this.isDeadEnd(e.node)) continue;
        c.lanes.forEach((l, i) => {
          if (this.reaches(c, l, end) && !this.across(c, i, end)) res.push(`Полоса ${i} полотна ${c.id} обрывается в стыке ${e.node.id}`);
        });
      }
      const offs = c.lanes.map((l) => l.offset).sort((x, y) => x - y);
      for (let i = 1; i < offs.length; i++) {
        if (offs[i] - offs[i - 1] < LANE_W - 0.01) res.push(`Полосы полотна ${c.id} налезают друг на друга`);
      }
    }
    return res;
  }

  /** Полотно, ось которого ближе всего к точке (не дальше radius) — для выбора мышью. */
  corridorNear(p: Vec, radius: number): Corridor | null {
    let best: Corridor | null = null;
    let bestD = radius;
    for (const c of this.corridorsNear(p, radius)) {
      const d = dist(p, c.lut.closest(p).point);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }
}

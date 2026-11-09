import { CAR_WIDTH, LIGHTS } from '../config';
import { add, angleDiff, angleOf, cubicBezier, dist, dot, scale, segSegDist, sub, Vec } from '../core/vec';
import type { Vehicle } from '../sim/vehicle';
import { KMH_PER_UNIT, ROAD_CLASSES } from '../world/roadTypes';
import { filletPath, junctionCuts } from './geometry';
import { phaseRelations, resolvePhases, SignalHead, signalHeads, turnKey } from './lights';
import { Corridor, CorridorEnd, End, Flow, LaneLink, LaneNet, LaneNode, parseLaneKey, taperLen } from './model';
import { autoSolids } from './solid';

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
  /** Линия к соседу справа (index + 1) сплошная — через неё не перестраиваются. */
  solidRight: boolean;
  /**
   * Где ещё линия к соседу справа сплошная сама (у развилки, после вливания, перед перекрёстком — `autoSolids`):
   * отрезки [от, до] по полосе от её начала по ходу движения. Там тоже не перестраиваются.
   */
  solidZones?: [number, number][];
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

/** Как два манёвра узла мешают друг другу: сливаются в одну полосу, пересекаются или расходятся из одной. */
export type ConflictKind = 'merge' | 'cross' | 'diverge';

/**
 * Распределяет полосы въезда по выездам. Выезды отсортированы справа налево, полосы считаются справа.
 * Возвращает для каждого выезда пары [полоса въезда справа, полоса выезда справа].
 */
export function assignLanes(inCount: number, exits: { count: number; theta: number; uTurn: boolean }[]): [number, number][][] {
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

/** Фаза светофора в графе: манёвры с зелёным, кто из них кому уступает, сколько горит. */
export interface LightPhase {
  /** Повороты фазы (`${полотно въезда}>${полотно выезда}`) — как в настройке узла. */
  go: string[];
  /** Манёвры (ключи GMove) с зелёным. */
  moves: Set<string>;
  /** Кому манёвр уступает (налево на общий зелёный — встречным); нет в списке — едет, никого не пропуская. */
  yields: Map<string, Set<string>>;
  /** Пересекающиеся потоки, которым уступать некому, — так фаза быть не может (едут по очереди). */
  clashes: [string, string][];
  green: number;
  /** Повороты, которых игрок не дал ни в одну фазу, — своя фаза «Авто». */
  extra?: boolean;
}

/** Светофор: фазы по кругу, между ними — жёлтый (clearing); секции светофора у каждого въезда. */
export interface LightState {
  phases: LightPhase[];
  phase: number;
  timer: number;
  clearing: boolean;
  heads: SignalHead[];
}

/** Перекрёсток или тупик во время движения: кто проезжает, кто ждёт, кто главный, светофор. */
export interface GNode {
  id: number;
  pos: Vec;
  priorityLanes: Set<number>;
  reserved: Vehicle[];
  waiting: Vehicle[];
  lights: LightState | null;
}

export const laneSpeed = (c: Corridor) => (c.limit ?? ROAD_CLASSES[c.cls].limit) / KMH_PER_UNIT;
/** Скорость манёвра в перекрёстке по радиусу поворота r (ед./с): шире — быстрее, не медленнее 5. */
export const turnSpeed = (r: number) => Math.max(5, Math.sqrt(9 * Math.max(2, r)));
export const moveKey = (inLane: number, outLane: number) => `${inLane}>${outLane}`;

/**
 * «Авто» — главная дорога перекрёстка сама: из почти прямых проездов через узел (излом до 0,6 рад)
 * самый вместительный (полосы × скорость), при равенстве — самый прямой. Дорог меньше трёх — главной нет.
 */
export function autoMainPair(ends: CorridorEnd[]): [number, number] | null {
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

/**
 * Главная дорога перекрёстка по настройке узла (как `mainPair`): пара полотен — она,
 * [] — равнозначный (null), не задано — «Авто». Пара не из этого узла (перестроили) — тоже «Авто».
 */
export function mainPairOf(ends: CorridorEnd[], choice: number[] | null | undefined): [number, number] | null {
  if (choice && choice.length === 0) return null;
  const here = new Set(ends.map((e) => e.corridor.id));
  if (choice && choice.length === 2 && choice.every((id) => here.has(id))) return [choice[0], choice[1]];
  return autoMainPair(ends);
}

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
  /** Манёвры каждого перекрёстка (без продолжений полос). */
  readonly junctionMoves = new Map<number, GMove[]>();
  /** Связи каждого полотна по ходу оси. */
  private readonly byCorridor = new Map<number, { flow: Flow; links: GLink[] }[]>();
  private nextId = 1;
  /** Манёвры каждого перекрёстка и тупика — чтобы следующий граф узнал узлы, где ничего не поменялось. */
  private readonly nodeMoves = new Map<number, GMove[]>();

  /** Номер графа и того, из которого он пересобран (prev): соответствия ниже — только к тому графу. */
  readonly serial = ++graphSerial;
  readonly prevSerial: number | null;
  /**
   * Связи и полосы, оставшиеся как были в prev (то же полотно той же формы, тот же отрезок оси, те же полосы):
   * id в prev → id здесь. Номера в графах свои, а полотна сохраняют номера — по ним и узнаются.
   */
  readonly linkFromPrev = new Map<number, number>();
  readonly laneFromPrev = new Map<number, number>();
  /** Перекрёстки и тупики, где всё как было в prev: те же манёвры (полосы и кривые), главная дорога и светофор. */
  readonly sameNodes = new Set<number>();
  /** Прежний граф — только пока строится этот (ссылку не держим: иначе цепочка всех графов). */
  private prev: LaneGraph | null;
  /**
   * С чего собран граф: полотна и настройки узлов — копией на момент сборки. Сеть правят и на месте (запреты, фазы
   * светофора, связи полос — в том же объекте узла), так что сверять следующему графу можно только с копией.
   */
  private readonly shapes = new Map<number, CorridorShape>();
  private readonly nodeShapes = new Map<number, NodeShape>();
  /** Обрезы полотен у перекрёстков, по которым собран граф, и номера (id), что заняли связи и полосы каждого полотна. */
  private readonly cutsOf = new Map<number, [number, number]>();
  private readonly idRange = new Map<number, [number, number]>();

  /**
   * cuts — обрезы у перекрёстков, если уже посчитаны по сети побольше (граф куска сети для предпросмотра).
   * prev — прежний граф той же игры: что не поменялось, узнаётся по нему (linkFromPrev, sameNodes), а конфликты
   * манёвров у прежних перекрёстков берутся готовыми — это почти вся сборка графа.
   */
  constructor(
    readonly net: LaneNet,
    cuts: Map<number, [number, number]> = junctionCuts(net),
    prev: LaneGraph | null = null,
  ) {
    this.prev = prev;
    this.prevSerial = prev?.serial ?? null;
    for (const c of net.corridors.values()) this.shapes.set(c.id, shapeOfCorridor(net, c));
    for (const n of net.nodes.values()) {
      const { kind, pos, dir } = n;
      const rules = `${n.control ?? ''}|${n.mainPair === undefined ? '-' : n.mainPair === null ? 'null' : n.mainPair.join(',')}`;
      this.nodeShapes.set(n.id, { kind, corridors: [...n.corridors], pos: [pos.x, pos.y, dir.x, dir.y], rules, lanes: n.lanes && [...n.lanes], bans: n.bans && [...n.bans] });
    }
    for (const c of net.corridors.values()) {
      const cut = cuts.get(c.id)!;
      const start = this.nextId;
      if (!this.copyCorridor(c, cut)) this.buildCorridor(c, ...cut);
      this.idRange.set(c.id, [start, this.nextId]);
      this.cutsOf.set(c.id, cut);
    }
    for (const c of net.corridors.values()) this.linkSeams(c);
    // Въезды и выезды узлов — одним проходом, а не перебором всех связей у каждого узла.
    const ins = new Map<number, GLink[]>();
    const outs = new Map<number, GLink[]>();
    for (const l of this.links.values()) {
      if (l.toNode !== null) push(ins, l.toNode, l);
      if (l.fromNode !== null) push(outs, l.fromNode, l);
    }
    for (const n of net.nodes.values()) {
      if (n.kind === 'junction') this.buildJunction(n, ins.get(n.id) ?? [], outs.get(n.id) ?? []);
      else if (net.isDeadEnd(n)) this.buildDeadEnd(n, ins.get(n.id) ?? [], outs.get(n.id) ?? []);
    }
    this.buildIndexes();
    this.prev = null;
  }

  /** Положение на полосе: u — пройдено от начала полосы по ходу движения. */
  lanePose(lane: GLane, u: number): { pos: Vec; dir: Vec } {
    const link = this.links.get(lane.link)!;
    const c = this.net.corridor(link.corridor);
    const s = link.flow > 0 ? link.s0 + u : link.s1 - u;
    // Как pointOff(c, s, lane.offset) и tangentAt(s), но точка и касательная — за один поиск по кривой.
    const { point: p, tangent: t } = c.lut.frameAt(s);
    const off = lane.offset;
    return { pos: off ? { x: p.x + -t.y * off, y: p.y + t.x * off } : p, dir: { x: t.x * link.flow, y: t.y * link.flow } };
  }

  /** s на оси полотна для положения u на полосе. */
  axisS(lane: GLane, u: number): number {
    const link = this.links.get(lane.link)!;
    return link.flow > 0 ? link.s0 + u : link.s1 - u;
  }

  /** Связи полотна (обоих направлений). */
  corridorLinks(id: number): GLink[] {
    return (this.byCorridor.get(id) ?? []).flatMap((g) => g.links);
  }

  /** Поворот манёвра — `${полотно въезда}>${полотно выезда}`, как в запретах и фазах светофора. */
  turnOf(m: GMove): string {
    return turnKey(this.links.get(m.inLink)?.corridor ?? -1, this.links.get(m.outLink)?.corridor ?? -1);
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
    // Полоса, что начинается или кончается отгоном («кармашек» у остановки, полосы торможения и разгона), есть и
    // на половине отгона: в неё перестраиваются с середины отгона, а из неё — до середины, как в жизни.
    const half = taperLen(c.cls) / 2;
    const spans = c.lanes.map((l) => ({
      from: l.from > 0.5 ? Math.max(0, l.from - half) : l.from,
      to: l.to < c.length - 0.5 ? Math.min(c.length, l.to + half) : l.to,
    }));
    const marks = [s0, s1];
    for (const l of spans) for (const x of [l.from, l.to]) if (x > s0 + 0.5 && x < s1 - 0.5) marks.push(x);
    marks.sort((x, y) => x - y);
    const cuts = marks.filter((x, i) => i === 0 || x - marks[i - 1] > 0.5);
    const speed = laneSpeed(c);
    const groups: { flow: Flow; links: GLink[] }[] = [];
    for (const flow of [1, -1] as const) {
      const links: GLink[] = [];
      for (let k = 0; k + 1 < cuts.length; k++) {
        const [a, b] = [cuts[k], cuts[k + 1]];
        const present = c.lanes.map((l, i) => ({ l, i })).filter(({ l, i }) => l.flow === flow && spans[i].from <= a + 0.5 && spans[i].to >= b - 0.5);
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
        link.lanes = present.map(({ l, i }, index) => {
          // Сплошную задаёт полоса с меньшим смещением из пары соседей.
          const next = present[index + 1]?.l;
          const solidRight = !!next && (l.offset < next.offset ? !!l.solid : !!next.solid);
          const lane: GLane = { id: this.nextId++, link: link.id, index, laneIdx: i, offset: l.offset, side: l.offset * flow, solidRight, length: link.length, speed, vehicles: [] };
          // Сплошная, которую дорога рисует сама, — там же, где она нарисована (по оси — в отрезки по полосе).
          const j = present[index + 1]?.i;
          if (j !== undefined) {
            const zones = autoSolids(this.net, c, l.offset < c.lanes[j].offset ? i : j, l.offset < c.lanes[j].offset ? j : i, s0, s1)
              .map(([u, v]) => [Math.max(u, a), Math.min(v, b)])
              .filter(([u, v]) => v - u > 0.01)
              .map(([u, v]) => (flow > 0 ? [u - a, v - a] : [b - v, b - u]) as [number, number]);
            if (zones.length) lane.solidZones = zones;
          }
          return lane;
        });
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
    if (this.prev) this.matchPrev(c, groups);
  }

  /**
   * Связи и полосы полотна копией прежних (prev), если строить их не из чего нового: полотно той же формы, с теми же
   * обрезами, а узлы на его концах — те же (вид, место, полотна; у стыка — и полотна по ту сторону той же формы: от них
   * сплошные у развилки). Номера — те же, что дала бы сборка заново: со сдвигом на начало полотна в этом графе.
   * Не вышло — false (полотно строится заново).
   */
  private copyCorridor(c: Corridor, cut: [number, number]): boolean {
    const prev = this.prev;
    const range = prev?.idRange.get(c.id);
    const was = prev?.byCorridor.get(c.id);
    const wasCut = prev?.cutsOf.get(c.id);
    if (!prev || !range || !was || !wasCut || wasCut[0] !== cut[0] || wasCut[1] !== cut[1]) return false;
    const shape = prev.shapes.get(c.id);
    if (!shape || !sameShape(shape, this.shapes.get(c.id)!)) return false;
    for (const id of [c.a, c.b]) {
      const a = prev.nodeShapes.get(id);
      const b = this.nodeShapes.get(id)!;
      if (!a || a.kind !== b.kind || !sameList(a.pos, b.pos) || !sameList(a.corridors, b.corridors)) return false;
      if (b.kind === 'seam' && !b.corridors.every((o) => sameShape(prev.shapes.get(o) ?? [], this.shapes.get(o)!))) return false;
    }
    const shift = this.nextId - range[0];
    const groups: { flow: Flow; links: GLink[] }[] = [];
    for (const g of was) {
      const links = g.links.map((o) => {
        const link: GLink = { ...o, id: o.id + shift, lanes: [] };
        link.lanes = o.lanes.map((l) => ({ ...l, id: l.id + shift, link: link.id, vehicles: [] }));
        this.links.set(link.id, link);
        this.linkFromPrev.set(o.id, link.id);
        for (let i = 0; i < link.lanes.length; i++) {
          this.lanes.set(link.lanes[i].id, link.lanes[i]);
          this.laneFromPrev.set(o.lanes[i].id, link.lanes[i].id);
        }
        return link;
      });
      groups.push({ flow: g.flow, links });
      // Продолжения полос внутри полотна — копией прежних, в том же порядке.
      const along = g.flow > 0 ? g.links : [...g.links].reverse();
      for (let k = 0; k + 1 < along.length; k++) {
        for (const lane of along[k].lanes) {
          for (const m of prev.movesFrom.get(lane.id) ?? []) {
            if (!m.cont || m.outLink !== along[k + 1].id) continue;
            this.addMove({ ...m, key: moveKey(m.inLane + shift, m.outLane + shift), inLane: m.inLane + shift, outLane: m.outLane + shift, inLink: m.inLink + shift, outLink: m.outLink + shift, conflicts: new Map(), zones: new Map(), vehicles: [] });
          }
        }
      }
    }
    this.byCorridor.set(c.id, groups);
    this.nextId += range[1] - range[0];
    return true;
  }

  /**
   * Связи полотна, оставшиеся как в прежнем графе: полотно той же формы (и те же высоты концов), связь — на том же
   * отрезке оси в ту же сторону и с теми же полосами (смещения, сплошные, длины, скорость).
   */
  private matchPrev(c: Corridor, groups: { flow: Flow; links: GLink[] }[]): void {
    const prev = this.prev!;
    const was = prev.shapes.get(c.id);
    if (!was || !sameShape(was, this.shapes.get(c.id)!)) return;
    const before = prev.byCorridor.get(c.id) ?? [];
    for (const g of groups) {
      const old = before.find((x) => x.flow === g.flow)?.links ?? [];
      for (const link of g.links) {
        const o = old.find((x) => x.s0 === link.s0 && x.s1 === link.s1);
        if (!o || o.speed !== link.speed || o.lanes.length !== link.lanes.length || !o.lanes.every((l, i) => sameLane(l, link.lanes[i]))) continue;
        this.linkFromPrev.set(o.id, link.id);
        o.lanes.forEach((l, i) => this.laneFromPrev.set(l.id, link.lanes[i].id));
      }
    }
  }

  /**
   * Те же манёвры, что у узла в прежнем графе (was), по порядку: с той же полосы на ту же (полосы — из оставшихся как
   * были) по той же кривой. Тогда и конфликты между ними те же.
   */
  private sameMoves(was: GMove[] | undefined, list: GMove[]): was is GMove[] {
    if (!was || was.length !== list.length) return false;
    for (let i = 0; i < list.length; i++) {
      const a = was[i];
      const b = list[i];
      if (a.length !== b.length || a.speed !== b.speed || a.points.length !== b.points.length) return false;
      if (this.laneFromPrev.get(a.inLane) !== b.inLane || this.laneFromPrev.get(a.outLane) !== b.outLane) return false;
      for (let k = 0; k < a.points.length; k++) if (a.points[k].x !== b.points[k].x || a.points[k].y !== b.points[k].y) return false;
    }
    return true;
  }

  /** Узел как в прежнем графе: те же манёвры (sameMoves уже проверен), та же главная дорога и тот же светофор. */
  private sameRules(was: GNode, now: GNode): boolean {
    if (was.priorityLanes.size !== now.priorityLanes.size) return false;
    for (const id of was.priorityLanes) if (!now.priorityLanes.has(this.laneFromPrev.get(id) ?? -1)) return false;
    const a = was.lights;
    const b = now.lights;
    if (!a || !b) return !a && !b;
    if (a.phases.length !== b.phases.length) return false;
    const key = (k: string) => {
      const [i, o] = k.split('>').map(Number);
      return moveKey(this.laneFromPrev.get(i) ?? -1, this.laneFromPrev.get(o) ?? -1);
    };
    return a.phases.every((p, i) => {
      const q = b.phases[i];
      return p.green === q.green && p.moves.size === q.moves.size && [...p.moves].every((k) => q.moves.has(key(k)));
    });
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
      g = { id: n.id, pos: n.pos, priorityLanes: new Set(), reserved: [], waiting: [], lights: null };
      this.nodes.set(n.id, g);
    }
    return g;
  }

  /** Манёвры перекрёстка: полосы въездов распределяются по выездам, как раньше; главная дорога — самая прямая и широкая. */
  private buildJunction(n: LaneNode, ins: GLink[], outs: GLink[]): void {
    const state = this.nodeState(n);
    const copied = this.copyMoves(n, ins, outs);
    const list = copied ?? this.junctionMovesOf(n, ins, outs);
    this.junctionConflicts(n, state, ins, list, !!copied);
  }

  /** Манёвры перекрёстка заново: полосы въездов по выездам (или по связям полос, заданным игроком). */
  private junctionMovesOf(n: LaneNode, ins: GLink[], outs: GLink[]): GMove[] {
    const list: GMove[] = [];
    // Связи полос, заданные игроком: полоса въезда (полотно.номер справа) → куда.
    const custom = new Map<string, LaneLink[]>();
    for (const key of n.lanes ?? []) {
      const l = parseLaneKey(key);
      if (l) push(custom, `${l.from}.${l.i}`, l);
    }
    const turn = (inL: GLink, lane: GLane, out: GLink, outLane: GLane) => this.turn(n.id, inL, lane, out, outLane);
    for (const inL of ins) {
      // Настроенные полосы — только по своим связям.
      inL.lanes.forEach((lane, idx) => {
        for (const l of custom.get(`${inL.corridor}.${inL.lanes.length - 1 - idx}`) ?? []) {
          const out = outs.find((o) => o.corridor === l.to && o.corridor !== inL.corridor);
          const outLane = out?.lanes[out.lanes.length - 1 - l.j];
          if (out && outLane) list.push(turn(inL, lane, out, outLane));
        }
      });
      const inDir = this.lanePose(inL.lanes[0], inL.length).dir;
      const exits = outs
        // Разворот на то же полотно и повороты, запрещённые игроком, — нельзя.
        .filter((o) => o.corridor !== inL.corridor && !n.bans?.includes(`${inL.corridor}>${o.corridor}`))
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
          if (custom.has(`${inL.corridor}.${fromRight}`)) continue;
          list.push(turn(inL, inL.lanes[inL.lanes.length - 1 - fromRight], e.link, e.link.lanes[e.link.lanes.length - 1 - outFromRight]));
        }
      });
    }
    return list;
  }

  /**
   * Манёвры узла копией прежних (prev), если строить их не из чего нового: те же полотна узла, запреты поворотов
   * и связи полос, а въезды и выезды — те же связи (как были, в том же порядке). Иначе null.
   */
  private copyMoves(n: LaneNode, ins: GLink[], outs: GLink[]): GMove[] | null {
    const prev = this.prev;
    const was = prev?.nodeMoves.get(n.id);
    const before = prev?.nodeShapes.get(n.id);
    const now = this.nodeShapes.get(n.id)!;
    if (!prev || !was || !before || before.kind !== now.kind || !sameList(before.corridors, now.corridors)) return null;
    if (!sameList(before.lanes, now.lanes) || !sameList(before.bans, now.bans)) return null;
    const same = (a: GLink[], b: GLink[]) => a.length === b.length && a.every((l, i) => this.linkFromPrev.get(l.id) === b[i].id);
    if (!same(prev.inLinks.get(n.id) ?? [], ins) || !same(prev.outLinks.get(n.id) ?? [], outs)) return null;
    return was.map((m) => {
      const inLane = this.laneFromPrev.get(m.inLane)!;
      const outLane = this.laneFromPrev.get(m.outLane)!;
      const copy: GMove = {
        ...m,
        key: moveKey(inLane, outLane),
        inLane,
        outLane,
        inLink: this.linkFromPrev.get(m.inLink)!,
        outLink: this.linkFromPrev.get(m.outLink)!,
        conflicts: new Map(),
        zones: new Map(),
        vehicles: [],
      };
      this.addMove(copy);
      return copy;
    });
  }

  /** Конфликты манёвров перекрёстка, его главная дорога или светофор; узел как был — в sameNodes. */
  private junctionConflicts(n: LaneNode, state: GNode, ins: GLink[], list: GMove[], copied: boolean): void {
    const was = this.prev?.nodeMoves.get(n.id);
    const same = this.sameMoves(was, list);
    if (same && list.every((m, k) => m.key === was[k].key)) {
      // Узел как был, и даже номера полос те же (правка — дальше по списку полотен): те же словари конфликтов — общими
      // (после сборки графа их не меняют).
      list.forEach((m, k) => {
        m.conflicts = was[k].conflicts;
        m.zones = was[k].zones;
      });
    } else if (same) {
      // Узел как был: конфликты — те же, что в прежнем графе (по номерам манёвров в списке, в том же порядке).
      const index = new Map(was.map((m, i) => [m.key, i]));
      for (let k = 0; k < list.length; k++) {
        for (const [key, kind] of was[k].conflicts) list[k].conflicts.set(list[index.get(key)!].key, kind);
        for (const [key, z] of was[k].zones) list[k].zones.set(list[index.get(key)!].key, [z[0], z[1]]);
      }
    } else {
      // Рамки манёвров с запасом — пары, которые заведомо не сближаются, отсеиваются сразу.
      const boxes = list.map((m) => boxOf(m.points, CONFLICT_GAP));
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const kind = conflictKind(list[i], list[j], boxes[i], boxes[j]);
          if (!kind) continue;
          list[i].conflicts.set(list[j].key, kind);
          list[j].conflicts.set(list[i].key, kind);
          if (kind !== 'cross') continue;
          list[i].zones.set(list[j].key, conflictZone(list[i], list[j]));
          list[j].zones.set(list[i].key, conflictZone(list[j], list[i]));
        }
      }
    }
    this.junctionMoves.set(n.id, list);
    this.nodeMoves.set(n.id, list);
    if (!(copied && this.copyPriority(n, state))) this.junctionRules(n, state, ins, list);
    const before = same && this.prev!.nodes.get(n.id);
    if (before && sameList(this.prev!.nodeShapes.get(n.id)?.corridors, n.corridors) && this.sameRules(before, state)) this.sameNodes.add(n.id);
  }

  /** Главная дорога перекрёстка или светофор. */
  /**
   * Главная дорога узла без светофора — копией прежней, если манёвры скопированы (copyMoves), а главная дорога
   * и светофор в настройках и все полотна узла (их направления, полосы, скорости — по ним выбирается «Авто») — те же.
   */
  private copyPriority(n: LaneNode, state: GNode): boolean {
    const prev = this.prev!;
    const before = prev.nodes.get(n.id);
    const a = prev.nodeShapes.get(n.id);
    const b = this.nodeShapes.get(n.id)!;
    if (n.control === 'lights' || !before || before.lights || !a || a.rules !== b.rules) return false;
    if (!b.corridors.every((id) => sameShape(prev.shapes.get(id) ?? [], this.shapes.get(id)!))) return false;
    for (const id of before.priorityLanes) state.priorityLanes.add(this.laneFromPrev.get(id)!);
    return true;
  }

  private junctionRules(n: LaneNode, state: GNode, ins: GLink[], list: GMove[]): void {
    // Светофор: фазы игрока или «Авто» (встречные подъезды вместе); главной дороги нет — решает свет.
    if (n.control === 'lights' && ins.length >= 2 && this.net.ends(n).length >= 3) {
      state.lights = this.buildLights(n, ins, list);
      return;
    }
    // Кольцо главнее въездов в него.
    const ring = ins.filter((l) => this.net.corridor(l.corridor).ring);
    if (ring.length && ring.length < ins.length) {
      for (const l of ring) for (const lane of l.lanes) state.priorityLanes.add(lane.id);
      return;
    }
    // Главная: выбранная игроком пара ([] — равнозначный) или самая прямая и вместительная.
    // Если главные все входы — приоритета нет.
    const main = mainPairOf(this.net.ends(n), n.mainPair);
    if (main) {
      for (const l of ins) if (main.includes(l.corridor)) for (const lane of l.lanes) state.priorityLanes.add(lane.id);
      if (ins.every((l) => main.includes(l.corridor))) state.priorityLanes.clear();
    }
  }

  /**
   * Светофор узла: фазы по настройке (`phases` игрока или «Авто» — src/lanes/lights.ts), в каждой — манёвры с зелёным,
   * кто кому уступает (налево на общий зелёный — встречным) и недопустимые пары; секции светофора у въездов.
   */
  private buildLights(n: LaneNode, ins: GLink[], list: GMove[]): LightState {
    const approaches = ins.map((l) => ({
      corridor: l.corridor,
      dir: this.lanePose(l.lanes[0], l.length).dir,
      turns: [...new Set(list.filter((m) => m.inLink === l.id).map((m) => this.turnOf(m)))],
    }));
    const resolved = resolvePhases(n.phases, approaches, n.greens);
    if (!resolved.length) resolved.push({ go: [], green: LIGHTS.green });
    const phases: LightPhase[] = resolved.map((p) => {
      const go = new Set(p.go);
      const moves = list.filter((m) => go.has(this.turnOf(m)));
      const { yields, clashes } = phaseRelations(moves);
      return { go: p.go, moves: new Set(moves.map((m) => m.key)), yields, clashes, green: p.green, ...(p.extra ? { extra: true } : {}) };
    });
    const heads = signalHeads(
      ins.map((l) => ({ link: l.id, moves: list.filter((m) => m.inLink === l.id) })),
      phases,
    );
    return { phases, phase: 0, timer: phases[0].green, clearing: false, heads };
  }

  /** Тупик: разворот с левой полосы въезда на левую полосу выезда того же полотна. */
  private buildDeadEnd(n: LaneNode, ins: GLink[], outs: GLink[]): void {
    const state = this.nodeState(n);
    let list = this.copyMoves(n, ins, outs);
    if (!list) {
      list = [];
      for (const inL of ins) {
        const out = outs.find((o) => o.corridor === inL.corridor);
        if (out) list.push(this.turn(n.id, inL, inL.lanes[0], out, out.lanes[0]));
      }
    }
    this.nodeMoves.set(n.id, list);
    const before = this.prev?.nodes.get(n.id);
    const same = before && this.sameMoves(this.prev!.nodeMoves.get(n.id), list) && sameList(this.prev!.nodeShapes.get(n.id)?.corridors, n.corridors);
    if (same && this.sameRules(before, state)) this.sameNodes.add(n.id);
  }

  /**
   * Манёвр от конца полосы въезда к началу полосы выезда: прямо, по дуге окружности (самой плавной, что помещается
   * между продолжениями полос) и снова прямо. Бордюр угла перекрёстка — дуга с тем же центром (`cornerCurb`), поэтому
   * поворот вдоль угла не съезжает с асфальта. Разворот и почти прямой проезд (продолжения полос не сходятся) — по кривой.
   */
  private turn(node: number, inL: GLink, inLane: GLane, outL: GLink, outLane: GLane): GMove {
    const a = this.lanePose(inLane, inLane.length);
    const b = this.lanePose(outLane, 0);
    const chord = dist(a.pos, b.pos);
    const uTurn = dot(a.dir, b.dir) < -0.95;
    const arc = uTurn ? null : filletPath(a, b);
    let points: Vec[];
    if (arc) points = arc.points;
    else {
      const k = uTurn ? Math.max(chord * 0.9, 7) : chord * 0.45;
      const p1 = add(a.pos, scale(a.dir, k));
      const p2 = sub(b.pos, scale(b.dir, k));
      points = [];
      for (let i = 0; i <= 10; i++) points.push(cubicBezier(a.pos, p1, p2, b.pos, i / 10));
    }
    const cum = [0];
    for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + dist(points[i - 1], points[i]));
    const length = Math.max(0.3, cum[cum.length - 1]);
    const theta = Math.abs(angleDiff(angleOf(a.dir), angleOf(b.dir)));
    let speed = Math.min(inLane.speed, outLane.speed);
    if (theta > 0.15) {
      const r = arc ? arc.r : Math.max(2, chord / (2 * Math.max(0.15, Math.sin(theta / 2))));
      speed = Math.min(speed, turnSpeed(r));
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

let graphSerial = 0;

/** Списки равны поэлементно (нет списка — пустой). */
function sameList<T>(a: readonly T[] | undefined, b: readonly T[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** Копия полотна на момент сборки графа: концы и их высоты, ось, класс, предел скорости, кольцо, полосы — подряд. */
type CorridorShape = (number | string)[];

/** Копия настроек узла, от которых зависят его манёвры. */
interface NodeShape {
  kind: string;
  /** Место и направление стыка: x, y, dir.x, dir.y. */
  pos: number[];
  /** Светофор и главная дорога из настроек — строкой. */
  rules: string;
  corridors: number[];
  lanes?: string[];
  bans?: string[];
}

function shapeOfCorridor(net: LaneNet, c: Corridor): CorridorShape {
  const { p0, p1, p2, p3 } = c.curve;
  const s: CorridorShape = [c.a, c.b, c.portA, c.portB, c.length, c.cls, c.limit ?? -1, c.ring ? 1 : 0, p0.x, p0.y, p1.x, p1.y, p2.x, p2.y, p3.x, p3.y];
  s.push(net.nodes.get(c.a)?.level ?? NaN, net.nodes.get(c.b)?.level ?? NaN);
  for (const l of c.lanes) s.push(l.offset, l.flow, l.from, l.to, l.solid ? 1 : 0);
  return s;
}

/** Полотно не менялось. */
const sameShape = (a: CorridorShape, b: CorridorShape) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Полоса связи та же (номер, полоса полотна, смещение, сплошные, длина, скорость). */
function sameLane(a: GLane, b: GLane): boolean {
  if (a.index !== b.index || a.laneIdx !== b.laneIdx || a.offset !== b.offset || a.solidRight !== b.solidRight || a.length !== b.length || a.speed !== b.speed) return false;
  const za = a.solidZones ?? [];
  const zb = b.solidZones ?? [];
  return za.length === zb.length && za.every((z, i) => z[0] === zb[i][0] && z[1] === zb[i][1]);
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Ближе этого траектории двух манёвров — машины на них мешают друг другу. */
const CONFLICT_GAP = CAR_WIDTH * 0.9;

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function boxOf(pts: Vec[], pad: number): Box {
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const p of pts) {
    b.x0 = Math.min(b.x0, p.x - pad);
    b.y0 = Math.min(b.y0, p.y - pad);
    b.x1 = Math.max(b.x1, p.x + pad);
    b.y1 = Math.max(b.y1, p.y + pad);
  }
  return b;
}

const meets = (a: Box, b: Box) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;

function conflictKind(a: GMove, b: GMove, ba: Box, bb: Box): ConflictKind | null {
  if (a.outLane === b.outLane) return 'merge';
  if (a.inLane === b.inLane) return 'diverge';
  return meets(ba, bb) && polylinesWithin(a.points, b.points, CONFLICT_GAP) ? 'cross' : null;
}

/**
 * Где на манёвре a он проходит ближе CONFLICT_GAP к манёвру b: [начало, конец] по длине a.
 * Проверяются концы и середины отрезков траектории — точность в треть отрезка, этого хватает.
 */
function conflictZone(a: GMove, b: GMove): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  const bb = boxOf(b.points, CONFLICT_GAP);
  for (let i = 0; i < a.points.length - 1; i++) {
    const p = a.points[i];
    const q = a.points[i + 1];
    if (!meets(boxOf([p, q], 0), bb)) continue;
    for (const t of [0, 0.5, 1]) {
      const pt = { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
      if (!pointWithin(pt, b.points, CONFLICT_GAP)) continue;
      const s = a.cum[i] + (a.cum[i + 1] - a.cum[i]) * t;
      lo = Math.min(lo, s);
      hi = Math.max(hi, s);
    }
  }
  return lo <= hi ? [lo, hi] : [0, a.length];
}

/** Подходят ли ломаные ближе d хоть где-то (с отсевом отрезков по рамкам). */
function polylinesWithin(a: Vec[], b: Vec[], d: number): boolean {
  for (let i = 0; i < a.length - 1; i++) {
    const sa = boxOf([a[i], a[i + 1]], d);
    for (let j = 0; j < b.length - 1; j++) {
      const p = b[j];
      const q = b[j + 1];
      if (Math.max(p.x, q.x) < sa.x0 || Math.min(p.x, q.x) > sa.x1 || Math.max(p.y, q.y) < sa.y0 || Math.min(p.y, q.y) > sa.y1) continue;
      if (segSegDist(a[i], a[i + 1], p, q) < d) return true;
    }
  }
  return false;
}

/** Точка ближе d к ломаной. */
function pointWithin(pt: Vec, b: Vec[], d: number): boolean {
  for (let j = 0; j < b.length - 1; j++) {
    const p = b[j];
    const q = b[j + 1];
    if (Math.max(p.x, q.x) < pt.x - d || Math.min(p.x, q.x) > pt.x + d || Math.max(p.y, q.y) < pt.y - d || Math.min(p.y, q.y) > pt.y + d) continue;
    if (segSegDist(pt, pt, p, q) < d) return true;
  }
  return false;
}

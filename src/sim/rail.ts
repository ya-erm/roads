import { dot, scale, Vec } from '../core/vec';
import { GRADE } from '../config';
import type { Network, Segment, SplitRecord } from '../world/network';
import { RAIL_SWITCH_ANGLE } from '../world/roadTypes';
import { trackSpeed } from './railSpeed';

export interface TrainSpec {
  cars: number;
  carLength: number;
  maxSpeed: number;
  accel: number;
  brake: number;
  color: string;
  kind: 'freight' | 'passenger';
}

/** Проход по сегменту пути в направлении dir; start — смещение от начала маршрута. */
export interface PathEdge {
  seg: number;
  dir: 0 | 1;
  len: number;
  start: number;
}

export interface Train extends TrainSpec {
  id: number;
  length: number;
  path: PathEdge[];
  /** Положение головы поезда вдоль маршрута. */
  head: number;
  /** Где голова остановится (середина конечной платформы). */
  stopAt: number;
  v: number;
  moving: boolean;
  /** Платформа, на которой поезд стоит. */
  platform: number | null;
  /** Цвет груза в вагонах. */
  load?: string;
  /** Заполненность состава на вид (доля вместимости) и до какой он сперва пустеет — см. stepWagons. */
  fill?: number;
  dip?: number;
  segs: number[];
  nodes: number[];
  /**
   * До какого участка маршрута (индекс в path) путь забронирован. Дальше — только когда
   * освободится следующий блок между сигналами. Нет — весь маршрут (старые сохранения).
   */
  reservedTo?: number;
  /** Сколько секунд поезд стоит перед сигналом. */
  held?: number;
  /**
   * Платформа назначения, ещё занятая уходящим поездом (отправление по прогнозу — departAhead): за этим поездом
   * она закреплена заявкой — другие её не займут, а он встанет перед ней и въедет, как только она освободится.
   */
  claim?: number;
  /**
   * Путь, по которому поезд уйдёт с платформы, — его первый блок и платформа назначения закреплены за ним
   * заранее (заявкой): так к его платформе уже едет другой поезд (departAhead), и уйти ему ничто не помешает.
   */
  exit?: PathEdge[];
}

/** Где поезд останавливается перед закрытым сигналом. */
const SIGNAL_GAP = 10;

export interface RailEvents {
  onArrive(train: Train): void;
  onLost(train: Train): void;
}

export type DepartResult = 'ok' | 'blocked' | 'noroute';

interface State {
  seg: number;
  dir: 0 | 1;
}

/** Ждать у входа на станцию, пока уйдёт поезд с платформы, — по прогнозу не дольше стольких секунд. */
export const AHEAD_SLACK = 20;

/** Поезд на платформе: через сколько секунд будет готов уехать и куда (платформы следующей станции). */
export interface Leaving {
  after: number;
  targets: number[];
  through?: number;
}

const BLOCKED_COST = 1e4;
/** Сквозной путь вокзала дороже бокового: на нём поезд встаёт, только если боковые заняты. */
const THROUGH_COST = 120;

class Heap<T> {
  private items: { k: number; v: T }[] = [];
  get size(): number {
    return this.items.length;
  }
  push(k: number, v: T): void {
    const a = this.items;
    a.push({ k, v });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].k <= a[i].k) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): { k: number; v: T } | undefined {
    const a = this.items;
    if (!a.length) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].k < a[m].k) m = l;
        if (r < a.length && a[r].k < a[m].k) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Поезда. Безопасность — автоблокировка без сигналов: поезд отправляется, только
 * когда весь путь до свободной платформы следующей станции свободен, и резервирует его.
 * Пройденные участки освобождаются, как только их покидает хвост. Платформа, с которой поезд
 * уйдёт к нашему приезду, — по прогнозу (departAhead): едем сразу, ждём, если что, у входа.
 */
export class RailSim {
  readonly trains = new Map<number, Train>();
  private readonly segOwner = new Map<number, number>();
  private readonly nodeOwner = new Map<number, number>();
  /**
   * Заявки (по поездам — syncClaims): платформа → поезд, который едет к ней, пока её не освободили (Train.claim);
   * участки и узлы первого блока и платформа назначения → поезд, который по ним уйдёт (Train.exit).
   */
  private readonly claims = new Map<number, number>();
  private readonly nodeClaims = new Map<number, number>();
  private nextId = 1;
  private speedVersion = -1;
  private readonly speedCache = new Map<number, number>();
  /** Переезды по участкам пути: где на пути, закрыт ли (подходит поезд), занят ли машиной. */
  crossings = new Map<number, { railS: number; closed: boolean; busy: boolean }[]>();

  constructor(
    private readonly net: Network,
    private readonly events: RailEvents,
    /** Уклон рельефа вдоль dir в точке p (положителен — в гору); без рельефа — всегда 0. */
    private readonly grade: (p: Vec, dir: Vec) => number = () => 0,
  ) {}

  // ---------- Геометрия графа ----------

  private endNode(s: Segment, dir: 0 | 1): number {
    return dir === 0 ? s.b : s.a;
  }

  /** Направление движения в конце прохода. */
  private arrivalDir(s: Segment, dir: 0 | 1): Vec {
    return dir === 0 ? s.lut.tangentAt(s.length) : scale(s.lut.tangentAt(0), -1);
  }

  private departDir(s: Segment, dir: 0 | 1): Vec {
    return dir === 0 ? s.lut.tangentAt(0) : scale(s.lut.tangentAt(s.length), -1);
  }

  /**
   * Куда можно проехать из прохода: только плавно, без резких поворотов и разворотов; мимо сигнала,
   * запрещающего встречное движение, — только по его направлению (anyWay — не глядя на такие сигналы).
   */
  private nextStates(state: State, anyWay = false): State[] {
    const s = this.net.segments.get(state.seg);
    if (!s) return [];
    const nodeId = this.endNode(s, state.dir);
    const node = this.net.nodes.get(nodeId);
    if (!node) return [];
    // Сигнал стоит на выезде из узла на этот участок, а поезд едет по участку к узлу — навстречу ему.
    if (!anyWay && node.oneWay?.includes(s.id)) return [];
    const arrive = this.arrivalDir(s, state.dir);
    const result: State[] = [];
    for (const sid of node.segments) {
      if (sid === s.id || !this.net.isRailSeg(sid)) continue;
      const next = this.net.segment(sid);
      const dir: 0 | 1 = next.a === nodeId ? 0 : 1;
      if (dot(arrive, this.departDir(next, dir)) > Math.cos(RAIL_SWITCH_ANGLE)) result.push({ seg: sid, dir });
    }
    return result;
  }

  /** Допустимая скорость на сегменте с учётом кривизны. */
  segSpeed(segId: number): number {
    if (this.speedVersion !== this.net.version) {
      this.speedCache.clear();
      this.speedVersion = this.net.version;
    }
    let v = this.speedCache.get(segId);
    if (v === undefined) {
      v = trackSpeed(this.net.segment(segId));
      this.speedCache.set(segId, v);
    }
    return v;
  }

  // ---------- Поезда ----------

  create(spec: TrainSpec): Train {
    const train: Train = {
      ...spec,
      id: this.nextId++,
      length: spec.cars * spec.carLength,
      path: [],
      head: 0,
      stopAt: 0,
      v: 0,
      moving: false,
      platform: null,
      segs: [],
      nodes: [],
    };
    this.trains.set(train.id, train);
    return train;
  }

  /** Кто держит участок: поезд, забронировавший его, или (платформу) поезд с заявкой на неё. */
  private holder(seg: number): number | undefined {
    return this.segOwner.get(seg) ?? this.claims.get(seg);
  }

  private nodeHolder(node: number): number | undefined {
    return this.nodeOwner.get(node) ?? this.nodeClaims.get(node);
  }

  private own(train: Train, segs: number[], nodes: number[]): void {
    for (const s of segs) {
      this.segOwner.set(s, train.id);
      if (!train.segs.includes(s)) train.segs.push(s);
      if (train.claim === s) {
        delete train.claim;
        this.syncClaims();
      }
    }
    for (const n of nodes) {
      this.nodeOwner.set(n, train.id);
      if (!train.nodes.includes(n)) train.nodes.push(n);
    }
  }

  private releaseSeg(train: Train, seg: number): void {
    if (this.segOwner.get(seg) === train.id) this.segOwner.delete(seg);
    train.segs = train.segs.filter((s) => s !== seg);
  }

  private releaseNode(train: Train, node: number): void {
    if (this.nodeOwner.get(node) === train.id) this.nodeOwner.delete(node);
    train.nodes = train.nodes.filter((n) => n !== node);
  }

  private releaseAll(train: Train): void {
    for (const s of [...train.segs]) this.releaseSeg(train, s);
    for (const n of [...train.nodes]) this.releaseNode(train, n);
    if (train.claim !== undefined || train.exit) {
      delete train.claim;
      delete train.exit;
      this.syncClaims();
    }
  }

  /** Ставит поезд на свободную платформу (при покупке или после сбоя). */
  park(train: Train, platforms: number[]): boolean {
    for (const pid of platforms) {
      const seg = this.net.segments.get(pid);
      if (!seg || this.holder(pid) !== undefined || seg.length < train.length + 6) continue;
      this.releaseAll(train);
      this.own(train, [pid], []);
      train.platform = pid;
      train.path = [{ seg: pid, dir: 0, len: seg.length, start: 0 }];
      train.head = (seg.length + train.length) / 2;
      train.stopAt = train.head;
      train.moving = false;
      train.v = 0;
      return true;
    }
    return false;
  }

  /**
   * Стоящий поезд — головой (локомотивом) туда, куда он уйдёт к одной из платформ targets (тот же маршрут, что
   * выбрал бы depart; закреплённый заранее Train.exit — по нему): на конечной и при возврате назад с проходной
   * поезд разворачивается сразу по прибытии, а не при отправлении. Занятый отрезок платформы тот же — меняется
   * только конец, с которого голова; брони не трогаются. Пути нет — стоит как стоял. true — развернулся.
   */
  orient(train: Train, targets: number[], through?: number): boolean {
    if (train.moving || train.platform === null || train.path.length !== 1) return false;
    const P = this.net.segments.get(train.platform);
    const edge = train.path[0];
    if (!P || edge.seg !== P.id) return false;
    const exit = train.exit;
    const dir = exit && exit.length > 1 && exit[0].seg === P.id ? exit[0].dir : this.plan(train, targets, through)?.[0]?.dir;
    if (dir === undefined || dir === edge.dir) return false;
    // Отрезок платформы под поездом в координатах сегмента — как в launch.
    const front = edge.dir === 0 ? train.head : P.length - train.head;
    const x0 = edge.dir === 0 ? front - train.length : front;
    const x1 = edge.dir === 0 ? front : front + train.length;
    train.path = [{ seg: P.id, dir, len: P.length, start: 0 }];
    train.head = dir === 0 ? x1 : P.length - x0;
    train.stopAt = train.head;
    return true;
  }

  /** Пытается отправить стоящий поезд к одной из платформ targets; through — сквозной путь вокзала. */
  depart(train: Train, targets: number[], through?: number): DepartResult {
    // Путь, закреплённый заранее (к платформе уже едет другой поезд), — тот же, что и обещан.
    const path = this.plannedExit(train, targets) ?? this.plan(train, targets, through);
    if (!path) return 'noroute';
    // Бронь: путь до первого сигнала по ходу (или до конца) и сразу платформа назначения —
    // поезд, ждущий у сигнала, всегда знает, что его платформа свободна.
    const k = this.blockEnd(path, 0);
    const last = path.length - 1;
    const segs = [...path.slice(0, k + 1).map((e) => e.seg), path[last].seg];
    const nodes = this.pathNodes(path, 0, k);
    if (!this.free(train, segs, nodes) || this.throughStanding(train, path, k)) return 'blocked';
    this.launch(train, path, k, segs, nodes);
    return 'ok';
  }

  /**
   * За первым блоком маршрут идёт через платформу, на которой стоит другой поезд (объезда нет): уехав, поезд
   * встанет у сигнала перед ним, а тот может уходить навстречу — по пути, который держит этот. Ждём на месте.
   */
  private throughStanding(train: Train, path: PathEdge[], k: number): boolean {
    return path.slice(k + 1, -1).some((e) => {
      const other = this.trains.get(this.segOwner.get(e.seg) ?? -1);
      return !!other && other.id !== train.id && !other.moving;
    });
  }

  /**
   * Отправление по прогнозу: все платформы targets заняты, но с одной из них поезд скоро уйдёт — к нашему приезду
   * (или не позже чем через slack секунд после него). Тогда едем сразу: бронь — путь без самой платформы (поезд
   * встанет у входа на неё), а платформа закреплена за нами заявкой (Train.claim) — другой её не займёт.
   * leaving(occupant) — через сколько секунд стоящий там поезд будет готов уехать и куда; null — неизвестно.
   * Без взаимной блокировки: уходящий поезд уедет, не задев ни одного участка и узла нашего маршрута (встречный
   * на однопутке, разворот в тупике — нельзя), и его первый блок с платформой назначения свободен уже сейчас.
   * 'blocked' — ждать на месте, как и раньше.
   */
  departAhead(train: Train, targets: number[], leaving: (occupant: Train) => Leaving | null, slack = AHEAD_SLACK): DepartResult {
    if (train.moving || train.platform === null || !this.net.segments.has(train.platform)) return 'noroute';
    const own = train.platform;
    const goals = targets.filter((t) => t !== own && this.net.segments.has(t));
    // Свободная платформа есть — держит не она, а путь до неё: ждём, как обычно.
    if (!goals.length || goals.some((t) => this.holder(t) === undefined)) return 'blocked';
    let best: { path: PathEdge[]; k: number; wait: number; platform: number; occupant: Train; exit: PathEdge[] } | null = null;
    for (const t of goals) {
      if (this.claims.has(t)) continue;
      // Платформу держит поезд, который на ней стоит или едет к ней, забронировав весь путь до неё (ни у какого
      // сигнала он уже не встанет).
      const occupant = this.trains.get(this.segOwner.get(t) ?? -1);
      if (!occupant || occupant.id === train.id || occupant.exit) continue;
      const last = occupant.path.length - 1;
      const coming = occupant.moving && occupant.path[last]?.seg === t && (occupant.reservedTo ?? last) >= last - 1;
      if (!coming && (occupant.moving || occupant.platform !== t)) continue;
      const info = leaving(occupant);
      if (!info || !Number.isFinite(info.after)) continue;
      const path = this.plan(train, [t]);
      const exit = this.plan(occupant, info.targets, info.through, t);
      if (!path || path.length < 2 || !exit) continue;
      if (!this.apart(path, exit) || !this.openFor(exit, [occupant.id, train.id], occupant.length)) continue;
      if (this.throughStanding(occupant, exit, this.blockEnd(exit, 0))) continue;
      const k = Math.min(this.blockEnd(path, 0), path.length - 2);
      if (!this.free(train, path.slice(0, k + 1).map((e) => e.seg), this.pathNodes(path, 0, k)) || this.throughStanding(train, path, k)) continue;
      const until = (coming ? this.arrivalTime(occupant) : 0) + info.after + this.clearTime(occupant, t);
      const wait = until - this.travelTime(train, path);
      if (wait > slack || (best && wait >= best.wait)) continue;
      best = { path, k, wait, platform: t, occupant, exit };
    }
    if (!best) return 'blocked';
    const { path, k, platform, occupant, exit } = best;
    this.launch(train, path, k, path.slice(0, k + 1).map((e) => e.seg), this.pathNodes(path, 0, k));
    train.claim = platform;
    occupant.exit = exit;
    this.syncClaims();
    return 'ok';
  }

  /** Закреплённый заранее путь поезда (Train.exit), если он годится для отправления к targets; иначе снимается. */
  private plannedExit(train: Train, targets: number[]): PathEdge[] | null {
    const exit = train.exit;
    if (!exit) return null;
    const ok = exit.length > 1 && exit[0].seg === train.platform && targets.includes(exit[exit.length - 1].seg) && exit.every((e) => this.net.segments.has(e.seg));
    if (!ok) {
      delete train.exit;
      this.syncClaims();
      return null;
    }
    // Длины участков могли поменяться (правка формы пути) — смещения заново.
    let acc = 0;
    return exit.map((e) => {
      const len = this.net.segment(e.seg).length;
      const edge = { seg: e.seg, dir: e.dir, len, start: acc };
      acc += len;
      return edge;
    });
  }

  /** Что закреплено за уходящим поездом по его пути exit: первый блок (без своей платформы) и платформа назначения. */
  private exitHold(exit: PathEdge[]): { segs: number[]; nodes: number[] } {
    const k = this.blockEnd(exit, 0);
    const segs = exit.slice(1, k + 1).map((e) => e.seg);
    const last = exit[exit.length - 1].seg;
    if (!segs.includes(last)) segs.push(last);
    return { segs, nodes: this.pathNodes(exit, 0, k) };
  }

  /**
   * Поезд стоит у входа на платформу назначения, которую ещё не освободил уходящий поезд (заявка departAhead):
   * ждёт именно из-за занятой платформы, а не из-за пути.
   */
  waitsPlatform(train: Train): boolean {
    if (!train.moving || train.claim === undefined || !train.held) return false;
    const from = (train.reservedTo ?? train.path.length - 1) + 1;
    return from < train.path.length && this.blockEnd(train.path, from) === train.path.length - 1;
  }

  /**
   * Маршрут поезда от платформы from (по умолчанию — той, где он стоит) к одной из targets — тот, что выбрал бы
   * depart; null — пути нет.
   */
  private plan(train: Train, targets: number[], through?: number, from?: number): PathEdge[] | null {
    const own = from ?? (train.moving ? null : train.platform);
    if (own === null || !this.net.segments.has(own)) return null;
    const goal = new Set(targets.filter((t) => t !== own));
    const route = this.findRoute([own], goal, train.id, train.length + 6, through);
    if (!route) return null;
    const path: PathEdge[] = [];
    let acc = 0;
    for (const st of route.states) {
      const len = this.net.segment(st.seg).length;
      path.push({ seg: st.seg, dir: st.dir, len, start: acc });
      acc += len;
    }
    return path;
  }

  /** Узлы маршрута между участками from…to (узел в конце каждого из них, кроме последнего). */
  private pathNodes(path: PathEdge[], from: number, to: number): number[] {
    return path.slice(from, to).map((e) => this.endNode(this.net.segment(e.seg), e.dir));
  }

  /** Трогает стоящий поезд по маршруту path: бронь — segs и nodes, до участка reservedTo включительно. */
  private launch(train: Train, path: PathEdge[], reservedTo: number, segs: number[], nodes: number[]): void {
    const P = this.net.segment(train.platform!);
    const edge = train.path[0];
    // Отрезок платформы, занятый поездом, в координатах сегмента.
    const front = edge.dir === 0 ? train.head : P.length - train.head;
    const x0 = edge.dir === 0 ? front - train.length : front;
    const x1 = edge.dir === 0 ? front : front + train.length;
    const first = path[0];
    const last = path[path.length - 1];
    train.path = path;
    train.head = first.dir === 0 ? x1 : P.length - x0;
    train.stopAt = last.start + (last.len + train.length) / 2;
    train.reservedTo = reservedTo;
    train.held = 0;
    train.moving = true;
    train.platform = null;
    this.own(train, segs, nodes);
    // Уехал — закреплённый за ним путь теперь его бронь, а остальное от заявки свободно.
    if (train.exit) {
      delete train.exit;
      this.syncClaims();
    }
  }

  /**
   * Маршруты не делят ни участков, ни узлов: наш (без платформы, с которой уезжаем, — её освободим первыми)
   * и уходящего поезда (без платформы, с которой уходит он, — на неё едем мы).
   */
  private apart(mine: PathEdge[], exit: PathEdge[]): boolean {
    const segs = new Set(mine.slice(1).map((e) => e.seg));
    const nodes = new Set(this.pathNodes(mine, 0, mine.length - 1));
    if (exit.slice(1).some((e) => segs.has(e.seg))) return false;
    return !this.pathNodes(exit, 0, exit.length - 1).some((n) => nodes.has(n));
  }

  /**
   * Уехал бы поезд длиной length по маршруту прямо сейчас и увёл бы хвост со своей платформы, не дожидаясь
   * следующих блоков: первый блок и платформа назначения свободны (или их держат ours), а первый блок за платформой
   * длиннее поезда (или доходит до самого конца).
   */
  private openFor(path: PathEdge[], ours: number[], length: number): boolean {
    const k = this.blockEnd(path, 0);
    const room = path.slice(1, k + 1).reduce((s, e) => s + e.len, 0);
    if (k < path.length - 1 && room < length + SIGNAL_GAP + 2) return false;
    const { segs, nodes } = this.exitHold(path);
    for (const s of segs) {
      const h = this.holder(s);
      if (h !== undefined && !ours.includes(h)) return false;
    }
    for (const n of nodes) {
      const h = this.nodeHolder(n);
      if (h !== undefined && !ours.includes(h)) return false;
    }
    return true;
  }

  /** Оценка снизу: сколько секунд поезду от середины своей платформы до входа на последний участок маршрута. */
  private travelTime(train: Train, path: PathEdge[]): number {
    let t = train.maxSpeed / (2 * train.accel);
    path.slice(0, -1).forEach((e, i) => {
      t += (i === 0 ? e.len / 2 : e.len) / Math.min(train.maxSpeed, this.segSpeed(e.seg));
    });
    return t;
  }

  /** Оценка снизу: сколько секунд едущему поезду до остановки на платформе назначения. */
  private arrivalTime(train: Train): number {
    let t = train.maxSpeed / (2 * train.brake);
    for (const e of train.path) {
      const a = Math.max(train.head, e.start);
      const b = Math.min(train.stopAt, e.start + e.len);
      if (b > a) t += (b - a) / Math.min(train.maxSpeed, this.segSpeed(e.seg));
    }
    return t;
  }

  /** Сколько секунд поезду, стоящему на платформе platform, тронуться и увести с неё хвост. */
  private clearTime(train: Train, platform: number): number {
    const seg = this.net.segments.get(platform);
    const d = ((seg?.length ?? train.length) + train.length) / 2;
    const v = Math.min(train.maxSpeed, seg ? this.segSpeed(seg.id) : train.maxSpeed);
    const run = (v * v) / (2 * train.accel);
    return d <= run ? Math.sqrt((2 * d) / train.accel) : v / train.accel + (d - run) / v;
  }

  /** Свободны ли участки и узлы от чужих броней (и заявок на платформы). */
  private free(train: Train, segs: number[], nodes: number[]): boolean {
    for (const s of segs) {
      const owner = this.holder(s);
      if (owner !== undefined && owner !== train.id) return false;
    }
    for (const n of nodes) {
      const owner = this.nodeHolder(n);
      if (owner !== undefined && owner !== train.id) return false;
    }
    return true;
  }

  /** Есть ли сигнал для поезда, выезжающего из узла на участок outSeg. */
  hasSignal(nodeId: number, outSeg: number): boolean {
    return !!this.net.nodes.get(nodeId)?.signals?.includes(outSeg);
  }

  /** Пути нет только из-за сигналов, запрещающих встречное движение: без них поезд бы проехал. */
  blockedByOneWay(from: number[], to: number[], through?: number): boolean {
    const starts = from.filter((id) => this.net.segments.has(id));
    const goal = new Set(to.filter((id) => this.net.segments.has(id) && !from.includes(id)));
    return !this.findRoute(starts, goal, null, 0, through) && !!this.findRoute(starts, goal, null, 0, through, true);
  }

  /**
   * Последний участок блока, начиная с from: до узла с сигналом по ходу поезда
   * или до конца маршрута.
   */
  private blockEnd(path: PathEdge[], from: number): number {
    for (let i = from; i < path.length - 1; i++) {
      const node = this.endNode(this.net.segment(path[i].seg), path[i].dir);
      if (this.hasSignal(node, path[i + 1].seg)) return i;
    }
    return path.length - 1;
  }

  /** Пытается забронировать следующий блок за сигналом. */
  private extend(train: Train): boolean {
    const path = train.path;
    const from = (train.reservedTo ?? path.length - 1) + 1;
    if (from >= path.length) return true;
    const k = this.blockEnd(path, from);
    const segs = path.slice(from, k + 1).map((e) => e.seg);
    // Узел сигнала и узлы внутри блока.
    const nodes = path.slice(from - 1, k).map((e) => this.endNode(this.net.segment(e.seg), e.dir));
    if (!this.free(train, segs, nodes)) return false;
    this.own(train, segs, nodes);
    train.reservedTo = k;
    return true;
  }

  /** Путь между вокзалами для отрисовки линии: по осям путей, без учёта других поездов. */
  previewRoute(from: number[], to: number[], through?: number): Vec[] | null {
    const starts = from.filter((id) => this.net.segments.has(id));
    const goal = new Set(to.filter((id) => this.net.segments.has(id) && !from.includes(id)));
    const route = this.findRoute(starts, goal, null, 0, through);
    if (!route) return null;
    const pts: Vec[] = [];
    route.states.forEach((st, i) => {
      const seg = this.net.segment(st.seg);
      // Первая и последняя платформы — от середины и до середины.
      const s0 = i === 0 ? seg.length / 2 : 0;
      const s1 = i === route.states.length - 1 ? seg.length / 2 : seg.length;
      const steps = Math.max(2, Math.ceil((s1 - s0) / 12));
      for (let k = 0; k <= steps; k++) {
        const s = s0 + ((s1 - s0) * k) / steps;
        pts.push(seg.lut.pointAt(st.dir === 0 ? s : seg.length - s));
      }
    });
    return pts;
  }

  /**
   * Тот же путь, что previewRoute, — по участкам с пределом скорости (путь и кривые) и уклоном рельефа
   * (на мосту и в тоннеле — без уклона): для графика скорости линии. null — пути нет.
   */
  previewTrack(from: number[], to: number[], through?: number, step = 12): { length: number; cap: number; grade: number; from: Vec; to: Vec }[] | null {
    const starts = from.filter((id) => this.net.segments.has(id));
    const goal = new Set(to.filter((id) => this.net.segments.has(id) && !from.includes(id)));
    const route = this.findRoute(starts, goal, null, 0, through);
    if (!route) return null;
    const pieces: { length: number; cap: number; grade: number; from: Vec; to: Vec }[] = [];
    route.states.forEach((st, i) => {
      const seg = this.net.segment(st.seg);
      const s0 = i === 0 ? seg.length / 2 : 0;
      const s1 = i === route.states.length - 1 ? seg.length / 2 : seg.length;
      const cap = this.segSpeed(seg.id);
      const k = Math.max(1, Math.ceil((s1 - s0) / step));
      for (let j = 0; j < k; j++) {
        const s = s0 + ((s1 - s0) * (j + 0.5)) / k;
        const cs = st.dir === 0 ? s : seg.length - s;
        const t = seg.lut.tangentAt(cs);
        const level = this.net.levelAt(seg, cs);
        const grade = Math.abs(level) < 0.25 ? this.grade(seg.lut.pointAt(cs), st.dir === 0 ? t : scale(t, -1)) : 0;
        const at = (u: number) => seg.lut.pointAt(st.dir === 0 ? u : seg.length - u);
        pieces.push({ length: (s1 - s0) / k, cap, grade, from: at(s0 + ((s1 - s0) * j) / k), to: at(s0 + ((s1 - s0) * (j + 1)) / k) });
      }
    });
    return pieces;
  }

  /**
   * Дейкстра по проходам пути; старт — платформы в обе стороны, цель — любая платформа из goal
   * длиной не меньше minLen. Чужие занятые участки сильно дороже — объезд выбирается, если есть;
   * сквозной путь вокзала through как цель дороже бокового.
   */
  private findRoute(
    starts: number[],
    goal: Set<number>,
    self: number | null,
    minLen: number,
    through?: number,
    anyWay = false,
  ): { states: State[]; nodes: number[] } | null {
    if (!goal.size || !starts.length) return null;
    const key = (s: State) => s.seg * 2 + s.dir;
    const g = new Map<number, number>();
    const prev = new Map<number, State>();
    const heap = new Heap<State>();
    for (const seg of starts) {
      for (const dir of [0, 1] as const) {
        const st = { seg, dir };
        g.set(key(st), 0);
        heap.push(0, st);
      }
    }
    const closed = new Set<number>();
    while (heap.size) {
      const { v: cur } = heap.pop()!;
      const k = key(cur);
      if (closed.has(k)) continue;
      closed.add(k);
      const seg = this.net.segment(cur.seg);
      if (goal.has(cur.seg) && seg.length >= minLen) {
        const states = [cur];
        let p = prev.get(k);
        while (p) {
          states.push(p);
          p = prev.get(key(p));
        }
        states.reverse();
        const nodes = states.slice(0, -1).map((s) => this.endNode(this.net.segment(s.seg), s.dir));
        return { states, nodes };
      }
      const base = g.get(k)!;
      for (const next of this.nextStates(cur, anyWay)) {
        const nk = key(next);
        if (closed.has(nk)) continue;
        const ns = this.net.segment(next.seg);
        const owner = self === null ? undefined : this.holder(next.seg);
        const blocked = owner !== undefined && owner !== self ? BLOCKED_COST : 0;
        const side = next.seg === through && goal.has(next.seg) ? THROUGH_COST : 0;
        const cost = base + ns.length / this.segSpeed(next.seg) + blocked + side;
        if (cost < (g.get(nk) ?? Infinity)) {
          g.set(nk, cost);
          prev.set(nk, cur);
          heap.push(cost, next);
        }
      }
    }
    return null;
  }

  remove(train: Train): void {
    this.releaseAll(train);
    this.trains.delete(train.id);
  }

  // ---------- Движение ----------

  step(dt: number): void {
    for (const list of this.crossings.values()) for (const x of list) x.closed = false;
    for (const train of [...this.trains.values()]) {
      if (!train.moving) continue;
      this.move(train, dt);
    }
  }

  private move(train: Train, dt: number): void {
    const path = train.path;
    let idx = this.edgeIndex(train, train.head);
    let target = train.maxSpeed;
    // В подъём поезд медленнее — тем сильнее, чем круче склон (на мосту и в тоннеле не считаем).
    const headPt = this.pointAt(train, train.head);
    if (headPt && Math.abs(headPt.level) < 0.25) {
      const grade = this.grade(headPt.pos, headPt.dir);
      if (grade > 0) target *= Math.max(0.35, 1 - Math.min(1, grade / GRADE.rail) * 0.5);
    }
    // Ограничения скорости на кривых впереди.
    for (let i = idx; i < path.length; i++) {
      const e = path[i];
      const ahead = Math.max(0, e.start - train.head);
      if (ahead > 500) break;
      const lim = this.segSpeed(e.seg);
      target = Math.min(target, Math.sqrt(lim * lim + 2 * train.brake * ahead));
    }
    // Сигналы: на подходе к концу брони пробуем занять следующий блок; не вышло — стоп перед сигналом.
    let limit = train.stopAt;
    const reserved = train.reservedTo ?? path.length - 1;
    if (reserved < path.length - 1) {
      const signalAt = path[reserved].start + path[reserved].len - SIGNAL_GAP;
      const brakeDist = (train.v * train.v) / (2 * train.brake) + 40;
      if (signalAt - train.head < brakeDist && this.extend(train)) {
        train.held = 0;
      } else if ((train.reservedTo ?? path.length - 1) < path.length - 1) {
        limit = Math.min(limit, signalAt);
        if (train.v < 0.2 && signalAt - train.head < 2) train.held = (train.held ?? 0) + dt;
      }
    }
    // Плавная остановка у платформы или перед закрытым сигналом.
    target = Math.min(target, Math.sqrt(2 * train.brake * Math.max(0, limit - train.head)));
    // Переезды: закрываем заранее; если машина застряла на переезде — тормозим перед ним.
    const tail = train.head - train.length;
    for (const e of path) {
      if (e.start > train.head + 260) break;
      if (e.start + e.len < tail - 12) continue;
      for (const x of this.crossings.get(e.seg) ?? []) {
        const pos = e.start + (e.dir === 0 ? x.railS : e.len - x.railS);
        if (pos - train.head >= 260 || pos <= tail - 12) continue;
        x.closed = true;
        const gap = pos - train.head;
        if (x.busy && gap > 0 && gap < 120) target = Math.min(target, Math.sqrt(2 * train.brake * Math.max(0, gap - 10)));
      }
    }
    const dv = target - train.v;
    train.v = Math.max(0, train.v + Math.max(-train.brake * dt, Math.min(train.accel * dt, dv)));
    train.head = Math.min(limit, train.head + train.v * dt);
    // Освобождаем пройденное хвостом.
    const newTail = train.head - train.length;
    for (let i = 0; i < path.length; i++) {
      const e = path[i];
      if (e.start + e.len > newTail - 1) break;
      const later = path.slice(i + 1).some((x) => x.seg === e.seg);
      if (!later) this.releaseSeg(train, e.seg);
      if (i < path.length - 1) this.releaseNode(train, this.endNode(this.net.segment(e.seg), e.dir));
    }
    idx = this.edgeIndex(train, train.head);
    if (train.head >= train.stopAt - 0.05 && train.v < 0.5) this.arrive(train);
  }

  private arrive(train: Train): void {
    const last = train.path[train.path.length - 1];
    train.moving = false;
    train.v = 0;
    train.platform = last.seg;
    train.head = train.head - last.start;
    train.stopAt = train.head;
    train.path = [{ ...last, start: 0 }];
    for (const s of [...train.segs]) if (s !== last.seg) this.releaseSeg(train, s);
    for (const n of [...train.nodes]) this.releaseNode(train, n);
    this.own(train, [last.seg], []);
    this.events.onArrive(train);
  }

  private edgeIndex(train: Train, s: number): number {
    const path = train.path;
    for (let i = 0; i < path.length; i++) if (s < path[i].start + path[i].len) return i;
    return path.length - 1;
  }

  /** Точка и направление на маршруте поезда; s может быть меньше нуля (хвост на старте). */
  pointAt(train: Train, s: number): { pos: Vec; dir: Vec; level: number } | null {
    const path = train.path;
    if (!path.length) return null;
    const i = this.edgeIndex(train, Math.max(0, s));
    const e = path[i];
    const seg = this.net.segments.get(e.seg);
    if (!seg) return null;
    const local = Math.max(0, Math.min(e.len, s - e.start));
    const cs = e.dir === 0 ? local : seg.length - local;
    const t = seg.lut.tangentAt(cs);
    return { pos: seg.lut.pointAt(cs), dir: e.dir === 0 ? t : scale(t, -1), level: this.net.levelAt(seg, cs) };
  }

  /** Положения вагонов от головы к хвосту. */
  cars(train: Train): { pos: Vec; dir: Vec; level: number }[] {
    const result: { pos: Vec; dir: Vec; level: number }[] = [];
    for (let k = 0; k < train.cars; k++) {
      const p = this.pointAt(train, train.head - (k + 0.5) * train.carLength);
      if (p) result.push(p);
    }
    return result;
  }

  // ---------- Изменения сети и сохранение ----------

  /**
   * После изменения сети: разрезанные участки (переезд, новый вокзал) заменяются половинками,
   * а поезда, чей путь исчез, считаются потерянными.
   */
  validate(splits: SplitRecord[] = []): void {
    const bySeg = new Map(splits.map((r) => [r.oldSeg, r]));
    for (const train of [...this.trains.values()]) {
      if (bySeg.size) this.applySplits(train, bySeg);
      const broken = train.path.some((e) => !this.net.segments.has(e.seg)) || train.segs.some((s) => !this.net.segments.has(s));
      if (!broken && train.path.length) {
        this.applyLengths(train);
        continue;
      }
      this.remove(train);
      this.events.onLost(train);
    }
    this.syncClaims();
  }

  /**
   * Заявки на платформы — заново по поездам: заявка жива, пока поезд едет и его маршрут кончается этой
   * платформой (её разрезали или убрали — заявка снимается, поезд займёт платформу обычной бронью).
   */
  private syncClaims(): void {
    this.claims.clear();
    this.nodeClaims.clear();
    for (const train of this.trains.values()) {
      const c = train.claim;
      if (c === undefined) continue;
      const ok = train.moving && this.net.segments.has(c) && train.path[train.path.length - 1]?.seg === c && !train.segs.includes(c) && !this.claims.has(c);
      if (ok) this.claims.set(c, train.id);
      else delete train.claim;
    }
    // Путь ухода — за поездом, который стоит на его первой платформе или едет к ней.
    for (const train of this.trains.values()) {
      const exit = train.exit;
      if (!exit) continue;
      const at = train.moving ? train.path[train.path.length - 1]?.seg : train.platform;
      if (exit.length < 2 || exit[0].seg !== at || !exit.every((e) => this.net.segments.has(e.seg))) {
        delete train.exit;
        continue;
      }
      const { segs, nodes } = this.exitHold(exit);
      for (const s of segs) if (!this.claims.has(s)) this.claims.set(s, train.id);
      for (const n of nodes) if (!this.nodeClaims.has(n)) this.nodeClaims.set(n, train.id);
    }
  }

  private applySplits(train: Train, bySeg: Map<number, SplitRecord>): void {
    let changed = false;
    // Участок мог быть разрезан несколько раз подряд — раскрываем, пока есть что.
    for (let guard = 0; guard < 8; guard++) {
      const next: PathEdge[] = [];
      let hit = false;
      // Граница брони сдвигается вместе с разрезанными участками до неё.
      let reserved = train.reservedTo;
      for (const [i, e] of train.path.entries()) {
        const rec = bySeg.get(e.seg);
        const first = rec && this.net.segments.get(rec.first);
        const second = rec && this.net.segments.get(rec.second);
        if (!rec || !first || !second) {
          next.push(e);
          continue;
        }
        hit = true;
        if (reserved !== undefined && i <= (train.reservedTo ?? 0)) reserved++;
        const pieces = e.dir === 0 ? [first, second] : [second, first];
        for (const p of pieces) next.push({ seg: p.id, dir: e.dir, len: p.length, start: 0 });
        const node = first.b;
        if (train.segs.includes(e.seg)) {
          this.releaseSeg(train, e.seg);
          this.own(train, [first.id, second.id], [node]);
        }
      }
      if (!hit) break;
      changed = true;
      train.path = next;
      train.reservedTo = reserved;
    }
    if (!changed) return;
    // Длины половинок чуть отличаются от целого — пересчитываем смещения, голову оставляем.
    let acc = 0;
    for (const e of train.path) {
      e.start = acc;
      acc += e.len;
    }
    const last = train.path[train.path.length - 1];
    if (train.moving) train.stopAt = last.start + (last.len + train.length) / 2;
    else train.stopAt = train.head = Math.min(train.head, acc);
    if (train.platform !== null && !this.net.segments.has(train.platform)) train.platform = last.seg;
  }

  /**
   * Участки маршрута поменяли форму (перенос узла, перо, изгиб): длины — заново, голова остаётся
   * на той же доле своего участка, остановка — посередине конечной платформы, как и была.
   */
  private applyLengths(train: Train): void {
    const stale = train.path.some((e) => Math.abs((this.net.segments.get(e.seg)?.length ?? e.len) - e.len) > 1e-6);
    if (!stale) return;
    const at = train.path[this.edgeIndex(train, Math.max(0, train.head))];
    const k = (train.head - at.start) / (at.len || 1);
    let acc = 0;
    for (const e of train.path) {
      e.start = acc;
      e.len = this.net.segments.get(e.seg)?.length ?? e.len;
      acc += e.len;
    }
    train.head = at.start + k * at.len;
    const last = train.path[train.path.length - 1];
    if (train.moving) train.stopAt = last.start + (last.len + train.length) / 2;
    else train.stopAt = train.head = Math.min(train.head, acc);
  }

  /** Есть ли на станции свободная платформа нужной длины. */
  canPark(platforms: number[], length: number): boolean {
    return platforms.some((pid) => {
      const seg = this.net.segments.get(pid);
      return seg && this.holder(pid) === undefined && seg.length >= length + 6;
    });
  }

  /** Занята ли платформа или участок пути. */
  isReserved(segId: number): boolean {
    return this.holder(segId) !== undefined;
  }

  serialize(): { nextId: number; trains: Train[] } {
    return { nextId: this.nextId, trains: [...this.trains.values()].map((t) => ({ ...t })) };
  }

  /** Снимает все поезда и брони (перед заменой сети); вернуть их — restore. */
  clearTrains(): void {
    this.trains.clear();
    this.segOwner.clear();
    this.nodeOwner.clear();
    this.claims.clear();
  }

  restore(data: { nextId: number; trains: Train[] }): Set<number> {
    this.nextId = data.nextId;
    const ok = new Set<number>();
    for (const t of data.trains) {
      if (t.path.some((e) => !this.net.segments.has(e.seg))) continue;
      const train: Train = { ...t, segs: [], nodes: [] };
      this.trains.set(train.id, train);
      this.own(train, t.segs, t.nodes);
      // Отмена правки формы путей: участки снова прежней длины.
      if (train.path.length) this.applyLengths(train);
      ok.add(train.id);
    }
    this.syncClaims();
    return ok;
  }
}

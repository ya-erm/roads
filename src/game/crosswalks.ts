import { hash } from '../core/math';
import type { Vec } from '../core/vec';
import { PEDESTRIANS_ON, XWALK } from '../lanes/crosswalk';
import type { GraphWalk, LaneGraph } from '../lanes/graph';
import type { Barrier, LaneTraffic } from '../lanes/traffic';

export { PEDESTRIANS_ON };

/**
 * Пешеходы на переходах перекрёстков (docs/CROSSWALKS.md): группы приходят к зебре по жителям вокруг, ждут окна (или
 * красного въезду с подъезда на светофоре) и идут; пока идут — зебра закрыта машинам в обе стороны (LaneTraffic.walks).
 * Состояние не сохраняется: после загрузки группы приходят заново, по тому же хешу.
 * Пока выключены (PEDESTRIANS_ON): вернутся вместе с пешеходами на тротуарах — движение ровно как без них.
 */

/**
 * Пешеходный светофор у зебры walk: зелёный, когда въезду с подъезда красный (и не жёлтый); перекрёсток без светофора —
 * null. От пешеходов не зависит — часть перехода на регулируемом перекрёстке.
 */
export function pedestrianLight(graph: LaneGraph, walk: Pick<GraphWalk, 'node' | 'inLink'>): boolean | null {
  const L = graph.nodes.get(walk.node)?.lights;
  if (!L) return null;
  if (L.clearing) return false;
  if (walk.inLink === null) return true;
  for (const key of L.phases[L.phase].moves) if (graph.moves.get(key)?.inLink === walk.inLink) return false;
  return true;
}

/** Переход «сам»: дом города ближе стольких метров к концу зебры (тротуару). */
export const WALK_HOUSES = 30;
/** Стёртый переход, где город хотел бы его, — у пассажирской станции рядом минус столько жителей охвата (each за каждый, до max). */
export const WALK_LOSS = { each: 0.05, max: 0.2 };
/** Жители вокруг перекрёстка — в таком радиусе, м. */
export const WALK_REACH = 120;
/** Групп на переход в минуту: P / PER_GROUP, не больше MAX_RATE; людей в группе — 1 + P / PER_PERSON, до 6. */
export const WALK_FLOW = { perGroup: 400, maxRate: 1.5, perPerson: 150, maxGroup: 6 };
/**
 * Нерегулируемый переход: пешеходы идут в просвет — подъезжающий должен спокойно остановиться до стоп-линии с
 * торможением soft (м/с²) и ещё margin м в запасе (50 км/ч — ~47 м до стоп-линии); прождав patience с — и при
 * торможении hard. Прежде (5 м/с², 1 м, через 10 с — 9 м/с²) группы вклинивались в плотный поток каждые полминуты на
 * каждом подъезде — на загруженных улицах крупных кварталов это копилось в пробки (машины мира 7 за 9 месяцев:
 * прибытия −40 %, стоящих — вдвое больше; теперь −15 % и не растёт). На светофоре — свой терпёж lightPatience: идут на
 * свой «зелёный», даже если до конца фазы не успеют.
 */
export const WALK_YIELD = { soft: 2.5, hard: 4, patience: 90, margin: 8, lightPatience: 10 };

/** Групп на переход в минуту по жителям вокруг. */
export const walkRate = (people: number) => Math.min(WALK_FLOW.maxRate, people / WALK_FLOW.perGroup);
/** Людей в группе по жителям вокруг. */
export const groupSize = (people: number) => Math.min(WALK_FLOW.maxGroup, 1 + Math.floor(people / WALK_FLOW.perPerson));

export interface Crossing {
  key: string;
  walk: GraphWalk;
  /** Жители вокруг (по ним поток). */
  people: number;
  /** Номер следующей группы и когда она придёт к бордюру. */
  n: number;
  next: number;
  /** Ждут у бордюра: сколько человек, с какого времени, с какого конца (0 — со стороны lo, 1 — hi). */
  waiting: number;
  since: number;
  from: 0 | 1;
  /** Идут по зебре: с какого времени, сколько секунд. */
  cross: { t0: number; dur: number; n: number; from: 0 | 1 } | null;
  /** Светофор узла даёт им идти (для пешеходного светофора); у нерегулируемого — null. */
  signal: boolean | null;
  /** Зебра закрыта машинам: въезд (к узлу) и выезд (от узла). */
  barriers: [Barrier, Barrier];
}

/** Через сколько секунд придёт следующая группа: в среднем 60 / rate, от половины до полутора. */
function gapAfter(c: Pick<Crossing, 'key' | 'n'>, rate: number, seed: number): number {
  if (rate <= 0) return Infinity;
  return (60 / rate) * (0.5 + hash(seed, c.n));
}

const seedOf = (walk: GraphWalk) => walk.node * 7919 + walk.corridor;

export class Crosswalks {
  list: Crossing[] = [];
  private serial = -1;
  /** Жители вокруг перекрёстка node (кэш до пересчёта раз в месяц). */
  private people = new Map<number, number>();

  /** on — пешеходы ходят (по умолчанию PEDESTRIANS_ON; тесты пешеходов включают их своему экземпляру). */
  constructor(
    private readonly peopleAt: (p: Vec, r: number) => number,
    readonly on = PEDESTRIANS_ON,
  ) {}

  /** Город вырос: жители вокруг переходов — заново. */
  refreshPeople(): void {
    this.people.clear();
    for (const c of this.list) c.people = this.peopleNear(c.walk);
  }

  private peopleNear(w: GraphWalk): number {
    let p = this.people.get(w.node);
    if (p === undefined) {
      const [a, b] = w.geo.ends;
      p = this.peopleAt({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, WALK_REACH);
      this.people.set(w.node, p);
    }
    return p;
  }

  /** Переходы — по графу: новые узнаются, прежние (тот же узел и подъезд) сохраняют пешеходов. */
  sync(graph: LaneGraph, time: number, traffic: LaneTraffic): void {
    if (graph.serial === this.serial) return;
    this.serial = graph.serial;
    const was = new Map(this.list.map((c) => [c.key, c]));
    const list: Crossing[] = [];
    for (const walks of graph.crosswalks.values()) {
      for (const walk of walks) {
        const key = `${walk.node}:${walk.corridor}`;
        const old = was.get(key);
        const barriers = this.barriersOf(walk);
        if (old) {
          barriers[0].closed = barriers[1].closed = !!old.cross;
          list.push({ ...old, walk, barriers });
          continue;
        }
        const people = this.peopleNear(walk);
        const c: Crossing = { key, walk, people, n: 0, next: 0, waiting: 0, since: 0, from: 0, cross: null, signal: null, barriers };
        c.next = time + gapAfter(c, walkRate(people), seedOf(walk)) * 0.5;
        list.push(c);
      }
    }
    this.list = list;
    const map = new Map<number, Barrier[]>();
    for (const c of list) {
      const arr = map.get(c.walk.corridor);
      if (arr) arr.push(...c.barriers);
      else map.set(c.walk.corridor, [...c.barriers]);
    }
    traffic.walks = map;
  }

  /**
   * Стоп-линии зебры: въезд — у стоп-линии перед ней (с поправкой на полкузова: шлагбаум меряют от середины машины),
   * выезд — у самого края площадки: поворачивающие в подъезд ждут перед перекрёстком.
   */
  private barriersOf(walk: GraphWalk): [Barrier, Barrier] {
    // Ход к узлу: у конца a — против оси.
    const toNode: 1 | -1 = walk.end === 'a' ? -1 : 1;
    const half = XWALK.depth / 2;
    return [
      { s: walk.geo.s, closed: false, busy: false, flow: toNode, stop: half + XWALK.stopGap + 3.5 },
      { s: walk.geo.s, closed: false, busy: false, flow: -toNode as 1 | -1, stop: half + XWALK.gap - 0.05 },
    ];
  }

  /** Такт: группы приходят, ждут окна, идут; зебра закрыта, пока идут. */
  step(dt: number, time: number, graph: LaneGraph, traffic: LaneTraffic): void {
    // Пешеходы выключены: никто не приходит, зебра машинам не закрывается.
    if (!this.on) return;
    this.sync(graph, time, traffic);
    for (const c of this.list) {
      const seed = seedOf(c.walk);
      const L = graph.nodes.get(c.walk.node)?.lights ?? null;
      c.signal = pedestrianLight(graph, c.walk);
      if (c.cross) {
        if (time - c.cross.t0 >= c.cross.dur) {
          c.cross = null;
          c.barriers[0].closed = c.barriers[1].closed = false;
        }
        continue;
      }
      if (!c.waiting && time >= c.next) {
        c.waiting = groupSize(c.people);
        c.since = time;
        c.from = hash(seed + 1, c.n) < 0.5 ? 0 : 1;
        c.n++;
        c.next = time + gapAfter(c, walkRate(c.people), seed);
      }
      if (!c.waiting) continue;
      const waited = time - c.since;
      let go: boolean;
      // На светофоре — только на свой «зелёный» и если успеют до конца фазы («умный» светофор без машин держит фазу
      // короткими продлениями — прождав lightPatience, идут и так: въезд с подъезда подождёт их у стоп-линии).
      if (L) go = !!c.signal && (L.timer >= c.walk.time || waited > WALK_YIELD.lightPatience) && this.clear(c, graph, traffic, false, 0);
      else go = this.clear(c, graph, traffic, true, waited > WALK_YIELD.patience ? WALK_YIELD.hard : WALK_YIELD.soft);
      if (!go) continue;
      c.cross = { t0: time, dur: c.walk.time, n: c.waiting, from: c.from };
      c.waiting = 0;
      c.barriers[0].closed = c.barriers[1].closed = true;
    }
    void dt;
  }

  /**
   * Можно идти: на зебре никого, к подъезду через перекрёсток никто не едет и не получил проезд, подъезжающие (approach —
   * проверять их) успевают остановиться до стоп-линии с торможением brake.
   */
  private clear(c: Crossing, graph: LaneGraph, traffic: LaneTraffic, approach: boolean, brake: number): boolean {
    const w = c.walk;
    const zone = XWALK.gap + XWALK.depth + 0.5;
    if (w.outLink !== null) {
      const out = graph.links.get(w.outLink);
      for (const lane of out?.lanes ?? []) for (const v of lane.vehicles) if (v.s - v.length < zone) return false;
    }
    if (w.inLink !== null) {
      const inl = graph.links.get(w.inLink);
      for (const lane of inl?.lanes ?? []) {
        const line = lane.length - traffic.lineBack(lane.id);
        for (const v of lane.vehicles) {
          // Нос за стоп-линией — машина на зебре или въезжает на перекрёсток.
          if (v.s > line + 0.3) return false;
          if (!approach) break;
          const d = line - v.s;
          if ((v.v * v.v) / (2 * brake) + WALK_YIELD.margin > d) return false;
          // Дальше в очереди — тем более успеют.
          break;
        }
      }
    }
    // Через перекрёсток к этому подъезду: на манёвре или с бронью узла.
    const node = graph.nodes.get(w.node);
    for (const v of node?.reserved ?? []) {
      const key = v.onMovement ?? v.granted;
      const m = key ? graph.moves.get(key) : undefined;
      if (m && m.outLink === w.outLink) return false;
    }
    for (const m of graph.junctionMoves.get(w.node) ?? []) if (m.outLink === w.outLink && m.vehicles.length) return false;
    return true;
  }

  /** Пешеходы на переходах для отрисовки: где каждый (идущие — по зебре, ждущие — у бордюра). */
  pedestrians(time: number):{ pos: Vec; walking: boolean; seed: number }[] {
    const res: { pos: Vec; walking: boolean; seed: number }[] = [];
    for (const c of this.list) {
      const [a, b] = c.walk.geo.ends;
      const ax = b.x - a.x;
      const ay = b.y - a.y;
      const len = Math.hypot(ax, ay) || 1;
      // Вдоль дороги — поперёк перехода: группа идёт не гуськом, а вразброс по ширине зебры.
      const nx = -ay / len;
      const ny = ax / len;
      const seed = seedOf(c.walk);
      if (c.cross) {
        const t = Math.min(1, Math.max(0, (time - c.cross.t0 - XWALK.start / 2) / Math.max(0.1, c.cross.dur - XWALK.start)));
        for (let i = 0; i < c.cross.n; i++) {
          const lag = hash(seed + 3, i) * 0.12;
          const k = Math.min(1, Math.max(0, t * 1.12 - lag));
          const f = c.cross.from === 0 ? k : 1 - k;
          const side = (hash(seed + 5, i) - 0.5) * (XWALK.depth - 1.2);
          res.push({ pos: { x: a.x + ax * f + nx * side, y: a.y + ay * f + ny * side }, walking: true, seed: seed * 13 + i });
        }
      }
      if (c.waiting) {
        const at = c.from === 0 ? a : b;
        for (let i = 0; i < c.waiting; i++) {
          const side = (i - (c.waiting - 1) / 2) * 1.3;
          res.push({ pos: { x: at.x + nx * side, y: at.y + ny * side }, walking: false, seed: seed * 17 + i });
        }
      }
    }
    return res;
  }
}

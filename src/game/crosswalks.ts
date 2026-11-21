import { XWALK } from '../lanes/crosswalk';
import type { GraphWalk, LaneGraph } from '../lanes/graph';
import type { Barrier, LaneTraffic } from '../lanes/traffic';

/**
 * Светофор перекрёстка пускает пешеходов на зебру walk: въезду с подъезда красный (и не жёлтый); перекрёсток без
 * светофора — null. Своих пешеходных светофоров на карте нет — идут по сигналу машинам.
 */
export function walkGreen(graph: LaneGraph, walk: Pick<GraphWalk, 'node' | 'inLink'>): boolean | null {
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
export const WALK_YIELD = { soft: 2.5, hard: 4, patience: 90, margin: 8, lightPatience: 10 };

interface Crossing {
  walk: GraphWalk;
  barriers: [Barrier, Barrier];
  until: number;
}

export const walkKey = (w: GraphWalk) => `${w.node}:${w.corridor}`;

/** Машины уступают реальным жителям, которые дошли по тротуару до края зебры. */
export class Crosswalks {
  readonly crossings = new Map<string, Crossing>();
  private readonly occupied = new Set<Crossing>();
  private serial = -1;

  reset(traffic: LaneTraffic): void {
    this.serial = -1;
    this.occupied.clear();
    this.crossings.clear();
    traffic.walks.clear();
  }

  step(time: number, graph: LaneGraph, traffic: LaneTraffic): void {
    if (this.serial !== graph.serial) {
      const previous = new Map(this.crossings);
      this.reset(traffic);
      this.serial = graph.serial;
      for (const walks of graph.crosswalks.values()) {
        for (const walk of walks) {
          if (walk.underground) continue;
          const key = walkKey(walk);
          const until = previous.get(key)?.until ?? 0;
          const barriers = this.barriersOf(walk);
          const c = { walk, barriers, until };
          this.crossings.set(key, c);
          if (until > time) this.occupy(c, traffic);
        }
      }
    }
    for (const c of this.occupied) {
      if (time < c.until) continue;
      c.barriers[0].closed = c.barriers[1].closed = false;
      this.occupied.delete(c);
      const corridor = c.walk.corridor;
      const rest = traffic.walks.get(corridor)?.filter((b) => b.closed);
      if (rest?.length) traffic.walks.set(corridor, rest);
      else traffic.walks.delete(corridor);
    }
  }

  /** В таблице препятствий движения нужны только занятые сейчас зебры. */
  private occupy(c: Crossing, traffic: LaneTraffic): void {
    if (this.occupied.has(c)) return;
    this.occupied.add(c);
    c.barriers[0].closed = c.barriers[1].closed = true;
    const list = traffic.walks.get(c.walk.corridor);
    if (list) list.push(...c.barriers);
    else traffic.walks.set(c.walk.corridor, [...c.barriers]);
  }

  /** Закрываем зебру до момента, когда этот пешеход фактически достигнет другого бордюра. */
  extend(key: string, until: number): void {
    const c = this.crossings.get(key);
    if (c && this.occupied.has(c)) c.until = Math.max(c.until, until);
  }

  /** Войти можно, когда позволяет сигнал и успевают затормозить машины. */
  enter(key: string, time: number, waited: number, duration: number, graph: LaneGraph, traffic: LaneTraffic): boolean {
    const c = this.crossings.get(key);
    if (!c) return false;
    const lights = graph.nodes.get(c.walk.node)?.lights;
    if (lights && (!walkGreen(graph, c.walk) || (lights.timer < duration && waited < WALK_YIELD.lightPatience))) return false;
    if (!this.clear(c, graph, traffic, !lights, waited >= WALK_YIELD.patience ? WALK_YIELD.hard : WALK_YIELD.soft)) return false;
    c.until = Math.max(c.until, time + duration);
    this.occupy(c, traffic);
    return true;
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
          if (v.v > 0.2 && (v.v * v.v) / (2 * brake) + WALK_YIELD.margin > d) return false;
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
}

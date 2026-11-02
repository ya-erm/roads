import type { Vec } from '../core/vec';
import { dist } from '../core/vec';
import { GLane, GLink, GMove, LaneGraph } from '../lanes/graph';
import { LaneNet, LaneNode } from '../lanes/model';
import { findLaneRoute, linkCost, transitionCost } from '../lanes/routing';
import { changePenalty, LaneTraffic, LaneTrafficEvents } from '../lanes/traffic';

/** Размер кольца: радиус оси (если примыкающие дороги шире, кольцо будет больше). */
export type RingSize = 'small' | 'medium' | 'large';
export const RING_SIZES: Record<RingSize, number> = { small: 30, medium: 46, large: 66 };

export interface RingOptions {
  lanes: number;
  size: RingSize;
}

export const DEFAULT_RING: RingOptions = { lanes: 1, size: 'small' };

/**
 * Дороги игры: сеть полос (что построено), граф движения по ней (пересобирается после правок)
 * и машины. Маршруты — списки связей графа между узлами, где можно начать и кончить поездку.
 */
export class Roads {
  net = new LaneNet();
  graph: LaneGraph;
  readonly traffic: LaneTraffic;
  private graphOf: { net: LaneNet; version: number };

  constructor(events: LaneTrafficEvents) {
    this.graph = new LaneGraph(this.net);
    this.graphOf = { net: this.net, version: this.net.version };
    this.traffic = new LaneTraffic(this.graph, events);
  }

  /** Сеть поменялась (стройка, рост города): граф заново, машины переезжают на него. */
  changed(): void {
    if (this.graphOf.net === this.net && this.graphOf.version === this.net.version) return;
    this.graph = new LaneGraph(this.net);
    this.graphOf = { net: this.net, version: this.net.version };
    this.traffic.rebind(this.graph);
  }

  /** Новая сеть целиком (загрузка, отмена). */
  replace(net: LaneNet): void {
    this.net = net;
    this.changed();
  }

  /** Узел, где можно начать и кончить поездку: перекрёсток или тупик (через стык полосы просто идут дальше). */
  routable(id: number): boolean {
    const n = this.net.nodes.get(id);
    return !!n && (n.kind === 'junction' || this.net.isDeadEnd(n));
  }

  /** Ближайший к точке узел, где можно начать и кончить поездку. */
  nearestRoutable(p: Vec, r: number): LaneNode | null {
    let best: LaneNode | null = null;
    for (const n of this.net.nodesNear(p, r)) {
      if (!this.routable(n.id)) continue;
      if (!best || dist(n.pos, p) < dist(best.pos, p)) best = n;
    }
    return best;
  }

  /** Маршрут между узлами: связи графа; нет пути — null. */
  route(from: number, to: number): number[] | null {
    if (from === to) return null;
    return findLaneRoute(this.graph, this.graph.outLinks.get(from) ?? [], to);
  }

  /** Обратная Дейкстра от цели: ближайший узел из candidates и маршрут от него до цели. */
  nearestSource(goal: number, candidates: Set<number>, maxCost = Infinity): { source: number; route: number[]; cost: number } | null {
    const g = this.graph;
    const cost = new Map<number, number>();
    const next = new Map<number, number>();
    const open: { c: number; link: GLink }[] = [];
    for (const link of g.inLinks.get(goal) ?? []) {
      cost.set(link.id, linkCost(link));
      open.push({ c: linkCost(link), link });
    }
    const closed = new Set<number>();
    while (open.length) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (open[i].c < open[bi].c) bi = i;
      const { c, link } = open.splice(bi, 1)[0];
      if (c > maxCost) return null;
      if (closed.has(link.id)) continue;
      closed.add(link.id);
      if (link.fromNode !== null && candidates.has(link.fromNode)) {
        const route = [link.id];
        while (next.has(route[route.length - 1])) route.push(next.get(route[route.length - 1])!);
        return { source: link.fromNode, route, cost: c };
      }
      for (const prevId of g.linkPrev.get(link.id) ?? []) {
        const before = g.links.get(prevId);
        if (!before || closed.has(prevId)) continue;
        const nc = c + transitionCost(g, before, link) + linkCost(before);
        if (nc < (cost.get(prevId) ?? Infinity)) {
          cost.set(prevId, nc);
          next.set(prevId, link.id);
          open.push({ c: nc, link: before });
        }
      }
    }
    return null;
  }

  /** Длина маршрута. */
  routeLength(route: number[]): number {
    return route.reduce((sum, id) => sum + (this.graph.links.get(id)?.length ?? 0), 0);
  }

  /** Линия маршрута на карте: по первой полосе каждой связи. */
  /**
   * Линия маршрута для карты — по полосам, которыми поедут машины: с наименьшей трудностью перестроений
   * (как их выбирают сами машины), перестроение — плавно посередине связи, повороты — по кривым манёвров.
   */
  routePolyline(route: number[]): Vec[] {
    const g = this.graph;
    const links = route.map((id) => g.links.get(id)).filter((l): l is GLink => !!l);
    if (!links.length) return [];
    const exits = (k: number, o: GLane) => (k + 1 < links.length ? (g.movesFrom.get(o.id) ?? []).filter((m) => m.outLink === links[k + 1].id) : []);
    // С конца: out — трудность дальше, если покинуть связь k по полосе; enter — если въехать на неё по полосе.
    const out: Map<number, number>[] = new Array(links.length);
    const enter: Map<number, number>[] = new Array(links.length);
    for (let k = links.length - 1; k >= 0; k--) {
      const link = links[k];
      out[k] = new Map(link.lanes.map((o) => [o.id, k === links.length - 1 ? 0 : Math.min(Infinity, ...exits(k, o).map((m) => enter[k + 1].get(m.outLane) ?? Infinity))]));
      enter[k] = new Map(link.lanes.map((l) => [l.id, Math.min(...link.lanes.map((o) => changePenalty(Math.abs(o.index - l.index), link.length) + out[k].get(o.id)!))]));
    }
    const pts: Vec[] = [];
    let lane = links[0].lanes.reduce((a, b) => ((enter[0].get(b.id) ?? Infinity) < (enter[0].get(a.id) ?? Infinity) ? b : a));
    for (let k = 0; k < links.length; k++) {
      const link = links[k];
      // Куда перестроиться на этой связи (сама полоса — при равенстве).
      let to = lane;
      let cost = out[k].get(lane.id) ?? Infinity;
      for (const o of link.lanes) {
        const c = changePenalty(Math.abs(o.index - lane.index), link.length) + (out[k].get(o.id) ?? Infinity);
        if (c < cost - 1e-6) {
          to = o;
          cost = c;
        }
      }
      const steps = Math.max(2, Math.ceil(link.length / 8));
      for (let i = 0; i <= steps; i++) {
        const s = (link.length * i) / steps;
        const a = g.lanePose(lane, s).pos;
        if (to === lane) {
          pts.push(a);
          continue;
        }
        const b = g.lanePose(to, s).pos;
        const t = Math.max(0, Math.min(1, (i / steps - 0.3) / 0.4));
        const w = t * t * (3 - 2 * t);
        pts.push({ x: a.x + (b.x - a.x) * w, y: a.y + (b.y - a.y) * w });
      }
      if (k + 1 === links.length) break;
      const move = exits(k, to).reduce<GMove | null>((m, x) => (!m || (enter[k + 1].get(x.outLane) ?? Infinity) < (enter[k + 1].get(m.outLane) ?? Infinity) ? x : m), null);
      const next = move && g.lanes.get(move.outLane);
      if (!move || !next) {
        lane = links[k + 1].lanes[Math.floor(links[k + 1].lanes.length / 2)];
        continue;
      }
      pts.push(...move.points);
      lane = next;
    }
    return pts;
  }
}

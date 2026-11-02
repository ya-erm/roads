import type { Vec } from '../core/vec';
import { dist } from '../core/vec';
import { GLink, LaneGraph } from '../lanes/graph';
import { LaneNet, LaneNode } from '../lanes/model';
import { findLaneRoute, linkCost, transitionCost } from '../lanes/routing';
import { LaneTraffic, LaneTrafficEvents } from '../lanes/traffic';

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
  routePolyline(route: number[]): Vec[] {
    const pts: Vec[] = [];
    for (const id of route) {
      const link = this.graph.links.get(id);
      if (!link) continue;
      const lane = link.lanes[Math.floor(link.lanes.length / 2)];
      const steps = Math.max(1, Math.ceil(link.length / 12));
      for (let k = 0; k <= steps; k++) pts.push(this.graph.lanePose(lane, (link.length * k) / steps).pos);
    }
    return pts;
  }
}

import { dist } from '../core/vec';
import type { Link, Network } from '../world/network';

class MinHeap<T> {
  private items: { key: number; value: T }[] = [];

  get size(): number {
    return this.items.length;
  }

  push(key: number, value: T): void {
    const items = this.items;
    items.push({ key, value });
    let i = items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (items[p].key <= items[i].key) break;
      [items[p], items[i]] = [items[i], items[p]];
      i = p;
    }
  }

  pop(): { key: number; value: T } | undefined {
    const items = this.items;
    if (!items.length) return undefined;
    const top = items[0];
    const last = items.pop()!;
    if (items.length) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < items.length && items[l].key < items[m].key) m = l;
        if (r < items.length && items[r].key < items[m].key) m = r;
        if (m === i) break;
        [items[m], items[i]] = [items[i], items[m]];
        i = m;
      }
    }
    return top;
  }
}

const MAX_SPEED = 40;

/** Время проезда связи в секундах с учётом загрузки. */
export function linkCost(link: Link): number {
  let count = 0;
  let stopped = 0;
  for (const lane of link.lanes) {
    count += lane.vehicles.length;
    for (const v of lane.vehicles) if (v.v < 2) stopped++;
  }
  const lanes = link.lanes.length;
  return link.length / link.speed + (count * 0.3 + stopped * 1.2) / lanes;
}

/** Стоимость перехода между связями через узел. */
export function transitionCost(net: Network, from: Link, to: Link): number {
  const node = net.node(from.to);
  let best = Infinity;
  for (const m of net.transitions.get(`${from.id}>${to.id}`) ?? []) {
    best = Math.min(best, m.length / m.speed + m.vehicles.length * 0.4);
  }
  if (node.segments.length >= 3) best += 0.4;
  if (node.control === 'lights') best += 2.5;
  else if (node.priorityLanes.size && !node.priorityLanes.has(from.lanes[0].id)) best += 1;
  return best;
}

function rebuildPath(prev: Map<number, number>, last: number): number[] {
  const path = [last];
  let cur = last;
  while (prev.has(cur)) {
    cur = prev.get(cur)!;
    path.push(cur);
  }
  return path.reverse();
}

/** A* по связям. Возвращает список id связей от одной из стартовых до узла goalNode. */
export function findRoute(net: Network, startLinks: Link[], goalNode: number): number[] | null {
  const goal = net.nodes.get(goalNode);
  if (!goal) return null;
  const h = (link: Link) => dist(net.node(link.to).pos, goal.pos) / MAX_SPEED;
  const g = new Map<number, number>();
  const prev = new Map<number, number>();
  const heap = new MinHeap<Link>();
  for (const link of startLinks) {
    const c = linkCost(link);
    g.set(link.id, c);
    heap.push(c + h(link), link);
  }
  const closed = new Set<number>();
  while (heap.size) {
    const { value: link } = heap.pop()!;
    if (closed.has(link.id)) continue;
    closed.add(link.id);
    if (link.to === goalNode) return rebuildPath(prev, link.id);
    const base = g.get(link.id)!;
    for (const nextId of net.linkNext.get(link.id) ?? []) {
      const next = net.links.get(nextId);
      if (!next || closed.has(nextId)) continue;
      const cost = base + transitionCost(net, link, next) + linkCost(next);
      if (cost < (g.get(nextId) ?? Infinity)) {
        g.set(nextId, cost);
        prev.set(nextId, link.id);
        heap.push(cost + h(next), next);
      }
    }
  }
  return null;
}

export function routeFromNode(net: Network, startNode: number, goalNode: number): number[] | null {
  if (startNode === goalNode) return null;
  return findRoute(net, net.outLinks.get(startNode) ?? [], goalNode);
}

/**
 * Обратная Дейкстра от цели: ближайший узел из candidates и маршрут от него до цели.
 */
export function nearestSource(
  net: Network,
  goalNode: number,
  candidates: Set<number>,
  maxCost = Infinity,
): { source: number; route: number[]; cost: number } | null {
  const g = new Map<number, number>();
  const next = new Map<number, number>();
  const heap = new MinHeap<Link>();
  for (const link of net.inLinks.get(goalNode) ?? []) {
    const c = linkCost(link);
    g.set(link.id, c);
    heap.push(c, link);
  }
  const closed = new Set<number>();
  while (heap.size) {
    const { key, value: link } = heap.pop()!;
    if (key > maxCost) return null;
    if (closed.has(link.id)) continue;
    closed.add(link.id);
    if (candidates.has(link.from)) {
      const route = [link.id];
      let cur = link.id;
      while (next.has(cur)) {
        cur = next.get(cur)!;
        route.push(cur);
      }
      return { source: link.from, route, cost: key };
    }
    const base = g.get(link.id)!;
    for (const prevId of net.linkPrev.get(link.id) ?? []) {
      const before = net.links.get(prevId);
      if (!before || closed.has(prevId)) continue;
      const cost = base + transitionCost(net, before, link) + linkCost(before);
      if (cost < (g.get(prevId) ?? Infinity)) {
        g.set(prevId, cost);
        next.set(prevId, link.id);
        heap.push(cost, before);
      }
    }
  }
  return null;
}

/** Длина маршрута в единицах мира. */
export function routeLength(net: Network, route: number[]): number {
  let total = 0;
  for (const id of route) total += net.links.get(id)?.length ?? 0;
  return total;
}

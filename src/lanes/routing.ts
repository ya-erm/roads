import { dist, dot } from '../core/vec';
import { KMH_PER_UNIT } from '../world/roadTypes';
import type { GLink, LaneGraph } from './graph';

/** Самая большая скорость в сети — для оценки остатка пути в A*. */
const MAX_SPEED = 120 / KMH_PER_UNIT;

export const linkCost = (l: GLink) => l.length / l.speed;

/** Стоимость перехода между связями: продолжение полосы — даром, манёвр — по длине, очереди и узлу. */
export function transitionCost(g: LaneGraph, from: GLink, to: GLink): number {
  let best = Infinity;
  for (const m of g.transitions.get(`${from.id}>${to.id}`) ?? []) {
    if (m.cont) return 0;
    best = Math.min(best, m.length / m.speed + m.vehicles.length * 0.4);
  }
  const node = from.toNode !== null ? g.nodes.get(from.toNode) : undefined;
  if (node) {
    best += 0.4;
    if (node.priorityLanes.size && !node.priorityLanes.has(from.lanes[0].id)) best += 1;
  }
  return best;
}

/** A* по связям: список id связей от одной из стартовых до узла goal. */
export function findLaneRoute(g: LaneGraph, starts: GLink[], goal: number): number[] | null {
  const target = g.net.nodes.get(goal);
  if (!target) return null;
  const endOf = (l: GLink) => g.lanePose(l.lanes[0], l.length).pos;
  const h = (l: GLink) => dist(endOf(l), target.pos) / MAX_SPEED;
  // Цель с одной стороны (LaneNode.arrive) — только связи, что подходят к ней по ходу этой стороны.
  const side = target.arrive;
  const arrives = (l: GLink) => !side || dot(g.lanePose(l.lanes[0], l.length).dir, target.dir) * side > 0;
  const cost = new Map<number, number>();
  const prev = new Map<number, number>();
  const open = new Heap<GLink>();
  for (const l of starts) {
    cost.set(l.id, linkCost(l));
    open.push(linkCost(l) + h(l), l);
  }
  const closed = new Set<number>();
  while (open.size) {
    const link = open.pop()!;
    if (closed.has(link.id)) continue;
    closed.add(link.id);
    if (link.toNode === goal && arrives(link)) {
      const path = [link.id];
      while (prev.has(path[0])) path.unshift(prev.get(path[0])!);
      return path;
    }
    const base = cost.get(link.id)!;
    for (const nextId of g.linkNext.get(link.id) ?? []) {
      const next = g.links.get(nextId);
      if (!next || closed.has(nextId)) continue;
      const c = base + transitionCost(g, link, next) + linkCost(next);
      if (c < (cost.get(nextId) ?? Infinity)) {
        cost.set(nextId, c);
        prev.set(nextId, link.id);
        open.push(c + h(next), next);
      }
    }
  }
  return null;
}

/** Двоичная куча по ключу: pop — элемент с наименьшим ключом. */
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

  pop(): T | undefined {
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
    return top.v;
  }
}

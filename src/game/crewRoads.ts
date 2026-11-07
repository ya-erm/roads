/**
 * Дороги для строительной техники (стройка: construction.ts, crews.ts). Подъезд к стройке — без учёта направления
 * полос: узел доступен с ворот базы, если до него можно добраться по готовым дорогам, проезжая полотна в обе стороны
 * (reach). Так стройку можно начать и с конца, к которому ведёт только съезд «от проекта» (выезд из тоннеля).
 *
 * Сама поездка (step) — по обычным правилам, машинами в потоке, насколько это возможно, а где по правилам не доехать —
 * короткий отрезок против движения вдоль дороги (как будто там стоит регулировщик), не в потоке, той же колонной, что
 * и вдоль стройки (Crews.walk). Отрезок против движения — либо в конце (по правилам до ближайшего к цели узла, оттуда
 * — против движения), либо в начале (против движения до ближайшего узла, откуда по правилам до цели доехать можно):
 * что короче. Ни телепорта, ни поездки по полю: против движения — только по оси готовых полотен.
 *
 * Всё считается по графу движения (его сеть — открытая, без строящегося) и запоминается до смены графа. Детерминизм:
 * обход — по номерам узлов и полотен, при равных длинах — меньший номер.
 */
import type { Vec } from '../core/vec';
import type { LaneGraph } from '../lanes/graph';
import type { Corridor } from '../lanes/model';

/**
 * Шаг пути строительной техники от узла к узлу: по дорогам в потоке до узла drive (это цель или узел, откуда дальше —
 * против движения) или против движения вдоль дороги по точкам walk до узла node (оттуда — дальше по правилам или уже
 * на месте).
 */
export type CrewStep = { drive: number } | { walk: Vec[]; node: number };

interface Edge {
  c: Corridor;
  to: number;
}

/** Двоичная куча по (расстояние, номер узла): при равных расстояниях — меньший номер. */
class NodeHeap {
  private items: { d: number; n: number }[] = [];
  get size(): number {
    return this.items.length;
  }
  private less(i: number, j: number): boolean {
    const a = this.items[i];
    const b = this.items[j];
    return a.d < b.d - 1e-9 || (Math.abs(a.d - b.d) <= 1e-9 && a.n < b.n);
  }
  push(d: number, n: number): void {
    const it = this.items;
    it.push({ d, n });
    let i = it.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      [it[i], it[p]] = [it[p], it[i]];
      i = p;
    }
  }
  pop(): { d: number; n: number } {
    const it = this.items;
    const top = it[0];
    const last = it.pop()!;
    if (it.length) {
      it[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < it.length && this.less(l, m)) m = l;
        if (r < it.length && this.less(r, m)) m = r;
        if (m === i) break;
        [it[i], it[m]] = [it[m], it[i]];
        i = m;
      }
    }
    return top;
  }
}

export class CrewRoads {
  private graph: LaneGraph | null = null;
  /** Полотна графа у каждого узла — в обе стороны, по номерам. */
  private adj = new Map<number, Edge[]>();
  /** Связность без учёта направления: номер куска сети у узла. */
  private comp = new Map<number, number>();
  /** Куда по правилам доехать от узла и откуда по правилам доехать до узла. */
  private fwd = new Map<number, Set<number>>();
  private bwd = new Map<number, Set<number>>();
  private steps = new Map<string, CrewStep | null>();

  /** Узел, где можно начать и кончить поездку (перекрёсток, тупик): промежуточные узлы пути — только такие. */
  private routable(g: LaneGraph, id: number): boolean {
    const n = g.net.nodes.get(id);
    return !!n && (n.kind === 'junction' || g.net.isDeadEnd(n));
  }

  private sync(g: LaneGraph): void {
    if (this.graph === g) return;
    this.graph = g;
    this.adj = new Map();
    this.comp = new Map();
    this.fwd = new Map();
    this.bwd = new Map();
    this.steps = new Map();
    const net = g.net;
    const ids = [...net.corridors.keys()].sort((a, b) => a - b);
    const push = (n: number, e: Edge) => {
      let list = this.adj.get(n);
      if (!list) this.adj.set(n, (list = []));
      list.push(e);
    };
    for (const id of ids) {
      const c = net.corridors.get(id)!;
      if (c.build || !c.lanes.length) continue;
      push(c.a, { c, to: c.b });
      if (c.b !== c.a) push(c.b, { c, to: c.a });
    }
    let label = 0;
    for (const start of [...this.adj.keys()].sort((a, b) => a - b)) {
      if (this.comp.has(start)) continue;
      label++;
      const stack = [start];
      this.comp.set(start, label);
      while (stack.length) {
        const u = stack.pop()!;
        for (const e of this.adj.get(u) ?? []) {
          if (this.comp.has(e.to)) continue;
          this.comp.set(e.to, label);
          stack.push(e.to);
        }
      }
    }
  }

  private onRoad(g: LaneGraph, node: number): boolean {
    return g.outLinks.has(node) || g.inLinks.has(node);
  }

  /** От узла from до узла to можно добраться по готовым дорогам, проезжая полотна в обе стороны. */
  reach(g: LaneGraph, from: number, to: number): boolean {
    if (!this.onRoad(g, from) || !this.onRoad(g, to)) return false;
    if (from === to) return true;
    this.sync(g);
    const a = this.comp.get(from);
    return a !== undefined && a === this.comp.get(to);
  }

  /** Узлы, куда по правилам доехать от from (forward) или откуда по правилам доехать до from (назад). */
  private flow(g: LaneGraph, node: number, forward: boolean): Set<number> {
    const cache = forward ? this.fwd : this.bwd;
    let hit = cache.get(node);
    if (hit) return hit;
    hit = new Set();
    const seen = new Set<number>();
    const queue = [...((forward ? g.outLinks : g.inLinks).get(node) ?? [])].map((l) => l.id);
    for (const id of queue) seen.add(id);
    while (queue.length) {
      const l = g.links.get(queue.pop()!);
      if (!l) continue;
      const end = forward ? l.toNode : l.fromNode;
      if (end !== null) hit.add(end);
      for (const next of (forward ? g.linkNext : g.linkPrev).get(l.id) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    cache.set(node, hit);
    return hit;
  }

  /**
   * Дейкстра без учёта направления от узла src по длине полотен: первый узел, для которого ok (по расстоянию, при
   * равных — prefer, иначе меньший номер), расстояние до него и полотна пути от src к нему.
   */
  private nearest(src: number, ok: (n: number) => boolean, prefer: number): { node: number; d: number; legs: { c: Corridor; from: number }[] } | null {
    const far = new Map<number, number>([[src, 0]]);
    const prev = new Map<number, { c: Corridor; from: number }>();
    const done = new Set<number>();
    const heap = new NodeHeap();
    heap.push(0, src);
    let found: { node: number; d: number } | null = null;
    while (heap.size) {
      const { d, n } = heap.pop();
      if (done.has(n)) continue;
      if (found && d > found.d + 1e-6) break;
      done.add(n);
      if (ok(n)) {
        if (!found || n === prefer) found = { node: n, d };
        if (n === prefer) break;
        continue;
      }
      for (const e of this.adj.get(n) ?? []) {
        const dv = d + e.c.length;
        if (dv < (far.get(e.to) ?? Infinity) - 1e-9) {
          far.set(e.to, dv);
          prev.set(e.to, { c: e.c, from: n });
          heap.push(dv, e.to);
        }
      }
    }
    if (!found) return null;
    const legs: { c: Corridor; from: number }[] = [];
    for (let node = found.node, step = prev.get(node); node !== src && step; node = step.from, step = prev.get(node)) legs.unshift(step);
    return { ...found, legs };
  }

  /** Точки вдоль оси полотен legs (каждое — от своего узла from к другому концу). */
  private points(g: LaneGraph, start: number, legs: { c: Corridor; from: number }[]): Vec[] {
    const pts: Vec[] = [{ ...g.net.node(start).pos }];
    for (const { c, from } of legs) {
      const fwd = c.a === from;
      const n = Math.max(1, Math.ceil(c.length / 10));
      for (let i = 1; i <= n; i++) pts.push(c.lut.pointAt(fwd ? (c.length * i) / n : c.length - (c.length * i) / n));
    }
    return pts;
  }

  /**
   * Следующий шаг пути от узла from к узлу to (разные): по правилам до самой цели — { drive: to }; иначе — с
   * наименьшим отрезком против движения: по правилам до узла R, оттуда против движения до цели ({ drive: R }, у R —
   * следующий шаг), либо против движения до узла R, откуда по правилам до цели доехать можно ({ walk, node: R }).
   * Не добраться и без учёта направления — null.
   */
  step(g: LaneGraph, from: number, to: number): CrewStep | null {
    if (from === to || !this.reach(g, from, to)) return null;
    this.sync(g);
    const key = `${from}>${to}`;
    if (this.steps.has(key)) return this.steps.get(key)!;
    if (this.steps.size > 20_000) this.steps.clear();
    const fwd = this.flow(g, from, true);
    const bwd = this.flow(g, to, false);
    let out: CrewStep | null;
    if (fwd.has(to)) out = { drive: to };
    else {
      // Против движения в конце: от цели — к ближайшему узлу, куда по правилам доехать от from (или к самому from).
      const end = this.nearest(to, (n) => n === from || (fwd.has(n) && this.routable(g, n)), from);
      // Против движения в начале: от from — к ближайшему узлу, откуда по правилам доехать до цели (или к самой цели).
      const head = this.nearest(from, (n) => n === to || (bwd.has(n) && this.routable(g, n)), to);
      if (end && (!head || end.d <= head.d + 1e-6)) {
        if (end.node === from) {
          // Своим ходом против движения до самой цели: путь — от from (legs найдены от цели к from — наоборот).
          const pts = this.points(g, to, end.legs).reverse();
          out = { walk: pts, node: to };
        } else out = { drive: end.node };
      } else if (head) out = { walk: this.points(g, from, head.legs), node: head.node };
      else out = null;
    }
    this.steps.set(key, out);
    return out;
  }
}

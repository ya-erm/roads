import { angleDiff, angleOf, dist, dot, scale, add, sub, type Vec } from '../core/vec';
import type { Box } from '../lanes/curb';
import { bezier, legPose, steeringLeg, straight, type Leg } from './lotMoves';

interface Pose { c: Vec; h: Vec }
interface Node extends Pose { back: boolean; changes: number; cost: number; rank: number; prev?: Node; leg?: Leg }
const RADIUS = 4.5;
const STEP = 2;

/** Весь кузов на пути, включая промежутки между узлами кривой. */
export function clearYardLeg(leg: Leg, length: number, width: number, clear: (box: Box) => boolean): boolean {
  let last: Pose | undefined;
  for (let i = 0, n = Math.max(1, Math.ceil(leg.len / 0.3)); i <= n; i++) {
    const p = legPose(leg, leg.len * i / n);
    if (!clear({ c: p.c, d: p.h, hl: length / 2 + 0.12, hw: width / 2 + 0.12 })) return false;
    // Не допускаем тесные петли и переломы касательной: радиус середины кузова не меньше 3,8 м игры.
    if (last) {
      const turn = Math.abs(angleDiff(angleOf(last.h), angleOf(p.h)));
      if (turn > 1e-4 && dist(last.c, p.c) / turn < 3.8) return false;
    }
    last = p;
  }
  return true;
}

/**
 * Короткий разворот внутри участка: поиск по положению, курсу и передаче. Дуги имеют радиус поворота машины,
 * смен хода не больше трёх; последний ход — передом к выезду. Ограниченный поиск: в тесноте вернёт null.
 */
export function planYardExit(start: Pose, goal: Pose, length: number, width: number, clear: (box: Box) => boolean, options: { step?: number; rearOffset?: number; startBack?: boolean; firstSteer?: number } = {}): Leg[] | null {
  const step = options.step ?? STEP;
  const heap: Node[] = [];
  const push = (n: Node) => {
    let i = heap.length;
    heap.push(n);
    while (i) {
      const p = (i - 1) >> 1;
      if (heap[p].rank <= n.rank) break;
      heap[i] = heap[p];
      i = p;
    }
    heap[i] = n;
  };
  const pop = () => {
    const n = heap[0];
    const tail = heap.pop()!;
    if (heap.length) {
      let i = 0;
      while (i * 2 + 1 < heap.length) {
        let j = i * 2 + 1;
        if (j + 1 < heap.length && heap[j + 1].rank < heap[j].rank) j++;
        if (tail.rank <= heap[j].rank) break;
        heap[i] = heap[j];
        i = j;
      }
      heap[i] = tail;
    }
    return n;
  };
  const heuristic = (p: Pose) => dist(p.c, goal.c) * 1.4 + RADIUS * Math.abs(angleDiff(angleOf(p.h), angleOf(goal.h)));
  const key = (n: Node) => `${Math.round(n.c.x / 0.65)}:${Math.round(n.c.y / 0.65)}:${Math.round(angleOf(n.h) * 18 / Math.PI)}:${+n.back}:${n.changes}`;
  const costs = new Map<string, number>();
  for (const back of [false, true]) push({ ...start, back, changes: 0, cost: 0, rank: heuristic(start) });
  for (let visits = 0; heap.length && visits < 12_000; visits++) {
    const n = pop();
    if ((costs.get(key(n)) ?? Infinity) < n.cost) continue;
    const d = dist(n.c, goal.c);
    if (d < 14 && dot(n.h, goal.h) > 0) {
      const finish = bezier(n.c, add(n.c, scale(n.h, d * 0.45)), sub(goal.c, scale(goal.h, d * 0.45)), goal.c, false, 6);
      if (clearYardLeg(finish, length, width, clear)) {
        const legs: Leg[] = [finish];
        for (let p: Node | undefined = n; p?.leg; p = p.prev) legs.unshift(p.leg);
        return mergeLegs(legs);
      }
    }
    for (const back of [n.back, !n.back]) {
      if (!n.prev && options.startBack && !back) continue;
      const changes = n.changes + +(back !== n.back);
      if (changes > 2 || (n.prev && back !== n.back && dist(n.c, n.prev.c) < step * 0.9)) continue;
      for (const steer of [0, -1, 1]) {
        if (!n.prev && options.firstSteer !== undefined && steer !== options.firstSteer) continue;
        const a = angleOf(n.h);
        const travel = back ? -step : step;
        const turn = travel * steer / RADIUS;
        const h = { x: Math.cos(a + turn), y: Math.sin(a + turn) };
        let c = steer ? { x: n.c.x + (Math.sin(a + turn) - Math.sin(a)) * RADIUS / steer, y: n.c.y + (Math.cos(a) - Math.cos(a + turn)) * RADIUS / steer } : add(n.c, scale(n.h, travel));
        const k = 4 / 3 * Math.tan(Math.abs(turn) / 4) * RADIUS;
        const leg = options.rearOffset !== undefined ? steeringLeg(n.c, n.h, travel, steer, RADIUS, options.rearOffset, back ? 2.5 : 6) : steer
          ? bezier(n.c, add(n.c, scale(n.h, back ? -k : k)), sub(c, scale(h, back ? -k : k)), c, back, back ? 2.5 : 6, 8)
          : straight(n.c, c, back, back ? 2.5 : 6);
        if (options.rearOffset !== undefined) c = leg.pts.at(-1)!;
        const cost = n.cost + step * (back ? 1.4 : 1) + (back !== n.back ? 8 : 0);
        const next = { c, h, back, changes, cost, rank: cost + heuristic({ c, h }), prev: n, leg };
        const id = key(next);
        if ((costs.get(id) ?? Infinity) <= cost || !clearYardLeg(leg, length, width, clear)) continue;
        costs.set(id, cost);
        push(next);
      }
    }
  }
  return null;
}

/** Одна передача — один отрезок: между маленькими дугами машина не тормозит и не меняет курс скачком. */
function mergeLegs(legs: Leg[]): Leg[] {
  const out: Leg[] = [];
  for (const leg of legs) {
    const prev = out.at(-1);
    if (!prev || prev.back !== leg.back) {
      out.push({ ...leg, pts: [...leg.pts], tan: [...leg.tan], heading: leg.heading && [...leg.heading], cum: [...leg.cum] });
      continue;
    }
    if (prev.heading || leg.heading) {
      prev.heading ??= prev.tan.map((h) => scale(h, prev.back ? -1 : 1));
      prev.heading.push(...(leg.heading ?? leg.tan.map((h) => scale(h, leg.back ? -1 : 1))).slice(1));
    }
    prev.pts.push(...leg.pts.slice(1));
    prev.tan.push(...leg.tan.slice(1));
    prev.cum.push(...leg.cum.slice(1).map((s) => s + prev.len));
    prev.len += leg.len;
    prev.vmax = Math.min(prev.vmax, leg.vmax);
  }
  return out;
}

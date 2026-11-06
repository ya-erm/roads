import { describe, expect, it } from 'vitest';
import type { Vehicle } from '../sim/vehicle';
import { LaneDemand } from './demand';
import { LaneGraph } from './graph';
import { LaneNet, oneWay, twoWay } from './model';
import { findLaneRoute } from './routing';
import { buildLab } from './scenes';
import { LaneTraffic, queueIndex, queueMismatches } from './traffic';

/** Повторяемый «случайный» поток. */
function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const CAR = { kind: 'car' as const, length: 7, width: 4, maxSpeed: 60, accel: 10, color: '#fff' };
const EAST = { x: 1, y: 0 };
const WEST = { x: -1, y: 0 };

/** Каждая машина — ровно в одной очереди: на манёвре — в его, иначе — в очереди своей полосы. Нарушения — строками. */
function misplaced(traffic: LaneTraffic): string[] {
  const where = new Map<Vehicle, string[]>();
  const add = (v: Vehicle, at: string) => where.set(v, [...(where.get(v) ?? []), at]);
  for (const lane of traffic.graph.lanes.values()) for (const v of lane.vehicles) add(v, `lane ${lane.id}`);
  for (const m of traffic.graph.moves.values()) for (const v of m.vehicles) add(v, `move ${m.key}`);
  const out: string[] = [];
  for (const v of traffic.vehicles.values()) {
    const expected = v.onMovement ? `move ${v.onMovement}` : `lane ${v.lane}`;
    const at = where.get(v) ?? [];
    if (at.length !== 1 || at[0] !== expected) out.push(`машина ${v.id}: ждали ${expected}, а она в ${at.join(', ') || 'нигде'}`);
  }
  for (const v of where.keys()) if (!traffic.vehicles.has(v.id)) out.push(`машины ${v.id} нет, а в очереди стоит`);
  return out;
}

/** Лаборатория полос с потоком машин; afterStep — после каждого такта, beforeStep — перед ним. */
function lab(seconds: number, hooks: { beforeStep?: (t: LaneTraffic) => void; afterStep?: (t: LaneTraffic, tick: number) => void } = {}) {
  const { net, sparse } = buildLab();
  const traffic = new LaneTraffic(new LaneGraph(net), { onArrive: () => {}, onLost: () => {} });
  const demand = new LaneDemand(traffic, 3, seeded(11), sparse);
  for (let tick = 0; tick * (1 / 30) < seconds; tick++) {
    demand.update(1 / 30);
    hooks.beforeStep?.(traffic);
    traffic.step(1 / 30);
    hooks.afterStep?.(traffic, tick);
  }
  return { net, traffic };
}

describe('Место машины в очереди полосы и манёвра', { timeout: 60_000 }, () => {
  it('в потоке через перекрёстки, светофоры, перестроения и съезды место всегда верное — и после перестройки графа', () => {
    const errors: string[] = [];
    let longest = 0;
    let onMoves = 0;
    let rebound = false;
    const { traffic } = lab(240, {
      afterStep: (t, tick) => {
        errors.push(...queueMismatches(t.graph));
        if (tick % 15 === 0) errors.push(...misplaced(t));
        for (const l of t.graph.lanes.values()) longest = Math.max(longest, l.vehicles.length);
        for (const m of t.graph.moves.values()) onMoves += m.vehicles.length;
        // Посреди потока сеть перестроили (как после правки дороги): машины переезжают на новый граф.
        if (tick === 3000) {
          t.rebind(new LaneGraph(t.graph.net));
          rebound = true;
        }
      },
    });
    expect(rebound).toBe(true);
    expect(errors.slice(0, 5)).toEqual([]);
    expect(traffic.arrivals).toBeGreaterThan(300);
    expect(traffic.vehicles.size).toBeGreaterThan(20);
    // Очереди были: и на полосах, и на манёврах в узлах.
    expect(longest).toBeGreaterThan(5);
    expect(onMoves).toBeGreaterThan(1000);
  });

  it('вставка в середину очереди и уход из неё сдвигают места тех, кто позади', () => {
    const net = new LaneNet();
    const a = net.addSeam({ x: 0, y: 0 }, WEST);
    const b = net.addSeam({ x: 1000, y: 0 }, EAST);
    net.addCorridor(a.id, b.id, { cls: 'street', lanes: oneWay(1) });
    const traffic = new LaneTraffic(new LaneGraph(net), { onArrive: () => {}, onLost: () => {} });
    const place = (x: number) => traffic.place({ ...CAR, targetNode: b.id }, { x, y: 0 }, EAST)!;
    const cars = [800, 600, 200, 100].map(place);
    const lane = traffic.currentLane(cars[0])!;
    // Между второй и третьей (как машина из сохранения или переехавшая на новый граф).
    const mid = place(400);
    expect(lane.vehicles).toEqual([cars[0], cars[1], mid, cars[2], cars[3]]);
    expect(lane.vehicles.map((v) => v.queueIdx)).toEqual([0, 1, 2, 3, 4]);
    // Ушла головная и машина из середины — остальные подтянулись в очереди.
    traffic.remove(cars[0]);
    traffic.remove(cars[2]);
    expect(lane.vehicles).toEqual([cars[1], mid, cars[3]]);
    expect(queueMismatches(traffic.graph)).toEqual([]);
    expect(lane.vehicles.map((v) => queueIndex(lane.vehicles, v))).toEqual([0, 1, 2]);
    // Новая в хвост — со своим местом.
    const last = traffic.spawn({ ...CAR, targetNode: b.id, route: findLaneRoute(traffic.graph, traffic.graph.outLinks.get(a.id)!, b.id)! })!;
    expect(last.queueIdx).toBe(3);
    expect(queueMismatches(traffic.graph)).toEqual([]);
  });

  it('очередь поменяли в обход (как в тестах): место всё равно находится верно, нет в очереди — −1', () => {
    const net = new LaneNet();
    const a = net.addSeam({ x: 0, y: 0 }, WEST);
    const b = net.addSeam({ x: 1000, y: 0 }, EAST);
    net.addCorridor(a.id, b.id, { cls: 'street', lanes: oneWay(2) });
    const graph = new LaneGraph(net);
    const traffic = new LaneTraffic(graph, { onArrive: () => {}, onLost: () => {} });
    const [left, right] = graph.links.get(graph.outLinks.get(a.id)![0].id)!.lanes;
    const cars = [700, 500, 300].map((x) => traffic.place({ ...CAR, targetNode: b.id }, { x, y: right.offset }, EAST)!);
    expect(cars.map((v) => traffic.currentLane(v))).toEqual([right, right, right]);
    // Среднюю переставили руками в левую полосу, без пересчёта мест.
    right.vehicles.splice(1, 1);
    left.vehicles.push(cars[1]);
    cars[1].lane = left.id;
    expect(queueIndex(right.vehicles, cars[0])).toBe(0);
    expect(queueIndex(right.vehicles, cars[2])).toBe(1);
    expect(queueIndex(right.vehicles, cars[1])).toBe(-1);
    expect(queueIndex(left.vehicles, cars[1])).toBe(0);
    // Очередь, которую снова ведёт движение, пронумерована заново.
    traffic.remove(cars[0]);
    expect(right.vehicles).toEqual([cars[2]]);
    expect(cars[2].queueIdx).toBe(0);
    for (let i = 0; i < 30; i++) traffic.step(1 / 30);
    for (const v of cars.slice(1)) expect(queueIndex(traffic.currentLane(v)!.vehicles, v)).toBe(traffic.currentLane(v)!.vehicles.indexOf(v));
  });

  it('с местом в очереди — то же движение до бита, что и с поиском машины в очереди (как прежде)', () => {
    const state = (t: LaneTraffic) =>
      JSON.stringify({
        arrivals: t.arrivals,
        cars: [...t.vehicles.values()].map(({ queueIdx: _q, ...v }) => v),
        lanes: [...t.graph.lanes.values()].map((l) => l.vehicles.map((v) => v.id)),
        moves: [...t.graph.moves.values()].map((m) => m.vehicles.map((v) => v.id)),
      });
    const fast = lab(150);
    // Перед каждым тактом места стёрты: машину в очереди ищут перебором, как было до queueIdx (пока вставка или уход
    // не пронумеруют очередь заново).
    const slow = lab(150, { beforeStep: (t) => t.vehicles.forEach((v) => (v.queueIdx = -1)) });
    expect(fast.traffic.arrivals).toBeGreaterThan(150);
    expect(state(fast.traffic)).toBe(state(slow.traffic));
  });

  it('переезды: открытые не мешают — движение как на улице без них; закрытые — очередь у стоп-линии каждого', () => {
    // Две одинаковые улицы 1+1: на второй — два переезда, сначала открытые, потом закрытые.
    const net = new LaneNet();
    const ends = [0, 200].map((y) => {
      const w = net.addSeam({ x: 0, y }, WEST);
      const e = net.addSeam({ x: 1500, y }, EAST);
      return { w, e, c: net.addCorridor(w.id, e.id, { cls: 'street', lanes: twoWay(1, 1) }) };
    });
    const graph = new LaneGraph(net);
    const traffic = new LaneTraffic(graph, { onArrive: () => {}, onLost: () => {} });
    const crossings = [
      { s: 600, closed: false, busy: false },
      { s: 1100, closed: false, busy: false },
    ];
    traffic.barriers.set(ends[1].c.id, crossings);
    const routes = ends.map(({ w, e }) => findLaneRoute(graph, graph.outLinks.get(w.id)!, e.id)!);
    const spawn = () => routes.map((route, k) => traffic.spawn({ ...CAR, targetNode: ends[k].e.id, route }));
    const run = (seconds: number) => {
      for (let t = 0; t < seconds; t += 1 / 30) {
        if (Math.round(t * 30) % 60 === 0) spawn();
        traffic.step(1 / 30);
      }
    };
    run(40);
    // Открытые переезды не мешают: на обеих улицах машины едут одинаково.
    const axis = (k: number) =>
      [...traffic.vehicles.values()].filter((v) => Math.abs(v.pos.y - k * 200) < 20).map((v) => [Math.round(v.pos.x * 1000), Math.round(v.v * 1000)]);
    expect(axis(1)).toEqual(axis(0));
    crossings.forEach((c) => (c.closed = true));
    run(60);
    // Закрыты: никто не на переезде, перед каждым — очередь (машины между переездами стоят у второго), и первая
    // в ней — у стоп-линии.
    expect(crossings.map((c) => c.busy)).toEqual([false, false]);
    const onSecond = [...traffic.vehicles.values()].filter((v) => Math.abs(v.pos.y - 200) < 20 && v.dir.x > 0);
    for (const { s } of [{ s: 600 }, { s: 1100 }]) {
      const first = onSecond.filter((v) => v.pos.x < s).sort((p, q) => q.pos.x - p.pos.x)[0];
      expect(first.v).toBeLessThan(0.1);
      expect(first.pos.x).toBeLessThan(s - 10);
      expect(first.pos.x).toBeGreaterThan(s - 25);
    }
    expect(queueMismatches(graph)).toEqual([]);
  });
});

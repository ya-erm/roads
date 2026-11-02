import { describe, expect, it } from 'vitest';
import type { Vehicle } from '../sim/vehicle';
import { LaneDemand } from './demand';
import { assignLanes, LaneGraph } from './graph';
import { LaneNet, oneWay, slot, twoWay } from './model';
import { findLaneRoute } from './routing';
import { buildLab } from './scenes';
import { LaneTraffic } from './traffic';

describe('Распределение полос по выездам', () => {
  it('две полосы: правая направо и прямо, левая налево и прямо', () => {
    const exits = [
      { count: 1, theta: 1.5, uTurn: false },
      { count: 2, theta: 0, uTurn: false },
      { count: 1, theta: -1.5, uTurn: false },
    ];
    const [right, straight, left] = assignLanes(2, exits);
    expect(right).toEqual([[0, 0]]);
    expect(straight.map((p) => p[0])).toEqual([0, 1]);
    expect(left).toEqual([[1, 0]]);
  });

  it('одна полоса расходится на две', () => {
    const [straight] = assignLanes(1, [{ count: 2, theta: 0, uTurn: false }]);
    expect(straight).toEqual([
      [0, 0],
      [0, 1],
    ]);
  });
});

/** Повторяемый «случайный» поток. */
function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function run(traffic: LaneTraffic, seconds: number, each?: () => void, demand?: LaneDemand): void {
  for (let t = 0; t < seconds; t += 1 / 30) {
    demand?.update(1 / 30);
    traffic.step(1 / 30);
    each?.();
  }
}

const CAR = { kind: 'car' as const, length: 7, width: 4, maxSpeed: 60, accel: 10, color: '#fff' };
const EAST = { x: 1, y: 0 };

describe('Полосы: движение', { timeout: 30_000 }, () => {
  it('на всех примерах лаборатории машины доезжают, никто не теряется и не застревает', () => {
    const { net, sparse } = buildLab();
    const graph = new LaneGraph(net);
    let lost = 0;
    const traffic = new LaneTraffic(graph, { onArrive: () => {}, onLost: () => lost++ });
    const demand = new LaneDemand(traffic, 4, seeded(7), sparse);
    let maxStopped = 0;
    run(traffic, 300, () => {
      for (const v of traffic.vehicles.values()) maxStopped = Math.max(maxStopped, v.stoppedTime);
    }, demand);
    expect(lost).toBe(0);
    expect(traffic.arrivals).toBeGreaterThan(600);
    // Никто не стоит подолгу: очереди рассасываются, вечных пробок нет.
    expect(maxStopped).toBeLessThan(60);
  });

  it('в съезд с крайней полосы машина перестраивается заранее и уезжает по съезду', () => {
    const net = new LaneNet();
    const a = net.addSeam({ x: -600, y: 0 }, EAST);
    const s = net.addSeam({ x: 0, y: 0 }, EAST);
    net.addCorridor(a.id, s.id, { cls: 'highway', lanes: [...twoWay(2, 2), slot(17.5, 1, 330)] });
    net.addCorridor(s.id, net.addSeam({ x: 600, y: 0 }, EAST).id, { cls: 'highway', lanes: twoWay(2, 2) });
    const exit = net.addSeam({ x: 560, y: 230 }, { x: 1, y: 0.25 });
    const ramp = net.addCorridor(s.id, exit.id, { cls: 'highway', portA: 17.5, lanes: oneWay(1) });
    const graph = new LaneGraph(net);
    const arrived: Vehicle[] = [];
    const traffic = new LaneTraffic(graph, { onArrive: (v) => arrived.push(v), onLost: () => {} });
    const route = findLaneRoute(graph, graph.outLinks.get(a.id)!, exit.id)!;
    expect(route).not.toBeNull();
    expect(graph.links.get(route[route.length - 1])!.corridor).toBe(ramp.id);
    // Выезжает в левой полосе — до съезда ей нужно перестроиться дважды.
    const v = traffic.spawn({ ...CAR, targetNode: exit.id, route })!;
    const left = graph.links.get(route[0])!.lanes[0];
    traffic.remove(v);
    left.vehicles = [];
    const veh = traffic.spawn({ ...CAR, targetNode: exit.id, route })!;
    traffic.remove(veh);
    const placed = { ...veh, lane: left.id };
    left.vehicles.push(placed);
    traffic.vehicles.set(placed.id, placed);
    let onRamp = false;
    run(traffic, 40, () => {
      const lane = traffic.currentLane(placed);
      if (lane && graph.links.get(lane.link)!.corridor === ramp.id) onRamp = true;
    });
    expect(onRamp).toBe(true);
    expect(arrived.map((x) => x.id)).toEqual([placed.id]);
  });

  it('к съезду с короткой полосой торможения перестраиваются заранее — даже из левой полосы и в плотном потоке', () => {
    // Магистраль 2+2, перед съездом — 110 м полосы торможения (как у развязок).
    const net = new LaneNet();
    const a = net.addSeam({ x: -1500, y: 0 }, EAST);
    const s = net.addSeam({ x: 0, y: 0 }, EAST);
    const e = net.addSeam({ x: 600, y: 0 }, EAST);
    net.addCorridor(a.id, s.id, { cls: 'highway', lanes: [...twoWay(2, 2), slot(17.5, 1, 1390)] });
    net.addCorridor(s.id, e.id, { cls: 'highway', lanes: twoWay(2, 2) });
    const exit = net.addSeam({ x: 560, y: 230 }, { x: 1, y: 0.25 });
    const ramp = net.addCorridor(s.id, exit.id, { cls: 'highway', portA: 17.5, lanes: oneWay(1) });
    const graph = new LaneGraph(net);
    let lost = 0;
    const traffic = new LaneTraffic(graph, { onArrive: () => {}, onLost: () => lost++ });
    const toExit = findLaneRoute(graph, graph.outLinks.get(a.id)!, exit.id)!;
    const through = findLaneRoute(graph, graph.outLinks.get(a.id)!, e.id)!;
    const first = graph.links.get(toExit[0])!;
    const [left, right] = first.lanes;
    /** Машина в начале нужной полосы (если там есть место). */
    const spawnIn = (lane: typeof left, target: number, route: number[]): Vehicle | null => {
      const v = traffic.spawn({ ...CAR, targetNode: target, route });
      if (!v) return null;
      const from = traffic.currentLane(v)!;
      if (from === lane) return v;
      const last = lane.vehicles[lane.vehicles.length - 1];
      if (last && last.s - last.length < 15) {
        traffic.remove(v);
        return null;
      }
      from.vehicles = from.vehicles.filter((x) => x !== v);
      v.lane = lane.id;
      lane.vehicles.push(v);
      return v;
    };
    // Связь с полосой торможения — вторая на маршруте к съезду.
    const aux = toExit[1];
    expect(graph.links.get(aux)!.lanes).toHaveLength(3);
    const exiting = new Set<Vehicle>();
    const tookRamp = new Set<Vehicle>();
    /** В какой полосе (0 — левая) машина въехала на связь с полосой торможения. */
    const enteredIn = new Map<Vehicle, number>();
    let tick = 0;
    run(traffic, 400, () => {
      tick++;
      // Плотный поток прямо — в правой полосе, к съезду — из левой.
      if (tick % 40 === 0) spawnIn(right, e.id, through);
      if (tick % 75 === 0 && traffic.time < 300) {
        const v = spawnIn(left, exit.id, toExit);
        if (v) exiting.add(v);
      }
      for (const v of exiting) {
        const lane = traffic.currentLane(v);
        if (!lane) continue;
        if (lane.link === aux && !enteredIn.has(v)) enteredIn.set(v, lane.index);
        if (graph.links.get(lane.link)!.corridor === ramp.id) tookRamp.add(v);
      }
    });
    expect(exiting.size).toBeGreaterThan(50);
    expect(lost).toBe(0);
    expect(tookRamp.size).toBe(exiting.size);
    // К полосе торможения подъезжают уже справа, а не тормозят в левой полосе.
    expect([...enteredIn.values()].filter((i) => i === 0)).toHaveLength(0);
    expect(Math.max(...[...exiting].map((v) => v.stoppedTime))).toBeLessThan(1);
  });

  it('перед закрытым шлагбаумом машины ждут, не заезжая на переезд, и едут, когда он открыт', () => {
    const net = new LaneNet();
    const w = net.addSeam({ x: 0, y: 0 }, EAST);
    const mid = net.addSeam({ x: 300, y: 0 }, EAST);
    const e = net.addSeam({ x: 700, y: 0 }, EAST);
    net.addCorridor(w.id, mid.id, { cls: 'street', lanes: twoWay(1, 1) });
    const c = net.addCorridor(mid.id, e.id, { cls: 'street', lanes: twoWay(1, 1) });
    const graph = new LaneGraph(net);
    const traffic = new LaneTraffic(graph, { onArrive: () => {}, onLost: () => {} });
    // Переезд на втором полотне, в 200 от его начала.
    const barrier = { s: 200, closed: true, busy: false };
    traffic.barriers.set(c.id, [barrier]);
    const route = findLaneRoute(graph, graph.outLinks.get(w.id)!, e.id)!;
    let spawned = 0;
    let crossed = 0;
    run(traffic, 40, () => {
      if (traffic.time > spawned * 2 && spawned < 5 && traffic.spawn({ ...CAR, targetNode: e.id, route })) spawned++;
      if (barrier.busy) crossed++;
    });
    expect(spawned).toBe(5);
    expect(crossed).toBe(0);
    expect(traffic.arrivals).toBe(0);
    // Первая стоит у стоп-линии — перед переездом, а не на нём.
    const first = [...traffic.vehicles.values()].sort((x, y) => y.pos.x - x.pos.x)[0];
    expect(first.pos.x).toBeLessThan(300 + 200 - 10);
    expect(first.pos.x).toBeGreaterThan(300 + 200 - 25);
    barrier.closed = false;
    run(traffic, 40);
    expect(traffic.arrivals).toBe(5);
  });

  it('с полосы разгона машины перестраиваются до её конца, а не стоят', () => {
    const net = new LaneNet();
    const s = net.addSeam({ x: 0, y: 0 }, EAST);
    const end = net.addSeam({ x: 650, y: 0 }, EAST);
    net.addCorridor(net.addSeam({ x: -650, y: 0 }, EAST).id, s.id, { cls: 'highway', lanes: twoWay(2, 2) });
    net.addCorridor(s.id, end.id, { cls: 'highway', lanes: [...twoWay(2, 2), slot(17.5, 1, 0, 180)] });
    const start = net.addSeam({ x: -560, y: 230 }, { x: 1, y: -0.25 });
    net.addCorridor(start.id, s.id, { cls: 'highway', portB: 17.5, lanes: oneWay(1) });
    const graph = new LaneGraph(net);
    const traffic = new LaneTraffic(graph, { onArrive: () => {}, onLost: () => {} });
    const route = findLaneRoute(graph, graph.outLinks.get(start.id)!, end.id)!;
    expect(route).not.toBeNull();
    let spawned = 0;
    run(traffic, 120, () => {
      if (traffic.time > spawned * 3 && spawned < 20 && traffic.spawn({ ...CAR, targetNode: end.id, route })) spawned++;
    });
    expect(traffic.arrivals).toBe(spawned);
  });
});

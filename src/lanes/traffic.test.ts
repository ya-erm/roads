import { describe, expect, it } from 'vitest';
import type { Vehicle } from '../sim/vehicle';
import { LaneDemand } from './demand';
import { LaneGraph } from './graph';
import { LaneNet, oneWay, slot, twoWay } from './model';
import { findLaneRoute } from './routing';
import { buildLab } from './scenes';
import { LaneTraffic } from './traffic';

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

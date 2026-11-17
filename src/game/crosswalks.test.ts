import { describe, expect, it } from 'vitest';
import type { Vec } from '../core/vec';
import { syncWalks, XWALK_BACK } from '../lanes/crosswalk';
import { LaneGraph } from '../lanes/graph';
import { LaneNet, twoWay } from '../lanes/model';
import { findLaneRoute } from '../lanes/routing';
import { LaneTraffic } from '../lanes/traffic';
import { Crosswalks, groupSize, PEDESTRIANS_ON, walkGreen, walkRate } from './crosswalks';

function scene(lights = false) {
  const net = new LaneNet();
  const j = net.addJunction({ x: 0, y: 0 });
  const dirs: Vec[] = [
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: -1, y: 0 },
    { x: 0, y: -1 },
  ];
  const far = dirs.map((d) => net.addSeam({ x: d.x * 300, y: d.y * 300 }, d));
  const arms = far.map((f) => net.addCorridor(j.id, f.id, { cls: 'street', lanes: twoWay(1, 1) }));
  if (lights) j.control = 'lights';
  syncWalks(net, j, () => true);
  // Пешеходы в игре пока выключены (PEDESTRIANS_ON) — здесь включены своему графу и экземпляру, не глобально.
  const graph = new LaneGraph(net, undefined, null, true);
  const traffic = new LaneTraffic(graph, { onArrive: () => {}, onLost: () => {} });
  // Центр города: 600 жителей — 1,5 группы в минуту.
  const walks = new Crosswalks(() => 600, true);
  return { net, j, far, arms, graph, traffic, walks };
}

const CAR = { kind: 'car' as const, length: 7, width: 4, maxSpeed: 60, accel: 10, color: '#fff' };

describe('Пешеходы на переходах', () => {
  it('поток по жителям: 300 — 0,75 группы в минуту, 600 и больше — 1,5; в группе до 6 человек', () => {
    expect(walkRate(300)).toBeCloseTo(0.75);
    expect(walkRate(600)).toBe(1.5);
    expect(walkRate(5000)).toBe(1.5);
    expect(walkRate(0)).toBe(0);
    expect(groupSize(0)).toBe(1);
    expect(groupSize(300)).toBe(3);
    expect(groupSize(5000)).toBe(6);
  });

  it('выключены (как в игре сейчас, PEDESTRIANS_ON): никто не приходит, зебра не закрывается', () => {
    expect(PEDESTRIANS_ON).toBe(false);
    const { net, traffic } = scene(true);
    const graph = new LaneGraph(net);
    const off = new Crosswalks(() => 600);
    for (let t = 0; t < 120; t += 1 / 30) off.step(1 / 30, t, graph, traffic);
    expect(off.list).toHaveLength(0);
    expect(off.pedestrians(120)).toHaveLength(0);
    expect(traffic.walks.size).toBe(0);
  });

  it('без машин группа приходит и сразу идут: зебра закрыта в обе стороны на время перехода, потом открыта', () => {
    const { graph, traffic, walks } = scene();
    let t = 0;
    let crossed = 0;
    let closedFor = 0;
    for (; t < 120; t += 1 / 30) {
      walks.step(1 / 30, t, graph, traffic);
      const c = walks.list[0];
      if (c.cross) closedFor += 1 / 30;
      if (c.cross && c.cross.t0 > t - 1 / 60) crossed++;
      expect(c.barriers[0].closed).toBe(!!c.cross);
      expect(c.barriers[1].closed).toBe(!!c.cross);
    }
    expect(traffic.walks.size).toBe(4);
    // За 2 минуты при 1,5 группы в минуту — 2–4 группы, по 5,7 с каждая.
    expect(crossed).toBeGreaterThanOrEqual(2);
    expect(crossed).toBeLessThanOrEqual(5);
    expect(closedFor / crossed).toBeCloseTo(17 / 3.5 + 0.8, 0);
    expect(walks.pedestrians(t).length).toBeGreaterThanOrEqual(0);
  });

  it('пока идут пешеходы, машина стоит перед зеброй; ушли — едет дальше', () => {
    const { graph, traffic, walks, far, arms } = scene();
    // Едем с запада на восток прямо: через переходы западного (въезд) и восточного (выезд) подъездов.
    const route = findLaneRoute(graph, graph.outLinks.get(far[2].id)!, far[0].id)!;
    walks.step(1 / 30, 0, graph, traffic);
    const east = walks.list.find((c) => c.walk.corridor === arms[0].id)!;
    // На восточном переходе идут люди, долго.
    east.cross = { t0: 0, dur: 1000, n: 3, from: 0 };
    east.barriers[0].closed = east.barriers[1].closed = true;
    for (const c of walks.list) if (c !== east) c.next = Infinity;
    const v = traffic.spawn({ ...CAR, targetNode: far[0].id, route })!;
    for (let t = 0; t < 40; t += 1 / 30) traffic.step(1 / 30);
    // Стоит перед перекрёстком у своей стоп-линии (западный подъезд — тоже с переходом), не въехав на зебру выезда.
    expect(v.onMovement).toBeNull();
    expect(v.v).toBeLessThan(0.1);
    const lane = traffic.currentLane(v)!;
    expect(lane.length - v.s).toBeGreaterThanOrEqual(XWALK_BACK - 0.1);
    east.cross = null;
    east.barriers[0].closed = east.barriers[1].closed = false;
    let arrived = false;
    for (let t = 0; t < 40 && !arrived; t += 1 / 30) {
      traffic.step(1 / 30);
      arrived = !traffic.vehicles.has(v.id);
    }
    expect(arrived).toBe(true);
  });

  it('подъезжающая быстро машина: группа ждёт, пока та проедет (успеть остановиться она не может)', () => {
    const { graph, traffic, walks, far, arms } = scene();
    const route = findLaneRoute(graph, graph.outLinks.get(far[2].id)!, far[0].id)!;
    walks.step(1 / 30, 0, graph, traffic);
    for (const c of walks.list) c.next = Infinity;
    const west = walks.list.find((c) => c.walk.corridor === arms[2].id)!;
    const v = traffic.spawn({ ...CAR, targetNode: far[0].id, route })!;
    // Машина разгоняется к перекрёстку; когда она близко и быстро, пешеходы приходят.
    let t = 0;
    for (; t < 30; t += 1 / 30) {
      traffic.step(1 / 30);
      const lane = traffic.currentLane(v);
      if (lane && lane.length - XWALK_BACK - v.s < 12 && v.v > 12) break;
    }
    west.waiting = 2;
    west.since = t;
    walks.step(1 / 30, t, graph, traffic);
    expect(west.cross).toBeNull();
    expect(west.waiting).toBe(2);
  });

  it('светофор: идут, только когда въезду с этого подъезда красный', () => {
    const { graph, traffic, walks, j, arms } = scene(true);
    walks.step(1 / 30, 0, graph, traffic);
    const L = graph.nodes.get(j.id)!.lights!;
    const east = walks.list.find((c) => c.walk.corridor === arms[0].id)!;
    const inE = east.walk.inLink!;
    const green = L.phases.findIndex((p) => [...p.moves].some((k) => graph.moves.get(k)?.inLink === inE));
    const red = L.phases.findIndex((p) => ![...p.moves].some((k) => graph.moves.get(k)?.inLink === inE));
    for (const c of walks.list) c.next = Infinity;
    L.phase = green;
    L.timer = 20;
    east.waiting = 2;
    east.since = 0;
    walks.step(1 / 30, 1, graph, traffic);
    expect(walkGreen(graph, east.walk)).toBe(false);
    expect(east.cross).toBeNull();
    L.phase = red;
    walks.step(1 / 30, 1.1, graph, traffic);
    expect(walkGreen(graph, east.walk)).toBe(true);
    expect(east.cross).not.toBeNull();
  });
});

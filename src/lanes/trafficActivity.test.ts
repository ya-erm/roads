import { expect, it } from 'vitest';
import { LaneGraph } from './graph';
import { LaneNet, twoWay } from './model';
import { findLaneRoute } from './routing';
import { LaneTraffic } from './traffic';

const CAR = { kind: 'car' as const, length: 7, width: 4, maxSpeed: 60, accel: 10, color: '#fff' };
const DT = 1 / 30;

function crossroads() {
  const net = new LaneNet();
  const j = net.addJunction({ x: 0, y: 0 });
  j.control = 'lights';
  const ends = [[-500, 0], [0, -500], [500, 0], [0, 500]].map(([x, y]) => {
    const end = net.addSeam({ x, y }, { x: Math.sign(x), y: Math.sign(y) });
    net.addCorridor(j.id, end.id, { cls: 'avenue', lanes: twoWay(2, 2) });
    return end.id;
  });
  const graph = new LaneGraph(net);
  const traffic = new LaneTraffic(graph, { onArrive: () => {}, onLost: () => {} });
  const route = (from: number, to: number) => findLaneRoute(graph, graph.outLinks.get(ends[from])!, ends[to])!;
  return { graph, traffic, ends, route, node: graph.nodes.get(j.id)! };
}

it('очередь плотного потока со спецмашинами полностью рассасывается', () => {
  const { traffic, ends, route } = crossroads();
  let spawned = 0;
  for (let tick = 0; tick < 30 * 800; tick++) {
    if (tick < 30 * 120 && tick % 30 === 0) for (let from = 0; from < 4; from++) {
      const to = (from + 1 + Math.floor(tick / 30 + from * 7) % 3) % 4;
      if (traffic.spawn({ ...CAR, siren: tick % 330 === 0, targetNode: ends[to], route: route(from, to) })) spawned++;
    }
    traffic.step(DT);
  }
  expect(spawned).toBeGreaterThan(300);
  expect(traffic.arrivals).toBe(spawned);
  expect(traffic.vehicles.size).toBe(0);
}, 30_000);

it('машина перед закрытой полосой на красный не держит очередь поперечного зелёного', () => {
  const { graph, traffic, ends, route, node } = crossroads();
  const place = (from: number, to: number, ahead: number, speed = 0) => {
    const r = route(from, to);
    const m = graph.transitions.get(`${r[0]}>${r[1]}`)![0];
    const lane = graph.lanes.get(m.inLane)!;
    const v = traffic.placeOnLane({ ...CAR, targetNode: ends[to] }, lane.id, lane.length - ahead)!;
    v.v = speed;
    return { v, lane, m };
  };
  const left = place(0, 1, 2);
  const oncoming = place(2, 0, 20, 10);
  const L = node.lights!;
  L.phase = L.phases.findIndex((p) => p.moves.has(left.m.key));
  L.timer = 1e6;
  traffic.step(DT);
  expect(left.v.ready).toBe(true);
  expect(left.v.granted).toBeNull();
  expect(node.waiting).toContain(left.v);
  const inLink = graph.links.get(left.lane.link)!;
  traffic.turnStops.set(inLink.corridor, [{ s: graph.axisS(left.lane, left.lane.length - 1), flow: inLink.flow, stop: 0, closed: true, busy: false }]);
  traffic.remove(oncoming.v);
  for (let tick = 0; tick < 3; tick++) traffic.step(DT);
  const crossing = place(3, 1, 2);
  expect(crossing.m.conflicts.has(left.m.key)).toBe(true);
  L.phase = L.phases.findIndex((p) => p.moves.has(crossing.m.key) && !p.moves.has(left.m.key));
  expect(L.phase).toBeGreaterThanOrEqual(0);
  for (let tick = 0; tick < 30 * 12; tick++) traffic.step(DT);
  expect(crossing.v.routeIndex).toBe(1);
  expect(crossing.v.v).toBeGreaterThan(5);
  expect(left.v.onMovement).toBeNull();
  expect(left.v.ready).toBe(false);
  expect(node.waiting).not.toContain(left.v);
});

it('показывает светофор, уступание конкретной встречной машине и очередь за ней', () => {
  const { graph, traffic, ends, route, node } = crossroads();
  const r = route(0, 1);
  const leftMove = graph.transitions.get(`${r[0]}>${r[1]}`)![0];
  const leftLane = graph.lanes.get(leftMove.inLane)!;
  const waiting = traffic.placeOnLane({ ...CAR, targetNode: ends[1] }, leftLane.id, leftLane.length - 2)!;
  const L = node.lights!;
  L.phase = L.phases.findIndex((p) => !p.moves.has(leftMove.key));
  L.timer = 1e6;
  traffic.step(DT);
  expect(traffic.activity(waiting)).toEqual({ kind: 'light' });
  L.phase = L.phases.findIndex((p) => p.moves.has(leftMove.key));
  const onRoute = route(2, 0);
  const onMove = graph.transitions.get(`${onRoute[0]}>${onRoute[1]}`)![0];
  const onLane = graph.lanes.get(onMove.inLane)!;
  const oncoming = traffic.placeOnLane({ ...CAR, targetNode: ends[0] }, onLane.id, onLane.length - 20)!;
  oncoming.v = 10;
  traffic.step(DT);
  expect(traffic.activity(waiting)).toEqual({ kind: 'yield', vehicle: oncoming.id });
  const follower = traffic.placeOnLane({ ...CAR, targetNode: ends[1] }, leftLane.id, waiting.s - waiting.length - 2)!;
  follower.lcCooldown = 100;
  traffic.step(DT);
  expect(traffic.activity(follower)).toEqual({ kind: 'following', vehicle: waiting.id });
});

it('отдаёт бронь узла, когда получившая её машина останавливается перед узлом', () => {
  const { graph, traffic, ends, route, node } = crossroads();
  const r = route(0, 2);
  const m = graph.transitions.get(`${r[0]}>${r[1]}`)![0];
  const lane = graph.lanes.get(m.inLane)!;
  const v = traffic.placeOnLane({ ...CAR, targetNode: ends[2] }, lane.id, lane.length - 5)!;
  node.lights!.phase = node.lights!.phases.findIndex((p) => p.moves.has(m.key));
  node.lights!.timer = 1e6;
  traffic.step(DT);
  expect(v.granted).toBe(m.key);
  traffic.holdAfter(v, 0);
  traffic.step(DT);
  expect(v.granted).toBeNull();
  expect(v.ready).toBe(false);
  expect(node.reserved).not.toContain(v);
  expect(node.waiting).not.toContain(v);
});

import { describe, expect, it } from 'vitest';
import type { Vec } from '../core/vec';
import { syncWalks, XWALK_BACK } from '../lanes/crosswalk';
import { LaneGraph } from '../lanes/graph';
import { LaneNet, twoWay } from '../lanes/model';
import { findLaneRoute } from '../lanes/routing';
import { LaneTraffic } from '../lanes/traffic';
import { Crosswalks, walkGreen, walkKey } from './crosswalks';

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
  for (const f of far) net.addCorridor(j.id, f.id, { cls: 'street', lanes: twoWay(1, 1) });
  if (lights) j.control = 'lights';
  syncWalks(net, j, () => true);
  const graph = new LaneGraph(net, undefined, null, true);
  const traffic = new LaneTraffic(graph, { onArrive() {}, onLost() {} });
  const walks = new Crosswalks();
  walks.step(0, graph, traffic);
  const crossings = graph.crosswalks.get(j.id)!;
  return { graph, traffic, walks, crossings, far, j };
}

const CAR = { kind: 'car' as const, length: 7, width: 4, maxSpeed: 60, accel: 10, color: '#fff' };

describe('Машины уступают пешеходам на зебре', () => {
  it('машины ждут последнего человека и продолжают, когда он дошёл до противоположного бордюра', () => {
    const { graph, traffic, walks, crossings, far } = scene();
    const key = walkKey(crossings[0]);
    expect(walks.enter(key, 0, 0, 30, graph, traffic)).toBe(true);
    expect(walks.enter(key, 1, 0, 40, graph, traffic)).toBe(true);
    const route = findLaneRoute(graph, graph.outLinks.get(far[2].id)!, far[0].id)!;
    const v = traffic.spawn({ ...CAR, targetNode: far[0].id, route })!;
    for (let t = 1; t < 40; t += 1 / 30) {
      walks.step(t, graph, traffic);
      traffic.step(1 / 30);
    }
    expect(walks.crossings.get(key)!.barriers.every((b) => b.closed)).toBe(true);
    expect(v.onMovement).toBeNull();
    expect(v.v).toBeLessThan(0.1);
    const lane = traffic.currentLane(v)!;
    expect(lane.length - v.s).toBeGreaterThanOrEqual(XWALK_BACK - 0.1);
    walks.step(42, graph, traffic);
    expect(walks.crossings.get(key)!.barriers.every((b) => !b.closed)).toBe(true);
    for (let i = 0; i < 1400 && traffic.vehicles.has(v.id); i++) traffic.step(1 / 30);
    expect(traffic.vehicles.has(v.id)).toBe(false);
  });

  it('когда к зебре быстро подъезжает машина, пешеход ждёт', () => {
    const { graph, traffic, walks, crossings, far } = scene();
    const route = findLaneRoute(graph, graph.outLinks.get(far[2].id)!, far[0].id)!;
    const v = traffic.spawn({ ...CAR, targetNode: far[0].id, route })!;
    let t = 0;
    for (; t < 30; t += 1 / 30) {
      traffic.step(1 / 30);
      const lane = traffic.currentLane(v);
      if (lane && lane.length - XWALK_BACK - v.s < 12 && v.v > 12) break;
    }
    const w = crossings.find((w) => w.inLink === route[0])!;
    expect(walks.enter(walkKey(w), t, 0, 5, graph, traffic)).toBe(false);
  });

  it('на светофоре идут только при красном сигнале въезду с этой стороны', () => {
    const { graph, traffic, walks, crossings, j } = scene(true);
    const w = crossings[0];
    const lights = graph.nodes.get(j.id)!.lights!;
    lights.timer = 20;
    lights.phase = lights.phases.findIndex((p) => [...p.moves].some((m) => graph.moves.get(m)?.inLink === w.inLink));
    expect(walkGreen(graph, w)).toBe(false);
    expect(walks.enter(walkKey(w), 0, 0, 5, graph, traffic)).toBe(false);
    lights.phase = lights.phases.findIndex((p) => ![...p.moves].some((m) => graph.moves.get(m)?.inLink === w.inLink));
    expect(walks.enter(walkKey(w), 1, 1, 5, graph, traffic)).toBe(true);
    walks.reset(traffic);
    expect(walks.crossings.size).toBe(0);
    expect(traffic.walks.size).toBe(0);
  });
});

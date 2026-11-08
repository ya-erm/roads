import { describe, expect, it } from 'vitest';
import type { Vehicle, VehicleSpec } from '../sim/vehicle';
import { LaneDemand } from './demand';
import { LaneGraph } from './graph';
import { LaneNet, oneWay, twoWay } from './model';
import { findLaneRoute } from './routing';
import { buildLab } from './scenes';
import { ASIDE, LaneTraffic } from './traffic';

const CAR = { kind: 'car' as const, length: 7, width: 4, maxSpeed: 60, accel: 10, color: '#fff' };
const AMBULANCE: VehicleSpec = { kind: 'car', body: 'ambulance', length: 8, width: 4.2, maxSpeed: 60, accel: 10, color: '#f4f5f2', siren: true };
const DT = 1 / 30;
type Arm = 'w' | 'e' | 'n' | 's';

function run(traffic: LaneTraffic, seconds: number, each?: (t: number) => void): void {
  for (let t = 0; t < seconds; t += DT) {
    traffic.step(DT);
    each?.(t);
  }
}

/** Повторяемый «случайный» поток. */
function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

/** Перекрёсток улиц 1+1 со светофором в (0, 0), плечи по 500 м; held — держать зелёный подъезду с севера на юг. */
function crossroads() {
  const net = new LaneNet();
  const j = net.addJunction({ x: 0, y: 0 });
  j.control = 'lights';
  const ends = {} as Record<Arm, number>;
  for (const [k, x, y] of [
    ['w', -500, 0],
    ['e', 500, 0],
    ['n', 0, -500],
    ['s', 0, 500],
  ] as const) {
    const end = net.addSeam({ x, y }, { x: Math.sign(x), y: Math.sign(y) });
    net.addCorridor(j.id, end.id, { cls: 'street', lanes: twoWay(1, 1) });
    ends[k] = end.id;
  }
  const graph = new LaneGraph(net);
  const arrived: Vehicle[] = [];
  const traffic = new LaneTraffic(graph, { onArrive: (v) => arrived.push(v), onLost: () => {} });
  const L = graph.nodes.get(j.id)!.lights!;
  const route = (from: Arm, to: Arm) => findLaneRoute(graph, graph.outLinks.get(ends[from])!, ends[to])!;
  const go = (from: Arm, to: Arm, spec: VehicleSpec = CAR) => traffic.spawn({ ...spec, targetNode: ends[to], route: route(from, to) });
  /** Зелёный — только с севера на юг и обратно, навсегда: с запада — красный. */
  const holdNorthSouth = () => {
    const r = route('n', 's');
    const key = graph.transitions.get(`${r[0]}>${r[1]}`)![0].key;
    L.phase = L.phases.findIndex((p) => p.moves.has(key));
    L.timer = 1e9;
    L.clearing = false;
  };
  return { graph, traffic, arrived, go, holdNorthSouth, node: j.id };
}

/** Центр кузова. */
const center = (v: Vehicle) => ({ x: v.pos.x - (v.dir.x * v.length) / 2, y: v.pos.y - (v.dir.y * v.length) / 2 });

/** Самое малое расстояние между центрами кузовов машин, что одновременно в перекрёстке на пересекающихся манёврах. */
function crossWatch(traffic: LaneTraffic) {
  let min = Infinity;
  return {
    sample() {
      const inside = [...traffic.vehicles.values()].filter((v) => v.onMovement && traffic.graph.moves.get(v.onMovement)?.node !== null);
      for (let i = 0; i < inside.length; i++) {
        for (let k = i + 1; k < inside.length; k++) {
          const a = inside[i];
          const b = inside[k];
          const kind = traffic.graph.moves.get(a.onMovement!)!.conflicts.get(b.onMovement!);
          if (kind !== 'cross') continue;
          const ca = center(a);
          const cb = center(b);
          min = Math.min(min, Math.hypot(ca.x - cb.x, ca.y - cb.y));
        }
      }
    },
    get min() {
      return min;
    },
  };
}

describe('Спецмашины с мигалкой', { timeout: 30_000 }, () => {
  it('на красный при плотном поперечном потоке: спецмашина проезжает, поперечные её пропускают; обычная стоит', () => {
    const pass = (spec: VehicleSpec) => {
      const { traffic, arrived, go, holdNorthSouth } = crossroads();
      holdNorthSouth();
      const watch = crossWatch(traffic);
      let target: Vehicle | null = null;
      let next = 0;
      run(traffic, 70, (t) => {
        // Поперёк — машина каждые 2,5 с в обе стороны.
        if (t >= next) {
          go('n', 's');
          go('s', 'n');
          next += 2.5;
        }
        if (!target && t > 8) target = go('w', 'e', spec);
        watch.sample();
      });
      return { done: !!target && arrived.includes(target), min: watch.min };
    };
    const siren = pass(AMBULANCE);
    expect(siren.done).toBe(true);
    // Без аварий: в перекрёстке спецмашина и поперечные не сходятся.
    expect(siren.min).toBeGreaterThan(5);
    // Та же машина без мигалки на красный не едет.
    expect(pass({ ...AMBULANCE, siren: false }).done).toBe(false);
  });

  it('в пробке на однополосной улице машины прижимаются к краю, спецмашина объезжает их и уезжает первой', () => {
    const { traffic, arrived, go, holdNorthSouth } = crossroads();
    holdNorthSouth();
    // Пробка с запада у красного: 8 машин.
    let n = 0;
    run(traffic, 30, (t) => {
      if (n < 8 && t > n * 2) {
        if (go('w', 'e')) n++;
      }
    });
    const queued = [...traffic.vehicles.values()];
    expect(queued.length).toBe(8);
    const amb = go('w', 'e', AMBULANCE)!;
    let maxAside = 0;
    let sirenAside = 0;
    // Плечо — 500 м до перекрёстка и 500 после: на объезд пробки и дорогу — полторы минуты.
    run(traffic, 90, () => {
      for (const v of traffic.vehicles.values()) {
        if (v === amb) sirenAside = Math.max(sirenAside, Math.abs(v.aside ?? 0));
        else maxAside = Math.max(maxAside, v.aside ?? 0);
      }
    });
    expect(maxAside).toBeGreaterThan(ASIDE * 0.9);
    expect(sirenAside).toBeGreaterThan(ASIDE * 0.9);
    // Спецмашина доехала; из пробки на красный проехали лишь те, кто стоял первым и пропускал её.
    expect(arrived).toContain(amb);
    expect(arrived.length).toBeLessThan(4);
    // Спецмашина уехала — остальные вернулись к середине полосы и снова стоят у красного.
    run(traffic, 10);
    for (const v of traffic.vehicles.values()) expect(Math.abs(v.aside ?? 0)).toBe(0);
  });

  it('на дороге в две полосы ей уступают — перестраиваются или прижимаются, — и она доезжает заметно быстрее', () => {
    const trip = (siren: boolean) => {
      const net = new LaneNet();
      const a = net.addSeam({ x: -1200, y: 0 }, { x: 1, y: 0 });
      const b = net.addSeam({ x: 1200, y: 0 }, { x: 1, y: 0 });
      net.addCorridor(a.id, b.id, { cls: 'street', lanes: oneWay(2) });
      const graph = new LaneGraph(net);
      const traffic = new LaneTraffic(graph, { onArrive: () => {}, onLost: () => {} });
      const route = findLaneRoute(graph, graph.outLinks.get(a.id)!, b.id)!;
      const link = graph.links.get(route[0])!;
      // Пробка в обеих полосах впереди: ползёт по 7 км/ч, машина за машиной (13 м от носа до носа).
      for (const lane of link.lanes) {
        for (let s = 150; s < 1000; s += 13) {
          const at = graph.lanePose(lane, s);
          traffic.place({ ...CAR, maxSpeed: 3, targetNode: b.id }, at.pos, at.dir, 3);
        }
      }
      // Спецмашина (или та же без мигалки) — в хвосте левой полосы.
      const tail = graph.lanePose(link.lanes[0], 60);
      const veh = traffic.place({ ...AMBULANCE, siren, targetNode: b.id }, tail.pos, tail.dir, 3)!;
      let changes = 0;
      const lanes = new Map([...traffic.vehicles.values()].map((v) => [v.id, v.lane]));
      let t = 0;
      while (traffic.vehicles.has(veh.id) && t < 300) {
        traffic.step(DT);
        t += DT;
        for (const v of traffic.vehicles.values()) {
          if (lanes.get(v.id) !== v.lane) changes++;
          lanes.set(v.id, v.lane);
        }
      }
      return { t, changes };
    };
    const slow = trip(false);
    const fast = trip(true);
    expect(fast.t).toBeLessThan(slow.t * 0.6);
    expect(fast.changes).toBeGreaterThan(0);
  });

  it('машина впереди в той же полосе перестраивается вправо, а в полосу перед спецмашиной никто не встаёт', () => {
    const net = new LaneNet();
    const a = net.addSeam({ x: -800, y: 0 }, { x: 1, y: 0 });
    const b = net.addSeam({ x: 800, y: 0 }, { x: 1, y: 0 });
    net.addCorridor(a.id, b.id, { cls: 'street', lanes: oneWay(2) });
    const graph = new LaneGraph(net);
    const traffic = new LaneTraffic(graph, { onArrive: () => {}, onLost: () => {} });
    const link = graph.links.get(findLaneRoute(graph, graph.outLinks.get(a.id)!, b.id)![0])!;
    const [left, right] = link.lanes;
    const at = (lane: typeof left, s: number, spec: VehicleSpec, v: number) => {
      const pose = graph.lanePose(lane, s);
      return traffic.place({ ...spec, targetNode: b.id }, pose.pos, pose.dir, v)!;
    };
    const slowCar = at(left, 300, { ...CAR, maxSpeed: 10 }, 10);
    const amb = at(left, 200, AMBULANCE, 15);
    let wentRight = false;
    run(traffic, 20, () => {
      if (slowCar.lane === right.id) wentRight = true;
    });
    expect(wentRight).toBe(true);
    // Обогнала: спецмашина впереди (или уже доехала).
    expect(amb.s > slowCar.s || !traffic.vehicles.has(amb.id)).toBe(true);
  });

  it('спецмашины в общем потоке лаборатории: никто не теряется и не стоит вечно, всё повторяется точь-в-точь', () => {
    const once = () => {
      const { net, sparse } = buildLab();
      const graph = new LaneGraph(net);
      let lost = 0;
      const traffic = new LaneTraffic(graph, { onArrive: () => {}, onLost: () => lost++ });
      const demand = new LaneDemand(traffic, 4, seeded(11), sparse);
      const rng = seeded(5);
      let maxStopped = 0;
      for (let t = 0; t < 240; t += DT) {
        demand.update(DT);
        // Каждой десятой новой машине — мигалку.
        for (const v of traffic.vehicles.values()) if (v.tripTime === 0 && v.siren === undefined) v.siren = rng() < 0.1;
        traffic.step(DT);
        for (const v of traffic.vehicles.values()) maxStopped = Math.max(maxStopped, v.stoppedTime);
      }
      const sirens = [...traffic.vehicles.values()].filter((v) => v.siren).length;
      const state = [...traffic.vehicles.values()].map((v) => `${v.id}:${v.pos.x.toFixed(3)},${v.pos.y.toFixed(3)}`).join(';');
      return { lost, arrivals: traffic.arrivals, maxStopped, sirens, state };
    };
    const a = once();
    expect(a.lost).toBe(0);
    expect(a.arrivals).toBeGreaterThan(450);
    expect(a.sirens).toBeGreaterThan(0);
    expect(a.maxStopped).toBeLessThan(60);
    expect(once()).toEqual(a);
  });
});

import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../config';
import { norm, sub, Vec } from '../core/vec';
import { BuildContext, Builder, DrawMode, Snap } from '../game/build';
import { assignLanes, Network } from '../world/network';
import type { RoadSpec } from '../world/roadTypes';
import { routeFromNode } from './routing';
import { Traffic } from './traffic';
import type { Vehicle } from './vehicle';

const STREET: RoadSpec = { cls: 'street', lanesF: 1, lanesB: 1 };
const AVENUE: RoadSpec = { cls: 'avenue', lanesF: 2, lanesB: 2 };
const CAR = { kind: 'car' as const, length: 7, width: 4, maxSpeed: 30, accel: 10, color: '#888' };

/** Мир без рельефа и зданий: только сеть, трафик и строитель. */
function makeWorld() {
  const net = new Network();
  const arrived: Vehicle[] = [];
  const lost: Vehicle[] = [];
  const traffic = new Traffic(net, { onArrive: (v) => arrived.push(v), onLost: (v) => lost.push(v) });
  const ctx: BuildContext = {
    net,
    budget: 1e12,
    roundaboutCenters: new Map(),
    isWater: () => false,
    inBounds: () => true,
    blocked: () => false,
    obstaclesAt: () => [],
    demolishCost: () => 0,
    demolish() {},
    spend() {},
    refund() {},
    networkChanged() {
      net.rebuild();
      traffic.validate();
    },
  };
  const builder = new Builder(ctx);
  const snap = (p: Vec, level = 0): Snap => builder.snap(p, level, 6);
  const road = (a: Vec, b: Vec, spec: RoadSpec = STREET, levels: [number, number] = [0, 0], mode: DrawMode = 'straight') => {
    const req = { start: snap(a, levels[0]), end: snap(b, levels[1]), spec, mode };
    const plan = builder.plan(req);
    if (!plan.ok) throw new Error(`Не строится: ${plan.reason}`);
    return builder.build(req)!;
  };
  const nodeAt = (p: Vec) => net.findNodeNear(p, 2)!;
  const send = (from: Vec, to: Vec) => {
    const a = nodeAt(from);
    const b = nodeAt(to);
    const route = routeFromNode(net, a.id, b.id);
    if (!route) throw new Error('нет маршрута');
    return traffic.spawn({ ...CAR, targetNode: b.id, route });
  };
  return { net, traffic, builder, arrived, lost, road, nodeAt, send };
}

function run(traffic: Traffic, seconds: number, onTick?: () => void) {
  const steps = Math.round(seconds / SIM_DT);
  for (let i = 0; i < steps; i++) {
    traffic.step(SIM_DT);
    onTick?.();
  }
}

function assertNoOverlap(net: Network) {
  for (const lane of net.lanes.values()) {
    for (let i = 1; i < lane.vehicles.length; i++) {
      const gap = lane.vehicles[i - 1].s - lane.vehicles[i].s;
      expect(gap).toBeGreaterThan(lane.vehicles[i - 1].length * 0.7);
    }
  }
}

describe('Распределение полос', () => {
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

describe('Трафик', () => {
  it('машина доезжает по прямой и по дуге', () => {
    const w = makeWorld();
    w.road({ x: 0, y: 0 }, { x: 400, y: 0 });
    const res = w.builder.build({
      start: w.builder.snap({ x: 400, y: 0 }, 0, 6),
      end: w.builder.snap({ x: 600, y: 200 }, 0, 6),
      spec: STREET,
      mode: 'arc',
      tangent: { x: 1, y: 0 },
    });
    expect(res).not.toBeNull();
    w.send({ x: 0, y: 0 }, { x: 600, y: 200 });
    run(w.traffic, 60);
    expect(w.arrived).toHaveLength(1);
  });

  it('дуга гладко входит в тупик существующей дороги', () => {
    const w = makeWorld();
    w.road({ x: 0, y: 0 }, { x: 300, y: 0 });
    w.road({ x: 700, y: 300 }, { x: 1000, y: 300 });
    const start = w.builder.snap({ x: 300, y: 0 }, 0, 6);
    const end = w.builder.snap({ x: 700, y: 300 }, 0, 6);
    const req = { start, end, spec: STREET, mode: 'arc' as const, tangent: w.builder.continuationTangent(start) };
    const curve = w.builder.buildCurve(req)!;
    const startDir = norm(sub(curve.p1, curve.p0));
    const endDir = norm(sub(curve.p3, curve.p2));
    expect(startDir.x).toBeCloseTo(1, 3);
    expect(endDir.x).toBeCloseTo(1, 3);
    expect(w.builder.plan(req).ok).toBe(true);
  });

  it('разворачивается в тупике', () => {
    const w = makeWorld();
    w.road({ x: 0, y: 0 }, { x: 400, y: 0 });
    w.road({ x: 200, y: 0 }, { x: 200, y: 200 });
    const mid = w.nodeAt({ x: 200, y: 0 });
    const end = w.nodeAt({ x: 400, y: 0 });
    const down = w.nodeAt({ x: 200, y: 200 });
    const link = [...w.net.links.values()].find((l) => l.from === mid.id && l.to === end.id)!;
    const route = routeFromNode(w.net, end.id, down.id)!;
    expect(route.length).toBeGreaterThan(0);
    w.traffic.spawn({ ...CAR, targetNode: down.id, route: [link.id, ...route] });
    run(w.traffic, 60);
    expect(w.arrived).toHaveLength(1);
  });

  const cases = [
    { control: 'none', spec: STREET, interval: 0.6, total: 120 },
    { control: 'lights', spec: STREET, interval: 0.6, total: 120 },
    { control: 'roundabout', spec: STREET, interval: 0.6, total: 120 },
    { control: 'none', spec: AVENUE, interval: 0.3, total: 200 },
    { control: 'lights', spec: AVENUE, interval: 0.3, total: 200 },
    { control: 'roundabout', spec: STREET, interval: 0.25, total: 240 },
  ] as const;
  for (const { control, spec, interval, total } of cases) {
    it(`перекрёсток ${control} (${spec.cls}, раз в ${interval} с) без вечного затора`, () => {
      const w = makeWorld();
      const c = { x: 300, y: 300 };
      w.road({ x: 0, y: 300 }, { x: 600, y: 300 }, spec);
      w.road({ x: 300, y: 0 }, { x: 300, y: 600 }, spec);
      expect(w.nodeAt(c).segments).toHaveLength(4);
      if (control === 'lights') expect(w.builder.toggleLights(c, 6)).toBe(true);
      if (control === 'roundabout') expect(w.builder.buildRoundabout(c, 6)).toBe(true);
      const ends: Vec[] = [
        { x: 0, y: 300 },
        { x: 600, y: 300 },
        { x: 300, y: 0 },
        { x: 300, y: 600 },
      ];
      let spawned = 0;
      let timer = 0;
      run(w.traffic, 700, () => {
        timer -= SIM_DT;
        if (timer > 0 || spawned >= total) return;
        timer = interval;
        for (let i = 0; i < ends.length; i++) {
          if (w.send(ends[i], ends[(i + 1 + (spawned % 3)) % 4])) spawned++;
        }
        assertNoOverlap(w.net);
      });
      expect(spawned).toBeGreaterThanOrEqual(total * 0.8);
      expect(w.lost).toHaveLength(0);
      expect(w.traffic.vehicles.size).toBe(0);
      expect(w.arrived.length).toBe(spawned);
    });
  }

  it('эстакада проходит над дорогой без перекрёстка', () => {
    const w = makeWorld();
    w.road({ x: 0, y: 300 }, { x: 600, y: 300 });
    w.road({ x: 300, y: 40 }, { x: 300, y: 180 }, STREET, [0, 1]);
    w.road({ x: 300, y: 180 }, { x: 300, y: 420 }, STREET, [1, 1]);
    w.road({ x: 300, y: 420 }, { x: 300, y: 560 }, STREET, [1, 0]);
    expect(w.net.findNodeNear({ x: 300, y: 300 }, 5)).toBeNull();
    w.send({ x: 300, y: 40 }, { x: 300, y: 560 });
    w.send({ x: 0, y: 300 }, { x: 600, y: 300 });
    run(w.traffic, 60);
    expect(w.arrived).toHaveLength(2);
  });

  it('тоннель проходит под дорогой', () => {
    const w = makeWorld();
    w.road({ x: 0, y: 300 }, { x: 600, y: 300 });
    w.road({ x: 300, y: 40 }, { x: 300, y: 180 }, STREET, [0, -1]);
    w.road({ x: 300, y: 180 }, { x: 300, y: 420 }, STREET, [-1, -1]);
    w.road({ x: 300, y: 420 }, { x: 300, y: 560 }, STREET, [-1, 0]);
    expect(w.net.findNodeNear({ x: 300, y: 300 }, 5)).toBeNull();
  });

  it('пересечение ровно в вершинах полилиний создаёт перекрёсток', () => {
    const w = makeWorld();
    w.road({ x: 650, y: 1120 }, { x: 830, y: 1120 });
    w.road({ x: 740, y: 1030 }, { x: 740, y: 1300 });
    expect(w.nodeAt({ x: 740, y: 1120 }).segments).toHaveLength(4);
  });

  it('нельзя строить перекрёсток на разной высоте и слишком крутой подъём', () => {
    const w = makeWorld();
    w.road({ x: 0, y: 300 }, { x: 600, y: 300 });
    const steep = w.builder.plan({
      start: w.builder.snap({ x: 300, y: 100 }, 0, 6),
      end: w.builder.snap({ x: 300, y: 140 }, 1, 6),
      spec: STREET,
      mode: 'straight',
    });
    expect(steep.reason).toBe('Слишком крутой подъём');
  });

  it('машины переживают разрезание дороги новым перекрёстком', () => {
    const w = makeWorld();
    w.road({ x: 0, y: 0 }, { x: 800, y: 0 });
    for (let i = 0; i < 3; i++) {
      expect(w.send({ x: 0, y: 0 }, { x: 800, y: 0 })).not.toBeNull();
      run(w.traffic, 2.5);
    }
    run(w.traffic, 2);
    w.road({ x: 400, y: -200 }, { x: 400, y: 200 });
    expect(w.lost).toHaveLength(0);
    run(w.traffic, 80);
    expect(w.arrived).toHaveLength(3);
  });

  it('съезд вливается в магистраль, магистраль не останавливается', () => {
    const w = makeWorld();
    const HW: RoadSpec = { cls: 'highway', lanesF: 2, lanesB: 0 };
    const RAMP: RoadSpec = { cls: 'avenue', lanesF: 1, lanesB: 0 };
    w.road({ x: 0, y: 0 }, { x: 600, y: 0 }, HW);
    w.road({ x: 600, y: 0 }, { x: 1400, y: 0 }, HW);
    w.road({ x: 250, y: 120 }, { x: 600, y: 0 }, RAMP);
    let mainStops = 0;
    let spawned = 0;
    let timer = 0;
    run(w.traffic, 200, () => {
      timer -= SIM_DT;
      if (timer <= 0 && spawned < 60) {
        timer = 1;
        if (w.send({ x: 0, y: 0 }, { x: 1400, y: 0 })) spawned++;
        if (spawned % 2 === 0 && w.send({ x: 250, y: 120 }, { x: 1400, y: 0 })) spawned++;
      }
      for (const v of w.traffic.vehicles.values()) {
        const lane = w.traffic.currentLane(v);
        if (lane && w.net.segment(lane.seg).spec.cls === 'highway' && lane.from === w.nodeAt({ x: 0, y: 0 }).id && v.v < 1 && v.s > 20) {
          mainStops++;
        }
      }
    });
    expect(spawned).toBeGreaterThan(40);
    expect(w.lost).toHaveLength(0);
    expect(w.arrived.length).toBe(spawned);
    expect(mainStops).toBe(0);
  });

  it('снос дороги с машиной убирает её', () => {
    const w = makeWorld();
    w.road({ x: 0, y: 0 }, { x: 400, y: 0 });
    w.send({ x: 0, y: 0 }, { x: 400, y: 0 });
    run(w.traffic, 3);
    w.builder.bulldoze({ x: 200, y: 0 });
    expect(w.lost).toHaveLength(1);
    expect(w.traffic.vehicles.size).toBe(0);
  });
});

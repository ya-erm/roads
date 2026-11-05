import { describe, expect, it } from 'vitest';
import { dot, sub } from '../core/vec';
import { LaneGraph } from './graph';
import { bodyOnEnds, LaneNet, twoWay } from './model';
import { findLaneRoute } from './routing';
import { LaneTraffic } from './traffic';
import { atPortals, portalHalf, portalSide, tunnelPortals } from './tunnel';

describe('Въезд в тоннель без моргания', () => {
  it('грузовик едет в тоннель: на каждом шаге — до портала ярко, на линии — по частям, за ним — бледно', () => {
    const { net, a, c } = road(-1);
    const portals = tunnelPortals(net);
    const graph = new LaneGraph(net);
    const traffic = new LaneTraffic(graph, { onArrive: () => {}, onLost: () => {} });
    const route = findLaneRoute(graph, graph.outLinks.get(a.id)!, c.id)!;
    const truck = traffic.spawn({ kind: 'truck', length: 12, width: 2.5, maxSpeed: 12, accel: 3, color: '#fff', targetNode: c.id, route })!;
    // Как рисуется кадр: у портала — по кузову, иначе — по слою движения (под землёй −1 бледно, на земле 0 ярко).
    const drawn = () => {
      const at = atPortals(portals, truck.pos, truck.dir, truck.length);
      return at ? at.side : (truck.layer ?? 0) < 0 ? 'in' : 'out';
    };
    const seen: { nose: number; how: string }[] = [];
    for (let t = 0; t < 30 && traffic.vehicles.has(truck.id); t += 1 / 30) {
      traffic.step(1 / 30);
      seen.push({ nose: truck.pos.x - 100, how: drawn() });
    }
    // Шаги по 0,4 м — и вокруг портала, и далеко за ним.
    expect(seen.filter((x) => x.nose > -5 && x.nose < 20).length).toBeGreaterThan(40);
    for (const { nose, how } of seen) {
      if (nose <= -0.05) expect(how).toBe('out');
      else if (nose > 0.05 && nose < 11.95) expect(how).toBe('split');
      else if (nose > 12.05) expect(how).toBe('in');
    }
    // Ни одного кадра «целиком ярко», когда кузов уже за порталом — и наоборот.
    const order = seen.map((x) => x.how).filter((h, i, all) => i === 0 || h !== all[i - 1]);
    expect(order).toEqual(['out', 'split', 'in']);
  });

  it('по кузову — тот портал, на линии которого он стоит, иначе ближайший', () => {
    const { net } = road(-1);
    const [p] = tunnelPortals(net);
    const far = { ...p, pos: { x: 300, y: 0 }, dir: { x: -1, y: 0 } };
    expect(atPortals([far, p], { x: 105, y: 1.75 }, EAST, 12)?.portal).toBe(p);
    expect(atPortals([far, p], { x: 130, y: 1.75 }, EAST, 12)).toMatchObject({ portal: p, side: 'in' });
    expect(atPortals([p], { x: 105, y: 40 }, EAST, 12)).toBeNull();
  });
});

const EAST = { x: 1, y: 0 };
const WEST = { x: -1, y: 0 };

/** Дорога с запада на восток: на земле до x = 100, дальше — под землю (или на мост) до x = 300. */
function road(far: number) {
  const net = new LaneNet();
  const a = net.addSeam({ x: 0, y: 0 }, EAST, 0);
  const b = net.addSeam({ x: 100, y: 0 }, EAST, 0);
  const c = net.addSeam({ x: 300, y: 0 }, EAST, far);
  const ground = net.addCorridor(a.id, b.id, { cls: 'street', lanes: twoWay(1, 1) });
  const ramp = net.addCorridor(b.id, c.id, { cls: 'street', lanes: twoWay(1, 1) });
  return { net, a, b, c, ground, ramp };
}

describe('Портал тоннеля', () => {
  it('стоит там, где дорога с земли уходит под землю: направление — внутрь, ширина — по проезду', () => {
    const { net } = road(-1);
    const list = tunnelPortals(net);
    expect(list).toHaveLength(1);
    const [p] = list;
    expect(p.pos.x).toBeCloseTo(100, 6);
    expect(p.dir.x).toBeCloseTo(1, 6);
    // Улица 1+1: полосы по 3,5 м в обе стороны от оси и обочина.
    expect(p.left).toBeLessThan(-3.5);
    expect(p.right).toBeGreaterThan(3.5);
    // Мост — не тоннель; тоннель под землёй с обоих концов — без портала.
    expect(tunnelPortals(road(1).net)).toHaveLength(0);
    const deep = road(-1);
    deep.net.node(deep.b.id).level = -1;
    expect(tunnelPortals(deep.net).map((q) => Math.round(q.pos.x))).toEqual([0]);
  });

  it('машина на линии портала — по частям; до него и за ним целиком — как есть; на другой дороге — не его', () => {
    const [p] = tunnelPortals(road(-1).net);
    // Грузовик 12 м едет на восток: нос в 5 м за порталом — хвост ещё снаружи.
    expect(portalSide(p, { x: 105, y: 1.75 }, EAST, 12)).toBe('split');
    expect(portalSide(p, { x: 90, y: 1.75 }, EAST, 12)).toBe('out');
    expect(portalSide(p, { x: 120, y: 1.75 }, EAST, 12)).toBe('in');
    // Выезжает из тоннеля на запад: нос снаружи, хвост внутри.
    expect(portalSide(p, { x: 96, y: -1.75 }, WEST, 12)).toBe('split');
    // В стороне от проезда и далеко — не этот портал.
    expect(portalSide(p, { x: 105, y: 30 }, EAST, 12)).toBeNull();
    expect(portalSide(p, { x: 400, y: 0 }, EAST, 12)).toBeNull();
  });

  it('половины проезда для обрезки машины — по разные стороны линии портала', () => {
    const [p] = tunnelPortals(road(-1).net);
    for (const q of portalHalf(p, 1)) expect(dot(sub(q, p.pos), p.dir)).toBeGreaterThanOrEqual(-1e-9);
    for (const q of portalHalf(p, -1)) expect(dot(sub(q, p.pos), p.dir)).toBeLessThanOrEqual(1e-9);
    // С запасом по бокам — шире проезда.
    const ys = portalHalf(p, 1).map((q) => q.y);
    expect(Math.min(...ys)).toBeLessThan(p.left);
    expect(Math.max(...ys)).toBeGreaterThan(p.right);
  });
});

describe('Съезд с моста: хвост машины не уходит под край моста', () => {
  it('кузов на конце полотна — от носа до хвоста', () => {
    // Нос в 8 м от начала полотна, кузов 12 м по ходу a→b — хвост ещё на соседнем полотне.
    expect(bodyOnEnds(8, 12, 1, 200)).toEqual({ a: true, b: false });
    expect(bodyOnEnds(14, 12, 1, 200)).toEqual({ a: false, b: false });
    // Против хода оси: нос у конца b, хвост тянется к нему.
    expect(bodyOnEnds(192, 12, -1, 200)).toEqual({ a: false, b: true });
    expect(bodyOnEnds(186, 12, -1, 200)).toEqual({ a: false, b: false });
    // Нос подъехал к концу — тоже на нём.
    expect(bodyOnEnds(199.5, 12, 1, 200).b).toBe(true);
  });

  it('автобус с моста: пока хвост на пандусе — в слое моста, съехал целиком — на земле', () => {
    // Мост на западе (уровень 1), пандус до x = 100, дальше — земля; автобус едет с моста на восток.
    const net = new LaneNet();
    const top = net.addSeam({ x: 0, y: 0 }, EAST, 1);
    const foot = net.addSeam({ x: 100, y: 0 }, EAST, 0);
    const end = net.addSeam({ x: 300, y: 0 }, EAST, 0);
    net.addCorridor(top.id, foot.id, { cls: 'street', lanes: twoWay(1, 1) });
    net.addCorridor(foot.id, end.id, { cls: 'street', lanes: twoWay(1, 1) });
    const graph = new LaneGraph(net);
    const traffic = new LaneTraffic(graph, { onArrive: () => {}, onLost: () => {} });
    const route = findLaneRoute(graph, graph.outLinks.get(top.id)!, end.id)!;
    const bus = traffic.spawn({ kind: 'bus', length: 12, width: 2.5, maxSpeed: 15, accel: 3, color: '#fff', targetNode: end.id, route })!;
    const seen: { past: number; layer: number }[] = [];
    for (let t = 0; t < 40 && traffic.vehicles.has(bus.id); t += 1 / 30) {
      traffic.step(1 / 30);
      seen.push({ past: bus.pos.x - 100, layer: bus.layer ?? 0 });
    }
    const onRamp = seen.filter((x) => x.past > 0.5 && x.past < 11.5);
    const off = seen.filter((x) => x.past > 13.5 && x.past < 150);
    expect(onRamp.length).toBeGreaterThan(3);
    expect(off.length).toBeGreaterThan(3);
    expect(onRamp.every((x) => x.layer === 1)).toBe(true);
    expect(off.every((x) => x.layer === 0)).toBe(true);
  });
});

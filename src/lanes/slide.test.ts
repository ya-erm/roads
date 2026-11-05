import { describe, expect, it } from 'vitest';
import { minRadius, splitBezier } from '../core/bezier';
import { dist, Vec } from '../core/vec';
import { buildRoad, dragHandle, laneStep, laneTipAt } from './edit';
import { LaneGraph } from './graph';
import { Corridor, LaneNet, slot, twoWay } from './model';
import { findLaneRoute } from './routing';
import { branchSeam, joinCubics, slideRange, slideSeam, slideTrack } from './slide';

const AVENUE = { cls: 'avenue' as const, lanes: twoWay(2, 2) };
const free = (x: number, y: number) => ({ kind: 'free' as const, pos: { x, y } });

/** Проспект 2+2 с запада на восток длиной 800. */
function road(): LaneNet {
  const net = new LaneNet();
  buildRoad(net, free(0, 0), free(800, 0), AVENUE);
  return net;
}

const deadEnds = (net: LaneNet) => [...net.nodes.values()].filter((n) => net.isDeadEnd(n));

function reachable(net: LaneNet, from: number, to: number): boolean {
  const g = new LaneGraph(net);
  return !!findLaneRoute(g, g.outLinks.get(from) ?? [], to);
}

/** Примыкание сети (стык с ответвлением посреди дороги). */
function joint(net: LaneNet) {
  const all = [...net.nodes.values()].map((n) => branchSeam(net, n)).filter((j) => j !== null);
  expect(all).toHaveLength(1);
  return all[0]!;
}

/** Въезд из поля на проспект у x = 300: стык, за ним полоса разгона. */
function entry(): { net: LaneNet; start: number; east: number; ramp: Corridor } {
  const net = road();
  const east = deadEnds(net).find((n) => n.pos.x > 700)!.id;
  laneStep(net, laneTipAt(net, { x: 100, y: 260 }, 14), { x: 300, y: 17.5 }, 'avenue', 14);
  const start = deadEnds(net).find((n) => n.pos.y > 200)!.id;
  const ramp = net.corridor(net.node(start).corridors[0]);
  return { net, start, east, ramp };
}

/** Полоса разгона (смещение 17,5 по ходу) на дороге: где на ней по x начинается и кончается полная ширина. */
function auxSpan(net: LaneNet): { x0: number; x1: number } {
  for (const c of net.corridors.values()) {
    const l = c.lanes.find((x) => Math.abs(x.offset - 17.5) < 0.5 && x.flow === 1);
    if (l && c.lanes.length > 1) return { x0: c.lut.pointAt(l.from).x, x1: c.lut.pointAt(Math.min(l.to, c.length)).x };
  }
  throw new Error('Нет полосы разгона');
}

describe('Примыкание вдоль дороги', () => {
  it('въезд тянут дальше по ходу: дорога на месте, въезд длиннее и плавнее, полоса разгона той же длины', () => {
    const { net, start, east, ramp } = entry();
    const before = joint(net);
    expect(before.node.pos.x).toBeCloseTo(300, 0);
    const aux = auxSpan(net);
    const radius = minRadius(ramp.curve);
    const roadLength = [...net.corridors.values()].filter((c) => c.lanes.length > 1).reduce((s, c) => s + c.length, 0);
    const corridors = net.corridors.size;

    expect(slideSeam(net, before.node.id, { x: 420, y: 30 })).toBe(true);
    expect(net.problems()).toEqual([]);
    const after = joint(net);
    expect(after.node.pos.x).toBeCloseTo(420, 0);
    expect(after.node.pos.y).toBeCloseTo(0, 6);
    // Въезд кончается у края дороги в новом месте, по касательной к ней.
    const r = net.corridor(ramp.id);
    expect(dist(r.curve.p3, { x: 420, y: 17.5 })).toBeLessThan(0.5);
    expect(Math.abs(r.curve.p3.y - r.curve.p2.y)).toBeLessThan(1e-6);
    expect(minRadius(r.curve)).toBeGreaterThan(radius * 1.2);
    // Прежний стык слился обратно: дорога — те же два куска, длина та же, ось прямая.
    expect(net.corridors.size).toBe(corridors);
    expect(net.nodes.has(before.node.id)).toBe(false);
    const main = [...net.corridors.values()].filter((c) => c.lanes.length > 1);
    expect(main.reduce((s, c) => s + c.length, 0)).toBeCloseTo(roadLength, 3);
    for (const c of main) for (const p of [c.curve.p0, c.curve.p1, c.curve.p2, c.curve.p3]) expect(Math.abs(p.y)).toBeLessThan(1e-6);
    // Полоса разгона уехала вместе с примыканием и той же длины.
    const moved = auxSpan(net);
    expect(moved.x0).toBeCloseTo(420, 0);
    expect(moved.x1 - moved.x0).toBeCloseTo(aux.x1 - aux.x0, 0);
    expect(reachable(net, start, east)).toBe(true);
  });

  it('въезд продолжает другую дорогу, подходящую под небольшим углом: её направление прежнее, поворот плавнее', () => {
    const { net, ramp } = entry();
    // Начало въезда смотрит почти вдоль проспекта, и к нему подходит однополосная — там стык, а не тупик.
    const head = net.node(ramp.a);
    expect(dragHandle(net, { corridor: ramp.id, end: 'a' }, { x: head.pos.x + 80, y: head.pos.y - 20 })).toBe(true);
    buildRoad(net, { kind: 'node', node: head.id, pos: head.pos }, free(head.pos.x - 200, head.pos.y + 60), { cls: 'avenue', lanes: [slot(0, -1)] });
    expect(net.node(head.id).kind).toBe('seam');
    expect(net.isDeadEnd(net.node(head.id))).toBe(false);
    const dir = { ...net.node(head.id).dir };
    const sharp = minRadius(net.corridor(ramp.id).curve);
    expect(net.problems()).toEqual([]);
    expect(slideSeam(net, joint(net).node.id, { x: 520, y: 20 })).toBe(true);
    expect(net.problems()).toEqual([]);
    expect(net.node(head.id).dir).toEqual(dir);
    expect(minRadius(net.corridor(ramp.id).curve)).toBeGreaterThan(sharp * 1.5);
  });

  it('и назад — ближе к началу дороги; дальше соседнего узла не уходит', () => {
    const { net, start, east } = entry();
    const j = joint(net);
    const [lo, hi] = slideRange(j);
    expect(lo).toBeCloseTo(-(300 - 15), 0);
    expect(hi).toBeCloseTo(500 - 15, 0);
    expect(slideSeam(net, j.node.id, { x: 150, y: 20 })).toBe(true);
    expect(net.problems()).toEqual([]);
    expect(joint(net).node.pos.x).toBeCloseTo(150, 0);
    expect(auxSpan(net).x0).toBeCloseTo(150, 0);
    expect(reachable(net, start, east)).toBe(true);
    // За конец дороги — только до запаса у тупика.
    expect(slideSeam(net, joint(net).node.id, { x: 2000, y: 0 })).toBe(true);
    expect(joint(net).node.pos.x).toBeCloseTo(800 - 15, 0);
    expect(net.problems()).toEqual([]);
    // Точки, куда можно сдвинуть, — вдоль дороги у её края.
    const track = slideTrack(joint(net));
    expect(track.length).toBeGreaterThan(10);
    for (const p of track) expect(p.y).toBeCloseTo(17.5, 3);
  });

  it('съезд тянут раньше: полоса торможения едет следом той же длины, доехать можно', () => {
    const net = road();
    // Съезд у x = 500 вправо: полоса торможения перед ним.
    const step = laneStep(net, laneTipAt(net, { x: 500, y: 17.5 }, 14), { x: 650, y: 250 }, 'avenue', 14);
    expect(step.what).toBe('Съезд');
    const west = deadEnds(net).find((n) => n.pos.x < 100)!.id;
    const exit = deadEnds(net).find((n) => n.pos.y > 200)!.id;
    expect(reachable(net, west, exit)).toBe(true);
    const j = joint(net);
    const aux = auxSpan(net);
    expect(aux.x1).toBeCloseTo(j.node.pos.x, 0);
    expect(slideSeam(net, j.node.id, { x: j.node.pos.x - 120, y: 10 })).toBe(true);
    expect(net.problems()).toEqual([]);
    const moved = auxSpan(net);
    expect(moved.x1).toBeCloseTo(j.node.pos.x - 120, 0);
    expect(moved.x1 - moved.x0).toBeCloseTo(aux.x1 - aux.x0, 0);
    expect(reachable(net, west, exit)).toBe(true);
  });

  it('съезд и въезд в одном стыке едут вместе, у каждого его полоса той же длины', () => {
    const net = new LaneNet();
    const a = net.addSeam({ x: 0, y: 0 }, { x: 1, y: 0 });
    const b = net.addSeam({ x: 800, y: 0 }, { x: 1, y: 0 });
    net.addCorridor(a.id, b.id, { cls: 'street', lanes: twoWay(1, 1) });
    // Справа (на восток) — полоса торможения 200…400 и съезд; слева (на запад) в том же стыке — въезд.
    let tip = laneTipAt(net, { x: 200, y: 10.5 }, 14);
    tip = laneStep(net, tip, { x: 400, y: 10.5 }, 'street', 14).tip;
    laneStep(net, tip, { x: 520, y: 150 }, 'street', 14);
    expect(laneStep(net, laneTipAt(net, { x: 520, y: -150 }, 14), { x: 406, y: -10.5 }, 'street', 14).what).toBe('Въезд');
    const j = joint(net);
    expect(j.branches).toHaveLength(2);
    const span = (offset: number, flow: 1 | -1) => {
      const xs = [...net.corridors.values()].flatMap((c) =>
        c.lanes.filter((l) => Math.abs(l.offset - offset) < 0.5 && l.flow === flow && c.lanes.length > 1).flatMap((l) => [c.lut.pointAt(l.from).x, c.lut.pointAt(Math.min(l.to, c.length)).x]),
      );
      return [Math.min(...xs), Math.max(...xs)];
    };
    const decel = span(10.5, 1);
    const accel = span(-10.5, -1);
    expect(slideSeam(net, j.node.id, { x: 480, y: 0 })).toBe(true);
    expect(net.problems()).toEqual([]);
    const moved = joint(net);
    expect(moved.node.pos.x).toBeCloseTo(480, 0);
    for (const e of moved.branches) expect(e.corridor.lut.pointAt(e.end === 'a' ? 0 : e.corridor.length).x).toBeCloseTo(480, 0);
    expect(span(10.5, 1)[0]).toBeCloseTo(decel[0] + 80, 0);
    expect(span(10.5, 1)[1]).toBeCloseTo(480, 0);
    expect(span(-10.5, -1)[0]).toBeCloseTo(accel[0] + 80, 0);
    const west = deadEnds(net).find((n) => n.pos.x < 100)!.id;
    expect(reachable(net, west, deadEnds(net).find((n) => n.pos.y > 100)!.id)).toBe(true);
    expect(reachable(net, deadEnds(net).find((n) => n.pos.y < -100)!.id, west)).toBe(true);
  });

  it('на изгибе дороги примыкание идёт по её оси, въезд — по касательной к ней', () => {
    const net = new LaneNet();
    buildRoad(net, free(0, 0), free(800, 0), { ...AVENUE, control: { x: 400, y: -160 } });
    laneStep(net, laneTipAt(net, { x: 150, y: 200 }, 14), { x: 300, y: -60 }, 'avenue', 14);
    const j = joint(net);
    const main = j.front.corridor;
    expect(slideSeam(net, j.node.id, main.lut.pointAt(main.length * 0.5))).toBe(true);
    // Стык не на оси или въезд не по касательной к нему — problems() это видит.
    expect(net.problems()).toEqual([]);
    const n = joint(net).node;
    const road = [...net.corridors.values()].filter((c) => c.lanes.length > 1);
    expect(Math.min(...road.map((c) => c.lut.closest(n.pos).d))).toBeLessThan(1e-3);
  });

  it('куски дороги — не одна кривая: прежний стык остаётся швом дороги, полосы через него сходятся', () => {
    const { net, start, east } = entry();
    const j = joint(net);
    // У заднего куска перья другой длины (касательные те же): с передним он уже не одна кривая.
    const back = j.back.corridor;
    const { p0, p1 } = back.curve;
    net.setCurve(back, { ...back.curve, p1: { x: p0.x + (p1.x - p0.x) * 1.8, y: p1.y } });
    expect(slideSeam(net, j.node.id, { x: 400, y: 20 })).toBe(true);
    expect(net.problems()).toEqual([]);
    expect(net.nodes.has(j.node.id)).toBe(true);
    expect(branchSeam(net, net.node(j.node.id))).toBeNull();
    expect(joint(net).node.pos.x).toBeCloseTo(400, 0);
    expect(reachable(net, start, east)).toBe(true);
  });

  it('куски одной кривой склеиваются обратно в неё, чужие — нет', () => {
    const c = { p0: { x: 0, y: 0 }, p1: { x: 100, y: 80 }, p2: { x: 300, y: -60 }, p3: { x: 400, y: 20 } };
    const [a, b] = splitBezier(c, 0.37);
    const q = joinCubics(a, b)!;
    for (const k of ['p0', 'p1', 'p2', 'p3'] as const) expect(dist(q[k], c[k] as Vec)).toBeLessThan(1e-6);
    expect(joinCubics(a, { ...b, p2: { x: 310, y: -50 } })).toBeNull();
  });
});

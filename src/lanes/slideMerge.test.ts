import { describe, expect, it } from 'vitest';
import { reverseCubic } from '../core/bezier';
import { buildRoad, laneStep, laneTipAt } from './edit';
import { pointOff } from './geometry';
import { LaneGraph } from './graph';
import { LaneNet, twoWay } from './model';
import { findLaneRoute } from './routing';
import { branchSeam, slideJoinTarget, slideSeam } from './slide';

const free = (x: number, y: number) => ({ kind: 'free' as const, pos: { x, y } });

function scene(reverse = false, exit = false) {
  const net = new LaneNet();
  buildRoad(net, free(0, 0), free(1000, 0), { cls: 'avenue', lanes: twoWay(2, 2) });
  if (exit) laneStep(net, laneTipAt(net, { x: 400, y: 17.5 }, 14), { x: 600, y: 200 }, 'avenue', 14);
  else laneStep(net, laneTipAt(net, { x: 200, y: 200 }, 14), { x: 400, y: 17.5 }, 'avenue', 14);
  laneStep(net, laneTipAt(net, { x: 700, y: -200 }, 14), { x: 450, y: -17.5 }, 'avenue', 14);
  // Полоса второго въезда продолжается через первый стык: её отгон — за ним.
  laneStep(net, laneTipAt(net, { x: 440, y: -17.5 }, 14), { x: 370, y: -17.5 }, 'avenue', 14);
  const joints = () => [...net.nodes.values()].flatMap((n) => branchSeam(net, n) ?? []);
  const source = joints().find((j) => Math.abs(j.node.pos.x - 400) < 1)!;
  const target = joints().find((j) => Math.abs(j.node.pos.x - 450) < 1)!;
  if (reverse) {
    // Соседний узел смотрит против оси дороги; среднее полотно записано в обратном направлении.
    const n = target.node;
    n.dir = { x: -n.dir.x, y: -n.dir.y };
    for (const id of n.corridors) {
      const c = net.corridor(id);
      if (c.a === n.id) c.portA *= -1;
      if (c.b === n.id) c.portB *= -1;
    }
    const middle = net.corridor(source.front.corridor.id);
    const lanes = middle.lanes.map((l) => ({ ...l, offset: -l.offset, flow: -l.flow as 1 | -1, from: middle.length - Math.min(l.to, middle.length), to: l.from <= 0.01 ? Infinity : middle.length - l.from }));
    [middle.a, middle.b] = [middle.b, middle.a];
    [middle.portA, middle.portB] = [middle.portB, middle.portA];
    net.setCurve(middle, reverseCubic(middle.curve));
    net.setLanes(middle, lanes);
  }
  expect(net.problems()).toEqual([]);
  return { net, source: branchSeam(net, source.node)!, target: branchSeam(net, target.node)!, joints };
}

function span(net: LaneNet, offset: number) {
  const xs = [...net.corridors.values()].filter((c) => c.lanes.length > 1).flatMap((c) => {
    const sign = Math.sign(c.curve.p3.x - c.curve.p0.x);
    return c.lanes.filter((l) => Math.abs(l.offset * sign - offset) < 0.5).flatMap((l) => [c.lut.pointAt(l.from).x, c.lut.pointAt(Math.min(l.to, c.length)).x]);
  });
  return [Math.min(...xs), Math.max(...xs)];
}

describe('Слияние соседних примыканий полос', () => {
  it('переносит всю полосу разгона, сохраняя её участки со сплошной разметкой', () => {
    const { net, source, target } = scene();
    const middle = source.front.corridor;
    net.setLanes(middle, middle.lanes.map((l) => l.offset === 17.5 ? { ...l, solid: true } : l));
    const before = span(net, 17.5);
    expect(slideSeam(net, source.node.id, target.node.pos)).toBe(true);
    expect(net.problems()).toEqual([]);
    expect(span(net, 17.5)[0]).toBeCloseTo(before[0] + 50, 1);
    expect(span(net, 17.5)[1]).toBeCloseTo(before[1] + 50, 1);
    const solid = [...net.corridors.values()].flatMap((c) => c.lanes.filter((l) => l.offset === 17.5 && l.solid).map((l) => Math.min(l.to, c.length) - l.from));
    expect(solid.reduce((sum, length) => sum + length, 0)).toBeCloseTo(50, 1);
  });

  it('на изгибе сохраняет ось дороги и касательные примыканий', () => {
    const net = new LaneNet();
    buildRoad(net, free(0, 0), free(1000, 0), { cls: 'avenue', lanes: twoWay(2, 2), control: { x: 500, y: -160 } });
    const axis = [...net.corridors.values()][0];
    const a = pointOff(axis, axis.length * 0.4, 17.5);
    const b = pointOff(axis, axis.length * 0.45, -17.5);
    laneStep(net, laneTipAt(net, { x: a.x - 200, y: a.y + 200 }, 14), a, 'avenue', 14);
    laneStep(net, laneTipAt(net, { x: b.x + 200, y: b.y - 200 }, 14), b, 'avenue', 14);
    laneStep(net, laneTipAt(net, pointOff(axis, axis.length * 0.44, -17.5), 14), pointOff(axis, axis.length * 0.37, -17.5), 'avenue', 14);
    expect(net.problems()).toEqual([]);
    const joints = () => [...net.nodes.values()].flatMap((n) => branchSeam(net, n) ?? []).sort((x, y) => x.node.pos.x - y.node.pos.x);
    const [source, target] = joints();
    expect(slideSeam(net, source.node.id, net.portPos(target.node, target.branches[0].port))).toBe(true);
    expect(net.problems()).toEqual([]);
    expect(joints()).toHaveLength(1);
    const main = [...net.corridors.values()].filter((c) => c.lanes.length > 1);
    for (let i = 0; i <= 40; i++) {
      const p = axis.lut.pointAt(axis.length * i / 40);
      expect(Math.min(...main.map((c) => c.lut.closest(p).d))).toBeLessThan(0.05);
    }
  });

  it('переносит съезд и его полосу торможения к противоположному въезду', () => {
    const { net, source, target, joints } = scene(false, true);
    const before = span(net, 17.5);
    const fixed = span(net, -17.5);
    expect(slideSeam(net, source.node.id, target.node.pos)).toBe(true);
    expect(joints()).toHaveLength(1);
    expect(net.problems()).toEqual([]);
    expect(span(net, 17.5)[0]).toBeCloseTo(before[0] + 50, 1);
    expect(span(net, 17.5)[1]).toBeCloseTo(before[1] + 50, 1);
    expect(span(net, -17.5)).toEqual(fixed);
  });

  it('сохраняет шов, если куски дороги не одна кривая, и не оставляет на нём веток', () => {
    const { net, source, target, joints } = scene();
    const back = source.back.corridor;
    net.setCurve(back, { ...back.curve, p1: { x: back.curve.p1.x * 1.5, y: back.curve.p1.y } });
    expect(slideSeam(net, source.node.id, target.node.pos)).toBe(true);
    expect(net.problems()).toEqual([]);
    expect(net.node(source.node.id).corridors).toHaveLength(2);
    expect(branchSeam(net, net.node(source.node.id))).toBeNull();
    expect(joints()).toHaveLength(1);
    expect(joints()[0].branches).toHaveLength(2);
  });

  for (const reverse of [false, true]) {
    for (const backwards of [false, true]) {
      it(`сводит обе ветки в один узел, обратные оси: ${reverse}, перенос назад: ${backwards}`, () => {
        const { net, source: a, target: b, joints } = scene(reverse);
        const [source, target] = backwards ? [b, a] : [a, b];
        const branch = source.branches[0].corridor;
        const fixed = target.branches[0].corridor;
        const fixedCurve = structuredClone(fixed.curve);
        const offset = backwards ? -17.5 : 17.5;
        const before = span(net, offset);
        const other = span(net, -offset);
        const delta = target.node.pos.x - source.node.pos.x;
        const p = net.portPos(target.node, target.branches[0].port);
        expect(slideJoinTarget(net, source, p)?.node.id).toBe(target.node.id);
        expect(slideSeam(net, source.node.id, p)).toBe(true);
        expect(net.problems()).toEqual([]);
        expect(joints()).toHaveLength(1);
        expect(joints()[0].node.id).toBe(target.node.id);
        expect(joints()[0].branches).toHaveLength(2);
        expect([branch.a, branch.b]).toContain(target.node.id);
        expect(fixed.curve).toEqual(fixedCurve);
        expect(net.nodes.has(source.node.id)).toBe(false);
        expect(span(net, offset)[0]).toBeCloseTo(before[0] + delta, 1);
        expect(span(net, offset)[1]).toBeCloseTo(before[1] + delta, 1);
        expect(span(net, -offset)[0]).toBeCloseTo(other[0], 1);
        expect(span(net, -offset)[1]).toBeCloseTo(other[1], 1);
        const graph = new LaneGraph(net);
        for (const ramp of [branch, fixed]) {
          const start = ramp.a === target.node.id ? ramp.b : ramp.a;
          const roadEnd = [...net.nodes.values()].find((n) => Math.abs(n.pos.y) < 1 && n.pos.x < 1)!;
          const east = [...net.nodes.values()].find((n) => Math.abs(n.pos.y) < 1 && n.pos.x > 999)!;
          const flowEast = (ramp === branch) !== backwards;
          expect(findLaneRoute(graph, graph.outLinks.get(start) ?? [], flowEast ? east.id : roadEnd.id)).not.toBeNull();
        }
      });
    }
  }

  it('отпускание рядом с узлом без прилипания оставляет обычный сдвиг с запасом', () => {
    const { net, source, target, joints } = scene();
    expect(slideJoinTarget(net, source, { x: 420, y: 17.5 }, 3)).toBeNull();
    expect(slideSeam(net, source.node.id, target.node.pos, 0)).toBe(true);
    expect(joints()).toHaveLength(2);
    expect(joints()[0].node.id).not.toBe(joints()[1].node.id);
    expect(net.problems()).toEqual([]);
  });
});

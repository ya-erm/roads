import { describe, expect, it } from 'vitest';
import type { Vec } from '../core/vec';
import { anchorAt, applyLane, buildRoad, bulldoze, dragLane, flipLane, startLane } from './edit';
import { LaneGraph } from './graph';
import { LaneNet, twoWay } from './model';
import { findLaneRoute } from './routing';

const AVENUE = { cls: 'avenue' as const, lanes: twoWay(2, 2) };
const free = (x: number, y: number) => ({ kind: 'free' as const, pos: { x, y } });

/** Дорога 2+2 с запада на восток длиной 800. */
function road(): LaneNet {
  const net = new LaneNet();
  buildRoad(net, free(0, 0), free(800, 0), AVENUE);
  return net;
}

const deadEnds = (net: LaneNet) => [...net.nodes.values()].filter((n) => net.isDeadEnd(n));

/** Ведёт полосу мышью по точкам. */
function drawLane(net: LaneNet, points: Vec[]): boolean {
  let d = startLane(net, points[0], 14);
  for (const p of points.slice(1)) d = dragLane(net, d, p, 14);
  return applyLane(net, d, 'avenue');
}

/** Есть ли путь между тупиками. */
function reachable(net: LaneNet, from: number, to: number): boolean {
  const g = new LaneGraph(net);
  return !!findLaneRoute(g, g.outLinks.get(from) ?? [], to);
}

describe('Полосы: инструменты', () => {
  it('дорога в чистом поле — полотно с тупиками на концах', () => {
    const net = road();
    expect(net.corridors.size).toBe(1);
    expect(deadEnds(net)).toHaveLength(2);
    expect(net.problems()).toEqual([]);
  });

  it('продолжение тупика тем же профилем — стык, другим — перекрёсток', () => {
    const net = road();
    const east = deadEnds(net).find((n) => n.pos.x > 400)!;
    buildRoad(net, anchorAt(net, east.pos, 14), free(1400, 200), AVENUE);
    expect(net.node(east.id).kind).toBe('seam');
    expect(net.problems()).toEqual([]);
    const ends = deadEnds(net);
    expect(reachable(net, ends[0].id, ends[1].id)).toBe(true);

    const west = ends.find((n) => n.pos.x < 100)!;
    buildRoad(net, anchorAt(net, west.pos, 14), free(-500, 0), { cls: 'street', lanes: twoWay(1, 1) });
    expect(net.node(west.id).kind).toBe('junction');
  });

  it('ответвление из стыка с дорогами по обе стороны — перекрёсток, дорога идёт прямо к цели', () => {
    const net = road();
    const east = deadEnds(net).find((n) => n.pos.x > 400)!;
    buildRoad(net, anchorAt(net, east.pos, 14), free(1400, 0), AVENUE);
    expect(net.node(east.id).kind).toBe('seam');
    buildRoad(net, anchorAt(net, east.pos, 14), free(800, 400), AVENUE);
    const n = net.node(east.id);
    expect(n.kind).toBe('junction');
    const branch = net.ends(n).find((e) => Math.abs(e.away.y) > 0.5)!;
    expect(branch.away.y).toBeCloseTo(1, 3);
  });

  it('дорога поперёк другой — перекрёсток посередине; конец на полотне — Т-образный', () => {
    const net = road();
    buildRoad(net, free(400, -300), free(400, 300), { cls: 'street', lanes: twoWay(1, 1) });
    const junctions = [...net.nodes.values()].filter((n) => n.kind === 'junction');
    expect(junctions).toHaveLength(1);
    expect(net.ends(junctions[0])).toHaveLength(4);
    buildRoad(net, free(200, 300), anchorAt(net, { x: 200, y: 2 }, 14), { cls: 'street', lanes: twoWay(1, 1) });
    expect([...net.nodes.values()].filter((n) => n.kind === 'junction')).toHaveLength(2);
    expect(net.problems()).toEqual([]);
  });

  it('полоса вдоль края прилипает к полотну: третья полоса с отгонами', () => {
    const net = road();
    expect(drawLane(net, [{ x: 200, y: 17.5 }, { x: 350, y: 18 }, { x: 600, y: 17 }])).toBe(true);
    const c = [...net.corridors.values()][0];
    expect(net.corridors.size).toBe(1);
    const added = c.lanes.find((l) => l.offset === 17.5)!;
    expect(added.flow).toBe(1);
    expect(added.from).toBeCloseTo(200, 0);
    expect(added.to).toBeCloseTo(600, 0);
  });

  it('полоса вдоль края и в сторону — съезд: стык, свой тупик, туда можно доехать', () => {
    const net = road();
    const west = deadEnds(net).find((n) => n.pos.x < 100)!;
    expect(drawLane(net, [{ x: 200, y: 17.5 }, { x: 400, y: 17 }, { x: 500, y: 18 }, { x: 600, y: 40 }, { x: 750, y: 200 }])).toBe(true);
    expect(net.problems()).toEqual([]);
    const ramp = deadEnds(net).find((n) => n.pos.y > 150)!;
    expect(ramp).toBeDefined();
    expect(reachable(net, west.id, ramp.id)).toBe(true);
    // По главной дороге тоже можно проехать дальше.
    const east = deadEnds(net).find((n) => n.pos.x > 700 && n.pos.y < 50)!;
    expect(reachable(net, west.id, east.id)).toBe(true);
  });

  it('полоса из поля к краю и вдоль — въезд с полосой разгона', () => {
    const net = road();
    const east = deadEnds(net).find((n) => n.pos.x > 700)!;
    expect(drawLane(net, [{ x: 50, y: 250 }, { x: 150, y: 120 }, { x: 300, y: 17.5 }, { x: 450, y: 18 }, { x: 500, y: 17 }])).toBe(true);
    expect(net.problems()).toEqual([]);
    const start = deadEnds(net).find((n) => n.pos.y > 200)!;
    expect(reachable(net, start.id, east.id)).toBe(true);
  });

  it('снос перекрёстной дороги оставляет тупики, разворот полосы, сохранение', () => {
    const net = road();
    buildRoad(net, anchorAt(net, { x: 400, y: 0 }, 14), free(400, 300), { cls: 'street', lanes: twoWay(1, 1) });
    const j = [...net.nodes.values()].find((n) => n.kind === 'junction')!;
    const side = net.ends(j).find((e) => e.corridor.cls === 'street')!.corridor;
    bulldoze(net, side.id);
    // Две половины проспекта остались у перекрёстка на две дороги.
    expect(net.ends(j)).toHaveLength(2);
    const any = [...net.corridors.values()][0];
    flipLane(net, any, 0);
    expect(any.lanes[0].flow).toBe(1);
    const copy = LaneNet.fromJSON(JSON.parse(JSON.stringify(net.toJSON())));
    expect(copy.toJSON()).toEqual(net.toJSON());
  });
});

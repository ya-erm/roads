import { describe, expect, it } from 'vitest';
import { add, dist, rightNormal, scale, Vec } from '../core/vec';
import { LANE_W } from '../world/roadTypes';
import { bridgeLook, deckAlong } from './deck';
import { pointOff } from './geometry';
import { GLink, LaneGraph } from './graph';
import { LaneNet, oneWay, slot, twoWay } from './model';
import { corridorLayer, deckLift, deckLine, inPass, onOtherRoad, perLane, signSpot, SPEEDMAP_LANE, speedStrokes, strokePoint } from './speedDisplay';

const EAST = { x: 1, y: 0 };

/** Связи полотна в направлении flow по ходу оси. */
function linksOf(g: LaneGraph, corridor: number, flow: 1 | -1): GLink[] {
  return g
    .corridorLinks(corridor)
    .filter((l) => l.flow === flow)
    .sort((a, b) => a.s0 - b.s0);
}

/** Шоссе 2+2 расширяется до трёх полос, крайняя уходит в съезд (как в лаборатории полос). */
function exitRamp() {
  const net = new LaneNet();
  const s = net.addSeam({ x: 0, y: 0 }, EAST);
  const main = net.addCorridor(net.addSeam({ x: -650, y: 0 }, EAST).id, s.id, { cls: 'highway', lanes: [...twoWay(2, 2), slot(17.5, 1, 330)] });
  const after = net.addCorridor(s.id, net.addSeam({ x: 650, y: 0 }, EAST).id, { cls: 'highway', lanes: twoWay(2, 2) });
  const ramp = net.addCorridor(s.id, net.addSeam({ x: 300, y: 260 }, { x: 0.3, y: 1 }).id, { cls: 'highway', portA: 17.5, lanes: oneWay(1) });
  return { net, graph: new LaneGraph(net), main, after, ramp };
}

describe('Карта скоростей: линией по связи или по каждой полосе', () => {
  it('обычная дорога 2+2 — одна линия посередине полос связи, толщиной по числу полос', () => {
    const net = new LaneNet();
    const c = net.addCorridor(net.addSeam({ x: 0, y: 0 }, EAST).id, net.addSeam({ x: 400, y: 0 }, EAST).id, { cls: 'avenue', lanes: twoWay(2, 2) });
    const g = new LaneGraph(net);
    for (const flow of [1, -1] as const) {
      const [link] = linksOf(g, c.id, flow);
      expect(perLane(g, link)).toBe(false);
      const strokes = speedStrokes(g, link);
      expect(strokes).toHaveLength(1);
      expect(strokes[0].lanes).toHaveLength(2);
      expect(strokes[0].width).toBeCloseTo(2 * SPEEDMAP_LANE);
      expect(strokes[0].offsetAt(200)).toBeCloseTo(7 * flow);
    }
  });

  it('полоса на отгоне и развилка в съезд — каждая полоса своей линией по своей середине', () => {
    const { graph: g, main } = exitRamp();
    const [before, split] = linksOf(g, main.id, 1);
    // До отгона — две полосы рядом, как на обычной дороге.
    expect(perLane(g, before)).toBe(false);
    expect(split.lanes).toHaveLength(3);
    expect(perLane(g, split)).toBe(true);
    const strokes = speedStrokes(g, split);
    expect(strokes.map((s) => s.lanes.map((l) => l.offset))).toEqual([[3.5], [10.5], [17.5]]);
    for (const s of strokes) expect(s.width).toBeCloseTo(SPEEDMAP_LANE);
    // У стыка — по середине своей полосы; на отгоне новая полоса уже, и её середина ближе к дороге.
    expect(strokes.map((s) => s.offsetAt(split.s1))).toEqual([3.5, 10.5, 17.5]);
    const mid = strokes[2].offsetAt(split.s0)!;
    expect(mid).toBeGreaterThan(14);
    expect(mid).toBeLessThan(17.5);
    // Встречные полосы того же полотна идут рядом и дальше — одной линией.
    for (const link of linksOf(g, main.id, -1)) expect(perLane(g, link)).toBe(false);
  });

  it('развилка односторонней и вливание двух дорог в одну — по полосам; перекрёсток — нет', () => {
    const net = new LaneNet();
    const fork = net.addSeam({ x: 0, y: 0 }, EAST);
    const two = net.addCorridor(net.addSeam({ x: -400, y: 0 }, EAST).id, fork.id, { cls: 'avenue', lanes: oneWay(2) });
    net.addCorridor(fork.id, net.addSeam({ x: 400, y: -150 }, EAST).id, { cls: 'avenue', portA: -3.5, lanes: oneWay(1) });
    net.addCorridor(fork.id, net.addSeam({ x: 400, y: 150 }, EAST).id, { cls: 'avenue', portA: 3.5, lanes: oneWay(1) });
    const merge = net.addSeam({ x: 0, y: 1000 }, EAST);
    net.addCorridor(net.addSeam({ x: -400, y: 850 }, EAST).id, merge.id, { cls: 'avenue', portB: -3.5, lanes: oneWay(1) });
    net.addCorridor(net.addSeam({ x: -400, y: 1150 }, EAST).id, merge.id, { cls: 'avenue', portB: 3.5, lanes: oneWay(1) });
    const joined = net.addCorridor(merge.id, net.addSeam({ x: 400, y: 1000 }, EAST).id, { cls: 'avenue', lanes: oneWay(2) });
    // Перекрёсток: полосы подъезда расходятся по выездам манёврами, а сами идут рядом.
    const j = net.addJunction({ x: 0, y: 2000 });
    const approach = net.addCorridor(net.addSeam({ x: -400, y: 2000 }, EAST).id, j.id, { cls: 'avenue', lanes: twoWay(2, 2) });
    net.addCorridor(j.id, net.addSeam({ x: 400, y: 2000 }, EAST).id, { cls: 'avenue', lanes: twoWay(2, 2) });
    net.addCorridor(j.id, net.addSeam({ x: 0, y: 2400 }, { x: 0, y: 1 }).id, { cls: 'avenue', lanes: twoWay(2, 2) });
    expect(net.problems()).toEqual([]);
    const g = new LaneGraph(net);
    const [forkLink] = linksOf(g, two.id, 1);
    expect(perLane(g, forkLink)).toBe(true);
    expect(speedStrokes(g, forkLink)).toHaveLength(2);
    const [mergeLink] = linksOf(g, joined.id, 1);
    expect(perLane(g, mergeLink)).toBe(true);
    for (const link of g.corridorLinks(approach.id)) {
      expect(link.lanes).toHaveLength(2);
      expect(perLane(g, link)).toBe(false);
    }
  });
});

describe('Знак на повороте — у кромки своей полосы, не на чужой дороге', () => {
  const R = 3.2;

  it('на обычной полосе — у кромки, справа или слева по ходу', () => {
    const { graph: g, after } = exitRamp();
    const [link] = linksOf(g, after.id, -1);
    const lane = link.lanes[link.lanes.length - 1];
    const pose = g.lanePose(lane, 100);
    const right = rightNormal(pose.dir);
    const p = signSpot(g, lane, 100, 1, R)!;
    expect(dist(p, add(pose.pos, scale(right, LANE_W / 2 + 3 + R)))).toBeLessThan(1e-6);
    const left = signSpot(g, link.lanes[0], 100, -1, R)!;
    const leftPose = g.lanePose(link.lanes[0], 100);
    expect(dist(left, add(leftPose.pos, scale(right, -(LANE_W / 2 + 3 + R))))).toBeLessThan(1e-6);
  });

  it('у развилки знак слева от съезда — не на основной дороге, а дальше, где съезд отошёл', () => {
    const { net, graph: g, after, ramp } = exitRamp();
    const [link] = linksOf(g, ramp.id, 1);
    const lane = link.lanes[0];
    // Сразу за стыком слева от съезда — асфальт основной дороги.
    const pose = g.lanePose(lane, 0);
    const naive: Vec = add(pose.pos, scale(rightNormal(pose.dir), -(LANE_W / 2 + 3 + R)));
    expect(onOtherRoad(net, naive, R, ramp.id)).toBe(true);
    // Дальше места нет — знака нет; есть куда отодвинуть — дальше по съезду и уже не на дороге.
    expect(signSpot(g, lane, 0, -1, R, 0)).toBeNull();
    const p = signSpot(g, lane, 0, -1, R, lane.length);
    expect(p).not.toBeNull();
    expect(onOtherRoad(net, p!, R, ramp.id)).toBe(false);
    expect(after.lut.closest(p!).d).toBeGreaterThan(14 + R);
    // Справа от съезда чужих дорог нет — знак на месте.
    const rightSpot = signSpot(g, lane, 0, 1, R)!;
    expect(dist(rightSpot, add(pose.pos, scale(rightNormal(pose.dir), LANE_W / 2 + 3 + R)))).toBeLessThan(1e-6);
  });
});

describe('Скорость на однополосном съезде-эстакаде', () => {
  /** Односторонний съезд в одну полосу: с земли — на эстакаду (пандус), по ней — и снова на землю; рядом — дорога на земле. */
  function flyover() {
    const net = new LaneNet();
    const SOUTH = { x: 0, y: 1 };
    const one = { cls: 'highway' as const, lanes: oneWay(1) };
    const A = net.addSeam({ x: 0, y: 0 }, SOUTH);
    const B = net.addSeam({ x: 0, y: 200 }, SOUTH, 1);
    const C = net.addSeam({ x: 0, y: 450 }, SOUTH, 1);
    const D = net.addSeam({ x: 0, y: 700 }, SOUTH);
    const ramp = net.addCorridor(A.id, B.id, one);
    const deck = net.addCorridor(B.id, C.id, one);
    const down = net.addCorridor(C.id, D.id, one);
    const ground = net.addCorridor(net.addSeam({ x: 300, y: 0 }, SOUTH).id, net.addSeam({ x: 300, y: 700 }, SOUTH).id, one);
    return { net, graph: new LaneGraph(net), ramp, deck, down, ground };
  }

  it('съезд на эстакаду и сама эстакада — в слое моста: их скорость рисуется поверх полотна, а не под ним', () => {
    const { net, ramp, deck, down, ground } = flyover();
    expect(corridorLayer(net, ground)).toBe(0);
    for (const c of [ramp, deck, down]) expect(corridorLayer(net, c)).toBe(1);
    // На земле — дороги земли (и тоннелей); на проходе моста — только мосты и пандусы к ним.
    expect(inPass(0, 0)).toBe(true);
    expect(inPass(-1, 0)).toBe(true);
    expect(inPass(1, 0)).toBe(false);
    expect(inPass(1, 1)).toBe(true);
    expect(inPass(0, 1)).toBe(false);
    expect(inPass(2, 1)).toBe(false);
  });

  it('линия карты скоростей и знак на эстакаде подняты вместе с полотном', () => {
    const { net, graph: g, ramp, deck, ground } = flyover();
    for (const c of [ramp, deck]) {
      const [link] = g.corridorLinks(c.id);
      // Одна полоса — одна линия по её середине.
      const [stroke] = speedStrokes(g, link);
      expect(speedStrokes(g, link)).toHaveLength(1);
      const s = c.length / 2;
      const lift = bridgeLook(deckAlong(net, c, s)).lift;
      expect(lift.y).toBeLessThan(0);
      expect(deckLift(net, c, s)).toEqual(lift);
      expect(dist(strokePoint(net, c, stroke, s)!, add(pointOff(c, s, 0), lift))).toBeLessThan(1e-6);
      // Знак справа — у кромки полосы и поднят так же.
      const lane = link.lanes[0];
      const pose = g.lanePose(lane, s);
      const spot = signSpot(g, lane, s, 1, 3.2)!;
      expect(dist(spot, add(add(pose.pos, scale(rightNormal(pose.dir), LANE_W / 2 + 3 + 3.2)), lift))).toBeLessThan(1e-6);
    }
    // Начало пандуса — на земле: там ещё не поднят.
    expect(deckLift(net, ramp, 0)).toEqual({ x: 0, y: 0 });
    // На земле — без подъёма.
    const [link] = g.corridorLinks(ground.id);
    const [stroke] = speedStrokes(g, link);
    expect(deckLift(net, ground, 300)).toEqual({ x: 0, y: 0 });
    expect(dist(strokePoint(net, ground, stroke, 300)!, pointOff(ground, 300, 0))).toBeLessThan(1e-6);
  });

  it('линия карты пробок вдоль полотна: на земле — по оси со смещением, на эстакаде — поднята с полотном', () => {
    const { net, deck, ground } = flyover();
    const flat = deckLine(net, ground, 50, 650, 3.5, 6);
    const lut = ground.lut.offsetPolyline(3.5, 50, 650, 6);
    expect(flat).toHaveLength(lut.length);
    flat.forEach((p, i) => expect(dist(p, lut[i])).toBeLessThan(1e-6));
    // Шаг не больше заданного, концы — ровно на s0 и s1.
    const up = deckLine(net, deck, 10, 240, 0, 6);
    expect(up.length).toBeGreaterThanOrEqual(Math.ceil(230 / 6) + 1);
    expect(dist(up[0], add(pointOff(deck, 10, 0), deckLift(net, deck, 10)))).toBeLessThan(1e-6);
    expect(dist(up[up.length - 1], add(pointOff(deck, 240, 0), deckLift(net, deck, 240)))).toBeLessThan(1e-6);
    // Каждая точка — выше (на экране) той же точки оси на земле: линию не закрывает поднятое полотно.
    const n = up.length - 1;
    up.forEach((p, i) => expect(p.y).toBeLessThan(pointOff(deck, 10 + (230 * i) / n, 0).y - 0.5));
  });
});

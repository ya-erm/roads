import { describe, expect, it } from 'vitest';
import { LANE_W } from '../world/roadTypes';
import { edgesAt, junctionRadius, laneShare } from './geometry';
import { LaneNet, oneWay, slot, taperLen, twoWay } from './model';
import { buildLab } from './scenes';

const EAST = { x: 1, y: 0 };

/** Магистраль 2+2 с третьей полосой, которая в стыке уходит в съезд. */
function exitNet() {
  const net = new LaneNet();
  const a = net.addSeam({ x: -600, y: 0 }, EAST);
  const s = net.addSeam({ x: 0, y: 0 }, EAST);
  const main = net.addCorridor(a.id, s.id, { cls: 'highway', lanes: [...twoWay(2, 2), slot(17.5, 1, 330)] });
  const on = net.addCorridor(s.id, net.addSeam({ x: 600, y: 0 }, EAST).id, { cls: 'highway', lanes: twoWay(2, 2) });
  const ramp = net.addCorridor(s.id, net.addSeam({ x: 560, y: 230 }, { x: 1, y: 0.25 }).id, { cls: 'highway', portA: 17.5, lanes: oneWay(1) });
  return { net, main, on, ramp };
}

describe('Полосы: модель', () => {
  it('примеры лаборатории собраны без ошибок', () => {
    expect(buildLab().net.problems()).toEqual([]);
  });

  it('в стыке полосы соединяются по положению: крайняя — в съезд, остальные — дальше по дороге', () => {
    const { net, main, on, ramp } = exitNet();
    const byOffset = (o: number) => main.lanes.findIndex((l) => l.offset === o);
    expect(net.across(main, byOffset(17.5), 'b')).toEqual({ corridor: ramp, lane: 0, end: 'a' });
    for (const o of [-10.5, -3.5, 3.5, 10.5]) {
      const next = net.across(main, byOffset(o), 'b')!;
      expect(next.corridor).toBe(on);
      expect(on.lanes[next.lane].offset).toBe(o);
    }
    // Обратно — тоже: встречные полосы продолжаются назад.
    const back = on.lanes.findIndex((l) => l.flow === -1);
    expect(net.across(on, back, 'a')!.corridor).toBe(main);
  });

  it('полоса, которой некуда деться в стыке, — ошибка; тупик — нет', () => {
    const net = new LaneNet();
    const s = net.addSeam({ x: 0, y: 0 }, EAST);
    net.addCorridor(net.addSeam({ x: -300, y: 0 }, EAST).id, s.id, { cls: 'street', lanes: oneWay(2) });
    expect(net.problems()).toEqual([]);
    net.addCorridor(s.id, net.addSeam({ x: 300, y: 0 }, EAST).id, { cls: 'street', portA: -3.5, lanes: oneWay(1) });
    expect(net.problems()).toHaveLength(1);
  });

  it('отгон: полоса плавно расширяется до полной ширины, кромка дороги — вместе с ней', () => {
    const { main } = exitNet();
    const added = main.lanes.find((l) => l.offset === 17.5)!;
    const T = taperLen(main.cls);
    expect(laneShare(main, added, 330 - T - 1)).toBe(0);
    expect(laneShare(main, added, 330 - T / 2)).toBeCloseTo(0.5, 5);
    expect(laneShare(main, added, 330)).toBe(1);
    expect(edgesAt(main, 100)![1]).toBeCloseTo(14, 5);
    expect(edgesAt(main, 330 - T / 2)![1]).toBeCloseTo(14 + LANE_W / 2, 5);
    expect(edgesAt(main, 500)![1]).toBeCloseTo(21, 5);
  });

  it('в стыке кромки сходятся: полотна спереди вместе — ровно ширина полотна сзади', () => {
    const { net, main } = exitNet();
    const s = net.node(main.b);
    const span = (side: 1 | -1) => {
      const lats = net
        .ends(s)
        .filter((e) => e.side === side)
        .flatMap((e) => e.corridor.lanes.map((l) => net.laneAtSeam(e, l).lat));
      return [Math.min(...lats), Math.max(...lats)];
    };
    expect(span(1)).toEqual(span(-1));
  });

  it('радиус перекрёстка больше полуширины подъездов', () => {
    const net = new LaneNet();
    const j = net.addJunction({ x: 0, y: 0 });
    net.addCorridor(net.addSeam({ x: -300, y: 0 }, EAST).id, j.id, { cls: 'avenue', lanes: twoWay(2, 2) });
    net.addCorridor(j.id, net.addSeam({ x: 0, y: 300 }, { x: 0, y: 1 }).id, { cls: 'street', lanes: twoWay(1, 1) });
    expect(junctionRadius(net, j)).toBeGreaterThan(2 * LANE_W + 1.5);
  });
});

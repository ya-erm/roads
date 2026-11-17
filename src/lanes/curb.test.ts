import { describe, expect, it } from 'vitest';
import { CURB, curbStalls } from './curb';
import { EditError, laneStep, toggleParkLane } from './edit';
import { LaneGraph } from './graph';
import { driveLanes, LaneNet, twoWay } from './model';
import { centreLine } from './solid';

/** Прямая дорога из перекрёстка в перекрёсток длиной L вдоль оси x (концы — перекрёстки с одной дорогой: как улица). */
function straight(cls: 'street' | 'avenue' | 'highway', f: number, b: number, L = 300) {
  const net = new LaneNet();
  const A = net.addJunction({ x: 0, y: 0 });
  const B = net.addJunction({ x: L, y: 0 });
  const c = net.addCorridor(A.id, B.id, { cls, lanes: twoWay(f, b) });
  return { net, c };
}

describe('Полоса стоянки (LaneSlot.park)', () => {
  it('слот стоянки — асфальт, но не полоса движения: граф по нему связей не строит, осевая 1+1 — пунктир', () => {
    const { net, c } = straight('street', 1, 1);
    net.setLanes(c, [...c.lanes, { offset: 10.5, flow: 1, from: 25, to: c.length - 25, park: true }]);
    expect(net.problems()).toEqual([]);
    const g = new LaneGraph(net);
    const links = g.corridorLinks(c.id);
    // По одной связи в каждую сторону (стоянка связи не режет), в каждой — одна полоса, и это не стоянка.
    expect(links).toHaveLength(2);
    for (const l of links) {
      expect(l.lanes).toHaveLength(1);
      expect(c.lanes[l.lanes[0].laneIdx].park).toBeUndefined();
    }
    expect(driveLanes(c)).toHaveLength(2);
    expect(centreLine(net, c, c.length / 2, 0, c.length)).toBe('dash');
  });

  it('«Полоса» с 🅿️ ведёт стоянку вдоль края с ходом соседней полосы; на магистрали — отказ', () => {
    const { net, c } = straight('street', 1, 1);
    laneStep(net, { kind: 'edge', corridor: c.id, offset: 10.5, s: 60 }, { x: 240, y: 10.5 }, 'street', 14, false, undefined, true);
    const park = net.corridor(c.id).lanes.find((l) => l.park)!;
    expect(park).toMatchObject({ offset: 10.5, flow: 1, park: true });
    expect(park.to - park.from).toBeGreaterThan(150);
    // Слева по оси (встречная сторона 1+1) — ход −1: места тоже справа по ходу.
    laneStep(net, { kind: 'edge', corridor: c.id, offset: -10.5, s: 60 }, { x: 240, y: -10.5 }, 'street', 14, false, undefined, true);
    expect(net.corridor(c.id).lanes.find((l) => l.park && l.offset < 0)).toMatchObject({ flow: -1 });
    expect(net.problems()).toEqual([]);
    const hw = straight('highway', 1, 1);
    expect(() => laneStep(hw.net, { kind: 'edge', corridor: hw.c.id, offset: 10.5, s: 60 }, { x: 240, y: 10.5 }, 'highway', 14, false, undefined, true)).toThrow(EditError);
  });

  it('«🅿️ под парковку» забирает крайнюю полосу движения и «↺ вернуть движению» отдаёт её; на 1+1 и магистрали — нельзя', () => {
    const { net, c } = straight('avenue', 2, 2);
    const outer = c.lanes.findIndex((l) => l.offset === 10.5);
    expect(toggleParkLane(net, c, outer)).toBe('park');
    expect(net.corridor(c.id).lanes[outer].park).toBe(true);
    let g = new LaneGraph(net);
    expect(g.corridorLinks(c.id).find((l) => l.flow === 1)!.lanes).toHaveLength(1);
    // Внутренняя полоса той же стороны — не крайняя: нельзя.
    const inner = c.lanes.findIndex((l) => l.offset === 3.5);
    expect(() => toggleParkLane(net, net.corridor(c.id), inner)).toThrow(EditError);
    expect(toggleParkLane(net, net.corridor(c.id), outer)).toBe('drive');
    g = new LaneGraph(net);
    expect(g.corridorLinks(c.id).find((l) => l.flow === 1)!.lanes).toHaveLength(2);
    const one = straight('street', 1, 1);
    expect(() => toggleParkLane(one.net, one.c, one.c.lanes.findIndex((l) => l.offset > 0))).toThrow(/1\+1/);
    const hw = straight('highway', 2, 2);
    expect(() => toggleParkLane(hw.net, hw.c, hw.c.lanes.findIndex((l) => l.offset === 10.5))).toThrow(/магистрал/);
  });

  it('места 9,5 × 4,6 у бордюра — по сетке от начала полосы, не ближе 15 к узлу, у светофора — 30; заезды без мест', () => {
    const { net, c } = straight('street', 1, 1, 400);
    net.setLanes(c, [...c.lanes, { offset: 10.5, flow: 1, from: 25, to: 375, park: true }]);
    const i = net.corridor(c.id).lanes.findIndex((l) => l.park);
    const all = curbStalls(net, net.corridor(c.id), i, [0, 0], [false, false], []);
    expect(all.length).toBeGreaterThan(30);
    for (const st of all) {
      expect(st.s - CURB.stallLen / 2).toBeGreaterThanOrEqual(25 - 1e-6);
      expect(st.s + CURB.stallLen / 2).toBeLessThanOrEqual(375 + 1e-6);
      // У бордюра: середина места — на 1,2 ед. дальше оси полосы стоянки, ход — по полосе движения.
      expect(st.pos.y).toBeCloseTo(10.5 + 3.5 - CURB.stallDepth / 2, 5);
      expect(st.dir.x).toBeCloseTo(1, 5);
    }
    const lit = curbStalls(net, net.corridor(c.id), i, [0, 0], [true, false], []);
    expect(Math.min(...lit.map((s) => s.s - CURB.stallLen / 2))).toBeGreaterThanOrEqual(CURB.lightRoom - 1e-6);
    // Заезд на 200 — мест над ним нет, а у соседних — те же ключи (номер — по сетке).
    const gap = curbStalls(net, net.corridor(c.id), i, [0, 0], [false, false], [[196, 204]]);
    expect(gap.some((s) => Math.abs(s.s - 200) < CURB.stallLen / 2 + 4)).toBe(false);
    const keys = new Set(all.map((s) => s.key));
    expect(gap.every((s) => keys.has(s.key))).toBe(true);
    expect(all.length - gap.length).toBeLessThanOrEqual(2);
  });
});

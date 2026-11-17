import { describe, expect, it } from 'vitest';
import { PARK_W, ROAD_MARGIN } from '../world/roadTypes';
import { CURB, curbDrive, curbEndRoom, curbStalls, fitCurbEnds, stallTee } from './curb';
import { EditError, laneStep, toggleParkLane } from './edit';
import { edgesAt, junctionCuts } from './geometry';
import { LaneGraph } from './graph';
import { driveLanes, fitParkOffsets, LaneNet, taperLen, twoWay } from './model';
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
    net.setLanes(c, [...c.lanes, { offset: 8.75, flow: 1, from: 25, to: c.length - 25, park: true }]);
    expect(net.problems()).toEqual([]);
    // Стоянка уже полосы движения: кромка асфальта — на 3,5 + 3,5 + 3,5 = 10,5 от оси, а не на 14.
    expect(edgesAt(c, c.length / 2)).toEqual([-7, 10.5]);
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
    // От края дороги (место полосы 10,5) — уже: вплотную к полосе движения, на 3,5 + (7 + 3,5) / 2.
    expect(park).toMatchObject({ offset: 8.75, flow: 1, park: true });
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
    // Стоянка уже: вплотную к полосе движения, бордюр — ближе к оси (10,5 вместо 14).
    expect(net.corridor(c.id).lanes[outer].offset).toBeCloseTo(8.75, 6);
    expect(edgesAt(net.corridor(c.id), c.length / 2)![1]).toBeCloseTo(10.5, 6);
    let g = new LaneGraph(net);
    expect(g.corridorLinks(c.id).find((l) => l.flow === 1)!.lanes).toHaveLength(1);
    // Внутренняя полоса той же стороны — не крайняя: нельзя.
    const inner = c.lanes.findIndex((l) => l.offset === 3.5);
    expect(() => toggleParkLane(net, net.corridor(c.id), inner)).toThrow(EditError);
    expect(toggleParkLane(net, net.corridor(c.id), outer)).toBe('drive');
    // Снова полоса движения — на прежнем месте и во всю длину (у перекрёстков стоянка была короче).
    expect(net.corridor(c.id).lanes[outer]).toMatchObject({ offset: 10.5, from: 0, to: c.length });
    g = new LaneGraph(net);
    expect(g.corridorLinks(c.id).find((l) => l.flow === 1)!.lanes).toHaveLength(2);
    const one = straight('street', 1, 1);
    expect(() => toggleParkLane(one.net, one.c, one.c.lanes.findIndex((l) => l.offset > 0))).toThrow(/1\+1/);
    const hw = straight('highway', 2, 2);
    expect(() => toggleParkLane(hw.net, hw.c, hw.c.lanes.findIndex((l) => l.offset === 10.5))).toThrow(/магистрал/);
  });

  it('места 9,5 у бордюра — по сетке от начала полосы, не ближе 15 к узлу, у светофора — 30; заезды без мест', () => {
    const { net, c } = straight('street', 1, 1, 400);
    net.setLanes(c, [...c.lanes, { offset: 8.75, flow: 1, from: 25, to: 375, park: true }]);
    const i = net.corridor(c.id).lanes.findIndex((l) => l.park);
    const all = curbStalls(net, net.corridor(c.id), i, [0, 0], [false, false], []);
    expect(all.length).toBeGreaterThan(30);
    // Бордюр — за кромкой слота на обочину: 10,5 + 1,5.
    const curb = 8.75 + PARK_W / 2 + ROAD_MARGIN;
    for (const st of all) {
      expect(st.s - CURB.stallLen / 2).toBeGreaterThanOrEqual(25 - 1e-6);
      expect(st.s + CURB.stallLen / 2).toBeLessThanOrEqual(375 + 1e-6);
      // У бордюра: машина 3,6 — в полосе stallDepth от бордюра, не на тротуаре и не на полосе движения (край — 7).
      expect(st.pos.y).toBeCloseTo(curb - CURB.stallDepth / 2, 5);
      expect(st.pos.y + 3.6 / 2).toBeLessThan(curb - 0.2);
      expect(st.pos.y - 3.6 / 2).toBeGreaterThan(7 + 0.2);
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

  it('граница мест — буква «Т»: поперечная от края движения до бордюра и засечка вдоль полосы у края движения', () => {
    const { net, c } = straight('street', 1, 1, 400);
    net.setLanes(c, [...c.lanes, { offset: 8.75, flow: 1, from: 25, to: 375, park: true }]);
    const P = net.corridor(c.id).lanes.find((l) => l.park)!;
    const [stem, bar] = stallTee(net.corridor(c.id), P, 100);
    expect(stem[0]).toMatchObject({ x: 100, y: 7 });
    expect(stem[1].x).toBeCloseTo(100, 6);
    expect(stem[1].y).toBeCloseTo(7 + PARK_W + ROAD_MARGIN, 6);
    expect(bar[0].x).toBeCloseTo(100 - CURB.tee, 6);
    expect(bar[1].x).toBeCloseTo(100 + CURB.tee, 6);
    expect(bar[0].y).toBeCloseTo(7, 6);
    expect(bar[1].y).toBeCloseTo(7, 6);
  });

  it('у перекрёстка стоянка — не до площадки: отгон начинается за обрезом (fitCurbEnds), угол — как у полотна без неё', () => {
    const net = new LaneNet();
    const A = net.addJunction({ x: 0, y: 0 });
    const B = net.addJunction({ x: 300, y: 0 });
    const S = net.addJunction({ x: 0, y: 200 });
    const N = net.addJunction({ x: 0, y: -200 });
    const c = net.addCorridor(A.id, B.id, { cls: 'street', lanes: twoWay(1, 1) });
    net.addCorridor(A.id, S.id, { cls: 'street', lanes: twoWay(1, 1) });
    net.addCorridor(A.id, N.id, { cls: 'street', lanes: twoWay(1, 1) });
    // Старый вид: отгон от самого узла — у обреза асфальт уже почти на всю ширину стоянки.
    net.setLanes(c, [...c.lanes, { offset: 8.75, flow: 1, from: 25, to: 275, park: true }]);
    const cut = junctionCuts(net).get(c.id)![0];
    expect(cut).toBeGreaterThan(10);
    expect(curbEndRoom(net, net.corridor(c.id))[0]).toBeCloseTo(cut + taperLen('street'), 6);
    expect(fitCurbEnds(net, net.corridor(c.id))).toBe(true);
    const k = net.corridor(c.id);
    const P = k.lanes.find((l) => l.park)!;
    expect(P.from).toBeCloseTo(cut + taperLen('street'), 6);
    // До обреза и на нём — полотно без стоянки; дальше — плавно шире, без ступеньки.
    expect(edgesAt(k, cut)![1]).toBeCloseTo(7, 6);
    let prev = 7;
    for (let s = cut; s <= P.from; s += 1) {
      const e = edgesAt(k, s)![1];
      expect(e).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(e - prev).toBeLessThan(0.25);
      prev = e;
    }
    expect(prev).toBeCloseTo(10.5, 6);
    // Второй раз — уже на месте.
    expect(fitCurbEnds(net, k)).toBe(false);
  });

  it('старое сохранение: полоса стоянки шириной полосы (на 7 от полосы движения) встаёт вплотную по нынешней ширине', () => {
    const { net, c } = straight('avenue', 2, 2);
    const lanes = c.lanes.map((l) => (l.offset === 10.5 ? { ...l, park: true as const, from: 40, to: 260 } : l));
    const save = net.toJSON();
    save.corridors.find((x) => x.id === c.id)!.lanes = lanes;
    const back = LaneNet.fromJSON(save);
    const P = back.corridor(c.id).lanes.find((l) => l.park)!;
    expect(P.offset).toBeCloseTo(8.75, 6);
    expect(curbDrive(back.corridor(c.id), P)?.offset).toBe(3.5);
    // Новое сохранение — как было.
    expect(LaneNet.fromJSON(back.toJSON()).corridor(c.id).lanes.find((l) => l.park)!.offset).toBeCloseTo(8.75, 6);
    expect(fitParkOffsets(lanes).filter((l) => !l.park)).toEqual(lanes.filter((l) => !l.park));
  });
});

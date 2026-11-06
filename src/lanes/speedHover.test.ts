import { describe, expect, it } from 'vitest';
import { KMH_PER_UNIT } from '../world/roadTypes';
import { GLane, LaneGraph } from './graph';
import { LaneNet, oneWay, twoWay } from './model';
import { laneKmhAt, signKmh, speedsAt, speedsUnder, speedText } from './speedHover';
import { buildLaneProfile, LaneProfile } from './speedProfile';

const EAST = { x: 1, y: 0 };
const SOUTH = { x: 0, y: 1 };

/** Профиль полосы по изгибам, как у игры (без рельефа). */
const profileOf = (g: LaneGraph) => (lane: GLane) => buildLaneProfile(g, lane, null);

/** Прямой проспект 2+2 вдоль x от (0, 0) до (400, 0); limit — своё ограничение скорости. */
function avenue(limit?: number) {
  const net = new LaneNet();
  const c = net.addCorridor(net.addSeam({ x: 0, y: 0 }, EAST).id, net.addSeam({ x: 400, y: 0 }, EAST).id, { cls: 'avenue', lanes: twoWay(2, 2), limit });
  return { net, c, graph: new LaneGraph(net) };
}

describe('Скорость у курсора на карте скоростей', () => {
  it('число — как на знаках: разрешённая, а заметно сниженная поворотом — кратно 10 вниз', () => {
    expect(signKmh(60, 200)).toBe(60);
    // Снижение меньше 5 км/ч — знака нет, и число — разрешённое.
    expect(signKmh(60, 56)).toBe(60);
    expect(signKmh(60, 47)).toBe(40);
    expect(signKmh(90, 30)).toBe(30);
    expect(signKmh(60, 4)).toBe(10);
  });

  it('прямая дорога в обе стороны — одно число, её разрешённая скорость', () => {
    const { c, graph } = avenue();
    for (const lat of [5, -5, 0]) expect(speedsAt(graph, profileOf(graph), c, 200, lat)).toEqual([60]);
    // Своё ограничение дороги — оно.
    const slow = avenue(30);
    expect(speedsAt(slow.graph, profileOf(slow.graph), slow.c, 200, 5)).toEqual([30]);
  });

  it('односторонняя — одно число', () => {
    const net = new LaneNet();
    const c = net.addCorridor(net.addSeam({ x: 0, y: 0 }, EAST).id, net.addSeam({ x: 300, y: 0 }, EAST).id, { cls: 'street', lanes: oneWay(2) });
    const graph = new LaneGraph(net);
    expect(speedsAt(graph, profileOf(graph), c, 150, 2)).toEqual([40]);
  });

  it('на крутом повороте — сниженная, одна для обоих направлений', () => {
    // Шоссе (90 км/ч) поворачивает на 90° на коротком отрезке — радиус около 50 м.
    const net = new LaneNet();
    const c = net.addCorridor(net.addSeam({ x: 0, y: 0 }, EAST).id, net.addSeam({ x: 60, y: 60 }, SOUTH).id, { cls: 'highway', lanes: twoWay(1, 1) });
    const graph = new LaneGraph(net);
    const at = speedsAt(graph, profileOf(graph), c, c.length / 2, 2);
    expect(at).toHaveLength(1);
    expect(at[0]).toBeLessThan(90);
    expect(at[0] % 10).toBe(0);
  });

  it('по направлениям разная — обе; первой — та, на чьей полосе курсор', () => {
    const { c, graph } = avenue();
    // Встречным (flow −1) поворот где-то впереди снижает скорость до 25 км/ч — тут, у курсора, тоже.
    const prof = (lane: GLane): LaneProfile => {
      const p = buildLaneProfile(graph, lane, null);
      return graph.links.get(lane.link)!.flow > 0 ? p : { ...p, c: p.c.map(() => 25 / KMH_PER_UNIT) };
    };
    // Курсор на попутной полосе (справа от оси по a→b) — сначала её скорость, на встречной — наоборот.
    expect(speedsAt(graph, prof, c, 200, 6)).toEqual([60, 20]);
    expect(speedsAt(graph, prof, c, 200, -6)).toEqual([20, 60]);
  });

  it('скорость полосы — у шага профиля, в который попал курсор (как цвет карты)', () => {
    const { graph } = avenue();
    const lane = [...graph.lanes.values()][0];
    const p = buildLaneProfile(graph, lane, null);
    const c = p.c.map((_, k) => (k === 3 ? 20 / KMH_PER_UNIT : p.c[k]));
    const prof = { ...p, c };
    expect(laneKmhAt(lane, prof, 3 * 6 + 1)).toBe(20);
    expect(laneKmhAt(lane, prof, 3 * 6 - 1)).toBe(60);
    // За концами полосы — её крайние шаги.
    expect(laneKmhAt(lane, prof, -10)).toBe(60);
    expect(laneKmhAt(lane, prof, lane.length + 50)).toBe(60);
  });

  it('под точкой: на асфальте — скорость дороги, рядом с дорогой — ничего', () => {
    const { graph } = avenue(80);
    expect(speedsUnder(graph, profileOf(graph), { x: 150, y: 4 })).toEqual([80]);
    expect(speedsUnder(graph, profileOf(graph), { x: 150, y: 40 })).toEqual([]);
    expect(speedsUnder(graph, profileOf(graph), { x: 600, y: 0 })).toEqual([]);
  });

  it('подпись: одно число или по направлениям через косую черту; не на дороге — нет', () => {
    expect(speedText([90])).toBe('90 км/ч');
    expect(speedText([80, 90])).toBe('80 / 90 км/ч');
    expect(speedText([])).toBeNull();
  });
});

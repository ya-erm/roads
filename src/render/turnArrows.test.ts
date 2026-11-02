import { describe, expect, it } from 'vitest';
import { LaneGraph } from '../lanes/graph';
import { LaneNet, twoWay } from '../lanes/model';
import { arrowShape, laneArrows, laneTurns, Turn } from './turnArrows';

/** Перекрёсток проспекта 2+2 (запад — восток) и улицы 1+1 (север — юг), как в лаборатории. */
function crossing() {
  const net = new LaneNet();
  const j = net.addJunction({ x: 0, y: 0 });
  const seam = (x: number, y: number, dir = { x: 1, y: 0 }) => net.addSeam({ x, y }, dir);
  const west = net.addCorridor(seam(-400, 0).id, j.id, { cls: 'avenue', lanes: twoWay(2, 2) });
  const east = net.addCorridor(j.id, seam(400, 0).id, { cls: 'avenue', lanes: twoWay(2, 2) });
  const north = net.addCorridor(seam(0, -300, { x: 0, y: 1 }).id, j.id, { cls: 'street', lanes: twoWay(1, 1) });
  const south = net.addCorridor(j.id, seam(0, 300, { x: 0, y: 1 }).id, { cls: 'street', lanes: twoWay(1, 1) });
  return { net, j, west, east, north, south };
}

/** Подъезд к перекрёстку по полотну. */
const approach = (g: LaneGraph, node: number, corridor: number) => g.inLinks.get(node)!.find((l) => l.corridor === corridor)!;

describe('Стрелки направлений на полосах', () => {
  it('с проспекта: левая полоса — прямо и налево, правая — прямо и направо', () => {
    const { net, j, west } = crossing();
    const g = new LaneGraph(net);
    const link = approach(g, j.id, west.id);
    expect(link.lanes).toHaveLength(2);
    const sets = laneTurns(g, link).map((s) => [...s].sort());
    expect(sets).toEqual([
      ['left', 'straight'],
      ['right', 'straight'],
    ]);
    expect(laneArrows(g, link)).toEqual([
      ['left', 'straight'],
      ['straight', 'right'],
    ]);
  });

  it('на однополосной улице стрелок нет', () => {
    const { net, j, north } = crossing();
    const g = new LaneGraph(net);
    const link = approach(g, j.id, north.id);
    expect([...laneTurns(g, link)[0]].sort()).toEqual(['left', 'right', 'straight']);
    expect(laneArrows(g, link)).toEqual([null]);
  });

  it('запрет налево: левой полосе — «прямо»; раз одна полоса размечена — размечены все полосы подъезда', () => {
    const { net, j, west, north } = crossing();
    j.bans = [`${west.id}>${north.id}`];
    const g = new LaneGraph(net);
    expect(laneArrows(g, approach(g, j.id, west.id))).toEqual([['straight'], ['straight', 'right']]);
  });

  it('повороты запрещены — на всех полосах «только прямо»; со всех полос можно всюду — стрелок нет', () => {
    const { net, j, west, north, south, east } = crossing();
    j.bans = [`${west.id}>${north.id}`, `${west.id}>${south.id}`];
    const g = new LaneGraph(net);
    expect(laneArrows(g, approach(g, j.id, west.id))).toEqual([['straight'], ['straight']]);
    // С востока на проспекте ничего не запрещено, но левая полоса — только налево и прямо: стрелки есть.
    expect(laneArrows(g, approach(g, j.id, east.id)).every((a) => a !== null)).toBe(true);
  });

  it('стрелка любой формы помещается в полосу и смотрит вперёд', () => {
    const all: Turn[][] = [['straight'], ['left'], ['right'], ['uturn'], ['left', 'straight'], ['straight', 'right'], ['left', 'straight', 'right'], ['uturn', 'left'], ['uturn', 'left', 'straight']];
    for (const turns of all) {
      const pts = arrowShape(turns).flat();
      expect(Math.max(...pts.map((p) => Math.abs(p.y)))).toBeLessThan(3.2);
      expect(Math.min(...pts.map((p) => p.x))).toBeGreaterThan(-5.5);
      expect(Math.max(...pts.map((p) => p.x))).toBeLessThan(4.5);
    }
  });
});

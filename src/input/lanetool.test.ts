import { describe, expect, it } from 'vitest';
import type { Vec } from '../core/vec';
import { Game } from '../game/game';
import { road } from '../game/testkit';
import { oneWay } from '../lanes/model';
import { RoadTools } from './roadtools';

const STREET = { cls: 'street' as const, lanesF: 1, lanesB: 1 };

/** Прямая улица из двух полотен со стыком посередине — в чистом поле. */
function streetWithSeam(game: Game): Vec {
  for (let y = 400; y < game.terrain.height - 400; y += 120) {
    for (let x = 300; x < game.terrain.width - 1100; x += 160) {
      if (road(game, { free: { x, y } }, { free: { x: x + 400, y } }) && road(game, { x: x + 400, y }, { free: { x: x + 900, y } })) return { x, y };
    }
  }
  throw new Error('нет места');
}

/** Протяжка мышью: нажали в первой точке, провели через остальные, отпустили в последней. */
function drag(tools: RoadTools, pts: Vec[]): string | null {
  tools.laneDown(pts[0], 14);
  for (const p of pts.slice(1)) tools.laneMove(p, 14);
  return tools.laneUp(pts[pts.length - 1], 14, STREET, true);
}

describe('Инструмент «Полоса»: место рядом с другой дорогой', () => {
  it('полоса с дальней от соседней дороги стороны строится, с ближней — слишком близко', () => {
    const game = new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' });
    let o: Vec | null = null;
    for (let y = 400; y < game.terrain.height - 400 && !o; y += 120) {
      for (let x = 300; x < game.terrain.width - 900 && !o; x += 160) {
        if (road(game, { free: { x, y } }, { free: { x: x + 500, y } }) && road(game, { free: { x, y: y - 20 } }, { free: { x: x + 500, y: y - 20 } })) o = { x, y };
      }
    }
    expect(o).not.toBeNull();
    const at = o!;
    const tools = new RoadTools(() => game);
    // Соседняя улица — выше (−y): снизу полоса встаёт, сверху ей нет места.
    expect(drag(tools, [{ x: at.x + 100, y: at.y + 10.5 }, { x: at.x + 250, y: at.y + 10.5 }, { x: at.x + 350, y: at.y + 10.5 }])).toBeNull();
    expect(drag(tools, [{ x: at.x + 100, y: at.y - 10.5 }, { x: at.x + 250, y: at.y - 10.5 }, { x: at.x + 350, y: at.y - 10.5 }])).toBe('Слишком близко к другой дороге');
  });
});

describe('Перестроить: разворот односторонней', () => {
  it('тот же профиль поверх односторонней из нескольких кусков разворачивает её всю, без встречных полос на стыках', () => {
    const game = new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' });
    const ONE = { cls: 'street' as const, lanes: oneWay(1) };
    let o: Vec | null = null;
    for (let y = 400; y < game.terrain.height - 400 && !o; y += 120) {
      for (let x = 300; x < game.terrain.width - 1000 && !o; x += 160) {
        if (road(game, { free: { x, y } }, { free: { x: x + 300, y } }, ONE)) o = { x, y };
      }
    }
    const at = o!;
    expect(road(game, { x: at.x + 300, y: at.y }, { free: { x: at.x + 600, y: at.y } }, ONE)).toBe(true);
    expect(road(game, { x: at.x + 600, y: at.y }, { free: { x: at.x + 900, y: at.y } }, ONE)).toBe(true);
    const mine = () => [...game.roads.net.corridors.values()].filter((c) => [c.a, c.b].every((id) => Math.abs(game.roads.net.node(id).pos.y - at.y) < 1));
    expect(mine()).toHaveLength(3);
    const dirs = () => mine().map((c) => Math.sign((game.roads.net.node(c.b).pos.x - game.roads.net.node(c.a).pos.x) * c.lanes[0].flow));
    expect(dirs()).toEqual([1, 1, 1]);
    const tools = new RoadTools(() => game);
    expect(tools.upgrade({ x: at.x + 450, y: at.y }, { cls: 'street', lanesF: 1, lanesB: 0 }, 4)).toBeNull();
    expect(dirs()).toEqual([-1, -1, -1]);
    expect(mine().every((c) => c.lanes[0].from === 0)).toBe(true);
    expect(game.roads.net.problems()).toEqual([]);
  });
});

describe('Инструмент «Полоса»: протяжка', () => {
  it('полоса, которую тянут вдоль края, проходит через стык дальше', () => {
    const game = new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' });
    const o = streetWithSeam(game);
    const tools = new RoadTools(() => game);
    const edge = (dx: number) => ({ x: o.x + dx, y: o.y + 10.5 });
    expect(drag(tools, [edge(150), edge(300), edge(450), edge(600), edge(700)])).toBeNull();
    const net = game.roads.net;
    const mine = [...net.corridors.values()].filter((c) => [c.a, c.b].every((id) => Math.abs(net.node(id).pos.y - o.y) < 1));
    const pieces = mine.filter((c) => c.lanes.some((l) => Math.abs(Math.abs(l.offset) - 10.5) < 0.5));
    expect(mine).toHaveLength(2);
    expect(pieces).toHaveLength(2);
    expect(net.problems()).toEqual([]);
  });

  it('тянут вдоль и уводят в сторону — съезд там, где ушли от края; правой кнопкой — отмена протяжки', () => {
    const game = new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' });
    const o = streetWithSeam(game);
    const tools = new RoadTools(() => game);
    const before = game.roads.net.corridors.size;
    tools.laneDown({ x: o.x + 100, y: o.y + 10.5 }, 14);
    tools.laneMove({ x: o.x + 200, y: o.y + 10.5 }, 14);
    expect(tools.cancel()).toBe(true);
    expect(tools.laneUp({ x: o.x + 200, y: o.y + 10.5 }, 14, STREET, true)).toBeNull();
    expect(game.roads.net.corridors.size).toBe(before);

    expect(drag(tools, [{ x: o.x + 100, y: o.y + 10.5 }, { x: o.x + 250, y: o.y + 10.5 }, { x: o.x + 320, y: o.y + 60 }, { x: o.x + 360, y: o.y + 160 }])).toBeNull();
    const net = game.roads.net;
    const ramp = [...net.corridors.values()].find((c) => c.portA || c.portB)!;
    expect(ramp).toBeDefined();
    const seam = net.node(ramp.portA ? ramp.a : ramp.b);
    expect(seam.pos.x - o.x).toBeCloseTo(250, -1);
    expect(net.problems()).toEqual([]);
  });
});

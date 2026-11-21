import { describe, expect, it } from 'vitest';
import { LaneNet } from '../lanes/model';
import { PEDESTRIAN_LEVELS } from '../config';
import { freshGame } from './testkit';

describe('Количество пешеходов', () => {
  it('на карте с ограничением численности каждый уровень увеличивает население без снятия паузы', () => {
    const game = freshGame(7);
    game.speed = 0;
    // Три неподвижных кадра 200×110 м у центральных перекрёстков разных городов.
    const crossroads = [...game.roads.net.nodes.values()].filter(node => node.corridors.length >= 3);
    const frames = game.towns.slice(0, 3).map(town => {
      const distance = (p: typeof town.center) => Math.hypot(p.x - town.center.x, p.y - town.center.y);
      const { pos } = crossroads.reduce((nearest, node) => distance(node.pos) < distance(nearest.pos) ? node : nearest);
      return { x0: pos.x - 100, x1: pos.x + 100, y0: pos.y - 55, y1: pos.y + 55 };
    });
    const counts = PEDESTRIAN_LEVELS.map(level => {
      game.setPedestrians(true, level);
      return frames.map(frame => [...game.pedestrians.visible(game.time, frame)].length);
    });
    for (const [index, first] of counts[0].entries()) {
      expect(first).toBeGreaterThan(0);
      for (let level = 1; level < counts.length; level++) {
        expect(counts[level][index]).toBeGreaterThan(counts[level - 1][index]);
      }
      expect(counts[4][index]).toBeGreaterThanOrEqual(first * 6);
    }
    const shown = (frame: typeof frames[number]) => [...game.pedestrians.visible(game.time, frame)];
    const before = frames.map(shown);
    game.setPedestrians(false);
    expect(game.pedestrians.walkers).toHaveLength(0);
    game.setPedestrians(true);
    expect(frames.map(shown)).toEqual(before);
    game.setPedestrians(true, 1);
    expect(game.pedestrians.walkers).toHaveLength(480);
  });

  it('новая группа распределяется по всем дорожкам, прежние пешеходы продолжают свой путь', () => {
    const game = freshGame({ seed: 7, towns: 0, industries: 'few', size: 'small', water: 'dry', money: 500_000 });
    game.roads.replace(new LaneNet());
    game.footpaths = [1, 2, 3, 4].map(i => ({
      id: i, a: { x: -100_000, y: -100_000 + i * 40 }, b: { x: -99_000, y: -100_000 + i * 40 },
    }));
    game.setPedestrians(true);
    game.time += 1;
    game.pedestrians.step(game);
    const before = [...game.pedestrians.visible(game.time)];
    game.setPedestrians(true, 5);
    const after = [...game.pedestrians.visible(game.time)];
    expect(after.slice(0, before.length)).toEqual(before);
    const added = after.slice(before.length);
    const groups = game.footpaths.map(p => added.filter(person => person.pos.y === p.a.y).length);
    expect(Math.max(...groups) - Math.min(...groups)).toBeLessThanOrEqual(2);
    expect(Math.min(...groups)).toBeGreaterThan(0);
  });
});

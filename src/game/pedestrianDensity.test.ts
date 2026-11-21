import { describe, expect, it } from 'vitest';
import { LaneNet } from '../lanes/model';
import { PEDESTRIAN_LEVELS } from '../config';
import { freshGame } from './testkit';

describe('Количество пешеходов', () => {
  it('на карте с ограничением численности каждый уровень увеличивает население без снятия паузы', () => {
    const game = freshGame(7);
    game.speed = 0;
    const counts = PEDESTRIAN_LEVELS.map(level => {
      game.setPedestrians(true, level);
      return [...game.pedestrians.visible(game.time)].length;
    });
    expect(counts).toEqual([480, 720, 960, 1200, 1440]);
    game.setPedestrians(false);
    expect(game.pedestrians.walkers).toHaveLength(0);
    game.setPedestrians(true);
    expect(game.pedestrians.walkers).toHaveLength(1440);
    game.setPedestrians(true, 1);
    expect(game.pedestrians.walkers).toHaveLength(480);
  });

  it('новая группа распределяется по всем дорожкам, прежние пешеходы продолжают свой путь', () => {
    const game = freshGame(7);
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

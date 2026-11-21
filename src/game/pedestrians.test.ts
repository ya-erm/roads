import { describe, expect, it } from 'vitest';
import { add, dist, norm, scale, sub } from '../core/vec';
import { setWalk } from '../lanes/crosswalk';
import { LaneNet, twoWay } from '../lanes/model';
import { freshGame } from './testkit';
import { Pedestrians } from './pedestrians';

describe('Пешеходы на дорожках к подземному переходу', () => {
  it('подготовка нового месяца по частям даёт те же пути и позиции, что обычный первый такт', () => {
    const game = freshGame(7);
    const stepped = new Pedestrians();
    const direct = new Pedestrians();
    stepped.on = direct.on = true;
    const steps = stepped.prepareMonth(game);
    expect(steps.next().done).toBe(false);
    expect(stepped.walkers).toHaveLength(0);
    for (const _ of steps) { /* досчитать карту между кадрами */ }
    stepped.step(game);
    direct.step(game);
    const positions = (p: Pedestrians) => p.walkers.map(w => [w.edge.key, w.start, w.end, w.reverse]);
    expect(stepped.walkers.length).toBeGreaterThan(0);
    expect(positions(stepped)).toEqual(positions(direct));
  });
  it.each(['у лестницы', 'у прежнего входа'] as const)('человек доходит по дорожке %s, спускается и выходит с другой стороны, машины свободно едут', (connection) => {
    const game = freshGame(7);
    // Отдельный перекрёсток вдали от городов — ровно две подходящие дорожки, без иных тротуаров.
    const streets = new LaneNet();
    const origin = { x: -100_000, y: -100_000 };
    const j = streets.addJunction(origin);
    for (const dir of [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }]) {
      const end = streets.addSeam({ x: origin.x + dir.x * 100, y: origin.y + dir.y * 100 }, dir);
      const c = streets.addCorridor(j.id, end.id, { cls: 'street', lanes: twoWay(1, 1) });
      if (dir.x === 1) setWalk(j, c.id, true, true, true);
    }
    game.roads.replace(streets);
    const walk = game.roads.graph.crosswalks.get(j.id)![0];
    const [a, b] = walk.geo.ends;
    // Человек может дойти до каждого входа только по своей дорожке.
    game.footpaths = [a, b].map((mouth, i) => {
      const curb = walk.geo.approaches![i];
      // В старом сохранении вход был на 0,25 м дальше оси тротуара, дорожка кончалась там.
      const p = connection === 'у лестницы' ? mouth : add(curb, scale(norm(sub(mouth, curb)), 0.25));
      return { id: i + 1, a: p, b: { x: p.x + 20, y: p.y } };
    });
    game.setPedestrians(true);
    let entered: typeof a | undefined;
    let emerged = false;
    let previous: typeof a | undefined;
    for (let i = 0; i < 800 && !emerged; i++) {
      game.time += 0.1;
      game.crosswalks.step(game.time, game.roads.graph, game.traffic);
      game.pedestrians.step(game);
      expect(game.pedestrians.walkers).toHaveLength(1);
      const w = game.pedestrians.walkers[0];
      const shown = [...game.pedestrians.visible(game.time)];
      if (w.edge.crossing) {
        expect(w.edge.crossing.underground).toBe(true);
        expect(shown).toHaveLength(0);
        expect(game.traffic.walks.size).toBe(0);
        if (!entered) {
          entered = w.reverse ? b : a;
          expect(dist(previous!, entered)).toBeLessThan(1);
        }
      } else {
        expect(shown).toHaveLength(1);
        previous = shown[0].pos;
        if (entered) {
          expect(dist(previous, entered === a ? b : a)).toBeLessThan(1);
          emerged = true;
        }
      }
    }
    expect(emerged).toBe(true);
  });
});

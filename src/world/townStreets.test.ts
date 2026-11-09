import { describe, expect, it } from 'vitest';
import { dist } from '../core/vec';
import { Game } from '../game/game';
import type { Town } from './entities';
import { DEFAULT_SETTINGS } from './settings';

/** Сколько улиц города сходится в каждом его узле. */
function degrees(game: Game, town: Town): Map<number, number> {
  const deg = new Map<number, number>();
  for (const id of town.streets) {
    const c = game.roads.net.corridors.get(id);
    if (!c) continue;
    for (const n of [c.a, c.b]) deg.set(n, (deg.get(n) ?? 0) + 1);
  }
  return deg;
}

describe('Улицы города — как у настоящего', { timeout: 60_000 }, () => {
  const games = [1, 2].map((seed) => new Game({ ...DEFAULT_SETTINGS, seed }));
  const towns = games.flatMap((game) => game.towns.map((town) => ({ game, town })));

  it('по seed — те же улицы', () => {
    const again = new Game({ ...DEFAULT_SETTINGS, seed: 1 });
    const shape = (g: Game) => g.towns.map((t) => t.streets.map((id) => g.roads.net.corridor(id).curve));
    expect(shape(again)).toEqual(shape(games[0]));
  });

  it('у кольцевого города кольцо — только площадь в центре: дальше улицы расходятся, а не идут кругами', () => {
    const radial = towns.filter(({ town }) => town.style === 'radial');
    expect(radial.length).toBeGreaterThan(0);
    for (const { game, town } of radial) {
      // Площадь: дуги вокруг ратуши ближе 130 м от центра.
      const square = town.streets.map((id) => game.roads.net.corridor(id)).filter((c) => [c.curve.p0, c.curve.p3].every((p) => dist(p, town.center) < 130));
      expect(square.length).toBeGreaterThanOrEqual(3);
      // Из центра — главные улицы-выезды: узлов дальше полутора сотен метров больше, чем у площади.
      const far = [...degrees(game, town).keys()].filter((id) => dist(game.roads.net.node(id).pos, town.center) > 400);
      expect(far.length).toBeGreaterThan(10);
    }
  });

  it('перекрёстки — больше Т-образные, чем кресты; есть тупики', () => {
    let tees = 0;
    let crosses = 0;
    for (const { game, town } of towns) {
      const d = [...degrees(game, town).values()];
      tees += d.filter((x) => x === 3).length;
      crosses += d.filter((x) => x >= 4).length;
      if (town.style !== 'linear') expect(d.filter((x) => x === 1).length).toBeGreaterThanOrEqual(3);
    }
    expect(tees).toBeGreaterThan(crosses * 1.5);
  });

  it('кварталы разной длины: расстояния между соседними перекрёстками не одинаковые', () => {
    for (const { game, town } of towns.filter(({ town }) => town.style !== 'linear')) {
      const lengths = town.streets.map((id) => game.roads.net.corridor(id).length);
      const mean = lengths.reduce((s, l) => s + l, 0) / lengths.length;
      const spread = Math.sqrt(lengths.reduce((s, l) => s + (l - mean) ** 2, 0) / lengths.length) / mean;
      expect(spread).toBeGreaterThan(0.1);
    }
  });

  it('улицы не ближе к чужим, чем нужно под дома с обеих сторон', () => {
    for (const { game, town } of towns) {
      const net = game.roads.net;
      const own = new Set(town.streets);
      for (const id of town.streets) {
        const c = net.corridor(id);
        const mid = c.lut.pointAt(c.length / 2);
        for (const o of net.corridorsNear(mid, 40)) {
          if (!own.has(o.id) || o.id === c.id || [o.a, o.b].some((n) => n === c.a || n === c.b)) continue;
          expect(o.lut.closest(mid).d).toBeGreaterThan(30);
        }
      }
    }
  });
});

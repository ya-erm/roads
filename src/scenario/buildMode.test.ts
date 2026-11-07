import { describe, expect, it } from 'vitest';
import { CONSTRUCTION, MONTH_LENGTH } from '../config';
import { dist } from '../core/vec';
import { Game } from '../game/game';
import { DEFAULT_SETTINGS, type WorldSettings } from '../world/settings';
import { buildReach, industryById, roadMonths, townById } from './analysis';
import { assess } from './feasibility';
import { fastMonths } from './generator';

const scenario = (seed: number, extra: Partial<WorldSettings> = {}): WorldSettings => ({
  ...DEFAULT_SETTINGS,
  ...extra,
  seed,
  scenario: { difficulty: 'normal', challenge: false },
});

describe('Сценарий «Со строительством»', () => {
  it('время стройки дороги: столько, сколько строится улица на земле с запасом на изгибы', () => {
    const instant = new Game({ ...DEFAULT_SETTINGS, seed: 3 });
    const build = new Game({ ...DEFAULT_SETTINGS, seed: 3, construction: 'build' });
    expect(roadMonths(instant, 3000)).toBe(0);
    expect(roadMonths(build, 3000)).toBeCloseTo((3000 * 1.3) / CONSTRUCTION.speed / MONTH_LENGTH, 9);
    expect(buildReach(90)).toBeCloseTo((90 * CONSTRUCTION.speed) / 1.3, 9);
  });

  it('оценка выполнимости и быстрый срок учитывают стройку дороги', () => {
    for (const seed of [5, 8]) {
      const instant = new Game(scenario(seed));
      const build = new Game(scenario(seed, { construction: 'build' }));
      const main = build.scenario!.state.objectives.find((o) => o.role === 'main' && o.phase === 0)!;
      expect(main).toBeDefined();
      const p = main.params;
      const months = 10;
      const a = assess(instant, p, months).estimate ?? 0;
      const b = assess(build, p, months).estimate ?? 0;
      // Тот же мир (рельеф и города по seed), но груз и пассажиры пойдут позже — оценка меньше.
      if (p.kind === 'deliver' || (p.kind === 'passengers' && p.towns)) expect(b).toBeLessThan(a);
      const fi = fastMonths(instant, p, 40, 'normal');
      const fb = fastMonths(build, p, 40, 'normal');
      if (fi !== null && fb !== null) expect(fb).toBeGreaterThanOrEqual(fi);
    }
  });

  it('первые задания этапа A — без долгой стройки: дорога до цели строится недолго', () => {
    /** Расстояния маршрутов главной и второй цели этапа A. */
    const routes = (game: Game): number[] =>
      game.scenario!.state.objectives
        .filter((x) => x.phase === 0 && (x.role === 'main' || x.role === 'goal'))
        .flatMap((o) => {
          const p = o.params;
          if (p.kind === 'passengers' && p.towns) {
            const [a, b] = p.towns.map((id) => townById(game, id)!);
            return [dist(a.center, b.center)];
          }
          if (p.kind === 'deliver' && p.to?.type === 'industry') {
            const to = industryById(game, p.to.id)!;
            const from = game.industries.filter((i) => i.info.produces === p.cargo).sort((x, y) => dist(x.fp.center, to.fp.center) - dist(y.fp.center, to.fp.center))[0];
            return [dist(from.fp.center, to.fp.center)];
          }
          return [];
        });
    let short = 0;
    let all = 0;
    for (const seed of [5, 8, 13, 21]) {
      const longest = Math.max(...routes(new Game(scenario(seed))));
      const game = new Game(scenario(seed, { construction: 'build' }));
      const build = routes(game);
      // Со стройкой маршруты не длиннее, чем без неё, и почти всегда — в пределах быстрой стройки.
      expect(Math.max(...build), `seed ${seed}`).toBeLessThanOrEqual(longest + 1e-6);
      all += build.length;
      short += build.filter((d) => roadMonths(game, d) * MONTH_LENGTH <= CONSTRUCTION.firstBuild + 1e-6).length;
    }
    expect(short).toBeGreaterThanOrEqual(all * 0.75);
  }, 60_000);
});

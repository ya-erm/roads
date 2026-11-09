import { describe, expect, it } from 'vitest';
import { CONSTRUCTION, MONTH_LENGTH, TERM_SCALE } from '../config';
import { dist } from '../core/vec';
import { Game } from '../game/game';
import { freshGame } from '../game/testkit';
import { DEFAULT_SETTINGS, type WorldSettings } from '../world/settings';
import { BUILD_ALLOWANCE, BUILD_SLACK, buildAllowance, buildReach, industryById, roadMonths, townById } from './analysis';
import { PHASES } from './content';
import { assess } from './feasibility';
import { fastMonths, oneBaseReaches } from './generator';

const scenario = (seed: number, extra: Partial<WorldSettings> = {}): WorldSettings => ({
  ...DEFAULT_SETTINGS,
  ...extra,
  seed,
  scenario: { difficulty: 'normal', challenge: false },
});

describe('Сценарий «Со строительством»', () => {
  it('время стройки дороги: столько, сколько строится улица на земле с запасом на изгибы', () => {
    const instant = freshGame({ ...DEFAULT_SETTINGS, seed: 3 });
    const build = freshGame({ ...DEFAULT_SETTINGS, seed: 3, construction: 'build' });
    expect(roadMonths(instant, 3000)).toBe(0);
    expect(roadMonths(build, 3000)).toBeCloseTo((3000 * 1.3) / CONSTRUCTION.speed / MONTH_LENGTH, 9);
    expect(buildReach(90)).toBeCloseTo((90 * CONSTRUCTION.speed) / 1.3, 9);
  });

  it('запас на стройку: полторы прикидки дорог по очереди, целыми минутами, от 2 до 6 мин; «Мгновенно» — без запаса', () => {
    const instant = freshGame({ ...DEFAULT_SETTINGS, seed: 3 });
    const build = freshGame({ ...DEFAULT_SETTINGS, seed: 3, construction: 'build' });
    expect(buildAllowance(instant, [525, 1786])).toBe(0);
    expect(buildAllowance(build, [])).toBe(0);
    // Короткая дорога — всё равно не меньше 2 мин: бригаде доехать, станции, машины.
    expect(buildAllowance(build, [100])).toBe(BUILD_ALLOWANCE.min);
    // 1200 м по прямой: 1200 × 1.3 / (1000 / 90) = 140 с ≈ 2.3 мин стройки → ×1.5 = 3.5 → 4 мин.
    expect(buildAllowance(build, [1200])).toBe(Math.ceil(roadMonths(build, 1200) * BUILD_SLACK));
    expect(buildAllowance(build, [1200])).toBe(4);
    // Две дороги строятся по очереди; длинные — не больше 6 мин.
    expect(buildAllowance(build, [600, 600])).toBe(buildAllowance(build, [1200]));
    expect(buildAllowance(build, [525, 1786])).toBe(BUILD_ALLOWANCE.max);
    expect(buildAllowance(build, [9000])).toBe(BUILD_ALLOWANCE.max);
  });

  it('срок целей этапа A — с запасом на стройку, а прежний срок — быстрый (⚡) у каждой цели', () => {
    for (const seed of [5, 8, 13]) {
      const instant = freshGame(scenario(seed)).scenario!.state;
      const game = freshGame(scenario(seed, { construction: 'build' }));
      const s = game.scenario!.state;
      const base = PHASES[0].months;
      const build = s.brief.build!;
      expect(build, `seed ${seed}`).toBeGreaterThanOrEqual(BUILD_ALLOWANCE.min);
      expect(build).toBeLessThanOrEqual(BUILD_ALLOWANCE.max);
      expect(s.brief.months).toBe(instant.brief.months + build);
      expect(instant.brief.build).toBeUndefined();
      const goals = s.objectives.filter((o) => o.phase === 0);
      expect(goals.length).toBeGreaterThanOrEqual(2);
      for (const o of goals) {
        expect(o.deadline, o.title).toBe(base + build);
        expect(o.months).toBe(base + build);
        // Успели к прежнему сроку — надбавка и очки за быстроту; у прибыли тоже.
        expect(o.fast, o.title).toBe(base);
      }
      // «Мгновенно» сроки прежние.
      for (const o of instant.objectives.filter((x) => x.phase === 0)) expect(o.deadline).toBe(base);
    }
  });

  it('стартовый контракт — с запасом на стройку цепочки: быстрый срок — прежний, отсчёт с принятия', () => {
    let checked = 0;
    for (const seed of [5, 8, 13]) {
      const game = freshGame(scenario(seed, { construction: 'build' }));
      const sc = game.scenario!;
      const offer = sc.state.objectives.find((o) => o.role === 'contract' && o.status === 'offered');
      if (!offer) continue;
      const base = 6 * TERM_SCALE;
      expect(offer.months!, `seed ${seed}`).toBeGreaterThanOrEqual(base + BUILD_ALLOWANCE.min);
      expect(offer.months!).toBeLessThanOrEqual(base + BUILD_ALLOWANCE.max);
      expect(offer.fastMonths).toBe(base);
      game.time = 1.5 * MONTH_LENGTH;
      expect(sc.accept(offer.id)).toBe(true);
      expect(offer.deadline).toBe(sc.month + offer.months!);
      expect(offer.fast).toBeCloseTo(1.5 + base);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('оценка выполнимости и быстрый срок учитывают стройку дороги', () => {
    for (const seed of [5, 8]) {
      const instant = freshGame(scenario(seed));
      const build = freshGame(scenario(seed, { construction: 'build' }));
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
      const longest = Math.max(...routes(freshGame(scenario(seed))));
      const game = freshGame(scenario(seed, { construction: 'build' }));
      const build = routes(game);
      // Со стройкой маршруты не длиннее, чем без неё (или строятся быстро — из коротких выбирается самая выгодная пара),
      // и почти всегда — в пределах быстрой стройки.
      expect(Math.max(...build), `seed ${seed}`).toBeLessThanOrEqual(Math.max(longest, buildReach(CONSTRUCTION.firstBuild)) + 1e-6);
      all += build.length;
      short += build.filter((d) => roadMonths(game, d) * MONTH_LENGTH <= CONSTRUCTION.firstBuild + 1e-6).length;
    }
    expect(short).toBeGreaterThanOrEqual(all * 0.75);
  }, 60_000);

  it('одна база достаёт стройки, если есть место, из радиуса которого видно хотя бы по точке каждой группы', () => {
    const R = CONSTRUCTION.serviceRadius;
    const groups = [
      [{ x: 0, y: 0 }, { x: 10 * R, y: 0 }],
      [{ x: 1.5 * R, y: 0 }],
    ];
    expect(oneBaseReaches(groups, [{ x: 0.75 * R, y: 0 }])).toBe(true);
    expect(oneBaseReaches(groups, [{ x: -0.5 * R, y: 0 }, { x: 10 * R, y: 0 }])).toBe(false);
    expect(oneBaseReaches([], [])).toBe(true);
  });

  it('стройки этапа A не достать одной базой — к капиталу цена второй базы и строка в брифинге; «Мгновенно» — без неё', () => {
    const radius = CONSTRUCTION.serviceRadius;
    const brief = (r: number, extra: Partial<WorldSettings>) => {
      CONSTRUCTION.serviceRadius = r;
      try {
        return new Game(scenario(5, extra)).scenario!.state.brief;
      } finally {
        CONSTRUCTION.serviceRadius = radius;
      }
    };
    const second = (b: { facts: string[] }) => b.facts.some((f) => f.includes('на вторую'));
    const wide = brief(1e9, { construction: 'build' });
    const narrow = brief(300, { construction: 'build' });
    expect(second(wide)).toBe(false);
    expect(second(narrow)).toBe(true);
    expect(narrow.capital).toBe(wide.capital + CONSTRUCTION.base.cost);
    expect(narrow.loan).toBe(wide.loan);
    expect(second(brief(300, {}))).toBe(false);
  }, 60_000);
});

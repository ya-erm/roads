import { describe, expect, it } from 'vitest';
import { Game } from '../game/game';
import { withoutCitizens } from '../game/testkit';
import { isRaw } from '../world/enterprise';
import { NEW_GAME_SETTINGS, type WorldSettings } from '../world/settings';
import { producible, region } from './analysis';
import { assess } from './feasibility';
import { buildTarget } from './generator';
import { builtFor, liveProgress, titleOf } from './objectives';
import type { Objective } from './types';

const scenario = (seed: number, extra: Partial<WorldSettings> = {}): WorldSettings => ({
  ...NEW_GAME_SETTINGS,
  seed,
  biome: 'temperate',
  relief: 'hills',
  scenario: { difficulty: 'normal', challenge: false },
  ...extra,
});

/** Главная цель этапа выполнена — следующий этап. */
function advance(game: Game): void {
  const sc = game.scenario!;
  const main = sc.state.objectives.filter((o) => o.phase === sc.state.phase && o.role === 'main').pop()!;
  main.status = 'done';
  expect(sc.advancePhase()).toBe(true);
}

const buildGoals = (game: Game, phase: number): Objective[] => game.scenario!.state.objectives.filter((o) => o.phase === phase && o.params.kind === 'build');

describe('сценарий «Строит игрок»', () => {
  it('этап A: кроме первой линии — цель построить предприятие (завод для добычи без сбыта или добычу для завода)', () => {
    let seen = 0;
    for (const seed of [7, 42, 101]) {
      const game = withoutCitizens(new Game(scenario(seed)));
      const sc = game.scenario!;
      expect(sc.state.objectives.some((o) => o.phase === 0 && o.role === 'main')).toBe(true);
      const goal = buildGoals(game, 0)[0];
      if (!goal) {
        expect(buildTarget(game)).toBeNull();
        continue;
      }
      seen++;
      expect(goal.role).toBe('goal');
      expect(goal.title).toMatch(/^Построить /);
      expect(goal.reward.money).toBeGreaterThan(0);
      expect(assess(game, goal.params, 10).ok).toBe(true);
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('груз «можно получить», если его можно построить: месторождения и заводы биома', () => {
    const game = withoutCitizens(new Game(scenario(7)));
    // Пиломатериалов на старте может не быть — но лесные участки есть, лесопилку можно построить.
    expect(game.enterprises.deposits.some((d) => d.kind === 'forest')).toBe(true);
    expect(producible(game, 'planks')).toBe(true);
    expect(region(game).compactChains).toBeGreaterThan(2);
  });

  it('прогресс «построить»: известные на выдаче не в счёт, новое — в счёт; «и выпустить» — по выпуску нового', () => {
    const game = withoutCitizens(new Game(scenario(7)));
    const sc = game.scenario!;
    const d = game.enterprises.deposits.find((x) => x.used === undefined)!;
    const kind = d.kind;
    const cargo = game.enterprises.kinds().find((k) => k.kind === kind)!.produces;
    const params = { kind: 'build' as const, count: 1, what: kind, cargo, known: game.industries.map((i) => i.id) };
    const o = sc.addObjective(params, { role: 'goal', phase: 0, months: 10, why: '', reward: {} });
    expect(liveProgress(o, sc.state, game)).toBe(0);
    game.money = 5_000_000;
    expect(game.enterprises.build(kind, d.center)).toBeNull();
    expect(liveProgress(o, sc.state, game)).toBe(1);
    expect(titleOf(params, game)).toMatch(/^Построить /);
    const made = sc.addObjective({ ...params, produce: 50, known: [] }, { role: 'goal', phase: 0, months: 10, why: '', reward: {} });
    const ind = builtFor(game, made.params as typeof params)[0];
    ind.made = 30;
    expect(liveProgress(made, sc.state, game)).toBeGreaterThanOrEqual(30);
  });

  it('этапы B и C подталкивают строить: своя новая цепочка, «построить N предприятий» вместо «подключить»', () => {
    const game = withoutCitizens(new Game(scenario(42)));
    advance(game);
    const b = game.scenario!.state.objectives.filter((o) => o.phase === 1);
    expect(b.some((o) => o.params.kind === 'build' && o.params.produce)).toBe(true);
    advance(game);
    const c = game.scenario!.state.objectives.filter((o) => o.phase === 2);
    expect(c.some((o) => o.params.kind === 'build' && !o.params.cargo)).toBe(true);
    expect(c.some((o) => o.params.kind === 'connect' && o.params.what === 'industry')).toBe(false);
    for (const o of [...b, ...c]) expect(assess(game, o.params, 14).ok, o.title).toBe(true);
  });

  it('«построить» не выдаётся, если вида нет или нет свободных месторождений', () => {
    const game = withoutCitizens(new Game(scenario(7)));
    const raw = game.enterprises.kinds().find(isRaw)!;
    for (const d of game.enterprises.deposits) if (d.kind === raw.kind) d.used = -1;
    expect(assess(game, { kind: 'build', count: 1, what: raw.kind, known: [] }, 10).ok).toBe(false);
    expect(assess(game, { kind: 'build', count: 1, what: 'gemcutter', known: [] }, 10).ok).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { Game } from '../game/game';
import { BASE_TOWN_CARGO, EXTRA_TOWN_CARGO } from './cargo';
import type { Town } from './entities';
import { assignExtraDemands, EXTRA_DEMAND_POPULATION } from './worldgen';

const town = (id: number, population: number, demands: Town['demands']) => ({ id, population, demands }) as Town;

describe('Потребности городов', () => {
  it('крупные города просят ещё стекло или мебель — поровну, мелкие — нет', () => {
    const towns = [
      town(1, 9000, ['food', 'goods', 'fuel']),
      town(2, 6000, ['fuel', 'construction', 'food']),
      town(3, 4500, ['goods', 'construction', 'fuel']),
      town(4, 3000, ['food', 'goods', 'fuel']),
      town(5, 1200, ['food', 'goods']),
    ];
    assignExtraDemands(towns);
    expect(towns.map((t) => t.demands.filter((c) => EXTRA_TOWN_CARGO.includes(c)))).toEqual([['glass'], ['furniture'], ['glass'], [], []]);
  });

  it('каждый новый груз нужен хотя бы одному городу, даже если крупных нет', () => {
    const towns = [town(1, 1500, ['food', 'goods']), town(2, 900, ['fuel', 'construction'])];
    assignExtraDemands(towns);
    for (const c of EXTRA_TOWN_CARGO) expect(towns.some((t) => t.demands.includes(c)), c).toBe(true);
  });

  it('в мире по seed основные потребности те же, новые — у городов покрупнее', () => {
    for (const seed of [1, 42]) {
      const game = new Game(seed);
      for (const c of EXTRA_TOWN_CARGO) expect(game.towns.some((t) => t.demands.includes(c)), `${seed}: ${c}`).toBe(true);
      for (const t of game.towns) {
        const base = t.demands.filter((c) => BASE_TOWN_CARGO.includes(c));
        expect(base.length, t.name).toBeGreaterThanOrEqual(2);
        if (t.population > EXTRA_DEMAND_POPULATION) expect(t.demands.length, t.name).toBe(base.length + 1);
      }
    }
  });
});

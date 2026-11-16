import { describe, expect, it } from 'vitest';
import { rescalePopulation } from './objectives';
import type { Objective, ScenarioState } from './types';

describe('Старое сохранение: население пересчитано — цели сценария в той же доле', () => {
  it('цель «население города» и отметка роста на старте — в доле нового населения к прежнему; прочие цели не трогаются', () => {
    const pop = { id: 7, kind: 'population' as const };
    const objective = (params: Objective['params'], base: number, progress: number, target: number) => ({ params, base, progress, target }) as unknown as Objective;
    const state = {
      start: { population: 20_000, levels: 0 },
      objectives: [objective({ kind: pop.kind, town: pop.id, amount: 3000 }, 2000, 2400, 3000), objective({ kind: 'passengers', amount: 500, towns: null }, 10, 100, 500)],
    } as unknown as ScenarioState;
    // Село 7: было 2000 жителей — стало 600; второй город не пересчитывали.
    rescalePopulation(state, [{ id: 7, population: 600 }, { id: 8, population: 18_000 }], new Map([[7, 2000]]));
    const [p, pax] = state.objectives;
    expect(p.params).toEqual({ kind: 'population', town: 7, amount: 900 });
    expect(p.base).toBe(600);
    expect(p.target).toBe(900);
    expect(p.progress).toBe(720);
    // Прогресс — та же доля пути к цели.
    expect((p.progress - p.base) / (p.target - p.base)).toBeCloseTo((2400 - 2000) / (3000 - 2000));
    expect(pax.params).toEqual({ kind: 'passengers', amount: 500, towns: null });
    expect([pax.base, pax.progress, pax.target]).toEqual([10, 100, 500]);
    // Мир: было 20 000 (2000 + 18 000) — стало 18 600.
    expect(state.start.population).toBe(18_600);
  });
});

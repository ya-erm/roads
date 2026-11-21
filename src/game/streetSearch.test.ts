import { describe, expect, it } from 'vitest';
import { MONTH_LENGTH, SIM_DT } from '../config';
import type { Rng } from '../core/rng';
import type { Town } from '../world/entities';
import { Game, type SaveData } from './game';
import { freshGame, withoutCitizens } from './testkit';

const setup = { seed: 7, size: 'small', towns: 1, industries: 'few', money: 5_000_000, water: 'dry' } as const;
const dayLength = MONTH_LENGTH / 30;

function growingTown(): Game {
  const game = withoutCitizens(freshGame(setup));
  expect(game.towns).toHaveLength(1);
  game.towns[0].growthAcc = 1400;
  return game;
}

function advance(game: Game, ticks: number, speed = 1): void {
  game.speed = speed;
  // И при 1×, и при 4× сравниваем состояние на одном и том же игровом такте.
  for (let i = 0; i < ticks; i += speed) {
    game.update(Math.min(speed, ticks - i) * SIM_DT / speed);
  }
}

function restore(game: Game): Game {
  const save: SaveData = JSON.parse(JSON.stringify(game.toSave()));
  return withoutCitizens(new Game(save.settings, save));
}

function recordSearch(game: Game) {
  const observed = game as unknown as { streetCandidates(town: Town, reach: number, rng: Rng, day?: number): unknown[] };
  const search = observed.streetCandidates.bind(game);
  const calls: { day?: number; time: number; closing: boolean; checks: number }[] = [];
  observed.streetCandidates = (town, reach, rng, day) => {
    const call = { day, time: game.time, closing: game.monthClosing, checks: 0 };
    const at = game.index.at;
    calls.push(call);
    game.index.at = (p, margin) => {
      call.checks++;
      return at.call(game.index, p, margin);
    };
    try { return search(town, reach, rng, day); } finally { game.index.at = at; }
  };
  return calls;
}

describe('Поиск места под городские улицы', () => {
  it('распределяет поиск одного города по игровым дням до закрытия месяца', () => {
    const game = growingTown();
    const calls = recordSearch(game);
    const roads = game.roads.net.corridors.size;
    advance(game, Math.round((MONTH_LENGTH - dayLength / 2) / SIM_DT));
    expect(game.roads.net.corridors.size).toBe(roads);
    const earlyDays = new Set(calls.filter(c => c.checks > 0).map(c => Math.floor(c.time / dayLength)));
    expect(earlyDays.size).toBeGreaterThanOrEqual(24);
    expect(earlyDays.has(0)).toBe(true);
    expect([...earlyDays].some(day => day >= 27)).toBe(true);
    const totalChecks = calls.reduce((sum, c) => sum + c.checks, 0);
    expect(Math.max(...calls.map(c => c.checks))).toBeLessThan(totalChecks / 4);
    advance(game, Math.round(dayLength / SIM_DT));
    expect(game.monthIndex).toBe(1);
    expect(calls.some(c => c.closing || c.day === undefined)).toBe(false);
  });

  it('сохраняет незавершённый поиск, останавливает его на паузе и продолжает на высокой скорости', () => {
    const game = growingTown();
    const halfway = Math.round(MONTH_LENGTH / (2 * SIM_DT));
    advance(game, halfway);
    const plan = structuredClone(game.towns[0].streetSearch);
    expect(plan).toBeDefined();
    const loaded = restore(game);
    expect(loaded.towns[0].streetSearch).toEqual(plan);
    const calls = recordSearch(loaded);
    loaded.speed = 0;
    for (let i = 0; i < 90; i++) loaded.update(0.1);
    expect(calls).toHaveLength(0);
    expect(loaded.towns[0].streetSearch).toEqual(plan);
    advance(game, halfway - 8);
    advance(loaded, halfway - 8, 4);
    expect(loaded.towns[0].streetSearch).toEqual(game.towns[0].streetSearch);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(c => c.day !== undefined && c.day > plan!.day)).toBe(true);
    advance(game, 16);
    advance(loaded, 16, 4);
    expect(loaded.roads.net.toJSON().corridors).toEqual(game.roads.net.toJSON().corridors);
  });

  it('старое сохранение в конце месяца начинает с текущего дня и не наверстывает пропущенные дни', () => {
    const game = growingTown();
    game.time = MONTH_LENGTH - dayLength / 2;
    const save: SaveData = JSON.parse(JSON.stringify(game.toSave()));
    delete save.towns[0].streetSearch;
    const loaded = withoutCitizens(new Game(save.settings, save));
    const calls = recordSearch(loaded);
    advance(loaded, Math.round(2 * dayLength / SIM_DT), 4);
    expect(calls.filter(c => c.time < MONTH_LENGTH).map(c => c.day)).toEqual([29]);
    expect(calls.some(c => c.closing || c.day === undefined)).toBe(false);
    expect(loaded.towns[0].streetSearch?.month).toBe(1);
  });

  it('повторно проверяет точки примыкания, если игрок снёс дорогу после дневного поиска', () => {
    const game = growingTown();
    advance(game, Math.round((MONTH_LENGTH - dayLength / 2) / SIM_DT));
    const town = game.towns[0];
    const plan = town.streetSearch!;
    const candidate = plan.candidates[0];
    expect(candidate).toBeDefined();
    const start = candidate.start;
    const removed = start.kind === 'node' ? [...game.roads.net.node(start.node).corridors]
      : start.kind === 'corridor' ? [start.corridor] : [];
    expect(removed.length).toBeGreaterThan(0);
    expect(game.roadBuilder.apply(game.roadBuilder.bulldoze(removed))).toBe(true);
    // Только устаревший вариант: месяц не должен строить другую улицу за счёт нового полного обхода.
    plan.candidates = [candidate];
    const afterEdit = new Set(game.roads.net.corridors.keys());
    advance(game, Math.round(dayLength / SIM_DT));
    expect(game.monthIndex).toBe(1);
    expect(new Set(game.roads.net.corridors.keys())).toEqual(afterEdit);
  });
});

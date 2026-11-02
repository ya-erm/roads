import { describe, expect, it } from 'vitest';
import { MONTH_LENGTH } from '../config';
import { TOWN_HISTORY, TOWN_NEED } from '../world/entities';
import { Game, SaveData } from './game';

/** Закрывает текущий месяц настоящим шагом игры: время — к самой границе месяца. */
function closeMonth(game: Game): void {
  game.speed = 1;
  game.time = (Math.floor(game.time / MONTH_LENGTH) + 1) * MONTH_LENGTH - 1e-3;
  game.update(0.1);
}

const reload = (save: SaveData) => new Game(save.settings, save);
const roundTrip = (game: Game) => JSON.parse(JSON.stringify(game.toSave())) as SaveData;

describe('Снабжение города по месяцам', { timeout: 60_000 }, () => {
  it('итоги каждого месяца пишутся в историю города: привезено по каждому грузу и норма', () => {
    const game = new Game(7);
    const town = game.towns.find((t) => t.demands.length >= 2)!;
    const [a, b] = town.demands;
    expect(town.supplyHistory ?? []).toEqual([]);

    const first = game.dateLabel;
    town.supplied[a] = 12;
    closeMonth(game);
    const second = game.dateLabel;
    expect(second).not.toBe(first);
    town.supplied[b] = 4;
    closeMonth(game);

    expect(town.supplyHistory).toHaveLength(2);
    const [m1, m2] = town.supplyHistory!;
    expect(m1.label).toBe(first);
    expect(m1.need).toBe(TOWN_NEED);
    // Не привезли — ноль, а не пропуск: у каждого нужного груза свой столбик.
    expect(m1.got).toEqual({ ...Object.fromEntries(town.demands.map((c) => [c, 0])), [a]: 12 });
    expect(m2.label).toBe(second);
    expect(m2.got[a]).toBe(0);
    expect(m2.got[b]).toBe(4);
    // «В прошлом месяце» и «в этом» сдвигаются как раньше.
    expect(town.lastSupplied[b]).toBe(4);
    expect(town.supplied).toEqual({});
  });

  it(`история хранит только последние ${TOWN_HISTORY} месяцев`, () => {
    const game = new Game(7);
    const town = game.towns[0];
    const c = town.demands[0];
    const labels: string[] = [];
    for (let m = 0; m < TOWN_HISTORY + 3; m++) {
      labels.push(game.dateLabel);
      town.supplied[c] = m + 1;
      closeMonth(game);
    }
    expect(town.supplyHistory).toHaveLength(TOWN_HISTORY);
    expect(town.supplyHistory!.map((h) => h.label)).toEqual(labels.slice(-TOWN_HISTORY));
    expect(town.supplyHistory!.map((h) => h.got[c])).toEqual(labels.map((_, i) => i + 1).slice(-TOWN_HISTORY));
  });

  it('история переживает сохранение и загрузку и дальше пополняется', () => {
    const game = new Game(7);
    for (let m = 0; m < 3; m++) {
      for (const t of game.towns) t.supplied[t.demands[0]] = 5 * (m + 1);
      closeMonth(game);
    }
    const loaded = reload(roundTrip(game));
    expect(loaded.towns.map((t) => t.supplyHistory)).toEqual(game.towns.map((t) => t.supplyHistory));
    expect(loaded.towns[0].supplyHistory).toHaveLength(3);
    closeMonth(loaded);
    expect(loaded.towns[0].supplyHistory).toHaveLength(4);
  });

  it('старое сохранение без истории грузится: история пустая и начинается со следующего месяца', () => {
    const game = new Game(7);
    closeMonth(game);
    const save = roundTrip(game);
    for (const t of save.towns) delete t.supplyHistory;
    const loaded = reload(save);
    expect(loaded.towns.length).toBe(game.towns.length);
    for (const t of loaded.towns) expect(t.supplyHistory).toBeUndefined();
    const town = loaded.towns[0];
    const label = loaded.dateLabel;
    town.supplied[town.demands[0]] = 7;
    closeMonth(loaded);
    expect(town.supplyHistory).toEqual([
      { label, got: { ...Object.fromEntries(town.demands.map((c) => [c, 0])), [town.demands[0]]: 7 }, need: TOWN_NEED },
    ]);
  });
});

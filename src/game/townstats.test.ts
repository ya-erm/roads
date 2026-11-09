import { describe, expect, it } from 'vitest';
import { MONTH_LENGTH } from '../config';
import { TOWN_HISTORY, TOWN_NEED } from '../world/entities';
import { townNeed } from '../world/townSupply';
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
    // Норма месяца — по населению на его конце (город растёт уже после итогов).
    const need1 = townNeed(town.population);
    closeMonth(game);
    const second = game.dateLabel;
    expect(second).not.toBe(first);
    town.supplied[b] = 4;
    const need2 = townNeed(town.population);
    closeMonth(game);

    expect(town.supplyHistory).toHaveLength(2);
    const [m1, m2] = town.supplyHistory!;
    expect(m1.label).toBe(first);
    expect(m1.need).toBe(need1);
    expect(m2.need).toBe(need2);
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

  it('излишек сверх нормы засчитывается следующему месяцу (не больше нормы) и виден в истории и после загрузки', () => {
    const game = new Game(7);
    const town = game.towns.find((t) => t.demands.length >= 2)!;
    const [a, b] = town.demands;
    const n1 = townNeed(town.population);
    town.supplied[a] = n1 + 5;
    town.supplied[b] = n1 * 4;
    // Без роста: норма нового месяца — та же n1 (иначе выросший город просит больше).
    town.growthAcc = -1e9;
    closeMonth(game);
    // Новый месяц начинается с излишков: по a — 5, по b — не больше нормы.
    expect(town.supplied).toEqual({ [a]: 5, [b]: n1 });
    expect(town.carried).toEqual({ [a]: 5, [b]: n1 });
    expect(game.townSatisfaction(town, 'current')).toBeGreaterThan(0);
    expect(town.supplyHistory![0].carried).toBeUndefined();

    const loaded = reload(roundTrip(game));
    const t2 = loaded.towns.find((t) => t.id === town.id)!;
    expect(t2.carried).toEqual(town.carried);
    // Город вырос — норма нового месяца не меньше прежней.
    const n2 = townNeed(t2.population);
    expect(n2).toBeGreaterThanOrEqual(n1);
    t2.supplied[a] = (t2.supplied[a] ?? 0) + n2 - 3;
    closeMonth(loaded);
    const month = t2.supplyHistory![t2.supplyHistory!.length - 1];
    // Месяц закрыт вместе с перенесённым: 5 из прошлого + (n2 − 3) = n2 + 2 ≥ нормы; по b — перенесённая норма прошлого.
    expect(month.need).toBe(n2);
    expect(month.got[a]).toBe(n2 + 2);
    expect(month.got[b]).toBe(n1);
    expect(month.carried).toEqual({ [a]: 5, [b]: n1 });
    expect(t2.lastSupplied[a]).toBe(n2 + 2);
    expect(t2.supplied).toEqual({ [a]: 2 });
    expect(t2.carried).toEqual({ [a]: 2 });
  });

  it('крупному городу базовой нормы мало: месяц закрывает только норма по его населению', () => {
    const game = new Game(7);
    const big = [...game.towns].sort((x, y) => y.population - x.population)[0];
    const small = [...game.towns].sort((x, y) => x.population - y.population)[0];
    expect(big.population).toBeGreaterThan(10_000);
    const need = townNeed(big.population);
    expect(need).toBeGreaterThanOrEqual(3 * TOWN_NEED);
    for (const c of big.demands) big.supplied[c] = TOWN_NEED;
    for (const c of small.demands) small.supplied[c] = TOWN_NEED;
    closeMonth(game);
    // Те же 15 единиц: маленький город снабжён, крупный — нет; норма месяца — в истории.
    expect(big.supplyHistory!.at(-1)!.need).toBe(need);
    expect(game.townSatisfaction(big)).toBe(0);
    expect(game.townSatisfaction(small)).toBe(1);
    expect(game.townReviews(big).at(-1)!.mood).toBe('bad');

    for (const c of big.demands) big.supplied[c] = townNeed(big.population);
    closeMonth(game);
    expect(game.townSatisfaction(big)).toBe(1);
    expect(game.townReviews(big).at(-1)!.mood).toBe('good');
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
    const need = townNeed(town.population);
    closeMonth(loaded);
    expect(town.supplyHistory).toEqual([
      { label, got: { ...Object.fromEntries(town.demands.map((c) => [c, 0])), [town.demands[0]]: 7 }, need },
    ]);
  });
});

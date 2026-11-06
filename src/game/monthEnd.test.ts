import { describe, expect, it } from 'vitest';
import { MONTH_LENGTH, SIM_DT } from '../config';
import { Game, type SaveData } from './game';
import { corridorCost } from './roadbuild';
import { road } from './testkit';

const world = () => new Game({ seed: 7, size: 'small', towns: 3, industries: 'few', money: 5_000_000, water: 'dry' });

/** Сохранение без отметки времени записи — для сравнения партий. */
const saveText = (g: Game) => JSON.stringify({ ...g.toSave(), savedAt: 0 });
/** Машины на дорогах: где и на какой полосе — до бита. */
const carsText = (g: Game) =>
  JSON.stringify([...(g.roads.traffic as unknown as { vehicles: Map<number, { id: number; pos: unknown; lane: number; s: number; v: number }> }).vehicles.values()].map((v) => [v.id, v.pos, v.lane, v.s, v.v]));

/**
 * Партия до конца второго месяца такт за тактом (кадр — один такт). Перед первой сменой месяца городам есть из
 * чего расти: они прокладывают несколько улиц, и машины жителей переезжают на новый граф не раз.
 * budget — Game.monthBudget; immediate — как было: граф после каждой улицы сразу, внутри стройки.
 */
function play(budget: number, immediate = false) {
  const g = world();
  g.monthBudget = budget;
  if (immediate) (g.roads as unknown as { quiet: (fn: () => unknown) => unknown }).quiet = (fn) => fn();
  const traffic = g.roads.traffic;
  const rebind = traffic.rebind.bind(traffic);
  let rebinds = 0;
  traffic.rebind = (graph) => {
    rebinds++;
    rebind(graph);
  };
  g.speed = 1;
  g.time = MONTH_LENGTH - 15;
  for (const t of g.towns) t.growthAcc = 400;
  let closingFrames = 0;
  let maxRebinds = 0;
  let updates = 0;
  while (g.time < 2 * MONTH_LENGTH + 1) {
    rebinds = 0;
    g.update(SIM_DT);
    updates++;
    if (g.monthClosing) closingFrames++;
    maxRebinds = Math.max(maxRebinds, rebinds);
  }
  return { save: saveText(g), cars: carsText(g), closingFrames, maxRebinds, updates, month: g.monthIndex, cars0: g.citizenCars };
}

describe('Итоги месяца по кадрам', { timeout: 120_000 }, () => {
  it('те же числа: целиком, по шагам и как было (граф сразу после каждой улицы) — партия и машины до бита', () => {
    const before = play(Infinity, true);
    const whole = play(Infinity);
    const sliced = play(0);
    expect(before.month).toBe(2);
    expect(before.cars0).toBeGreaterThan(0);
    // Города проложили несколько улиц: машины переезжали на новый граф больше одного раза за смену месяца.
    expect(before.maxRebinds).toBeGreaterThanOrEqual(2);
    expect(whole.save).toBe(before.save);
    expect(whole.cars).toBe(before.cars);
    expect(sliced.save).toBe(whole.save);
    expect(sliced.cars).toBe(whole.cars);
    // Целиком — в том же кадре; по шагам — несколько кадров, и в каждом не больше одного переезда машин.
    expect(whole.closingFrames).toBe(0);
    expect(sliced.closingFrames).toBeGreaterThan(5);
    expect(sliced.maxRebinds).toBe(1);
  });

  it('пока итоги идут, время партии стоит; сохранение подводит их до конца, и после загрузки они не повторяются', () => {
    const g = world();
    g.monthBudget = 0;
    const ended: number[] = [];
    g.onMonthEnd = () => ended.push(g.monthIndex);
    g.speed = 1;
    g.time = MONTH_LENGTH - 1;
    while (!g.monthClosing) g.update(SIM_DT);
    const t = g.time;
    g.update(SIM_DT);
    g.update(SIM_DT);
    expect(g.time).toBe(t);
    expect(g.monthClosing).toBe(true);
    expect(g.monthIndex).toBe(0);
    expect(ended).toEqual([]);
    // На паузе итоги тоже идут — незаконченными не остаются.
    g.speed = 0;
    let n = 0;
    while (g.monthClosing && n++ < 1000) g.update(SIM_DT);
    expect(g.monthClosing).toBe(false);
    expect(g.monthIndex).toBe(1);
    expect(ended).toEqual([1]);

    // Сохранение посреди итогов: сначала они до конца.
    const h = world();
    h.monthBudget = 0;
    h.speed = 1;
    h.time = MONTH_LENGTH - 1;
    while (!h.monthClosing) h.update(SIM_DT);
    const save = JSON.parse(JSON.stringify(h.toSave())) as SaveData;
    expect(h.monthClosing).toBe(false);
    expect(save.month).toBe(1);
    expect(save.history).toHaveLength(1);
    const loaded = new Game(save.settings, save);
    loaded.speed = 1;
    loaded.update(0.1);
    expect(loaded.history).toHaveLength(1);
  });

  it('автосохранение (onMonthEnd) — уже с новым месяцем: загрузка его итоги месяца не повторяет', () => {
    const g = world();
    let saved: SaveData | null = null;
    g.onMonthEnd = () => (saved = JSON.parse(JSON.stringify(g.toSave())) as SaveData);
    g.speed = 1;
    g.time = MONTH_LENGTH - 1;
    while (!saved) g.update(SIM_DT);
    const save = saved as SaveData;
    expect(save.month).toBe(1);
    const loaded = new Game(save.settings, save);
    const money = loaded.money;
    loaded.speed = 1;
    loaded.update(0.1);
    expect(loaded.history).toHaveLength(1);
    expect(loaded.monthIndex).toBe(1);
    expect(loaded.money).toBeGreaterThanOrEqual(money);
  });

  it('стоимость дорог для ремонта — та же, что подряд по всем полотнам: после стройки и роста городов', () => {
    const g = world();
    const brute = () => {
      let total = 0;
      for (const s of g.net.segments.values()) total += g.builder.segmentCost(s);
      for (const c of g.roads.net.corridors.values()) total += corridorCost(g.roads.net, c, (p, m) => g.isWater(p, m), g.ground());
      return total;
    };
    expect(g.roadValueTotal()).toBe(brute());
    const town = g.towns[0];
    const from = { x: town.center.x + town.radius + 150, y: town.center.y };
    expect(road(g, { free: from }, { free: { x: from.x + 300, y: from.y + 40 } })).toBe(true);
    expect(g.roadValueTotal()).toBe(brute());
    for (const t of g.towns) t.growthAcc = 400;
    g.speed = 1;
    g.time = MONTH_LENGTH - 1;
    while (g.monthIndex < 1) g.update(SIM_DT);
    expect(g.roadValueTotal()).toBe(brute());
  });
});

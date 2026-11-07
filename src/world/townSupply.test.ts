import { describe, expect, it } from 'vitest';
import { TOWN_NEED } from './entities';
import { closeSupply, lastTownNeed, monthTownNeed, supplyCarry, townNeed } from './townSupply';

describe('Перенос излишков снабжения города', () => {
  it('сверх нормы — в следующий месяц', () => {
    expect(supplyCarry(22, 15)).toBe(7);
    expect(supplyCarry(16, 15)).toBe(1);
  });

  it('не дотянули до нормы или ровно норма — переносить нечего', () => {
    expect(supplyCarry(15, 15)).toBe(0);
    expect(supplyCarry(9, 15)).toBe(0);
    expect(supplyCarry(0, 15)).toBe(0);
  });

  it('большая поставка закрывает только следующий месяц: переносится не больше нормы', () => {
    expect(supplyCarry(100, 15)).toBe(15);
    expect(supplyCarry(30, 15)).toBe(15);
  });

  it('итог месяца — по каждому нужному грузу (0 — не привезли), излишки — только где они есть', () => {
    const { got, carry } = closeSupply(['food', 'goods', 'fuel'], { food: 20, goods: 12 }, 15);
    expect(got).toEqual({ food: 20, goods: 12, fuel: 0 });
    expect(carry).toEqual({ food: 5 });
  });

  it('грузы, которые городу не нужны, в итог не попадают', () => {
    const { got, carry } = closeSupply(['food'], { food: 15, coal: 40 }, 15);
    expect(got).toEqual({ food: 15 });
    expect(carry).toEqual({});
  });

  it('рейс раз в полтора месяца: с переносом каждый месяц закрыт, без него — через раз', () => {
    // 24 ед. каждые 1,5 месяца — 16 в месяц при норме 15: возят достаточно, но не каждый месяц.
    const arrivals = [24, 0, 24, 24, 0, 24, 24, 0];
    let carried = 0;
    const closed = arrivals.map((got) => {
      const total = carried + got;
      carried = supplyCarry(total, 15);
      return total >= 15;
    });
    expect(closed.filter(Boolean).length).toBeGreaterThan(arrivals.filter((g) => g >= 15).length);
    expect(closed.slice(0, 3)).toEqual([true, false, true]);
  });
});

describe('Норма города растёт с населением', () => {
  it('до 2000 жителей — базовая, дальше — ещё одна базовая на каждые 4000, круглыми пятёрками', () => {
    expect(TOWN_NEED).toBe(15);
    expect(townNeed(0)).toBe(15);
    expect(townNeed(1200)).toBe(15);
    expect(townNeed(2000)).toBe(15);
    expect(townNeed(4000)).toBe(25);
    expect(townNeed(6000)).toBe(30);
    expect(townNeed(10_000)).toBe(45);
    expect(townNeed(14_000)).toBe(60);
  });

  it('растёт без скачков вниз и без взрыва: вдвое больше жителей — не больше чем вдвое больше нормы', () => {
    let prev = 0;
    for (let pop = 0; pop <= 40_000; pop += 50) {
      const n = townNeed(pop);
      expect(n % 5, `${pop}`).toBe(0);
      expect(n, `${pop}`).toBeGreaterThanOrEqual(prev);
      if (pop >= 2000) expect(townNeed(pop * 2), `${pop}`).toBeLessThanOrEqual(n * 2 + 5);
      prev = n;
    }
  });

  it('прошлый месяц — со своей нормой из истории, а без истории — по нынешнему населению', () => {
    const month = (need: number) => ({ label: 'Май 2000', got: {}, need });
    expect(lastTownNeed({ population: 10_000, supplyHistory: [month(15), month(30)] })).toBe(30);
    expect(lastTownNeed({ population: 10_000 })).toBe(45);
    expect(monthTownNeed({ population: 10_000, supplyHistory: [month(30)] }, 'last')).toBe(30);
    expect(monthTownNeed({ population: 10_000, supplyHistory: [month(30)] }, 'current')).toBe(45);
  });
});

import { describe, expect, it } from 'vitest';
import { closeSupply, supplyCarry } from './townSupply';

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

import { describe, expect, it } from 'vitest';
import { playRate, TL_MIN_SECONDS, TL_SPEEDS } from './timelapseSpeed';

/** Прежний ход на 1× (до замедления): 4 месяца в секунду, вся партия не короче 6 с. */
const before = (span: number) => Math.min(4, Math.max(0.05, span / 6));

describe('Скорость таймлапса', () => {
  it('кнопки 1×, 2×, 3×', () => {
    expect(TL_SPEEDS).toEqual([1, 2, 3]);
  });

  it('вдвое медленнее прежнего: 1× — половина прежней 1×, 2× — прежняя 1×, 3× — прежняя 1,5×', () => {
    for (const span of [0.3, 1, 5, 12, 24, 60, 240]) {
      expect(playRate(span, 1)).toBeCloseTo(before(span) * 0.5, 9);
      expect(playRate(span, 2)).toBeCloseTo(before(span), 9);
      expect(playRate(span, 3)).toBeCloseTo(before(span) * 1.5, 9);
    }
  });

  it('длинная партия на 1× — 2 месяца в секунду: 10 лет за минуту', () => {
    expect(playRate(120, 1)).toBe(2);
    expect(120 / playRate(120, 1)).toBe(60);
    expect(120 / playRate(120, 3)).toBe(20);
  });

  it('короткая партия на 1× идёт не меньше TL_MIN_SECONDS', () => {
    for (const span of [1, 6, 12, 23]) expect(span / playRate(span, 1)).toBeCloseTo(TL_MIN_SECONDS, 9);
    expect(TL_MIN_SECONDS).toBe(12);
  });
});

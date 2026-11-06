import { describe, expect, it } from 'vitest';
import { MONTH_LENGTH } from '../config';
import { playRate, TL_MIN_SECONDS, TL_SPEEDS } from './timelapseSpeed';

/** Минут игры за секунду таймлапса на этой скорости и при этой длине партии (в месяцах). */
const minutesPerSecond = (span: number, speed: number) => (playRate(span, speed) * MONTH_LENGTH) / 60;

describe('Скорость таймлапса', () => {
  it('кнопки 1×, 2×, 3×', () => {
    expect(TL_SPEEDS).toEqual([1, 2, 3]);
  });

  it('длинная партия на 1× — 4 минуты игры в секунду (как 2 месяца по 2 минуты): 4 часа игры — за минуту', () => {
    const months = (4 * 60 * 60) / MONTH_LENGTH;
    expect(minutesPerSecond(months, 1)).toBeCloseTo(4, 9);
    expect(months / playRate(months, 1)).toBeCloseTo(60, 9);
    expect(months / playRate(months, 3)).toBeCloseTo(20, 9);
  });

  it('2× и 3× — вдвое и втрое быстрее 1×', () => {
    for (const span of [0.3, 1, 5, 12, 24, 60, 240, 480]) {
      expect(playRate(span, 2)).toBeCloseTo(playRate(span, 1) * 2, 9);
      expect(playRate(span, 3)).toBeCloseTo(playRate(span, 1) * 3, 9);
    }
  });

  it('короткая партия на 1× идёт не меньше TL_MIN_SECONDS', () => {
    for (const span of [1, 6, 12, 23, 47]) expect(span / playRate(span, 1)).toBeCloseTo(TL_MIN_SECONDS, 9);
    expect(TL_MIN_SECONDS).toBe(12);
  });
});

import { describe, expect, it } from 'vitest';
import { MONTH_LENGTH } from '../config';
import { monthsText, travelMonths, travelTimeText } from './travelTime';

describe('время в пути', () => {
  it('секунды симуляции переводятся в игровые месяцы', () => {
    expect(travelMonths(MONTH_LENGTH)).toBe(1);
    expect(travelMonths(MONTH_LENGTH / 2)).toBe(0.5);
    expect(travelMonths(-5)).toBe(0);
  });

  it('месяцы: до 10 — с одним знаком после запятой, от 10 — целыми', () => {
    expect(monthsText(MONTH_LENGTH * 0.42)).toBe('0,4 мес.');
    expect(monthsText(MONTH_LENGTH * 2.46)).toBe('2,5 мес.');
    expect(monthsText(MONTH_LENGTH * 3)).toBe('3 мес.');
    expect(monthsText(MONTH_LENGTH * 12.4)).toBe('12 мес.');
  });

  it('совсем короткий путь — «меньше 0,1 месяца», а не ноль', () => {
    expect(monthsText(1)).toBe('< 0,1 мес.');
    expect(monthsText(0)).toBe('< 0,1 мес.');
  });

  it('сначала целые секунды, в скобках — месяцы', () => {
    expect(travelTimeText(MONTH_LENGTH * 0.8)).toBe('96 с (0,8 мес.)');
    expect(travelTimeText(128.6)).toBe(`129 с (${monthsText(128.6)})`);
    expect(travelTimeText(5)).toBe('5 с (< 0,1 мес.)');
  });

  it('большие числа секунд — с разделителем разрядов', () => {
    expect(travelTimeText(MONTH_LENGTH * 12.4)).toBe(`${(MONTH_LENGTH * 12.4).toLocaleString('ru-RU')} с (12 мес.)`);
  });
});

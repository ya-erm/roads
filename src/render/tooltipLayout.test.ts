import { describe, expect, it } from 'vitest';
import { TOOLTIP_MAX_PX, tooltipOffset, wrapLines } from './tooltipLayout';

/** Как ширина текста шрифтом 13 px — по 7 px на символ. */
const measure = (s: string) => s.length * 7;

describe('Подсказка на карте: перенос строк', () => {
  it('короткая — одной строкой, как есть', () => {
    expect(wrapLines('Станция-2', TOOLTIP_MAX_PX, measure)).toEqual(['Станция-2']);
  });

  it('длинная — по словам в несколько строк не шире предела, ни одно слово не потеряно', () => {
    const text = 'Склад станции полон: «Нефть» отсюда никто не везёт, её никто не принимает на остановках маршрутов';
    const lines = wrapLines(text, TOOLTIP_MAX_PX, measure);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(measure(l)).toBeLessThanOrEqual(TOOLTIP_MAX_PX);
    expect(lines.join(' ')).toBe(text);
  });

  it('слово длиннее строки — отдельной строкой целиком, не режем', () => {
    expect(wrapLines('а ' + 'ж'.repeat(60) + ' б', 100, measure)).toEqual(['а', 'ж'.repeat(60), 'б']);
  });
});

describe('Подсказка на карте: у края экрана', () => {
  const W = 1000;
  const H = 600;

  it('посередине — справа снизу от курсора', () => {
    expect(tooltipOffset(400, 300, 200, 40, W, H)).toEqual({ x: 16, y: 14 });
  });

  it('у правого края — слева от курсора, у нижнего — над ним; целиком на экране', () => {
    const { x, y } = tooltipOffset(950, 580, 200, 58, W, H);
    expect(x).toBe(-216);
    expect(y).toBe(-72);
    expect(950 + x).toBeGreaterThanOrEqual(8);
    expect(580 + y + 58).toBeLessThanOrEqual(H - 8);
  });

  it('широкая у левого края, когда не помещается ни справа, ни слева, — прижата к краю, не за ним', () => {
    const { x } = tooltipOffset(20, 300, 990, 40, W, H);
    expect(20 + x).toBe(8);
  });
});

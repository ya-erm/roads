import { describe, expect, it } from 'vitest';
import { INPUT_TAIL_MS, RedrawGate } from './redraw';

describe('Кадр без изменений не перерисовывается', () => {
  it('первый кадр — всегда; потом без изменений и движения — нет', () => {
    const g = new RedrawGate();
    expect(g.need(0, [1, 'a'], false)).toBe(true);
    expect(g.need(16, [1, 'a'], false)).toBe(false);
    expect(g.need(32, [1, 'a'], false)).toBe(false);
  });

  it('поменялась подпись (камера, партия…) — рисуем; та же партия — объект сравнивается сам по себе', () => {
    const g = new RedrawGate();
    const game = {};
    g.need(0, [game, 1], false);
    expect(g.need(16, [game, 1.5], false)).toBe(true);
    expect(g.need(32, [game, 1.5], false)).toBe(false);
    expect(g.need(48, [{}, 1.5], false)).toBe(true);
    expect(g.need(64, [game, 1.5, 'ещё'], false)).toBe(true);
  });

  it('движущееся в кадре — рисуем каждый кадр, пока оно есть', () => {
    const g = new RedrawGate();
    g.need(0, [1], false);
    expect(g.need(16, [1], true)).toBe(true);
    expect(g.need(32, [1], true)).toBe(true);
    expect(g.need(48, [1], false)).toBe(false);
  });

  it('после ввода рисуем ещё INPUT_TAIL_MS', () => {
    const g = new RedrawGate();
    g.need(0, [1], false);
    g.poke(100);
    expect(g.need(116, [1], false)).toBe(true);
    expect(g.need(100 + INPUT_TAIL_MS - 1, [1], false)).toBe(true);
    expect(g.need(100 + INPUT_TAIL_MS + 1, [1], false)).toBe(false);
  });
});

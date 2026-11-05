import { describe, expect, it } from 'vitest';
import { hillshade } from './relief';

/** Освещённость склона холма с вершиной в начале координат в точке (x, y): высота −(x² + y²)·a. */
const onHill = (x: number, y: number, a = 0.05) => hillshade(-2 * a * x, -2 * a * y);

describe('hillshade', () => {
  it('у холма светлый бок сверху-слева, тень — снизу-справа, как у построек', () => {
    expect(onHill(-3, -3)).toBeGreaterThan(0);
    expect(onHill(3, 3)).toBeLessThan(0);
    expect(onHill(3, 0)).toBeLessThan(0);
    expect(onHill(0, 3)).toBeLessThan(0);
  });

  it('у впадины наоборот: тень на склоне сверху-слева', () => {
    expect(onHill(-3, -3, -0.05)).toBeLessThan(0);
    expect(onHill(3, 3, -0.05)).toBeGreaterThan(0);
  });

  it('ровная земля не затеняется, крутой склон — не больше ±1', () => {
    expect(hillshade(0, 0)).toBe(0);
    expect(hillshade(5, 5)).toBe(1);
    expect(hillshade(-5, -5)).toBe(-1);
  });
});

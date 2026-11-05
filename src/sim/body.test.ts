import { describe, expect, it } from 'vitest';
import { follow, hitchOf, jointOf, steerBase, trailDir } from './body';

describe('Кузов из двух частей', () => {
  it('ось тянется за шарниром на своём расстоянии и срезает угол на повороте', () => {
    const len = 6;
    // Шарнир ехал на восток, потом повернул на юг: ось идёт следом, но по хорде — курс второй части между ними.
    let trail = follow({ x: 0, y: 0 }, { x: 1, y: 0 }, undefined, len);
    expect(trail).toEqual({ x: -6, y: 0 });
    for (let y = 0.5; y <= 4; y += 0.5) trail = follow({ x: 0, y }, { x: 0, y: 1 }, trail, len);
    expect(Math.hypot(trail.x, trail.y - 4)).toBeCloseTo(len, 6);
    const td = trailDir({ x: 0, y: 4 }, trail, { x: 0, y: 1 });
    expect(td.x).toBeGreaterThan(0.3);
    expect(td.y).toBeGreaterThan(0.3);
  });

  it('машину переставили — вторая часть встаёт прямо за первой', () => {
    const far = { x: 100, y: 100 };
    const p = follow({ x: 0, y: 0 }, { x: 0, y: -1 }, far, 5);
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.y).toBeCloseTo(5, 6);
  });

  it('у цельных машин сцепки нет, у тягачей и сочленённого — шарнир между частями', () => {
    expect(hitchOf(undefined)).toBeUndefined();
    expect(hitchOf('van')).toBeUndefined();
    expect(steerBase('van')).toBe(0.7);
    for (const body of ['semi', 'longSemi', 'articBus'] as const) {
      const h = hitchOf(body)!;
      // Шарнир — внутри машины, вторая часть кончается у хвоста; тягач поворачивает по короткой базе.
      expect(h.joint).toBeGreaterThan(0);
      expect(h.joint + h.tail).toBeLessThan(1);
      expect(steerBase(body)).toBeLessThan(0.7);
      expect(jointOf({ x: 0, y: 0 }, { x: 1, y: 0 }, 10, h).x).toBeCloseTo(-h.joint * 10, 6);
    }
  });
});

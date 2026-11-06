import { describe, expect, it } from 'vitest';
import { type CoverTree, type Hiders, TreeCover } from './treeCover';

/** Повторяемый «случайный» ряд 0…1. */
function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

/** Спрятанные деревья полным пересчётом — эталон. */
function reference(trees: CoverTree[], hiders: Hiders): boolean[] {
  const copy = trees.map((t) => ({ pos: t.pos, hidden: false }));
  new TreeCover().full(copy, hiders);
  return copy.map((t) => t.hidden);
}

/** Дорога кружками вдоль отрезка. */
function road(rnd: () => number): number[] {
  const x = rnd() * 2000;
  const y = rnd() * 2000;
  const a = rnd() * Math.PI * 2;
  const len = 50 + rnd() * 400;
  const r = 6 + rnd() * 10;
  const pts: number[] = [];
  for (let s = 0; s <= len; s += 6) pts.push(x + Math.cos(a) * s, y + Math.sin(a) * s, r);
  return pts;
}

describe('Деревья под дорогами и строениями', () => {
  it('после правки пересчёт только в её рамке — то же, что пересчёт всей карты', () => {
    const rnd = seeded(11);
    const trees: CoverTree[] = Array.from({ length: 6000 }, () => ({ pos: { x: rnd() * 2000, y: rnd() * 2000 }, hidden: false }));
    const hiders: Hiders = new Map();
    for (let i = 0; i < 120; i++) hiders.set(`c${i}`, road(rnd));
    const homes = Array.from({ length: 300 }, () => ({ id: 0 }));
    homes.forEach((h, i) => hiders.set(h, [rnd() * 2000, rnd() * 2000, 8 + (i % 5)]));
    const cover = new TreeCover();
    cover.update(trees, hiders);
    expect(trees.map((t) => t.hidden)).toEqual(reference(trees, hiders));
    for (let step = 0; step < 12; step++) {
      // Правка: новая дорога, снос дороги, перестройка дороги, снос и новое строение.
      hiders.set(`n${step}`, road(rnd));
      hiders.delete(`c${step * 3}`);
      hiders.set(`c${step * 3 + 1}`, road(rnd));
      hiders.delete(homes[step]);
      hiders.set({ id: step }, [rnd() * 2000, rnd() * 2000, 9]);
      cover.update(trees, hiders);
      expect(trees.map((t) => t.hidden)).toEqual(reference(trees, hiders));
    }
    // Ничего не поменялось — ничего и не пересчитывается (и не портится).
    const before = trees.map((t) => t.hidden);
    cover.update(trees, new Map(hiders));
    expect(trees.map((t) => t.hidden)).toEqual(before);
    expect(trees.some((t) => t.hidden) && trees.some((t) => !t.hidden)).toBe(true);
  });
});

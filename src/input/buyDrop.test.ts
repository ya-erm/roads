import { describe, expect, it } from 'vitest';
import type { Vec } from '../core/vec';
import { dropSpots, pickDropStop, type DropLook } from './buyDrop';

// Станции: 1, 2, 3 — обычные; 4 и 5 — пара напротив через улицу (20 м).
const pos: Record<number, Vec> = {
  1: { x: 0, y: 0 },
  2: { x: 200, y: 0 },
  3: { x: 400, y: 0 },
  4: { x: 600, y: 0 },
  5: { x: 600, y: 20 },
};
const pairs: Record<number, number> = { 4: 5, 5: 4 };
const look: DropLook = { dot: 8, center: (id) => pos[id], reach: () => 12, mate: (id) => pairs[id] };
const pick = (stops: number[], p: Vec) => pickDropStop(dropSpots(stops, look.center, 16), p, look);

describe('кружки остановок на карте', () => {
  it('в центрах станций, повтор станции — рядом в ряд', () => {
    const spots = dropSpots([1, 2, 1], look.center, 16);
    expect(spots).toEqual([
      { i: 0, id: 1, at: { x: -8, y: 0 } },
      { i: 1, id: 2, at: { x: 200, y: 0 } },
      { i: 2, id: 1, at: { x: 8, y: 0 } },
    ]);
  });

  it('снесённой станции кружка нет', () => {
    expect(dropSpots([1, 9, 2], look.center, 16).map((s) => s.i)).toEqual([0, 2]);
  });
});

describe('куда упадёт покупка', () => {
  it('на станцию маршрута — её номер в маршруте', () => {
    expect(pick([1, 2, 3], { x: 205, y: 6 })).toBe(1);
  });

  it('мимо остановок — никуда', () => {
    expect(pick([1, 2, 3], { x: 100, y: 0 })).toBeNull();
    // Станция есть, но не в этом маршруте.
    expect(pick([1, 2], { x: 400, y: 0 })).toBeNull();
  });

  it('в маршруте одна половина пары — бросок на любую половину ставит на неё', () => {
    expect(pick([1, 4], { x: 600, y: 0 })).toBe(1);
    expect(pick([1, 4], { x: 600, y: 22 })).toBe(1);
    expect(pick([1, 5], { x: 600, y: -2 })).toBe(1);
  });

  it('в маршруте обе половины — на ту, что ближе к точке броска', () => {
    expect(pick([1, 4, 5], { x: 600, y: 3 })).toBe(1);
    expect(pick([1, 4, 5], { x: 600, y: 17 })).toBe(2);
    expect(pick([5, 1, 4], { x: 602, y: 2 })).toBe(2);
  });

  it('станция в маршруте дважды — по ближнему кружку', () => {
    expect(pick([1, 2, 1], { x: -7, y: 0 })).toBe(0);
    expect(pick([1, 2, 1], { x: 7, y: 0 })).toBe(2);
    // Ровно посередине — меньший номер.
    expect(pick([1, 2, 1], { x: 0, y: 0 })).toBe(0);
  });
});

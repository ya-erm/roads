import { describe, expect, it } from 'vitest';
import { carLayers, levelBand, railSegLayer } from './trainLayer';

describe('railSegLayer', () => {
  it('участок рисуют слоем по наибольшей высоте: пандус с земли — целиком мостом', () => {
    expect(railSegLayer(0)).toBe(0);
    expect(railSegLayer(-1)).toBe(0);
    expect(railSegLayer(1)).toBe(1);
    expect(railSegLayer(0.5)).toBe(1);
    expect(railSegLayer(2)).toBe(2);
    expect(railSegLayer(1.5)).toBe(2);
  });
});

describe('carLayers', () => {
  // Земля (участок 1, 100 м) → пандус на мост (участок 2, 200 м, высота 0 → 1) → мост (участок 3).
  const layer: Record<number, number> = { 1: 0, 2: 1, 3: 1 };
  const path = [
    { seg: 1, dir: 0 as const, len: 100, start: 0 },
    { seg: 2, dir: 0 as const, len: 200, start: 100 },
    { seg: 3, dir: 0 as const, len: 300, start: 300 },
  ];
  const segLayer = (id: number) => layer[id];
  const levelAt = (s: number) => Math.max(0, Math.min(1, (s - 100) / 200));
  const train = (head: number) => ({ path, head, cars: 4, carLength: 16 });
  const levels = (head: number) => [0, 1, 2, 3].map((k) => levelAt(head - (k + 0.5) * 16));

  it('вагоны на нижней половине пандуса — над его полотном, а не под ним', () => {
    const t = train(170);
    expect(levels(170).every((l) => levelBand(l) === 0)).toBe(true);
    expect(carLayers(t, levels(170), segLayer)).toEqual([1, 1, 1, 1]);
  });

  it('вагон, заехавший на пандус краем, — тоже слоем моста; ещё на земле — на земле', () => {
    // Голова в 10 м за началом пандуса: локомотив краем на нём, остальные вагоны на земле.
    expect(carLayers(train(110), levels(110), segLayer)).toEqual([1, 0, 0, 0]);
  });

  it('на мосту — слоем моста; в тоннеле — под землёй', () => {
    expect(carLayers(train(500), levels(500), segLayer)).toEqual([1, 1, 1, 1]);
    expect(carLayers(train(60), [-1, -0.8, -0.6, -0.2], () => 0)).toEqual([-1, -1, -1, 0]);
  });
});

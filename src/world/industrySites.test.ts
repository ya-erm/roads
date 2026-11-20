import { describe, expect, it } from 'vitest';
import { INDUSTRY_TYPES } from './cargo';
import { industryFootprint } from './industrySites';
import { footprintAlong, footprintRadius, footprintsOverlap, pointInFootprint } from './spatial';

describe('Участки предприятий', () => {
  it('поля остаются отдельными площадками за пределами размеров хозяйственного двора', () => {
    const farm = industryFootprint(INDUSTRY_TYPES.farm, { x: 0, y: 0 }, 0);
    const field = { x: -102, y: -10 };
    const gap = { x: -68, y: -farm.h * 0.97 };
    const buildingAt = (center: typeof field) => ({ center, w: 4, h: 4, angle: 0 });

    expect(footprintRadius(farm)).toBeGreaterThan(farm.w);
    expect(farm.compound?.sections.filter((s) => s.kind === 'field')).toHaveLength(6);
    expect(pointInFootprint(field, farm)).toBe(true);
    expect(pointInFootprint(gap, farm)).toBe(false);
    expect(footprintsOverlap(buildingAt(field), farm)).toBe(true);
    expect(footprintsOverlap(buildingAt(gap), farm)).toBe(false);

    const rotated = industryFootprint(INDUSTRY_TYPES.farm, { x: 50, y: 50 }, Math.PI / 2);
    expect(pointInFootprint({ x: 50 - field.y, y: 50 + field.x }, rotated)).toBe(true);
  });

  it('дорога задевает удалённое поле, но может пройти в свободном промежутке', () => {
    const farm = industryFootprint(INDUSTRY_TYPES.farm, { x: 0, y: 0 }, 0);
    const path = (y: number) => ({ length: 28, pointAt: (s: number) => ({ x: -85 + s, y }) });
    expect(footprintAlong(farm, path(-10), () => 2)).toBe(true);
    expect(footprintAlong(farm, path(-farm.h * 0.97), () => 1)).toBe(false);
  });
});

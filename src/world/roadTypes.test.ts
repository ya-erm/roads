import { describe, expect, it } from 'vitest';
import { capLimit, DEFAULT_PRESET_ID, defaultPreset, limitAllowed, limitCapText, maxKmh, ROAD_CLASS_IDS, ROAD_CLASSES, ROAD_PRESETS, SPEED_LIMITS } from './roadTypes';

describe('потолок ограничения скорости по классу дороги', () => {
  it('грунтовая — 40, улица (и односторонняя) — 80, проспект — 100, шоссе и автомагистраль — 120', () => {
    expect(ROAD_CLASS_IDS.map(maxKmh)).toEqual([40, 80, 100, 120, 120]);
    expect(ROAD_PRESETS.find((p) => p.id === 'oneway')!.spec.cls).toBe('street');
    // Скорость по умолчанию — не выше потолка, и потолок — один из знаков.
    for (const cls of ROAD_CLASS_IDS) {
      expect(ROAD_CLASSES[cls].limit).toBeLessThanOrEqual(maxKmh(cls));
      expect(SPEED_LIMITS).toContain(maxKmh(cls));
    }
  });

  it('какие знаки доступны: на грунтовке — только 40, на улице — 40…80', () => {
    expect(SPEED_LIMITS.filter((v) => limitAllowed('dirt', v))).toEqual([40]);
    expect(SPEED_LIMITS.filter((v) => limitAllowed('street', v))).toEqual([40, 60, 80]);
    expect(SPEED_LIMITS.filter((v) => limitAllowed('avenue', v))).toEqual([40, 60, 80, 90, 100]);
    expect(SPEED_LIMITS.filter((v) => limitAllowed('highway', v))).toEqual(SPEED_LIMITS);
  });

  it('обрезка по потолку; без знака — по классу', () => {
    expect(capLimit('dirt', 120)).toBe(40);
    expect(capLimit('street', 60)).toBe(60);
    expect(capLimit('avenue', 120)).toBe(100);
    expect(capLimit('dirt', undefined)).toBeUndefined();
    expect(limitCapText('dirt')).toBe('Грунтовая: не быстрее 40 км/ч');
    expect(limitCapText('street', 'Односторонняя')).toBe('Односторонняя: не быстрее 80 км/ч');
  });
});

describe('тип дороги по умолчанию', () => {
  it('шоссе 1+1', () => {
    const p = defaultPreset();
    expect(ROAD_PRESETS.some((x) => x.id === DEFAULT_PRESET_ID)).toBe(true);
    expect(p.name).toBe('Шоссе');
    expect(p.spec).toEqual({ cls: 'highway', lanesF: 1, lanesB: 1 });
  });
});

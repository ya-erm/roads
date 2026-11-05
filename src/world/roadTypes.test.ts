import { describe, expect, it } from 'vitest';
import { DEFAULT_PRESET_ID, defaultPreset, ROAD_PRESETS } from './roadTypes';

describe('тип дороги по умолчанию', () => {
  it('шоссе 1+1', () => {
    const p = defaultPreset();
    expect(ROAD_PRESETS.some((x) => x.id === DEFAULT_PRESET_ID)).toBe(true);
    expect(p.name).toBe('Шоссе');
    expect(p.spec).toEqual({ cls: 'highway', lanesF: 1, lanesB: 1 });
  });
});

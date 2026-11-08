import { describe, expect, it } from 'vitest';
import { ICON_MAX_PX, ICON_MIN_PX, iconBucket, iconRaster, type RasterCanvas } from './iconRaster';

/** Картинка-заглушка: загружена или нет. */
const image = (loaded = true) => ({ complete: loaded, naturalWidth: loaded ? 64 : 0 }) as unknown as HTMLImageElement;

/** Фабрика холстов, что считает, сколько холстов создано и сколько раз в них рисовали. */
function factory() {
  const made: { size: number; draws: number }[] = [];
  const make = (size: number): RasterCanvas => {
    const rec = { size, draws: 0 };
    made.push(rec);
    return { width: size, height: size, getContext: () => ({ drawImage: () => void rec.draws++ }) };
  };
  return { made, make };
}

describe('Растр значков на канвасе', () => {
  it('размер растра — степень двойки не меньше нужного, в пределах', () => {
    expect(iconBucket(0)).toBe(ICON_MIN_PX);
    expect(iconBucket(Number.NaN)).toBe(ICON_MIN_PX);
    expect(iconBucket(10)).toBe(16);
    expect(iconBucket(16)).toBe(16);
    expect(iconBucket(17)).toBe(32);
    expect(iconBucket(30)).toBe(32);
    expect(iconBucket(48)).toBe(64);
    expect(iconBucket(1000)).toBe(ICON_MAX_PX);
  });

  it('растр картинки на размер — один раз: дальше тот же холст, SVG больше не рисуется', () => {
    const { made, make } = factory();
    const img = image();
    const a = iconRaster(img, 30, make);
    const b = iconRaster(img, 31, make);
    expect(a).toBe(b);
    expect(made).toEqual([{ size: 32, draws: 1 }]);
    // Другой размер — свой растр.
    const c = iconRaster(img, 60, make);
    expect(c).not.toBe(a);
    expect(made.map((m) => m.size)).toEqual([32, 64]);
    // У другой картинки — свои растры.
    iconRaster(image(), 30, make);
    expect(made).toHaveLength(3);
  });

  it('картинка не загрузилась или холста нет — рисуется сама картинка, растр не запоминается', () => {
    const { made, make } = factory();
    const loading = image(false);
    expect(iconRaster(loading, 30, make)).toBe(loading);
    expect(made).toHaveLength(0);
    const img = image();
    expect(iconRaster(img, 30, () => null)).toBe(img);
    // Холст появился — растр создаётся.
    expect(iconRaster(img, 30, make)).not.toBe(img);
    expect(made).toHaveLength(1);
  });
});

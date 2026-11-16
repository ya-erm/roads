import { describe, expect, it } from 'vitest';
import { INDUSTRY_TYPES } from '../world/cargo';
import type { Industry, TownBuilding } from '../world/entities';
import type { Footprint } from '../world/spatial';
import { craneSpot, dirtyIndustries, houseGrime } from './enterpriseArt';

/** Ферма из баг-репорта: участок 110×80 под углом, автостанция — вплотную к его западному краю. */
const farm: Footprint = { center: { x: 6976.5, y: 6114.5 }, w: 110, h: 80, angle: -0.343 };
const station: Footprint = { center: { x: 6909.4, y: 6125.7 }, w: 56, h: 18, angle: -1.914 };

/** Точка в осях участка — в пределах его прямоугольника (с допуском). */
const inside = (fp: Footprint, p: { x: number; y: number }) => Math.abs(p.x) <= fp.w / 2 + 1e-9 && Math.abs(p.y) <= fp.h / 2 + 1e-9;

/** Участок, приставленный к стороне fp: dx, dy — по осям fp, в долях полуразмеров. */
function beside(fp: Footprint, dx: number, dy: number): Footprint {
  const lx = (dx * (fp.w + 20)) / 2;
  const ly = (dy * (fp.h + 20)) / 2;
  const cs = Math.cos(fp.angle);
  const sn = Math.sin(fp.angle);
  return { center: { x: fp.center.x + lx * cs - ly * sn, y: fp.center.y + lx * sn + ly * cs }, w: 20, h: 20, angle: fp.angle };
}

describe('Кран стройки предприятия', () => {
  it('опора и вся стрела — в пределах участка при любой готовности и наклоне', () => {
    for (const fp of [farm, { ...farm, w: 40, h: 30 }, { ...farm, w: 60, h: 120 }]) {
      for (let done = 0; done <= 1; done += 0.05) {
        for (const swing of [-0.25, -0.1, 0, 0.1, 0.25]) {
          const { base, tip } = craneSpot(fp, done, swing, [station]);
          expect(inside(fp, base)).toBe(true);
          expect(inside(fp, tip)).toBe(true);
        }
      }
    }
  });

  it('в начале стройки стрела не уходит на станцию у западного края: тянется к недостроенному', () => {
    const { base, tip } = craneSpot(farm, 0, -0.25, [station]);
    expect(base.x).toBeLessThan(0);
    expect(tip.x).toBeGreaterThan(base.x);
    expect(tip.x).toBeGreaterThan(-farm.w / 2);
  });

  it('опора — у длинной стороны, свободной от своего: станция с юга — кран у северной', () => {
    expect(craneSpot(farm, 0.3, 0).base.y).toBeGreaterThan(0);
    expect(craneSpot(farm, 0.3, 0, [beside(farm, 0, 1)]).base.y).toBeLessThan(0);
    expect(craneSpot(farm, 0.3, 0, [beside(farm, 0, -1)]).base.y).toBeGreaterThan(0);
    // Стрела — к другой стороне: от опоры через участок.
    const north = craneSpot(farm, 0.3, 0, [beside(farm, 0, 1)]);
    expect(north.tip.y).toBeGreaterThan(north.base.y);
  });
});

describe('Налёт на домах у вредных предприятий', () => {
  const plant = (kind: 'steelmill' | 'claypit', x: number) =>
    ({ id: 1, info: INDUSTRY_TYPES[kind], fp: { center: { x, y: 0 }, w: 120, h: 80, angle: 0 } }) as unknown as Industry;
  const house = (x: number) => ({ id: 2, fp: { center: { x, y: 0 }, w: 150, h: 80, angle: 0 } }) as unknown as TownBuilding;

  it('вплотную к металлургическому — серый дом, к краю зоны вреда налёт сходит на нет линейно', () => {
    const dirty = dirtyIndustries([plant('steelmill', 0)]);
    expect(houseGrime(house(80), dirty)).toBe(1);
    const g = [300, 600, 900, 1200].map((x) => houseGrime(house(x), dirty));
    for (let i = 1; i < g.length; i++) expect(g[i]).toBeLessThan(g[i - 1]);
    expect(houseGrime(house(2000), dirty)).toBe(0);
  });

  it('дома из баг-репорта — в километре от завода и в 700 м от глиняного карьера — почти без налёта', () => {
    // Было: налёт 0.56–0.72 и тёмная пелена на весь участок — панельные дома почти чёрные.
    expect(houseGrime(house(980), dirtyIndustries([plant('steelmill', 0)]))).toBeLessThan(0.4);
    expect(houseGrime(house(714), dirtyIndustries([plant('claypit', 0)]))).toBeLessThan(0.2);
  });
});

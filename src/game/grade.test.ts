import { describe, expect, it } from 'vitest';
import { structureFactor } from '../world/roadTypes';
import { autoLevels, designProfile, earthworkProblem, profileText } from './grade';

const ramp = (n: number, ds: number, grade: number) => Array.from({ length: n }, (_, i) => i * ds * grade);

describe('Продольный профиль полотна', () => {
  it('пологий рельеф — полотно лежит на земле, без насыпей и выемок', () => {
    const h = ramp(30, 8, 0.06);
    const p = designProfile(h, 8, 0.1);
    expect(p.cut).toBeLessThan(1e-9);
    expect(p.fill).toBeLessThan(1e-9);
    expect(p.grade).toBeCloseTo(0.06, 5);
  });

  it('короткий крутой бугор срезается выемкой, ямка засыпается насыпью; уклон не круче допустимого, концы на земле', () => {
    const h = Array.from({ length: 41 }, (_, i) => 4 * Math.exp(-(((i - 12) / 3) ** 2)) - 4 * Math.exp(-(((i - 28) / 3) ** 2)));
    const p = designProfile(h, 8, 0.05);
    expect(p.grade).toBeLessThanOrEqual(0.05 + 1e-3);
    expect(p.cut).toBeGreaterThan(0.5);
    expect(p.fill).toBeGreaterThan(0.5);
    expect(p.z[0]).toBeCloseTo(h[0]);
    expect(p.z[40]).toBeCloseTo(h[40]);
    expect(earthworkProblem(p, 0.05, 6)).toBeUndefined();
  });

  it('подъём между концами круче допустимого — выровнять нельзя: подсказка вести дорогу наискось', () => {
    const p = designProfile(ramp(20, 8, 0.15), 8, 0.1);
    expect(p.steep).toBe(true);
    expect(earthworkProblem(p, 0.1, 6)).toMatch(/наискось/);
  });

  it('глубокая выемка через гребень — нужен тоннель, высокая насыпь через лощину — мост', () => {
    const ridge = Array.from({ length: 41 }, (_, i) => 30 * Math.exp(-(((i - 20) / 5) ** 2)));
    expect(earthworkProblem(designProfile(ridge, 8, 0.1), 0.1, 6)).toMatch(/Выемка.*тоннель/);
    const gully = ridge.map((v) => -v);
    expect(earthworkProblem(designProfile(gully, 8, 0.1), 0.1, 6)).toMatch(/Насыпь.*мост/);
  });

  it('над водой (NaN) полотно не привязано к земле и там глубину не считаем', () => {
    const h = [0, 0, 0, NaN, NaN, NaN, 0, 0, 0];
    const p = designProfile(h, 8, 0.1);
    expect(p.cut).toBe(0);
    expect(p.fill).toBe(0);
    expect([...p.z].every(Number.isFinite)).toBe(true);
  });

  it('мост, эстакада и тоннель заметно дороже дороги на земле; насыпь в пределах допуска — дешевле моста', () => {
    expect(structureFactor(0, false)).toBe(1);
    expect(structureFactor(1, false)).toBeGreaterThanOrEqual(8);
    expect(structureFactor(2, false)).toBeGreaterThan(structureFactor(1, false));
    expect(structureFactor(-1, false)).toBeGreaterThan(structureFactor(2, false));
    expect(structureFactor(0, true)).toBeGreaterThanOrEqual(8);
    expect(structureFactor(-1, true)).toBeGreaterThan(structureFactor(-1, false));
    // Насыпь 6 м (предел для дороги) стоит втрое против земли — всё ещё дешевле моста.
    expect(1 + 6 / 3).toBeLessThan(structureFactor(1, false));
  });

  it('«Авто»: глубокая лощина — мост с пандусами, гребень — тоннель, мелкие неровности — земля', () => {
    const n = 61;
    const valley = Array.from({ length: n }, (_, i) => -30 * Math.exp(-(((i - 30) / 6) ** 2)));
    const z = designProfile(valley, 8, 0.1).z;
    const pts = autoLevels(z, valley, 8, 6, 80);
    expect(pts[0]).toEqual({ s: 0, level: 0 });
    expect(pts[pts.length - 1].level).toBe(0);
    expect(pts.some((p) => p.level === 1)).toBe(true);
    // Пандус до моста — не короче 80 м.
    const up = pts.findIndex((p) => p.level === 1);
    expect(pts[up].s - pts[up - 1].s).toBeGreaterThanOrEqual(80 - 1e-6);
    const ridge = valley.map((v) => -v);
    expect(autoLevels(designProfile(ridge, 8, 0.1).z, ridge, 8, 6, 80).some((p) => p.level === -1)).toBe(true);
    const bumps = Array.from({ length: n }, (_, i) => 2 * Math.sin(i / 3));
    expect(autoLevels(designProfile(bumps, 8, 0.1).z, bumps, 8, 6, 80).every((p) => p.level === 0)).toBe(true);
  });

  it('конец задан выше земли — полотно приходит на высоту конца (мост в конце)', () => {
    const flat = Array.from({ length: 41 }, () => 0);
    const p = designProfile(flat, 8, 0.1, { start: 0, end: 12 });
    expect(p.z[40]).toBeCloseTo(12);
    const pts = autoLevels(p.z, flat, 8, 6, 80);
    expect(pts[pts.length - 1].level).toBe(1);
    expect(pts[0].level).toBe(0);
  });

  it('полотно выравнивается: бугры и ложбинки до smooth м срезаются и засыпаются, большой холм — нет', () => {
    // Ровное место с буграми по 1.5 м — дорога идёт ровно, уклон 0, а не 10% на каждом бугре.
    const bumps = Array.from({ length: 21 }, (_, i) => (i % 4 === 2 ? 1.5 : 0));
    const flat = designProfile(bumps, 8, 0.1, undefined, 2);
    expect(flat.grade).toBeLessThan(1e-9);
    expect(flat.cut).toBeCloseTo(1.5);
    // Без выравнивания полотно шло бы по каждому бугру — упираясь в предел уклона.
    expect(designProfile(bumps, 8, 0.1).grade).toBeGreaterThan(0.09);
    // Ровный подъём с неровностями — один уклон от конца до конца.
    const slope = Array.from({ length: 21 }, (_, i) => i * 8 * 0.04 + (i % 3 === 1 ? 1 : 0));
    const up = designProfile(slope, 8, 0.1, undefined, 2);
    expect(up.grade).toBeCloseTo(0.04, 5);
    // Холм на 10 м — полотно поднимается на него (выемка не больше нужного), а не идёт насквозь.
    const hill = Array.from({ length: 41 }, (_, i) => 10 * Math.exp(-(((i - 20) / 8) ** 2)));
    const over = designProfile(hill, 8, 0.1, undefined, 2);
    expect(over.cut).toBeLessThanOrEqual(2 + 1e-6);
    expect(over.z[20]).toBeGreaterThan(8);
  });

  it('подпись: главное — уклон между концами со стрелкой хода, крутой бугор по пути — «местами»', () => {
    // Концы на одной высоте, по пути бугор 10% — не «↗ 10%».
    expect(profileText({ grade: 0.1, cut: 0, fill: 0, slope: 0 })).toBe('→ 0% · местами 10%');
    expect(profileText({ grade: 0.09, cut: 0, fill: 0, slope: 0.062 })).toBe('↗ 6% · местами 9%');
    expect(profileText({ grade: 0.05, cut: 0, fill: 2.4, slope: -0.04 })).toBe('↘ 4% · насыпь 2 м');
    // Без концов (правка части дороги) — только наибольший уклон.
    expect(profileText({ grade: 0.06, cut: 1, fill: 0 })).toBe('↗ до 6% · выемка 1 м');
  });
});

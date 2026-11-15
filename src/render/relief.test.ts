import { describe, expect, it } from 'vitest';
import type { Terrain } from '../world/terrain';
import { contourLabel, contourTile, fineContourStep, gradeRungs, hillshade, labelSpots, steepTicks } from './relief';

/**
 * Рельеф-заглушка 1024 × 1024 м (один тайл): западная половина ровная (высота 0), восточная — склон, поднимающийся
 * на east м на метр к востоку. Сетка высот — через 16 м, как у настоящего рельефа (на ней излом ровно в узле).
 */
function ramp(east: number): Terrain {
  const cell = 16;
  const nx = 1024 / cell + 1;
  const h = (x: number) => Math.max(0, x - 512) * east;
  const data = new Float32Array(nx * nx);
  for (let j = 0; j < nx; j++) for (let i = 0; i < nx; i++) data[j * nx + i] = h(i * cell);
  return {
    hasRelief: true,
    width: 1024,
    height: 1024,
    waterLevel: 0,
    contourStep: 20,
    heightGrid: () => ({ data, nx, ny: nx, cell }),
    heightAt: (p: { x: number; y: number }) => h(Math.max(0, Math.min(1024, p.x))),
    altitudeAt: (p: { x: number; y: number }) => h(Math.max(0, Math.min(1024, p.x))),
  } as unknown as Terrain;
}

describe('промежуточные изолинии', () => {
  it('шаг — 5, 2 или 1 м: не больше четверти обычного и делит его нацело', () => {
    expect(fineContourStep(20)).toBe(5);
    expect(fineContourStep(10)).toBe(2);
    expect(fineContourStep(4)).toBe(1);
  });

  it('лежат между обычными, на своей высоте, а совпадающих с обычными нет', () => {
    const t = ramp(0.2);
    const fine = contourTile(t, 0, 0, true);
    const regular = contourTile(t, 0, 0);
    expect(fine.length).toBeGreaterThan(0);
    expect(new Set(regular.map((c) => c.alt))).toEqual(new Set([20, 40, 60, 80, 100]));
    const alts = new Set(fine.map((c) => c.alt));
    for (const a of [5, 10, 15, 25, 95]) expect(alts.has(a)).toBe(true);
    for (const c of fine) {
      expect(c.fine).toBe(true);
      expect(c.major).toBe(false);
      expect(c.alt % 20).not.toBe(0);
      // Склон 0,2: линия высоты alt — на x = 512 + alt / 0,2.
      for (let q = 0; q < c.pts.length; q += 2) expect(c.pts[q]).toBeCloseTo(512 + c.alt / 0.2, 0);
    }
    expect(regular.every((c) => !c.fine)).toBe(true);
  });
});

describe('штрихи крутых склонов', () => {
  it('только где круче предела дороги, вниз по склону; класс — по крутизне', () => {
    const [mild, mid, hard] = steepTicks(ramp(0.2), 0, 0, 0.1);
    // Склон вдвое круче предела — средний класс; на ровной половине штрихов нет (у излома — пара метров разностей).
    expect(mid.length).toBeGreaterThan(1000);
    expect(hard.length).toBe(0);
    for (const s of [mild, mid]) {
      for (let q = 0; q < s.length; q += 4) {
        expect((s[q] + s[q + 2]) / 2).toBeGreaterThan(505);
        // Вниз по склону: второй конец западнее (ниже), поперёк изолиний (по y не сдвинут).
        expect(s[q + 2]).toBeLessThan(s[q]);
        expect(s[q + 3]).toBeCloseTo(s[q + 1], 3);
      }
    }
    // Пологий склон (5%) — без штрихов, очень крутой (40%) — самый тёмный класс.
    expect(steepTicks(ramp(0.05), 0, 0, 0.1).every((s) => s.length === 0)).toBe(true);
    expect(steepTicks(ramp(0.4), 0, 0, 0.1)[2].length).toBeGreaterThan(1000);
  });

  it('каждый раз одни и те же — плитки кэша сходятся без шва', () => {
    expect(steepTicks(ramp(0.2), 0, 0, 0.1)).toEqual(steepTicks(ramp(0.2), 0, 0, 0.1));
  });
});

describe('подписи высот на изолиниях', () => {
  it('на пересечениях с мировой сеткой; место не зависит от нарезки линии на куски', () => {
    const pts: number[] = [];
    for (let k = 0; k <= 120; k++) pts.push(150 + k * 4, 300 + Math.sin(k / 9) * 60);
    const whole = labelSpots(Float32Array.from(pts));
    expect(whole.length).toBeGreaterThan(0);
    for (const s of whole) {
      const onGrid = (v: number) => Math.abs(v / 200 - Math.round(v / 200)) < 1e-6;
      expect(onGrid(s.x) || onGrid(s.y)).toBe(true);
      // Подпись не вверх ногами.
      expect(Math.abs(s.angle)).toBeLessThanOrEqual(Math.PI / 2);
    }
    // Куски, как у contourTile: соседние делят крайнюю точку.
    const a = labelSpots(Float32Array.from(pts.slice(0, 2 * 64)));
    const b = labelSpots(Float32Array.from(pts.slice(2 * 63)));
    const key = (s: { x: number; y: number }) => `${s.x.toFixed(3)}:${s.y.toFixed(3)}`;
    expect([...a, ...b].map(key).sort()).toEqual(whole.map(key).sort());
  });

  it('высота — со знаком минус и десятичной запятой', () => {
    expect(contourLabel(-25)).toBe('−25');
    expect(contourLabel(40)).toBe('40');
    expect(contourLabel(2.5)).toBe('2,5');
  });
});

describe('лесенка уклона на превью дороги', () => {
  it('случай из баг-репорта: 110 м с −23 до −36 м — три ступеньки через 5 м, все круче 10%', () => {
    const n = 56;
    const alts = Array.from({ length: n }, (_, i) => -23 - (13 * i) / (n - 1));
    const rungs = gradeRungs(alts, 2, 5, 0.1);
    expect(rungs.map((r) => r.alt)).toEqual([-25, -30, -35]);
    expect(rungs.every((r) => r.steep)).toBe(true);
    expect(rungs[1].s - rungs[0].s).toBeCloseTo(110 * (5 / 13), 0);
  });

  it('полого — ступеньки не красные; вернулись через ту же изолинию — не в счёт', () => {
    // 7,5%: ступеньки через 67 м — дольше 50 м, которые дороге нужны на 5 м подъёма.
    const gentle = gradeRungs(Array.from({ length: 201 }, (_, i) => i * 0.15), 2, 5, 0.1);
    expect(gentle.map((r) => r.alt)).toEqual([5, 10, 15, 20, 25, 30]);
    expect(gentle.some((r) => r.steep)).toBe(false);
    const bump = gradeRungs([4, 6, 4], 2, 5, 0.1);
    expect(bump.map((r) => r.alt)).toEqual([5, 5]);
    expect(bump.some((r) => r.steep)).toBe(false);
  });

  it('высота ровно на изолинии — одна ступенька, а не две', () => {
    expect(gradeRungs([3, 5, 7], 4, 5, 0.1).map((r) => r.alt)).toEqual([5]);
    expect(gradeRungs([7, 5, 3], 4, 5, 0.1).map((r) => r.alt)).toEqual([5]);
  });
});

/** Освещённость склона холма с вершиной в начале координат в точке (x, y): высота −(x² + y²)·a. */
const onHill = (x: number, y: number, a = 0.05) => hillshade(-2 * a * x, -2 * a * y);

describe('hillshade', () => {
  it('у холма светлый бок сверху-слева, тень — снизу-справа, как у построек', () => {
    expect(onHill(-3, -3)).toBeGreaterThan(0);
    expect(onHill(3, 3)).toBeLessThan(0);
    expect(onHill(3, 0)).toBeLessThan(0);
    expect(onHill(0, 3)).toBeLessThan(0);
  });

  it('у впадины наоборот: тень на склоне сверху-слева', () => {
    expect(onHill(-3, -3, -0.05)).toBeLessThan(0);
    expect(onHill(3, 3, -0.05)).toBeGreaterThan(0);
  });

  it('ровная земля не затеняется, крутой склон — не больше ±1', () => {
    expect(hillshade(0, 0)).toBe(0);
    expect(hillshade(5, 5)).toBe(1);
    expect(hillshade(-5, -5)).toBe(-1);
  });
});

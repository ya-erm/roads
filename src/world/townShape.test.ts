import { describe, expect, it } from 'vitest';
import { Rng } from '../core/rng';
import { dist, type Vec } from '../core/vec';
import { Game } from '../game/game';
import { DEFAULT_SETTINGS } from './settings';
import type { Terrain } from './terrain';
import { townShape, type TownShape, type WorldContext } from './worldgen';

/** Ровная карта 10×10 км; wet — где вода. */
function ctxWith(seed: number, wet: (p: Vec) => boolean = () => false): WorldContext {
  const terrain = {
    hasRelief: false,
    amplitude: 0,
    heightAt: () => 0,
    inBounds: (p: Vec, m = 0) => p.x >= m && p.y >= m && p.x <= 10_000 - m && p.y <= 10_000 - m,
    isWater: (p: Vec, margin = 0) => wet(p) || wet({ x: p.x - margin, y: p.y }) || wet({ x: p.x + margin, y: p.y }),
  } as unknown as Terrain;
  return { terrain, rng: new Rng(seed) } as unknown as WorldContext;
}

const C = { x: 5000, y: 5000 };
const R = 500;
const samples = (f: TownShape) => Array.from({ length: 360 }, (_, i) => f((i / 360) * Math.PI * 2));
const meanSquare = (fs: number[]) => fs.reduce((s, f) => s + f * f, 0) / fs.length;

describe('Очертания города', () => {
  it('по seed — одни и те же; у разных seed — разные', () => {
    const a = samples(townShape(ctxWith(5), C, R));
    expect(samples(townShape(ctxWith(5), C, R))).toEqual(a);
    expect(samples(townShape(ctxWith(6), C, R))).not.toEqual(a);
  });

  it('не круг: край неровный и вытянут, а площадь — как у круга того же радиуса', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const fs = samples(townShape(ctxWith(seed), C, R));
      expect(Math.max(...fs) / Math.min(...fs)).toBeGreaterThan(1.15);
      expect(meanSquare(fs)).toBeCloseTo(1, 1);
    }
  });

  it('к воде край поджимается, а место добирается вдоль берега', () => {
    // Река вдоль y в 400 м к востоку от центра.
    const river = (p: Vec) => p.x > C.x + 400 && p.x < C.x + 600;
    for (const seed of [1, 2, 3]) {
      const f = townShape(ctxWith(seed, river), C, R);
      // На восток — не дальше берега (с запасом), на север и юг — дальше обычного радиуса.
      expect(f(0) * R).toBeLessThan(360);
      expect(Math.max(f(Math.PI / 2), f(-Math.PI / 2))).toBeGreaterThan(1);
      expect(meanSquare(samples(f))).toBeGreaterThan(0.9);
    }
  });

  it('вдоль выездов — лепестки: город тянется дальше', () => {
    const petal = 1.2;
    for (const seed of [1, 2, 3]) {
      const plain = townShape(ctxWith(seed), C, R);
      const petals = townShape(ctxWith(seed), C, R, { petals: [petal] });
      expect(petals(petal) / plain(petal)).toBeGreaterThan(1.1);
    }
  });

  it('пределы: не уже min и не шире max', () => {
    const fs = samples(townShape(ctxWith(9), C, R, { min: 0.7, max: 1.5 }));
    expect(Math.min(...fs)).toBeGreaterThanOrEqual(0.7 - 1e-9);
    expect(Math.max(...fs)).toBeLessThanOrEqual(1.5 + 1e-9);
  });
});

describe('Города в мире — не круги', { timeout: 60_000 }, () => {
  it('кольцевые города вытянуты: застройка по одной оси заметно шире, чем по другой', () => {
    const ratios: number[] = [];
    for (const seed of [1, 2]) {
      const game = new Game({ ...DEFAULT_SETTINGS, seed });
      for (const t of game.towns.filter((x) => x.style === 'radial')) {
        // Главные оси застройки — по ковариации домов.
        let xx = 0;
        let yy = 0;
        let xy = 0;
        for (const b of t.buildings) {
          const x = b.fp.center.x - t.center.x;
          const y = b.fp.center.y - t.center.y;
          xx += x * x;
          yy += y * y;
          xy += x * y;
        }
        const tr = xx + yy;
        const d = Math.sqrt((tr * tr) / 4 - (xx * yy - xy * xy));
        ratios.push(Math.sqrt((tr / 2 + d) / (tr / 2 - d)));
        // Дома — у своего города, не дальше выездов.
        for (const b of t.buildings) expect(dist(b.fp.center, t.center)).toBeLessThan(1400);
      }
    }
    expect(ratios.length).toBeGreaterThan(0);
    // Прежние круглые — в среднем около 1.15.
    expect(ratios.reduce((s, r) => s + r, 0) / ratios.length).toBeGreaterThan(1.25);
  });
});

import { describe, expect, it } from 'vitest';
import { Rng } from '../core/rng';
import type { Vec } from '../core/vec';
import { Game } from '../game/game';
import { DEFAULT_SETTINGS } from './settings';
import { Terrain } from './terrain';
import { townRelief, townSites } from './worldgen';

const settings = (relief: 'hills' | 'mountains' | undefined, seed: number) => ({ ...DEFAULT_SETTINGS, seed, size: 'small' as const, relief });

describe('Города и рельеф', () => {
  it('без рельефа места под город идут по порядку попыток, с рельефом — сначала самое ровное', () => {
    const flat = new Terrain(new Rng(3), settings(undefined, 3));
    const points: Vec[] = [500, 1500, 2500].map((x) => ({ x, y: 1000 }));
    expect([...townSites(flat, 300, 3, (a) => points[a])]).toEqual(points);

    const hills = new Terrain(new Rng(3), settings('mountains', 3));
    const candidates: Vec[] = [];
    for (let x = 800; x < hills.width - 800; x += 700) candidates.push({ x, y: hills.height / 2 });
    const order = [...townSites(hills, 300, 6, (a) => candidates[a])];
    const spreads = order.map((c) => townRelief(hills, c, 300).spread);
    expect(order.length).toBe(Math.min(6, candidates.length));
    expect(spreads).toEqual([...spreads].sort((a, b) => a - b));
  });

  it('в горах земля под городом выровнена: перепад и уклон меньше исходных больше чем вдвое', () => {
    let before = 0;
    let after = 0;
    let slopeBefore = 0;
    let slopeAfter = 0;
    for (const seed of [1, 2]) {
      const s = settings('mountains', seed);
      const game = new Game(s);
      const raw = new Terrain(new Rng(seed), s);
      expect(game.towns.length).toBeGreaterThan(0);
      for (const t of game.towns) {
        before += townRelief(raw, t.center, t.radius).spread;
        after += townRelief(game.terrain, t.center, t.radius).spread;
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * Math.PI * 2;
          const p = { x: t.center.x + Math.cos(a) * t.radius * 0.6, y: t.center.y + Math.sin(a) * t.radius * 0.6 };
          slopeBefore += raw.slopeAt(p);
          slopeAfter += game.terrain.slopeAt(p);
        }
      }
    }
    expect(after).toBeLessThan(before * 0.5);
    expect(slopeAfter).toBeLessThan(slopeBefore * 0.5);
  });

  it('площадка под городом переживает сохранение', () => {
    const game = new Game(settings('hills', 4));
    const t = game.towns[0];
    const loaded = new Game(game.settings, JSON.parse(JSON.stringify(game.toSave())));
    for (const f of [0, 0.5, 1]) {
      const p = { x: t.center.x + t.radius * f, y: t.center.y };
      expect(loaded.terrain.heightAt(p)).toBeCloseTo(game.terrain.heightAt(p), 5);
    }
  });

  it('кисть площадки — в полную силу до pad·r, к краю сходит на нет', () => {
    const fresh = () => new Terrain(new Rng(7), settings('mountains', 7));
    const raw = fresh();
    const t = fresh();
    let c: Vec = { x: 0, y: 0 };
    for (let y = 600; y < t.height - 600 && !c.x; y += 200) for (let x = 600; x < t.width - 600 && !c.x; x += 200) if (!t.isWater({ x, y }, 600)) c = { x, y };
    expect(c.x).toBeGreaterThan(0);
    const target = t.heightAt(c) + 20;
    t.terraform({ ...c, r: 400, mode: 'flatten', amount: 2, target, pad: 0.5 });
    for (const d of [0, 100, 190]) expect(t.heightAt({ x: c.x + d, y: c.y })).toBeCloseTo(target, 0);
    const edge = { x: c.x + 399, y: c.y };
    expect(Math.abs(t.heightAt(edge) - raw.heightAt(edge))).toBeLessThan(0.5);
  });
});

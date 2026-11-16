import { describe, expect, it } from 'vitest';
import { freshGame } from '../game/testkit';
import { NEW_GAME_SETTINGS } from '../world/settings';
import { EarthworkCache } from './earthworks';
import { sidewalkNet, walkSite } from './sidewalks';

/** Холст-заглушка: штрихи откосов — отрезки moveTo → lineTo. */
function ticksDrawn(draw: (ctx: CanvasRenderingContext2D) => void): number[][] {
  const out: number[][] = [];
  let from: number[] = [];
  const ctx = new Proxy({} as Record<string | symbol, unknown>, {
    get: (t, k) =>
      k in t
        ? t[k]
        : k === 'moveTo'
          ? (x: number, y: number) => void (from = [x, y])
          : k === 'lineTo'
            ? (x: number, y: number) => void out.push([...from, x, y])
            : () => {},
    set: (t, k, v) => ((t[k] = v), true),
  }) as unknown as CanvasRenderingContext2D;
  draw(ctx);
  return out;
}

const toSeg = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - ax - dx * t, py - ay - dy * t);
};

describe('Откосы у городских улиц', { timeout: 30_000 }, () => {
  it('вдоль тротуаров штрихов откосов нет — тёмные чёрточки не торчат из-под тротуара на газон; вне города — как были', () => {
    const g = freshGame({ ...NEW_GAME_SETTINGS, seed: 1, relief: 'hills' });
    const net = sidewalkNet(g.roads.net, walkSite(g));
    // Профили всех полотен карты считать долго — рамка вокруг двух крупных городов с окрестностями.
    const big = [...g.towns].sort((a, b) => b.population - a.population).slice(0, 2);
    const all = {
      x0: Math.min(...big.map((t) => t.center.x - (t.extent ?? t.radius) - 200)),
      y0: Math.min(...big.map((t) => t.center.y - (t.extent ?? t.radius) - 200)),
      x1: Math.max(...big.map((t) => t.center.x + (t.extent ?? t.radius) + 200)),
      y1: Math.max(...big.map((t) => t.center.y + (t.extent ?? t.radius) + 200)),
    };
    // Штрихи по профилю считаются раз на полотно (кэш), тротуары — при каждом рисовании.
    const cache = new EarthworkCache();
    const draw = (walks?: typeof net.spans) => ticksDrawn((ctx) => cache.draw(ctx, g.ground(), g.roads.net, g.net, [], all, 1, g.terrain.version, undefined, walks));
    // Штрих задевает тротуар улицы: его отрезок проходит ближе 1,5 м от оси тротуара.
    // Отрезки осей тротуаров улиц — по клеткам CELL м (отрезок тротуара — 2,5 м, штрих — до 17,5).
    const CELL = 20;
    const grid = new Map<string, number[][]>();
    for (const l of net.lines) {
      if (!l.key.startsWith('c')) continue;
      for (const p of l.paths) {
        for (let i = 0; i + 3 < p.length; i += 2) {
          const k = `${Math.floor(p[i] / CELL)},${Math.floor(p[i + 1] / CELL)}`;
          const cell = grid.get(k) ?? [];
          cell.push(p.slice(i, i + 4));
          grid.set(k, cell);
        }
      }
    }
    const underWalk = (t: number[]) =>
      // Середина и конец штриха — от оси тротуара.
      [0.5, 1].some((k) => {
        const x = t[0] + (t[2] - t[0]) * k;
        const y = t[1] + (t[3] - t[1]) * k;
        for (let i = -1; i <= 1; i++)
          for (let j = -1; j <= 1; j++)
            for (const s of grid.get(`${Math.floor(x / CELL) + i},${Math.floor(y / CELL) + j}`) ?? []) if (toSeg(x, y, s[0], s[1], s[2], s[3]) < 1.5) return true;
        return false;
      });
    const before = draw();
    const after = draw(net.spans);
    // В холмах у городских улиц есть насыпи и выемки: без тротуаров их штрихи легли бы под тротуар.
    expect(before.filter(underWalk).length).toBeGreaterThan(100);
    expect(after.filter(underWalk)).toEqual([]);
    // За городом штрихи остались.
    expect(after.length).toBeGreaterThan(20);
    expect(after.length).toBeLessThan(before.length);
  });
});

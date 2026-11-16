import { describe, expect, it } from 'vitest';
import { freshGame } from '../game/testkit';
import { NEW_GAME_SETTINGS } from '../world/settings';
import { townTier } from '../world/townForms';
import { halfAtS } from '../world/worldgen';
import { drawSidewalks, sidewalkEnds, sidewalkNet, type WalkSite } from './sidewalks';

function stub() {
  const calls: Record<string, number> = {};
  const set = new Set<string>();
  const props: Record<string | symbol, unknown> = {};
  const ctx = new Proxy(props, {
    get: (t, k) =>
      k in t
        ? t[k]
        : () => {
            calls[String(k)] = (calls[String(k)] ?? 0) + 1;
          },
    set: (t, k, v) => {
      set.add(String(k));
      t[k] = v;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, set };
}

const total = (c: Record<string, number>) => Object.values(c).reduce((s, n) => s + n, 0);

describe('Тротуары вдоль улиц', { timeout: 30_000 }, () => {
  const g = freshGame({ ...NEW_GAME_SETTINGS, seed: 1 });
  const site: WalkSite = {
    around: (p, r) => {
      const near = g.index.near(p, r);
      return { houses: near.filter((s) => s.type === 'building').map((s) => s.fp), others: near.filter((s) => s.type !== 'building').map((s) => s.fp) };
    },
    wet: (p) => g.terrain.isWater(p, 0.6),
    townAt: (p) => {
      const t = g.towns.find((x) => Math.hypot(p.x - x.center.x, p.y - x.center.y) < (x.extent ?? x.radius) + 20);
      return t ? { paved: townTier(t) !== 'village', key: `${t.id}` } : null;
    },
  };
  const net = sidewalkNet(g.roads.net, site);

  it('по обе стороны улиц, где рядом дома: в городе мощёные, в селе тропинки; у бордюра, не на проезжей части', () => {
    const streets = net.lines.filter((l) => l.key.startsWith('c'));
    expect(streets.filter((l) => l.paved).length).toBeGreaterThan(80);
    expect(streets.filter((l) => !l.paved).length).toBeGreaterThan(5);
    let points = 0;
    for (const l of streets) {
      const own = g.roads.net.corridor(Number(l.key.slice(1)));
      for (const w of l.paths) {
        for (let i = 0; i < w.length; i += 2) {
          const p = { x: w[i], y: w[i + 1] };
          points++;
          const hit = own.lut.closest(p);
          expect(hit.d, `тротуар на полотне ${own.id}`).toBeGreaterThan(halfAtS(own, hit.s) + 0.5);
          expect(hit.d).toBeLessThan(halfAtS(own, hit.s) + 4);
        }
      }
    }
    expect(points).toBeGreaterThan(2000);
  });

  it('у узлов тротуары сходятся скруглением угла: дуга начинается и кончается у концов тротуаров улиц; концы — по узлу', () => {
    const corners = net.lines.filter((l) => l.key.startsWith('n'));
    expect(corners.length).toBeGreaterThan(30);
    let joined = 0;
    for (const l of corners) {
      const node = Number(l.key.slice(1));
      const ends = sidewalkEnds(net, node);
      expect(ends.length).toBeGreaterThanOrEqual(2);
      for (const arc of l.paths) {
        const near = (x: number, y: number) => ends.some((e) => Math.hypot(e.x - x, e.y - y) < 0.6);
        expect(near(arc[0], arc[1])).toBe(true);
        expect(near(arc[arc.length - 2], arc[arc.length - 1])).toBe(true);
        joined++;
      }
    }
    expect(joined).toBeGreaterThan(50);
    // Концы — по обе стороны улицы у узла: между ними ляжет переход.
    const byStreet = new Map<string, Set<number>>();
    for (const e of net.ends) {
      const k = `${e.node}:${e.corridor}`;
      if (!byStreet.has(k)) byStreet.set(k, new Set());
      byStreet.get(k)!.add(e.side);
    }
    expect([...byStreet.values()].filter((s) => s.size === 2).length).toBeGreaterThan(50);
  });

  it('издали не видны, ближе — одна обводка на вид, без фильтров; кэш по полотнам — то же без пересчёта', () => {
    const all = { x0: -1e6, y0: -1e6, x1: 1e6, y1: 1e6 };
    const far = stub();
    drawSidewalks(far.ctx, net.lines, all, 0.15);
    expect(total(far.calls)).toBe(0);
    const near = stub();
    drawSidewalks(near.ctx, net.lines, all, 0.8);
    expect(near.calls.stroke).toBe(4);
    expect(near.set.has('filter')).toBe(false);
    const cache = new Map();
    const a = sidewalkNet(g.roads.net, site, cache);
    const b = sidewalkNet(g.roads.net, site, cache);
    expect(b.lines.map((l) => l.sig)).toEqual(a.lines.map((l) => l.sig));
    expect(a.lines.map((l) => l.sig)).toEqual(net.lines.map((l) => l.sig));
  });
});

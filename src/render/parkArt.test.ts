import { describe, expect, it } from 'vitest';
import { freshGame } from '../game/testkit';
import type { ParkKind, TownPark } from '../world/entities';
import { NEW_GAME_SETTINGS } from '../world/settings';
import { townTier } from '../world/townForms';
import { corridorHalf, halfAtS } from '../world/worldgen';
import { drawParkArt, drawSidewalks, drawStreetGreen, streetGreen, type WalkSite } from './parkArt';
import { LAMPS_ON } from './townDecor';

/** Холст-заглушка: сколько раз позван каждый метод и какие свойства выставлялись. */
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

const SIZES: Record<ParkKind, [number, number]> = { park: [100, 72], square: [26, 20], plaza: [60, 28], memorial: [24, 18], embankment: [34, 13] };
const park = (kind: ParkKind, id = 1203): TownPark => ({ id, kind, fp: { center: { x: 500, y: 400 }, w: SIZES[kind][0], h: SIZES[kind][1], angle: 0.3 } });
const total = (c: Record<string, number>) => Object.values(c).reduce((s, n) => s + n, 0);

describe('Парки и скверы — рисунок', () => {
  it('каждый вид рисуется на любом зуме; ближе — больше деталей; без фильтров и размытия', () => {
    for (const kind of Object.keys(SIZES) as ParkKind[]) {
      const runs = [0.15, 0.4, 0.8, 2].map((z) => {
        const s = stub();
        drawParkArt(s.ctx, park(kind), z);
        return s;
      });
      for (let i = 1; i < runs.length; i++) expect(total(runs[i].calls), `${kind} ${i}`).toBeGreaterThanOrEqual(total(runs[i - 1].calls));
      expect(total(runs[3].calls), kind).toBeGreaterThan(total(runs[0].calls));
      for (const s of runs) {
        expect(s.set.has('filter'), kind).toBe(false);
        expect(s.set.has('shadowBlur'), kind).toBe(false);
        expect(s.calls.save).toBe(s.calls.restore);
      }
    }
  });

  it('раскладка — по id парка: тот же парк рисуется так же, другой — иначе', () => {
    const a = stub();
    drawParkArt(a.ctx, park('park', 1203), 0.8);
    const b = stub();
    drawParkArt(b.ctx, park('park', 1203), 0.8);
    const c = stub();
    drawParkArt(c.ctx, park('park', 1207), 0.8);
    expect(b.calls).toEqual(a.calls);
    expect(c.calls).not.toEqual(a.calls);
  });
});

describe('Аллеи, фонари и тротуары вдоль улиц', { timeout: 30_000 }, () => {
  it('деревья — вдоль проспектов, у тротуара, не на полотнах; фонари пока выключены', () => {
    const g = freshGame({ ...NEW_GAME_SETTINGS, seed: 1 });
    const lines = streetGreen(g.roads.net, g.towns, (p, r) => g.index.at(p, r) !== null);
    const trees = lines.reduce((n, l) => n + l.trees.length / 3, 0);
    const lamps = lines.reduce((n, l) => n + l.lamps.length / 2, 0);
    expect(trees).toBeGreaterThan(50);
    // Освещение вернётся вместе с ночным режимом (LAMPS_ON).
    expect(lamps).toBe(LAMPS_ON ? lamps : 0);
    // Без застройки рядом (site) — без тротуаров.
    expect(lines.every((l) => !l.walks.length)).toBe(true);
    for (const l of lines) {
      const own = g.roads.net.corridor(l.id);
      if (l.trees.length) expect(own.cls).toBe('avenue');
      for (let i = 0; i < l.trees.length; i += 3) {
        const p = { x: l.trees[i], y: l.trees[i + 1] };
        for (const c of g.roads.net.corridorsNear(p, 40)) expect(c.lut.closest(p).d, `дерево на полотне ${c.id}`).toBeGreaterThan(corridorHalf(c) - 0.5);
        expect(g.index.at(p, 0)).toBeNull();
      }
    }
    // Вблизи деревья — с бликами: вызовов больше.
    const far = stub();
    drawStreetGreen(far.ctx, lines, { x0: -1e6, y0: -1e6, x1: 1e6, y1: 1e6 }, 0.4);
    const near = stub();
    drawStreetGreen(near.ctx, lines, { x0: -1e6, y0: -1e6, x1: 1e6, y1: 1e6 }, 2);
    expect(total(near.calls)).toBeGreaterThan(total(far.calls));
  });

  it('тротуары — по обе стороны улиц, где рядом дома: в городе мощёные, в селе тропинки; не на полотнах и не в воде', () => {
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
    const lines = streetGreen(g.roads.net, g.towns, (p, r) => g.index.at(p, r) !== null, undefined, site);
    const walked = lines.filter((l) => l.walks.length);
    expect(walked.filter((l) => l.paved).length).toBeGreaterThan(100);
    expect(walked.filter((l) => !l.paved).length).toBeGreaterThan(5);
    let points = 0;
    for (const l of walked) {
      const own = g.roads.net.corridor(l.id);
      for (const w of l.walks) {
        for (let i = 0; i < w.length; i += 2) {
          const p = { x: w[i], y: w[i + 1] };
          points++;
          // Ось тротуара — за краем своего полотна (тротуар у бордюра, а не на проезжей части).
          const hit = own.lut.closest(p);
          expect(hit.d, `тротуар на полотне ${own.id}`).toBeGreaterThan(halfAtS(own, hit.s) + 0.5);
          expect(hit.d).toBeLessThan(halfAtS(own, hit.s) + 4);
        }
      }
    }
    expect(points).toBeGreaterThan(2000);
    // Тротуары — только вблизи: издали их не видно, ближе — одна обводка на вид (мощёные и тропинки).
    const all = { x0: -1e6, y0: -1e6, x1: 1e6, y1: 1e6 };
    const far = stub();
    drawSidewalks(far.ctx, lines, all, 0.15);
    expect(total(far.calls)).toBe(0);
    const near = stub();
    drawSidewalks(near.ctx, lines, all, 0.8);
    expect(near.calls.stroke).toBe(4);
    expect(near.set.has('filter')).toBe(false);
  });
});

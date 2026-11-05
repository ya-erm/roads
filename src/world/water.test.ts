import { describe, expect, it } from 'vitest';
import { Rng } from '../core/rng';
import { closestOnSegment, dist, norm, sub, Vec } from '../core/vec';
import { waterRings } from '../render/relief';
import { DEFAULT_SETTINGS } from './settings';
import { Terrain } from './terrain';

const settings = (relief: 'plains' | 'hills' | 'mountains' | undefined, seed = 7) => ({
  ...DEFAULT_SETTINGS,
  seed,
  size: 'small' as const,
  water: 'wet' as const,
  relief,
});

/** Высота рельефа без спуска к воде — по ней и строятся берега. */
const raw = (t: Terrain, p: Vec) => t['rawHeightAt'](p);

/** От точки p в воде по направлению dir до берега, м (шагом 2 м). */
function toShore(t: Terrain, p: Vec, dir: Vec, max = 2000): number {
  for (let s = 0; s < max; s += 2) if (!t.isWater({ x: p.x + dir.x * s, y: p.y + dir.y * s })) return s;
  return max;
}

describe('Вода по рельефу', () => {
  it('без рельефа реки и озёра прежние: русло постоянной ширины, озеро — круг', () => {
    const t = new Terrain(new Rng(7), settings(undefined));
    expect(t.waterField()).toBeNull();
    for (const l of t.lakes) {
      expect(t.isWater({ x: l.center.x + l.radius - 1, y: l.center.y })).toBe(true);
      const out = { x: l.center.x, y: l.center.y - l.radius - 1 };
      expect(t.isWater(out)).toBe(t.riverDistance(out) < 0 || t.lakes.some((o) => dist(out, o.center) < o.radius));
    }
  });

  it('ширина реки меняется вдоль течения, русло нигде не прерывается', () => {
    for (const relief of ['plains', 'hills', 'mountains'] as const) {
      const t = new Terrain(new Rng(7), settings(relief));
      // Сглаживание берега не рвёт и узкие притоки.
      for (const river of t.rivers) for (const p of river.points) if (t.inBounds(p, 20)) expect(t.isWater(p)).toBe(true);
      const r = t.rivers[0];
      const widths: number[] = [];
      for (let i = 1; i < r.points.length - 1; i++) {
        const p = r.points[i];
        if (!t.inBounds(p, 200)) continue;
        expect(t.isWater(p)).toBe(true);
        if (i % 5) continue;
        const d = norm(sub(r.points[i + 1], r.points[i - 1]));
        const n = { x: -d.y, y: d.x };
        widths.push(toShore(t, p, n) + toShore(t, p, { x: -n.x, y: -n.y }));
      }
      const sorted = [...widths].sort((a, b) => a - b);
      const lo = sorted[Math.floor(sorted.length * 0.1)];
      const hi = sorted[Math.floor(sorted.length * 0.9)];
      // Не везде одинаковая: узкие места и разливы.
      expect(hi / lo).toBeGreaterThan(1.4);
      // Но и не меньше половины заданной ширины.
      expect(sorted[0]).toBeGreaterThan(r.width * 0.4);
    }
  });

  it('река разливается по низкому берегу и не лезет на крутой', () => {
    const t = new Terrain(new Rng(42), settings('hills', 42));
    let wide = 0;
    let uphill = 0;
    for (let x = 0; x <= t.width; x += 16) {
      for (let y = 0; y <= t.height; y += 16) {
        const p = { x, y };
        if (!t.isWater(p) || t.lakes.some((l) => dist(p, l.center) < l.radius * 3)) continue;
        // Ближайшая река и место на её русле.
        let best = { d: Infinity, r: t.rivers[0], s: 0 };
        for (const r of t.rivers) {
          for (let i = 0; i < r.points.length - 1; i++) {
            const c = closestOnSegment(p, r.points[i], r.points[i + 1]);
            if (c.d < best.d) best = { d: c.d, r, s: i };
          }
        }
        // Вода далеко за обычной шириной русла — это разлив по низине.
        if (best.d < best.r.width) continue;
        wide++;
        const near = best.r.points.slice(Math.max(0, best.s - 6), best.s + 7);
        const level = near.reduce((sum, q) => sum + raw(t, q), 0) / near.length;
        if (raw(t, p) > level + t.amplitude * 0.08) uphill++;
      }
    }
    expect(wide).toBeGreaterThan(50);
    // Разливы — на уровне реки, а не на склонах выше неё (берег скруглён и сглажен — чуть выше бывает).
    expect(uphill / wide).toBeLessThan(0.05);
  });

  it('озеро — не круг: берег идёт по горизонтали рельефа', () => {
    const t = new Terrain(new Rng(42), settings('hills', 42));
    expect(t.lakes.length).toBeGreaterThan(2);
    let shaped = 0;
    for (const l of t.lakes) {
      if (!t.isWater(l.center)) continue;
      const reach: number[] = [];
      const shore: number[] = [];
      for (let a = 0; a < 32; a++) {
        const dir = { x: Math.cos((a * Math.PI) / 16), y: Math.sin((a * Math.PI) / 16) };
        const s = toShore(t, l.center, dir, l.radius * 4);
        reach.push(s);
        if (s < l.radius * 2.4) shore.push(raw(t, { x: l.center.x + dir.x * s, y: l.center.y + dir.y * s }));
      }
      const min = Math.min(...reach);
      const max = Math.max(...reach);
      if (max / min > 1.3) shaped++;
      // Точки берега почти на одной высоте (той, до которой налита вода).
      const mean = shore.reduce((s, v) => s + v, 0) / shore.length;
      const spread = Math.sqrt(shore.reduce((s, v) => s + (v - mean) ** 2, 0) / shore.length);
      expect(spread).toBeLessThan(t.amplitude * 0.03);
    }
    expect(shaped).toBeGreaterThan(t.lakes.length / 2);
  });

  it('берег плавный: без зубцов, ступенек и острых мысов', () => {
    for (const [seed, relief] of [
      [7, 'mountains'],
      [42, 'hills'],
      [11, 'plains'],
    ] as const) {
      const t = new Terrain(new Rng(seed), settings(relief, seed));
      let worst = 0;
      let n = 0;
      for (const ring of waterRings(t)) {
        // Точки берега через 16 м: угол поворота между соседними кусками.
        const pts = [ring[0]];
        let run = 0;
        for (let i = 1; i < ring.length; i++) {
          run += Math.hypot(ring[i][0] - ring[i - 1][0], ring[i][1] - ring[i - 1][1]);
          if (run >= 16) {
            pts.push(ring[i]);
            run = 0;
          }
        }
        for (let i = 1; i < pts.length - 1; i++) {
          const [x, y] = pts[i];
          // У края карты контур замыкается по рамке — там углы законные.
          if (!t.inBounds({ x, y }, 20)) continue;
          const a = Math.atan2(y - pts[i - 1][1], x - pts[i - 1][0]);
          const b = Math.atan2(pts[i + 1][1] - y, pts[i + 1][0] - x);
          let turn = Math.abs(b - a);
          if (turn > Math.PI) turn = 2 * Math.PI - turn;
          worst = Math.max(worst, (turn * 180) / Math.PI);
          n++;
        }
      }
      expect(n).toBeGreaterThan(1000);
      // Радиус изгиба берега не меньше ~35 м: на 16 м он поворачивает не больше чем на 27°.
      expect(worst).toBeLessThan(27);
    }
  });

  it('контур воды на карте совпадает с тем, где вода для стройки', () => {
    const t = new Terrain(new Rng(42), settings('hills', 42));
    const rings = waterRings(t);
    expect(rings.length).toBeGreaterThan(0);
    let n = 0;
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i += 7) {
        const p = { x: ring[i][0], y: ring[i][1] };
        if (!t.inBounds(p, 1)) continue;
        n++;
        expect(t.isWater(p, 4) && !t.isWater(p, -4)).toBe(true);
      }
    }
    expect(n).toBeGreaterThan(200);
  });

  it('вода детерминирована по seed', () => {
    const a = new Terrain(new Rng(9), settings('mountains', 9));
    const b = new Terrain(new Rng(9), settings('mountains', 9));
    for (let x = 0; x < a.width; x += 97) for (let y = 0; y < a.height; y += 89) expect(a.isWater({ x, y }, 20)).toBe(b.isWater({ x, y }, 20));
    expect(a.lakes.map((l) => l.center)).toEqual(b.lakes.map((l) => l.center));
    expect(dist(a.rivers[0].points[5], b.rivers[0].points[5])).toBe(0);
  });
});

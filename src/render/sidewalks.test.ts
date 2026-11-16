import { describe, expect, it } from 'vitest';
import type { Vec } from '../core/vec';
import { freshGame } from '../game/testkit';
import { edgesAt, junctionCuts, plateOutline, pointOff } from '../lanes/geometry';
import { ROAD_MARGIN } from '../world/roadTypes';
import { NEW_GAME_SETTINGS } from '../world/settings';
import { townTier } from '../world/townForms';
import { halfAtS } from '../world/worldgen';
import { drawSidewalks, SIDEWALK, sidewalkEnds, sidewalkNet, type WalkSite } from './sidewalks';

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

  it('у узлов тротуары сходятся скруглением угла: дуга начинается у конца тротуара улицы, кончается у другого (или за скруглением); концы — по узлу', () => {
    const corners = net.lines.filter((l) => l.key.startsWith('n'));
    expect(corners.length).toBeGreaterThan(30);
    let joined = 0;
    let both = 0;
    for (const l of corners) {
      const node = Number(l.key.slice(1));
      const ends = sidewalkEnds(net, node);
      expect(ends.length).toBeGreaterThanOrEqual(1);
      for (const arc of l.paths) {
        const near = (x: number, y: number) => ends.some((e) => Math.hypot(e.x - x, e.y - y) < 0.6);
        const a = near(arc[0], arc[1]);
        const b = near(arc[arc.length - 2], arc[arc.length - 1]);
        expect(a || b).toBe(true);
        if (a && b) both++;
        joined++;
      }
    }
    expect(joined).toBeGreaterThan(50);
    expect(both / joined).toBeGreaterThan(0.8);
    // Концы — по обе стороны улицы у узла: между ними ляжет переход.
    const byStreet = new Map<string, Set<number>>();
    for (const e of net.ends) {
      const k = `${e.node}:${e.corridor}`;
      if (!byStreet.has(k)) byStreet.set(k, new Set());
      byStreet.get(k)!.add(e.side);
    }
    expect([...byStreet.values()].filter((s) => s.size === 2).length).toBeGreaterThan(50);
  });

  it('вплотную к асфальту по его контуру: вдоль полотна и по бордюру угла площадки — на одном расстоянии (без клина травы)', () => {
    const roads = g.roads.net;
    const cuts = junctionCuts(roads);
    const toSeg = (p: Vec, a: Vec, b: Vec) => {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
      return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t);
    };
    const toLine = (p: Vec, pts: Vec[]) => {
      let best = Infinity;
      for (let i = 0; i + 1 < pts.length; i++) best = Math.min(best, toSeg(p, pts[i], pts[i + 1]));
      return best;
    };
    let inside = 0;
    let all = 0;
    let corners = 0;
    for (const l of net.lines) {
      const spec = l.paved ? SIDEWALK.paved : SIDEWALK.path;
      const want = spec.from + spec.w / 2;
      // Край асфальта рядом: у полотна — его кромки (как рисуются), у перекрёстка — бордюры площадки.
      const edges: Vec[][] = [];
      if (l.key.startsWith('c')) {
        const c = roads.corridor(Number(l.key.slice(1)));
        const [ca, cb] = cuts.get(c.id)!;
        const n = 400;
        for (const side of [0, 1] as const) {
          const pts: Vec[] = [];
          for (let i = 0; i <= n; i++) {
            const s = ca + ((c.length - ca - cb) * i) / n;
            const e = edgesAt(c, s);
            if (e) pts.push(pointOff(c, s, side ? e[1] + ROAD_MARGIN : e[0] - ROAD_MARGIN));
          }
          edges.push(pts);
        }
      } else {
        const node = roads.node(Number(l.key.slice(1)));
        if (node.kind !== 'junction') continue;
        edges.push(...plateOutline(roads, node, cuts)!.curbs.map((k) => k.pts));
        corners += l.paths.length;
      }
      for (const w of l.paths) {
        for (let i = 0; i < w.length; i += 2) {
          const d = Math.min(...edges.map((e) => toLine({ x: w[i], y: w[i + 1] }, e)));
          all++;
          if (Math.abs(d - want) < 0.3) inside++;
        }
      }
    }
    expect(all).toBeGreaterThan(3000);
    expect(corners).toBeGreaterThan(50);
    // Почти все точки — ровно на полширины тротуара от края; мимо — лишь у самых острых углов (бордюр круче тротуара).
    expect(inside / all).toBeGreaterThan(0.99);
  });

  it('на углу перекрёстка — непрерывная полоса вдоль всего бордюра: от тротуара одной улицы до другой (или до прямого края улицы без тротуара)', () => {
    const roads = g.roads.net;
    const cuts = junctionCuts(roads);
    let curbs = 0;
    let single = 0;
    for (const n of roads.nodes.values()) {
      if (n.kind !== 'junction') continue;
      const ends = sidewalkEnds(net, n.id);
      if (!ends.length) continue;
      const line = net.lines.find((l) => l.key === `n${n.id}`);
      const spec = line?.paved === false ? SIDEWALK.path : SIDEWALK.paved;
      const d = spec.from + spec.w / 2;
      for (const k of plateOutline(roads, n, cuts)?.curbs ?? []) {
        const si = k.from.end === 'a' ? 1 : -1;
        const sj = k.to.end === 'a' ? -1 : 1;
        const A = ends.find((e) => e.corridor === k.from.corridor.id && e.side === si);
        const B = ends.find((e) => e.corridor === k.to.corridor.id && e.side === sj);
        if (!A && !B) continue;
        // Дуга над водой не рисуется.
        const pts = k.pts;
        if (g.terrain.isWater(pts[Math.floor(pts.length / 2)], 0.6)) continue;
        curbs++;
        if (!A || !B) single++;
        const first = pts[0];
        const last = pts[pts.length - 1];
        const at = (p: number[], i: number) => ({ x: p[i], y: p[i + 1] });
        // Полоса, что начинается у начала бордюра и кончается у его конца — на d от края асфальта.
        const arc = line?.paths.find((p) => Math.abs(Math.hypot(p[0] - first.x, p[1] - first.y) - d) < 0.3 && Math.abs(Math.hypot(p[p.length - 2] - last.x, p[p.length - 1] - last.y) - d) < 0.3);
        expect(arc, `угол у узла ${n.id}: ${k.from.corridor.id} → ${k.to.corridor.id}`).toBeTruthy();
        if (!arc) continue;
        // Без разрывов и клиньев: у каждой точки бордюра полоса — на d от него (по касательной, а не срезом).
        for (const q of pts) {
          let best = Infinity;
          for (let i = 0; i + 3 < arc.length; i += 2) {
            const a = at(arc, i);
            const b = at(arc, i + 2);
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const l2 = dx * dx + dy * dy;
            const t = l2 > 0 ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2)) : 0;
            best = Math.min(best, Math.hypot(q.x - a.x - dx * t, q.y - a.y - dy * t));
          }
          expect(best).toBeLessThan(d + 0.3);
        }
      }
    }
    expect(curbs).toBeGreaterThan(100);
    // Есть и углы, где тротуар только у одной улицы: их тоже обходит полоса.
    expect(single).toBeGreaterThan(0);
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

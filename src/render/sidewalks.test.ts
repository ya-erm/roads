import { describe, expect, it } from 'vitest';
import type { Vec } from '../core/vec';
import { freshGame } from '../game/testkit';
import { setCornerRadius } from '../lanes/corners';
import { edgesAt, junctionCorners, junctionCuts, plateOutline, pointOff } from '../lanes/geometry';
import { ROAD_MARGIN } from '../world/roadTypes';
import { NEW_GAME_SETTINGS } from '../world/settings';
import { type Footprint, pointInFootprint } from '../world/spatial';
import { curbGap } from '../world/worldgen';
import { drawSidewalks, mergeSidewalks, SIDEWALK, type SidewalkNet, sidewalkEnds, sidewalkNet, sidewalkScope, walkSite } from './sidewalks';

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
  // Как в игре (renderer): дома, ратуша, парки и скверы городов.
  const site = walkSite(g);
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
          // От кромки своей стороны: полоса стоянки бывает только с одной стороны улицы.
          const gap = curbGap(own, p);
          expect(gap, `тротуар на полотне ${own.id}`).toBeGreaterThan(0.5);
          expect(gap).toBeLessThan(4);
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

  // Улицы с тротуарами по правилам sidewalkNet: улица, проспект или грунтовка на земле в черте города.
  const roads = g.roads.net;
  const cuts = junctionCuts(roads);
  const streets = [...roads.corridors.values()].filter(
    (c) => !c.build && !c.ring && ['street', 'avenue', 'dirt'].includes(c.cls) && roads.node(c.a).level === 0 && roads.node(c.b).level === 0 && site.townAt(c.lut.pointAt(c.length / 2)),
  );
  const toSeg = (p: Vec, a: Vec, b: Vec) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t);
  };
  const onPath = (q: Vec, list: readonly number[][] | undefined, d: number) =>
    !!list?.some((p) => {
      for (let i = 0; i + 3 < p.length; i += 2) if (toSeg(q, { x: p[i], y: p[i + 1] }, { x: p[i + 2], y: p[i + 3] }) < d) return true;
      return false;
    });
  /** Ось тротуара стороны side полотна c на s (как sidewalks.walkOff). */
  const axis = (c: (typeof streets)[number], s: number, side: 1 | -1) => {
    const spec = site.townAt(c.lut.pointAt(c.length / 2))!.paved ? SIDEWALK.paved : SIDEWALK.path;
    const d = ROAD_MARGIN + spec.from + spec.w / 2;
    const e = edgesAt(c, s)!;
    return pointOff(c, s, side === 1 ? e[1] + d : e[0] - d);
  };
  /** Там тротуара не бывает: вода, станция, предприятие, база. */
  const off = (q: Vec) => site.wet(q) || g.index.near(q, 10).some((x) => x.type !== 'building' && pointInFootprint(q, x.fp, SIDEWALK.paved.w / 2 + 1));
  const lots: Footprint[] = g.towns.flatMap((t) => [...t.buildings.map((b) => b.fp), ...(t.parks ?? []).map((k) => k.fp)]);
  const toLot = (q: Vec, f: Footprint) => {
    const dx = q.x - f.center.x;
    const dy = q.y - f.center.y;
    const lx = Math.abs(dx * Math.cos(f.angle) + dy * Math.sin(f.angle)) - f.w / 2;
    const ly = Math.abs(-dx * Math.sin(f.angle) + dy * Math.cos(f.angle)) - f.h / 2;
    return Math.hypot(Math.max(0, lx), Math.max(0, ly));
  };

  it('вдоль застроенной улицы — сплошной: у участков (дома, ратуша, парки) тротуар есть везде, разрывы — не короче участка', () => {
    let checked = 0;
    const miss: string[] = [];
    const holes: string[] = [];
    for (const c of streets) {
      const own = net.lines.find((l) => l.key === `c${c.id}`)?.paths;
      const [ca, cb] = cuts.get(c.id)!;
      for (const side of [1, -1] as const) {
        // Участок ближе 25 м к оси тротуара — тротуар есть.
        for (let s = ca + 2; s <= c.length - cb - 2; s += 2) {
          const q = axis(c, s, side);
          if (off(q) || !lots.some((f) => Math.abs(f.center.x - q.x) < 160 && Math.abs(f.center.y - q.y) < 160 && toLot(q, f) < 25)) continue;
          checked++;
          if (!onPath(q, own, 1)) miss.push(`${c.id}/${side} s=${s.toFixed(0)}`);
        }
        // Куски одной стороны: между ними — не меньше пустого участка (WALK.hole, 50 м), если там не вода и не станция.
        const parts = (own ?? [])
          .map((p) => {
            const a = c.lut.closest({ x: p[0], y: p[1] });
            const b = c.lut.closest({ x: p[p.length - 2], y: p[p.length - 1] });
            const t = c.lut.tangentAt(a.s);
            const sd = t.x * (p[1] - a.point.y) - t.y * (p[0] - a.point.x) >= 0 ? 1 : -1;
            return { s0: Math.min(a.s, b.s), s1: Math.max(a.s, b.s), sd };
          })
          .filter((x) => x.sd === side)
          .sort((x, y) => x.s0 - y.s0);
        for (let i = 1; i < parts.length; i++) {
          const gap = parts[i].s0 - parts[i - 1].s1;
          if (gap >= 47) continue;
          let free = true;
          for (let s = parts[i - 1].s1; s <= parts[i].s0; s += 1) if (off(axis(c, s, side))) free = false;
          if (free) holes.push(`${c.id}/${side} ${gap.toFixed(0)} м`);
        }
      }
    }
    expect(checked).toBeGreaterThan(3000);
    expect(miss).toEqual([]);
    expect(holes).toEqual([]);
  });

  it('тротуар, что подходит к перекрёстку ближе 60 м, доходит до угла; угол обходится дугой от тротуара улицы до тротуара другой', () => {
    let corners = 0;
    let both = 0;
    const short: string[] = [];
    const missing: string[] = [];
    for (const n of roads.nodes.values()) {
      if (n.kind !== 'junction') continue;
      const ends = sidewalkEnds(net, n.id);
      const arcs = net.lines.find((l) => l.key === `n${n.id}`)?.paths ?? [];
      for (const k of plateOutline(roads, n, cuts)?.curbs ?? []) {
        // Стороны улиц, что смотрят на угол (как в sidewalkNet): у начала бордюра — левая от узла, у конца — правая.
        const sides = [
          { e: k.from, side: (k.from.end === 'a' ? 1 : -1) as 1 | -1 },
          { e: k.to, side: (k.to.end === 'a' ? -1 : 1) as 1 | -1 },
        ];
        let near = 0;
        let reached = 0;
        for (const { e, side } of sides) {
          const c = e.corridor;
          const spans = net.spans.get(c.id)?.filter((w) => w.side === side) ?? [];
          const [ca, cb] = cuts.get(c.id)!;
          // Тротуар этой стороны подходит к узлу ближе 60 м (от обреза площадки)?
          const close = e.end === 'a' ? spans.some((w) => w.s0 <= ca + 60) : spans.some((w) => w.s1 >= c.length - cb - 60);
          if (!close) continue;
          near++;
          const end = ends.find((x) => x.corridor === c.id && x.side === side);
          if (end) {
            reached++;
            continue;
          }
          // Не дошёл — только если путь к углу перекрыт (вода, станция).
          let free = true;
          for (let d = 0; d <= 60; d += 1) {
            const s = e.end === 'a' ? ca + d : c.length - cb - d;
            if (s < 0 || s > c.length) break;
            if (off(axis(c, s, side))) free = false;
          }
          if (free) short.push(`${n.id}: ${c.id}/${side}`);
        }
        if (!near) continue;
        if (!reached || g.terrain.isWater(k.pts[Math.floor(k.pts.length / 2)], 0.6)) continue;
        corners++;
        if (reached === 2) both++;
        // Дуга вдоль бордюра — от его начала до конца.
        const pts = k.pts;
        const mid = pts[Math.floor(pts.length / 2)];
        if (!onPath(mid, arcs, SIDEWALK.paved.from + SIDEWALK.paved.w / 2 + 0.6)) missing.push(`${n.id}: ${k.from.corridor.id} → ${k.to.corridor.id}`);
      }
    }
    expect(short).toEqual([]);
    expect(missing).toEqual([]);
    expect(corners).toBeGreaterThan(100);
    expect(both / corners).toBeGreaterThan(0.85);
    // Шов и поворот улицы (узел двух улиц): тротуар, дошедший до узла по одной, продолжен по другой, если у неё с этой
    // стороны тротуар подходит ближе 60 м.
    const ids = new Set(streets.map((c) => c.id));
    let seams = 0;
    const broken: string[] = [];
    for (const n of roads.nodes.values()) {
      const two = roads.ends(n);
      if (two.length !== 2 || !two.every((e) => ids.has(e.corridor.id))) continue;
      const ends = sidewalkEnds(net, n.id);
      for (const [x, y] of [two, [two[1], two[0]]]) {
        // Левая (от узла) сторона одной улицы продолжается правой стороной другой.
        const sx = (x.end === 'a' ? 1 : -1) as 1 | -1;
        const sy = (y.end === 'a' ? -1 : 1) as 1 | -1;
        if (!ends.some((e) => e.corridor === x.corridor.id && e.side === sx)) continue;
        const c = y.corridor;
        const [ca, cb] = cuts.get(c.id)!;
        const spans = net.spans.get(c.id)?.filter((w) => w.side === sy) ?? [];
        if (!(y.end === 'a' ? spans.some((w) => w.s0 <= ca + 60) : spans.some((w) => w.s1 >= c.length - cb - 60))) continue;
        seams++;
        if (ends.some((e) => e.corridor === c.id && e.side === sy)) continue;
        let free = true;
        for (let d = 0; d <= 60; d += 1) {
          const s = y.end === 'a' ? ca + d : c.length - cb - d;
          if (s >= 0 && s <= c.length && off(axis(c, s, sy))) free = false;
        }
        if (free) broken.push(`${n.id}: ${x.corridor.id} → ${c.id}/${sy}`);
      }
    }
    expect(seams).toBeGreaterThan(50);
    expect(broken).toEqual([]);
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

  describe('во время правки — только затронутые, по сети с правкой', () => {
    const before = g.roads.net;
    const byKey = (n: SidewalkNet) => new Map(n.lines.map((l) => [l.key, l.sig]));
    const endsKey = (n: SidewalkNet) => n.ends.map((e) => `${e.node}|${e.corridor}|${e.side}|${e.x.toFixed(2)},${e.y.toFixed(2)}`).sort();
    const spansKey = (n: SidewalkNet) => [...n.spans].sort((a, b) => a[0] - b[0]).map(([id, s]) => `${id}:${JSON.stringify(s)}`);
    // Перекрёсток в городе, где у всех улиц тротуары: скругления у него есть.
    const hub = [...before.nodes.values()].find(
      (n) => n.kind === 'junction' && n.corridors.length >= 3 && net.lines.some((l) => l.key === `n${n.id}`) && n.corridors.every((id) => net.spans.has(id)),
    )!;

    /** Часть по scope совпадает с полным пересчётом сети с правкой; поверх прежних — ровно он же (ничего не забыто). */
    const check = (next: typeof before) => {
      const scope = sidewalkScope(before, next)!;
      expect(scope).not.toBeNull();
      const full = sidewalkNet(next, site);
      const part = sidewalkNet(next, site, new Map(), scope);
      const fullKeys = byKey(full);
      const partKeys = byKey(part);
      for (const [k, sig] of partKeys) expect(sig, k).toBe(fullKeys.get(k));
      for (const [k, sig] of fullKeys) if ((k[0] === 'c' ? scope.corridors : scope.nodes).has(Number(k.slice(1)))) expect(partKeys.get(k), k).toBe(sig);
      const merged = mergeSidewalks(net, part, scope);
      expect(byKey(merged)).toEqual(fullKeys);
      expect(endsKey(merged)).toEqual(endsKey(full));
      expect(spansKey(merged)).toEqual(spansKey(full));
      return { scope, part };
    };

    it('сдвинули перекрёсток: полотна у него, их соседи по углам и дотягиванию — заново; остальное — прежнее', () => {
      expect(hub).toBeDefined();
      const next = before.clone();
      next.moveNode(hub.id, { x: hub.pos.x + 6, y: hub.pos.y + 4 });
      const { scope, part } = check(next);
      // Затронуты полотна узла и полотна у их дальних концов — не вся сеть.
      for (const id of hub.corridors) expect(scope.corridors.has(id)).toBe(true);
      expect(scope.nodes.has(hub.id)).toBe(true);
      expect(scope.corridors.size).toBeLessThan(before.corridors.size / 5);
      // Тротуары полотен узла — уже по новому месту.
      const was = byKey(net);
      expect(hub.corridors.some((id) => part.lines.find((l) => l.key === `c${id}`)?.sig !== was.get(`c${id}`))).toBe(true);
    });

    it('скруглили угол перекрёстка: заново — его скругления и тротуары его улиц', () => {
      const next = before.clone();
      const k = junctionCorners(next, next.node(hub.id))[0];
      setCornerRadius(next, hub.id, k.key, 20);
      const { scope, part } = check(next);
      expect(scope.nodes.has(hub.id)).toBe(true);
      expect(part.lines.find((l) => l.key === `n${hub.id}`)?.sig).not.toBe(byKey(net).get(`n${hub.id}`));
    });

    it('снесли улицу у перекрёстка: её тротуары прочь, у соседей — как при полном пересчёте', () => {
      const next = before.clone();
      next.removeCorridor(hub.corridors[0]);
      expect(check(next).scope.corridors.has(hub.corridors[0])).toBe(true);
    });

    it('та же сеть — правки нет', () => {
      expect(sidewalkScope(before, before)).toBeNull();
      expect(sidewalkScope(before, before.clone())).toBeNull();
    });
  });
});

import { circleArc, type Cubic, CurveLUT, straightCubic } from '../core/bezier';
import { add, dist, norm, scale, sub, type Vec } from '../core/vec';
import type { Corridor, LaneNode } from '../lanes/model';
import type { TownStyle } from './entities';
import type { TownShape, WorldContext } from './worldgen';

/**
 * Улицы города — как у настоящего небольшого города, а не кольца и не ровная решётка:
 * - старый центр: площадь с кольцом вокруг ратуши (кольцевой город) или перекрёсток главных улиц;
 * - от центра — главные улицы-выезды под неравными углами; они петляют, обходят воду и идут вдоль склонов;
 * - вдоль главных улиц — разросшиеся районы: боковые улицы разной длины (Т-перекрёстки), часть продолжается
 *   дальше, концы соседних соединяют задние улицы — кварталы разной длины; остальные — тупики;
 * - у кольцевого города — куски бульваров между соседними выездами (не кольцо целиком);
 * - в самом свободном секторе — прямоугольная сетка нового района.
 * Всё по ctx.rng — детерминированно по seed.
 */
export interface StreetKit {
  ctx: WorldContext;
  /** Узел улицы в точке (ближе 20 м — существующий); null — вода или край карты. */
  node(p: Vec): LaneNode | null;
  /** Улица a → b (кривая или прямая); null — пересекает воду или другую улицу. main — проспект. */
  street(a: LaneNode | null, b: LaneNode | null, curve: Cubic | null, main: boolean): Corridor | null;
  /** Очертания города (townShape): во сколько раз край в направлении a дальше R. */
  shape: TownShape;
}

/** Обычный радиус города по стилю и размеру, м (как у прежних колец и сеток: от него — площадь и население). */
export function streetsRadius(style: TownStyle, size: number): number {
  // Множители подобраны так, чтобы население в среднем было как у прежних колец, сеток и улиц-линий.
  if (style === 'radial') return (110 + (size >= 3 ? 3 : 2) * 140) * 1.3;
  if (style === 'organic') return (size + 0.5) * 150 * 0.94;
  return (2 + size) * 165 * 0.75;
}

/** Ближе стольких метров к чужой улице новая не идёт: между ними — дома с обеих сторон. */
const GAP = 52;

interface Chain {
  /** Узлы главной улицы от центра наружу. */
  nodes: LaneNode[];
  angle: number;
}

export function townStreets(kit: StreetKit, center: Vec, size: number, style: TownStyle): void {
  const { rng, terrain, roads } = kit.ctx;
  const R = streetsRadius(style, size);
  const radial = style === 'radial';
  const linear = style === 'linear';
  const reachAt = (p: Vec) => R * kit.shape(Math.atan2(p.y - center.y, p.x - center.x));
  const created = new Set<number>();

  /** Узел в точке; snap — притянуться к существующему узлу ближе snap. */
  const nodeNear = (p: Vec, snap = 20): LaneNode | null => {
    if (snap > 20) {
      const near = roads.nodesNear(p, snap).sort((x, y) => dist(x.pos, p) - dist(y.pos, p))[0];
      if (near) return near;
    }
    const had = roads.nodesNear(p, 20).length > 0;
    const n = kit.node(p);
    if (n && !had) created.add(n.id);
    return n;
  };
  /** Лишний узел, к которому так и не легла улица, — прочь. */
  const drop = (n: LaneNode | null) => {
    if (n && created.has(n.id) && !n.corridors.length) {
      roads.removeNode(n.id);
      created.delete(n.id);
    }
  };
  /** Место под улицу: ни одна точка не ближе GAP к чужим улицам (кроме тех, что сходятся в её концах). */
  const roomy = (a: LaneNode, b: LaneNode, curve: Cubic | null): boolean => {
    const c = curve ? { ...curve, p0: a.pos, p3: b.pos } : straightCubic(a.pos, b.pos);
    const lut = new CurveLUT(c);
    if (lut.length < 60) return false;
    const own = new Set([...a.corridors, ...b.corridors]);
    for (let i = 1; i < 8; i++) {
      const p = lut.pointAt((lut.length * i) / 8);
      const margin = Math.min(GAP, (lut.length * Math.min(i, 8 - i)) / 8);
      for (const o of roads.corridorsNear(p, GAP + 10)) if (!own.has(o.id) && o.lut.closest(p).d < margin) return false;
    }
    // Тупик не упирается вплотную в чужую улицу: либо перекрёсток с ней, либо место под дома.
    for (const n of [a, b]) {
      const mine = new Set(n.corridors);
      for (const o of roads.corridorsNear(n.pos, GAP)) if (!mine.has(o.id) && !own.has(o.id) && o.lut.closest(n.pos).d < GAP * 0.75) return false;
    }
    // Острый угол с улицами в концах — не перекрёсток, а клин без места для домов.
    for (const [n, toward] of [
      [a, lut.tangentAt(0)],
      [b, scale(lut.tangentAt(lut.length), -1)],
    ] as const) {
      for (const e of roads.ends(n)) if (e.away.x * toward.x + e.away.y * toward.y > Math.cos(0.6)) return false;
    }
    return true;
  };
  /** Улица между узлами (или точками), если ей хватает места. */
  const link = (pa: LaneNode | Vec | null, pb: LaneNode | Vec | null, curve: Cubic | null = null, main = false, snap = 20): LaneNode | null => {
    const a = pa && 'id' in pa ? pa : pa ? nodeNear(pa, 20) : null;
    const b = pb && 'id' in pb ? pb : pb ? nodeNear(pb, snap) : null;
    // Больше четырёх улиц в одном перекрёстке не сходится: такой узел — и не по-настоящему, и пробка.
    const ok = !!a && !!b && a !== b && a.corridors.length < 4 && b.corridors.length < 4 && roomy(a, b, curve) && !!kit.street(a, b, curve, main);
    if (!ok) {
      if (!(pa && 'id' in pa)) drop(a);
      if (!(pb && 'id' in pb)) drop(b);
      return null;
    }
    mine.add(a!).add(b);
    return b;
  };
  /** Узлы улиц этого города — от них растут переулки. */
  const mine = new Set<LaneNode>();
  const ok = (p: Vec, margin = 45) => terrain.inBounds(p, 100) && !terrain.isWater(p, margin);

  // ---------- Главные улицы-выезды ----------
  const count = radial ? (size >= 3 ? rng.int(5, 7) : 5) : linear ? 2 : rng.int(3, 5);
  const a0 = rng.range(0, Math.PI * 2);
  const angles: number[] = [];
  for (let i = 0; i < count; i++) {
    // Неравные углы: у линейного — навстречу друг другу, у остальных — с разбросом до трети сектора.
    const even = a0 + (i * Math.PI * 2) / count;
    angles.push(linear ? even + rng.range(-0.12, 0.12) : even + rng.range(-0.33, 0.33) * ((Math.PI * 2) / count));
  }
  // Линейному иногда — короткая поперечная улица через центр.
  if (linear && rng.chance(0.4)) angles.push(a0 + Math.PI / 2 + rng.range(-0.3, 0.3) + (rng.chance(0.5) ? Math.PI : 0));

  // Центр: площадь с кольцом (кольцевой город) или перекрёсток главных улиц.
  const starts: (LaneNode | null)[] = [];
  if (radial) {
    const rc = rng.range(95, 115);
    const sorted = angles.map((a, i) => ({ a: ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2), i })).sort((x, y) => x.a - y.a);
    const ring = sorted.map(({ a }) => nodeNear(add(center, { x: Math.cos(a) * rc, y: Math.sin(a) * rc })));
    for (let k = 0; k < sorted.length; k++) {
      const a1 = sorted[k].a;
      const a2 = k + 1 < sorted.length ? sorted[k + 1].a : sorted[0].a + Math.PI * 2;
      if (kit.street(ring[k], ring[(k + 1) % ring.length], circleArc(center, rc, a1, a2), true)) mine.add(ring[k]!).add(ring[(k + 1) % ring.length]!);
      starts[sorted[k].i] = ring[k];
    }
  } else {
    const c = nodeNear(center);
    for (let i = 0; i < angles.length; i++) starts.push(c);
  }

  const chains: Chain[] = [];
  for (let i = 0; i < angles.length; i++) {
    const start = starts[i];
    if (!start) continue;
    const cross = linear && i >= 2;
    const target = angles[i];
    // Длина — до края очертаний и дальше выездом из города (не у всех).
    const len = (cross ? R * 0.45 : R * kit.shape(target) * rng.range(0.9, 1.05)) + (rng.chance(radial ? 0.5 : 0.35) ? rng.range(60, 150) : 0);
    const pts: Vec[] = [start.pos];
    let h = target;
    let p = start.pos;
    while (dist(p, center) < len) {
      const step = rng.range(120, 165);
      h += rng.range(-0.16, 0.16) + wrap(target - h) * 0.25;
      // Обходим воду и край карты, на склоне — идём вдоль горизонталей.
      let best: Vec | null = null;
      let score = Infinity;
      for (const turn of [0, 0.3, -0.3, 0.6, -0.6]) {
        const q = add(p, { x: Math.cos(h + turn) * step, y: Math.sin(h + turn) * step });
        if (!ok(q)) continue;
        const climb = terrain.hasRelief ? Math.abs(terrain.heightAt(q) - terrain.heightAt(p)) / step : 0;
        const s = Math.abs(turn) * 0.05 + climb;
        if (s < score) {
          score = s;
          best = q;
        }
      }
      if (!best || dist(best, center) <= dist(p, center) + 40) break;
      h = Math.atan2(best.y - p.y, best.x - p.x);
      pts.push(best);
      p = best;
    }
    const nodes: LaneNode[] = [start];
    // Главные: у кольцевого большого города — две, у остальных от второго размера — одна (линейный — сквозная).
    const main = radial ? size >= 3 && i < 2 : linear ? size >= 2 && !cross : size >= 2 && i === 0;
    for (let k = 1; k < pts.length; k++) {
      const curve = catmull(pts[Math.max(0, k - 2)], pts[k - 1], pts[k], pts[Math.min(pts.length - 1, k + 1)]);
      const n = link(nodes[nodes.length - 1], pts[k], curve, main);
      if (!n) break;
      nodes.push(n);
    }
    if (nodes.length > 1) chains.push({ nodes, angle: target });
  }

  // ---------- Куски бульваров между соседними выездами ----------
  if (radial) {
    const byAngle = [...chains].sort((x, y) => norm2pi(x.angle) - norm2pi(y.angle));
    // Не больше двух кусков и не соседних, каждый на своём расстоянии: кольца вокруг центра не складываются.
    let boulevards = 0;
    let last = -2;
    let fromFirst = false;
    for (let k = 0; k < byAngle.length && boulevards < 2; k++) {
      const rb = rng.range(240, 360);
      if (k - last < 2 || (k === byAngle.length - 1 && fromFirst) || !rng.chance(0.4)) continue;
      const c1 = byAngle[k];
      const c2 = byAngle[(k + 1) % byAngle.length];
      const at = (c: Chain) => c.nodes.reduce((b, n) => (Math.abs(dist(n.pos, center) - rb) < Math.abs(dist(b.pos, center) - rb) ? n : b));
      const n1 = at(c1);
      const n2 = at(c2);
      const t1 = Math.atan2(n1.pos.y - center.y, n1.pos.x - center.x);
      let t2 = Math.atan2(n2.pos.y - center.y, n2.pos.x - center.x);
      while (t2 < t1) t2 += Math.PI * 2;
      if (t2 - t1 > 1.6 || t2 - t1 < 0.3) continue;
      const r1 = dist(n1.pos, center);
      const r2 = dist(n2.pos, center);
      const P = (a: number) => {
        const r = r1 + ((r2 - r1) * (a - t1)) / (t2 - t1);
        return add(center, { x: Math.cos(a) * r, y: Math.sin(a) * r });
      };
      if (link(n1, n2, polarArc(P, t1, t2))) {
        boulevards++;
        last = k;
        if (k === 0) fromFirst = true;
      }
    }
  }

  // ---------- Сетка нового района в самом свободном секторе ----------
  if (!linear && size >= 2 && chains.length >= 2 && rng.chance(radial ? 0.7 : 0.8)) {
    const sorted = chains.map((c) => norm2pi(c.angle)).sort((x, y) => x - y);
    let gapAt = 0;
    let gap = 0;
    for (let k = 0; k < sorted.length; k++) {
      const g = (k + 1 < sorted.length ? sorted[k + 1] : sorted[0] + Math.PI * 2) - sorted[k];
      if (g > gap) {
        gap = g;
        gapAt = sorted[k] + g / 2;
      }
    }
    const tilt = gapAt + rng.range(-0.15, 0.15);
    const u = { x: Math.cos(tilt), y: Math.sin(tilt) };
    const v = { x: -u.y, y: u.x };
    const w = rng.range(130, 170);
    const hgt = rng.range(95, 125);
    const reach = R * kit.shape(gapAt);
    const from = Math.max(radial ? 200 : 120, reach * 0.3);
    const ni = Math.max(2, Math.round((reach * 1.05 - from) / w));
    const nj = Math.max(1, Math.round(Math.min(reach * Math.sin(Math.min(gap / 2, 1.2)), 2.5 * hgt) / hgt));
    const grid = new Map<string, LaneNode | null>();
    const pos = (i: number, j: number) => add(center, add(scale(u, from + i * w), scale(v, j * hgt)));
    for (let i = 0; i <= ni; i++) {
      for (let j = -nj; j <= nj; j++) {
        const q = pos(i, j);
        grid.set(`${i}:${j}`, dist(q, center) <= reachAt(q) * 1.08 && ok(q) ? nodeNear(q) : null);
      }
    }
    for (let i = 0; i <= ni; i++) {
      for (let j = -nj; j <= nj; j++) {
        const a = grid.get(`${i}:${j}`) ?? null;
        if (!a) continue;
        link(a, grid.get(`${i + 1}:${j}`) ?? null);
        link(a, grid.get(`${i}:${j + 1}`) ?? null);
      }
    }
    // Новый район — к ближайшим главным улицам: от его углов и ближнего края.
    const loose = [...grid.values()].filter((n): n is LaneNode => !!n);
    for (const n of loose) {
      if (!n.corridors.length) drop(n);
    }
    const edge = loose.filter((n) => n.corridors.length && n.corridors.length < 4).sort((x, y) => dist(x.pos, center) - dist(y.pos, center));
    let joined = 0;
    for (const n of edge) {
      if (joined >= 3) break;
      const target = chains
        .flatMap((c) => c.nodes)
        .filter((m) => m !== n && dist(m.pos, n.pos) < 240)
        .sort((x, y) => dist(x.pos, n.pos) - dist(y.pos, n.pos))[0];
      if (target && link(n, target)) joined++;
    }
  }

  // ---------- Боковые улицы, продолжения и задние улицы вдоль главных ----------
  const dense = linear ? 0.62 : 0.78;
  for (const c of chains) {
    for (const side of [-1, 1]) {
      let prev: { e1: LaneNode; e2: LaneNode | null } | null = null;
      for (let k = 1; k < c.nodes.length; k++) {
        const n = c.nodes[k];
        const d = dist(n.pos, center);
        const nearEdge = d / Math.max(1, reachAt(n.pos));
        // С другой стороны от этого узла улица уже есть — чаще сдвигаемся к следующему: Т-перекрёстки, а не крест.
        const cross = n.corridors.length >= 3 ? 0.4 : 1;
        if (d < (radial ? 170 : 90) || nearEdge > 1.15 || !rng.chance((dense - 0.3 * Math.min(1, nearEdge)) * cross)) {
          prev = null;
          continue;
        }
        const back = c.nodes[k - 1].pos;
        const fwd = c.nodes[Math.min(c.nodes.length - 1, k + 1)].pos;
        const t = norm(sub(fwd, back));
        const turn = rng.range(-0.25, 0.25);
        const dir = rotate({ x: -t.y * side, y: t.x * side }, turn);
        const l1 = rng.range(95, 175) * (1 - 0.25 * Math.min(1, nearEdge));
        const e1 = link(n, add(n.pos, scale(dir, l1)), null, false, 45);
        if (!e1) {
          prev = null;
          continue;
        }
        // Улица идёт дальше — второй квартал вглубь (чаще у центра).
        let e2: LaneNode | null = null;
        if (rng.chance(0.55 - 0.3 * Math.min(1, nearEdge)) && dist(e1.pos, center) < reachAt(e1.pos)) {
          e2 = link(e1, add(e1.pos, scale(rotate(dir, rng.range(-0.2, 0.2)), rng.range(85, 150))), null, false, 45);
        }
        // Задние улицы: соседние боковые сходятся в квартал (Т-перекрёстки), иначе — тупики.
        if (prev && rng.chance(0.68)) {
          const span = dist(prev.e1.pos, e1.pos);
          if (span > 70 && span < 280) link(prev.e1, e1);
          if (prev.e2 && e2 && rng.chance(0.6)) {
            const s2 = dist(prev.e2.pos, e2.pos);
            if (s2 > 70 && s2 < 300) link(prev.e2, e2);
          }
        }
        prev = { e1, e2 };
      }
    }
  }

  // ---------- Переулки: город дорастает между районами ----------
  // От перекрёстков и тупиков — улицы поперёк (Т-перекрёстки) или продолжением тупика; ближе к центру — чаще.
  const infill = radial ? INFILL * 1.5 : INFILL;
  for (let round = 0; round < (radial ? INFILL_ROUNDS + 1 : INFILL_ROUNDS); round++) {
    const list = [...mine].filter((n) => n.corridors.length && n.corridors.length < 4).sort((x, y) => dist(x.pos, center) - dist(y.pos, center));
    for (const n of list) {
      const edge = dist(n.pos, center) / Math.max(1, reachAt(n.pos));
      if (edge > 1 || !rng.chance(infill * (1 - 0.6 * edge) * (n.corridors.length >= 3 ? 0.12 : 1))) continue;
      const ends = roads.ends(n);
      const dirs = ends.flatMap((e) => [rotate(e.away, Math.PI / 2), rotate(e.away, -Math.PI / 2)]);
      if (ends.length === 1) dirs.push(scale(ends[0].away, -1), scale(ends[0].away, -1));
      for (let k = 0; k < 3; k++) {
        const dir = rotate(dirs[rng.int(0, dirs.length)], rng.range(-0.2, 0.2));
        const to = add(n.pos, scale(dir, rng.range(90, 165)));
        if (dist(to, center) > reachAt(to) * 1.05) continue;
        if (link(n, to, null, false, 55)) break;
      }
    }
  }
}

/** Сколько проходов досыпки переулками и с какой вероятностью у узла (у центра) появится новый. */
const INFILL_ROUNDS = 3;
const INFILL = 0.55;

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const norm2pi = (a: number) => ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
const rotate = (v: Vec, a: number): Vec => ({ x: v.x * Math.cos(a) - v.y * Math.sin(a), y: v.x * Math.sin(a) + v.y * Math.cos(a) });

/** Отрезок кривой Катмулла-Рома между p1 и p2 с соседями p0 и p3 — плавная улица через узлы. */
function catmull(p0: Vec, p1: Vec, p2: Vec, p3: Vec): Cubic {
  return { p0: p1, p1: add(p1, scale(sub(p2, p0), 1 / 6)), p2: sub(p2, scale(sub(p3, p1), 1 / 6)), p3: p2 };
}

/** Кусок кривой в полярных координатах от угла a0 до a1 (P — точка кривой под углом): гладкий, как дуга. */
function polarArc(P: (a: number) => Vec, a0: number, a1: number): Cubic {
  const h = 1e-3;
  const d = (a: number) => scale(sub(P(a + h), P(a - h)), 1 / (2 * h));
  const t = (4 / 3) * Math.tan((a1 - a0) / 4);
  const s = P(a0);
  const e = P(a1);
  return { p0: s, p1: add(s, scale(d(a0), t)), p2: sub(e, scale(d(a1), t)), p3: e };
}

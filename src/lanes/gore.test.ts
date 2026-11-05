import { describe, expect, it } from 'vitest';
import { add, dot, rightNormal, scale, sub, Vec } from '../core/vec';
import { LANE_W, ROAD_MARGIN } from '../world/roadTypes';
import { buildRoad, laneStep, laneTipAt } from './edit';
import { GoreGeo, LaneRenderer } from './draw';
import { edgesAt, laneBand } from './geometry';
import { LaneNet, twoWay } from './model';

const HIGHWAY = { cls: 'highway' as const, lanes: twoWay(2, 2) };

/** Точка внутри многоугольника (чётность пересечений). */
function inside(p: Vec, poly: Vec[]): boolean {
  let res = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) res = !res;
  }
  return res;
}

/** Глубже всего, на сколько точка заходит на полосу какого-нибудь полотна сети (0 — ни на какую). */
function onLane(net: LaneNet, p: Vec): number {
  let worst = 0;
  for (const c of net.corridorsNear(p, 40)) {
    const hit = c.lut.closest(p);
    if (hit.s < 0.5 || hit.s > c.length - 0.5) continue;
    const off = dot(sub(p, hit.point), rightNormal(c.lut.tangentAt(hit.s)));
    for (const l of c.lanes) {
      const band = laneBand(c, l, hit.s);
      if (band) worst = Math.max(worst, Math.min(off - band[0], band[1] - off));
    }
  }
  return worst;
}

/** На сколько точка дальше края асфальта ближайшего полотна (кромка крайней полосы и обочина); 0 — на асфальте. */
function fromAsphalt(net: LaneNet, p: Vec): number {
  let best = Infinity;
  for (const c of net.corridorsNear(p, 40)) {
    const hit = c.lut.closest(p);
    const off = dot(sub(p, hit.point), rightNormal(c.lut.tangentAt(hit.s)));
    const e = edgesAt(c, hit.s);
    if (!e) continue;
    const along = Math.sqrt(Math.max(0, hit.d * hit.d - off * off));
    best = Math.min(best, Math.max(0, e[0] - ROAD_MARGIN - off, off - e[1] - ROAD_MARGIN, along));
  }
  return best;
}

/**
 * Магистраль 2+2 по дуге (bend — куда выгнута: вверх или вниз), справа по ходу на восток — съезд у четверти и въезд
 * у трёх четвертей; bend = 0 — прямая.
 */
function scene(bend: number): { net: LaneNet; gores: GoreGeo[] } {
  const net = new LaneNet();
  const [c] = buildRoad(net, { kind: 'free', pos: { x: 0, y: 0 } }, { kind: 'free', pos: { x: 1000, y: 0 } }, { ...HIGHWAY, control: bend ? { x: 500, y: bend } : undefined });
  const edge = (s: number, out = 0) => add(c.lut.pointAt(s), scale(rightNormal(c.lut.tangentAt(s)), 17.5 + out));
  // Съезд: от края у s = 250 — полоса вдоль, дальше в сторону (полого — островок длинный).
  let tip = laneTipAt(net, edge(170), 14);
  tip = laneStep(net, tip, edge(250), 'highway', 14).tip;
  expect(laneStep(net, tip, edge(420, 90), 'highway', 14).what).toBe('Съезд');
  // Въезд: из поля полого к краю у s = 780.
  const main = [...net.corridors.values()].sort((x, y) => y.length - x.length)[0];
  const far = (s: number) => add(main.lut.pointAt(s), scale(rightNormal(main.lut.tangentAt(s)), 110));
  expect(laneStep(net, laneTipAt(net, far(main.length * 0.35), 14), add(main.lut.pointAt(main.length * 0.62), scale(rightNormal(main.lut.tangentAt(main.length * 0.62)), 17.5)), 'highway', 14).what).toBe('Въезд');
  expect(net.problems()).toEqual([]);
  const r = new LaneRenderer();
  const gores = [...net.nodes.values()].flatMap((n) => (n.kind === 'seam' && !net.isDeadEnd(n) ? r.seamGores(net, n) : []));
  return { net, gores };
}

describe('Островок у стыка («ёлочка»)', () => {
  for (const [name, bend] of [
    ['прямая дорога', 0],
    ['дорога выгнута в сторону ответвлений', 260],
    ['дорога выгнута от ответвлений', -260],
  ] as const) {
    it(`${name}: контур по кромкам полос — не на полосе и внутри асфальта островка, ёлочка — по его средней линии`, () => {
      const { net, gores } = scene(bend);
      // Съезд (расходятся) и въезд (сходятся).
      expect(gores.map((g) => g.diverge).sort()).toEqual([false, true]);
      let chordOut = 0;
      for (const g of gores) {
        expect(g.length).toBeGreaterThan(30);
        // Контур краской — между кромками полос: на полосу не заходит (допуск — толщина линии).
        for (const p of g.paint) expect(onLane(net, p)).toBeLessThan(0.15);
        // И на траву не выходит: каждая точка контура — на асфальте полотен (до обочины) или островка (у носа).
        for (const p of g.paint) expect(fromAsphalt(net, p) < 0.05 || inside(p, g.asphalt)).toBe(true);
        // Вершины ёлочки на отрезке островка — внутри контура краской (по дуге, а не по хорде у начала).
        const apexes = g.hatch.filter((_, i) => i % 2 === 0).map(([a]) => a);
        const within = apexes.slice(2, Math.max(2, Math.floor((g.length - 10) / 5)));
        expect(within.length).toBeGreaterThan(3);
        for (const a of within) expect(inside(a, g.paint)).toBe(true);
        // По прямой от стыка (как раньше) на изогнутой дороге вершины уходили из островка.
        const chord = within.map((_, i) => add(g.start, scale(g.axis, (i + 2) * 5 - 4)));
        if (chord.some((a) => !inside(a, g.paint))) chordOut++;
        // Плечи — под 60° к средней линии с обеих сторон, одинаковой длины.
        for (const [a, b] of g.hatch) expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(g.armLen * Math.hypot(0.5, 0.87), 6);
      }
      // Дорога выгнута от ответвлений — островок узкий и изогнутый: прямая от стыка из него выходила.
      if (bend < 0) expect(chordOut).toBeGreaterThan(0);
      expect(LANE_W).toBe(7);
    });
  }
});

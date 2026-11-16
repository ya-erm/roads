import { describe, expect, it } from 'vitest';
import { add, closestOnSegment, dist, dot, rightNormal, scale, segmentIntersection, sub, Vec } from '../core/vec';
import { LANE_W, ROAD_MARGIN } from '../world/roadTypes';
import { buildRoad, laneStep, laneTipAt } from './edit';
import { GoreGeo, LaneRenderer } from './draw';
import { edgesAt, laneBand } from './geometry';
import { LaneNet, LaneSlot, twoWay } from './model';

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
        const within = apexes.filter((a) => Math.hypot(a.x - g.start.x, a.y - g.start.y) > 5);
        expect(within.length).toBeGreaterThan(3);
        for (const a of within) expect(inside(a, g.paint)).toBe(true);
        // По прямой от стыка (как раньше) на изогнутой дороге вершины уходили из островка.
        const chord = within.map((a) => add(g.start, scale(g.axis, Math.hypot(a.x - g.start.x, a.y - g.start.y))));
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

// ---------- Петля клеверного листа (баг-репорт «Дефект отображения разметки на развязке») ----------

type P = [number, number];
const v = ([x, y]: P): Vec => ({ x, y });
const lane = (offset: number, flow: 1 | -1, from = 0): LaneSlot => ({ offset, flow, from, to: Infinity });

/**
 * Участок из отчёта: улица 1+1 спускается с эстакады, перед стыком справа добавлена полоса, и в стыке на склоне
 * (на высоте ~4 м) с неё уходит петля — одна полоса вправо крутой дугой; внизу петля вливается в шоссе 1+1 сбоку,
 * через полосу разгона.
 */
function cloverLoop() {
  const net = new LaneNet();
  const seam = (pos: P, dir: P, level = 0) => net.addSeam(v(pos), v(dir), level);
  const road = (a: number, b: number, cls: 'street' | 'highway', lanes: LaneSlot[], c: [P, P, P, P], ports: P = [0, 0]) =>
    net.addCorridor(a, b, { cls, lanes, portA: ports[0], portB: ports[1], curve: { p0: v(c[0]), p1: v(c[1]), p2: v(c[2]), p3: v(c[3]) } });
  const up: P = [0.5225, -0.8526];
  // Наверху: улица с эстакады (уровень 1), стык на склоне, дальше — на землю; петля уходит с полосы +10,5.
  const bridge = seam([-24.604, 10.416], up, 1);
  const fork = seam([1.872, -32.787], [0.5314, -0.8471], 0.5364);
  const street = seam([32.51, -82.78], up);
  const loopEnd = seam([81.965, -11.552], [0.0989, 0.9951]);
  road(bridge.id, fork.id, 'street', [lane(-3.5, -1), lane(3.5, 1), lane(10.5, 1, 16.91)], [[-24.604, 10.416], [-15.779, -3.985], [-7.102, -18.478], [1.872, -32.787]]);
  road(fork.id, street.id, 'street', [lane(-3.5, -1), lane(3.5, 1)], [[1.872, -32.787], [12.258, -49.344], [22.298, -66.115], [32.51, -82.78]]);
  const exit = road(fork.id, loopEnd.id, 'street', [lane(0, 1)], [[10.767, -27.207], [27.599, -54.042], [78.56, -45.822], [81.965, -11.552]], [10.5, 0]);
  // Внизу: петля вливается в шоссе сбоку (порт −10,5), дальше — полоса разгона на шоссе.
  const west = seam([-125, -54.092], [0.6316, 0.7753]);
  const merge = seam([-13.333, 51.726], [0.8081, 0.5891]);
  const east = seam([61.057, 108.5], [0.7814, 0.624]);
  const loopStart = seam([53.576, 46.254], [-0.9216, 0.3881]);
  road(west.id, merge.id, 'highway', [lane(-3.5, -1), lane(3.5, 1), lane(-10.5, -1, 74.27)], [[-125, -54.092], [-92.575, -14.294], [-55.073, 21.3], [-13.333, 51.726]]);
  road(merge.id, east.id, 'highway', [lane(-3.5, -1), lane(3.5, 1)], [[-13.333, 51.726], [11.886, 70.109], [36.688, 89.038], [61.057, 108.5]]);
  const entry = road(loopStart.id, merge.id, 'street', [lane(0, 1)], [[53.576, 46.254], [30.125, 56.128], [6.824, 53.426], [-7.148, 43.241]], [0, -10.5]);
  return { net, fork, merge, exit, entry };
}

/** Холст, который запоминает линии: цвет, толщину, точки. */
function strokeRecorder() {
  const strokes: { style: string; width: number; pts: Vec[] }[] = [];
  // Каждый кусок пути (от moveTo) — отдельно: разметка всех полотен рисуется одним путём.
  let subs: Vec[][] = [];
  const state: Record<string | symbol, unknown> = {};
  const api: Record<string, (...a: number[]) => void> = {
    beginPath: () => void (subs = []),
    moveTo: (x, y) => void subs.push([{ x, y }]),
    lineTo: (x, y) => void subs[subs.length - 1].push({ x, y }),
    stroke: () => {
      for (const pts of subs) strokes.push({ style: String(state.strokeStyle), width: Number(state.lineWidth), pts });
    },
  };
  const ctx = new Proxy(state, {
    get: (t, k) => (typeof k === 'string' && k in api ? api[k] : k in t ? t[k] : () => {}),
    set: (t, k, val) => ((t[k] = val), true),
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, strokes };
}

/**
 * Где ломаные a и b пересекаются не у своих концов (дальше near от концов обеих) — крест, а не стык. Касание почти
 * вдоль (угол меньше 3°: две кромки у самой вершины пологой «V» лежат в сантиметрах друг от друга) — не крест.
 */
function crossings(a: Vec[], b: Vec[], near = 1): Vec[] {
  const ends = [a[0], a[a.length - 1], b[0], b[b.length - 1]];
  const res: Vec[] = [];
  for (let i = 0; i + 1 < a.length; i++) {
    for (let j = 0; j + 1 < b.length; j++) {
      const hit = segmentIntersection(a[i], a[i + 1], b[j], b[j + 1]);
      if (!hit || !ends.every((e) => dist(e, hit.point) > near)) continue;
      const u = sub(a[i + 1], a[i]);
      const w = sub(b[j + 1], b[j]);
      const sin = Math.abs(u.x * w.y - u.y * w.x) / (Math.hypot(u.x, u.y) * Math.hypot(w.x, w.y));
      if (sin > Math.sin((3 * Math.PI) / 180)) res.push(hit.point);
    }
  }
  return res;
}

const nearPolyline = (p: Vec, pts: Vec[]) => Math.min(...pts.slice(1).map((q, i) => closestOnSegment(p, pts[i], q).d));

describe('Петля клеверного листа: съезд с эстакады и въезд сбоку', () => {
  it('на эстакаде стенки ограждения не идут крест-накрест через асфальт стыка: у общих кромок их нет до носа островка, нос обведён стенкой', () => {
    const { net } = cloverLoop();
    const { ctx, strokes } = strokeRecorder();
    new LaneRenderer().draw(ctx, net, 1, false, undefined, 1);
    // Тёмная кромка стенок: и полотен, и носа островка.
    const walls = strokes.filter((s) => s.style === '#8c877c').map((s) => s.pts);
    expect(walls.length).toBeGreaterThan(4);
    for (let i = 0; i < walls.length; i++) for (let j = i + 1; j < walls.length; j++) expect(crossings(walls[i], walls[j])).toEqual([]);
    // Стенка носа — дуга, её концы сходятся с концами стенок полотен (подъём на склоне — тот же).
    const ends = walls.flatMap((w) => [w[0], w[w.length - 1]]);
    const nose = walls.find((w) => dist(w[0], w[w.length - 1]) < 12 && w.length >= 10)!;
    expect(nose).toBeDefined();
    for (const p of [nose[0], nose[nose.length - 1]]) {
      const others = ends.filter((q) => q !== p && q !== nose[0] && q !== nose[nose.length - 1]);
      expect(Math.min(...others.map((q) => dist(p, q)))).toBeLessThan(0.3);
    }
  });

  it('линии кромок у съезда (эстакада) и у въезда (земля) расходятся буквой V от стыка, не крест-накрест и не одна по другой', () => {
    const { net, fork, merge } = cloverLoop();
    for (const [layer, node] of [
      [1, fork],
      [0, merge],
    ] as const) {
      const { ctx, strokes } = strokeRecorder();
      new LaneRenderer().draw(ctx, net, 10, false, undefined, layer);
      // Белые линии толщиной 1: осевые, границы полос, кромки полотен, контур островка (галочки — 1,1 и в клипе).
      const lines = strokes
        .filter((s) => s.style === 'rgba(245, 243, 230, 0.85)' && s.width === 1 && s.pts.length > 1)
        .map((s) => s.pts)
        .filter((pts) => pts.some((p) => dist(p, node.pos) < 40));
      expect(lines.length).toBeGreaterThan(4);
      // Пересекаются только концами: в стыке (вершина V) и там, где нос островка упирается в кромку.
      for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) expect(crossings(lines[i], lines[j])).toEqual([]);
      // Ни одна линия не идёт по другой: контур островка не повторяет кромку, которую полотно красит само.
      for (let i = 0; i < lines.length; i++) {
        for (let j = 0; j < lines.length; j++) {
          if (i !== j) expect(lines[i].filter((p) => nearPolyline(p, lines[j]) < 0.05).length).toBeLessThanOrEqual(2);
        }
      }
    }
  });

  it('«ёлочка» у съезда и у въезда: галочки не у носа и не крест-накрест, контур без самопересечений', () => {
    const { net, fork, merge } = cloverLoop();
    const r = new LaneRenderer();
    const gores = [fork, merge].flatMap((n) => r.seamGores(net, n));
    expect(gores.map((g) => g.diverge).sort()).toEqual([false, true]);
    for (const g of gores) {
      // Нос контура краской — дуга между кромками: контур идёт по кромке X (steps + 1 точек), носом, обратно по Y.
      const steps = Math.max(4, Math.ceil((g.length - 5) / 3));
      const noseArc = g.paint.slice(steps, steps + 13);
      const apexes = g.hatch.filter((_, i) => i % 2 === 0).map(([a]) => a);
      for (const a of apexes.filter((x) => dist(x, g.start) > 5)) {
        expect(inside(a, g.paint)).toBe(true);
        expect(nearPolyline(a, noseArc)).toBeGreaterThan(1.9);
      }
      // Контур — простой многоугольник.
      const ring = [...g.paint, g.paint[0]];
      for (let i = 0; i + 1 < ring.length; i++) {
        for (let j = i + 2; j + 1 < ring.length; j++) {
          if (i === 0 && j === ring.length - 2) continue;
          expect(segmentIntersection(ring[i], ring[i + 1], ring[j], ring[j + 1])).toBeNull();
        }
      }
    }
  });
});

// ---------- Пологий съезд с эстакады (баг-репорт «Мост не отображается при съезде») ----------

/**
 * Участок из отчёта: шоссе 1+1 с полосой торможения справа спускается с эстакады; в стыке на высоте (уровень 0,4)
 * с полосы уходит пологий съезд, а шоссе за стыком — короткое полотно (18,5 м) до узла на уровне 0,32 и дальше на
 * землю. Кромки съезда и шоссе расходятся на 9 м только через ~55 м — уже за коротким полотном.
 */
function gentleExit() {
  const net = new LaneNet();
  const seam = (pos: P, dir: P, level = 0) => net.addSeam(v(pos), v(dir), level);
  const road = (a: number, b: number, lanes: LaneSlot[], c: [P, P, P, P], ports: P = [0, 0]) =>
    net.addCorridor(a, b, { cls: 'highway', lanes, portA: ports[0], portB: ports[1], curve: { p0: v(c[0]), p1: v(c[1]), p2: v(c[2]), p3: v(c[3]) } });
  const east = seam([120.5, -0.715], [-0.9929, 0.1188], 0.7132);
  const fork = seam([44.076, 10.778], [-0.9837, 0.1798], 0.3989);
  const mid = seam([25.853, 14.239], [-0.9812, 0.1931], 0.3234);
  const west = seam([-49.436, 39.851], [-0.925, 0.3799]);
  const exitEnd = seam([-74.445, -20.648], [-0.7313, -0.682]);
  road(east.id, fork.id, [lane(-3.5, -1), lane(3.5, 1), lane(10.5, 1, 17.3)], [[120.5, -0.715], [93.578, 2.507], [69.308, 6.165], [44.076, 10.778]]);
  const short = road(fork.id, mid.id, [lane(-3.5, -1), lane(3.5, 1)], [[44.076, 10.778], [38.072, 11.875], [32.014, 13.027], [25.853, 14.239]]);
  road(mid.id, west.id, [lane(-3.5, -1), lane(3.5, 1)], [[25.853, 14.239], [2.463, 18.843], [-21.489, 28.373], [-49.436, 39.851]]);
  road(fork.id, exitEnd.id, [lane(0, 1)], [[42.188, 0.449], [21.201, 4.286], [-32.837, 18.153], [-74.445, -20.648]], [10.5, 0]);
  return { net, fork, short };
}

describe('Пологий съезд с эстакады за коротким полотном', () => {
  it('островок с носом есть: кромки ведутся и по следующему за стыком полотну, нос — там, где разошлись', () => {
    const { net, fork, short } = gentleExit();
    const gores = new LaneRenderer().seamGores(net, fork);
    expect(gores).toHaveLength(1);
    expect(gores[0].diverge).toBe(true);
    // Нос — дальше конца короткого полотна (раньше островок искали только на нём и не находили).
    expect(gores[0].length).toBeGreaterThan(short.length + 20);
  });

  it('стенки ограждения съезда и шоссе не перекрещиваются над общим асфальтом, нос обведён стенкой', () => {
    const { net } = gentleExit();
    const { ctx, strokes } = strokeRecorder();
    new LaneRenderer().draw(ctx, net, 1, false, undefined, 1);
    const walls = strokes.filter((s) => s.style === '#8c877c').map((s) => s.pts);
    expect(walls.length).toBeGreaterThan(4);
    for (let i = 0; i < walls.length; i++) for (let j = i + 1; j < walls.length; j++) expect(crossings(walls[i], walls[j])).toEqual([]);
    // Стенка носа: её концы сходятся с концами стенок полотен — со съездом и с шоссе за коротким полотном.
    const ends = walls.flatMap((w) => [w[0], w[w.length - 1]]);
    const nose = walls.find((w) => dist(w[0], w[w.length - 1]) < 12 && w.length >= 10)!;
    expect(nose).toBeDefined();
    for (const p of [nose[0], nose[nose.length - 1]]) {
      const others = ends.filter((q) => q !== nose[0] && q !== nose[nose.length - 1]);
      expect(Math.min(...others.map((q) => dist(p, q)))).toBeLessThan(0.3);
    }
  });

  it('линии кромок расходятся от стыка буквой V — не крест-накрест и не одна по другой', () => {
    const { net, fork } = gentleExit();
    const { ctx, strokes } = strokeRecorder();
    new LaneRenderer().draw(ctx, net, 10, false, undefined, 1);
    const lines = strokes
      .filter((s) => s.style === 'rgba(245, 243, 230, 0.85)' && s.width === 1 && s.pts.length > 1)
      .map((s) => s.pts)
      .filter((pts) => pts.some((p) => dist(p, fork.pos) < 80));
    expect(lines.length).toBeGreaterThan(4);
    for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) expect(crossings(lines[i], lines[j])).toEqual([]);
  });
});

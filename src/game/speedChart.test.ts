import { describe, expect, it } from 'vitest';
import { buildBusScene } from '../testpages/bus';
import type { Station } from '../world/entities';
import { KMH_PER_UNIT, RAIL_SPEC } from '../world/roadTypes';
import type { RoadRequest } from './build';
import { Game } from './game';
import { chartIndexAt, Motion, runSpeeds, runTime, speedChart, TrackLeg } from './speedChart';

const flat: Motion = { top: () => 40, accel: () => 4, decel: 8 };
const straight = (length: number, cap = 30): TrackLeg => ({ pieces: [{ length, cap, grade: 0 }] });

describe('График скорости маршрута', () => {
  it('скорость — с места до места: не выше предела, разгон и торможение не резче заданных', () => {
    const d = Array.from({ length: 101 }, (_, i) => i * 5);
    const cap = d.map((x) => (x > 200 && x < 260 ? 10 : 30));
    const accel = d.map(() => 4);
    const v = runSpeeds(d, cap, accel, 8);
    expect(v[0]).toBe(0);
    expect(v[v.length - 1]).toBe(0);
    for (let i = 0; i < d.length; i++) expect(v[i]).toBeLessThanOrEqual(cap[i] + 1e-9);
    for (let i = 1; i < d.length; i++) {
      const dv2 = v[i] ** 2 - v[i - 1] ** 2;
      expect(dv2).toBeLessThanOrEqual(2 * 4 * 5 + 1e-6);
      expect(dv2).toBeGreaterThanOrEqual(-2 * 8 * 5 - 1e-6);
    }
    // К изгибу тормозит заранее: перед ним уже медленнее предела.
    expect(v[d.indexOf(195)]).toBeLessThan(30);
    expect(Math.max(...v)).toBeCloseTo(30);
  });

  it('время — по средней скорости на каждом шаге', () => {
    expect(runTime([0, 10, 20], [5, 5, 5])).toBeCloseTo(4);
    expect(runTime([0, 10], [0, 10])).toBeCloseTo(2);
    expect(runTime([0, 10], [0, 0])).toBe(Infinity);
  });

  it('круг А→Б→А: на остановках ноль, длина — сумма участков, средняя ниже предела', () => {
    const chart = speedChart([straight(600), straight(600)], flat)!;
    expect(chart.length).toBeCloseTo(1200);
    expect(chart.stops).toEqual([0, 600, 1200]);
    for (const s of chart.stops) expect(chart.v[chart.d.findIndex((x) => Math.abs(x - s) < 1e-6)]).toBe(0);
    expect(chart.avg).toBeLessThan(30);
    expect(chart.avg).toBeGreaterThan(20);
    expect(chart.time).toBeCloseTo(chart.length / chart.avg);
    // Точки по порядку, без повторов на стыке участков.
    for (let i = 1; i < chart.d.length; i++) expect(chart.d[i]).toBeGreaterThan(chart.d[i - 1]);
  });

  it('поворот и подъём снижают среднюю скорость; рельеф — по уклонам', () => {
    const base = speedChart([straight(600), straight(600)], flat)!;
    const turn: TrackLeg = { pieces: [{ length: 290, cap: 30, grade: 0 }, { length: 20, cap: 8, grade: 0 }, { length: 290, cap: 30, grade: 0 }] };
    expect(speedChart([turn, straight(600)], flat)!.avg).toBeLessThan(base.avg);
    const heavy: Motion = { top: (g) => 40 * (g > 0 ? 1 - 4 * g : 1), accel: () => 4, decel: 8 };
    const uphill: TrackLeg = { pieces: [{ length: 600, cap: 30, grade: 0.08 }] };
    const downhill: TrackLeg = { pieces: [{ length: 600, cap: 30, grade: -0.08 }] };
    const hill = speedChart([uphill, downhill], heavy)!;
    expect(hill.avg).toBeLessThan(base.avg);
    // В гору — медленнее, чем под гору.
    const mid = (from: number, to: number) => chart(hill, from, to);
    expect(mid(200, 400)).toBeLessThan(mid(800, 1000));
    expect(Math.max(...hill.z)).toBeCloseTo(48);
    expect(hill.z[hill.z.length - 1]).toBeCloseTo(0);
  });

  it('у точек — место на карте по участкам; точка под курсором — ближайшая по расстоянию', () => {
    const leg = (a: number, b: number): TrackLeg => ({ pieces: [{ length: Math.abs(b - a), cap: 30, grade: 0, from: { x: a, y: 0 }, to: { x: b, y: 0 } }] });
    const c = speedChart([leg(0, 600), leg(600, 0)], flat)!;
    expect(c.x[0]).toBeCloseTo(0);
    expect(c.x[chartIndexAt(c, 300)]).toBeCloseTo(300, 0);
    expect(c.x[chartIndexAt(c, 600)]).toBeCloseTo(600);
    expect(c.x[chartIndexAt(c, 900)]).toBeCloseTo(300, 0);
    expect(c.x[c.x.length - 1]).toBeCloseTo(0);
    expect(chartIndexAt(c, -5)).toBe(0);
    expect(chartIndexAt(c, 1e6)).toBe(c.d.length - 1);
    // Без положения участка — NaN, а не выдуманная точка.
    expect(Number.isNaN(speedChart([straight(100), straight(100)], flat)!.x[3])).toBe(true);
  });

  it('нет пути на участке — графика нет', () => {
    expect(speedChart([straight(600), { pieces: [] }], flat)).toBeNull();
    expect(speedChart([], flat)).toBeNull();
  });
});

/** Наибольшая скорость графика на отрезке пути. */
function chart(c: { d: Float64Array; v: Float64Array }, from: number, to: number): number {
  let m = 0;
  for (let i = 0; i < c.d.length; i++) if (c.d[i] >= from && c.d[i] <= to) m = Math.max(m, c.v[i]);
  return m;
}

describe('График скорости линии в игре', { timeout: 60_000 }, () => {
  it('по улицам сцены /test/bus: круг через все остановки, поворот в кварталах — медленнее прямой', () => {
    const { game, lines } = buildBusScene();
    const straightLine = game.lines.get(lines.straight)!;
    const block = game.lines.get(lines.block)!;
    const a = game.lineSpeedChart(straightLine)!;
    const b = game.lineSpeedChart(block)!;
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a.stops).toHaveLength(straightLine.stops.length + 1);
    expect(b.stops).toHaveLength(block.stops.length + 1);
    // Автобус по улице: не быстрее разрешённой скорости и своей наибольшей.
    const kmh = a.avg * KMH_PER_UNIT;
    expect(kmh).toBeGreaterThan(15);
    expect(kmh).toBeLessThan(60);
    for (let i = 0; i < a.v.length; i++) expect(a.v[i]).toBeLessThanOrEqual(a.cap[i] + 1e-6);
    // На повороте в кварталах предел ниже разрешённого на улице.
    expect(Math.min(...b.cap)).toBeLessThan(Math.max(...b.cap) * 0.7);
    // Тот же объект, пока сеть и линия не менялись.
    expect(game.lineSpeedChart(straightLine)).toBe(a);
    // Точки графика — на маршруте: каждая есть на карте, у остановок — рядом с её узлом, соседние — рядом.
    for (const c of [a, b]) {
      for (let i = 0; i < c.x.length; i++) expect(Number.isFinite(c.x[i]) && Number.isFinite(c.y[i])).toBe(true);
      for (let i = 1; i < c.x.length; i++) expect(Math.hypot(c.x[i] - c.x[i - 1], c.y[i] - c.y[i - 1])).toBeLessThan(c.d[i] - c.d[i - 1] + 2);
    }
    a.stops.slice(0, -1).forEach((d, k) => {
      const node = game.roads.net.node(game.stations.get(straightLine.stops[k])!.nodeId).pos;
      const i = chartIndexAt(a, d);
      expect(Math.hypot(a.x[i] - node.x, a.y[i] - node.y)).toBeLessThan(20);
    });
  });

  it('ж/д линия: по путям между вокзалами, поезд не быстрее своей наибольшей скорости', () => {
    const game = new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' });
    const len = 2400;
    let stops: [Station, Station] | null = null;
    for (let y = 400; !stops && y < game.terrain.height - 400; y += 170) {
      for (let x = 300; !stops && x < game.terrain.width - len - 300; x += 230) {
        const req: RoadRequest = { start: { kind: 'free', pos: { x, y }, level: 0 }, end: { kind: 'free', pos: { x: x + len, y }, level: 0 }, spec: RAIL_SPEC, mode: 'straight' };
        if (!game.builder.plan(req).ok) continue;
        game.builder.build(req);
        const pa = { x: x + 400, y: y + 40 };
        const pb = { x: x + len - 400, y: y + 40 };
        if (game.stationPlan(pa, 14, 'rail').ok && game.stationPlan(pb, 14, 'rail').ok) stops = [game.placeStation(pa, 14, 'rail')!, game.placeStation(pb, 14, 'rail')!];
        else game.builder.bulldoze({ x: x + len / 2, y }, 4);
      }
    }
    expect(stops).not.toBeNull();
    const line = game.createLine(stops!.map((s) => s.id))!;
    expect(game.lineMode(line)).toBe('rail');
    const chart = game.lineSpeedChart(line)!;
    expect(chart).not.toBeNull();
    // Туда и обратно — примерно вдвое больше расстояния между вокзалами.
    expect(chart.length).toBeGreaterThan(2 * 1400);
    expect(chart.length).toBeLessThan(2 * 2000);
    const top = Math.max(...chart.v) * KMH_PER_UNIT;
    expect(top).toBeGreaterThan(60);
    expect(top).toBeLessThanOrEqual(120 + 1e-6);
    for (let i = 0; i < chart.x.length; i++) expect(Number.isFinite(chart.x[i])).toBe(true);
  });
});

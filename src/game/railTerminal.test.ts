import { describe, expect, it } from 'vitest';
import { RAIL_STATION } from '../config';
import { add, dist, dot, rightNormal, scale, sub, Vec } from '../core/vec';
import type { Train } from '../sim/rail';
import type { Station } from '../world/entities';
import { RAIL_HALF, RAIL_SPEC } from '../world/roadTypes';
import { Game } from './game';
import { withoutCitizens } from './testkit';

function runSeconds(game: Game, seconds: number, each?: () => void) {
  game.speed = 1;
  for (let t = 0; t < seconds; t += 0.1) {
    game.update(0.1);
    each?.();
  }
}

const SERVES = { pax: true, cargo: true };

/** Прямой путь длиной len (оба конца — тупики) в свободном месте, где у концов встают конечные. */
function layTrack(game: Game, len: number): { from: Vec; dir: Vec; n: Vec; at: (s: number, side?: number) => Vec } {
  for (let y = 400; y < game.terrain.height - 400; y += 170) {
    for (let x = 300; x < game.terrain.width - len - 300; x += 230) {
      const dir = { x: 1, y: 0 };
      const n = { x: 0, y: 1 };
      const from = { x, y };
      const at = (s: number, side = 0) => add(add(from, scale(dir, s)), scale(n, side));
      const req = { start: { kind: 'free' as const, pos: from, level: 0 }, end: { kind: 'free' as const, pos: at(len), level: 0 }, spec: RAIL_SPEC, mode: 'straight' as const };
      if (!game.builder.plan(req).ok) continue;
      game.builder.build(req);
      const a = game.stationPlan(at(200, 40), 14, 'rail', 0, 2, 150, true);
      const b = game.stationPlan(at(len - 200, 40), 14, 'rail', 0, 2, 150, true);
      if (a.ok && b.ok) return { from, dir, n, at };
      game.builder.bulldoze(at(len / 2), 4);
    }
  }
  throw new Error('Нет места для пути');
}

/** Отрезки пути под телом поезда: участок → [от, до] в его координатах. */
function body(train: Train): Map<number, [number, number]> {
  const result = new Map<number, [number, number]>();
  const tail = train.head - train.length;
  for (const e of train.path) {
    const a = Math.max(tail, e.start);
    const b = Math.min(train.head, e.start + e.len);
    if (b <= a) continue;
    result.set(e.seg, e.dir === 0 ? [a - e.start, b - e.start] : [e.start + e.len - b, e.start + e.len - a]);
  }
  return result;
}

/** Платформы с упором: один конец — тупик (больше путей в узле нет). */
function buffers(game: Game, st: Station): Vec[] {
  return st.platforms.flatMap((id) => {
    const s = game.net.segment(id);
    return [s.a, s.b].filter((nid) => game.net.node(nid).segments.length === 1).map((nid) => game.net.node(nid).pos);
  });
}

/**
 * Здание конечной — в торце: за упорами (с перроном между ними), поперёк путей и шире их всех,
 * и не задевает ни один путь станции.
 */
function expectHeadBuilding(game: Game, st: Station): void {
  const fp = st.fp;
  const across = { x: Math.cos(fp.angle), y: Math.sin(fp.angle) };
  const ends = buffers(game, st);
  // Вдоль путей: от упоров к зданию.
  const main = game.net.segment(st.platforms[0]);
  const end = ends[0];
  const inner = main.lut.pointAt(main.lut.closest(end).s > main.length / 2 ? 0 : main.length);
  const along = scale(sub(end, inner), 1 / dist(end, inner));
  // Поперёк путей: здание повёрнуто длинной стороной поперёк.
  expect(Math.abs(dot(across, along))).toBeLessThan(0.01);
  for (const p of ends) {
    // За каждым упором — перрон и фасад здания.
    expect(dot(sub(fp.center, p), along) - fp.h / 2).toBeGreaterThanOrEqual(RAIL_STATION.concourse - 0.5);
    // Каждый путь упирается в здание, а не мимо него.
    expect(Math.abs(dot(sub(p, fp.center), across))).toBeLessThan(fp.w / 2 - RAIL_HALF);
  }
  // Ни одна точка путей станции не под зданием.
  for (const id of st.platforms) {
    const s = game.net.segment(id);
    for (let k = 0; k <= 20; k++) {
      const q = sub(s.lut.pointAt((s.length * k) / 20), fp.center);
      const inside = Math.abs(dot(q, across)) < fp.w / 2 && Math.abs(dot(q, rightNormal(across))) < fp.h / 2 + RAIL_HALF;
      expect(inside).toBe(false);
    }
  }
}

describe('Конечная ж/д станция', { timeout: 60_000 }, () => {
  const world = () => withoutCitizens(new Game({ seed: 11, size: 'small', towns: 3, industries: 'few', money: 9_000_000, water: 'dry' }));

  it('в чистом поле: пути от горловины кончаются упорами, у каждой платформы — свой', () => {
    const game = world();
    let st: Station | null = null;
    for (let y = 600; y < game.terrain.height - 600 && !st; y += 300) {
      for (let x = 600; x < game.terrain.width - 600 && !st; x += 300) {
        const plan = game.stationPlan({ x, y }, 14, 'rail', 0, 3, 150, true);
        if (!plan.ok) continue;
        // Конечная дешевле проходной: нет съездов обратно на главный путь.
        expect(plan.cost).toBeLessThan(game.stationPlan({ x, y }, 14, 'rail', 0, 3, 150).cost);
        st = game.placeStation({ x, y }, 14, 'rail', SERVES, 0, 3, 150, true);
      }
    }
    expect(st).not.toBeNull();
    expect(st!.terminal).toBe(true);
    expect(st!.platforms).toHaveLength(3);
    const ends = buffers(game, st!);
    expect(ends).toHaveLength(3);
    // Упоры — в один ряд поперёк путей, с одной стороны станции.
    for (const p of ends) expect(Math.abs(p.x - ends[0].x)).toBeLessThan(1);
    for (const id of st!.platforms) expect(game.net.segment(id).length).toBeCloseTo(150, 0);
    expectHeadBuilding(game, st!);
    // Здание в торце — по ширине путей: на четыре пути шире, чем на два, на два междупутья.
    const p = st!.fp.center;
    const two = game.stationPlan(add(p, { x: 0, y: 600 }), 14, 'rail', 0, 2, 150, true).fp!;
    const four = game.stationPlan(add(p, { x: 0, y: 600 }), 14, 'rail', 0, 4, 150, true).fp!;
    expect(four.w - two.w).toBeCloseTo(RAIL_STATION.spacing * 2, 0);
    // Место под здание проверяется: в торце уже стоит наша конечная — новую на него не поставить.
    const behind = game.stationPlan(add(p, { x: 150 / 2 + RAIL_STATION.concourse + 5, y: 0 }), 14, 'rail', 0, 3, 150, true);
    expect(behind.ok).toBe(false);
  });

  it('у тупика пути: платформы доходят до его конца — там упор', () => {
    const game = world();
    const len = 1600;
    const { at } = layTrack(game, len);
    const segsBefore = game.net.segments.size;
    const st = game.placeStation(at(len - 150, 40), 14, 'rail', SERVES, 0, 2, 150, true)!;
    expect(st?.terminal).toBe(true);
    // Новый главный путь не строился: вокзал встал на конец существующего.
    expect(game.net.segments.size).toBe(segsBefore + 2 + 2);
    const ends = buffers(game, st);
    expect(ends.some((p) => dist(p, at(len)) < 1)).toBe(true);
    // Здание — за концом пути, в торце.
    expectHeadBuilding(game, st);
    expect(st.fp.center.x).toBeGreaterThan(at(len).x + RAIL_STATION.concourse);
    // У середины пути (без тупика рядом) конечную не поставить.
    const mid = game.stationPlan(at(len / 2 - 300, 40), 14, 'rail', 0, 2, 150, true);
    expect(mid.ok).toBe(false);
  });

  it('поезд приходит на конечную, разворачивается и уходит обратно — в обе стороны маршрута', () => {
    const game = world();
    const len = 2400;
    const { at } = layTrack(game, len);
    const t1 = game.placeStation(at(200, 40), 14, 'rail', SERVES, 0, 2, 150, true)!;
    const t2 = game.placeStation(at(len - 200, 40), 14, 'rail', SERVES, 0, 2, 150, true)!;
    const line = game.createLine([t1.id, t2.id])!;
    for (const i of [0, 1]) game.setStopRule(line.id, i, { wait: 'none', maxWait: null, load: 'auto', unload: 'auto' });
    expect(game.buyVehicle(line.id, 'passengerTrain')).not.toBeNull();
    const train = () => [...game.rail.trains.values()][0];
    // Где голова (локомотив) у стоящего на платформе поезда: со стороны упора или горловины.
    const stops: { st: number; loco: 'buffer' | 'throat' }[] = [];
    let moving = true;
    let lastLoco: Vec | null = null;
    // Сдвиг локомотива за первый шаг после отправления: без скачка на другой конец состава.
    const jumps: number[] = [];
    runSeconds(game, 600, () => {
      const t = train();
      if (!t) return;
      const loco = game.rail.cars(t)[0].pos;
      if (!t.moving && moving) {
        const st = [t1, t2].find((s) => t.platform !== null && s.platforms.includes(t.platform));
        if (st) {
          const buffer = buffers(game, st).reduce((a, b) => (dist(a, loco) < dist(b, loco) ? a : b));
          const tail = game.rail.cars(t)[t.cars - 1].pos;
          stops.push({ st: st.id, loco: dist(loco, buffer) < dist(tail, buffer) ? 'buffer' : 'throat' });
        }
      }
      if (t.moving && !moving && lastLoco) jumps.push(dist(loco, lastLoco));
      moving = t.moving;
      lastLoco = loco;
    });
    const seq = stops.map((s) => s.st);
    // Туда и обратно, не раз: t1 → t2 → t1 → t2…
    expect(seq.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < seq.length; i++) expect(seq[i]).not.toBe(seq[i - 1]);
    // На стоянке локомотив уже со стороны горловины — поезд развернулся по прибытии и стоит к выезду.
    expect(stops.every((s) => s.loco === 'throat')).toBe(true);
    // Отправляется с места — локомотив не перескакивает на другой конец состава.
    expect(jumps.length).toBeGreaterThanOrEqual(3);
    for (const d of jumps) expect(d).toBeLessThan(2);
    expect(line.problem).toBeNull();
  });

  it('конечная — последняя после проходной: поезд ходит туда и обратно', () => {
    const game = world();
    const len = 2400;
    const { at } = layTrack(game, len);
    const t = game.placeStation(at(200, 40), 14, 'rail', SERVES, 0, 2, 150, true)!;
    const s = game.placeStation(at(len - 600, 40), 14, 'rail', SERVES, 0, 2, 150)!;
    expect(s.terminal).toBeUndefined();
    const line = game.createLine([s.id, t.id])!;
    for (const i of [0, 1]) game.setStopRule(line.id, i, { wait: 'none', maxWait: null, load: 'auto', unload: 'auto' });
    game.buyVehicle(line.id, 'freightTrain');
    const visits: number[] = [];
    runSeconds(game, 600, () => {
      for (const tr of game.rail.trains.values()) {
        if (tr.moving || tr.platform === null) continue;
        const st = [s, t].find((x) => x.platforms.includes(tr.platform!))!;
        if (visits[visits.length - 1] !== st.id) visits.push(st.id);
      }
    });
    expect(visits.filter((id) => id === t.id).length).toBeGreaterThanOrEqual(2);
    expect(visits.filter((id) => id === s.id).length).toBeGreaterThanOrEqual(2);
    expect(line.problem).toBeNull();
  });

  it('два поезда на двух путях конечных: не сталкиваются и не встают в горловине', () => {
    const game = world();
    const len = 2400;
    const { at } = layTrack(game, len);
    const t1 = game.placeStation(at(200, 40), 14, 'rail', SERVES, 0, 2, 150, true)!;
    const t2 = game.placeStation(at(len - 200, 40), 14, 'rail', SERVES, 0, 2, 150, true)!;
    const line = game.createLine([t1.id, t2.id])!;
    for (const i of [0, 1]) game.setStopRule(line.id, i, { wait: 'none', maxWait: null, load: 'auto', unload: 'auto' });
    game.buyVehicle(line.id, 'passengerTrain');
    game.buyVehicle(line.id, 'passengerTrain');
    const arrivals = new Map<number, number>();
    const last = new Map<number, number | null>();
    let overlaps = 0;
    runSeconds(game, 900, () => {
      const trains = [...game.rail.trains.values()];
      for (const tr of trains) {
        const at = tr.moving ? null : tr.platform;
        if (at !== null && last.get(tr.id) !== at) arrivals.set(tr.id, (arrivals.get(tr.id) ?? 0) + 1);
        last.set(tr.id, at);
      }
      if (trains.length === 2) {
        const b0 = body(trains[0]);
        for (const [seg, [x0, x1]] of body(trains[1])) {
          const o = b0.get(seg);
          if (o && o[0] < x1 && x0 < o[1]) overlaps++;
        }
      }
    });
    expect(overlaps).toBe(0);
    expect(arrivals.size).toBe(2);
    // Каждый поезд не застрял: побывал на платформах конечных не один раз.
    for (const n of arrivals.values()) expect(n).toBeGreaterThanOrEqual(4);
  });

  it('снос конечной: тупики разбираются, главный путь остаётся', () => {
    const game = world();
    const len = 1600;
    const { at } = layTrack(game, len);
    const st = game.placeStation(at(len - 150, 40), 14, 'rail', SERVES, 0, 3, 150, true)!;
    const main = st.platforms[0];
    expect(game.removeStation(st)).toBe(true);
    expect(game.net.segments.get(main)?.platform).toBeUndefined();
    for (const id of st.platforms.slice(1)) expect(game.net.segments.has(id)).toBe(false);
  });
});

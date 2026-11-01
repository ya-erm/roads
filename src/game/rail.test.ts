import { describe, expect, it } from 'vitest';
import { add, scale, Vec } from '../core/vec';
import type { Train } from '../sim/rail';
import type { Station } from '../world/entities';
import { RAIL_SPEC, RoadSpec } from '../world/roadTypes';
import type { RoadRequest } from './build';
import { Game } from './game';
import { carsOf, vehicleCapacity } from './transport';

const STREET: RoadSpec = { cls: 'street', lanesF: 1, lanesB: 1 };

function runSeconds(game: Game, seconds: number, each?: () => void) {
  game.speed = 1;
  for (let t = 0; t < seconds; t += 0.1) {
    game.update(0.1);
    each?.();
  }
}

function straight(from: Vec, to: Vec, spec: RoadSpec): RoadRequest {
  return { start: { kind: 'free', pos: from, level: 0 }, end: { kind: 'free', pos: to, level: 0 }, spec, mode: 'straight' };
}

/** Ищет свободное место и кладёт прямой путь длиной len. */
function layTrack(game: Game, len: number): { from: Vec; dir: Vec } {
  for (let y = 400; y < game.terrain.height - 400; y += 170) {
    for (let x = 300; x < game.terrain.width - len - 300; x += 230) {
      for (const angle of [0, 0.3, -0.3]) {
        const dir = { x: Math.cos(angle), y: Math.sin(angle) };
        const from = { x, y };
        const req = straight(from, add(from, scale(dir, len)), RAIL_SPEC);
        if (!game.builder.plan(req).ok) continue;
        // Рядом с путём должно хватить места для вокзалов.
        game.builder.build(req);
        const n = { x: -dir.y, y: dir.x };
        const a = game.stationPlan(add(add(from, scale(dir, 400)), scale(n, 40)), 14, 'rail');
        const b = game.stationPlan(add(add(from, scale(dir, len - 400)), scale(n, 40)), 14, 'rail');
        if (a.ok && b.ok) return { from, dir };
        game.builder.bulldoze(add(from, scale(dir, len / 2)), 4);
      }
    }
  }
  throw new Error('Нет места для пути');
}

/** Отрезки пути, занятые телом поезда: [seg, from, to] в координатах маршрута. */
function body(train: Train): Map<number, [number, number]> {
  const result = new Map<number, [number, number]>();
  const tail = train.head - train.length;
  for (const e of train.path) {
    const a = Math.max(tail, e.start);
    const b = Math.min(train.head, e.start + e.len);
    if (b <= a) continue;
    const local = e.dir === 0 ? [a - e.start, b - e.start] : [e.start + e.len - b, e.start + e.len - a];
    result.set(e.seg, local as [number, number]);
  }
  return result;
}

function railWorld(): { game: Game; a: Station; b: Station; from: Vec; dir: Vec } {
  const game = new Game({ seed: 11, size: 'small', towns: 3, industries: 'few', money: 5_000_000, water: 'dry' });
  const len = 2400;
  const { from, dir } = layTrack(game, len);
  const n = { x: -dir.y, y: dir.x };
  const a = game.placeStation(add(add(from, scale(dir, 400)), scale(n, 40)), 14, 'rail')!;
  const b = game.placeStation(add(add(from, scale(dir, len - 400)), scale(n, 40)), 14, 'rail')!;
  return { game, a, b, from, dir };
}

// Длинные симуляции поездов: при параллельном прогоне всех тестов не укладываются в 5 с.
describe('Железная дорога', { timeout: 30_000 }, () => {
  it('вокзал: две платформы на главном и обгонном пути', () => {
    const { game, a, b } = railWorld();
    for (const st of [a, b]) {
      expect(st.kind).toBe('rail');
      expect(st.platforms).toHaveLength(2);
      for (const pid of st.platforms) expect(game.net.segment(pid).platform).toBe(st.id);
    }
    // Автостанции и вокзалы в одной линии не смешиваются.
    expect(game.lineProblem([a.id, b.id])).toBeNull();
    const line = game.createLine([a.id, b.id])!;
    expect(line.mode).toBe('rail');
    expect(game.buyVehicle(line.id, 'truck')).toBeNull();
  });

  it('поезд встаёт на боковой путь вокзала, главный остаётся свободным', () => {
    const { game, a, b } = railWorld();
    const line = game.createLine([a.id, b.id])!;
    game.setStopRule(line.id, 0, { wait: 'none', maxWait: null, load: 'auto', unload: 'auto' });
    game.buyVehicle(line.id, 'passengerTrain');
    const train = () => [...game.rail.trains.values()][0];
    const stops: number[] = [];
    runSeconds(game, 200, () => {
      const t = train();
      if (t && !t.moving && t.platform !== null && stops[stops.length - 1] !== t.platform) stops.push(t.platform);
    });
    // Прибыл на другой вокзал (и, может, вернулся) — и каждый раз на боковой путь.
    const sidings = new Set([a.platforms[1], b.platforms[1]]);
    expect(stops.length).toBeGreaterThanOrEqual(2);
    for (const p of stops) expect(sidings.has(p)).toBe(true);
  });

  it('поезда делят одноколейный путь без столкновений', () => {
    const { game, a, b } = railWorld();
    const line = game.createLine([a.id, b.id])!;
    for (let i = 0; i < 3; i++) expect(game.buyVehicle(line.id, i === 1 ? 'passengerTrain' : 'freightTrain')).not.toBeNull();
    const arrivals = new Map<number, number>();
    let overlaps = 0;
    const lastStop = new Map<number, number>();
    runSeconds(game, 400, () => {
      const trains = [...game.rail.trains.values()];
      // Тела поездов не пересекаются ни на одном участке.
      for (let i = 0; i < trains.length; i++) {
        const bi = body(trains[i]);
        for (let j = i + 1; j < trains.length; j++) {
          for (const [seg, [x0, x1]] of body(trains[j])) {
            const other = bi.get(seg);
            if (other && other[0] < x1 && x0 < other[1]) overlaps++;
          }
        }
      }
      for (const v of game.fleet.values()) {
        if (v.state === 'loading' && lastStop.get(v.id) !== v.stop) {
          lastStop.set(v.id, v.stop);
          arrivals.set(v.id, (arrivals.get(v.id) ?? 0) + 1);
        }
      }
    });
    expect(overlaps).toBe(0);
    // Каждый поезд успел съездить на другой вокзал и обратно.
    for (const v of game.fleet.values()) expect(arrivals.get(v.id) ?? 0).toBeGreaterThanOrEqual(3);
  });

  it('сигналы: поезд уходит вслед за первым, не дожидаясь его прибытия', () => {
    const { game, a, b, from, dir } = railWorld();
    // Сигналы для направления A → B: курсор справа по ходу.
    const right = { x: -dir.y, y: dir.x };
    for (const at of [800, 1200, 1600]) {
      const p = add(add(from, scale(dir, at)), scale(right, 20));
      const plan = game.signalPlan(p, 14);
      expect(plan.ok).toBe(true);
      expect(plan.dir!.x * dir.x + plan.dir!.y * dir.y).toBeGreaterThan(0.9);
      expect(game.toggleSignal(p, 14)).toBe(true);
    }
    const line = game.createLine([a.id, b.id])!;
    // «Не ждать» на погрузке: оба поезда стремятся уехать сразу.
    game.setStopRule(line.id, 0, { wait: 'none', maxWait: null, load: 'auto', unload: 'auto' });
    game.buyVehicle(line.id, 'freightTrain');
    game.buyVehicle(line.id, 'freightTrain');
    let together = 0;
    let overlaps = 0;
    runSeconds(game, 120, () => {
      const trains = [...game.rail.trains.values()];
      if (trains.length === 2 && trains.every((t) => t.moving)) together++;
      if (trains.length === 2) {
        const b0 = body(trains[0]);
        for (const [seg, [x0, x1]] of body(trains[1])) {
          const o = b0.get(seg);
          if (o && o[0] < x1 && x0 < o[1]) overlaps++;
        }
      }
    });
    expect(overlaps).toBe(0);
    // Оба поезда были в пути одновременно — блоки работают.
    expect(together).toBeGreaterThan(0);
    // Сигнал снимается повторным кликом.
    const p = add(add(from, scale(dir, 800)), scale(right, 20));
    expect(game.signalPlan(p, 14).remove).toBe(true);
  });

  it('станция на 4 пути и длина состава', () => {
    const game = new Game({ seed: 11, size: 'small', towns: 3, industries: 'few', money: 9_000_000, water: 'dry' });
    // Две станции на 4 пути в чистом поле.
    const placed: Station[] = [];
    for (let y = 600; y < game.terrain.height - 600 && placed.length < 2; y += 300) {
      for (let x = 600; x < game.terrain.width - 600 && placed.length < 2; x += 300) {
        if (placed.some((s) => Math.hypot(s.fp.center.x - x, s.fp.center.y - y) < 900)) continue;
        const st = game.placeStation({ x, y }, 14, 'rail', { pax: true, cargo: true }, 0, 4);
        if (st) placed.push(st);
      }
    }
    expect(placed).toHaveLength(2);
    for (const st of placed) {
      expect(st.platforms).toHaveLength(4);
      for (const p of st.platforms) expect(game.net.segment(p).platform).toBe(st.id);
    }
    const line = game.createLine(placed.map((s) => s.id))!;
    for (let i = 0; i < 4; i++) game.buyVehicle(line.id, 'freightTrain');
    runSeconds(game, 2);
    // Все четыре поезда встали на платформы первой станции.
    const parked = [...game.rail.trains.values()].filter((t) => !t.moving && t.platform !== null);
    expect(parked.length).toBe(4);
    // Длина состава: вместимость растёт вместе с вагонами, но не длиннее платформы.
    const v = game.fleet.get(line.vehicles[0])!;
    const cap = vehicleCapacity(v);
    const run = game.runningCost(v);
    expect(game.setTrainCars(v.id, 8)).toBe(true);
    expect(vehicleCapacity(v)).toBeGreaterThan(cap);
    expect(game.runningCost(v)).toBeGreaterThan(run);
    expect(game.setTrainCars(v.id, 30)).toBe(false);
    expect(carsOf(v)).toBe(game.maxCars(v));
    expect(game.fleetTrain(v)!.length).toBe(carsOf(v) * 17);
  });

  it('переезд закрывается перед поездом, машины ждут', () => {
    const { game, a, b, from, dir } = railWorld();
    const n = { x: -dir.y, y: dir.x };
    const mid = add(from, scale(dir, 1200));
    const road = game.builder.build(straight(add(mid, scale(n, -200)), add(mid, scale(n, 200)), STREET));
    expect(road).not.toBeNull();
    const crossing = [...game.net.nodes.values()].find((x) => game.net.isCrossing(x));
    expect(crossing).toBeDefined();
    const line = game.createLine([a.id, b.id])!;
    game.buyVehicle(line.id, 'passengerTrain');
    let closed = 0;
    runSeconds(game, 150, () => {
      if (crossing!.crossingClosed) closed++;
    });
    expect(closed).toBeGreaterThan(0);
    // Поезд не стоит на переезде вечно: переезд открывается.
    expect(crossing!.crossingClosed).toBe(false);
  });

  it('поезд переживает разрезание пути переездом и сохранение', () => {
    const { game, a, b, from, dir } = railWorld();
    const line = game.createLine([a.id, b.id])!;
    game.buyVehicle(line.id, 'freightTrain');
    // Ждём, пока поезд поедет, и режем путь прямо перед ним.
    runSeconds(game, 30);
    const v = [...game.fleet.values()][0];
    expect(v.state).toBe('driving');
    const n = { x: -dir.y, y: dir.x };
    const mid = add(from, scale(dir, 1200));
    expect(game.builder.build(straight(add(mid, scale(n, -150)), add(mid, scale(n, 150)), STREET))).not.toBeNull();
    expect(game.fleetTrain(v)).toBeDefined();
    expect(game.fleetTrain(v)!.moving).toBe(true);
    const loaded = new Game(game.settings, JSON.parse(JSON.stringify(game.toSave())));
    const lv = loaded.fleet.get(v.id)!;
    const t0 = game.fleetTrain(v)!;
    const t1 = loaded.fleetTrain(lv)!;
    expect(t1.head).toBeCloseTo(t0.head, 5);
    // Загруженный поезд продолжает ездить: доезжает и возвращается.
    let arrivals = 0;
    let last = lv.state;
    runSeconds(loaded, 200, () => {
      if (lv.state === 'loading' && last !== 'loading') arrivals++;
      last = lv.state;
    });
    expect(loaded.lines.get(line.id)!.problem).toBeNull();
    expect(arrivals).toBeGreaterThanOrEqual(2);
  });
});

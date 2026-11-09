import { describe, expect, it } from 'vitest';
import { add, angleDiff, angleOf, dist, scale, Vec } from '../core/vec';
import { placer } from '../lanes/fragment';
import type { Train } from '../sim/rail';
import type { Station } from '../world/entities';
import { RAIL_SPEC, RoadSpec } from '../world/roadTypes';
import type { RoadRequest, Snap } from './build';
import { Game } from './game';
import { snapRails } from './railFragment';
import { road, roadPlan, STREET as STREET_LANES, withoutCitizens } from './testkit';
import { carsOf, vehicleCapacity } from './transport';
import { wagonFills } from '../sim/wagons';
import { CARGO } from '../world/cargo';


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
        // Путь — в поле, в стороне от дорог: без переездов, которых тест не строил, и с местом для дорог через него.
        let crosses = false;
        for (let s = 0; s <= len && !crosses; s += 25) {
          const p = add(from, scale(dir, s));
          crosses = game.roads.net.corridorsNear(p, 260).some((c) => c.lut.closest(p).d < 250);
        }
        if (crosses) continue;
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

/** Пути, кроме платформ вокзалов. */
const tracks = (game: Game) => [...game.net.segments.values()].filter((s) => s.platform === undefined);

/** Первое место сетки, где получилось (неудачная попытка ничего не строит). */
function somewhere(game: Game, tryAt: (p: Vec) => boolean): Vec {
  for (let y = 400; y < game.terrain.height - 400; y += 200) {
    for (let x = 400; x < game.terrain.width - 400; x += 200) if (tryAt({ x, y })) return { x, y };
  }
  throw new Error('Нет места');
}

/** Стройка целиком или никак: не вышло — построенное откатывается. */
function tryBuild(game: Game, build: () => boolean): boolean {
  const state = () => [game.net.version, game.roads.net.version, game.money].join();
  const was = state();
  game.checkpoint('стройка');
  const ok = build();
  game.commit();
  if (!ok && state() !== was) game.undo();
  return ok;
}

/**
 * Стрелка в чистом поле, подальше от far: прямой путь на 500 м вдоль x, ответвление от 150 м (на 40 м вбок
 * к 400 м) и сигнал у 300 м; withRoad — ещё улица поперёк пути у 420 м (переезд). Возвращает начало пути.
 */
function junctionYard(game: Game, far: Vec[], withRoad = false): Vec {
  return somewhere(game, (o) => {
    if (o.x > game.terrain.width - 900 || far.some((f) => dist(f, add(o, { x: 250, y: 0 })) < 700)) return false;
    const main = straight(o, add(o, { x: 500, y: 0 }), RAIL_SPEC);
    if (!game.builder.plan(main).ok) return false;
    return tryBuild(game, () => {
      if (!game.builder.build(main)) return false;
      const start = game.builder.snap(add(o, { x: 150, y: 0 }), 0, 14);
      const branch: RoadRequest = { start, end: { kind: 'free', pos: add(o, { x: 400, y: 40 }), level: 0 }, spec: RAIL_SPEC, mode: 'arc' };
      if (!game.builder.build(branch) || !game.toggleSignal(add(o, { x: 300, y: -6 }), 14)) return false;
      return !withRoad || road(game, { free: add(o, { x: 420, y: -80 }) }, { free: add(o, { x: 420, y: 25 }) });
    });
  });
}

/** Путь с вокзалами в чистом поле — вдали от городов: без машин жителей (они не доезжают сюда, а счёт отнимают). */
function railWorld(): { game: Game; a: Station; b: Station; from: Vec; dir: Vec } {
  const game = withoutCitizens(new Game({ seed: 11, size: 'small', towns: 3, industries: 'few', money: 5_000_000, water: 'dry' }));
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

  it('путь, пересекающий другой под пологим углом, пристыковывается к нему стрелкой', () => {
    const game = new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' });
    const { from, dir } = layTrack(game, 1600);
    const n = { x: -dir.y, y: dir.x };
    // Под углом ~11°: раньше — «пересекаются слишком остро».
    const a = add(add(from, scale(dir, 300)), scale(n, 60));
    const b = add(add(from, scale(dir, 900)), scale(n, -60));
    const req = straight(a, b, RAIL_SPEC);
    expect(game.builder.plan(req).reason).toBeUndefined();
    expect(game.builder.build(req)).not.toBeNull();
    // В точке пересечения — узел на четыре участка; с нового пути можно уехать по старому дальше.
    const cross = [...game.net.nodes.values()].find((x) => x.segments.length === 4)!;
    expect(cross).toBeDefined();
    const startSeg = game.net.nodesNear(a, 1)[0].segments[0];
    const far = game.net.findSegmentNear(add(from, scale(dir, 1500)), 5)!.seg.id;
    expect(game.rail.previewRoute([startSeg], [far])).not.toBeNull();
  });

  it('путь рядом: вдоль прямой и дуги, на расстоянии между путями, со стороны курсора', () => {
    const game = new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 9_000_000, water: 'dry' });
    const { from, dir } = layTrack(game, 1200);
    const n = { x: -dir.y, y: dir.x };
    const before = game.net.segments.size;
    // Тянем от начала до конца — курсор чуть в стороне +n.
    const a = add(from, scale(dir, 100));
    const b = add(add(from, scale(dir, 1100)), scale(n, 20));
    const plan = game.parallelTrackPlan(a, b, 14);
    expect(plan.reason ?? 'ok').toBe('ok');
    expect(game.buildParallelTrack(a, b, 14)).toBeNull();
    const added = [...game.net.segments.values()].filter((s) => s.id > 0 && !s.platform).length - before;
    expect(added).toBeGreaterThan(0);
    // Новый путь — на TRACK_GAP от старого, со стороны +n.
    const probe = add(add(from, scale(dir, 600)), scale(n, 13));
    const hit = game.net.findSegmentNear(probe, 4, (s) => s.spec.cls === 'rail');
    expect(hit).not.toBeNull();
    expect(hit!.d).toBeLessThan(1);
    expect(game.net.findSegmentNear(add(add(from, scale(dir, 600)), scale(n, -13)), 4, (s) => s.spec.cls === 'rail')).toBeNull();
    // Отмена — одним шагом.
    expect(game.undo()).toBe('путь рядом');
    expect(game.net.findSegmentNear(probe, 4, (s) => s.spec.cls === 'rail')).toBeNull();
  });

  it('переезд закрывается перед поездом, машины ждут', () => {
    const { game, a, b, from, dir } = railWorld();
    const n = { x: -dir.y, y: dir.x };
    const mid = add(from, scale(dir, 1200));
    // Под острым углом переезд не построить.
    const acute = roadPlan(game, { free: add(mid, scale(dir, -200)) }, { free: add(add(mid, scale(dir, 200)), scale(n, 60)) });
    expect(acute.ok).toBe(false);
    expect(acute.reason).toBe('Переезд только под углом от 30°');
    expect(road(game, { free: add(mid, scale(n, -200)) }, { free: add(mid, scale(n, 200)) })).toBe(true);
    expect(game.levelCrossings).toHaveLength(1);
    const crossing = game.levelCrossings[0];
    // Путь не режется: дороги и пути — разные сети.
    expect([...game.net.segments.values()].filter((s) => s.platform === undefined).length).toBeGreaterThan(0);
    const line = game.createLine([a.id, b.id])!;
    game.buyVehicle(line.id, 'passengerTrain');
    let closed = 0;
    let onRails = 0;
    runSeconds(game, 150, () => {
      if (crossing.closed) closed++;
      if (crossing.closed && crossing.busy) onRails++;
    });
    expect(closed).toBeGreaterThan(0);
    // Поезд не стоит на переезде вечно: переезд открывается.
    expect(crossing.closed).toBe(false);
    expect(onRails).toBe(0);
  });

  it('дорога над путями — мост без переезда, на той же высоте вплотную вдоль путей — нельзя', () => {
    const { game, from, dir } = railWorld();
    const n = { x: -dir.y, y: dir.x };
    const mid = add(from, scale(dir, 1000));
    const at = (k: number, level: number) => ({ kind: 'free' as const, pos: add(mid, scale(n, k)), level });
    // Пандус, который над путём ещё низко, — мало места по высоте.
    const low = game.roadBuilder.road(at(-100, 0), at(200, 1), STREET_LANES);
    expect(low.reason).toBe('Мало места по высоте');
    // Мост над путём: переезда нет, путь цел.
    const bridge = game.roadBuilder.road(at(-60, 1), at(60, 1), STREET_LANES);
    expect(bridge.ok).toBe(true);
    game.roadBuilder.apply(bridge);
    expect(game.levelCrossings).toHaveLength(0);
    // Вдоль путей вплотную — нельзя.
    const along = roadPlan(game, { free: add(add(from, scale(dir, 1500)), scale(n, 8)) }, { free: add(add(from, scale(dir, 1800)), scale(n, 8)) });
    expect(along.reason).toBe('Слишком близко к путям');
  });

  it('поезд переживает переезд, построенный прямо перед ним, и сохранение', () => {
    const { game, a, b, from, dir } = railWorld();
    const line = game.createLine([a.id, b.id])!;
    game.buyVehicle(line.id, 'freightTrain');
    // Ждём, пока поезд поедет, и режем путь прямо перед ним.
    runSeconds(game, 30);
    const v = [...game.fleet.values()][0];
    expect(v.state).toBe('driving');
    const n = { x: -dir.y, y: dir.x };
    const mid = add(from, scale(dir, 1200));
    expect(road(game, { free: add(mid, scale(n, -150)) }, { free: add(mid, scale(n, 150)) })).toBe(true);
    expect(game.levelCrossings).toHaveLength(1);
    expect(game.fleetTrain(v)).toBeDefined();
    expect(game.fleetTrain(v)!.moving).toBe(true);
    const loaded = withoutCitizens(new Game(game.settings, JSON.parse(JSON.stringify(game.toSave()))));
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

  it('вагоны на стоянке наполняются и пустеют по очереди, в темпе погрузки', () => {
    const { game, a, b } = railWorld();
    const line = game.createLine([a.id, b.id])!;
    // Ждать полной загрузки, но ничего не брать со станции: груз кладём сами.
    game.setStopRule(line.id, 0, { wait: 'full', maxWait: null, load: [], unload: 'auto' });
    const v = game.buyVehicle(line.id, 'freightTrain')!;
    runSeconds(game, 1);
    const train = game.fleetTrain(v)!;
    expect(train.moving).toBe(false);
    expect(train.fill).toBe(0);
    const cap = vehicleCapacity(v);
    const wagons = carsOf(v) - 1;
    // Полпоезда угля: вид догоняет не скачком, а по 10 единиц в секунду.
    v.cargo = 'coal';
    v.amount = cap / 2;
    runSeconds(game, 1);
    expect(train.fill!).toBeGreaterThan(0);
    expect(train.fill!).toBeLessThan(0.15);
    expect(train.load).toBe(CARGO.coal.color);
    runSeconds(game, cap / 2 / 10);
    expect(train.fill).toBeCloseTo(0.5, 6);
    const fills = wagonFills(train.fill!, 1, wagons);
    // 5 вагонов: два полных, третий наполовину, хвостовые пустые.
    expect(fills.filter((f) => f > 0.999)).toHaveLength(Math.floor(wagons / 2));
    expect(fills[wagons - 1]).toBe(0);
    // Выгрузили — пустеют тоже постепенно, потом без цвета груза.
    v.cargo = null;
    v.amount = 0;
    runSeconds(game, 1);
    expect(train.fill!).toBeGreaterThan(0.35);
    expect(train.load).toBe(CARGO.coal.color);
    runSeconds(game, cap / 2 / 10);
    expect(train.fill).toBe(0);
    expect(train.load).toBeUndefined();
    expect(v.state).toBe('loading');
  });
});

describe('Копирование и вставка путей', { timeout: 60_000 }, () => {
  /** Рамка вокруг стрелки «мастерской» от o: путь режется у 50 и 450 м; центр рамки — 250 м от начала пути. */
  const yardBox = (o: Vec): [Vec, Vec] => [add(o, { x: 50, y: -70 }), add(o, { x: 450, y: 70 })];

  it('стрелка с сигналом копируется рамкой и встаёт в чистом поле повёрнутой: по ней можно проехать', () => {
    const game = new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 9_000_000, water: 'dry' });
    const o = junctionYard(game, []);
    const frag = game.copyArea(...yardBox(o))!;
    expect(frag.corridors).toHaveLength(0);
    // Прямой путь режется по рамке: три куска (у стрелки и сигнала — узлы) и ответвление.
    expect(frag.rail!.segs).toHaveLength(4);
    expect(frag.rail!.nodes.filter((n) => n.signals?.length)).toHaveLength(1);
    const before = tracks(game).length;
    const angle = Math.PI / 3;
    const at = somewhere(game, (q) => dist(q, o) > 900 && game.pastePlan(frag, q, angle).ok);
    const plan = game.pastePlan(frag, at, angle);
    expect(plan.rails).toHaveLength(4);
    expect(plan.cost).toBeGreaterThan(0);
    const money = game.money;
    expect(game.paste(frag, at, angle)).toBeNull();
    expect(money - game.money).toBe(plan.cost);
    expect(tracks(game).length).toBe(before + 4);
    const { place } = placer(at, angle);
    const nodeAt = (p: Vec) => game.net.nodesNear(place(p), 1.5)[0];
    // Стрелка на три участка; сигнал — на своём узле и смотрит на свой участок.
    expect(nodeAt({ x: -100, y: 0 }).segments).toHaveLength(3);
    const sig = nodeAt({ x: 50, y: 0 });
    expect(sig.signals).toHaveLength(1);
    expect(sig.segments).toContain(sig.signals![0]);
    // Проезд: с западного конца — на восточный и на ответвление, с ответвления — обратно.
    const west = nodeAt({ x: -200, y: 0 }).segments;
    const east = nodeAt({ x: 200, y: 0 }).segments;
    const branch = nodeAt({ x: 150, y: 40 }).segments;
    expect(game.rail.previewRoute(west, east)).not.toBeNull();
    expect(game.rail.previewRoute(west, branch)).not.toBeNull();
    expect(game.rail.previewRoute(branch, west)).not.toBeNull();
    // Отмена — одним шагом.
    expect(game.undo()).toBe('вставка');
    expect(tracks(game).length).toBe(before);
  });

  it('стрелка встаёт на путь между вокзалами: кусок под рамкой заменяется, срезы примыкают, поезд проезжает', () => {
    const { game, a, b, from, dir } = railWorld();
    const along = [0, 600, 1200, 1800, 2400].map((k) => add(from, scale(dir, k)));
    const o = junctionYard(game, along);
    const frag = game.copyArea(...yardBox(o))!;
    // Ставим у середины пути, чуть мимо и под углом — прилипание выправит.
    const mid = add(from, scale(dir, 1200));
    const snap = snapRails(game.net, frag, add(mid, { x: 4, y: -6 }), angleOf(dir) + 0.2, 30);
    expect(snap.snapped).toBe(true);
    expect(Math.abs(angleDiff(snap.angle, angleOf(dir)))).toBeLessThan(1e-6);
    const top = Math.max(...game.net.segments.keys());
    const plan = game.pastePlan(frag, snap.at, snap.angle);
    expect(plan.reason ?? 'ok').toBe('ok');
    // За снесённый под рамкой кусок пути — возврат.
    expect(plan.railRefund).toBeGreaterThan(0);
    expect(game.paste(frag, snap.at, snap.angle)).toBeNull();
    // Тупиков у рамки нет, кроме конца ответвления: концы куска примкнули к срезам пути.
    const ends = [...game.net.nodes.values()].filter((n) => n.segments.length === 1 && dist(n.pos, snap.at) < 400);
    expect(ends).toHaveLength(1);
    expect(dist(ends[0].pos, placer(snap.at, snap.angle).place({ x: 150, y: 40 }))).toBeLessThan(1);
    // Поезд ходит от вокзала до вокзала — через вставленные участки.
    const line = game.createLine([a.id, b.id])!;
    game.setStopRule(line.id, 0, { wait: 'none', maxWait: null, load: 'auto', unload: 'auto' });
    game.buyVehicle(line.id, 'passengerTrain');
    const v = [...game.fleet.values()][0];
    const used = new Set<number>();
    let arrivals = 0;
    let last = v.state;
    runSeconds(game, 200, () => {
      for (const t of game.rail.trains.values()) for (const s of t.segs) used.add(s);
      if (v.state === 'loading' && last !== 'loading') arrivals++;
      last = v.state;
    });
    expect(game.lines.get(line.id)!.problem).toBeNull();
    expect(arrivals).toBeGreaterThanOrEqual(2);
    expect([...used].some((id) => id > top)).toBe(true);
  });

  it('путь с переездом копируется вместе с улицей и встаёт целиком: и дорога, и путь, и переезд', () => {
    const game = new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 9_000_000, water: 'dry' });
    const o = junctionYard(game, [], true);
    expect(game.levelCrossings).toHaveLength(1);
    const frag = game.copyArea(...yardBox(o))!;
    expect(frag.corridors).toHaveLength(1);
    expect(frag.rail!.segs).toHaveLength(4);
    const roads = game.roads.net.corridors.size;
    const at = somewhere(game, (q) => dist(q, o) > 900 && game.pastePlan(frag, q, -0.4).ok);
    expect(game.paste(frag, at, -0.4)).toBeNull();
    expect(game.roads.net.corridors.size).toBe(roads + 1);
    expect(game.roads.net.problems()).toEqual([]);
    expect(game.levelCrossings).toHaveLength(2);
  });

  it('мост копируется с высотой: пандусы и пролёт встают так же', () => {
    const game = new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 9_000_000, water: 'dry' });
    // Пандус 200 м на мост, пролёт 120 м, пандус вниз.
    const xs = [0, 200, 320, 520];
    const levels = [0, 1, 1, 0];
    const o = somewhere(game, (p) =>
      tryBuild(game, () => {
        let prev: Snap = { kind: 'free', pos: p, level: 0 };
        for (let i = 1; i < xs.length; i++) {
          const res = game.builder.build({ start: prev, end: { kind: 'free', pos: add(p, { x: xs[i], y: 0 }), level: levels[i] }, spec: RAIL_SPEC, mode: 'straight' });
          if (!res) return false;
          prev = { kind: 'node', nodeId: res.endNode, pos: game.net.node(res.endNode).pos, level: levels[i] };
        }
        return true;
      }),
    );
    const frag = game.copyArea(add(o, { x: -20, y: -40 }), add(o, { x: 540, y: 40 }))!;
    expect(frag.rail!.segs).toHaveLength(3);
    expect(frag.rail!.nodes.map((n) => n.level).sort()).toEqual([0, 0, 1, 1]);
    const top = Math.max(...game.net.nodes.keys());
    const at = somewhere(game, (q) => dist(q, add(o, { x: 260, y: 0 })) > 900 && game.pastePlan(frag, q, 0.5).ok);
    expect(game.paste(frag, at, 0.5)).toBeNull();
    const fresh = [...game.net.nodes.values()].filter((n) => n.id > top);
    expect(fresh.map((n) => n.level).sort()).toEqual([0, 0, 1, 1]);
    const ends = fresh.filter((n) => n.segments.length === 1);
    expect(ends).toHaveLength(2);
    expect(game.rail.previewRoute(ends[0].segments, ends[1].segments)).not.toBeNull();
  });
});

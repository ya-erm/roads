import { describe, expect, it } from 'vitest';
import { COST, RAIL_STATION } from '../config';
import { add, scale, Vec } from '../core/vec';
import type { Station } from '../world/entities';
import { RAIL_SPEC } from '../world/roadTypes';
import { carsOnPlatform, clampRailLength, clampRailTracks, Game, platformCars, railStationFee } from './game';
import { withoutCitizens } from './testkit';
import { carsOf } from './transport';

function runSeconds(game: Game, seconds: number, each?: () => void) {
  game.speed = 1;
  for (let t = 0; t < seconds; t += 0.1) {
    game.update(0.1);
    each?.();
  }
}

/** Прямой путь длиной len в свободном месте, рядом с которым встают два вокзала на один путь. */
function layTrack(game: Game, len: number): { from: Vec; dir: Vec; n: Vec } {
  for (let y = 400; y < game.terrain.height - 400; y += 170) {
    for (let x = 300; x < game.terrain.width - len - 300; x += 230) {
      const dir = { x: 1, y: 0 };
      const from = { x, y };
      const req = { start: { kind: 'free' as const, pos: from, level: 0 }, end: { kind: 'free' as const, pos: add(from, scale(dir, len)), level: 0 }, spec: RAIL_SPEC, mode: 'straight' as const };
      if (!game.builder.plan(req).ok) continue;
      game.builder.build(req);
      const n = { x: 0, y: 1 };
      const a = game.stationPlan(add(add(from, scale(dir, 400)), scale(n, 40)), 14, 'rail', 0, 1);
      const b = game.stationPlan(add(add(from, scale(dir, len - 400)), scale(n, 40)), 14, 'rail', 0, 1);
      if (a.ok && b.ok) return { from, dir, n };
      game.builder.bulldoze(add(from, scale(dir, len / 2)), 4);
    }
  }
  throw new Error('Нет места для пути');
}

describe('Вокзал на один путь', { timeout: 30_000 }, () => {
  it('путей — от 1 до 4, цена на один путь — как на два', () => {
    expect(clampRailTracks(0)).toBe(RAIL_STATION.minTracks);
    expect(clampRailTracks(1)).toBe(1);
    expect(clampRailTracks(3)).toBe(3);
    expect(clampRailTracks(9)).toBe(RAIL_STATION.maxTracks);
    expect(clampRailTracks(NaN)).toBe(2);
    expect(railStationFee(1)).toBe(RAIL_STATION.cost);
    expect(railStationFee(2)).toBe(RAIL_STATION.cost);
    expect(railStationFee(4)).toBe(RAIL_STATION.cost * 3);
  });

  it('в чистом поле: платформа на главном пути, без обгонного — дешевле, чем на два', () => {
    const game = new Game({ seed: 11, size: 'small', towns: 3, industries: 'few', money: 5_000_000, water: 'dry' });
    let st: Station | null = null;
    for (let y = 600; y < game.terrain.height - 600 && !st; y += 300) {
      for (let x = 600; x < game.terrain.width - 600 && !st; x += 300) {
        const one = game.stationPlan({ x, y }, 14, 'rail', 0, 1);
        const two = game.stationPlan({ x, y }, 14, 'rail', 0, 2);
        if (!one.ok || !two.ok) continue;
        expect(one.rail?.tracks).toHaveLength(0);
        expect(one.cost).toBeLessThan(two.cost);
        const before = game.money;
        st = game.placeStation({ x, y }, 14, 'rail', { pax: true, cargo: true }, 0, 1);
        expect(st).not.toBeNull();
        expect(before - game.money).toBe(one.cost);
      }
    }
    expect(st).not.toBeNull();
    expect(st!.platforms).toHaveLength(1);
    expect(st!.bays).toBe(1);
    const platform = game.net.segment(st!.platforms[0]);
    expect(platform.platform).toBe(st!.id);
    // Здание — вплотную к единственному пути.
    expect(platform.lut.closest(st!.fp.center).d).toBeLessThan(RAIL_STATION.size.h + 10);
    // Снос: главный путь остаётся, за вокзал возвращаем как за обычный.
    const money = game.money;
    expect(game.removeStation(st!)).toBe(true);
    expect(game.money - money).toBe(Math.round(railStationFee(1) * COST.refundRatio));
    expect(game.net.segments.get(platform.id)?.platform).toBeUndefined();
  });

  it('поезд ходит между вокзалами на один путь', () => {
    // Путь в чистом поле: машины жителей сюда не доезжают — без них счёт в разы быстрее.
    const game = withoutCitizens(new Game({ seed: 11, size: 'small', towns: 3, industries: 'few', money: 5_000_000, water: 'dry' }));
    const len = 2400;
    const { from, dir, n } = layTrack(game, len);
    const a = game.placeStation(add(add(from, scale(dir, 400)), scale(n, 40)), 14, 'rail', { pax: true, cargo: true }, 0, 1)!;
    const b = game.placeStation(add(add(from, scale(dir, len - 400)), scale(n, 40)), 14, 'rail', { pax: true, cargo: true }, 0, 1)!;
    expect(a.platforms).toHaveLength(1);
    expect(b.platforms).toHaveLength(1);
    const line = game.createLine([a.id, b.id])!;
    for (const i of [0, 1]) game.setStopRule(line.id, i, { wait: 'none', maxWait: null, load: 'auto', unload: 'auto' });
    expect(game.buyVehicle(line.id, 'passengerTrain')).not.toBeNull();
    const visited = new Set<number>();
    runSeconds(game, 300, () => {
      for (const t of game.rail.trains.values()) if (!t.moving && t.platform !== null) visited.add(t.platform);
    });
    expect(visited.has(a.platforms[0])).toBe(true);
    expect(visited.has(b.platforms[0])).toBe(true);
    expect(line.problem).toBeNull();
  });
});

describe('Длина вокзала', { timeout: 40_000 }, () => {
  // Вокзалы в чистом поле, без машин жителей (сюда они не доезжают, а счёт отнимают).
  const world = () => withoutCitizens(new Game({ seed: 11, size: 'small', towns: 3, industries: 'few', money: 9_000_000, water: 'dry' }));
  /** Вокзал с платформами длиной length на пути: в точке dist от начала, со стороны n. */
  const station = (game: Game, at: Vec, length: number, tracks = 2): Station => {
    const st = game.placeStation(at, 14, 'rail', { pax: true, cargo: true }, 0, tracks, length);
    expect(st).not.toBeNull();
    return st!;
  };

  it('длина — от 50 до 400 м шагом 50, цена растёт с длиной', () => {
    expect(clampRailLength(0)).toBe(RAIL_STATION.minLength);
    expect(clampRailLength(149)).toBe(150);
    expect(clampRailLength(1000)).toBe(RAIL_STATION.maxLength);
    expect(clampRailLength(NaN)).toBe(RAIL_STATION.platform);
    // У обычной платформы — прежняя цена; половина — здание, половина — по длине.
    expect(railStationFee(2, 150)).toBe(RAIL_STATION.cost);
    expect(railStationFee(2, 300)).toBe(RAIL_STATION.cost * 1.5);
    expect(railStationFee(3, 50)).toBeLessThan(railStationFee(3, 150));
    expect(carsOnPlatform(150, 20)).toBe(7);
    expect(carsOnPlatform(150, 17)).toBe(8);
    expect(carsOnPlatform(400, 20)).toBe(19);
  });

  it('подпись у длины: пассажирских и грузовых вагонов — столько же, сколько разрешит карточка поезда', () => {
    expect(platformCars(150)).toEqual({ passenger: 7, freight: 8 });
    expect(platformCars(400)).toEqual({ passenger: 19, freight: 23 });
    expect(platformCars(50)).toEqual({ passenger: 2, freight: 2 });
    // Совпадает с пределом maxCars у поездов на линии между такими вокзалами.
    const game = world();
    const len = 2400;
    const { from, dir, n } = layTrack(game, len);
    const at = (s: number) => add(add(from, scale(dir, s)), scale(n, 40));
    const a = station(game, at(400), 250);
    const b = station(game, at(len - 400), 250);
    const line = game.createLine([a.id, b.id])!;
    const pax = game.buyVehicle(line.id, 'passengerTrain')!;
    const freight = game.buyVehicle(line.id, 'freightTrain')!;
    expect(game.maxCars(pax)).toBe(platformCars(250).passenger);
    expect(game.maxCars(freight)).toBe(platformCars(250).freight);
  });

  it('платформа той длины, что выбрана: длинная дороже и вмещает поезд длиннее', () => {
    const game = world();
    let found: Vec | null = null;
    for (let y = 600; y < game.terrain.height - 600 && !found; y += 300) {
      for (let x = 600; x < game.terrain.width - 600 && !found; x += 300) {
        const short = game.stationPlan({ x, y }, 14, 'rail', 0, 2, 150);
        const long = game.stationPlan({ x, y }, 14, 'rail', 0, 2, 300);
        if (!short.ok || !long.ok) continue;
        expect(long.cost).toBeGreaterThan(short.cost);
        found = { x, y };
      }
    }
    expect(found).not.toBeNull();
    const st = station(game, found!, 300);
    for (const p of st.platforms) expect(game.net.segment(p).length).toBeCloseTo(300, 0);
  });

  it('поезд на длинных платформах — с вагонами до их длины, на коротких — новый поезд короче', () => {
    const game = world();
    const len = 2400;
    const { from, dir, n } = layTrack(game, len);
    const at = (s: number) => add(add(from, scale(dir, s)), scale(n, 40));
    const a = station(game, at(400), 300);
    const b = station(game, at(len - 400), 300);
    const line = game.createLine([a.id, b.id])!;
    for (const i of [0, 1]) game.setStopRule(line.id, i, { wait: 'none', maxWait: null, load: 'auto', unload: 'auto' });
    const v = game.buyVehicle(line.id, 'passengerTrain')!;
    // 300 м: пассажирских вагонов по 20 м встанет 14.
    expect(game.maxCars(v)).toBe(carsOnPlatform(300, 20));
    expect(game.setTrainCars(v.id, 14)).toBe(true);
    expect(carsOf(v)).toBe(14);
    const visited = new Set<number>();
    runSeconds(game, 300, () => {
      for (const t of game.rail.trains.values()) if (!t.moving && t.platform !== null) visited.add(t.platform);
    });
    expect([...visited].some((p) => b.platforms.includes(p))).toBe(true);
    expect(line.problem).toBeNull();

    // Вокзал на 50 м: новый поезд линии к нему сразу короче — 2 вагона.
    const game2 = world();
    const t2 = layTrack(game2, len);
    const at2 = (s: number) => add(add(t2.from, scale(t2.dir, s)), scale(t2.n, 40));
    const c = station(game2, at2(400), 50);
    const d = station(game2, at2(len - 400), 150);
    const line2 = game2.createLine([c.id, d.id])!;
    const v2 = game2.buyVehicle(line2.id, 'passengerTrain')!;
    expect(carsOf(v2)).toBe(2);
    const stops = new Set<number>();
    runSeconds(game2, 300, () => {
      for (const t of game2.rail.trains.values()) if (!t.moving && t.platform !== null) stops.add(t.platform);
    });
    expect([...stops].some((p) => c.platforms.includes(p))).toBe(true);
    expect([...stops].some((p) => d.platforms.includes(p))).toBe(true);
    expect(line2.problem).toBeNull();
  });

  it('поезд длиннее платформ нового вокзала маршрута — понятное предупреждение', () => {
    const game = world();
    const len = 2400;
    const { from, dir, n } = layTrack(game, len);
    const at = (s: number) => add(add(from, scale(dir, s)), scale(n, 40));
    const a = station(game, at(400), 150);
    const short = station(game, at(1200), 100);
    const b = station(game, at(len - 400), 150);
    const line = game.createLine([a.id, b.id])!;
    for (const i of [0, 1]) game.setStopRule(line.id, i, { wait: 'none', maxWait: null, load: 'auto', unload: 'auto' });
    const v = game.buyVehicle(line.id, 'passengerTrain')!;
    expect(game.setTrainCars(v.id, 7)).toBe(true);
    // Короткий вокзал добавили в маршрут после покупки: семь вагонов на 100 м не встанут.
    expect(game.addLineStop(line.id, short.id)).toBeNull();
    expect(game.maxCars(v)).toBe(carsOnPlatform(100, 20));
    let problem: string | null = null;
    runSeconds(game, 400, () => {
      if (line.problem) problem = line.problem;
    });
    expect(problem).toMatch(/длиннее платформ/);
    expect(problem).toContain(short.name);
  });
});

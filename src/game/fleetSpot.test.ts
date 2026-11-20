import { describe, expect, it } from 'vitest';
import { MONTH_LENGTH, STATION } from '../config';
import { dist } from '../core/vec';
import { twoWay } from '../lanes/model';
import { CURB_GAP } from '../lanes/traffic';
import { LANE_W } from '../world/roadTypes';
import { Game } from './game';
import { connectStations, fieldSpot, road, runUntil, stationAtIndustry, withoutCitizens } from './testkit';
import { bayBox, bayPose, LONGEST_BUS, MODELS, stopBerth } from './transport';

describe('Бокс поста автостанции', () => {
  it('боксы идут подряд вдоль здания, от середины к воротам — как на рисунке станции', () => {
    const fp = { center: { x: 100, y: 50 }, w: 40, h: 20, angle: 0 };
    const boxes = [0, 1, 2].map((i) => bayBox(fp, 3, i));
    const bw = (fp.w - 10) / 3;
    expect(boxes[0].w).toBeCloseTo(bw - 2);
    expect(boxes[0].h).toBeCloseTo(11);
    expect(boxes[1].center.x - boxes[0].center.x).toBeCloseTo(bw);
    // Боксы — от края здания + 5, промежуток 2 — справа от каждого.
    expect(boxes[0].center.x - (bw - 2) / 2).toBeCloseTo(100 - 20 + 5);
    // Ворота со стороны +y: бокс от y = −1 до hh = 10 (в координатах здания).
    expect(boxes[0].center.y).toBeCloseTo(50 + 4.5);
    expect(bayBox(fp, 3, 0, -1).center.y).toBeCloseTo(50 - 4.5);
  });

  it('на посту новой станции любая машина — целиком на площадке; нос сочленённого — у фасада вокзала', () => {
    const fp = { center: { x: 0, y: 0 }, w: STATION.size.w, h: STATION.size.h, angle: 0 };
    for (const m of Object.values(MODELS)) {
      if (m.mode !== 'road') continue;
      // Нос — к задней стене (−y), корма — к воротам (+y).
      const p = bayPose(fp, STATION.bays, 1, m.spec.length);
      expect(p.dir.y, m.id).toBeCloseTo(-1);
      expect(p.pos.y, m.id).toBeGreaterThanOrEqual(-fp.h / 2 + 1 - 1e-9);
      expect(p.pos.y + m.spec.length, m.id).toBeLessThanOrEqual(fp.h / 2);
    }
    // Здание автовокзала 6,5 м у задней стены (метр от неё) — за самым длинным автобусом.
    expect(bayPose(fp, STATION.bays, 1, LONGEST_BUS).pos.y).toBeCloseTo(-fp.h / 2 + 1 + 6.5);
  });

  it('открытые грузовые посты шириной с полосу и вмещают длинную фуру даже на широком дворе', () => {
    const fp = { center: { x: 100, y: 50 }, w: 126, h: 56, angle: 0 };
    const length = 21;
    for (let i = 0; i < 5; i++) {
      const box = bayBox(fp, 5, i, -1, true);
      const parked = bayPose(fp, 5, i, length, -1);
      expect(box.w).toBe(LANE_W);
      expect(box.center.x).toBeCloseTo(parked.pos.x);
      expect(parked.pos.y).toBeLessThan(box.center.y + box.h / 2);
      expect(parked.pos.y - length).toBeGreaterThan(box.center.y - box.h / 2);
    }
  });
});

describe('Место автобуса у остановки', () => {
  const fp = { center: { x: 0, y: 0 }, w: 20, h: 6, angle: 0 };

  it('вдоль бордюра со стороны улицы, носы — через длину автобуса и зазор (по умолчанию 18), носом вдоль него', () => {
    const a = stopBerth(fp, { x: 0, y: 30 }, 0, 2);
    const b = stopBerth(fp, { x: 0, y: 30 }, 1, 2);
    // Бордюр — в 2 от навеса; борт автобуса шириной 4.8 (по умолчанию) — в CURB_GAP от бордюра.
    expect(a.pos.y).toBeCloseTo(3 + 2 + CURB_GAP + 4.8 / 2);
    expect(stopBerth(fp, { x: 0, y: 30 }, 0, 1, 4.2).pos.y).toBeCloseTo(3 + 2 + CURB_GAP + 4.2 / 2);
    expect(b.pos.y).toBeCloseTo(a.pos.y);
    expect(b.pos.x - a.pos.x).toBeCloseTo(18);
    // Сочленённые (22 м) — через 24: друг на друга не заходят.
    expect(stopBerth(fp, { x: 0, y: 30 }, 1, 2, 4.8, 24).pos.x - stopBerth(fp, { x: 0, y: 30 }, 0, 2, 4.8, 24).pos.x).toBeCloseTo(24);
    expect(a.pos.x + b.pos.x).toBeCloseTo(0);
    expect(Math.abs(a.dir.x)).toBeCloseTo(1);
    expect(a.dir).toEqual(b.dir);
  });

  it('улица с другой стороны — и место там, и едет навстречу', () => {
    const near = stopBerth(fp, { x: 0, y: 30 }, 0, 1);
    const far = stopBerth(fp, { x: 0, y: -30 }, 0, 1);
    expect(far.pos.y).toBeCloseTo(-near.pos.y);
    expect(far.dir.x).toBeCloseTo(-near.dir.x);
  });
});

describe('Где машина компании на карте (подсветка из списка маршрута)', { timeout: 90_000 }, () => {
  it('новая — на свободном посту первой станции, в пути — по кузову, на посту — внутри автостанции', () => {
    // Трасса — своя сеть в стороне от городов: машины жителей на неё не попадают, без них счёт в разы быстрее.
    const game = withoutCitizens(new Game(7));
    game.money = 5_000_000;
    const pairs = game.industries
      .filter((i) => i.info.kind === 'farm')
      .flatMap((f) => game.industries.filter((i) => i.info.kind === 'foodplant').map((p) => ({ f, p, d: dist(f.fp.center, p.fp.center) })))
      .sort((a, b) => a.d - b.d);
    const { f, p } = pairs[0];
    const sA = stationAtIndustry(game, f, p.fp.center)!;
    const sB = stationAtIndustry(game, p, f.fp.center)!;
    expect(connectStations(game, sA, sB, { cls: 'highway', lanes: twoWay(1, 1) })).toBe(true);
    const line = game.createLine([sA.id, sB.id])!;
    const v = game.buyVehicle(line.id, 'truck')!;
    const L = MODELS.truck.mode === 'road' ? MODELS.truck.spec.length : 0;

    // Новая грузится на первой станции, не заняв поста, — нарисована на свободном посту, там и кольцо.
    expect(game.fleetLook(v)).toBeUndefined();
    expect(v.inBay).toBe(false);
    expect(game.stationBays(sA).filter(Boolean)).toEqual([line.color]);
    const fresh = game.fleetSpot(v)!;
    expect(fresh.station).toBeUndefined();
    expect(game.inFootprint(fresh.pos, sA.fp)).toBe(true);

    // Выехала — кольцо вокруг кузова: центр на половине длины за носом.
    game.speed = 1;
    for (let t = 0; t < MONTH_LENGTH && v.simId === null; t += 0.1) game.update(0.1);
    const look = game.fleetLook(v)!;
    expect(look).toBeDefined();
    const onRoad = game.fleetSpot(v)!;
    expect(onRoad.station).toBeUndefined();
    expect(dist(onRoad.pos, look.pos)).toBeCloseTo(L / 2);
    expect(onRoad.r).toBeCloseTo(L * 0.9 + 3);

    // На открытом посту у комбината рисуется сам грузовик, включая момент заезда.
    for (let t = 0; t < MONTH_LENGTH * 3 && !(v.stop === 1 && v.enter); t += 0.1) game.update(0.1);
    expect(v.stop === 1 && v.enter).toBeTruthy();
    const entering = game.fleetLook(v)!;
    expect(game.bayLooks(sB)).toContainEqual(entering);
    expect(game.enteringLooks()).not.toContainEqual(entering);
    for (let t = 0; t < MONTH_LENGTH && v.enter; t += 0.1) game.update(0.1);
    expect(v.inBay && !v.enter).toBe(true);
    expect(game.fleetLook(v)).toBeUndefined();
    expect(game.bayLooks(sB)).toHaveLength(1);
    const inBay = game.fleetSpot(v)!;
    expect(inBay.station).toBeUndefined();
    expect(game.inFootprint(inBay.pos, sB.fp)).toBe(true);

    expect(runUntil(game, MONTH_LENGTH, () => v.yardExit !== undefined)).toBe(true);
    let previous = game.fleetLook(v)!;
    expect(runUntil(game, MONTH_LENGTH, () => v.simId !== null, () => {
      const current = game.fleetLook(v)!;
      expect(dist(current.pos, previous.pos)).toBeLessThan(2);
      previous = current;
    })).toBe(true);
    expect(sB.occupied).not.toContain(v.id);
  });

  it('новые автобусы на автовокзале — каждый на своём окрашенном посту, кому поста не хватило — у станции', () => {
    const game = new Game(42);
    game.money = 5_000_000;
    const a = fieldSpot(game, 500);
    expect(road(game, { free: a }, { free: { x: a.x + 500, y: a.y } })).toBe(true);
    const sA = game.placeStation({ x: a.x + 120, y: a.y - 30 }, 14)!;
    const sB = game.placeStation({ x: a.x + 380, y: a.y - 30 }, 14)!;
    expect(sA.kind).toBe('road');
    const line = game.createLine([sA.id, sB.id])!;
    const buses = Array.from({ length: sA.bays + 1 }, () => game.buyVehicle(line.id, 'bus')!);
    // Грузятся все, поста не занял никто — но на рисунке станции каждый на своём посту.
    expect(buses.every((v) => v.state === 'loading' && !v.inBay)).toBe(true);
    expect(sA.occupied).toEqual([]);
    expect(game.stationBays(sA)).toEqual(Array(sA.bays).fill(line.color));
    const spots = buses.map((v) => game.fleetSpot(v)!);
    const onBays = spots.slice(0, sA.bays);
    for (const s of onBays) {
      expect(s.station).toBeUndefined();
      // Подсвечивается сам бокс поста — он внутри здания и уже трети станции.
      expect(s.box).toBeDefined();
      expect(s.pos).toEqual(s.box!.center);
      expect(game.inFootprint(s.pos, sA.fp)).toBe(true);
      expect(s.box!.w).toBeLessThan(sA.fp.w / sA.bays);
    }
    expect(new Set(onBays.map((s) => `${s.pos.x.toFixed(1)},${s.pos.y.toFixed(1)}`)).size).toBe(sA.bays);
    // Лишнему поста нет — кольцо вокруг автовокзала.
    expect(spots[sA.bays]).toMatchObject({ pos: sA.fp.center, station: true });
    // Ушёл с поста — пост освободился и достался тому, кто ждал.
    game.sellVehicle(buses[0].id);
    expect(game.stationBays(sA)).toEqual(Array(sA.bays).fill(line.color));
    expect(game.fleetSpot(buses[sA.bays])!.station).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../config';
import { dist } from '../core/vec';
import type { Town, TownBuilding } from '../world/entities';
import { CAR_SIZE } from '../world/houseAccess';
import { flatsOf, formOf } from '../world/townForms';
import { STALL_MIN_D, yardLotOf } from '../world/yardLots';
import { nowhereShare, watchCarFlow } from './carFlow';
import { CAR_HOMES, carKey, type FleetCar } from './carHomes';
import { Game, type SaveData } from './game';
import { GARAGE_TRIPS } from './garages';
import { stallKey } from './shopParking';
import { freshGame, runSeconds, withoutCitizens } from './testkit';

const WORLD: [number, number, number, number] = [-1e6, -1e6, 1e6, 1e6];
const CAR = { kind: 'car' as const, length: CAR_SIZE.l, width: CAR_SIZE.w, maxSpeed: 60, accel: 10 };
const step = (game: Game) => game.update(SIM_DT);

/**
 * Машина парка дома, с местом, к которому можно подъехать, — первая подходящая (и её город). Поворот к месту — подальше
 * от начала полосы: машина с разгона успевает остановиться напротив заезда (иначе проезжает мимо и «возвращается
 * незаметно» у узла).
 */
function fleetCar(game: Game, ok: (c: FleetCar) => boolean): { town: Town; car: FleetCar } {
  for (const town of game.towns)
    for (const car of game.carHomes.fleet(town).cars) {
      const slot = car.place && game.garages.slotOf(car.place.spot);
      if (slot && slot.mid > 45 && ok(car) && game.carHomes.isHome(town, car.key)) return { town, car };
    }
  throw new Error('нет такой машины');
}

/** Деловой дом города с узлом — куда ехать. */
const jobOf = (town: Town): TownBuilding => town.buildings.find((b) => b.kind === 'com' && formOf(b) === 'office') ?? town.buildings.find((b) => b.kind === 'com')!;

/** Машина видна на своём месте (рисунок парка — вблизи). */
const seen = (game: Game, car: FleetCar) => game.carHomes.looks(WORLD).some((l) => car.place!.look && dist(l.look.pos, car.place!.look.pos) < 0.01);

describe('Парк машин жителей', { timeout: 120_000 }, () => {
  it('парк по домам: частный дом — 1 машина у гаража или площадки (вторая — у 20 % с гаражом), многоквартирный — 0,15 на квартиру', () => {
    const game = freshGame(7);
    let cottages = 0;
    let second = 0;
    let garaged = 0;
    for (const town of game.towns) {
      const f = game.carHomes.fleet(town);
      for (const b of town.buildings) {
        if (b.kind !== 'res') continue;
        const cars = f.byHome.get(b.id) ?? [];
        // Ключ машины — дом × 64 + номер.
        cars.forEach((c, k) => expect(c.key).toBe(carKey(b.id, k)));
        const form = formOf(b);
        if (form === 'cottage' || form === 'dacha') {
          const home = game.garages.homeOf(b);
          if (!home) {
            expect(cars.length).toBe(0);
            continue;
          }
          cottages++;
          if (home.kind === 'garage') garaged++;
          expect(cars[0].place!.kind).toBe(home.kind);
          if (cars.length === 2) {
            second++;
            expect(home.kind).toBe('garage');
            expect(cars[1].place!.kind).toBe('apron');
          } else expect(cars.length).toBe(1);
        } else expect(cars.length).toBe(Math.min(CAR_HOMES.maxPerHome, Math.round(flatsOf(b) * CAR_HOMES.perFlat)));
      }
    }
    expect(cottages).toBeGreaterThan(100);
    expect(second / garaged).toBeCloseTo(GARAGE_TRIPS.secondCar, 1);
  });

  it('место ночёвки: двор дома, не больше его мест, остальным — боксы в 700 ед., пока есть; места — 4,6 × 8,5 ед.', () => {
    const game = freshGame(7);
    let yard = 0;
    let box = 0;
    for (const town of game.towns) {
      const f = game.carHomes.fleet(town);
      const boxes = new Map<number, number>();
      for (const b of town.buildings) {
        const lot = b.kind === 'res' && formOf(b) !== 'cottage' && formOf(b) !== 'dacha' ? yardLotOf(b) : null;
        const cars = f.byHome.get(b.id) ?? [];
        const own = cars.filter((c) => c.place?.at === b);
        const stalls = lot ? lot.rows.reduce((s, r) => s + r.stalls.length, 0) : 0;
        // Место — 4,6 ед. шириной, 8,5 вглубь (мельче — где двор неглубок, но не мельче машины с запасом).
        for (const r of lot?.rows ?? [])
          for (const s of r.stalls) {
            expect(Math.min(s.w, s.h)).toBe(4.6);
            expect(Math.max(s.w, s.h)).toBeGreaterThanOrEqual(STALL_MIN_D);
            expect(Math.max(s.w, s.h)).toBeLessThanOrEqual(8.5);
          }
        if (lot) {
          // Сначала — двор: в боксы и без места — только когда во дворе мест нет.
          expect(own.length).toBe(Math.min(stalls, cars.length));
          yard += own.length;
        }
        for (const c of cars) {
          if (c.place?.kind !== 'box') continue;
          box++;
          expect(dist(c.place.at.fp.center, b.fp.center)).toBeLessThan(CAR_HOMES.boxRange);
          boxes.set(c.place.at.id, (boxes.get(c.place.at.id) ?? 0) + 1);
          if (!c.place) expect(own.length).toBe(stalls);
        }
      }
      // В гаражах машин — не больше боксов.
      for (const [id, n] of boxes) {
        const lot = yardLotOf(town.buildings.find((x) => x.id === id)!)!;
        expect(n).toBeLessThanOrEqual(lot.rows.reduce((s, r) => s + r.stalls.length, 0));
      }
    }
    expect(yard).toBeGreaterThan(100);
    expect(box).toBeGreaterThan(20);
  });

  it('машина уезжает со двора через ворота и возвращается на своё место: дома видна на нём, в пути — нет', () => {
    const game = withoutCitizens(freshGame(7));
    const { town, car } = fleetCar(game, (c) => c.place!.kind === 'yard');
    const place = car.place!;
    const dest = jobOf(town);
    expect(place.spot.d.garage).toBe(true);
    expect(seen(game, car)).toBe(true);
    game.carHomes.depart({ kind: 'out', car, town }, dest);
    // Сразу не видна на месте: выезжает из ворот (рисунок манёвра — с воротами, за ними её не видно).
    expect(seen(game, car)).toBe(false);
    let gate = false;
    let simId: number | undefined;
    for (let i = 0; i < 30 * 60 && simId === undefined; i++) {
      step(game);
      if (game.garageLooks(WORLD, true).some((l) => l.gate && dist(l.gate.pos, place.spot.d.gate) < 0.01)) gate = true;
      const m = game.garages.moveOf(place.spot.key);
      if (m?.sim) simId = m.sim.id;
    }
    expect(gate).toBe(true);
    expect(simId).toBeDefined();
    expect(game.tripOf(simId!)).toEqual({ from: car.home, to: dest });
    // Встала в поток — не дома: в Town.cars, у цели простоит своё.
    const e = game.carHomes.awayOf(town, car.key)!;
    expect(e).toMatchObject({ car: car.key, at: dest.id });
    expect(e.until!).toBeGreaterThan(game.time);
    expect(seen(game, car)).toBe(false);
    // Доехала до цели — стоит у неё; срок вышел — едет домой (как решила бы поездка жителя).
    for (let i = 0; i < 30 * 240 && game.carHomes.isMoving(car.key); i++) step(game);
    expect(game.carHomes.isMoving(car.key)).toBe(false);
    const way = game.garages.wayHome(dest.anchor, place.spot)!;
    const sim = game.traffic.spawn({ ...CAR, color: car.color, targetNode: way.slot.link.toNode!, route: way.route })!;
    // Машина жителя — как у поездки (Game.spawnCitizenTrip): в счёте и с хозяином.
    game.citizenCars++;
    (game as unknown as { owners: Map<number, unknown> }).owners.set(sim.id, { type: 'citizen', trip: { from: dest, to: car.home } });
    game.carHomes.homeward(sim, { kind: 'back', car, town, from: dest }, way.slot);
    let entered = false;
    for (let i = 0; i < 30 * 240 && !game.carHomes.isHome(town, car.key); i++) {
      step(game);
      if (game.garages.moveOf(place.spot.key)?.kind === 'in') entered = true;
    }
    // Въехала в ворота двора — и видна на своём месте.
    expect(entered).toBe(true);
    expect(game.carHomes.isHome(town, car.key)).toBe(true);
    expect(game.carHomes.awayOf(town, car.key)).toBeUndefined();
    expect(seen(game, car)).toBe(true);
  });

  it('машина панельки ночует в кармане у улицы и выезжает с места на виду: задним ходом через тротуар на полосу, без ворот', () => {
    const game = withoutCitizens(freshGame(7));
    const { town, car } = fleetCar(game, (c) => formOf(c.home) === 'slab' && c.place!.kind === 'stall');
    const place = car.place!;
    expect(place.spot.d.garage).toBe(false);
    expect(seen(game, car)).toBe(true);
    game.carHomes.depart({ kind: 'out', car, town }, jobOf(town));
    // Кузов — от места до полосы без скачков и без проёма ворот: видна всё время, пока не встала в поток.
    let last = place.look!.pos;
    let jump = 0;
    let frames = 0;
    let simId: number | undefined;
    for (let i = 0; i < 30 * 60 && simId === undefined; i++) {
      step(game);
      const m = game.garages.moveOf(place.spot.key);
      if (m?.sim) simId = m.sim.id;
      const looks = game.garageLooks(WORLD, true).filter((l) => l.look.color === car.color && dist(l.look.pos, place.spot.d.curb) < 20);
      expect(looks.some((l) => l.gate)).toBe(false);
      const near = looks.sort((p, q) => dist(p.look.pos, last) - dist(q.look.pos, last))[0];
      if (!near || simId !== undefined) continue;
      frames++;
      jump = Math.max(jump, dist(near.look.pos, last));
      last = near.look.pos;
    }
    expect(simId).toBeDefined();
    expect(frames).toBeGreaterThan(30);
    expect(jump).toBeLessThan(1);
  });

  it('со стоянки магазина машина парка едет на своё место, а не к случайному дому', () => {
    const game = withoutCitizens(freshGame(7));
    const { town, car } = fleetCar(game, (c) => c.place!.kind === 'pad' || c.place!.kind === 'stall');
    // Стоит на стоянке магазина своего города, к которой можно подъехать.
    let shop: { b: TownBuilding; k: number } | null = null;
    for (const b of town.buildings) {
      const lot = b.kind === 'com' ? game.shops.lotOf(b) : null;
      const k = lot ? lot.spots.findIndex((s) => game.garages.slotOf(s)) : -1;
      if (k >= 0 && !town.shopParked?.some((c) => c.b === b.id)) {
        shop = { b, k };
        break;
      }
    }
    expect(shop).not.toBeNull();
    const { b, k } = shop!;
    town.shopParked = [...(town.shopParked ?? []), { b: b.id, k, color: car.color, until: game.time + 1, car: car.key }];
    town.cars = [{ car: car.key, spot: stallKey(b.id, k), at: b.id, until: game.time }];
    expect(game.carHomes.isHome(town, car.key)).toBe(false);
    let trip: ReturnType<Game['tripOf']> = null;
    let entered = false;
    for (let i = 0; i < 30 * 240 && !game.carHomes.isHome(town, car.key); i++) {
      step(game);
      const m = game.garages.moveOf(stallKey(b.id, k));
      if (m?.sim) trip = game.tripOf(m.sim.id);
      if (game.garages.moveOf(car.place!.spot.key)?.kind === 'in') entered = true;
    }
    expect(trip).toEqual({ from: b, to: car.home });
    expect(entered).toBe(true);
    expect(game.carHomes.isHome(town, car.key)).toBe(true);
    expect(town.shopParked!.some((c) => c.car === car.key)).toBe(false);
    expect(seen(game, car)).toBe(true);
  });

  /**
   * Партия seed 7 с машинами жителей на две минуты — одна на оба теста ниже (та же свежая партия, считается один раз,
   * а не дважды): поток машин за всё время и снимок на первой минуте — сохранение и кто не дома.
   */
  type AtMinute = { away: number; shopCar: boolean; save: SaveData; settings: Game['settings']; towns: { carTrips?: number; cars?: unknown }[] };
  let run: { flow: ReturnType<typeof watchCarFlow>['flow']; minute: AtMinute } | undefined;
  const cityRun = () => {
    if (run) return run;
    const game = freshGame(7);
    const w = watchCarFlow(game);
    let t = 0;
    let minute: AtMinute | undefined;
    runSeconds(game, 120, () => {
      w.frame();
      t += 0.1;
      if (minute || t < 60) return;
      minute = {
        away: game.towns.reduce((s, x) => s + (x.cars?.length ?? 0), 0),
        // Машины парка на стоянках магазинов — тоже с меткой машины.
        shopCar: game.towns.some((x) => x.shopParked?.some((c) => c.car !== undefined)),
        save: JSON.parse(JSON.stringify(game.toSave())) as SaveData,
        settings: structuredClone(game.settings),
        towns: structuredClone(game.towns.map((x) => ({ carTrips: x.carTrips, cars: x.cars }))),
      };
    });
    run = { flow: w.flow, minute: minute! };
    return run;
  };

  it('«из ниоткуда»: машин, что появляются у узла, — меньше пятой части (было ~60 %), без своего места — ещё меньше', () => {
    const w = cityRun();
    const s = nowhereShare(w.flow);
    expect(w.flow.placeIn).toBeGreaterThan(300);
    expect(s.appear).toBeLessThan(0.25);
    // Без машин парка (едут от цели домой, встали у цели) — машины без места: появились и пропали у узла.
    expect(s.nowhereIn).toBeLessThan(0.2);
    expect(s.nowhereOut).toBeLessThan(0.3);
  });

  it('сохранение: кто не дома и номер поездки — с городом; после загрузки на местах ровно машины, что дома', () => {
    // Партия на первой минуте (cityRun): сохранение и что было в игре в тот кадр.
    const a = cityRun().minute;
    expect(a.away).toBeGreaterThan(20);
    expect(a.shopCar).toBe(true);
    const b = new Game(structuredClone(a.settings), structuredClone(a.save));
    for (const [i, t] of b.towns.entries()) {
      expect(t.carTrips).toBe(a.towns[i].carTrips);
      expect(t.cars).toEqual(a.towns[i].cars);
    }
    let want = 0;
    for (const t of b.towns) for (const c of b.carHomes.fleet(t).cars) if (c.place?.look && b.carHomes.isHome(t, c.key)) want++;
    expect(b.carHomes.looks(WORLD).length).toBe(want);
    // Ехавшие — у цели: потом едут домой, как прочие.
    runSeconds(b, 60);
    const back = b.towns.reduce((s, t) => s + (t.cars?.length ?? 0), 0);
    expect(back).toBeGreaterThan(0);
  });

  it('старое сохранение: учёт гаражей переносится в парк (номер поездки, уехавшие), остальные машины дома', () => {
    const a = freshGame(7);
    const save = JSON.parse(JSON.stringify(a.toSave())) as SaveData;
    const town = save.towns[0];
    const home = town.buildings.find((b) => b.kind === 'res' && a.garages.homeOf(b))!;
    delete town.cars;
    delete town.carTrips;
    town.garageTrips = 17;
    town.garageAway = [home.id];
    for (const t of save.towns.slice(1)) {
      delete t.cars;
      delete t.carTrips;
    }
    const g = new Game(structuredClone(a.settings), save);
    const t = g.towns[0];
    expect(t.carTrips).toBe(17);
    expect(t.garageTrips).toBeUndefined();
    expect(t.garageAway).toBeUndefined();
    const cars = g.carHomes.fleet(t).byHome.get(home.id)!;
    const gone = cars.find((c) => c.place?.kind === 'apron') ?? cars[0];
    expect(t.cars).toEqual([{ car: gone.key, until: g.time }]);
    for (const x of g.towns) for (const c of g.carHomes.fleet(x).cars) if (c !== gone) expect(g.carHomes.isHome(x, c.key)).toBe(true);
    // Партия идёт: машина из старого учёта может вернуться, новые — уезжают.
    runSeconds(g, 30);
    expect(g.towns.reduce((s, x) => s + (x.cars?.length ?? 0), 0)).toBeGreaterThan(0);
  });
});

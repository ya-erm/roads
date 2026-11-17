import { describe, expect, it } from 'vitest';
import { dist, type Vec } from '../core/vec';
import type { Town, TownBuilding } from '../world/entities';
import { formOf, HOSPITAL_BAY } from '../world/townForms';
import { hospitalPlan } from '../world/yardLots';
import { Game } from './game';
import type { Garages } from './garages';
import type { DepotCar } from './serviceDepots';
import { freshGame, HIGHWAY, road, runUntil } from './testkit';

/** Партия без поездок жителей (выезды служб идут): машин жителей нет — симуляция быстрая. */
function quiet(game: Game): Game {
  (game as unknown as { spawnCitizenTrip(): void }).spawnCitizenTrip = () => {};
  return game;
}

/** Партия совсем без выездов: вызовы скорой — только тестом. */
function silent(game: Game): Game {
  quiet(game);
  (game as unknown as { serviceTrips(): void }).serviceTrips = () => {};
  return game;
}

const hospitals = (game: Game) => game.towns.flatMap((town) => town.buildings.filter((b) => formOf(b) === 'hospital').map((b) => ({ town, b })));
const garagesOf = (game: Game): Garages => (game.depots as unknown as { garagesOf(k: string): Garages }).garagesOf('ambulance');

/** Дом вызова в городе: жилой, подальше от больницы (но в том же городе), до него есть путь. */
function callHome(game: Game, town: Town, b: TownBuilding): TownBuilding {
  return town.buildings
    .filter((x) => x.kind === 'res' && game.roads.route(b.anchor, x.anchor))
    .sort((x, y) => Math.abs(dist(x.fp.center, b.fp.center) - 300) - Math.abs(dist(y.fp.center, b.fp.center) - 300) || x.id - y.id)[0];
}

describe('Стоянка скорых у больницы', { timeout: 120_000 }, () => {
  it('план: места между крыльями у улицы, сколько мест у больницы (bays), не больше, чем влезает; козырёк у перемычки', () => {
    const fp = (w: number, h: number) => ({ center: { x: 0, y: 0 }, w, h, angle: 0 });
    for (const bays of [2, 3, 4]) {
      const p = hospitalPlan({ fp: fp(62, 50), bays });
      expect(p.row!.stalls.length).toBe(bays);
      expect(p.row!.direct).toBe(true);
      for (const s of p.row!.stalls) {
        // От края участка у улицы, между крыльями, перед козырьком.
        expect(s.y).toBeCloseTo(-25 + 0.6);
        expect(s.x).toBeGreaterThanOrEqual(-31 + 2 + p.t);
        expect(s.x + s.w).toBeLessThanOrEqual(31 - 2 - p.t);
        expect(s.h).toBeGreaterThanOrEqual(HOSPITAL_BAY.minD);
        expect(s.y + s.h).toBeLessThanOrEqual(p.canopy!.y + 1e-6);
      }
      expect(p.canopy!.y + p.canopy!.h).toBeCloseTo(p.bar);
    }
    // Узкий участок — мест меньше, чем нужно городу; совсем узкий — стоянки нет.
    expect(hospitalPlan({ fp: fp(37, 37), bays: 4 }).row!.stalls.length).toBe(2);
    expect(hospitalPlan({ fp: fp(20, 37), bays: 4 }).row).toBeNull();
  });

  it('мир по seed: у каждой больницы 2–4 места по размеру города, скорых — ровно по местам, у каждой — заезд с полосы', () => {
    const game = freshGame(1);
    const list = hospitals(game);
    expect(list.length).toBeGreaterThan(2);
    for (const { town, b } of list) {
      const stalls = hospitalPlan(b).row?.stalls.length ?? 0;
      const cars = game.depots.carsOf(town, b);
      expect(stalls).toBeGreaterThanOrEqual(2);
      expect(stalls).toBeLessThanOrEqual(4);
      expect(stalls).toBe(b.bays);
      expect(cars.length).toBe(stalls);
      // Все на местах, и у каждого места — где встать на полосу.
      for (const c of cars) {
        expect(game.depots.isHome(c)).toBe(true);
        expect(game.garages.slotOf(c.spot) ?? garagesOf(game).slotOf(c.spot)).toBeTruthy();
      }
    }
    // Город крупнее — мест не меньше.
    const big = list.filter((x) => x.town.tier === 'city').map((x) => x.b.bays!);
    const small = list.filter((x) => x.town.tier === 'town').map((x) => x.b.bays!);
    if (big.length && small.length) expect(Math.min(...big)).toBeGreaterThanOrEqual(Math.max(...small));
  });

  it('скорая выезжает со своего места, едет к дому вызова, стоит там и возвращается на своё место', () => {
    const game = silent(freshGame(1));
    const { town, b } = hospitals(game)[0];
    const to = callHome(game, town, b);
    expect(game.depots.dispatch('ambulance', town, to, true)).toBe('sent');
    const cars = game.depots.carsOf(town, b);
    const car = cars.find((c) => !game.depots.isHome(c))!;
    expect(car).toBeTruthy();
    // Выезд — задним ходом с места к полосе: на манёвре — у места, в поток встаёт у своего заезда.
    const g = garagesOf(game);
    expect(g.moveOf(car.key)?.kind).toBe('out');
    let simId: number | undefined;
    expect(runUntil(game, 60, () => (simId = [...game.traffic.vehicles.keys()].find((id) => game.depots.carOfSim(id)?.car === car)) !== undefined)).toBe(true);
    const sim = game.traffic.vehicles.get(simId!)!;
    expect(game.serviceOfSim(sim.id)).toBe('ambulance');
    expect(sim.siren).toBe(true);
    expect(dist(sim.pos, car.spot.curbSide)).toBeLessThan(20);
    expect(game.tripOf(sim.id)).toMatchObject({ from: b, to });
    // Доехала до вызова — стоит у дома (в потоке её нет), положенное время.
    expect(runUntil(game, 400, () => !game.traffic.vehicles.has(simId!))).toBe(true);
    const away = town.serviceAway!.find((e) => e.b === b.id && e.k === car.k)!;
    expect(away.node).toBe(to.anchor);
    expect(away.until).toBeGreaterThan(game.time);
    // Обратно — от дома вызова к своему месту: на полосе напротив — поворот на место (манёвр въезда).
    let back: number | undefined;
    let drove = false;
    let turned = false;
    const home = runUntil(
      game,
      700,
      () => game.depots.isHome(car),
      () => {
        back ??= [...game.traffic.vehicles.keys()].find((id) => game.depots.carOfSim(id)?.car === car && game.depots.carOfSim(id)!.home);
        if (back !== undefined && !drove && game.traffic.vehicles.has(back)) {
          const v = game.traffic.vehicles.get(back)!;
          // Встаёт в поток у дома вызова, а не «из ниоткуда».
          expect(dist(v.pos, game.roads.net.node(to.anchor).pos)).toBeLessThan(60);
          expect(v.siren).toBeFalsy();
          drove = true;
        }
        if (g.moveOf(car.key)?.kind === 'in') turned = true;
      },
    );
    expect(home).toBe(true);
    expect(drove).toBe(true);
    expect(turned).toBe(true);
    expect(town.serviceAway?.some((e) => e.b === b.id && e.k === car.k) ?? false).toBe(false);
    expect(game.serviceCars).toBe([...game.traffic.vehicles.values()].filter((v) => game.serviceOfSim(v.id)).length);
  });

  it('все скорые на вызовах — вызов не принят; машин больше, чем мест, не бывает', () => {
    const game = silent(freshGame(1));
    const { town, b } = hospitals(game)[0];
    const n = game.depots.carsOf(town, b).length;
    const to = callHome(game, town, b);
    for (let i = 0; i < n; i++) expect(game.depots.dispatch('ambulance', town, to, false)).toBe('sent');
    expect(game.depots.dispatch('ambulance', town, to, false)).toBe('busy');
  });

  it('машин «из ниоткуда» у скорых нет: каждая встаёт в поток у места больницы или у дома вызова; в городе без больницы — из ближней', () => {
    const game = quiet(freshGame(1));
    const spots: Vec[] = hospitals(game).flatMap(({ town, b }) => game.depots.carsOf(town, b).map((c: DepotCar) => c.spot.curbSide));
    const fallback: string[] = [];
    const spawn = game.spawnService.bind(game);
    // Прежний выезд «из здания в здание» у скорой — только в городе, куда ни от одной больницы не доехать (сёла в начале
    // партии не связаны с городами).
    const withHospital = new Set(hospitals(game).map((h) => h.town.id));
    game.spawnService = (kind, siren, from, to, trip) => {
      if (kind === 'ambulance' && trip && withHospital.has(trip.from.townId)) fallback.push(`${trip.from.townId}`);
      return spawn(kind, siren, from, to, trip);
    };
    const seen = new Set<number>();
    let out = 0;
    let back = 0;
    runUntil(
      game,
      600,
      () => out >= 6 && back >= 3,
      () => {
        for (const v of game.traffic.vehicles.values()) {
          if (seen.has(v.id) || game.serviceOfSim(v.id) !== 'ambulance') continue;
          seen.add(v.id);
          const d = game.depots.carOfSim(v.id);
          expect(d).toBeTruthy();
          if (!d!.home) {
            out++;
            expect(Math.min(...spots.map((p) => dist(p, v.pos)))).toBeLessThan(20);
          } else {
            back++;
            const e = d!.car.town.serviceAway?.find((x) => x.b === d!.car.b.id && x.k === d!.car.k);
            expect(e).toBeTruthy();
            expect(dist(game.roads.net.node(e!.node).pos, v.pos)).toBeLessThan(60);
          }
        }
      },
    );
    expect(out).toBeGreaterThanOrEqual(6);
    expect(back).toBeGreaterThanOrEqual(3);
    expect(fallback).toEqual([]);
  });

  it('городу без больницы скорая едет из больницы ближнего города; не доехать ни от одной — как прежде', () => {
    const game = silent(freshGame(1));
    game.money = 1e8;
    const villages = game.towns.filter((t) => !t.buildings.some((b) => formOf(b) === 'hospital'));
    const homeOf = (t: Town) => t.buildings.find((b) => b.kind === 'res')!;
    // В начале партии города не связаны: ни от одной больницы не доехать — станции нет.
    expect(game.depots.dispatch('ambulance', villages[0], homeOf(villages[0]), true)).toBe('none');
    // Село, которое шоссе связали с городом ближней больницы.
    const village = villages.find((v) => {
      const to = homeOf(v);
      const h = [...hospitals(game)].sort((x, y) => dist(x.b.fp.center, to.fp.center) - dist(y.b.fp.center, to.fp.center))[0];
      return road(game, to.anchor, h.b.anchor, HIGHWAY);
    })!;
    expect(village).toBeTruthy();
    const to = homeOf(village);
    expect(game.depots.dispatch('ambulance', village, to, true)).toBe('sent');
    const gone = hospitals(game).flatMap(({ town, b }) => game.depots.carsOf(town, b)).filter((c) => !game.depots.isHome(c));
    expect(gone.length).toBe(1);
    expect(gone[0].town).not.toBe(village);
    // Ближняя из тех, откуда есть путь.
    const reach = hospitals(game).filter((h) => game.roads.route(h.b.anchor, to.anchor));
    const nearest = Math.min(...reach.map((h) => dist(h.b.fp.center, to.fp.center)));
    expect(dist(gone[0].b.fp.center, to.fp.center)).toBeCloseTo(nearest);
  });

  it('скорая у вызова — в сохранении: после загрузки возвращается на своё место', () => {
    const game = silent(freshGame(1));
    const { town, b } = hospitals(game)[0];
    const to = callHome(game, town, b);
    game.depots.dispatch('ambulance', town, to, true);
    expect(runUntil(game, 400, () => !!town.serviceAway?.length && ![...game.traffic.vehicles.keys()].some((id) => game.depots.carOfSim(id)))).toBe(true);
    const loaded = silent(new Game(structuredClone(game.settings), JSON.parse(JSON.stringify(game.toSave()))));
    const t2 = loaded.towns.find((t) => t.id === town.id)!;
    expect(t2.serviceAway?.length).toBe(1);
    const b2 = t2.buildings.find((x) => x.id === b.id)!;
    const car = loaded.depots.carsOf(t2, b2).find((c) => !loaded.depots.isHome(c))!;
    expect(car).toBeTruthy();
    expect(runUntil(loaded, 700, () => loaded.depots.isHome(car))).toBe(true);
    expect(t2.serviceAway).toBeUndefined();
  });
});

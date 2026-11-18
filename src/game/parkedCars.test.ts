import { describe, expect, it } from 'vitest';
import { add, dist, scale } from '../core/vec';
import { buildParkingScene } from '../testpages/parking';
import { CAR_SIZE } from '../world/houseAccess';
import { lotLayout } from '../world/parkingLots';
import { yardLotOf, yardSpots } from '../world/yardLots';
import { stallKey } from './shopParking';
import { MODELS } from './transport';

const spec = { kind: 'car' as const, length: CAR_SIZE.l, width: CAR_SIZE.w, maxSpeed: 60, accel: 10, color: '#f00' };
const advance = (game: ReturnType<typeof buildParkingScene>['game'], seconds = 120) => {
  game.speed = 1;
  for (let i = 0; i < seconds * 30; i++) game.update(1 / 30);
};

describe('Выбор и ручные поездки припаркованных машин', { timeout: 60_000 }, () => {
  it('выбирает кузов у дома и у магазина; едет именно на выбранное место, затем домой', () => {
    const scene = buildParkingScene(true);
    const { game } = scene;
    const c = scene.cases[1];
    const id = `car:${c.car.key}`;
    const home = game.parkedCars.get(id)!;
    expect(home.parked).toBe(true);
    expect(game.parkedCars.at(add(home.look.pos, scale(home.look.dir, -home.look.length / 2)))).toBe(id);
    const lot = game.shops.lotOf(c.destination)!;
    expect(game.parkedCars.send(id, lot.spots[1].spot)).toBeNull();
    expect(game.parkedCars.send(id, lot.spots[2].spot)).toMatch(/покинула/);
    advance(game, 70);
    expect(c.town.shopParked?.find((s) => s.car === c.car.key)?.k).toBe(1);
    const parked = game.parkedCars.get(id)!;
    expect(parked.parked).toBe(true);
    expect(game.parkedCars.at(add(parked.look.pos, scale(parked.look.dir, -parked.look.length / 2)))).toBe(id);
    expect(game.parkedCars.send(id)).toBeNull();
    advance(game, 100);
    expect(game.carHomes.isHome(c.town, c.car.key)).toBe(true);
    expect(c.town.shopParked?.some((s) => s.car === c.car.key)).toBe(false);
  });

  it('ставит машину на конкретное место площадки и освобождает его при выезде', () => {
    const { game, cases } = buildParkingScene(true);
    const c = cases[6];
    const stall = lotLayout(c.lot!).stalls[2];
    const created = game.parkedCars.spawn(spec, stall.pos);
    expect(typeof created).toBe('object');
    if (typeof created === 'string') throw new Error(created);
    expect(game.lots.occupied(c.lot!.id, 2)).toBe(true);
    expect(game.parkedCars.spawn(spec, stall.pos)).toMatch(/занято/);
    const shop = game.shops.lotOf(cases[1].destination)!;
    expect(game.parkedCars.send(created.parked!, shop.spots[0].spot)).toMatch(/маршрута/);
    expect(game.lots.occupied(c.lot!.id, 2)).toBe(true);
    expect(game.parkedCars.send(created.parked!, lotLayout(c.lot!).stalls[4].pos)).toBeNull();
    advance(game, 160);
    expect(game.lots.occupied(c.lot!.id, 2)).toBe(false);
    expect(game.lots.occupied(c.lot!.id, 4), game.parkedCars.get(created.parked!)?.state).toBe(true);
    expect(game.parkedCars.get(created.parked!)?.parked).toBe(true);
  });

  it('на паузе ставит все дорожные модели кузовом в точку клика, не сдвигая время', () => {
    for (const model of Object.values(MODELS).filter((m) => m.mode === 'road')) {
      if (model.mode !== 'road') continue;
      const { game, cases } = buildParkingScene(true);
      const slot = game.garages.slotOf(cases[1].car.place!.spot)!;
      const point = game.roads.graph.lanePose(slot.lane, slot.mid + 35).pos;
      const result = game.parkedCars.spawn(model.spec, point);
      expect(typeof result, model.name).toBe('object');
      if (typeof result === 'string') throw new Error(result);
      const sim = game.traffic.vehicles.get(result.simId!)!;
      expect(sim.kind).toBe(model.spec.kind);
      expect(sim.body).toBe(model.spec.body);
      expect(dist(add(sim.pos, scale(sim.dir, -sim.length / 2)), point)).toBeLessThan(0.1);
      const before = { ...sim.pos };
      game.update(1);
      expect(sim.pos).toEqual(before);
      expect(game.time).toBe(0);
      advance(game, 2);
      expect(dist(sim.pos, before)).toBeGreaterThan(0);
    }
  });

  it('машина с дороги паркуется на указанном месте магазина', () => {
    const { game, cases } = buildParkingScene(true);
    const c = cases[1];
    const slot = game.garages.slotOf(c.car.place!.spot)!;
    const point = game.roads.graph.lanePose(slot.lane, slot.mid + 15).pos;
    const created = game.parkedCars.spawn(spec, point);
    if (typeof created === 'string') throw new Error(created);
    const lot = game.shops.lotOf(c.destination)!;
    expect(game.parkedCars.sendVehicle(created.simId!, lot.spots[2].spot)).toBeNull();
    const preview = game.parkedCars.preview(`sim:${created.simId}`, lot.spots[2].spot);
    expect(preview?.goal).toEqual(lot.spots[2].spot);
    advance(game, 300);
    expect(c.town.shopParked?.some((s) => s.k === 2 && s.b === c.destination.id && s.color === spec.color)).toBe(true);
    expect(game.parkedCars.arrivedCar(created.simId!)).toBe(`shop:${c.destination.id}:2`);
  });

  it('после поездки к точке на дороге автобус остаётся там, затем может получить другую цель', () => {
    const { game, cases } = buildParkingScene(true);
    const slot = game.garages.slotOf(cases[1].car.place!.spot)!;
    const point = game.roads.graph.lanePose(slot.lane, slot.mid + 15).pos;
    const bus = MODELS.bus;
    if (bus.mode !== 'road') throw new Error('bus');
    const created = game.parkedCars.spawn(bus.spec, point);
    if (typeof created === 'string') throw new Error(created);
    const goal = game.roads.graph.lanePose(slot.lane, slot.mid + 65).pos;
    expect(game.parkedCars.sendVehicle(created.simId!, goal)).toBeNull();
    advance(game, 160);
    const sim = game.traffic.vehicles.get(created.simId!)!;
    expect(sim).toBeDefined();
    expect(sim.v).toBeLessThan(0.1);
    expect(dist(add(sim.pos, scale(sim.dir, -sim.length / 2)), goal)).toBeLessThan(1);
    const next = game.roads.graph.lanePose(slot.lane, slot.mid + 90).pos;
    expect(game.parkedCars.sendVehicle(sim.id, next)).toBeNull();
    advance(game, 10);
    expect(dist(add(sim.pos, scale(sim.dir, -sim.length / 2)), next)).toBeLessThan(1);
  });

  it('при занятом выезде назначает цель сразу и выпускает следующую машину после первой', () => {
    const { game, cases } = buildParkingScene(true);
    const c = cases[6];
    const stalls = lotLayout(c.lot!).stalls;
    const a = game.parkedCars.spawn(spec, stalls[0].pos);
    const b = game.parkedCars.spawn({ ...spec, color: '#00f' }, stalls[1].pos);
    if (typeof a === 'string' || typeof b === 'string') throw new Error('spawn');
    expect(game.parkedCars.send(a.parked!, stalls[3].pos)).toBeNull();
    expect(game.parkedCars.send(b.parked!, stalls[4].pos)).toBeNull();
    expect(game.parkedCars.get(b.parked!)?.state).toBe('Ждёт выезда');
    expect(game.parkedCars.get(b.parked!)?.parked).toBe(true);
    expect(game.parkedCars.trip(b.parked!)?.goal).toEqual(stalls[4].pos);
    advance(game, 240);
    expect(game.lots.occupied(c.lot!.id, 3)).toBe(true);
    expect(game.lots.occupied(c.lot!.id, 4), game.parkedCars.get(b.parked!)?.state).toBe(true);
    expect(game.parkedCars.get(b.parked!)?.parked).toBe(true);
  });

  it('на свободном месте у жилого дома можно поставить машину, отправить к магазину и вернуть на это место', () => {
    for (const index of [2, 3]) {
      const { game, cases } = buildParkingScene(true);
      const c = cases[index];
      const building = c.car.home;
      const reserved = new Set(game.carHomes.fleet(c.town).cars.map((car) => car.place?.spot.key));
      const places = yardSpots(building, yardLotOf(building)!, spec.length).spots;
      const place = places.find((s, k) => s.drive && !reserved.has(stallKey(building.id, k)))!;
      expect(place).toBeDefined();
      const center = add(place.nose, scale(place.dir, -spec.length / 2));
      const created = game.parkedCars.spawn(spec, center);
      if (typeof created === 'string') throw new Error(created);
      expect(game.parkedCars.get(created.parked!)?.look.pos).toEqual(place.nose);
      const shop = game.shops.lotOf(c.destination)!;
      expect(game.parkedCars.send(created.parked!, shop.spots[0].spot)).toBeNull();
      advance(game, 100);
      expect(game.parkedCars.get(created.parked!)?.parked).toBe(true);
      expect(game.parkedCars.send(created.parked!, center)).toBeNull();
      advance(game, 120);
      expect(dist(game.parkedCars.get(created.parked!)!.look.pos, place.nose)).toBeLessThan(0.01);
    }
  });
});

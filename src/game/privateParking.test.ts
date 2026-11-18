import { describe, expect, it } from 'vitest';
import { buildParkingScene } from '../testpages/parking';
import { drivewaysOf } from '../world/houseAccess';

describe('Многоместный частный участок', () => {
  it('две машины в гараже и одна на площадке имеют отдельные места и выезжают очередью', () => {
    const { game, cases } = buildParkingScene(true);
    const c = cases[0];
    c.car.home.homeSpaces = 3;
    c.car.home.garageSpaces = 2;
    game.layoutRev++;
    const cars = game.carHomes.fleet(c.town).cars.filter((car) => car.home === c.car.home);
    expect(cars.map((car) => car.place!.kind)).toEqual(['garage', 'garage', 'pad']);
    expect(new Set(cars.map((car) => car.place!.spot.key)).size).toBe(3);
    expect(drivewaysOf(c.car.home)).toHaveLength(3);
    for (const car of cars) expect(game.carHomes.canDepart(c.town, car)).toBe(true);
    const destination = game.shops.lotOf(c.destination)!;
    for (const [i, car] of cars.entries()) expect(game.parkedCars.send(`car:${car.key}`, destination.spots[i].spot)).toBeNull();
    expect(game.parkedCars.get(`car:${cars[1].key}`)?.state).toBe('Ждёт выезда');
    game.speed = 1;
    for (let i = 0; i < 180 * 30; i++) game.update(1 / 30);
    for (const [i, car] of cars.entries()) {
      expect(c.town.shopParked?.find((s) => s.car === car.key)?.k).toBe(i);
      expect(game.parkedCars.get(`car:${car.key}`)?.parked).toBe(true);
    }
  }, 30_000);
});

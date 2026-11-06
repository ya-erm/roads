import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../config';
import { add, dist, rightNormal, scale } from '../core/vec';
import { RAIL_SPEC } from '../world/roadTypes';
import type { Station } from '../world/entities';
import type { RoadRequest } from './build';
import { Game } from './game';
import { freightRoute, runSeconds, withoutCitizens } from './testkit';
import { MODELS, type FleetVehicle, type ModelId, type RailModel, type RoadModel } from './transport';

const road = (id: ModelId) => MODELS[id] as RoadModel;
const rail = (id: ModelId) => MODELS[id] as RailModel;

/** Ферма → пищекомбинат по своей трассе, без машин жителей; грузовик на линии. */
function truckRoute() {
  const game = withoutCitizens(new Game(7));
  const { built, line } = freightRoute(game);
  expect(built).toBe(true);
  const truck = game.buyVehicle(line.id, 'truck')!;
  return { game, line, truck };
}

/** Ждёт, пока грузовик не поедет с грузом по середине полосы (не в узле и не у её начала). */
function driveLoaded(game: Game, v: FleetVehicle): void {
  game.speed = 1;
  for (let t = 0; t < 600; t += SIM_DT) {
    game.update(SIM_DT);
    const sim = game.fleetSim(v);
    if (v.state === 'driving' && v.amount > 0 && sim && !sim.onMovement && sim.s > 60 && sim.v > 5) return;
  }
  throw new Error('Грузовик так и не поехал с грузом');
}

describe('Замена транспорта на модель новее', { timeout: 30_000 }, () => {
  it('в пути и на посту станции — на месте: тот же номер, место на полосе, скорость, рейс, груз и пост', () => {
    const { game, line, truck } = truckRoute();
    // В пути с зерном: та же машина на дороге, длиннее, едет дальше оттуда же.
    driveLoaded(game, truck);
    const sim = game.fleetSim(truck)!;
    const before = { pos: { ...sim.pos }, s: sim.s, v: sim.v, lane: sim.lane, target: sim.targetNode };
    const trip = { state: truck.state, stop: truck.stop, cargo: truck.cargo, amount: truck.amount, loadedAt: truck.loadedAt, loadedTime: truck.loadedTime };
    game.openModelTier(2);
    const money = game.money;
    expect(game.replaceVehicle(truck.id)).toBe(truck);
    expect(truck).toMatchObject({ ...trip, model: 'truck2', name: `Грузовик II №${truck.id}` });
    expect(truck.upgradeTo).toBeUndefined();
    expect(line.vehicles).toEqual([truck.id]);
    expect(game.fleetSim(truck)).toBe(sim);
    expect(sim).toMatchObject({ s: before.s, v: before.v, lane: before.lane, targetNode: before.target, length: road('truck2').spec.length, body: 'semi' });
    expect(dist(sim.pos, before.pos)).toBeLessThan(1e-6);
    // Платится разница: новая минус 60% старой.
    expect(money - game.money).toBe(MODELS.truck2.price - Math.round(MODELS.truck.price * 0.6));

    // Доезжает до комбината и встаёт на пост.
    const revenue = line.revenueTotal + line.revenueMonth;
    game.speed = 1;
    for (let t = 0; t < 300 && !(truck.inBay && truck.stop === 1 && !truck.enter); t += SIM_DT) game.update(SIM_DT);
    expect(truck).toMatchObject({ inBay: true, stop: 1, state: 'loading' });
    // На посту станции — на том же посту, с тем же зерном.
    game.openModelTier(3);
    const at = { state: truck.state, stop: truck.stop, bay: truck.bay, inBay: true, cargo: truck.cargo, amount: truck.amount };
    expect(game.replaceVehicle(truck.id)).toBe(truck);
    expect(truck).toMatchObject({ ...at, model: 'truck3' });
    // Зерно не пропало: сдаёт его на комбинате — выручка за рейс от первой станции.
    runSeconds(game, 10);
    expect(line.revenueTotal + line.revenueMonth).toBeGreaterThan(revenue);
  });

  it('новая длиннее, а сзади вплотную машина — замена ждёт места, потом — там же', () => {
    const { game, truck } = truckRoute();
    driveLoaded(game, truck);
    const sim = game.fleetSim(truck)!;
    // Вплотную сзади на той же полосе — стоящая машина.
    const back = add(sim.pos, scale(sim.dir, -(sim.length + 2.5)));
    const blocker = game.traffic.place({ ...road('truck').spec, targetNode: sim.targetNode }, back, sim.dir, 0)!;
    expect(blocker.lane).toBe(sim.lane);
    game.openModelTier(2);
    const money = game.money;
    expect(game.replaceVehicle(truck.id)).toBe(truck);
    expect(truck.model).toBe('truck');
    expect(truck.upgradeTo).toBe('truck2');
    expect(sim.length).toBe(road('truck').spec.length);
    expect(game.money).toBe(money);
    // Место освободилось — меняется на следующем же шаге, на ходу.
    game.traffic.remove(blocker);
    const amount = truck.amount;
    game.update(SIM_DT);
    expect(truck.model).toBe('truck2');
    expect(truck.upgradeTo).toBeUndefined();
    expect(game.fleetSim(truck)).toBe(sim);
    expect(sim.length).toBe(road('truck2').spec.length);
    expect(truck.amount).toBe(amount);
    expect(game.money).toBeLessThan(money);
  });

  it('поезд в пути — той же длины, с тем же грузом и на том же месте, ход новой модели', () => {
    const { game, a, b } = railWorld();
    const line = game.createLine([a.id, b.id])!;
    const v = game.buyVehicle(line.id, 'freightTrain')!;
    game.speed = 1;
    for (let t = 0; t < 600 && !game.fleetTrain(v)?.moving; t += 0.1) game.update(0.1);
    const train = game.fleetTrain(v)!;
    expect(train.moving).toBe(true);
    const before = { id: train.id, head: train.head, cars: train.cars, length: train.length };
    game.openModelTier(2);
    expect(game.replaceVehicle(v.id)).toBe(v);
    expect(v.model).toBe('freightTrain2');
    expect(v.cars).toBe(rail('freightTrain').train.cars);
    expect(game.fleetTrain(v)).toBe(train);
    expect(train).toMatchObject({ ...before, maxSpeed: rail('freightTrain2').train.maxSpeed, accel: rail('freightTrain2').train.accel });
  });
});

/** Длинный путь в чистом поле с вокзалами у концов (как в railmove.test.ts), без машин жителей. */
function railWorld(): { game: Game; a: Station; b: Station } {
  const game = withoutCitizens(new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' }));
  const len = 2400;
  for (let y = 400; y < game.terrain.height - 400; y += 170) {
    for (let x = 300; x < game.terrain.width - len - 300; x += 230) {
      const from = { x, y };
      const dir = { x: 1, y: 0 };
      const req: RoadRequest = { start: { kind: 'free', pos: from, level: 0 }, end: { kind: 'free', pos: add(from, scale(dir, len)), level: 0 }, spec: RAIL_SPEC, mode: 'straight' };
      if (!game.builder.plan(req).ok) continue;
      game.builder.build(req);
      const n = rightNormal(dir);
      const pa = add(add(from, scale(dir, 400)), scale(n, 40));
      const pb = add(add(from, scale(dir, len - 400)), scale(n, 40));
      if (game.stationPlan(pa, 14, 'rail').ok && game.stationPlan(pb, 14, 'rail').ok) {
        return { game, a: game.placeStation(pa, 14, 'rail')!, b: game.placeStation(pb, 14, 'rail')! };
      }
      game.builder.bulldoze(add(from, scale(dir, len / 2)), 4);
    }
  }
  throw new Error('Нет места для пути');
}

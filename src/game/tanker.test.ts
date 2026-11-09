import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../config';
import { CARGO, FREIGHT, isTankCargo } from '../world/cargo';
import { Game } from './game';
import { freightRoute, freshGame, withoutCitizens } from './testkit';
import { type FleetVehicle, MODELS, modelName, TANKER_NAMES } from './transport';

/** Ждёт, пока машина не поедет с грузом по дороге. */
function driveLoaded(game: Game, v: FleetVehicle): void {
  game.speed = 1;
  for (let t = 0; t < 600; t += SIM_DT) {
    game.update(SIM_DT);
    if (v.state === 'driving' && v.amount > 0 && game.fleetSim(v)) return;
  }
  throw new Error('Машина так и не поехала с грузом');
}

describe('Автоцистерны: нефть, топливо и газ возят цистерной', { timeout: 60_000 }, () => {
  it('наливные грузы — нефть, топливо и газ, остальные — в кузове', () => {
    expect(FREIGHT.filter(isTankCargo).sort()).toEqual(['fuel', 'gas', 'oil']);
    expect(isTankCargo(null)).toBe(false);
    expect(CARGO.grain.tank).toBeUndefined();
  });

  it('у каждого грузовика — своё название автоцистерны, у автобусов и поездов его нет', () => {
    for (const id of ['truck', 'truck2', 'truck3'] as const) {
      expect(TANKER_NAMES[id]).toMatch(/^Автоцистерна/);
      expect(modelName(id, true)).toBe(TANKER_NAMES[id]);
      expect(modelName(id)).toBe(MODELS[id].name);
    }
    expect(modelName('bus', true)).toBe('Автобус');
    expect(modelName('freightTrain', true)).toBe('Грузовой поезд');
  });

  it('на маршруте скважина → НПЗ грузовик — автоцистерна: и пустой, и с нефтью, на карте — цистерна', () => {
    const game = withoutCitizens(freshGame(7));
    const { built, line } = freightRoute(game, 'oilwell', 'refinery');
    expect(built).toBe(true);
    expect(game.lineFreight(line)).toEqual(['oil']);
    expect(game.tankLine(line)).toBe(true);
    expect(game.lineVehicleKind(line)).toBe('tanker');
    const truck = game.buyVehicle(line.id, 'truck')!;
    // Модель та же — цена и вместимость грузовика; записан, как куплен, а в интерфейсе — автоцистерна.
    expect(truck.model).toBe('truck');
    expect(truck.name).toBe(`Грузовик №${truck.id}`);
    expect(game.isTanker(truck)).toBe(true);
    expect(game.vehicleTitle(truck)).toBe(`Автоцистерна №${truck.id}`);
    driveLoaded(game, truck);
    expect(truck.cargo).toBe('oil');
    expect(game.fleetSim(truck)).toMatchObject({ tank: true, body: 'van', load: CARGO.oil.color });
  });

  it('на маршруте ферма → пищекомбинат — обычный грузовик с кузовом', () => {
    const game = withoutCitizens(freshGame(7));
    const { built, line } = freightRoute(game);
    expect(built).toBe(true);
    expect(game.tankLine(line)).toBe(false);
    expect(game.lineVehicleKind(line)).toBe('truck');
    const truck = game.buyVehicle(line.id, 'truck')!;
    expect(game.isTanker(truck)).toBe(false);
    expect(game.vehicleTitle(truck)).toBe(`Грузовик №${truck.id}`);
    driveLoaded(game, truck);
    expect(truck.cargo).toBe('grain');
    expect(game.fleetSim(truck)!.tank).toBeFalsy();
    // На маршруте с разными грузами грузовик с наливным грузом — цистерна, пустой — снова с кузовом.
    truck.cargo = 'fuel';
    expect(game.isTanker(truck)).toBe(true);
    expect(game.vehicleTitle(truck)).toBe(`Автоцистерна №${truck.id}`);
    truck.cargo = null;
    expect(game.isTanker(truck)).toBe(false);
  });

  it('груз из правила остановки входит в грузы маршрута: топливо и зерно — маршрут смешанный, не наливной', () => {
    const game = withoutCitizens(freshGame(7));
    const { line } = freightRoute(game);
    line.rules = [{ wait: 'auto', maxWait: null, load: ['fuel'], unload: 'auto' }];
    // Поток зерна остаётся — маршрут смешанный.
    expect(game.lineFreight(line).sort()).toEqual(['fuel', 'grain']);
    expect(game.tankLine(line)).toBe(false);
  });

  it('старое сохранение: купленный раньше грузовик на нефтяном маршруте после загрузки едет автоцистерной', () => {
    const game = withoutCitizens(freshGame(7));
    const { line } = freightRoute(game, 'oilwell', 'refinery');
    const truck = game.buyVehicle(line.id, 'truck')!;
    driveLoaded(game, truck);
    const save = JSON.parse(JSON.stringify(game.toSave()));
    // В сохранении ничего нового: модель и имя — как у грузовика, признака цистерны нет.
    const saved = save.fleet.find((v: { id: number }) => v.id === truck.id);
    expect(saved.model).toBe(truck.model);
    expect(JSON.stringify(saved)).not.toContain('tank');
    const loaded = withoutCitizens(new Game(game.settings, save));
    const again = loaded.fleet.get(truck.id)!;
    expect(again.name).toBe(truck.name);
    expect(loaded.vehicleTitle(again)).toMatch(/^Автоцистерна/);
    expect(loaded.fleetSim(again)).toMatchObject({ tank: true });
    // И работает дальше: довозит нефть.
    loaded.speed = 1;
    const earned = () => loaded.lines.get(line.id)!.revenueTotal;
    const before = earned();
    for (let t = 0; t < 300 && earned() === before; t += SIM_DT) loaded.update(SIM_DT);
    expect(earned()).toBeGreaterThan(before);
  });
});

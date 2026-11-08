import { describe, expect, it } from 'vitest';
import { TRANSFER } from '../config';
import type { Station } from '../world/entities';
import { Game } from './game';
import { stationAtIndustry } from './testkit';
import { transferable, transferNear, transferNeighbors } from './transfer';
import type { FleetVehicle, Line } from './transport';

type Internals = { handleStop(v: FleetVehicle, st: Station, line: Line): void };

/** Станция без игры: прямоугольник w×h с центром (x, y) — для проверок «рядом ли». */
function fake(id: number, x: number, kind: Station['kind'] = 'road', w = 36): Station {
  return {
    type: 'station',
    id,
    kind,
    name: `S${id}`,
    fp: { center: { x, y: 0 }, w, h: 22, angle: 0 },
    nodeId: -1,
    platforms: [],
    serves: { pax: kind === 'stop', cargo: kind !== 'stop' },
    industryId: null,
    cargo: {},
    passengers: new Map(),
    occupied: [],
    bays: 1,
    townIds: [],
    industryIds: [],
    accepts: new Set(),
    catchPop: 0,
    paxAcc: 0,
  } as Station;
}

describe('Перевалка между соседними станциями', () => {
  it('соседи — грузовые станции край к краю не дальше TRANSFER.reach, ближние первыми', () => {
    const a = fake(1, 0);
    // Край a — на x = 18; у соседа край на 18 + gap.
    const near = fake(2, 18 + TRANSFER.reach - 10 + 18);
    const nearer = fake(5, 18 + 30 + 18);
    const far = fake(3, 18 + TRANSFER.reach + 10 + 18);
    const stop = fake(4, 60, 'stop');
    expect(transferNear(a, near)).toBe(true);
    expect(transferNear(near, a)).toBe(true);
    expect(transferNear(a, far)).toBe(false);
    expect(transferNear(a, stop)).toBe(false);
    expect(transferNear(a, a)).toBe(false);
    expect(transferNeighbors(a, [a, far, near, stop, nearer]).map((s) => s.id)).toEqual([5, 2]);
  });

  it('перекладывается только груз со склада, привезённый другой линией, а не продукция станции', () => {
    const s = fake(1, 0);
    s.cargo = { textiles: 40.7, grain: 30 };
    s.cargoOrigin = { textiles: 99 };
    expect(transferable(s, 'textiles')).toBe(40);
    expect(transferable(s, 'grain')).toBe(0);
    s.cargoOrigin = { textiles: 1 };
    expect(transferable(s, 'textiles')).toBe(0);
  });

  it('маршрут с автостанции забирает груз со склада соседней станции и везёт его от станции первой погрузки', () => {
    const game = new Game(7);
    game.money = 5_000_000;
    const farm = game.industries.find((i) => i.info.kind === 'farm')!;
    const plant = game.industries.find((i) => i.info.kind === 'foodplant')!;
    // Две станции у одной фермы (как ж/д и автостанция у плантации) и станция у комбината.
    const store = stationAtIndustry(game, farm, plant.fp.center)!;
    const yard = stationAtIndustry(game, farm, plant.fp.center)!;
    const b = stationAtIndustry(game, plant, farm.fp.center)!;
    expect(transferNear(store, yard)).toBe(true);
    expect(transferNear(yard, b)).toBe(false);

    // На склад store другая линия выгрузила ткань, привезённую со станции b; зерно на store — продукция фермы.
    store.cargo = { textiles: 40, grain: 50 };
    store.cargoOrigin = { textiles: b.id };
    yard.cargo = {};
    const line = game.createLine([yard.id, b.id])!;
    game.setStopRule(line.id, 0, { wait: 'none', maxWait: null, load: ['textiles', 'grain'], unload: 'auto' });
    expect(game.transferSources(line, 0).map((s) => s.id)).toEqual([store.id]);
    expect(game.lineWaiting(line, 0, 'freight')).toBe(40);
    // Карточка станции: ткань со склада соседа заберёт этот маршрут.
    const flows = game.transferFlows(yard).find((x) => x.near === store)!.flows;
    expect(flows.map((f) => [f.from.id, f.to.id, f.cargo, f.amount, f.lines.map((l) => l.id)])).toEqual([[store.id, yard.id, 'textiles', 40, [line.id]]]);

    const truck = game.buyVehicle(line.id, 'truck')!;
    truck.stop = 0;
    (game as unknown as Internals).handleStop(truck, yard, line);
    expect(truck.cargo).toBe('textiles');
    expect(truck.amount).toBe(16);
    expect(truck.loadedAt).toBe(b.id);
    expect(truck.fromStore).toBe(true);
    expect(store.cargo.textiles).toBe(24);
    // Продукцию фермы со store через соседа не берут.
    expect(store.cargo.grain).toBe(50);
  });

  it('станции самого маршрута — не источник перевалки: свой груз туда-обратно не перекладывается', () => {
    const game = new Game(7);
    game.money = 5_000_000;
    const farm = game.industries.find((i) => i.info.kind === 'farm')!;
    const plant = game.industries.find((i) => i.info.kind === 'foodplant')!;
    const store = stationAtIndustry(game, farm, plant.fp.center)!;
    const yard = stationAtIndustry(game, farm, plant.fp.center)!;
    store.cargo = { textiles: 40 };
    store.cargoOrigin = { textiles: 12345 };
    yard.cargo = {};
    const line = game.createLine([yard.id, store.id])!;
    game.setStopRule(line.id, 0, { wait: 'none', maxWait: null, load: ['textiles'], unload: 'auto' });
    expect(game.transferSources(line, 0)).toEqual([]);
    const truck = game.buyVehicle(line.id, 'truck')!;
    truck.stop = 0;
    (game as unknown as Internals).handleStop(truck, yard, line);
    expect(truck.cargo).toBeNull();
    expect(store.cargo.textiles).toBe(40);
  });
});

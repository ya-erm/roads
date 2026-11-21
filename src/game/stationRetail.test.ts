import { describe, expect, it } from 'vitest';
import { dist } from '../core/vec';
import type { CargoType } from '../world/cargo';
import type { Station, Town, TownBuilding } from '../world/entities';
import { receiverNeed, receiverOf, STATION_RETAIL, stockCap, townRoom } from '../world/retail';
import { townNeed } from '../world/townSupply';
import { DEFAULT_SETTINGS } from '../world/settings';
import { Game } from './game';
import { fieldSpot, freshGame, road, runMonths, withoutCitizens } from './testkit';
import { DEFAULT_RULE, type FleetVehicle, type Line } from './transport';

const WORLD = { ...DEFAULT_SETTINGS, seed: 17, size: 'small', towns: 0, industries: 'few', water: 'dry', relief: 'plains', retail: true } as const;

function layout() {
  const game = withoutCitizens(freshGame(WORLD));
  game.money = 5_000_000;
  const at = fieldSpot(game, 760);
  const y = at.y;
  expect(road(game, { free: at }, { free: { x: at.x + 760, y } })).toBe(true);
  const cityStation = game.placeStation({ x: at.x + 190, y: y - 38 }, 14, 'road', { pax: false, cargo: true })!;
  const source = game.placeStation({ x: at.x + 650, y: y - 38 }, 14, 'road', { pax: false, cargo: true })!;
  expect(cityStation).toBeTruthy();
  expect(source).toBeTruthy();
  const town: Town = {
    id: game.nextId(), name: 'Заречье', center: { x: at.x + 195, y }, radius: 260, top: y, style: 'linear', population: 8,
    buildings: [], streets: [], demands: ['food'], supplied: {}, lastSupplied: {}, tripAcc: 0, growthAcc: -1000,
    autoStreets: false,
  };
  const shop: TownBuilding = {
    type: 'building', id: game.nextId(), townId: town.id, kind: 'com', form: 'shop', floors: 2,
    fp: { center: { x: at.x + 225, y: y + 32 }, w: 38, h: 36, angle: 0 },
    face: -1, anchor: cityStation.nodeId, color: '#d5dde5', roof: '#7d8a99',
  };
  const school: TownBuilding = { ...shop, id: game.nextId(), form: 'school', fp: { ...shop.fp, center: { x: at.x + 365, y: y + 32 } } };
  town.buildings.push(shop, school);
  game.index.add(shop);
  game.index.add(school);
  game.towns.push(town);
  game.refreshReceivers(town);
  game.computeCatchment(cityStation);
  expect(cityStation.townIds).toContain(town.id);
  expect(cityStation.accepts.has('food')).toBe(true);
  const line = game.createLine([source.id, cityStation.id])!;
  const truck = game.buyVehicle(line.id, 'truck')!;
  expect(truck).toBeTruthy();
  return { game, town, cityStation, source, line, truck, shop };
}

function unload(game: Game, line: Line, truck: FleetVehicle, origin: Station, target: Station, cargo: CargoType, amount: number) {
  truck.stop = 1;
  truck.cargo = cargo;
  truck.amount = amount;
  truck.loadedAt = origin.id;
  truck.fromStore = true;
  const before = game.money;
  const runtime = game as unknown as { handleStop(v: FleetVehicle, st: Station, line: Line): void };
  runtime.handleStop(truck, target, line);
  return { accepted: amount - truck.amount, revenue: game.money - before };
}

describe('Торговля у городской автостанции', () => {
  it('сохраняет фактические поставки одному магазину через станцию и напрямую, включая месяц без поставок', () => {
    const { game, town, cityStation, source, line, truck, shop } = layout();
    const receiver = receiverOf(town, shop.id)!;
    expect(shop.retailSupply).toBeUndefined(); // Стартовый запас не считается поставкой.
    expect(unload(game, line, truck, source, cityStation, 'food', 5).accepted).toBe(5);

    const dock = game.dockFor(shop)!;
    const direct = game.createLine([source.id, dock.id])!;
    const local = game.buyVehicle(direct.id, 'truck')!;
    receiver.stock.food = stockCap(town, receiver, 'food') - 3;
    expect(unload(game, direct, local, source, dock, 'food', 5).accepted).toBe(3);
    expect(unload(game, direct, local, source, dock, 'food', 2).accepted).toBe(0);
    local.amount = 0;
    local.cargo = null;

    game.setStopRule(line.id, 1, { ...DEFAULT_RULE, load: [], unload: ['goods'] });
    expect(unload(game, line, truck, source, cityStation, 'goods', 4)).toEqual({ accepted: 4, revenue: 0 });
    game.refreshReceivers(town);
    const save = structuredClone(game.toSave());
    const loaded = withoutCitizens(new Game(save.settings, save));
    const loadedTown = loaded.towns.find((t) => t.id === town.id)!;
    const loadedShop = loadedTown.buildings.find((b) => b.id === shop.id)!;
    expect(loadedShop.retailSupply?.map((m) => m.got)).toEqual([{ food: 8 }]);

    runMonths(loaded, 2);
    expect(loadedShop.retailSupply?.map((m) => [m.month, m.got.food ?? 0])).toEqual([[save.month, 8], [save.month + 1, 0]]);
    expect(loadedShop.retailSupply?.every((m) => (m.need.food ?? 0) > 0)).toBe(true);
    expect(loadedTown.buildings.filter((b) => b.retailSupply).map((b) => b.id)).toEqual([shop.id]);
  });

  it('после оплачиваемых поставок в разных месяцах открывает новую точку, без перераспределения прежнего спроса', () => {
    const { game, town, cityStation, source, line, truck, shop } = layout();
    const baseNeed = receiverNeed(town, receiverOf(town, shop.id)!, 'food');
    const first = unload(game, line, truck, source, cityStation, 'food', 8);
    expect(first.accepted).toBeGreaterThan(0);
    expect(first.revenue).toBeGreaterThan(0);
    runMonths(game, 2);
    expect(town.buildings).toHaveLength(2);
    const second = unload(game, line, truck, source, cityStation, 'food', 8);
    expect(second.revenue).toBeGreaterThan(0);
    runMonths(game, 1);

    const outlet = town.buildings.find((b) => b.stationRetail?.outlet === 'food')!;
    expect(outlet, JSON.stringify({ month: game.monthIndex, retail: town.stationRetail, coverage: cityStation.townIds, shop: shop.stationRetail })).toBeTruthy();
    expect(dist(outlet.fp.center, cityStation.fp.center)).toBeLessThanOrEqual(game.catchmentRadius(cityStation));
    const receiver = receiverOf(town, outlet.id)!;
    expect(receiver.cargo).toEqual(['food']);
    expect(receiverNeed(town, receiverOf(town, shop.id)!, 'food')).toBeCloseTo(baseNeed);
    expect(receiverNeed(town, receiver, 'food')).toBeCloseTo(townNeed(town.population) * STATION_RETAIL.outletShare);
    expect(townRoom(town, 'food', game.time, 4)).toBeGreaterThan(baseNeed * 1.35 * 4);

    const save = structuredClone(game.toSave());
    const loaded = withoutCitizens(new Game(save.settings, save));
    const loadedTown = loaded.towns.find((t) => t.id === town.id)!;
    loaded.refreshReceivers(loadedTown);
    expect(receiverNeed(loadedTown, receiverOf(loadedTown, outlet.id)!, 'food')).toBeCloseTo(townNeed(loadedTown.population) * STATION_RETAIL.outletShare);
    runMonths(loaded, STATION_RETAIL.window + 1);
    expect(loadedTown.buildings.filter((b) => b.stationRetail)).toHaveLength(1);
  });

  it('расширяет существующий магазин с паузами и фиксированным пределом', () => {
    const { game, town, cityStation, source, line, truck, shop } = layout();
    for (let month = 0; month < 14; month++) {
      unload(game, line, truck, source, cityStation, 'food', 8);
      runMonths(game, 1);
      if (month < STATION_RETAIL.interval + 1) expect(shop.stationRetail).toBeUndefined();
    }
    expect(shop.floors, JSON.stringify({ month: game.monthIndex, retail: town.stationRetail, station: cityStation.townIds, buildings: town.buildings.map((b) => b.stationRetail) })).toBe(3);
    expect(shop.stationRetail?.extra.food).toBeCloseTo(STATION_RETAIL.maxReceiverShare);
    expect(receiverNeed(town, receiverOf(town, shop.id)!, 'food')).toBeCloseTo(townNeed(town.population) * (1 + STATION_RETAIL.maxReceiverShare));
    expect(town.buildings.filter((b) => b.stationRetail?.outlet)).toHaveLength(1);
  });

  it('транзитное хранение на той же станции не увеличивает спрос', () => {
    const { game, town, cityStation, source, line, truck } = layout();
    game.setStopRule(line.id, 1, { ...DEFAULT_RULE, load: [], unload: ['goods'] });
    for (let month = 0; month < STATION_RETAIL.interval + 1; month++) {
      expect(unload(game, line, truck, source, cityStation, 'goods', 8)).toEqual({ accepted: 8, revenue: 0 });
      runMonths(game, 1);
    }
    expect(cityStation.cargo.goods).toBe(8 * (STATION_RETAIL.interval + 1));
    expect(town.stationRetail).toBeUndefined();
    expect(town.buildings).toHaveLength(2);
  });

  it('из партии без истории торгового района настоящий маршрут привозит продукцию и открывает точку', () => {
    const before = layout();
    const save = structuredClone(before.game.toSave());
    const game = withoutCitizens(new Game(save.settings, save));
    const town = game.towns.find((t) => t.id === before.town.id)!;
    const line = game.lines.get(before.line.id)!;
    expect(town.stationRetail).toBeUndefined();
    game.stations.get(before.source.id)!.cargo.food = 200;
    game.setStopRule(line.id, 0, { ...DEFAULT_RULE, wait: 'none', unload: [] });
    game.setStopRule(line.id, 1, { ...DEFAULT_RULE, wait: 'none', load: [] });
    runMonths(game, 4);
    expect(line.revenueTotal).toBeGreaterThan(0);
    expect(town.buildings.some((b) => b.stationRetail?.outlet === 'food')).toBe(true);
  });
});

import { emptyLedger, Game, type RoadSpot } from '../game/game';
import { add, scale } from '../core/vec';
import type { Vehicle } from '../sim/vehicle';
import { roadPlan, STREET, withoutCitizens } from '../game/testkit';
import { MODELS, type FleetVehicle, type ModelId } from '../game/transport';
import { CARGO, type CargoType } from '../world/cargo';
import type { HouseForm, Station, Town, TownBuilding } from '../world/entities';
import { LOT_SETBACK } from '../world/houseAccess';
import { maxTruck } from '../world/retail';
import { TERRAIN_VERSION } from '../world/settings';
import type { TestScene } from './index';

export type TruckModel = Extract<ModelId, 'truck' | 'truck2' | 'truck3'>;
export const TRUCK_MODELS: readonly TruckModel[] = ['truck', 'truck2', 'truck3'];

export interface TruckCase {
  title: string;
  town: Town;
  building: TownBuilding;
  source: Station;
  dock: Station;
  line: number;
  cargo: CargoType;
  model: TruckModel;
  vehicle?: FleetVehicle;
  phase: 'ready' | 'outbound' | 'entering' | 'unloading' | 'leaving' | 'returning' | 'done';
  arrivals: number;
  exits: number;
  action?: 'entry' | 'exit';
  view: TestScene['view'];
}

export interface TruckScene extends TestScene {
  truckCases: TruckCase[];
  start(index: number, model: TruckModel, action?: 'entry' | 'exit'): void;
  modelProblem(index: number, model: TruckModel): string | null;
  tick(): void;
}

const CASES: { title: string; form: HouseForm; cargo: CargoType; model: TruckModel; w: number; h: number }[] = [
  { title: '01 · АЗС — доставка топлива', form: 'fuel', cargo: 'fuel', model: 'truck2', w: 68, h: 54 },
  { title: '02 · Склад — грузовая площадка', form: 'warehouse', cargo: 'food', model: 'truck3', w: 70, h: 54 },
  { title: '03 · Оптовая база — сквозной проезд', form: 'depot', cargo: 'food', model: 'truck3', w: 70, h: 54 },
  { title: '04 · Магазин — боковая разгрузка', form: 'shop', cargo: 'food', model: 'truck', w: 56, h: 52 },
  { title: '05 · Рынок — две рампы', form: 'market', cargo: 'food', model: 'truck2', w: 68, h: 54 },
  { title: '06 · Сельский магазин — боковая рампа', form: 'store', cargo: 'food', model: 'truck', w: 46, h: 46 },
  { title: '07 · Офис — служебный въезд', form: 'office', cargo: 'furniture', model: 'truck2', w: 64, h: 54 },
];

/** Настоящие линии доставки: станция-источник → двор получателя → обратно на станцию. */
export function buildTruckAccessScene(): TruckScene {
  const game = withoutCitizens(new Game({ seed: 1, size: 'small', towns: 0, industries: 'few', money: 1e9, water: 'dry', relief: 'plains', parking: true, retail: true, terrainVersion: TERRAIN_VERSION }));
  game.speed = 0;
  game.monthBudget = Infinity;
  game.openModelTier(3, true);
  (game as unknown as { growTown(): void }).growTown = () => {};
  game.townLots = () => false;
  game.terrain.clearWater();
  game.terrain.trees.length = 0;
  game.terrain.extraForests.length = 0;
  for (const industry of game.industries) game.index.remove(industry);
  game.industries = [];
  const truckCases: TruckCase[] = [];
  const lines: Record<string, number> = {};
  const errors: string[] = [];

  CASES.forEach((spec, index) => {
    try {
      // Правый верхний квартал оставлен под панель маршрутов, как в остальных тестовых сценах.
      const col = index === 0 ? 0 : (index - 1) % 3;
      const row = index === 0 ? 0 : 1 + Math.floor((index - 1) / 3);
      const x = 1400 + col * 580;
      const y = 1300 + row * 420;
      const points = [{ x, y }, { x: x + 460, y }, { x: x + 460, y: y + 230 }, { x, y: y + 230 }];
      for (let i = 0; i < points.length; i++) {
        const plan = roadPlan(game, i === 0 ? { free: points[i] } : points[i], i === points.length - 1 ? points[0] : { free: points[i + 1] }, { ...STREET, kink: true });
        if (!plan.ok || !game.roadBuilder.apply(plan)) throw new Error(plan.reason ?? 'Не построилась улица');
      }
      const road = game.roads.net.corridorNear({ x: x + 160, y: y + 230 }, 5)!;
      const { w, h } = spec;
      const town: Town = {
        id: index + 1, name: spec.title, center: { x: x + 230, y: y + 120 }, radius: 300, top: y,
        style: 'linear', population: 0, buildings: [], streets: [...game.roads.net.corridors.values()].filter((c) => c.lut.closest({ x: x + 230, y: y + 115 }).d < 260).map((c) => c.id),
        demands: [spec.cargo], supplied: {}, lastSupplied: {}, tripAcc: 0, growthAcc: 0, autoStreets: false, labelOnly: true,
        // Начальные покупатели не занимают грузовую сцену; их можно добавить обычным тестовым инструментом.
        shopParked: [],
      };
      const building: TownBuilding = {
        type: 'building', id: 200_000 + index, townId: town.id, kind: 'com', form: spec.form, floors: 2, people: 0,
        fp: { center: { x: x + 160, y: y + 230 - 8.5 - LOT_SETBACK - h / 2 }, w, h, angle: 0 }, face: 1,
        anchor: road.b, color: '#d9d2be', roof: spec.form === 'fuel' ? '#cf5547' : '#7c8975',
      };
      town.buildings.push(building);
      town.receivers = [{ b: building.id, cargo: [spec.cargo], w: 1, stock: {}, at: 0, ...(spec.form === 'depot' || spec.form === 'warehouse' ? { depot: true as const } : {}) }];
      game.towns.push(town);
      game.index.add(building);
      const dock = game.dockFor(building);
      if (!dock || dock.nodeId < 0) throw new Error('Нет грузового въезда');
      const source = game.placeStation({ x: x + 380, y: y + 278 }, 35, 'road', { pax: false, cargo: true });
      if (!source) throw new Error('Не встала станция-источник');
      source.name = `Источник: ${CARGO[spec.cargo].name.toLowerCase()}`;
      source.cargo[spec.cargo] = 10_000;
      const line = game.createLine([source.id, dock.id]);
      if (!line) throw new Error(game.lineProblem([source.id, dock.id]) ?? 'Не создалась линия доставки');
      game.renameLine(line.id, spec.title);
      lines[spec.form] = line.id;
      truckCases.push({ title: spec.title, town, building, source, dock, line: line.id, cargo: spec.cargo, model: spec.model, phase: 'ready', arrivals: 0, exits: 0, view: { x0: building.fp.center.x - w / 2 - 45, y0: building.fp.center.y - h / 2 - 35, x1: building.fp.center.x + w / 2 + 45, y1: y + 290 } });
    } catch (error) {
      errors.push(`${spec.title}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  const modelProblem = (index: number, model: TruckModel): string | null => {
    const c = truckCases[index];
    const m = MODELS[model];
    if (!c || m.mode !== 'road') return 'Не найден участок или грузовик';
    if (m.spec.length > maxTruck(c.building)) return `Длина ${m.spec.length}: двор допускает до ${maxTruck(c.building)}`;
    if (!game.docks.reachable(c.building, m.spec.length, m.spec.width)) return 'Недостаточно места для поворота и разгрузки';
    return null;
  };

  for (const [i, c] of truckCases.entries()) if (modelProblem(i, c.model)) c.model = TRUCK_MODELS.find((model) => !modelProblem(i, model)) ?? 'truck';

  const start = (index: number, model: TruckModel, action?: 'entry' | 'exit') => {
    const c = truckCases[index];
    const problem = modelProblem(index, model);
    if (problem) throw new Error(problem);
    const vehicleModel = MODELS[model];
    if (vehicleModel.mode !== 'road') throw new Error('Нужна дорожная модель');
    if (c.vehicle) game.sellVehicle(c.vehicle.id);
    c.source.cargo[c.cargo] = 10_000;
    const receiver = c.town.receivers?.find((r) => r.b === c.building.id);
    if (receiver) { receiver.stock = {}; receiver.at = game.time; }
    c.dock.cargo = {};
    const v = game.buyVehicle(c.line, model);
    if (!v) throw new Error('Не удалось добавить грузовик на линию');
    // Только подготовка источника: дальше загрузку, движение и доковые манёвры полностью выполняет Game.
    v.cargo = c.cargo;
    v.amount = MODELS[model].capacity;
    v.loadedAt = c.source.id;
    v.fromStore = true;
    delete v.fresh;
    v.timer = 0;
    c.vehicle = v;
    c.model = model;
    c.phase = 'outbound';
    c.action = action;
    if (action) {
      v.stop = 1;
      v.inBay = false;
      delete v.bay;
      delete v.enter;
      c.source.occupied = c.source.occupied.filter((id) => id !== v.id);
      const spec = vehicleModel.spec;
      const geo = game.docks.geoOf(c.building, spec.length, spec.width)!;
      if (action === 'entry') {
        v.state = 'driving';
        // Тот же путь восстановления машины и её владельца, что при загрузке сохранения.
        const sim = (game as unknown as { placeOnRoad(v: FleetVehicle, spot: RoadSpot): Vehicle | null }).placeOnRoad(v, {
          pos: add(geo.in!.pos, scale(geo.in!.f, spec.length / 2 - 2)), dir: geo.in!.f, v: 0, trip: 0, stopped: 0,
        });
        if (!sim) {
          game.sellVehicle(v.id);
          delete c.vehicle;
          c.phase = 'ready';
          throw new Error('Начало заезда занято другой машиной');
        }
        c.phase = 'entering';
      } else {
        v.state = 'loading';
        v.cargo = null;
        v.amount = 0;
        if (!game.docks.stand(v.id, c.building, spec.length, spec.width) || !game.docks.leave(v.id, spec, c.source.nodeId, undefined, c.building)) throw new Error('Не удалось запустить выезд от рампы');
        c.phase = 'leaving';
      }
    }
    game.speed = 1;
  };

  const tick = () => {
    for (const c of truckCases) {
      const v = c.vehicle;
      if (!v || c.phase === 'ready' || c.phase === 'done') continue;
      if (game.docks.entering(v.id)) c.phase = 'entering';
      else if (game.docks.leaving(v.id)) c.phase = 'leaving';
      else if (game.docks.inYard(v.id)) {
        if (c.phase !== 'unloading') { c.phase = 'unloading'; c.arrivals++; }
      } else if (c.phase === 'leaving' && game.fleetSim(v)) { c.phase = 'returning'; c.exits++; }
      if (c.action === 'entry' && c.phase === 'unloading') v.timer = Infinity;
      if (c.action === 'exit' && c.phase === 'returning') {
        const sim = game.fleetSim(v);
        if (sim) game.traffic.holdAfter(sim, 0);
        c.phase = 'done';
      }
      if (c.phase === 'returning' && v.stop === 0 && v.state === 'loading' && !v.enter) {
        c.phase = 'done';
        v.timer = Infinity;
      }
    }
  };
  game.money = game.settings.money;
  game.incomeMonth = game.expensesMonth = 0;
  game.ledger = emptyLedger();
  return { game, truckCases, lines, errors, start, modelProblem, tick, view: { x0: 1350, y0: 1120, x1: 3160, y1: 2510 } };
}

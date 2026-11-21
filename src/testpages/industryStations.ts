import { add, scale, type Vec } from '../core/vec';
import { emptyLedger, Game } from '../game/game';
import { stationGatePoints } from '../game/stationAccess';
import { roadPlan, stationExit, STREET, withoutCitizens, type End } from '../game/testkit';
import { DEFAULT_RULE, type FleetVehicle, type ModelId } from '../game/transport';
import { RoadTools } from '../input/roadtools';
import { INDUSTRY_TYPES, type CargoType, type IndustryKind } from '../world/cargo';
import type { Industry, Station } from '../world/entities';
import { industryFootprint } from '../world/industrySites';
import { TERRAIN_VERSION } from '../world/settings';
import type { TestScene } from './index';

export const INDUSTRY_STATION_POSTS = [2, 4, 8] as const;
export const INDUSTRY_STATION_ACCESS = {
  shared: 'Один двусторонний подъезд',
  split: 'Раздельные въезд и выезд',
  dual: 'Два двусторонних подъезда',
} as const;
export const INDUSTRY_STATION_LOAD = {
  low: { label: 'Низкая', vehicles: 3 },
  medium: { label: 'Средняя', vehicles: 8 },
  high: { label: 'Высокая', vehicles: 22 },
} as const;

export interface IndustryStationOptions {
  access: keyof typeof INDUSTRY_STATION_ACCESS;
  bays: (typeof INDUSTRY_STATION_POSTS)[number];
  load: keyof typeof INDUSTRY_STATION_LOAD;
}

const DEFAULT_OPTIONS: IndustryStationOptions = { access: 'shared', bays: 4, load: 'medium' };
const MODELS: readonly ModelId[] = ['truck', 'truck2', 'truck3'];
const MAIN_ROAD_Y = 1810;
const OVERVIEW = { x0: 1910, y0: 1440, x1: 2690, y1: 2170 };

export interface IndustryStationScene extends TestScene {
  industryStationOptions: IndustryStationOptions;
  yard: Station | null;
  focusView: TestScene['view'];
  overview: TestScene['view'];
  stats: { occupied: number; waiting: number; peakWaiting: number; arrivals: number; departures: number };
  tick(): void;
}

/** Две линии с настоящими рейсами к грузовому двору мясокомбината. */
export function buildIndustryStationScene(options: IndustryStationOptions = DEFAULT_OPTIONS): IndustryStationScene {
  const game = withoutCitizens(new Game({ seed: 1, size: 'small', towns: 0, industries: 'few', money: 1e9, water: 'dry', relief: 'plains', terrainVersion: TERRAIN_VERSION }));
  game.terrain.clearWater();
  game.terrain.trees.length = 0;
  game.terrain.extraForests.length = 0;
  for (const industry of game.industries) game.index.remove(industry);
  game.industries = [];
  game.openModelTier(3, true);

  const lines: Record<string, number> = {};
  const errors: string[] = [];
  const stats = { occupied: 0, waiting: 0, peakWaiting: 0, arrivals: 0, departures: 0 };
  const atYard = new Set<number>();
  const fleet: FleetVehicle[] = [];
  const supplies: { station: Station; cargo: CargoType }[] = [];
  let yard: Station | null = null;

  try {
    const target = buildStation(game, 'meatplant', { x: 2300, y: 1490 }, Math.PI / 2);
    yard = target;
    const sources = [
      { kind: 'farm', cargo: 'grain', pos: { x: 2060, y: 2070 } },
      { kind: 'ranch', cargo: 'livestock', pos: { x: 2540, y: 2070 } },
    ] as const;
    const sourceStations = sources.map(({ kind, pos }) => buildStation(game, kind, pos, -Math.PI / 2));
    buildRoad(game, { free: { x: 1940, y: MAIN_ROAD_Y } }, { free: { x: 2660, y: MAIN_ROAD_Y } });
    const baysError = game.setStationBays(target.id, options.bays);
    if (baysError) throw new Error(baysError);
    if (options.access === 'shared') connectDriveway(game, target);
    else connectGates(game, target, options.access === 'split');

    const count = INDUSTRY_STATION_LOAD[options.load].vehicles;
    sources.forEach(({ kind, cargo }, side) => {
      const source = sourceStations[side];
      connectDriveway(game, source);
      const sourceError = game.setStationBays(source.id, 8);
      if (sourceError) throw new Error(sourceError);
      const stops = [source.id, target.id];
      const line = game.createLine(stops);
      if (!line) throw new Error(game.lineProblem(stops) ?? 'Не создалась грузовая линия');
      game.setLineSpacing(line.id, false);
      game.setStopRule(line.id, 0, { ...DEFAULT_RULE, wait: 'none', load: [cargo] });
      game.setStopRule(line.id, 1, { ...DEFAULT_RULE, wait: 'none', load: [] });
      lines[kind] = line.id;
      supplies.push({ station: source, cargo });
      source.cargo[cargo] = 300;
      for (let i = side; i < count; i += sources.length) {
        const vehicle = game.buyVehicle(line.id, MODELS[i % MODELS.length]);
        if (!vehicle) throw new Error('Не удалось добавить грузовик на линию');
        fleet.push(vehicle);
      }
    });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  const tick = () => {
    if (!yard) return;
    // Запас сырья поддерживает повторные рейсы при любой выбранной нагрузке.
    for (const { station, cargo } of supplies) if ((station.cargo[cargo] ?? 0) < 160) station.cargo[cargo] = 300;
    stats.occupied = yard.occupied.length;
    stats.waiting = Math.max(game.stationJam(yard), fleet.filter((v) => v.stop === 1 && game.bayWait(v) > 0).length);
    stats.peakWaiting = Math.max(stats.peakWaiting, stats.waiting);
    for (const v of fleet) {
      if (v.stop === 1 && v.inBay && !v.enter && !atYard.has(v.id)) {
        atYard.add(v.id);
        stats.arrivals++;
      }
      if (v.stop === 0 && v.state === 'driving' && atYard.delete(v.id)) stats.departures++;
    }
  };

  game.speed = errors.length ? 0 : 1;
  if (yard && game.speed) {
    // Начинаем показ у первого заезда, чтобы при переключении не ждать проезда по всему маршруту.
    for (let i = 0; i < 600 && !yard.occupied.length; i++) {
      game.update(0.1);
      tick();
    }
  }
  game.money = game.settings.money;
  game.incomeMonth = game.expensesMonth = 0;
  game.ledger = emptyLedger();
  const focusView = yard ? {
    x0: yard.fp.center.x - 110, x1: yard.fp.center.x + 125,
    y0: yard.fp.center.y - 90, y1: MAIN_ROAD_Y + 28,
  } : OVERVIEW;
  return { game, view: focusView, focusView, overview: OVERVIEW, maxZoom: 2.6, lines, errors, industryStationOptions: options, yard, stats, tick };
}

function buildStation(game: Game, kind: IndustryKind, center: Vec, angle: number): Station {
  const info = INDUSTRY_TYPES[kind];
  const industry: Industry = {
    type: 'industry', id: 200_000 + game.industries.length, info, name: info.name,
    fp: industryFootprint(info, center, angle), stock: {}, output: 0,
    producedMonth: 0, producedLast: 0, prodAcc: 0,
  };
  game.industries.push(industry);
  game.index.add(industry);
  const at = add(center, scale({ x: Math.cos(angle), y: Math.sin(angle) }, info.w / 2 + 22));
  const station = game.placeStation(at, 14, 'road', { pax: false, cargo: true });
  if (!station || station.industryId !== industry.id) throw new Error(`${info.name} — ${game.stationPlan(at, 14, 'road').reason ?? 'не построилась автостанция'}`);
  return station;
}

function buildRoad(game: Game, from: End, to: End): void {
  const plan = roadPlan(game, from, to, STREET);
  if (!plan.ok || !game.roadBuilder.apply(plan)) throw new Error(plan.reason ?? 'Не построилась улица');
}

function connectDriveway(game: Game, station: Station): void {
  const exit = stationExit(game, station.nodeId);
  buildRoad(game, exit.id, { x: exit.pos.x, y: MAIN_ROAD_Y });
}

function connectGates(game: Game, station: Station, oneWay: boolean): void {
  const net = game.roads.net;
  const gates = stationGatePoints(station, net).filter((gate) => !gate.side).sort((a, b) => a.pos.x - b.pos.x);
  const demolition = game.roadBuilder.bulldoze([...net.node(station.nodeId).corridors]);
  if (!demolition.ok || !game.roadBuilder.apply(demolition)) throw new Error('Не удалось заменить основной подъезд');

  const tools = new RoadTools(() => game);
  tools.auto = false;
  for (const [index, gate] of gates.entries()) {
    const road = { x: gate.pos.x, y: MAIN_ROAD_Y };
    const [from, to] = oneWay && index === 1 ? [gate.pos, road] : [road, gate.pos];
    tools.clear();
    if (!tools.begin(from, 8)) throw new Error('Не найдено начало подъезда');
    const error = tools.build(to, { cls: 'street', lanesF: 1, lanesB: oneWay ? 0 : 1 }, 'straight', 8, false);
    if (error) throw new Error(error);
  }
}

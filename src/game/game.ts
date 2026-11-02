import {
  CAR_COLORS,
  COST,
  ECONOMY,
  LIGHTS,
  MIN_SEGMENT_LEN,
  MONTH_LENGTH,
  RAIL_STATION,
  SIM_DT,
  START_YEAR,
  STATION,
  STOP,
  TOWN_GROWTH,
  TOWN_TRAFFIC,
} from '../config';
import { Cubic, CurveLUT, intersectCurves, offsetCubic, reverseCubic, splitBezier, straightCubic } from '../core/bezier';
import { Rng } from '../core/rng';
import { add, angleDiff, angleOf, cross, dist, dot, scale, sub, Vec } from '../core/vec';
import { Anchor, anchorAt, buildRing, insideRuns, splitCorridor } from '../lanes/edit';
import { copyBox, Fragment, pasteFragment } from '../lanes/fragment';
import { Corridor, laneKey, LaneLink, LaneNet, LaneNetSave, LaneNode, parseLaneKey, twoWay } from '../lanes/model';
import type { LaneTraffic } from '../lanes/traffic';
import { RailSim, Train } from '../sim/rail';
import type { Vehicle, VehicleLook } from '../sim/vehicle';
import { CARGO, CargoType, FREIGHT, INDUSTRY_TYPES, IndustryKind } from '../world/cargo';
import { Industry, Station, StationServes, Structure, Town, TOWN_NEED, TownBuilding } from '../world/entities';
import { Network, NetworkSave, Segment } from '../world/network';
import { halfWidth, isRail, isTrunk, LANE_W, RAIL_HALF, RAIL_SPEC, specCost, TRACK_GAP } from '../world/roadTypes';
import { Footprint, footprintCorners, footprintRadius, FootprintIndex, footprintsOverlap, pointInFootprint } from '../world/spatial';
import { DEFAULT_SETTINGS, WorldSettings } from '../world/settings';
import { Terrain } from '../world/terrain';
import {
  anchorFor,
  coreRadius,
  corridorHalf,
  fillStreet,
  generateWorld,
  halfAtS,
  measureTown,
  nearHighway,
  normalTowards,
  onRail,
  placeable,
  railNear,
  recountPopulation,
  WorldContext,
} from '../world/worldgen';
import { findCrossings, LevelCrossing } from './crossings';
import { corridorCost, RoadBuilder, RoadPlan } from './roadbuild';
import { RING_SIZES, RingOptions, Roads } from './roads';
import { BuildContext, Builder, Plan, RoadRequest, Snap } from './build';
import { diamondPlan, TemplateOptions, templatePlan, TemplatePlan } from './interchange';
import { cloneNetwork, copyRails, RailPaste } from './railFragment';
import {
  AUTO_FLEET,
  DEFAULT_RULE,
  FleetVehicle,
  Line,
  LineAuto,
  LINE_COLORS,
  LineFolder,
  LineMode,
  ModelId,
  MODELS,
  newestLike,
  RailModel,
  StopRule,
  vehicleCapacity,
  vehicleLoad,
  carsOf,
  bayFront,
  bayPose,
  entryPose,
  nearestBay,
  Pose,
} from './transport';

export type StationKind = Station['kind'];

export type TurnKind = 'left' | 'straight' | 'right';

/** Что попадёт под снос рамкой: что вернём за дороги и сколько стоит снос домов. */
export interface AreaContents {
  /** Пути. */
  segs: number[];
  /** Дороги — полотна. */
  corridors: number[];
  buildings: TownBuilding[];
  stations: Station[];
  refund: number;
  cost: number;
}

/** План вставки куска: его дороги — планом строителя дорог, пути — планами строителя путей по участкам. */
export interface PastePlan extends RoadPlan {
  /** Дороги куска; дорог в нём нет — null. */
  road: RoadPlan | null;
  /** Участки путей куска (для предпросмотра). */
  rails: Plan[];
  /** За пути: сколько заплатим и сколько стоят снесённые под рамкой (вернём часть). */
  railSpend: number;
  railRefund: number;
}

/** Куда встанет ж/д сигнал (или какой снять). */
export interface SignalPlan {
  ok: boolean;
  reason?: string;
  pos?: Vec;
  /** Направление поездов, которые видят сигнал. */
  dir?: Vec;
  /** Сигнал в существующем узле… */
  nodeId?: number;
  outSeg?: number;
  /** …или в новой точке на участке. */
  segId?: number;
  t?: number;
  forward?: boolean;
  remove?: boolean;
  cost?: number;
}

export interface Compass {
  name: string;
  arrow: string;
}

/** Сторона света, куда уходит дорога от узла (экран: вверх — север). */
export function compassOf(d: Vec): Compass {
  const names = ['В', 'ЮВ', 'Ю', 'ЮЗ', 'З', 'СЗ', 'С', 'СВ'];
  const arrows = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'];
  const k = (Math.round(Math.atan2(d.y, d.x) / (Math.PI / 4)) + 8) % 8;
  return { name: names[k], arrow: arrows[k] };
}

export interface JunctionInfo {
  node: LaneNode;
  approaches: { seg: number; compass: Compass; dir: Vec }[];
  turns: { from: number; label: Compass; exits: { out: number; kind: TurnKind; banned: boolean }[] }[];
  pairs: { segs: [number, number]; name: string }[];
  /** Участки, у которых сейчас приоритет. */
  mainNow: number[];
  phases: { approaches: Compass[]; green: number; active: boolean }[];
  label: (seg: number) => Compass;
  /** Сколько полос въезда игрок настроил вручную. */
  customLanes: number;
}

/** Конец полосы у перекрёстка — метка для настройки связей полос на карте. */
export interface LaneEnd {
  kind: 'in' | 'out';
  seg: number;
  /** Номер полосы справа по ходу движения. */
  i: number;
  /** id полосы в сети. */
  lane: number;
  pos: Vec;
  dir: Vec;
  /** Въезд: полосу настроил игрок. */
  custom: boolean;
  /** Въезд: на какие участки с неё в принципе можно выехать. */
  exits: number[];
}

/** Сколько последних строек можно отменить. */
const UNDO_DEPTH = 30;

/** Чем ездят к станции: к вокзалу — поезда, к автостанции и остановке — машины. */
export function stationMode(st: Pick<Station, 'kind'>): LineMode {
  return st.kind === 'rail' ? 'rail' : 'road';
}

/** Центр окружности через три точки; на одной прямой — null. */
function circleCenter(a: Vec, b: Vec, c: Vec): Vec | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-6) return null;
  const a2 = a.x * a.x + a.y * a.y;
  const b2 = b.x * b.x + b.y * b.y;
  const c2 = c.x * c.x + c.y * c.y;
  return { x: (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d, y: (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d };
}

/** Плата за кольцо: растёт с радиусом и числом полос. */
function roundaboutFee(R: number, lanes: number): number {
  return Math.round((COST.roundabout * (R / 40) * (0.6 + 0.4 * lanes)) / 100) * 100;
}

/** Снимок построек до действия игрока — для Ctrl+Z. */
interface UndoSnapshot {
  label: string;
  /** Дороги — копия сети полос; пути — старая сеть. */
  roads: LaneNet;
  net: NetworkSave;
  version: number;
  roadsVersion: number;
  stations: SaveData['stations'];
  buildings: { townId: number; list: TownBuilding[] }[];
  roundabouts: [number, Vec][];
  moneyBefore: number;
  /** Сколько стоило действие — вернётся при отмене. */
  spent: number;
}

/** По умолчанию станция работает и с пассажирами, и с грузом. */
export const ALL_SERVICES: StationServes = { pax: true, cargo: true };

/** Геометрия будущего вокзала: где резать путь и куда класть второй. */
interface RailStationGeom {
  segId: number;
  /** Стрелка, начало платформы, конец платформы, стрелка — вдоль пути. */
  cuts: [number, number, number, number];
  /** Дополнительные пути (2-й, 3-й, …): съезд, платформа, съезд. */
  tracks: [Cubic, Cubic, Cubic][];
  /** Станция в чистом поле: сначала строим этот главный путь (segId тогда −1). */
  main?: RoadRequest;
}

type SimOwner = { type: 'fleet'; id: number } | { type: 'citizen' };

export interface Notice {
  text: string;
  color?: string;
  age: number;
}

export interface Floater {
  pos: Vec;
  text: string;
  color: string;
  age: number;
}

/** Доходы и расходы месяца по статьям — для окна «Финансы». */
export interface Ledger {
  /** Перевозки: грузы и пассажиры. */
  transport: number;
  /** Продажа транспорта и возврат за снос. */
  sales: number;
  /** Содержание транспорта. */
  vehicles: number;
  /** Ремонт дорог и путей. */
  roads: number;
  /** Строительство. */
  build: number;
  /** Покупка транспорта. */
  purchases: number;
  /** Проценты по кредиту. */
  interest: number;
}

export const emptyLedger = (): Ledger => ({ transport: 0, sales: 0, vehicles: 0, roads: 0, build: 0, purchases: 0, interest: 0 });

export interface MonthRecord {
  label: string;
  income: number;
  expenses: number;
  money: number;
  /** В старых сохранениях нет. */
  ledger?: Ledger;
}

export interface Partner {
  cargo: CargoType;
  direction: 'in' | 'out';
  pos: Vec;
  name: string;
  ref: { type: 'industry' | 'town'; id: number };
  distance: number;
}

/** 3 — дороги из полос (сохранения версии 2 со старыми дорогами не грузятся, лежат в резервном ключе). */
export const SAVE_VERSION = 3;

/** Машина компании на дороге в сохранении: нос, курс, скорость и сколько уже в пути. */
export interface RoadSpot {
  pos: Vec;
  dir: Vec;
  v: number;
  trip: number;
  stopped: number;
}

export interface SaveData {
  version: number;
  settings: WorldSettings;
  savedAt: number;
  rng: number;
  time: number;
  month: number;
  money: number;
  incomeMonth: number;
  expensesMonth: number;
  ledger?: Ledger;
  loan?: number;
  nextEntityId: number;
  extraForests: { c: Vec; r: number }[];
  /** Железная дорога. */
  net: NetworkSave;
  /** Дороги — сеть полос. */
  roads: LaneNetSave;
  towns: Town[];
  industries: (Omit<Industry, 'info' | 'type'> & { kind: IndustryKind })[];
  stations: (Omit<Station, 'passengers' | 'accepts' | 'type'> & { passengers: [number, number][]; accepts: CargoType[] })[];
  lines: Line[];
  /** Папки линий. В старых сохранениях отсутствуют. */
  folders?: LineFolder[];
  /** onRoad — где машина была на дороге; в старых сохранениях нет: машины в пути начинали со станции. */
  fleet: (FleetVehicle & { onRoad?: RoadSpot })[];
  roundabouts: [number, Vec][];
  history: MonthRecord[];
  /** Поезда в пути и на платформах. */
  rail?: ReturnType<RailSim['serialize']>;
  /** Положение камеры — заполняет интерфейс. */
  view?: { x: number; y: number; zoom: number };
}

export interface StationPlan {
  ok: boolean;
  reason?: string;
  cost: number;
  fp: Footprint | null;
  /** Станция пристроена к этому предприятию. */
  industryId?: number;
  /** Для вокзала: как разрезать путь и где пройдёт второй путь. */
  rail?: RailStationGeom;
  /** Выезд автостанции: план дороги (сеть с выездом — для предпросмотра, даже если поставить нельзя). */
  driveway?: RoadPlan;
  /** Откуда идёт выезд: узел (перекрёсток, тупик) или место на полотне. */
  from?: Anchor;
  /** Тупик выезда — узел станции. */
  nodePos?: Vec;
  /** Дома под самой станцией: снесём за доплату (их цена уже в cost). Дома под выездом — в driveway.demolish. */
  demolish?: number[];
}

/** Можно ли сделать на станции столько постов погрузки и во что это обойдётся. */
export interface BaysPlan {
  ok: boolean;
  reason?: string;
  /** Плюс — доплата за новые посты, минус — возврат за убранные. */
  cost: number;
  fp: Footprint | null;
}

const MONTHS = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];
/** Выезд автостанции — улица 1+1. */
const DRIVEWAY = { cls: 'street' as const, lanes: twoWay(1, 1) };
/** Выезд станции из перекрёстка — не ближе этого угла (рад) к соседним дорогам. */
const STATION_JOIN_GAP = 0.5;
/** Легковушка жителя: до ≈130 км/ч на автомагистрали. */
const CAR_SPEC = { kind: 'car' as const, length: 7, width: 4, maxSpeed: 60, accel: 10 };
/** Сквозной путь ж/д вокзала (первая платформа), если у него есть боковые пути. */
const throughOf = (st: Station): number | undefined => (st.platforms.length > 1 ? st.platforms[0] : undefined);
/** Платформы вокзала: боковые первыми, сквозной путь — последним. */
const sidingsFirst = (st: Station): number[] => (st.platforms.length > 1 ? [...st.platforms.slice(1), st.platforms[0]] : st.platforms);

export class Game implements BuildContext {
  readonly rng: Rng;
  readonly terrain: Terrain;
  /** Железная дорога (пути, стрелки, сигналы, платформы). */
  readonly net = new Network();
  /** Дороги: сеть полос, граф движения и машины. */
  readonly roads: Roads;
  readonly index = new FootprintIndex<Structure>();
  readonly rail: RailSim;
  /** Строитель путей (старая сеть). */
  readonly builder: Builder;
  /** Строитель дорог — на сети полос. */
  readonly roadBuilder: RoadBuilder;
  /** Переезды: где дороги пересекают пути на земле. */
  levelCrossings: LevelCrossing[] = [];
  towns: Town[] = [];
  industries: Industry[] = [];
  readonly stations = new Map<number, Station>();
  readonly lines = new Map<number, Line>();
  /** Папки списка линий — в порядке создания. */
  readonly folders = new Map<number, LineFolder>();
  readonly fleet = new Map<number, FleetVehicle>();
  readonly roundaboutCenters = new Map<number, Vec>();
  readonly notices: Notice[] = [];
  readonly floaters: Floater[] = [];
  readonly history: MonthRecord[] = [];

  money: number;
  time = 0;
  speed = 1;
  incomeMonth = 0;
  expensesMonth = 0;
  /** Статьи доходов и расходов текущего месяца. */
  ledger: Ledger = emptyLedger();
  /** Взятый кредит: проценты списываются раз в месяц. */
  loan = 0;
  citizenCars = 0;
  private month = 0;
  private accumulator = 0;
  private nextEntityId = 1;
  private readonly owners = new Map<number, SimOwner>();
  private roadValue = { version: -1, value: 0 };
  /** Прикидка времени круга линии, пока его не измерили по рейсам: когда считали и сколько вышло. */
  private readonly lapGuess = new Map<number, { at: number; lap: number | null }>();
  /** Вызывается в конце каждого игрового месяца — для автосохранения. */
  onMonthEnd: () => void = () => {};

  readonly settings: WorldSettings;

  constructor(setup: WorldSettings | number, save?: SaveData) {
    this.settings = typeof setup === 'number' ? { ...DEFAULT_SETTINGS, seed: setup } : setup;
    this.rng = new Rng(this.settings.seed);
    this.terrain = new Terrain(this.rng, this.settings);
    this.money = this.settings.money;
    this.roads = new Roads({
      canArrive: (v) => this.canArrive(v),
      onArrive: (v) => this.onArrive(v),
      onLost: (v) => this.onLost(v),
    });
    this.rail = new RailSim(this.net, {
      onArrive: (t) => this.onTrainArrive(t),
      onLost: (t) => this.onTrainLost(t),
    });
    this.builder = new Builder(this);
    this.roadBuilder = new RoadBuilder(this);
    if (save) {
      this.restore(save);
      return;
    }
    const world = generateWorld(this.worldContext(), this.settings);
    this.towns = world.towns;
    this.industries = world.industries;
    this.net.rebuild();
    this.roads.changed();
  }

  /** Машины на дорогах. */
  get traffic(): LaneTraffic {
    return this.roads.traffic;
  }

  // ---------- Сохранение ----------

  get seed(): number {
    return this.settings.seed;
  }

  toSave(): SaveData {
    return {
      version: SAVE_VERSION,
      settings: this.settings,
      savedAt: Date.now(),
      rng: this.rng.seedState,
      time: this.time,
      month: this.month,
      money: this.money,
      incomeMonth: this.incomeMonth,
      expensesMonth: this.expensesMonth,
      ledger: this.ledger,
      loan: this.loan,
      nextEntityId: this.nextEntityId,
      extraForests: this.terrain.extraForests,
      net: this.net.serialize(),
      roads: this.roads.net.toJSON(),
      towns: this.towns,
      industries: this.industries.map(({ info, type: _t, ...rest }) => ({ ...rest, kind: info.kind })),
      stations: [...this.stations.values()].map((s) => this.stationToSave(s)),
      lines: [...this.lines.values()],
      folders: [...this.folders.values()],
      fleet: [...this.fleet.values()].map((v) => this.fleetToSave(v)),
      roundabouts: [...this.roundaboutCenters],
      history: this.history,
      rail: this.rail.serialize(),
    };
  }

  /** Машина компании для сохранения; в пути — с местом на дороге, чтобы после загрузки ехать дальше оттуда же. */
  private fleetToSave(v: FleetVehicle): SaveData['fleet'][number] {
    const sim = v.state === 'driving' ? this.fleetSim(v) : undefined;
    if (!sim) return v;
    const spot = this.traffic.spotOf(sim);
    return { ...v, onRoad: { ...spot, v: sim.v, trip: sim.tripTime, stopped: sim.stoppedTime } };
  }

  /** Машина из сохранения снова на дороге — там же, где была, с маршрутом до своей станции заново. */
  private placeOnRoad(v: FleetVehicle, spot: RoadSpot): Vehicle | null {
    const m = MODELS[v.model];
    const line = this.lines.get(v.lineId);
    const to = line && this.stations.get(line.stops[v.stop]);
    if (m.mode !== 'road' || v.state !== 'driving' || !line || !to) return null;
    const load = v.cargo ? CARGO[v.cargo].color : undefined;
    const sim = this.traffic.place({ ...m.spec, color: line.color, load, targetNode: to.nodeId }, spot.pos, spot.dir, spot.v);
    if (!sim) return null;
    sim.tripTime = spot.trip;
    sim.stoppedTime = spot.stopped;
    this.owners.set(sim.id, { type: 'fleet', id: v.id });
    v.simId = sim.id;
    return sim;
  }

  /** Станция из сохранения; в старых сохранениях нет ж/д станций и выбора «пассажиры / груз». */
  private stationFromSave(s: SaveData['stations'][number]): Station {
    return {
      ...s,
      kind: s.kind ?? 'road',
      platforms: s.platforms ?? [],
      serves: s.serves ?? { pax: true, cargo: true },
      type: 'station',
      passengers: new Map(s.passengers),
      accepts: new Set(s.accepts),
      occupied: [],
    };
  }

  private stationToSave(s: Station): SaveData['stations'][number] {
    return { ...s, passengers: [...s.passengers], accepts: [...s.accepts], occupied: [] };
  }

  /**
   * После восстановления сети: машины, которых не удалось вернуть на полосу, и поезда,
   * которых нет на путях, возвращаются на предыдущую станцию со своим грузом.
   */
  private reattachFleet(sims: Set<number>, trains: Set<number>): void {
    for (const st of this.stations.values()) st.occupied = [];
    for (const v of this.fleet.values()) {
      const line = this.lines.get(v.lineId);
      if (!line) continue;
      if (MODELS[v.model].mode === 'rail') {
        // Поезд, которого нет в симуляции, снова встанет на платформу в updateTrain.
        if (v.trainId == null || !trains.has(v.trainId)) v.trainId = null;
        continue;
      }
      if (v.state === 'driving' && v.simId !== null && sims.has(v.simId)) continue;
      if (v.state === 'driving') {
        v.state = 'departing';
        v.stop = (v.stop - 1 + line.stops.length) % line.stops.length;
        v.timer = 1;
        v.inBay = false;
      }
      v.simId = null;
      if (v.inBay) this.stations.get(line.stops[v.stop])?.occupied.push(v.id);
    }
    // В старых сохранениях у машин на автостанции нет номера поста.
    for (const st of this.stations.values()) {
      if (st.kind !== 'road') continue;
      for (const id of st.occupied) {
        const v = this.fleet.get(id)!;
        if (v.bay === undefined) v.bay = this.freeBay(st, st.fp.center);
      }
    }
  }

  /**
   * Восстанавливает игру вместе с машинами в пути. Если машину не удалось вернуть
   * на её полосу (старое сохранение), она возвращается на предыдущую станцию со своим грузом.
   */
  private restore(save: SaveData): void {
    for (const f of save.extraForests) this.terrain.addForest(f.c, f.r, this.rng);
    this.net.load(save.net);
    this.roads.replace(LaneNet.fromJSON(save.roads));
    this.towns = save.towns;
    for (const t of this.towns) {
      // Дома, которые город по прежним правилам поставил прямо на пути, сносим.
      const clear = t.buildings.filter((b) => b.kind === 'landmark' || !onRail(this.net, b.fp, 0));
      if (clear.length < t.buildings.length) {
        t.buildings = clear;
        recountPopulation(t);
      }
      for (const b of t.buildings) this.index.add(b);
      // Радиус старых сохранений — по самому дальнему дому; теперь — по плотной застройке.
      measureTown(t);
    }
    this.industries = save.industries.map(({ kind, ...rest }) => ({ ...rest, type: 'industry', info: INDUSTRY_TYPES[kind] }));
    for (const ind of this.industries) this.index.add(ind);
    for (const s of save.stations) {
      const st = this.stationFromSave(s);
      this.stations.set(st.id, st);
      this.index.add(st);
    }
    for (const line of save.lines) this.lines.set(line.id, line);
    for (const f of save.folders ?? []) this.folders.set(f.id, f);
    // Линия из несуществующей папки возвращается в корень списка.
    for (const line of this.lines.values()) if (line.folder !== undefined && !this.folders.has(line.folder)) delete line.folder;
    // Машины в пути встают на дорогу там же, где были; не вышло (или сохранение старое) — вернутся на станцию.
    const restored = new Set<number>();
    const trains = save.rail ? this.rail.restore(save.rail) : new Set<number>();
    for (const { onRoad, ...v } of save.fleet) {
      if (!this.lines.has(v.lineId)) continue;
      // Номер машины в движении — от прошлой партии.
      v.simId = null;
      this.fleet.set(v.id, v);
      const sim = onRoad && this.placeOnRoad(v, onRoad);
      if (sim) restored.add(sim.id);
    }
    this.reattachFleet(restored, trains);
    for (const [id, c] of save.roundabouts) this.roundaboutCenters.set(id, c);
    // В старых сохранениях могли остаться следы снесённых колец.
    this.pruneRoundabouts();
    this.net.rebuild();
    this.refreshCrossings();
    this.history.push(...save.history);
    this.time = save.time;
    this.month = save.month;
    this.money = save.money;
    this.incomeMonth = save.incomeMonth;
    this.expensesMonth = save.expensesMonth;
    this.ledger = { ...emptyLedger(), ...save.ledger };
    this.loan = save.loan ?? 0;
    this.nextEntityId = save.nextEntityId;
    this.rng.seedState = save.rng;
  }

  /**
   * Станция вплотную к предприятию: площадка у стены со стороны курсора, ворота и короткий выезд.
   * Если рядом с концом выезда есть дорога, выезд сразу к ней подключается.
   */
  private industryStationPlan(ind: Industry, p: Vec): StationPlan {
    const fp = ind.fp;
    const u = { x: Math.cos(fp.angle), y: Math.sin(fp.angle) };
    const v = { x: -u.y, y: u.x };
    const d = sub(p, fp.center);
    const lx = dot(d, u);
    const ly = dot(d, v);
    const alongX = Math.abs(lx) / (fp.w / 2) > Math.abs(ly) / (fp.h / 2);
    const n = alongX ? scale(u, Math.sign(lx) || 1) : scale(v, Math.sign(ly) || 1);
    const half = alongX ? fp.w / 2 : fp.h / 2;
    const along = alongX ? fp.h : fp.w;
    const axis = alongX ? v : u;
    const dockW = Math.min(64, along * 0.7);
    const slide = Math.max(-(along / 2 - dockW / 2), Math.min(along / 2 - dockW / 2, alongX ? ly : lx));
    const at = (k: number) => add(add(fp.center, scale(axis, slide)), scale(n, half + k));
    const dock: Footprint = { center: at(12), w: dockW, h: 18, angle: Math.atan2(n.x, -n.y) };
    const fail = (reason: string, cost = COST.station, driveway?: RoadPlan): StationPlan => ({
      ok: false,
      reason,
      cost,
      fp: dock,
      industryId: ind.id,
      driveway,
    });
    const gate = at(26);
    const exit = at(64);
    if ([dock.center, gate, exit].some((q) => this.isWater(q, 10) || !this.inBounds(q, 40))) return fail('Мешает вода');
    // Дома на месте площадки сносим за доплату; другое предприятие или станция мешают.
    const under = this.structuresUnder(dock, 0);
    if (under.blocker) return fail(under.blocker);
    // Выезд — от дороги (если она рядом) к воротам: тупик у ворот и есть узел станции.
    const plan = this.roadBuilder.road(anchorAt(this.roads.net, exit, 16), { kind: 'free', pos: gate }, DRIVEWAY);
    const demolish = under.houses.filter((id) => !plan.demolish.includes(id));
    const cost = plan.cost + COST.station + this.demolishTotal(demolish);
    if (!plan.ok) return fail(plan.reason ?? 'Нельзя построить', cost, plan);
    if (cost > this.budget) return fail('Не хватает денег', cost, plan);
    return { ok: true, cost, fp: dock, industryId: ind.id, driveway: plan, nodePos: gate, demolish };
  }

  /**
   * Что стоит на площадке (с запасом margin): дома идут под снос, а ратуша,
   * предприятие или станция мешают — тогда blocker с причиной.
   */
  private structuresUnder(fp: Footprint, margin: number, skip?: Structure): { houses: number[]; blocker?: string } {
    const houses: number[] = [];
    for (const s of this.index.near(fp.center, footprintRadius(fp) + margin + 120)) {
      if (s === skip || !footprintsOverlap(fp, s.fp, margin)) continue;
      if (s.type === 'building' && s.kind !== 'landmark') houses.push(s.id);
      else return { houses, blocker: s.type === 'building' ? 'Мешает ратуша' : s.type === 'industry' ? 'Мешает предприятие' : 'Мешает станция' };
    }
    return { houses };
  }

  /** Сколько стоит снести эти дома. */
  private demolishTotal(ids: number[]): number {
    return ids.reduce((sum, id) => sum + this.demolishCost(id), 0);
  }

  /**
   * Дорога или путь, задевающие площадку (с запасом pad), — проверяем по сетке точек внутри неё;
   * ответ — чем мешает. Полотна узла skipNode (выезд самой станции) не в счёт.
   */
  private roadUnder(fp: Footprint, pad: number, skipNode = -1): string | null {
    const u = { x: Math.cos(fp.angle), y: Math.sin(fp.angle) };
    const v = { x: -u.y, y: u.x };
    const nx = Math.max(2, Math.ceil(fp.w / 6));
    const ny = Math.max(2, Math.ceil(fp.h / 6));
    const probes: Vec[] = [];
    for (let i = 0; i <= nx; i++) {
      for (let j = 0; j <= ny; j++) probes.push(add(fp.center, add(scale(u, (i / nx - 0.5) * fp.w), scale(v, (j / ny - 0.5) * fp.h))));
    }
    for (const s of this.net.segmentsNear(fp.center, footprintRadius(fp) + pad + 10)) {
      const reach = halfWidth(s.spec) + pad;
      if (probes.some((q) => s.lut.closest(q).d < reach)) return 'Мешает путь';
    }
    for (const c of this.roads.net.corridorsNear(fp.center, footprintRadius(fp) + pad + 40)) {
      if (c.a === skipNode || c.b === skipNode) continue;
      if (
        probes.some((q) => {
          const hit = c.lut.closest(q);
          return hit.d < halfAtS(c, hit.s) + pad;
        })
      )
        return 'Мешает дорога';
    }
    return null;
  }

  private worldContext(): WorldContext {
    return { roads: this.roads.net, terrain: this.terrain, index: this.index, rng: this.rng, nextId: () => this.nextEntityId++, rail: this.net };
  }

  // ---------- BuildContext ----------

  get budget(): number {
    return this.money - ECONOMY.creditLimit;
  }

  isWater(p: Vec, margin = 0): boolean {
    return this.terrain.isWater(p, margin);
  }

  inBounds(p: Vec, margin = 0): boolean {
    return this.terrain.inBounds(p, margin);
  }

  blocked(p: Vec, radius: number): boolean {
    return this.index.at(p, radius) !== null;
  }

  obstaclesAt(p: Vec, radius: number): { id: number; demolishable: boolean; gate?: number }[] {
    return this.index
      .near(p, radius + 60)
      .filter((s) => pointInFootprint(p, s.fp, radius))
      .map((s) => ({
        id: s.id,
        demolishable: s.type === 'building' && s.kind !== 'landmark',
        // Автостанция стоит в торце своего выезда: дороге, что входит в её узел, она не мешает.
        gate: s.type === 'station' && s.kind === 'road' ? s.nodeId : undefined,
      }));
  }

  buildingById(id: number): TownBuilding | undefined {
    for (const t of this.towns) for (const b of t.buildings) if (b.id === id) return b;
    return undefined;
  }

  demolishCost(id: number): number {
    const b = this.buildingById(id);
    if (!b) return 0;
    return b.kind === 'com' ? 2000 + b.floors * 1200 : 1200 + b.floors * 900;
  }

  /** Сносит дома (без оплаты — её учитывает тот, кто вызывает). */
  demolish(ids: number[]): void {
    const touched = new Set<Town>();
    for (const id of ids) {
      const b = this.buildingById(id);
      const town = b && this.townOf(b);
      if (!b || !town || b.kind === 'landmark') continue;
      this.index.remove(b);
      town.buildings = town.buildings.filter((x) => x !== b);
      touched.add(town);
      this.refreshCatchmentsNear(b.fp.center);
    }
    for (const t of touched) recountPopulation(t);
  }

  /** Снос одного здания игроком. */
  demolishBuilding(b: TownBuilding): boolean {
    if (b.kind === 'landmark') {
      this.notify('Ратушу снести нельзя, но её можно перенести');
      return false;
    }
    const cost = this.demolishCost(b.id);
    if (cost > this.budget) {
      this.notify('Не хватает денег');
      return false;
    }
    this.demolish([b.id]);
    this.spend(cost);
    return true;
  }

  /**
   * Что снесёт рамка от a до b: участки дорог и путей (больше половины длины внутри),
   * дома и станции (центр внутри). Ратуша, грузовые дворы предприятий и станции с линиями не сносятся.
   */
  areaContents(a: Vec, b: Vec): AreaContents {
    const x0 = Math.min(a.x, b.x);
    const x1 = Math.max(a.x, b.x);
    const y0 = Math.min(a.y, b.y);
    const y1 = Math.max(a.y, b.y);
    const inside = (p: Vec) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
    const segs: number[] = [];
    let refund = 0;
    for (const s of this.net.segmentsInBox(x0, y0, x1, y1)) {
      if (s.platform !== undefined) continue;
      const pts = s.lut.points;
      if (pts.filter(inside).length * 2 < pts.length) continue;
      segs.push(s.id);
      refund += this.builder.segmentCost(s) * COST.refundRatio;
    }
    // Дороги, задетые рамкой: снесётся часть внутри (возврат — за неё).
    const corridors: number[] = [];
    for (const c of this.roads.net.corridorsInBox(x0, y0, x1, y1)) {
      const runs = insideRuns(c, inside);
      if (!runs.length) continue;
      corridors.push(c.id);
      const share = runs.reduce((s, [p, q]) => s + q - p, 0) / c.length;
      refund += corridorCost(this.roads.net, c, (q, m) => this.isWater(q, m)) * share * COST.refundRatio;
    }
    const buildings: TownBuilding[] = [];
    let cost = 0;
    for (const t of this.towns) {
      for (const bld of t.buildings) {
        if (bld.kind === 'landmark' || !inside(bld.fp.center)) continue;
        buildings.push(bld);
        cost += this.demolishCost(bld.id);
      }
    }
    const stations = [...this.stations.values()].filter((st) => st.industryId === null && inside(st.fp.center) && !this.stationLines(st.id).length);
    return { segs, corridors, buildings, stations, refund: Math.round(refund), cost: Math.round(cost) };
  }

  /** Сносит всё в рамке разом (одним шагом для Ctrl+Z). */
  bulldozeArea(a: Vec, b: Vec): boolean {
    const c = this.areaContents(a, b);
    if (!c.segs.length && !c.corridors.length && !c.buildings.length && !c.stations.length) return false;
    if (c.cost > this.budget + c.refund) {
      this.notify('Не хватает денег на снос');
      return false;
    }
    this.checkpoint('снос области');
    for (const st of c.stations) this.removeStation(st);
    if (c.buildings.length) {
      this.demolish(c.buildings.map((x) => x.id));
      this.spend(c.cost);
    }
    this.builder.bulldozeSegments(c.segs);
    if (c.corridors.length) {
      const [x0, x1] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
      const [y0, y1] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
      // Снести можно всегда: оборванные полосы у новых тупиков — не повод отказать.
      const plan = this.roadBuilder.bulldozeBox(x0, y0, x1, y1);
      if (plan.net) this.roadBuilder.apply({ ...plan, ok: true });
    }
    this.commit();
    return true;
  }

  /** Улица, у которой можно поставить дом: не магистраль, не кольцо, на земле; r — от края полотна. */
  private streetNear(p: Vec, r: number): { seg: Corridor; s: number } | null {
    const net = this.roads.net;
    return this.roadNear(p, r, (c) => !c.ring && !isTrunk(c.cls) && net.node(c.a).level === 0 && net.node(c.b).level === 0);
  }

  /**
   * Ближайшее полотно (из подходящих под ok), до края которого от p не дальше r: у широкой дороги
   * (проспект, магистраль) край дальше от оси — мерить от оси значит не дотянуться до неё вовсе.
   */
  private roadNear(p: Vec, r: number, ok: (c: Corridor) => boolean): { seg: Corridor; s: number } | null {
    let best: { seg: Corridor; s: number; d: number } | null = null;
    for (const c of this.roads.net.corridorsNear(p, r + 40)) {
      if (!ok(c)) continue;
      const hit = c.lut.closest(p);
      const gap = hit.d - halfAtS(c, hit.s);
      if (gap < r && (!best || gap < best.d)) best = { seg: c, s: hit.s, d: gap };
    }
    return best;
  }

  /** Куда встанет здание при переносе: вдоль ближайшей улицы. */
  movePlan(b: TownBuilding, p: Vec): { ok: boolean; reason?: string; fp: Footprint | null; cost: number; anchor: number } {
    const cost = Math.round(this.demolishCost(b.id) * 0.6) || 3000;
    const hit = this.streetNear(p, 60);
    if (!hit) return { ok: false, reason: 'Поставьте рядом с улицей', fp: null, cost, anchor: 0 };
    const seg = hit.seg;
    const n = normalTowards(seg, hit.s, p);
    const t = seg.lut.tangentAt(hit.s);
    const center = add(seg.lut.pointAt(hit.s), scale(n, halfAtS(seg, hit.s) + 5 + b.fp.h / 2));
    const fp: Footprint = { center, w: b.fp.w, h: b.fp.h, angle: Math.atan2(t.y, t.x) };
    const anchor = anchorFor(this.roads.net, center);
    this.index.remove(b);
    const ok = placeable(this.worldContext(), fp, seg.id);
    this.index.add(b);
    if (!ok) return { ok: false, reason: 'Здесь мало места', fp, cost, anchor };
    if (cost > this.budget) return { ok: false, reason: 'Не хватает денег', fp, cost, anchor };
    return { ok: true, fp, cost, anchor };
  }

  moveBuilding(b: TownBuilding, p: Vec): boolean {
    const plan = this.movePlan(b, p);
    if (!plan.ok || !plan.fp) return false;
    const from = b.fp.center;
    this.index.remove(b);
    b.fp = plan.fp;
    b.anchor = plan.anchor;
    this.index.add(b);
    this.spend(plan.cost);
    this.refreshCatchmentsNear(from);
    this.refreshCatchmentsNear(b.fp.center);
    return true;
  }

  private refreshCatchmentsNear(p: Vec): void {
    for (const st of this.stations.values()) {
      if (dist(st.fp.center, p) < this.catchmentRadius(st) + 60) this.computeCatchment(st);
    }
  }

  /** Расход: стройка (по умолчанию) или покупка транспорта — для отчёта о финансах. */
  spend(amount: number, kind: 'build' | 'purchases' = 'build'): void {
    const a = Math.round(amount);
    this.money -= a;
    this.expensesMonth += a;
    this.ledger[kind] += a;
  }

  /** Возврат части денег за снесённое. */
  refund(amount: number): void {
    const a = Math.round(amount * COST.refundRatio);
    this.money += a;
    this.incomeMonth += a;
    this.ledger.sales += a;
  }

  /**
   * Дорогу расширили: дома, на которые она теперь налезает, отодвигаются от неё
   * по перпендикуляру. Если сзади стоит другой дом — фасад отступает (дом становится
   * мельче в глубину). Совсем нет места — дом сносится (за счёт города, игроку бесплатно).
   */
  roadWidened(segId: number): void {
    const seg = this.roads.net.corridors.get(segId);
    if (!seg) return;
    const edge = corridorHalf(seg) + 3;
    const ctx = this.worldContext();
    const razed: number[] = [];
    let moved = 0;
    for (const s of this.index.near(seg.lut.pointAt(seg.length / 2), seg.length / 2 + 80)) {
      if (s.type !== 'building' || s.kind === 'landmark') continue;
      const corners = footprintCorners(s.fp);
      const nearest = Math.min(...corners.map((c) => seg.lut.closest(c).d));
      if (nearest >= edge) continue;
      const hit = seg.lut.closest(s.fp.center);
      if (hit.s <= 1 || hit.s >= seg.length - 1) continue;
      const away = sub(s.fp.center, hit.point);
      const len = Math.hypot(away.x, away.y) || 1;
      const dir = scale(away, 1 / len);
      const need = edge - nearest + 2;
      const fp = { ...s.fp, center: add(s.fp.center, scale(dir, need)) };
      // Глубина дома — его сторона, что смотрит на дорогу.
      const alongH = Math.abs(dot(dir, { x: -Math.sin(s.fp.angle), y: Math.cos(s.fp.angle) })) >= Math.abs(dot(dir, { x: Math.cos(s.fp.angle), y: Math.sin(s.fp.angle) }));
      const depth = alongH ? s.fp.h : s.fp.w;
      this.index.remove(s);
      if (placeable(ctx, fp, segId)) {
        s.fp = fp;
        moved++;
      } else if (depth - need >= 12) {
        const center = add(s.fp.center, scale(dir, need / 2));
        s.fp = alongH ? { ...s.fp, center, h: depth - need } : { ...s.fp, center, w: depth - need };
        moved++;
      } else razed.push(s.id);
      this.index.add(s);
    }
    if (razed.length) this.demolish(razed);
    if (moved + razed.length) this.refreshCatchmentsNear(seg.lut.pointAt(seg.length / 2));
  }

  /**
   * Узел считается частью кольца, пока к нему примыкает хоть один участок кольца;
   * центр кольца живёт, пока жив хоть один такой узел. Иначе после сноса кольца
   * остаются невидимые правила приоритета и остров посреди дороги.
   */
  private pruneRoundabouts(): void {
    // Живое кольцо и одна из его дуг: по ней центр проверяется (и чинится, если записан не тот).
    const alive = new Map<number, Corridor>();
    const roads = this.roads.net;
    for (const n of roads.nodes.values()) {
      if (n.roundabout === null || n.roundabout === undefined) continue;
      const arc = n.corridors.map((id) => roads.corridors.get(id)).find((c) => c?.ring);
      if (arc) alive.set(n.roundabout, arc);
      else n.roundabout = null;
    }
    for (const id of [...this.roundaboutCenters.keys()]) if (!alive.has(id)) this.roundaboutCenters.delete(id);
    for (const [id, arc] of alive) {
      const center = circleCenter(arc.lut.pointAt(0), arc.lut.pointAt(arc.length / 2), arc.lut.pointAt(arc.length));
      const was = this.roundaboutCenters.get(id);
      if (center && (!was || dist(was, center) > 2)) this.roundaboutCenters.set(id, center);
    }
  }

  /** Сеть дорог или путей изменилась: графы движения заново, машины и поезда — на новые пути. */
  networkChanged(): void {
    this.pruneRoundabouts();
    this.roads.changed();
    this.net.rebuild();
    const splits = [...this.net.pendingSplits];
    this.net.pendingSplits = [];
    this.rail.validate(splits);
    this.refreshCrossings();
  }

  /** Переезды заново (дороги или пути поменялись): машины ждут у закрытых, поезда их закрывают. */
  private refreshCrossings(): void {
    this.levelCrossings = findCrossings(this.roads.net, this.net);
    const byCorridor = new Map<number, LevelCrossing[]>();
    const byRail = new Map<number, LevelCrossing[]>();
    for (const x of this.levelCrossings) {
      byCorridor.set(x.corridor, [...(byCorridor.get(x.corridor) ?? []), x]);
      byRail.set(x.rail, [...(byRail.get(x.rail) ?? []), x]);
    }
    this.traffic.barriers = byCorridor;
    this.rail.crossings = byRail;
  }

  /**
   * Что не так у нового пути с дорогами: те же правила переезда, что и у дороги через путь.
   * net — с какими дорогами сверять (вставка — с теми, что станут), skip — какие не в счёт (свои дороги вставки).
   */
  roadConflict(lut: CurveLUT, levelAt: (s: number) => number, hw: number, net: LaneNet = this.roads.net, skip?: Set<number>): string | undefined {
    const xs = lut.points.map((p) => p.x);
    const ys = lut.points.map((p) => p.y);
    const pad = 40;
    const flat = Math.abs(levelAt(0) - levelAt(lut.length)) < 0.01;
    for (const c of net.corridorsInBox(Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad)) {
      if (skip?.has(c.id)) continue;
      const hits = intersectCurves(lut, c.lut);
      for (const h of hits) {
        const dh = Math.abs(levelAt(h.s1) - net.heightAt(c, h.s2));
        if (dh >= 0.75) continue;
        if (dh >= 0.3) return 'Мало места по высоте';
        if (!flat || !net.isFlat(c)) return 'Переезд на подъёме';
        if (Math.abs(cross(lut.tangentAt(h.s1), c.lut.tangentAt(h.s2))) < 0.5) return 'Переезд только под углом от 30°';
        if (h.s2 < 15 || c.length - h.s2 < 15) return 'Переезд слишком близко к перекрёстку';
        if (h.s1 < 20 || lut.length - h.s1 < 20) return 'Переезд слишком близко к стрелке';
      }
      if (hits.length) continue;
      const half = corridorHalf(c);
      for (let s = 0; s <= lut.length; s += 8) {
        const near = c.lut.closest(lut.pointAt(s));
        if (near.d < half + hw + 2 && Math.abs(levelAt(s) - net.heightAt(c, near.s)) < 0.75) return 'Слишком близко к дороге';
      }
    }
    return undefined;
  }

  /**
   * Что не так у полотна с путями. Пересечь путь можно мостом, тоннелем или переездом — на земле,
   * под углом от 30°, не у стрелок и не на платформе; вдоль путей — не вплотную. rails — с какими путями
   * сверять (вставка — с теми, что останутся после сноса под рамкой).
   */
  railConflict(net: LaneNet, c: Corridor, rails: Network = this.net): string | undefined {
    const xs = c.lut.points.map((p) => p.x);
    const ys = c.lut.points.map((p) => p.y);
    const pad = 40;
    for (const seg of rails.segmentsInBox(Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad)) {
      if (!isRail(seg.spec)) continue;
      const hits = intersectCurves(c.lut, seg.lut);
      for (const h of hits) {
        const dh = Math.abs(net.heightAt(c, h.s1) - rails.levelAt(seg, h.s2));
        if (dh >= 0.75) continue;
        if (dh >= 0.3) return 'Мало места по высоте';
        if (seg.platform !== undefined) return 'Нельзя пересекать платформу';
        if (!net.isFlat(c) || !rails.isFlat(seg)) return 'Переезд на подъёме';
        if (Math.abs(cross(c.lut.tangentAt(h.s1), seg.lut.tangentAt(h.s2))) < 0.5) return 'Переезд только под углом от 30°';
        if (h.s2 < 20 || seg.length - h.s2 < 20) return 'Переезд слишком близко к стрелке';
        if (h.s1 < 15 || c.length - h.s1 < 15) return 'Переезд слишком близко к перекрёстку';
      }
      if (hits.length) continue;
      // Вдоль путей на той же высоте — не вплотную.
      const half = corridorHalf(c);
      for (let s = 0; s <= c.length; s += 8) {
        const p = c.lut.pointAt(s);
        const near = seg.lut.closest(p);
        if (near.d < half + RAIL_HALF + 2 && Math.abs(net.heightAt(c, s) - rails.levelAt(seg, near.s)) < 0.75) return 'Слишком близко к путям';
      }
    }
    return undefined;
  }

  // ---------- Шаблоны развязок ----------

  diamondPlan(p: Vec, radius: number): TemplatePlan {
    return diamondPlan(this.roads.net, this.roadBuilder, p, radius, this.budget);
  }

  /** Развязка по шаблону: на магистрали под курсором или в чистом поле вместе с магистралью. */
  templatePlan(p: Vec, radius: number, opts: TemplateOptions): TemplatePlan {
    return templatePlan(this.roads.net, this.roadBuilder, p, radius, this.budget, opts);
  }

  /** Строит развязку целиком — одной правкой сети и одним шагом для Ctrl+Z. null — построилась. */
  buildTemplate(plan: TemplatePlan, label: string): string | null {
    if (!plan.ok || !plan.plan) return plan.reason ?? 'Нельзя построить';
    this.checkpoint(label);
    const ok = this.roadBuilder.apply(plan.plan);
    this.commit();
    return ok ? null : 'Не удалось построить развязку';
  }

  // ---------- Копирование и вставка ----------

  /** Копия дорог и ж/д путей в рамке между углами a и b; null — копировать нечего. */
  copyArea(a: Vec, b: Vec): Fragment | null {
    const [x0, y0, x1, y1] = [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)];
    const roads = copyBox(this.roads.net, x0, y0, x1, y1);
    const rail = copyRails(this.net, x0, y0, x1, y1);
    if (!rail) return roads;
    return { ...(roads ?? { nodes: [], corridors: [], half: { x: (x1 - x0) / 2, y: (y1 - y0) / 2 } }), rail };
  }

  /**
   * Вставка куска (центр — в at, поворот angle): дороги под рамкой заменяются его дорогами, пути — его путями
   * (если они в нём есть); станцию под рамкой не трогаем — мешает. Дороги проверяет строитель дорог, пути —
   * строитель путей (каждый участок, с ценой); дороги и пути самого куска друг с другом не сверяются — так задумано.
   */
  pastePlan(frag: Fragment, at: Vec, angle: number): PastePlan {
    const hasRail = !!frag.rail?.segs.length;
    // Пути — на копии сети: сперва снос под рамкой; с тем, что осталось, сверяются дороги куска.
    const rails = hasRail ? cloneNetwork(this.net) : this.net;
    const railPaste = hasRail ? new RailPaste(rails, frag, at, angle) : null;
    const pricing = new Builder(this.pasteContext(rails, this.roads.net));
    const cleared = railPaste?.clear((s) => pricing.segmentCost(s)) ?? { refund: 0 };
    const fail = (reason: string, road: RoadPlan | null, plans: Plan[] = []): PastePlan => ({
      ok: false,
      reason,
      cost: 0,
      spend: 0,
      refund: 0,
      demolish: road?.demolish ?? [],
      net: road?.net ?? null,
      changed: road?.changed ?? [],
      road,
      rails: plans,
      railSpend: 0,
      railRefund: 0,
    });
    if (cleared.reason) return fail(cleared.reason, null);

    let mine = new Set<number>();
    let road: RoadPlan | null = null;
    if (frag.corridors.length) {
      road = this.roadPlanner(rails).plan(
        (n) => {
          mine = pasteFragment(n, frag, at, angle);
        },
        { trusted: true, only: (c) => mine.has(c.id) },
      );
      const next = road.net;
      if (road.ok && next) {
        const lost = [...this.stations.values()].some((st) => st.kind !== 'rail' && this.roads.net.nodes.has(st.nodeId) && !next.nodes.has(st.nodeId));
        if (lost) return fail('Мешает станция', road);
      }
      if (!road.ok) return fail(road.reason ?? 'Нельзя вставить', road);
    }

    // Пути куска — участок за участком против сети после сноса; дороги — какими станут (свои дороги куска не в счёт).
    const razed = new Set(road?.demolish ?? []);
    const plans: Plan[] = [];
    let railSpend = 0;
    if (railPaste) {
      const builder = new Builder(this.pasteContext(rails, road?.net ?? this.roads.net, mine));
      for (const { req } of railPaste.requests()) {
        const p = builder.plan(req);
        plans.push(p);
        if (!p.ok) return fail(p.reason ?? 'Нельзя построить путь', road, plans);
        if (p.crossings.length) return fail('Мешает путь', road, plans);
        railSpend += p.cost;
        // Дом под дорогой и путём (или под двумя участками) сносится и оплачивается раз.
        for (const id of p.demolish) {
          if (razed.has(id)) railSpend -= this.demolishCost(id);
          razed.add(id);
        }
      }
      railSpend += railPaste.signals * COST.signal;
    }
    const railRefund = cleared.refund;
    const cost = (road?.cost ?? 0) + railSpend - Math.round(railRefund * COST.refundRatio);
    const reason = cost > this.budget ? 'Не хватает денег' : undefined;
    return {
      ok: !reason,
      reason,
      cost,
      spend: (road?.spend ?? 0) + railSpend,
      refund: (road?.refund ?? 0) + railRefund,
      demolish: [...razed],
      net: road?.net ?? null,
      changed: road?.changed ?? [],
      road,
      rails: plans,
      railSpend,
      railRefund,
    };
  }

  /** Вставляет кусок одним шагом для Ctrl+Z. null — вставился. */
  paste(frag: Fragment, at: Vec, angle: number): string | null {
    const plan = this.pastePlan(frag, at, angle);
    if (!plan.ok) return plan.reason ?? 'Нельзя вставить';
    this.checkpoint('вставка');
    let ok = !plan.road || this.roadBuilder.apply(plan.road);
    if (ok && frag.rail?.segs.length) {
      // Те же шаги, что в плане на копии сети, — на настоящей: те же номера узлов и участков.
      const rail = new RailPaste(this.net, frag, at, angle);
      ok = !rail.clear(() => 0).reason;
      if (ok) {
        rail.lay();
        const own = new Set(plan.road?.demolish ?? []);
        const razed = plan.demolish.filter((id) => !own.has(id));
        if (razed.length) this.demolish(razed);
        this.spend(plan.railSpend);
        if (plan.railRefund) this.refund(plan.railRefund);
      }
      this.networkChanged();
    }
    this.commit();
    return ok ? null : 'Не удалось вставить';
  }

  /** Строитель путей для проверки вставки: пути — копия сети, дороги — какими станут (skip — свои дороги куска). */
  private pasteContext(rails: Network, roads: LaneNet, skip?: Set<number>): BuildContext {
    return {
      net: rails,
      budget: this.budget,
      isWater: (p, m) => this.isWater(p, m),
      inBounds: (p, m) => this.inBounds(p, m),
      obstaclesAt: (p, r) => this.obstaclesAt(p, r),
      demolishCost: (id) => this.demolishCost(id),
      demolish: () => {},
      spend: () => {},
      refund: () => {},
      networkChanged: () => {},
      roadConflict: (lut, levelAt, hw) => this.roadConflict(lut, levelAt, hw, roads, skip),
    };
  }

  /** Строитель дорог, сверяющий дороги с путями rails (вставка — с оставшимися после сноса под рамкой). */
  private roadPlanner(rails: Network): RoadBuilder {
    if (rails === this.net) return this.roadBuilder;
    return new RoadBuilder({
      roads: this.roads,
      budget: this.budget,
      isWater: (p, m) => this.isWater(p, m),
      inBounds: (p, m) => this.inBounds(p, m),
      obstaclesAt: (p, r) => this.obstaclesAt(p, r),
      demolishCost: (id) => this.demolishCost(id),
      demolish: () => {},
      spend: () => {},
      refund: () => {},
      networkChanged: () => {},
      railConflict: (n, c) => this.railConflict(n, c, rails),
    });
  }

  // ---------- Пути рядом ----------

  /**
   * Пристроить путь: вдоль цепочки путей (через узлы без стрелок) от точки a до точки b — новый путь
   * рядом, на расстоянии TRACK_GAP, с той стороны, где курсор b. Куски — сдвинутые копии участков.
   */
  parallelTrackPlan(a: Vec, b: Vec, radius: number): { ok: boolean; reason?: string; cost: number; reqs: RoadRequest[] } {
    const net = this.net;
    const fail = (reason: string, cost = 0, reqs: RoadRequest[] = []) => ({ ok: false, reason, cost, reqs });
    const onTrack = (s: Segment) => isRail(s.spec) && s.platform === undefined;
    const hit = net.findSegmentNear(a, Math.max(30, radius), onTrack);
    if (!hit) return fail('Зажмите на пути и протяните вдоль него');
    // Цепочка участков по порядку: от участка под курсором в обе стороны, пока узел — не стрелка.
    const chain: { seg: Segment; forward: boolean }[] = [{ seg: hit.seg, forward: true }];
    const walk = (from: number, ahead: boolean) => {
      let node = from;
      for (let guard = 0; guard < 60; guard++) {
        const segs = net.railSegs(net.node(node)).filter((id) => onTrack(net.segment(id)));
        if (segs.length !== 2) return;
        const known = ahead ? chain[chain.length - 1].seg.id : chain[0].seg.id;
        const next = net.segment(segs.find((id) => id !== known)!);
        if (chain.some((x) => x.seg.id === next.id)) return;
        if (ahead) {
          chain.push({ seg: next, forward: next.a === node });
          node = next.a === node ? next.b : next.a;
        } else {
          chain.unshift({ seg: next, forward: next.b === node });
          node = next.b === node ? next.a : next.b;
        }
      }
    };
    walk(hit.seg.b, true);
    walk(hit.seg.a, false);
    if (chain.some((x) => !net.isFlat(x.seg) || net.node(x.seg.a).level !== 0)) return fail('Пристроить путь — только на земле');
    // Координата вдоль цепочки: u у начала каждого участка.
    const starts: number[] = [];
    let u = 0;
    for (const x of chain) {
      starts.push(u);
      u += x.seg.length;
    }
    const along = (i: number, s: number) => starts[i] + (chain[i].forward ? s : chain[i].seg.length - s);
    const uA = along(chain.findIndex((x) => x.seg.id === hit.seg.id), hit.s);
    let best = { i: 0, s: 0, d: Infinity, point: b };
    chain.forEach((x, i) => {
      const h = x.seg.lut.closest(b);
      if (h.d < best.d) best = { i, s: h.s, d: h.d, point: h.point };
    });
    const uB = along(best.i, best.s);
    if (Math.abs(uB - uA) < 30) return fail('Протяните вдоль пути');
    // Сторона — где курсор при отпускании, относительно хода цепочки.
    const segB = chain[best.i];
    const tB = scale(segB.seg.lut.tangentAt(best.s), segB.forward ? 1 : -1);
    const side = dot(sub(b, best.point), { x: -tB.y, y: tB.x }) >= 0 ? 1 : -1;
    const [u0, u1] = uA < uB ? [uA, uB] : [uB, uA];
    const reqs: RoadRequest[] = [];
    chain.forEach((x, i) => {
      const lo = Math.max(u0, starts[i]);
      const hi = Math.min(u1, starts[i] + x.seg.length);
      if (hi - lo < 1) return;
      // Кусок участка между lo и hi, по ходу цепочки, и его копия сбоку.
      const sOf = (uu: number) => (x.forward ? uu - starts[i] : x.seg.length - (uu - starts[i]));
      const [ta, tb] = [x.seg.lut.tAt(sOf(lo)), x.seg.lut.tAt(sOf(hi))];
      let piece = x.seg.curve;
      const t0 = Math.min(ta, tb);
      const t1 = Math.max(ta, tb);
      if (t1 < 1) piece = splitBezier(piece, t1)[0];
      if (t0 > 0) piece = splitBezier(piece, t0 / t1)[1];
      if (!x.forward) piece = reverseCubic(piece);
      const curve = offsetCubic(piece, side * TRACK_GAP);
      reqs.push({ start: { kind: 'free', pos: curve.p0, level: 0 }, end: { kind: 'free', pos: curve.p3, level: 0 }, spec: RAIL_SPEC, mode: 'straight', curve });
    });
    // Каждый кусок — против нынешней сети; соседние куски стыкуются концами.
    let cost = 0;
    for (const req of reqs) {
      const plan = this.builder.plan(req);
      cost += plan.cost;
      if (!plan.ok) return fail(plan.reason ?? 'Нельзя построить', cost, reqs);
    }
    if (cost > this.budget) return fail('Не хватает денег', cost, reqs);
    return { ok: true, cost, reqs };
  }

  /** Строит путь рядом; null — построен, иначе причина. Не встал кусок — всё построенное откатывается. */
  buildParallelTrack(a: Vec, b: Vec, radius: number): string | null {
    const plan = this.parallelTrackPlan(a, b, radius);
    if (!plan.ok) return plan.reason ?? 'Нельзя построить';
    this.checkpoint('путь рядом');
    let prev: number | null = null;
    for (const req of plan.reqs) {
      const start: Snap = prev === null ? req.start : { kind: 'node', nodeId: prev, pos: this.net.node(prev).pos, level: 0 };
      const res = this.builder.build({ ...req, start, curve: req.curve && { ...req.curve, p0: start.pos } });
      if (!res) {
        this.commit();
        this.undo();
        return 'Не удалось построить путь';
      }
      prev = res.endNode;
    }
    this.commit();
    return null;
  }

  // ---------- Ж/д сигналы ----------

  /**
   * Где встанет сигнал: ближайший путь под курсором, направление — то, при котором
   * курсор справа по ходу поезда (сигналы стоят справа). Повторно по тому же месту — снять.
   */
  signalPlan(p: Vec, radius: number): SignalPlan {
    const hit = this.net.findSegmentNear(p, Math.max(30, radius), (s) => isRail(s.spec) && s.platform === undefined);
    if (!hit) return { ok: false, reason: 'Кликните рядом с ж/д путём' };
    const seg = hit.seg;
    const t = seg.lut.tangentAt(hit.s);
    const right = { x: -t.y, y: t.x };
    const along = dot(sub(p, hit.point), right) >= 0;
    const d = along ? t : scale(t, -1);
    // У самого узла — сигнал в узле, иначе путь разрезается в точке клика.
    const near = hit.s < 14 ? seg.a : seg.length - hit.s < 14 ? seg.b : null;
    if (near !== null) {
      const out = this.net
        .railSegs(this.net.node(near))
        .map((id) => ({ id, k: dot(this.net.dirFrom(near, id), d) }))
        .sort((x, y) => y.k - x.k)[0];
      if (!out || out.k < 0.5) return { ok: false, reason: 'Здесь некуда ставить сигнал' };
      const node = this.net.node(near);
      const remove = !!node.signals?.includes(out.id);
      return { ok: true, pos: node.pos, dir: d, nodeId: near, outSeg: out.id, remove, cost: remove ? 0 : COST.signal };
    }
    if (seg.length < 2 * MIN_SEGMENT_LEN) return { ok: false, reason: 'Слишком короткий участок' };
    return { ok: true, pos: hit.point, dir: d, segId: seg.id, t: hit.t, forward: along, remove: false, cost: COST.signal };
  }

  /** Ставит или снимает сигнал по плану signalPlan. */
  toggleSignal(p: Vec, radius: number): boolean {
    const plan = this.signalPlan(p, radius);
    if (!plan.ok) return false;
    if (!plan.remove && plan.cost! > this.budget) return false;
    let nodeId = plan.nodeId;
    let out = plan.outSeg;
    if (nodeId === undefined) {
      const res = this.net.splitSegmentDetailed(plan.segId!, plan.t!);
      nodeId = res.node.id;
      // Сигнал смотрит туда, куда едет поезд: вперёд по участку — на вторую половину.
      out = plan.forward ? res.second.id : res.first.id;
    }
    const node = this.net.node(nodeId);
    const list = node.signals ?? [];
    node.signals = plan.remove ? list.filter((s) => s !== out) : [...list, out!];
    if (!plan.remove) this.spend(plan.cost!);
    this.net.touch(nodeId);
    this.networkChanged();
    return true;
  }

  // ---------- Кредит ----------

  /** Берёт кредит шагом loanStep, пока не достигнут предел. Деньги — не доход: в отчёте отдельно. */
  takeLoan(): boolean {
    const E = ECONOMY;
    const amount = Math.min(E.loanStep, E.loanMax - this.loan);
    if (amount <= 0) return false;
    this.loan += amount;
    this.money += amount;
    return true;
  }

  /** Гасит кредит шагом loanStep (или остаток), если хватает денег. */
  repayLoan(): boolean {
    const amount = Math.min(ECONOMY.loanStep, this.loan);
    if (amount <= 0 || this.money < amount) return false;
    this.loan -= amount;
    this.money -= amount;
    return true;
  }

  // ---------- Настройка перекрёстка ----------

  /**
   * Меняет главную дорогу, запреты поворотов или режим светофора на перекрёстке.
   * Новый запрет поворота снимает связи полос в ту сторону.
   */
  setJunction(nodeId: number, patch: Partial<Pick<LaneNode, 'mainPair' | 'bans' | 'greens' | 'adaptive'>>): void {
    const n = this.roads.net.nodes.get(nodeId);
    if (!n) return;
    Object.assign(n, patch);
    if (patch.bans && n.lanes) {
      n.lanes = n.lanes.filter((k) => {
        const l = parseLaneKey(k);
        return !l || !patch.bans!.includes(`${l.from}>${l.to}`);
      });
      if (!n.lanes.length) delete n.lanes;
    }
    this.roads.net.version++;
    this.networkChanged();
  }

  /**
   * Кольцо на месте перекрёстка у курсора: радиус по выбранному размеру (но чтобы влезли примыкающие дороги
   * и полосы кольца), проверки места и цена — как у любой стройки дорог.
   */
  roundaboutPlan(
    p: Vec,
    radius: number,
    opts: RingOptions,
  ): { ok: boolean; reason?: string; cost: number; r: number; center?: Vec; ringId?: number; plan?: RoadPlan } {
    const net = this.roads.net;
    const n = net
      .nodesNear(p, radius + 20)
      .filter((x) => x.kind === 'junction')
      .sort((x, y) => dist(x.pos, p) - dist(y.pos, p))[0];
    if (!n) return { ok: false, reason: 'Выберите перекрёсток', cost: 0, r: RING_SIZES[opts.size] };
    const ends = net.ends(n);
    const ringHalf = (opts.lanes * LANE_W) / 2 + 2;
    const R = Math.max(RING_SIZES[opts.size], Math.max(...ends.map((e) => corridorHalf(e.corridor))) * 2 + 14, ringHalf + 14);
    const res = { cost: 0, r: R, center: n.pos };
    const fail = (reason: string) => ({ ok: false, reason, ...res });
    if ((n.roundabout ?? null) !== null) return fail('Уже кольцо');
    if (n.level !== 0) return fail('Кольцо только на земле');
    if (ends.length < 2) return fail('Нужен перекрёсток');
    if ([...this.stations.values()].some((st) => st.nodeId === n.id)) return fail('Это выезд станции');
    for (const e of ends) if (e.corridor.ring || !net.isFlat(e.corridor)) return fail('Рядом пандус');
    const angles = ends.map((e) => angleOf(e.away)).sort((a, b) => a - b);
    for (let i = 0; i < angles.length; i++) {
      const next = i + 1 < angles.length ? angles[i + 1] : angles[0] + Math.PI * 2;
      if (next - angles[i] < 0.6) return fail('Дороги сходятся слишком остро');
    }
    if (net.nodesNear(n.pos, R + 8).some((o) => o.id !== n.id && Math.abs(o.level - n.level) < 1)) return fail('Мало места');
    for (let i = 0; i < 36; i++) {
      const a = (i / 36) * Math.PI * 2;
      if (this.isWater(add(n.pos, { x: Math.cos(a) * R, y: Math.sin(a) * R }), ringHalf)) return fail('Мешает вода');
    }
    const id = n.id;
    const plan = this.roadBuilder.plan((x) => buildRing(x, id, R, opts.lanes));
    // Кольцо — стройка: платим за него сверх разницы в стоимости дорог.
    const cost = plan.cost + roundaboutFee(R, opts.lanes);
    if (plan.ok && cost > this.budget) return { ok: false, reason: 'Не хватает денег', cost, r: R, center: n.pos, ringId: id, plan };
    return { ok: plan.ok, reason: plan.reason, cost, r: R, center: n.pos, ringId: id, plan };
  }

  /** Строит кольцо на месте перекрёстка у курсора. false — нельзя. */
  buildRoundabout(p: Vec, radius: number, opts: RingOptions): boolean {
    const check = this.roundaboutPlan(p, radius, opts);
    if (!check.ok || !check.plan || !check.center || check.ringId === undefined) return false;
    // Кольцо помечено id перекрёстка, на месте которого оно встало.
    const ringId = check.ringId;
    const center = { ...check.center };
    this.roundaboutCenters.set(ringId, center);
    if (!this.roadBuilder.apply(check.plan)) {
      this.roundaboutCenters.delete(ringId);
      return false;
    }
    this.spend(roundaboutFee(check.r, opts.lanes));
    return true;
  }

  /** Можно ли поставить (или снять) светофор на перекрёстке и во что это обойдётся (минус — возврат). */
  lightsPlan(nodeId: number): { ok: boolean; reason?: string; cost: number } {
    const n = this.roads.net.nodes.get(nodeId);
    const cost = COST.trafficLight;
    if (!n || n.kind !== 'junction') return { ok: false, reason: 'Кликните по перекрёстку', cost };
    if (n.control === 'lights') return { ok: true, cost: -Math.round(cost * COST.refundRatio) };
    if ((n.roundabout ?? null) !== null) return { ok: false, reason: 'Это кольцо', cost };
    if (this.roads.net.ends(n).length < 3) return { ok: false, reason: 'Светофор — на перекрёстке от трёх дорог', cost };
    if (cost > this.budget) return { ok: false, reason: 'Не хватает денег', cost };
    return { ok: true, cost };
  }

  /** Ставит или снимает светофор. */
  toggleLights(nodeId: number): boolean {
    const plan = this.lightsPlan(nodeId);
    const n = this.roads.net.nodes.get(nodeId);
    if (!plan.ok || !n) return false;
    if (n.control === 'lights') {
      delete n.control;
      this.refund(COST.trafficLight);
    } else {
      n.control = 'lights';
      this.spend(COST.trafficLight);
    }
    this.roads.net.version++;
    this.networkChanged();
    return true;
  }

  /** Метки полос перекрёстка для настройки связей на карте: въезды (у стоп-линии) и выезды. */
  laneEnds(nodeId: number): LaneEnd[] {
    const n = this.roads.net.nodes.get(nodeId);
    if (!n || n.kind !== 'junction') return [];
    const g = this.roads.graph;
    const custom = new Set((n.lanes ?? []).map((k) => k.split('>')[0]));
    const outs = g.outLinks.get(nodeId) ?? [];
    const res: LaneEnd[] = [];
    for (const l of g.inLinks.get(nodeId) ?? []) {
      const exits = outs.filter((o) => o.corridor !== l.corridor && !n.bans?.includes(`${l.corridor}>${o.corridor}`)).map((o) => o.corridor);
      l.lanes.forEach((lane, idx) => {
        const i = l.lanes.length - 1 - idx;
        const pose = g.lanePose(lane, Math.max(0, lane.length - 6));
        res.push({ kind: 'in', seg: l.corridor, i, lane: lane.id, pos: pose.pos, dir: pose.dir, custom: custom.has(`${l.corridor}.${i}`), exits });
      });
    }
    for (const l of outs) {
      l.lanes.forEach((lane, idx) => {
        const pose = g.lanePose(lane, Math.min(lane.length, 6));
        res.push({ kind: 'out', seg: l.corridor, i: l.lanes.length - 1 - idx, lane: lane.id, pos: pose.pos, dir: pose.dir, custom: false, exits: [] });
      });
    }
    return res;
  }

  /**
   * Соединяет полосу въезда (полотно inSeg, полоса i справа) с полосой выезда или разъединяет их.
   * Первый клик по ненастроенной полосе переносит её автоматические связи в настройку. null — получилось.
   */
  toggleLaneConnection(nodeId: number, inSeg: number, i: number, outSeg: number, j: number): string | null {
    const n = this.roads.net.nodes.get(nodeId);
    if (!n || n.kind !== 'junction') return 'Нет перекрёстка';
    if (inSeg === outSeg) return 'Разворот на ту же дорогу нельзя';
    const ends = this.laneEnds(nodeId);
    const from = ends.find((e) => e.kind === 'in' && e.seg === inSeg && e.i === i);
    const to = ends.find((e) => e.kind === 'out' && e.seg === outSeg && e.i === j);
    if (!from || !to) return 'Нет такой полосы';
    if (!from.exits.includes(outSeg)) return 'С этой полосы сюда не проехать';
    const prefix = `${inSeg}.${i}>`;
    let lanes = [...(n.lanes ?? [])];
    if (!lanes.some((k) => k.startsWith(prefix))) {
      const g = this.roads.graph;
      for (const m of g.movesFrom.get(from.lane) ?? []) {
        if (m.node !== nodeId) continue;
        const out = g.lanes.get(m.outLane)!;
        const link = g.links.get(out.link)!;
        lanes.push(laneKey({ from: inSeg, i, to: link.corridor, j: link.lanes.length - 1 - out.index }));
      }
    }
    const key = laneKey({ from: inSeg, i, to: outSeg, j });
    if (lanes.includes(key)) {
      if (lanes.filter((k) => k.startsWith(prefix)).length <= 1) return 'Полоса без выезда — тупик';
      lanes = lanes.filter((k) => k !== key);
    } else lanes.push(key);
    n.lanes = lanes;
    this.roads.net.version++;
    this.networkChanged();
    return null;
  }

  /** Возвращает всем полосам перекрёстка автоматические связи. */
  resetLanes(nodeId: number): void {
    const n = this.roads.net.nodes.get(nodeId);
    if (!n?.lanes) return;
    delete n.lanes;
    this.roads.net.version++;
    this.networkChanged();
  }

  /**
   * Что показать в карточке перекрёстка: подъезды по сторонам света, главная дорога,
   * фазы светофора и повороты с каждого подъезда (разрешён или запрещён). Подъезды — полотна.
   */
  junctionInfo(nodeId: number): JunctionInfo | null {
    const net = this.roads.net;
    const n = net.nodes.get(nodeId);
    if (!n || n.kind !== 'junction') return null;
    const ends = net.ends(n);
    const approaches = ends.map((e) => ({ seg: e.corridor.id, compass: compassOf(e.away), dir: e.away }));
    const label = (seg: number) => approaches.find((a) => a.seg === seg)?.compass ?? { name: '?', arrow: '•' };
    const g = this.roads.graph;
    const ins = g.inLinks.get(nodeId) ?? [];
    const awayOf = (seg: number) => approaches.find((a) => a.seg === seg)?.dir ?? { x: 1, y: 0 };
    const turns = ins.map((link) => {
      const arrive = scale(awayOf(link.corridor), -1);
      const exits = approaches
        .filter((out) => out.seg !== link.corridor || approaches.length === 1)
        .map((out) => {
          const theta = angleDiff(angleOf(arrive), angleOf(out.dir));
          const kind: TurnKind = Math.abs(theta) < 0.5 ? 'straight' : theta > 0 ? 'right' : 'left';
          return { out: out.seg, kind, banned: !!n.bans?.includes(`${link.corridor}>${out.seg}`) };
        });
      return { from: link.corridor, label: label(link.corridor), exits };
    });
    // Пары для главной дороги — почти прямые проезды через узел.
    const pairs: [number, number][] = [];
    for (let i = 0; i < approaches.length; i++) {
      for (let j = i + 1; j < approaches.length; j++) {
        if (dot(approaches[i].dir, approaches[j].dir) < -0.8) pairs.push([approaches[i].seg, approaches[j].seg]);
      }
    }
    const priority = g.nodes.get(nodeId)?.priorityLanes ?? new Set<number>();
    const mainNow = [...new Set(ins.filter((l) => l.lanes.some((lane) => priority.has(lane.id))).map((l) => l.corridor))];
    // Фазы светофора: чьи подъезды едут вместе, сколько горит зелёный, какая сейчас.
    const L = g.nodes.get(nodeId)?.lights;
    const corridorOfLane = (id: number) => g.links.get(g.lanes.get(id)?.link ?? -1)?.corridor;
    const phases = (L?.phases ?? []).map((ph, i) => ({
      approaches: [...new Set(ph.map(corridorOfLane).filter((x): x is number => x !== undefined))].map(label),
      green: n.greens?.[i] ?? LIGHTS.green,
      active: !!L && i === L.phase && !L.clearing,
    }));
    const here = new Set(approaches.map((a) => a.seg));
    const links = (n.lanes ?? []).map(parseLaneKey).filter((l): l is LaneLink => !!l && here.has(l.from) && here.has(l.to));
    const customLanes = new Set(links.map((l) => `${l.from}.${l.i}`)).size;
    return {
      node: n,
      approaches,
      turns,
      pairs: pairs.map((p) => ({ segs: p, name: `${label(p[0]).name}–${label(p[1]).name}` })),
      mainNow,
      phases,
      label,
      customLanes,
    };
  }

  // ---------- Отмена строительства ----------

  private readonly undoStack: UndoSnapshot[] = [];
  /** Снимок сделан, действие ещё идёт (например, тянем снос мышью). */
  private undoPending = false;

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /** Запоминает постройки перед действием игрока: дороги, пути, станции, здания, кольца. */
  checkpoint(label: string): void {
    if (this.undoPending) this.commit();
    this.undoPending = true;
    this.undoStack.push({
      label,
      roads: this.roads.net.clone(),
      roadsVersion: this.roads.net.version,
      net: structuredClone(this.net.serialize()),
      version: this.net.version,
      stations: [...this.stations.values()].map((s) => structuredClone(this.stationToSave(s))),
      buildings: this.towns.map((t) => ({ townId: t.id, list: t.buildings.map((b) => structuredClone(b)) })),
      roundabouts: [...this.roundaboutCenters].map(([id, c]) => [id, { ...c }]),
      moneyBefore: this.money,
      spent: 0,
    });
    if (this.undoStack.length > UNDO_DEPTH) this.undoStack.shift();
  }

  /** Действие закончено: если ничего не построили и не снесли, снимок не нужен. */
  commit(): void {
    if (!this.undoPending) return;
    this.undoPending = false;
    const top = this.undoStack[this.undoStack.length - 1];
    if (!top) return;
    const changed =
      top.version !== this.net.version ||
      top.roadsVersion !== this.roads.net.version ||
      top.stations.length !== this.stations.size ||
      top.buildings.some((b) => this.towns.find((t) => t.id === b.townId)?.buildings.length !== b.list.length) ||
      top.moneyBefore !== this.money;
    if (!changed) this.undoStack.pop();
    else top.spent = top.moneyBefore - this.money;
  }

  /** После правок линий старые снимки могли бы сломать маршруты — забываем их. */
  private forgetUndo(): void {
    this.undoStack.length = 0;
  }

  /**
   * Отменяет последнюю стройку: возвращает сеть, станции, дома и кольца как были
   * и возвращает потраченные деньги. Заработанное за это время остаётся,
   * машины и поезда продолжают путь (кто оказался на снесённом участке — вернётся на станцию).
   */
  undo(): string | null {
    this.commit();
    const snap = this.undoStack.pop();
    if (!snap) return null;
    const railSave = this.rail.serialize();
    this.rail.clearTrains();
    this.net.replaceWith(snap.net);
    // Машины переезжают на восстановленные дороги сами; кому некуда — вернутся на станцию.
    this.roads.replace(snap.roads.clone());

    // Станции: живые остаются (со своими грузами и пассажирами), лишние уходят, снесённые возвращаются.
    const keep = new Set(snap.stations.map((s) => s.id));
    for (const st of [...this.stations.values()]) {
      if (keep.has(st.id)) continue;
      this.index.remove(st);
      this.stations.delete(st.id);
    }
    for (const s of snap.stations) {
      const live = this.stations.get(s.id);
      if (live) {
        // Посты погрузки и размер площадки — как были до действия.
        if (live.bays !== s.bays || live.fp.w !== s.fp.w) {
          this.index.remove(live);
          live.fp = s.fp;
          live.bays = s.bays;
          this.index.add(live);
        }
        continue;
      }
      const st = this.stationFromSave(s);
      this.stations.set(st.id, st);
      this.index.add(st);
    }
    // Дома: снесённые возвращаются, перенесённые встают на старое место,
    // а выросшие с тех пор сами по себе — остаются.
    for (const { townId, list } of snap.buildings) {
      const town = this.towns.find((t) => t.id === townId);
      if (!town) continue;
      const now = new Map(town.buildings.map((b) => [b.id, b]));
      for (const old of list) {
        const cur = now.get(old.id);
        if (cur) this.index.remove(cur);
        now.set(old.id, old);
        this.index.add(old);
      }
      // Дома у улиц, которые город проложил после снимка (их отмена убрала), уходят вместе с ними.
      town.buildings = [...now.values()].filter((b) => {
        if (this.roads.net.nodes.has(b.anchor)) return true;
        this.index.remove(b);
        return false;
      });
      recountPopulation(town);
    }
    this.roundaboutCenters.clear();
    for (const [id, c] of snap.roundabouts) this.roundaboutCenters.set(id, c);

    // Поезда — обратно на восстановленные пути.
    const sims = new Set(this.traffic.vehicles.keys());
    const trains = this.rail.restore(railSave);
    this.reattachFleet(sims, trains);
    this.net.rebuild();
    this.refreshCrossings();
    for (const st of this.stations.values()) this.computeCatchment(st);

    // Деньги за стройку — назад.
    this.money += snap.spent;
    this.expensesMonth -= snap.spent;
    this.ledger.build -= Math.min(this.ledger.build, snap.spent);
    return snap.label;
  }

  // ---------- Время ----------

  get dateLabel(): string {
    const m = this.month % 12;
    return `${MONTHS[m]} ${START_YEAR + Math.floor(this.month / 12)}`;
  }

  /** Текущий игровой год. */
  get year(): number {
    return START_YEAR + Math.floor(this.month / 12);
  }

  /** Содержание в месяц: у поезда растёт с длиной состава. */
  runningCost(v: FleetVehicle): number {
    const m = MODELS[v.model];
    const length = m.mode === 'rail' ? 0.4 + (0.6 * carsOf(v)) / m.train.cars : 1;
    return Math.round(m.running * length);
  }

  /** Сколько вагонов поместится на платформы всех станций линии. */
  maxCars(v: FleetVehicle): number {
    const m = MODELS[v.model];
    const line = this.lines.get(v.lineId);
    if (m.mode !== 'rail' || !line) return 1;
    let shortest = Infinity;
    for (const sid of line.stops) {
      const st = this.stations.get(sid);
      const longest = Math.max(0, ...(st?.platforms ?? []).map((p) => this.net.segments.get(p)?.length ?? 0));
      shortest = Math.min(shortest, longest);
    }
    return Math.max(2, Math.floor((shortest - 6) / m.train.carLength));
  }

  /**
   * Меняет длину состава: вместимость и содержание — вместе с ней. Стоящий поезд
   * перецепляется сразу, едущий — по прибытии на станцию. Лишний груз остаётся на станции.
   */
  setTrainCars(id: number, cars: number): boolean {
    const v = this.fleet.get(id);
    const m = v && MODELS[v.model];
    if (!v || !m || m.mode !== 'rail') return false;
    const next = Math.max(2, Math.min(this.maxCars(v), cars));
    if (next === carsOf(v)) return false;
    v.cars = next;
    const train = this.fleetTrain(v);
    if (train && !train.moving) this.recouple(v, train);
    return true;
  }

  private recouple(v: FleetVehicle, train: Train): void {
    const cars = carsOf(v);
    if (train.cars === cars || train.platform === null) return;
    const seg = this.net.segments.get(train.platform);
    if (!seg) return;
    train.cars = cars;
    train.length = cars * train.carLength;
    train.head = (seg.length + train.length) / 2;
    train.stopAt = train.head;
    const cap = vehicleCapacity(v);
    if (v.amount > cap) v.amount = cap;
  }

  /** Сколько дадут при продаже: 60% цены. */
  saleValue(v: FleetVehicle): number {
    return Math.round(MODELS[v.model].price * 0.6);
  }

  /** Модель новее того же рода, если уже вышла. */
  replacementFor(v: FleetVehicle): ModelId | null {
    const best = newestLike(v.model, this.year);
    return best !== v.model ? best : null;
  }

  /** Продаёт старую машину и покупает новую на ту же линию. */
  replaceVehicle(id: number): FleetVehicle | null {
    const v = this.fleet.get(id);
    const model = v && this.replacementFor(v);
    if (!v || !model) return null;
    if (MODELS[model].price - this.saleValue(v) > this.budget) return null;
    const lineId = v.lineId;
    this.sellVehicle(id);
    return this.buyVehicle(lineId, model);
  }

  get monthProgress(): number {
    return (this.time % MONTH_LENGTH) / MONTH_LENGTH;
  }

  update(realDt: number): void {
    for (const n of this.notices) n.age += realDt;
    while (this.notices.length && this.notices[0].age > 6) this.notices.shift();
    for (const f of this.floaters) f.age += realDt;
    while (this.floaters.length && this.floaters[0].age > 2.5) this.floaters.shift();
    if (this.speed === 0) return;
    this.accumulator += Math.min(realDt, 0.1) * this.speed;
    let steps = 0;
    while (this.accumulator >= SIM_DT && steps < 24) {
      this.tick(SIM_DT);
      this.accumulator -= SIM_DT;
      steps++;
    }
    if (steps >= 24) this.accumulator = 0;
  }

  private tick(dt: number): void {
    this.time += dt;
    this.traffic.step(dt);
    this.rail.step(dt);
    this.updateFleet(dt);
    this.updateAutoSell();
    this.updateIndustries(dt);
    this.updateStations(dt);
    this.updateTowns(dt);
    const month = Math.floor(this.time / MONTH_LENGTH);
    if (month !== this.month) {
      this.monthEnd();
      const yearBefore = this.year;
      this.month = month;
      // Новый год — новые модели в продаже.
      if (this.year !== yearBefore) {
        for (const m of Object.values(MODELS)) {
          if (m.year === this.year) this.notify(`Новая модель: ${m.name} — ${m.capacity} мест. Старый транспорт можно заменить в карточке маршрута`, '#4a8fe7');
        }
      }
    }
  }

  // ---------- Транспортная компания ----------

  stationLines(stationId: number): Line[] {
    return [...this.lines.values()].filter((l) => l.stops.includes(stationId));
  }

  /** Маршруты предприятия: через станции, которые его обслуживают. */
  industryLines(industryId: number): Line[] {
    const stations = new Set([...this.stations.values()].filter((s) => s.industryId === industryId || s.industryIds.includes(industryId)).map((s) => s.id));
    return [...this.lines.values()].filter((l) => l.stops.some((id) => stations.has(id)));
  }

  private served(st: Station): boolean {
    for (const l of this.lines.values()) if (l.stops.includes(st.id) && l.vehicles.length) return true;
    return false;
  }

  lineMode(line: Line): LineMode {
    return line.mode ?? 'road';
  }

  /**
   * Чем ездит линия — для значка в списках: поезд, автобус или грузовик.
   * Автолиния — по своему транспорту, а пока его нет — по станциям маршрута.
   */
  lineVehicleKind(line: Line): 'train' | 'bus' | 'truck' {
    if (this.lineMode(line) === 'rail') return 'train';
    return this.lineCarries(line) === 'passengers' ? 'bus' : 'truck';
  }

  /** Что возит линия: по её транспорту, а пока его нет — по станциям маршрута. */
  lineCarries(line: Line): 'freight' | 'passengers' {
    const v = line.vehicles.map((id) => this.fleet.get(id)).find((x) => x);
    return v ? MODELS[v.model].carries : this.stationsCarry(line);
  }

  /** Что возить по станциям маршрута: груз, если одна станция производит то, что принимает другая. */
  private stationsCarry(line: Line): 'freight' | 'passengers' {
    const sts = line.stops.map((id) => this.stations.get(id)).filter((s): s is Station => !!s);
    if (sts.every((s) => !s.serves.pax)) return 'freight';
    if (sts.every((s) => !s.serves.cargo)) return 'passengers';
    return this.freightFlow(sts) ? 'freight' : 'passengers';
  }

  /** Одна станция маршрута производит груз, который принимает другая, — есть что возить грузовиками. */
  private freightFlow(sts: Station[]): boolean {
    return sts.some((s) => this.stationIndustries(s).some((ind) => sts.some((o) => o !== s && o.accepts.has(ind.info.produces))));
  }

  /**
   * Какой транспорт подходит маршруту — для кнопок покупки и авто-парка; null — смешанный или пока не понять
   * (тогда годится любой). По транспорту на линии; пока его нет — по станциям: с остановкой — пассажирский;
   * груз от одной станции к другой — грузовой (а если жители есть у двух станций — смешанный);
   * без груза — пассажирский, если в охвате есть жители.
   */
  lineKind(line: Line): 'freight' | 'passengers' | null {
    const kinds = new Set(line.vehicles.map((id) => this.fleet.get(id)).flatMap((v) => (v ? [MODELS[v.model].carries] : [])));
    if (kinds.size) return kinds.size === 1 ? [...kinds][0] : null;
    const sts = line.stops.map((id) => this.stations.get(id)).filter((s): s is Station => !!s);
    if (sts.some((s) => s.kind === 'stop') || sts.every((s) => !s.serves.cargo)) return 'passengers';
    if (sts.every((s) => !s.serves.pax)) return 'freight';
    const people = sts.filter((s) => s.serves.pax && s.catchPop > 0).length;
    if (this.freightFlow(sts)) return people >= 2 ? null : 'freight';
    return people ? 'passengers' : null;
  }

  /** Почему из этих станций нельзя собрать линию; null — можно. Остановки ездят вместе с автостанциями. */
  lineProblem(stops: number[]): string | null {
    const sts = stops.map((id) => this.stations.get(id)).filter((s): s is Station => !!s);
    if (new Set(sts.map(stationMode)).size > 1) return 'В одном маршруте — либо автостанции и остановки, либо ж/д станции';
    return null;
  }

  createLine(stops: number[]): Line | null {
    const clean = stops.filter((id, i) => this.stations.has(id) && id !== stops[i - 1]);
    if (clean.length > 1 && clean[0] === clean[clean.length - 1]) clean.pop();
    if (clean.length < 2 || this.lineProblem(clean)) return null;
    this.forgetUndo();
    const n = this.lines.size ? Math.max(...this.lines.keys()) + 1 : 1;
    // Грузовой маршрут — цветом груза, который везут с первой станции (его принимают дальше по маршруту, иначе —
    // что там производят); пассажирский — первый цвет, которого ещё нет у других линий.
    const first = this.stations.get(clean[0])!;
    const later = clean.slice(1).map((id) => this.stations.get(id)!);
    const produced = first.serves.cargo ? this.stationIndustries(first).map((ind) => ind.info.produces) : [];
    const cargo = produced.find((c) => later.some((s) => s.accepts.has(c))) ?? produced[0];
    const used = new Set([...this.lines.values()].map((l) => l.color));
    const color = cargo ? CARGO[cargo].color : (LINE_COLORS.find((c) => !used.has(c)) ?? LINE_COLORS[(n - 1) % LINE_COLORS.length]);
    const line: Line = {
      id: n,
      name: this.defaultLineName(clean),
      color,
      mode: stationMode(this.stations.get(clean[0])!),
      stops: clean,
      vehicles: [],
      revenueMonth: 0,
      revenueLast: 0,
      revenueTotal: 0,
      costMonth: 0,
      costLast: 0,
      carriedMonth: 0,
      carriedLast: 0,
      problem: null,
    };
    this.lines.set(n, line);
    return line;
  }

  /**
   * «Откуда — Куда», для длинных линий с многоточием посередине.
   * Грузовые цепочки называются коротко: груз и получатель — «Уголь — Завод металла».
   */
  private defaultLineName(stops: number[]): string {
    const sts = stops.map((id) => this.stations.get(id)).filter((s): s is Station => !!s);
    const names = sts.map((s) => s.name);
    const first = sts[0];
    const others = new Set(sts.slice(1).flatMap((s) => [...s.accepts]));
    const source = first && this.stationIndustries(first).find((i) => others.has(i.info.produces));
    if (source) {
      const cargo = source.info.produces;
      names[0] = CARGO[cargo].name;
      sts.forEach((s, i) => {
        if (i === 0) return;
        const taker = this.stationIndustries(s).find((ind) => ind.info.accepts.includes(cargo));
        if (taker) names[i] = taker.info.short;
      });
    }
    if (names.length <= 3) return names.join(' — ');
    return `${names[0]} — … — ${names[names.length - 1]}`;
  }

  /** Предприятия станции: сначала то, к которому она пристроена. */
  private stationIndustries(st: Station): Industry[] {
    const ids = st.industryId !== null ? [st.industryId, ...st.industryIds.filter((id) => id !== st.industryId)] : st.industryIds;
    return ids.map((id) => this.industries.find((i) => i.id === id)).filter((i): i is Industry => !!i);
  }

  /** Меняет цвет линии вместе с машинами, которые уже в пути. */
  setLineColor(id: number, color: string): void {
    const line = this.lines.get(id);
    if (!line || !/^#[0-9a-f]{6}$/i.test(color)) return;
    line.color = color;
    for (const vid of line.vehicles) {
      const v = this.fleet.get(vid);
      const sim = v && this.fleetSim(v);
      if (sim) sim.color = color;
    }
  }

  renameLine(id: number, name: string): void {
    const line = this.lines.get(id);
    const clean = name.trim().slice(0, 60);
    if (line && clean) line.name = clean;
  }

  // ---------- Папки линий ----------

  /** Новая папка; без названия — «Папка N» с первым свободным номером. */
  createFolder(name?: string): LineFolder {
    const id = this.folders.size ? Math.max(...this.folders.keys()) + 1 : 1;
    const names = new Set([...this.folders.values()].map((f) => f.name));
    let n = 1;
    while (names.has(`Папка ${n}`)) n++;
    const folder: LineFolder = { id, name: name?.trim().slice(0, 40) || `Папка ${n}` };
    this.folders.set(id, folder);
    return folder;
  }

  renameFolder(id: number, name: string): void {
    const folder = this.folders.get(id);
    const clean = name.trim().slice(0, 40);
    if (folder && clean) folder.name = clean;
  }

  /** Удаляет папку; её линии остаются и переходят в корень списка. */
  deleteFolder(id: number): void {
    if (!this.folders.delete(id)) return;
    for (const line of this.lines.values()) if (line.folder === id) delete line.folder;
  }

  /** Переносит линию в папку; null или несуществующая папка — в корень списка. */
  setLineFolder(lineId: number, folderId: number | null): void {
    const line = this.lines.get(lineId);
    if (!line) return;
    if (folderId !== null && this.folders.has(folderId)) line.folder = folderId;
    else delete line.folder;
  }

  /** Сворачивает или разворачивает папку в списке. */
  toggleFolder(id: number): void {
    const folder = this.folders.get(id);
    if (folder) folder.collapsed = !folder.collapsed;
  }

  /** Линии папки в порядке создания; null — линии вне папок. */
  folderLines(id: number | null): Line[] {
    return [...this.lines.values()].filter((l) => (l.folder ?? null) === id);
  }

  /**
   * Переставляет линию в списке: в папку folderId (null — в корень) перед линией beforeId,
   * а без beforeId — в конец этой папки. Порядок списка — порядок линий в lines, он же сохраняется.
   */
  moveLine(lineId: number, folderId: number | null, beforeId: number | null = null): void {
    const line = this.lines.get(lineId);
    if (!line || lineId === beforeId) return;
    this.setLineFolder(lineId, folderId);
    const group = line.folder ?? null;
    const order = [...this.lines.values()].filter((l) => l !== line);
    const before = beforeId !== null ? this.lines.get(beforeId) : undefined;
    let at = before && (before.folder ?? null) === group ? order.indexOf(before) : -1;
    if (at < 0) {
      // В конец папки — сразу за её последней линией; в пустой папке — в конец списка.
      let last = -1;
      order.forEach((l, i) => {
        if ((l.folder ?? null) === group) last = i;
      });
      at = last >= 0 ? last + 1 : order.length;
    }
    order.splice(at, 0, line);
    this.lines.clear();
    for (const l of order) this.lines.set(l.id, l);
  }

  // ---------- Редактирование маршрута ----------

  /**
   * Новый маршрут линии. Машины, чья станция (где стоят или куда едут) осталась
   * в маршруте, продолжают как ни в чём не бывало; остальные начинают с первой станции.
   */
  setLineRoute(id: number, stops: number[], rules: (StopRule | null)[]): string | null {
    const line = this.lines.get(id);
    if (!line) return 'Нет маршрута';
    const clean: number[] = [];
    const cleanRules: (StopRule | null)[] = [];
    stops.forEach((sid, i) => {
      if (!this.stations.has(sid) || sid === clean[clean.length - 1]) return;
      clean.push(sid);
      cleanRules.push(rules[i] ?? null);
    });
    if (clean.length > 1 && clean[0] === clean[clean.length - 1]) {
      clean.pop();
      cleanRules.pop();
    }
    if (clean.length < 2) return 'В маршруте нужно минимум две станции';
    const problem = this.lineProblem(clean);
    if (problem) return problem;
    if (stationMode(this.stations.get(clean[0])!) !== this.lineMode(line)) return 'Поезда и машины не смешиваются в одном маршруте';
    if (line.vehicles.some((id) => MODELS[this.fleet.get(id)!.model].carries !== 'passengers') && clean.some((id) => this.stations.get(id)!.kind === 'stop')) {
      return 'Грузовики к остановкам не ездят';
    }
    this.forgetUndo();
    const before = line.stops;
    line.stops = clean;
    line.rules = cleanRules;
    line.problem = null;
    // Круг другой — его время мерим заново.
    delete line.lap;
    delete line.departedAt;
    this.lapGuess.delete(line.id);
    for (const vid of line.vehicles) {
      const v = this.fleet.get(vid);
      if (!v) continue;
      this.forgetLap(v);
      const at = before[v.stop];
      const index = clean.indexOf(at);
      if (index >= 0) {
        v.stop = index;
        continue;
      }
      // Станции больше нет в маршруте: машина возвращается к началу маршрута.
      this.resetVehicle(v, line);
    }
    return null;
  }

  /** Снимает машину или поезд с дороги и ставит в начало маршрута. */
  private resetVehicle(v: FleetVehicle, line: Line): void {
    if (v.simId !== null) {
      const sim = this.traffic.vehicles.get(v.simId);
      if (sim) this.traffic.remove(sim);
      this.owners.delete(v.simId);
      v.simId = null;
    }
    const train = this.fleetTrain(v);
    if (train) this.rail.remove(train);
    v.trainId = null;
    this.leaveBay(v);
    // Груз не теряется: он поедет дальше по новому маршруту.
    v.stop = MODELS[v.model].mode === 'rail' ? 0 : line.stops.length - 1;
    v.state = 'departing';
    v.timer = 1;
    v.waited = 0;
    this.forgetLap(v);
  }

  /** Круг машины не в счёт (сменился маршрут, машину сняли с пути): мерим со следующего отправления. */
  private forgetLap(v: FleetVehicle): void {
    delete v.lapAt;
    delete v.lapHeld;
    delete v.holdFrom;
    delete v.holdUntil;
  }

  addLineStop(id: number, stationId: number): string | null {
    const line = this.lines.get(id);
    if (!line) return 'Нет маршрута';
    return this.setLineRoute(id, [...line.stops, stationId], [...(line.rules ?? line.stops.map(() => null)), null]);
  }

  removeLineStop(id: number, index: number): string | null {
    const line = this.lines.get(id);
    if (!line) return 'Нет маршрута';
    const rules = line.rules ?? line.stops.map(() => null);
    return this.setLineRoute(
      id,
      line.stops.filter((_, i) => i !== index),
      rules.filter((_, i) => i !== index),
    );
  }

  moveLineStop(id: number, index: number, delta: number): string | null {
    const line = this.lines.get(id);
    if (!line) return 'Нет маршрута';
    const to = index + delta;
    if (to < 0 || to >= line.stops.length) return null;
    const stops = [...line.stops];
    const rules = [...(line.rules ?? line.stops.map(() => null))];
    [stops[index], stops[to]] = [stops[to], stops[index]];
    [rules[index], rules[to]] = [rules[to], rules[index]];
    return this.setLineRoute(id, stops, rules);
  }

  setStopRule(id: number, index: number, rule: StopRule): void {
    const line = this.lines.get(id);
    if (!line || index < 0 || index >= line.stops.length) return;
    const rules = [...(line.rules ?? line.stops.map(() => null))];
    rules[index] = rule;
    line.rules = rules;
  }

  deleteLine(id: number): void {
    const line = this.lines.get(id);
    if (!line) return;
    this.forgetUndo();
    for (const vid of [...line.vehicles]) this.sellVehicle(vid);
    this.lines.delete(id);
    this.lapGuess.delete(id);
  }

  buyVehicle(lineId: number, model: ModelId): FleetVehicle | null {
    const line = this.lines.get(lineId);
    const m = MODELS[model];
    if (!line || m.price > this.budget || m.mode !== this.lineMode(line) || m.year > this.year) return null;
    // На остановке только пассажиры: грузовику там делать нечего.
    if (m.carries !== 'passengers' && line.stops.some((id) => this.stations.get(id)?.kind === 'stop')) return null;
    const first = this.stations.get(line.stops[0]);
    const id = this.nextEntityId++;
    const v: FleetVehicle = {
      id,
      name: `${m.name} №${id}`,
      model,
      lineId,
      stop: 0,
      state: 'departing',
      simId: null,
      // Поезд встанет на платформу первого вокзала, как только она освободится (updateTrain).
      trainId: null,
      cargo: null,
      amount: 0,
      loadedAt: null,
      passengers: [],
      timer: 0,
      waited: 0,
      inBay: false,
      profitMonth: 0,
      profitLast: 0,
      boughtMonth: this.month,
      // Новая машина уедет с первой станции, выждав интервал за предыдущей (spacingUntil).
      fresh: true,
    };
    this.fleet.set(id, v);
    line.vehicles.push(id);
    this.spend(m.price, 'purchases');
    // Новая машина сначала грузится на первой остановке.
    if (first && m.mode === 'road') {
      this.handleStop(v, first, line);
      v.state = 'loading';
      v.timer += line.vehicles.length * 3;
    }
    return v;
  }

  sellVehicle(id: number): void {
    const v = this.fleet.get(id);
    if (!v) return;
    if (v.simId !== null) {
      const sim = this.traffic.vehicles.get(v.simId);
      if (sim) this.traffic.remove(sim);
      this.owners.delete(v.simId);
    }
    const train = this.fleetTrain(v);
    if (train) this.rail.remove(train);
    this.leaveBay(v);
    const line = this.lines.get(v.lineId);
    if (line) line.vehicles = line.vehicles.filter((x) => x !== id);
    this.fleet.delete(id);
    const sale = this.saleValue(v);
    this.money += sale;
    this.incomeMonth += sale;
    this.ledger.sales += sale;
  }

  // ---------- Авто-парк ----------

  /**
   * Настройки авто-парка линии. Впервые — от нынешнего числа машин до вдвое большего.
   * Включённый сразу докупает до минимума (если хватает денег) и продаёт сверх максимума.
   */
  setLineAuto(id: number, patch: Partial<Pick<LineAuto, 'on' | 'min' | 'max'>>): void {
    const line = this.lines.get(id);
    if (!line) return;
    const n = line.vehicles.length;
    const auto = (line.auto ??= { on: false, min: Math.max(1, n), max: Math.max(3, n * 2) });
    const top = AUTO_FLEET.maxVehicles;
    if (patch.on !== undefined) auto.on = patch.on;
    if (patch.min !== undefined) {
      auto.min = Math.max(1, Math.min(top, Math.round(patch.min)));
      auto.max = Math.max(auto.max, auto.min);
    }
    if (patch.max !== undefined) {
      auto.max = Math.max(1, Math.min(top, Math.round(patch.max)));
      auto.min = Math.min(auto.min, auto.max);
    }
    delete auto.noMoney;
    if (!auto.on) {
      delete auto.sell;
      return;
    }
    this.autoBounds(line);
  }

  /**
   * Игрок сам купил или продал машину на линии с авто-парком: пределы раздвигаются под новое число,
   * чтобы авто-парк не отменил его решение. Продал все — авто-парк выключается.
   */
  fitAutoRange(lineId: number): void {
    const line = this.lines.get(lineId);
    const auto = line?.auto;
    if (!line || !auto?.on) return;
    const n = line.vehicles.length;
    if (!n) {
      auto.on = false;
      delete auto.sell;
      return;
    }
    auto.min = Math.min(auto.min, n);
    auto.max = Math.max(auto.max, n);
    this.restartDemand(line);
  }

  /**
   * Что докупает авто-парк: модель последней купленной машины, подходящей маршруту (грузовой — грузовики,
   * пассажирский — автобусы; смешанный — по станциям), а если такой нет — новейшую подходящую.
   */
  autoModel(line: Line): ModelId {
    const carries = this.lineKind(line) ?? this.stationsCarry(line);
    const last = this.lastVehicle(line, carries);
    if (last) return last.model;
    const freight = carries === 'freight';
    const base: ModelId = this.lineMode(line) === 'rail' ? (freight ? 'freightTrain' : 'passengerTrain') : freight ? 'truck' : 'bus';
    return newestLike(base, this.year);
  }

  /** Последняя купленная на линию машина, что возит carries. */
  private lastVehicle(line: Line, carries: 'freight' | 'passengers'): FleetVehicle | undefined {
    for (let i = line.vehicles.length - 1; i >= 0; i--) {
      const v = this.fleet.get(line.vehicles[i]);
      if (v && MODELS[v.model].carries === carries) return v;
    }
    return undefined;
  }

  /** Содержание всего транспорта за месяц — авто-парк оставляет его в запасе. */
  private fleetRunning(): number {
    let total = 0;
    for (const v of this.fleet.values()) total += this.runningCost(v);
    return total;
  }

  /** Покупка авто-парком — если и после неё до кредитного предела останется на месяц содержания транспорта. */
  private autoBuy(line: Line): boolean {
    const auto = line.auto!;
    const model = this.autoModel(line);
    if (MODELS[model].price + this.fleetRunning() > this.budget) {
      auto.noMoney = true;
      return false;
    }
    const last = this.lastVehicle(line, MODELS[model].carries);
    const v = this.buyVehicle(line.id, model);
    if (!v) return false;
    // Поезд — той же длины, что и последний такой на линии.
    if (last?.model === model && last.cars !== undefined) v.cars = last.cars;
    delete auto.noMoney;
    this.restartDemand(line);
    return true;
  }

  /** Какую машину продать: пустую, лучше стоящую на станции; force — хоть какую, самую незагруженную. */
  private spareVehicle(line: Line, force: boolean): FleetVehicle | null {
    const list = line.vehicles.map((id) => this.fleet.get(id)).filter((v): v is FleetVehicle => !!v);
    list.sort((a, b) => vehicleLoad(a) - vehicleLoad(b) || Number(a.state === 'driving') - Number(b.state === 'driving'));
    const v = list[0];
    return v && (force || vehicleLoad(v) === 0) ? v : null;
  }

  /** Держит число машин в пределах авто-парка: докупает до минимума, продаёт сверх максимума; true — что-то сделал. */
  private autoBounds(line: Line): boolean {
    const auto = line.auto;
    if (!auto?.on) return false;
    let acted = false;
    while (line.vehicles.length < auto.min && this.autoBuy(line)) acted = true;
    while (line.vehicles.length > auto.max) {
      const v = this.spareVehicle(line, true);
      if (!v) break;
      this.sellVehicle(v.id);
      this.restartDemand(line);
      acted = true;
    }
    if (line.vehicles.length <= auto.min) delete auto.sell;
    return acted;
  }

  /** Парк линии изменился — загрузку считаем заново, с этого момента. */
  private restartDemand(line: Line): void {
    line.stopLoads = {};
    line.statsFrom = this.time;
  }

  /**
   * Итог загрузки линии для авто-парка за окно не короче месяца и круга линии — чтобы в него попали рейсы
   * со всех станций и доход за доставку. true — окно закрылось, итог новый.
   */
  private closeDemand(line: Line): boolean {
    const span = this.time - (line.statsFrom ?? 0);
    if (span < Math.max(MONTH_LENGTH, this.lineLap(line) ?? 0) - 1) return false;
    let load = 0;
    let left = 0;
    let runs = 0;
    for (const [sum, waiting, count] of Object.values(line.stopLoads ?? {})) {
      load = Math.max(load, sum / count);
      left = Math.max(left, waiting / count);
      runs += count;
    }
    // Прибыль — за те же месяцы окна.
    const months = Math.max(1, Math.round(span / MONTH_LENGTH));
    const profit = (line.history ?? []).slice(-months).reduce((s, h) => s + h.revenue - h.cost, 0);
    line.demandLast = runs ? { load, left, profit } : null;
    this.restartDemand(line);
    return true;
  }

  /**
   * Авто-парк в конце месяца: держит число машин в пределах, а по итогам окна (closed — оно только что
   * закрылось) докупает, если с самой загруженной станции машины уходят почти полными, груз (пассажиры)
   * всё равно остаётся ждать и линия не в минусе; продаёт лишнюю, если машины окно за окном уходят полупустыми.
   * Покупка или продажа начинает окно заново — следующее решение не раньше, чем она скажется.
   */
  private autoFleet(line: Line, closed: boolean): void {
    const auto = line.auto!;
    if (closed) delete auto.noMoney;
    if (this.autoBounds(line) || !closed) return;
    const d = line.demandLast;
    const A = AUTO_FLEET;
    auto.low = d && d.load < A.low && d.left < 0.1 ? (auto.low ?? 0) + 1 : 0;
    // Машины снова нужны — продажу отменяем.
    if (!auto.low) delete auto.sell;
    if (!d) return;
    const n = line.vehicles.length;
    if (d.load >= A.full && d.left >= A.leftBehind && d.profit >= 0) {
      if (n < auto.max) this.autoBuy(line);
    } else if (auto.low >= A.lowWindows && n > auto.min) {
      auto.sell ??= this.time;
    }
  }

  /** Решённая продажа: первая опустевшая машина линии, а не опустела за месяц — самая незагруженная. */
  private updateAutoSell(): void {
    for (const line of this.lines.values()) {
      const auto = line.auto;
      if (auto?.sell === undefined) continue;
      if (!auto.on || line.vehicles.length <= auto.min) {
        delete auto.sell;
        continue;
      }
      const v = this.spareVehicle(line, this.time - auto.sell > MONTH_LENGTH);
      if (!v) continue;
      this.sellVehicle(v.id);
      delete auto.sell;
      auto.low = 0;
      this.restartDemand(line);
    }
  }

  // ---------- Равномерный выпуск ----------

  /** Время круга линии, секунд: по рейсам, а пока их нет — прикидка по длине маршрута и скорости транспорта. */
  lineLap(line: Line): number | null {
    if (line.lap) return line.lap;
    const cached = this.lapGuess.get(line.id);
    if (cached && this.time - cached.at < 20) return cached.lap;
    const lap = this.guessLap(line);
    this.lapGuess.set(line.id, { at: this.time, lap });
    return lap;
  }

  private guessLap(line: Line): number | null {
    const v = this.fleet.get(line.vehicles[0]);
    if (!v) return null;
    const m = MODELS[v.model];
    let length = 0;
    for (let i = 0; i < line.stops.length; i++) {
      const a = this.stations.get(line.stops[i]);
      const b = this.stations.get(line.stops[(i + 1) % line.stops.length]);
      if (!a || !b) return null;
      const route = m.mode === 'road' ? this.roads.route(a.nodeId, b.nodeId) : null;
      length += route ? this.roads.routeLength(route) : dist(a.fp.center, b.fp.center) * 1.3;
    }
    // В пути медленнее предельной скорости (разгон, перекрёстки), на каждой станции — ещё ≈10 с.
    const speed = m.mode === 'road' ? m.spec.maxSpeed : m.train.maxSpeed;
    return length / (speed * 0.7) + line.stops.length * 10;
  }

  /** Интервал между отправлениями машин линии с первой станции: круг / число машин; одной машине — null. */
  lineInterval(line: Line): number | null {
    const n = line.vehicles.length;
    const lap = n > 1 ? this.lineLap(line) : null;
    return lap ? lap / n : null;
  }

  /** Сколько ещё секунд машина ждёт интервала на первой станции; не ждёт — null. */
  spacingLeft(v: FleetVehicle): number | null {
    return v.state === 'loading' && v.holdUntil !== undefined ? Math.max(0, v.holdUntil - this.time) : null;
  }

  /**
   * До какого времени машине стоять на первой станции, чтобы не уехать вплотную за предыдущей машиной линии
   * (почти интервал после её отправления); null — ждать незачем. Новые выжидают интервал полностью, по очереди
   * (но не дольше круга); остальные — мягко: не дольше половины интервала и 30 с, только если подъезжающим
   * есть где встать, и не ждут полными, когда груз и так в очереди.
   */
  private spacingUntil(v: FleetVehicle, line: Line, st: Station): number | null {
    const interval = v.stop === 0 && line.departedAt !== undefined ? this.lineInterval(line) : null;
    if (!interval || !this.roomToHold(v, st)) return null;
    if (!v.fresh && vehicleLoad(v) >= vehicleCapacity(v) && this.lineWaiting(line, 0, MODELS[v.model].carries) >= 1) return null;
    const cap = v.fresh ? interval * line.vehicles.length : Math.min(interval * 0.5, 30);
    return Math.min(line.departedAt! + interval * 0.8, (v.holdFrom ?? this.time) + cap);
  }

  /** Если эта машина постоит, найдётся ли место подъезжающим: свободный пост или платформа. */
  private roomToHold(v: FleetVehicle, st: Station): boolean {
    if (st.kind === 'rail') {
      const train = this.fleetTrain(v);
      return st.platforms.some((p) => p !== train?.platform && !this.rail.isReserved(p));
    }
    // Новая машина ещё не на посту — никому не мешает.
    return !v.inBay || st.occupied.length < st.bays;
  }

  /** Ждёт ли машина интервала сейчас; отпускает — ожидание вычитается из времени круга. */
  private spacingHold(v: FleetVehicle, line: Line, st: Station): boolean {
    const until = this.spacingUntil(v, line, st);
    if (until !== null && this.time < until) {
      v.holdFrom ??= this.time;
      v.holdUntil = until;
      return true;
    }
    if (v.holdFrom !== undefined) v.lapHeld = (v.lapHeld ?? 0) + this.time - v.holdFrom;
    delete v.holdFrom;
    delete v.holdUntil;
    return false;
  }

  /** Машина уходит с первой станции: замеряем её круг (без ожидания интервала) и запоминаем отправление линии. */
  private noteLap(line: Line, v: FleetVehicle): void {
    if (v.lapAt !== undefined) {
      // Случайный долгий круг (машина терялась, стояла в пробке) сдвигает среднее понемногу.
      const lap = this.time - v.lapAt - (v.lapHeld ?? 0);
      if (lap > 1) line.lap = line.lap === undefined ? lap : line.lap * 0.7 + Math.min(lap, line.lap * 3) * 0.3;
    }
    v.lapAt = this.time;
    v.lapHeld = 0;
    delete v.fresh;
    line.departedAt = this.time;
  }

  private leaveBay(v: FleetVehicle): void {
    delete v.enter;
    delete v.bay;
    if (!v.inBay) return;
    for (const st of this.stations.values()) st.occupied = st.occupied.filter((x) => x !== v.id);
    v.inBay = false;
  }

  /**
   * Погрузка на остановке по её условию отправления; true — можно ехать.
   * auto: пустой грузовик у производителя немного ждёт груз; full: до полной загрузки
   * (с пределом ожидания или без); none: сразу в путь.
   */
  private loadingDone(v: FleetVehicle, line: Line, dt: number): boolean {
    v.timer -= dt;
    if (v.timer > 0) return false;
    const here = this.stations.get(line.stops[v.stop]);
    const model = MODELS[v.model];
    const rule = this.stopRule(line, v.stop);
    const notFull = vehicleLoad(v) < vehicleCapacity(v);
    let wait = false;
    if (here && notFull) {
      if (rule.wait === 'full') wait = rule.maxWait === null || v.waited < rule.maxWait;
      else if (rule.wait === 'auto') wait = model.carries === 'freight' && v.waited < 25 && this.expectsCargo(here, line, v.stop);
    }
    if (here && wait) {
      const moved = model.carries === 'freight' ? this.loadFreight(v, here, line, v.dropped ?? null) : this.boardPassengers(v, here, line);
      v.waited += 1;
      v.timer = moved ? 1 + moved * 0.1 : 1;
      return false;
    }
    // С первой станции машины уходят с интервалом, а не пачкой; пока ждёт — догружается.
    if (here && this.spacingHold(v, line, here)) {
      const moved = model.carries === 'freight' ? this.loadFreight(v, here, line, v.dropped ?? null) : this.boardPassengers(v, here, line);
      v.timer = moved ? 0.5 + moved * 0.1 : 0.5;
      return false;
    }
    if (v.stop === 0) this.noteLap(line, v);
    v.waited = 0;
    v.dropped = null;
    return true;
  }

  private updateFleet(dt: number): void {
    for (const v of this.fleet.values()) {
      const line = this.lines.get(v.lineId);
      if (!line) continue;
      const model = MODELS[v.model];
      if (model.mode === 'rail') {
        this.updateTrain(v, line, model, dt);
        continue;
      }
      if (v.state === 'loading') {
        // Сначала заезд на пост, потом выгрузка и погрузка.
        if (v.enter) {
          this.updateEntry(v, line, dt);
          continue;
        }
        if (!this.loadingDone(v, line, dt)) continue;
        v.state = 'departing';
        v.timer = 0;
        continue;
      }
      if (v.state !== 'departing') continue;
      v.timer -= dt;
      if (v.timer > 0) continue;
      const from = this.stations.get(line.stops[v.stop]);
      const nextIdx = (v.stop + 1) % line.stops.length;
      const to = this.stations.get(line.stops[nextIdx]);
      if (!from || !to) {
        v.timer = 2;
        continue;
      }
      const route = this.roads.route(from.nodeId, to.nodeId);
      if (!route) {
        line.problem = `Нет дороги: ${from.name} → ${to.name}`;
        v.timer = 2;
        continue;
      }
      const sim = this.traffic.spawn({
        ...model.spec,
        color: line.color,
        load: v.cargo ? CARGO[v.cargo].color : undefined,
        targetNode: to.nodeId,
        route,
      });
      if (!sim) {
        v.timer = 0.4;
        continue;
      }
      line.problem = null;
      this.leaveBay(v);
      this.owners.set(sim.id, { type: 'fleet', id: v.id });
      v.simId = sim.id;
      this.recordDeparture(line, v);
      v.state = 'driving';
      v.stop = nextIdx;
    }
  }

  /**
   * Загрузка при отправлении — для подсказки «машин больше, чем груза»; по станциям — ещё и сколько
   * груза осталось ждать (в вместимостях машины): по ним авто-парк решает, докупать ли.
   */
  private recordDeparture(line: Line, v: FleetVehicle): void {
    const cap = vehicleCapacity(v);
    const load = vehicleLoad(v) / cap;
    line.loadSumMonth = (line.loadSumMonth ?? 0) + load;
    line.departuresMonth = (line.departuresMonth ?? 0) + 1;
    const sid = line.stops[v.stop];
    const stats = (line.stopLoads ??= {});
    const s = stats[sid] ?? [0, 0, 0];
    s[0] += load;
    s[1] += this.lineWaiting(line, v.stop, MODELS[v.model].carries) / cap;
    s[2] += 1;
    stats[sid] = s;
  }

  /**
   * Поезд: грузится на платформе, затем ждёт, пока весь путь до свободной платформы
   * следующего вокзала освободится (автоблокировка), и только тогда отправляется.
   */
  private updateTrain(v: FleetVehicle, line: Line, model: RailModel, dt: number): void {
    const n = line.stops.length;
    let train = this.fleetTrain(v);
    if (!train) {
      // После загрузки сохранения или сбоя поезд снова встаёт на платформу.
      if (v.state === 'driving') v.stop = (v.stop - 1 + n) % n;
      v.state = 'departing';
      const st = this.stations.get(line.stops[v.stop]);
      const length = carsOf(v) * model.train.carLength;
      if (!st || !this.rail.canPark(st.platforms, length)) {
        v.trainId = null;
        v.waited += dt;
        if (v.waited > 20) line.problem = `Поезд ждёт свободную платформу: ${st?.name ?? '?'}`;
        return;
      }
      train = this.rail.create({ ...model.train, cars: carsOf(v), color: line.color });
      this.rail.park(train, sidingsFirst(st));
      v.trainId = train.id;
      v.waited = 0;
      // Встал на платформу — сначала погрузка.
      v.state = 'loading';
      this.handleStop(v, st, line);
    }
    train.color = line.color;
    train.load = v.cargo ? CARGO[v.cargo].color : undefined;
    if (v.state === 'driving') {
      if ((train.held ?? 0) > 40) line.problem = 'Поезд долго стоит у красного сигнала. Если на однопутке сигналы в обе стороны — встречные поезда могли упереться друг в друга';
      return;
    }
    if (v.state === 'loading') {
      if (!this.loadingDone(v, line, dt)) return;
      v.state = 'departing';
      v.timer = 0;
      v.waited = 0;
    }
    v.timer -= dt;
    if (v.timer > 0) return;
    const from = this.stations.get(line.stops[v.stop]);
    const nextIdx = (v.stop + 1) % n;
    const to = this.stations.get(line.stops[nextIdx]);
    if (!from || !to) {
      v.timer = 2;
      return;
    }
    // Встаём на боковой путь, сквозной остаётся для проходящих поездов.
    const res = this.rail.depart(train, to.platforms, throughOf(to));
    if (res === 'noroute') {
      line.problem = `Нет пути: ${from.name} → ${to.name}`;
      v.timer = 2;
      return;
    }
    if (res === 'blocked') {
      // Путь занят другим поездом — ждём. Подождать встречный на одноколейке — нормально,
      // проблемой считаем только очень долгое ожидание (поездов больше, чем платформ).
      v.waited += 0.5;
      if (v.waited > 150) line.problem = `Поезд долго ждёт свободный путь: ${from.name} → ${to.name}. Возможно, поездов больше, чем платформ`;
      v.timer = 0.5;
      return;
    }
    line.problem = null;
    v.waited = 0;
    this.recordDeparture(line, v);
    v.state = 'driving';
    v.stop = nextIdx;
  }

  fleetTrain(v: FleetVehicle): Train | undefined {
    return v.trainId != null ? this.rail.trains.get(v.trainId) : undefined;
  }

  /** Машина или поезд компании по id поезда. */
  trainOwner(train: Train): FleetVehicle | undefined {
    for (const v of this.fleet.values()) if (v.trainId === train.id) return v;
    return undefined;
  }

  private onTrainArrive(train: Train): void {
    const v = this.trainOwner(train);
    const line = v && this.lines.get(v.lineId);
    const st = line && this.stations.get(line.stops[v.stop]);
    if (!v || !line || !st) return;
    v.state = 'loading';
    // Длину состава меняли в пути — перецепляем вагоны на станции.
    this.recouple(v, train);
    this.handleStop(v, st, line);
    train.load = v.cargo ? CARGO[v.cargo].color : undefined;
  }

  private onTrainLost(train: Train): void {
    const v = this.trainOwner(train);
    if (!v) return;
    v.trainId = null;
    const line = this.lines.get(v.lineId);
    if (line) line.problem = 'Путь поезда разобран — поезд вернулся на станцию';
  }

  private fleetOf(sim: Vehicle): FleetVehicle | undefined {
    const owner = this.owners.get(sim.id);
    return owner?.type === 'fleet' ? this.fleet.get(owner.id) : undefined;
  }

  private canArrive(sim: Vehicle): boolean {
    const v = this.fleetOf(sim);
    if (!v) return true;
    const line = this.lines.get(v.lineId);
    const st = line && this.stations.get(line.stops[v.stop]);
    return !st || st.occupied.length < st.bays;
  }

  private onArrive(sim: Vehicle): void {
    const owner = this.owners.get(sim.id);
    this.owners.delete(sim.id);
    if (owner?.type === 'citizen') {
      this.citizenCars--;
      return;
    }
    const v = owner && this.fleet.get(owner.id);
    if (!v) return;
    v.simId = null;
    const line = this.lines.get(v.lineId);
    const st = line && this.stations.get(line.stops[v.stop]);
    if (!line || !st) {
      v.state = 'departing';
      v.timer = 1;
      return;
    }
    const bay = st.kind === 'road' ? this.freeBay(st, sim.pos) : undefined;
    st.occupied.push(v.id);
    v.inBay = true;
    v.state = 'loading';
    if (bay !== undefined) {
      // Автостанция: из тупика выезда машина заезжает на свободный пост (он уже за ней), там и выгрузится.
      v.bay = bay;
      v.enter = { pos: { ...sim.pos }, dir: { ...sim.dir }, v0: sim.v, t: 0 };
      return;
    }
    this.handleStop(v, st, line);
  }

  /** Свободный пост автостанции, ближайший к точке p. */
  private freeBay(st: Station, p: Vec): number {
    const taken = new Set<number>();
    for (const id of st.occupied) {
      const bay = this.fleet.get(id)?.bay;
      if (bay !== undefined) taken.add(bay);
    }
    return nearestBay(st.fp, st.bays, taken, p);
  }

  /** Заезд на пост: доехала — выгружается и начинает погрузку. */
  private updateEntry(v: FleetVehicle, line: Line, dt: number): void {
    v.enter!.t += dt;
    const st = this.stations.get(line.stops[v.stop]);
    const pose = this.bayEntryPose(v);
    if (pose && !pose.done) return;
    delete v.enter;
    if (st) this.handleStop(v, st, line);
  }

  private onLost(sim: Vehicle): void {
    const owner = this.owners.get(sim.id);
    this.owners.delete(sim.id);
    if (owner?.type === 'citizen') {
      this.citizenCars--;
      return;
    }
    const v = owner && this.fleet.get(owner.id);
    if (!v) return;
    const line = this.lines.get(v.lineId);
    v.simId = null;
    v.state = 'departing';
    v.timer = 2;
    if (line) {
      // Машина возвращается на предыдущую станцию и пробует снова.
      v.stop = (v.stop - 1 + line.stops.length) % line.stops.length;
      line.problem = 'Машина потеряла дорогу и вернулась на станцию';
    }
  }

  private handleStop(v: FleetVehicle, st: Station, line: Line): void {
    const model = MODELS[v.model];
    let moved = 0;
    let revenue = 0;
    // Наибольшая надбавка за скорость среди доставленного — для подписи над станцией.
    let bonus = 0;
    v.dropped = null;
    if (model.carries === 'freight') {
      const what = v.cargo ? this.unloadsHere(line, v.stop, st, v.cargo) : null;
      if (v.cargo && what === 'deliver' && v.loadedAt !== st.id) {
        // Платят за расстояние от станции, где груз впервые погрузили (с учётом пересадок).
        const origin = v.loadedAt !== null ? this.stations.get(v.loadedAt) : undefined;
        const distance = origin ? dist(origin.fp.center, st.fp.center) : 0;
        const k = v.fromStore || v.loadedTime === undefined ? 1 : this.speedFactor(distance, this.time - v.loadedTime);
        bonus = Math.max(bonus, k);
        revenue += Math.round((v.amount * CARGO[v.cargo].rate * ECONOMY.tariff * distance * k) / 100);
        this.deliver(st, v.cargo, v.amount);
        moved += v.amount;
        line.carriedMonth += v.amount;
        v.dropped = v.cargo;
        v.cargo = null;
        v.amount = 0;
        v.loadedAt = null;
      } else if (v.cargo && what === 'store') {
        // Склад: выгружаем столько, сколько поместится; дальше груз повезёт другая линия.
        const c = v.cargo;
        const take = Math.min(v.amount, Math.max(0, STATION.cargoCap * 2 - (st.cargo[c] ?? 0)));
        if (take > 0) {
          st.cargo[c] = (st.cargo[c] ?? 0) + take;
          st.cargoOrigin = { ...st.cargoOrigin, [c]: v.loadedAt ?? st.id };
          v.amount -= take;
          moved += take;
          v.dropped = c;
          if (v.amount <= 0) {
            v.cargo = null;
            v.amount = 0;
            v.loadedAt = null;
          }
        }
      }
      moved += this.loadFreight(v, st, line, v.dropped);
    } else {
      const stay = [];
      for (const g of v.passengers) {
        if (g.to !== st.id) {
          stay.push(g);
          continue;
        }
        const from = this.stations.get(g.from);
        const distance = from ? dist(from.fp.center, st.fp.center) : 0;
        const k = g.at === undefined ? 1 : this.speedFactor(distance, this.time - g.at);
        bonus = Math.max(bonus, k);
        revenue += Math.round((g.count * CARGO.passengers.rate * ECONOMY.tariff * distance * k) / 100);
        moved += g.count;
        line.carriedMonth += g.count;
        const town = st.townIds.length ? this.towns.find((t) => t.id === st.townIds[0]) : undefined;
        if (town) town.growthAcc += g.count * 0.02;
      }
      v.passengers = stay;
      moved += this.boardPassengers(v, st, line);
    }
    if (revenue > 0) {
      this.earn(revenue, line, v);
      // Быстрая доставка оплачивается дороже — показываем множитель рядом с суммой.
      const fast = bonus >= 1.1 ? ` ⚡×${bonus.toFixed(1)}` : bonus > 0 && bonus <= 0.9 ? ` 🐢×${bonus.toFixed(1)}` : '';
      this.floaters.push({ pos: { ...st.fp.center }, text: `+$${revenue.toLocaleString('ru-RU')}${fast}`, color: '#2e9d57', age: 0 });
    }
    v.timer = 2 + moved * 0.1;
  }

  /**
   * Надбавка за скорость доставки: средняя скорость по прямой (с ожиданием погрузки)
   * против опорной. Медленно — до ×0.8, быстро (магистрали, поезда) — до ×1.5.
   */
  speedFactor(distance: number, seconds: number): number {
    const E = ECONOMY;
    if (distance <= 0 || seconds <= 0) return 1;
    const k = 0.75 + (0.25 * distance) / seconds / E.refSpeed;
    return Math.max(E.speedMin, Math.min(E.speedMax, k));
  }

  /** Посадка пассажиров до других остановок линии. */
  private boardPassengers(v: FleetVehicle, st: Station, line: Line): number {
    if (!st.serves.pax) return 0;
    let free = vehicleCapacity(v) - vehicleLoad(v);
    let moved = 0;
    const others = new Set(line.stops.filter((id) => id !== st.id));
    for (const [dest, count] of st.passengers) {
      if (free <= 0) break;
      if (!others.has(dest) || count <= 0) continue;
      const take = Math.min(free, count);
      st.passengers.set(dest, count - take);
      v.passengers.push({ from: st.id, to: dest, count: take, at: this.time });
      free -= take;
      moved += take;
    }
    return moved;
  }

  /**
   * Подсказки по линии: где копится груз (мало транспорта), где транспорт ездит
   * полупустым (много транспорта) и почему линия в минусе.
   */
  lineAdvice(line: Line): string[] {
    const out: string[] = [];
    const n = line.vehicles.length;
    if (!n) return out;
    // С авто-парком покупать и продавать незачем — разве что он упёрся в свой предел.
    const auto = line.auto?.on ? line.auto : null;
    line.stops.forEach((sid, i) => {
      const st = this.stations.get(sid);
      if (!st) return;
      const waiting = Math.floor(this.lineWaiting(line, i));
      if (waiting < 150 || (auto && n < auto.max)) return;
      out.push(`${st.name}: ждут отправки ${waiting} — не хватает транспорта, ${auto ? 'поднимите максимум авто-парка' : 'купите ещё'}`);
    });
    const load = line.loadLast;
    if (load !== undefined && load !== null && load < 0.35 && n >= 2 && !(auto && n > auto.min)) {
      out.push(`Рейсы уходят загруженными на ${Math.round(load * 100)}% — транспорта больше, чем груза. Продайте лишний или поставьте «Полная загрузка» на станции погрузки`);
    }
    const profit = line.revenueLast - line.costLast;
    if (profit < 0 && line.costLast > 0 && !out.length) {
      out.push('Маршрут в минусе: возите дальше (платят за расстояние), загружайте рейсы полностью или уберите лишний транспорт');
    }
    return out;
  }

  /**
   * Сколько ждёт отправки этой линией на её остановке index: груз, который здесь грузят, и пассажиры
   * до других её остановок; what — только груз или только пассажиры.
   */
  lineWaiting(line: Line, index: number, what?: 'freight' | 'passengers'): number {
    const st = this.stations.get(line.stops[index]);
    if (!st) return 0;
    let waiting = 0;
    if (what !== 'freight') {
      const others = new Set(line.stops.filter((x) => x !== st.id));
      for (const [dest, n] of st.passengers) if (others.has(dest)) waiting += n;
    }
    if (what !== 'passengers' && st.serves.cargo) for (const c of this.loadable(line, index)) waiting += st.cargo[c] ?? 0;
    return waiting;
  }

  stopRule(line: Line, index: number): StopRule {
    return line.rules?.[index] ?? DEFAULT_RULE;
  }

  /** Что делать с грузом на остановке: доставить получателю, оставить на складе или везти дальше. */
  private unloadsHere(line: Line, index: number, st: Station, cargo: CargoType): 'deliver' | 'store' | null {
    if (!st.serves.cargo) return null;
    const rule = this.stopRule(line, index);
    const listed = rule.unload === 'all' || (Array.isArray(rule.unload) && rule.unload.includes(cargo));
    if (st.accepts.has(cargo) && (rule.unload === 'auto' || listed)) return 'deliver';
    return listed ? 'store' : null;
  }

  /** Грузы, которые выгрузит хотя бы одна другая остановка линии (получателю или на склад). */
  private wantedElsewhere(line: Line, index: number): Set<CargoType> {
    const result = new Set<CargoType>();
    line.stops.forEach((sid, j) => {
      const st = this.stations.get(sid);
      if (j === index || !st?.serves.cargo) return;
      const rule = this.stopRule(line, j);
      if (rule.unload === 'all') for (const c of FREIGHT) result.add(c);
      else if (Array.isArray(rule.unload)) for (const c of rule.unload) result.add(c);
      else for (const c of st.accepts) result.add(c);
    });
    return result;
  }

  /** Что можно грузить на этой остановке. */
  private loadable(line: Line, index: number): Set<CargoType> {
    const rule = this.stopRule(line, index);
    return rule.load === 'auto' ? this.wantedElsewhere(line, index) : new Set(rule.load);
  }

  private expectsCargo(st: Station, line: Line, index: number): boolean {
    if (!st.serves.cargo) return false;
    const wanted = this.loadable(line, index);
    return this.industries.some((i) => st.industryIds.includes(i.id) && wanted.has(i.info.produces));
  }

  /**
   * Грузит (или догружает тем же грузом) грузовик. Груз со склада сохраняет станцию,
   * откуда его везут изначально. skip — то, что только что выгрузили здесь же.
   */
  private loadFreight(v: FleetVehicle, st: Station, line: Line, skip: CargoType | null = null): number {
    if (!st.serves.cargo) return 0;
    const wanted = this.loadable(line, v.stop);
    const originOf = (c: CargoType) => st.cargoOrigin?.[c] ?? st.id;
    let best: CargoType | null = v.cargo;
    if (best && v.loadedAt !== originOf(best)) return 0;
    if (!best) {
      for (const c of FREIGHT) {
        if (c === skip || !wanted.has(c) || (st.cargo[c] ?? 0) < 1) continue;
        if (!best || (st.cargo[c] ?? 0) > (st.cargo[best] ?? 0)) best = c;
      }
    }
    if (!best || !wanted.has(best)) return 0;
    const take = Math.floor(Math.min(vehicleCapacity(v) - v.amount, st.cargo[best] ?? 0));
    if (take <= 0) return 0;
    st.cargo[best] = (st.cargo[best] ?? 0) - take;
    v.cargo = best;
    v.amount += take;
    // Время доставки считаем от первой погрузки; со склада — без надбавки за скорость.
    if (v.amount === take) {
      v.loadedTime = this.time;
      v.fromStore = originOf(best) !== st.id;
    }
    v.loadedAt = originOf(best);
    return take;
  }

  private earn(amount: number, line: Line, v: FleetVehicle): void {
    this.money += amount;
    this.incomeMonth += amount;
    this.ledger.transport += amount;
    line.revenueMonth += amount;
    line.revenueTotal += amount;
    v.profitMonth += amount;
  }

  private deliver(st: Station, cargo: CargoType, amount: number): void {
    const ind = this.industries.find((i) => st.industryIds.includes(i.id) && i.info.accepts.includes(cargo));
    if (ind) {
      ind.stock[cargo] = (ind.stock[cargo] ?? 0) + amount;
      return;
    }
    const town = this.towns.find((t) => st.townIds.includes(t.id) && t.demands.includes(cargo));
    if (town) town.supplied[cargo] = (town.supplied[cargo] ?? 0) + amount;
  }

  // ---------- Производство и пассажиры ----------

  /**
   * Сколько может ждать на станции: две полные загрузки транспорта, который здесь останавливается
   * (пассажиров — автобусов и пассажирских поездов, груза — грузовиков и товарных). Больше не
   * появляется: и станция не забивается, и производство подстраивается под перевозки.
   */
  stationCap(st: Station, what: 'passengers' | 'freight'): number {
    let capacity = 0;
    for (const line of this.lines.values()) {
      if (!line.stops.includes(st.id)) continue;
      for (const id of line.vehicles) {
        const v = this.fleet.get(id);
        if (v && MODELS[v.model].carries === what) capacity += vehicleCapacity(v);
      }
    }
    return Math.max(20, Math.min(STATION.cargoCap, capacity * 2));
  }

  private updateIndustries(dt: number): void {
    for (const ind of this.industries) {
      const served = [...this.stations.values()].filter((st) => st.serves.cargo && st.industryIds.includes(ind.id) && this.served(st));
      const inputs = ind.info.accepts;
      const level = ind.level ?? 1;
      if (!inputs.length) {
        if (served.length) ind.prodAcc += (ind.info.rate * level * dt) / MONTH_LENGTH;
      } else {
        // Переработка идёт, только когда есть все виды сырья; выросший завод перерабатывает больше.
        const available = Math.min(...inputs.map((c) => ind.stock[c] ?? 0));
        const conv = Math.min(available, (120 * level * dt) / MONTH_LENGTH);
        if (conv > 0) {
          for (const c of inputs) ind.stock[c] = (ind.stock[c] ?? 0) - conv;
          ind.prodAcc += conv;
        }
      }
      const whole = Math.floor(ind.prodAcc);
      if (whole > 0) {
        ind.prodAcc -= whole;
        ind.output += whole;
        ind.producedMonth += whole;
      }
      if (ind.output >= 1 && served.length) {
        const per = Math.floor(ind.output / served.length);
        for (const st of served) {
          const c = ind.info.produces;
          st.cargo[c] = Math.min(this.stationCap(st, 'freight'), (st.cargo[c] ?? 0) + per);
        }
        ind.output -= per * served.length;
      }
      ind.output = Math.min(ind.output, 300);
    }
  }

  /**
   * Куда со станции может уехать пассажир: станция назначения → линии, где ходят автобусы
   * или пассажирские поезда. Грузовики пассажиров не берут.
   */
  paxRoutes(st: Station): Map<number, Line[]> {
    const out = new Map<number, Line[]>();
    if (!st.serves.pax) return out;
    for (const line of this.lines.values()) {
      if (!line.stops.includes(st.id)) continue;
      const carries = line.vehicles.some((id) => {
        const v = this.fleet.get(id);
        return !!v && MODELS[v.model].carries === 'passengers';
      });
      if (!carries) continue;
      for (const sid of line.stops) {
        // Пассажиры едут только на станции, которые работают с пассажирами.
        if (sid === st.id || !this.stations.get(sid)?.serves.pax) continue;
        const list = out.get(sid) ?? [];
        if (!list.includes(line)) list.push(line);
        out.set(sid, list);
      }
    }
    return out;
  }

  private updateStations(dt: number): void {
    for (const st of this.stations.values()) {
      const routes = this.paxRoutes(st);
      // Кому больше не на чем уехать (линию убрали, продали автобусы) — расходятся.
      for (const [sid, n] of st.passengers) if (n <= 0 || !routes.has(sid)) st.passengers.delete(sid);
      if (st.catchPop <= 0) continue;
      const dests = new Map<number, number>();
      for (const sid of routes.keys()) dests.set(sid, this.stations.get(sid)!.catchPop + 60);
      if (!dests.size) continue;
      st.paxAcc += (st.catchPop / 1000) * 1.2 * dt;
      let waiting = 0;
      for (const c of st.passengers.values()) waiting += c;
      const cap = this.stationCap(st, 'passengers');
      while (st.paxAcc >= 1) {
        st.paxAcc -= 1;
        if (waiting >= cap) continue;
        const total = [...dests.values()].reduce((a, b) => a + b, 0);
        let r = this.rng.range(0, total);
        for (const [sid, w] of dests) {
          r -= w;
          if (r <= 0) {
            st.passengers.set(sid, (st.passengers.get(sid) ?? 0) + 1);
            waiting++;
            break;
          }
        }
      }
    }
  }

  // ---------- Жители ----------

  private updateTowns(dt: number): void {
    for (const town of this.towns) {
      town.tripAcc += (town.population / 1000) * TOWN_TRAFFIC.tripsPerThousand * dt;
      while (town.tripAcc >= 1) {
        town.tripAcc -= 1;
        if (this.citizenCars >= TOWN_TRAFFIC.maxCars) break;
        this.spawnCitizenTrip(town);
      }
    }
  }

  private spawnCitizenTrip(town: Town): void {
    const homes = town.buildings.filter((b) => b.kind === 'res');
    if (!homes.length) return;
    const origin = this.rng.pick(homes);
    let dest: TownBuilding | undefined;
    let route: number[] | null = null;
    if (this.towns.length > 1 && this.rng.chance(TOWN_TRAFFIC.intercityShare)) {
      // Чаще ездят в ближние города.
      const others = this.towns
        .filter((t) => t !== town && t.buildings.length)
        .sort((a, b) => dist(a.center, town.center) - dist(b.center, town.center))
        .slice(0, 3);
      const other = this.rng.pick(others);
      const targets = other.buildings.filter((b) => b.kind !== 'landmark');
      dest = this.rng.pick(targets);
      route = this.roads.route(origin.anchor, dest.anchor);
    }
    if (!route) {
      const jobs = town.buildings.filter((b) => b.kind === 'com');
      dest = this.rng.pick(jobs.length ? jobs : homes);
      if (dest.anchor === origin.anchor) return;
      route = this.roads.route(origin.anchor, dest.anchor);
    }
    if (!route || !dest) return;
    const sim = this.traffic.spawn({ ...CAR_SPEC, color: this.rng.pick(CAR_COLORS), targetNode: dest.anchor, route });
    if (!sim) return;
    this.owners.set(sim.id, { type: 'citizen' });
    this.citizenCars++;
  }

  // ---------- Месяц ----------

  /** Стоимость всех дорог и путей — от неё считается ремонт. */
  roadValueTotal(): number {
    const version = this.net.version * 100003 + this.roads.net.version;
    if (this.roadValue.version !== version) {
      let total = 0;
      for (const s of this.net.segments.values()) total += this.builder.segmentCost(s);
      for (const c of this.roads.net.corridors.values()) total += corridorCost(this.roads.net, c, (p, m) => this.isWater(p, m));
      this.roadValue = { version, value: total };
    }
    return this.roadValue.value;
  }

  private monthEnd(): void {
    for (const v of this.fleet.values()) {
      const cost = this.runningCost(v);
      this.money -= cost;
      this.expensesMonth += cost;
      v.profitMonth -= cost;
      this.ledger.vehicles += cost;
      const line = this.lines.get(v.lineId);
      if (line) line.costMonth += cost;
    }
    const upkeep = Math.round(this.roadValueTotal() * ECONOMY.roadUpkeepRate * 0.3);
    this.money -= upkeep;
    this.expensesMonth += upkeep;
    this.ledger.roads += upkeep;
    if (this.loan > 0) {
      const interest = Math.round(this.loan * ECONOMY.loanRate);
      this.money -= interest;
      this.expensesMonth += interest;
      this.ledger.interest += interest;
    }

    for (const line of this.lines.values()) {
      line.revenueLast = line.revenueMonth;
      line.costLast = line.costMonth;
      line.carriedLast = line.carriedMonth;
      line.history = [...(line.history ?? []), { label: this.dateLabel, revenue: line.revenueMonth, cost: line.costMonth }].slice(-12);
      line.revenueMonth = line.costMonth = line.carriedMonth = 0;
      line.loadLast = line.departuresMonth ? (line.loadSumMonth ?? 0) / line.departuresMonth : null;
      line.loadSumMonth = line.departuresMonth = 0;
    }
    for (const v of this.fleet.values()) {
      v.profitLast = v.profitMonth;
      v.profitMonth = 0;
    }
    for (const ind of this.industries) {
      ind.producedLast = ind.producedMonth;
      ind.producedMonth = 0;
    }
    this.growIndustries();
    for (const town of this.towns) this.growTown(town);
    for (const st of this.stations.values()) this.computeCatchment(st);

    this.history.push({ label: this.dateLabel, income: this.incomeMonth, expenses: this.expensesMonth, money: this.money, ledger: { ...this.ledger } });
    if (this.history.length > 36) this.history.shift();
    this.incomeMonth = 0;
    this.expensesMonth = 0;
    this.ledger = emptyLedger();
    // Авто-парк решает по итогам окна загрузки; покупки — уже в новом месяце.
    for (const line of [...this.lines.values()]) {
      const closed = this.closeDemand(line);
      if (line.auto?.on) this.autoFleet(line, closed);
    }
    if (this.money < ECONOMY.creditLimit * 0.8) this.notify('Компания на грани банкротства!', '#e5534b');
    this.onMonthEnd();
  }

  /**
   * Предприятие растёт, если его продукцию исправно вывозят (на станциях она не копится),
   * и сокращается, если его долго никто не обслуживает. Так большим линиям и поездам есть что возить.
   */
  private growIndustries(): void {
    const E = ECONOMY;
    for (const ind of this.industries) {
      const level = ind.level ?? 1;
      const c = ind.info.produces;
      const stations = [...this.stations.values()].filter((st) => st.serves.cargo && st.industryIds.includes(ind.id) && this.served(st));
      // Копится у самого предела станции — транспорт не успевает, расти незачем.
      const piled = stations.some((st) => (st.cargo[c] ?? 0) >= this.stationCap(st, 'freight') * 0.9);
      const good = stations.length > 0 && ind.producedLast > 0 && !piled;
      let streak = ind.streak ?? 0;
      if (good) streak = Math.max(1, streak + 1);
      else if (!stations.length) streak = Math.min(-1, streak - 1);
      else streak = 0;
      if (streak >= E.growthMonths && level < E.maxLevel) {
        ind.level = Math.min(E.maxLevel, level + E.growthStep);
        streak = 0;
        if (Math.floor(ind.level) > Math.floor(level)) this.notify(`${ind.name}: производство выросло до ×${ind.level}`, '#2e9d57');
      } else if (streak <= -E.declineMonths && level > 1) {
        ind.level = Math.max(1, level - E.growthStep);
        streak = 0;
      }
      ind.streak = streak;
    }
  }

  /** Сколько предприятие производит (или может переработать) в месяц сейчас. */
  industryRate(ind: Industry): number {
    return Math.round((ind.info.accepts.length ? 120 : ind.info.rate) * (ind.level ?? 1));
  }

  /**
   * Что говорят жители: о пробках (доля стоящих машин в городе), об общественном
   * транспорте (сколько жителей рядом с обслуживаемой станцией) и о снабжении.
   */
  townReviews(town: Town): { mood: 'good' | 'ok' | 'bad'; text: string }[] {
    const out: { mood: 'good' | 'ok' | 'bad'; text: string }[] = [];
    let cars = 0;
    let stuck = 0;
    for (const v of this.traffic.vehicles.values()) {
      if (dist(v.pos, town.center) > town.radius) continue;
      cars++;
      if (v.v < 1) stuck++;
    }
    const jam = cars >= 8 ? stuck / cars : 0;
    if (jam > 0.45) out.push({ mood: 'bad', text: 'В пробках стоим подолгу. Нужны объезды, развязки или светофоры на перекрёстках' });
    else if (jam > 0.25) out.push({ mood: 'ok', text: 'В центре бывают пробки, но жить можно' });
    else out.push({ mood: 'good', text: 'По городу ездить удобно, пробок почти нет' });
    let covered = 0;
    for (const st of this.stations.values()) {
      if (!st.serves.pax || !st.townIds.includes(town.id) || !this.served(st)) continue;
      covered += st.catchPop;
    }
    const share = town.population ? covered / town.population : 0;
    if (share <= 0) out.push({ mood: 'bad', text: 'Автобусов нет — до работы и в другие города только на машине' });
    else if (share < 0.4) out.push({ mood: 'ok', text: `Автобус есть, но до остановки далеко: рядом с ней живёт ${Math.round(share * 100)}% горожан` });
    else out.push({ mood: 'good', text: 'Остановка рядом с домом, ездим на автобусе' });
    const missing = town.demands.filter((c) => (town.lastSupplied[c] ?? 0) < TOWN_NEED).map((c) => CARGO[c].name.toLowerCase());
    if (!missing.length) out.push({ mood: 'good', text: 'В магазинах всего хватает — город растёт' });
    else if (missing.length < town.demands.length) out.push({ mood: 'ok', text: `Не хватает: ${missing.join(', ')}` });
    else out.push({ mood: 'bad', text: `Пустые полки: нужны ${missing.join(', ')}` });
    return out;
  }

  /** Доля закрытых потребностей города за прошлый месяц (0…1). */
  townSatisfaction(town: Town, month: 'last' | 'current' = 'last'): number {
    const src = month === 'last' ? town.lastSupplied : town.supplied;
    const ok = town.demands.filter((c) => (src[c] ?? 0) >= TOWN_NEED).length;
    return town.demands.length ? ok / town.demands.length : 0;
  }

  /** Улицы, застроенные до отказа: id полотна → месяц, когда это выяснилось. Через год проверяем снова. */
  private readonly fullStreets = new Map<number, number>();

  /**
   * Город растёт от центра к краю: сначала застраивает свободные места у улиц поближе к центру,
   * а когда их нет — прокладывает короткую улицу у края плотной застройки. Дальше предела роста не строит.
   */
  private growTown(town: Town): void {
    town.lastSupplied = { ...town.supplied };
    town.supplied = {};
    const satisfaction = this.townSatisfaction(town);
    town.growthAcc += town.population * (0.003 + 0.025 * satisfaction);
    const ctx = this.worldContext();
    const reach = this.townReach(town);
    // Город растёт вдоль любых своих улиц, включая построенные игроком, — ближние к центру раньше.
    // Кроме магистралей, съездов и дорог развязок — к ним город не пристраивается.
    const streets = this.roads.net
      .corridorsNear(town.center, reach)
      .filter((s) => this.streetLike(s) && !this.streetFull(s.id))
      .map((s) => ({ s, hit: s.lut.closest(town.center) }))
      .filter(({ hit }) => hit.d <= reach && this.ownedBy(town, hit.point))
      .map(({ s, hit }) => ({ s, d: hit.d + this.rng.range(0, 80) }))
      .sort((a, b) => a.d - b.d);
    let tries = 0;
    for (const { s } of streets) {
      if (town.growthAcc < 20 || tries++ >= 12) break;
      const added = fillStreet(ctx, town, s, 1, Math.min(3, Math.floor(town.growthAcc / 20)), reach);
      if (added) town.growthAcc -= added * 20;
      else this.fullStreets.set(s.id, this.month);
    }
    // Мест вдоль улиц не хватает — город сам прокладывает новую улицу и застраивает её (если игрок не запретил).
    if (town.growthAcc >= 40 && town.autoStreets !== false) {
      const seg = this.growStreet(town, reach);
      if (seg) {
        // Сеть после стройки — новая: дома ставим уже по ней.
        const added = fillStreet(this.worldContext(), town, seg, 0.8, Math.floor(town.growthAcc / 20), reach);
        town.growthAcc = Math.max(0, town.growthAcc - added * 20);
      }
    }
    const before = town.population;
    recountPopulation(town);
    measureTown(town);
    if (town.population > before && satisfaction >= 1) this.notify(`${town.name} растёт: ${town.population} жителей`);
  }

  private streetFull(id: number): boolean {
    const at = this.fullStreets.get(id);
    if (at === undefined) return false;
    if (this.month - at < 12) return true;
    this.fullStreets.delete(id);
    return false;
  }

  /**
   * Как далеко от центра город может строить: чуть дальше края плотной застройки,
   * но не дальше предела по населению (если только застройка уже не дошла до него).
   */
  private townReach(town: Town): number {
    const G = TOWN_GROWTH;
    const edge = coreRadius(town);
    return Math.max(edge + G.edgeMin, Math.min(G.reachBase + G.reachK * Math.sqrt(town.population), edge + G.edgeMax));
  }

  /** Точка ближе к центру этого города, чем к центрам остальных: к ней пристраивается он, а не сосед. */
  private ownedBy(town: Town, p: Vec): boolean {
    const d = dist(p, town.center);
    return this.towns.every((t) => t === town || dist(p, t.center) > d);
  }

  /** Сколько домов города стоит ближе r к точке. */
  private housesNear(town: Town, p: Vec, r: number): number {
    return this.index.near(p, r).filter((s) => s.type === 'building' && s.townId === town.id && dist(s.fp.center, p) < r).length;
  }

  /** Городская улица: на земле, не кольцо и не часть магистрали или развязки. */
  private streetLike(c: Corridor): boolean {
    const net = this.roads.net;
    return !c.ring && net.node(c.a).level === 0 && net.node(c.b).level === 0 && !nearHighway(net, c);
  }

  /**
   * Город прокладывает новую короткую улицу у края застройки, ближе к центру — раньше: от перекрёстка
   * наружу (продолжение улицы или поперёк неё), переулок в просвете между домами, перемычку от тупика
   * к соседней улице (замыкает квартал) или продолжение тупика, вдоль которого уже стоят дома.
   * Длина — по размеру города, дальше reach от центра не уходит.
   * Без сноса, без мостов и без пересечений с чужими дорогами; бесплатно для игрока.
   * Упирается в дорогу — конец цепляется к ней, так появляются кварталы.
   */
  private growStreet(town: Town, reach: number): Corridor | null {
    const G = TOWN_GROWTH;
    const net = this.roads.net;
    const rng = this.rng;
    const center = town.center;
    const step = Math.min(G.stepMax, G.stepMin + G.stepK * Math.sqrt(town.population));
    // Полуширина новой улицы с запасом до домов.
    const half = LANE_W + 3;
    // Выезды станций — не тупики улиц: их город не продлевает и к ним не примыкает.
    const stationNodes = new Set([...this.stations.values()].map((st) => st.nodeId));
    const fits = (p: Vec) => dist(p, center) <= reach && this.inBounds(p, 80) && this.ownedBy(town, p);
    // Дорога ближе r к точке (кроме skip). Сперва — по рамке контрольных точек: кривая внутри неё.
    const nearRoad = (p: Vec, r: number, skip: Set<number>) =>
      net.corridorsNear(p, r).some((c) => {
        if (skip.has(c.id)) return false;
        const { p0, p1, p2, p3 } = c.curve;
        if (p.x < Math.min(p0.x, p1.x, p2.x, p3.x) - r || p.x > Math.max(p0.x, p1.x, p2.x, p3.x) + r) return false;
        if (p.y < Math.min(p0.y, p1.y, p2.y, p3.y) - r || p.y > Math.max(p0.y, p1.y, p2.y, p3.y) + r) return false;
        return c.lut.closest(p).d < r;
      });
    /**
     * Путь свободен: на [t0, t1] нет домов, воды и ж/д путей ближе G.spacing (ни вдоль, ни поперёк — переезды
     * город сам не строит), на [s0, s1] нет дорог вдоль ближе G.spacing (кроме skip).
     */
    const clear = (from: Vec, dir: Vec, t0: number, t1: number, s0: number, s1: number, skip: Set<number>) => {
      for (let t = t0, i = 0; t <= t1; t += 8, i++) {
        const p = add(from, scale(dir, t));
        if (this.index.at(p, half)) return false;
        if (i % 2) continue;
        if (this.isWater(p, half) || railNear(this.net, p, G.spacing)) return false;
        if (t >= s0 && t <= s1 && nearRoad(p, G.spacing, skip)) return false;
      }
      return true;
    };
    /**
     * Улица от from по dir длиной около len: упирается в дорогу (не ближе 60 и не дальше полутора len) —
     * конец на ней, иначе тупик через len (join — только с концом на дороге). Тупик — только на краю
     * застройки: впереди чисто, а не дома или дорога соседнего квартала. null — так нельзя.
     */
    const cast = (from: Vec, dir: Vec, len: number, skip: Set<number>, join = false): Anchor | null => {
      let stop = len;
      let end: Anchor | null = null;
      for (let t = 12; t <= len * 2.5; t += 6) {
        const p = add(from, scale(dir, t));
        if (this.index.at(p, half)) return null;
        if (nearRoad(p, 12, skip)) {
          if (t > len * 1.5) return null;
          end = anchorAt(net, p, 28);
          stop = t;
          break;
        }
      }
      if (!end && join) return null;
      const touches = new Set<number>();
      if (end?.kind === 'corridor') touches.add(end.corridor);
      else if (end?.kind === 'node') {
        if (stationNodes.has(end.node)) return null;
        for (const id of net.node(end.node).corridors) touches.add(id);
      }
      if (end && (end.kind === 'free' || stop < 60)) return null;
      // Примыкаем только к городским улицам, и не к той, от которой начали.
      for (const id of touches) if (skip.has(id) || !this.streetLike(net.corridor(id))) return null;
      const target = end?.pos ?? add(from, scale(dir, len));
      if (!fits(target)) return null;
      if (!clear(from, dir, 12, end ? stop - 12 : len, 25, end ? stop - 25 : len, new Set([...skip, ...touches]))) return null;
      return end ?? { kind: 'free', pos: target, level: 0 };
    };
    const cands: { start: Anchor; end: Anchor; kink: boolean; score: number }[] = [];
    /** kink — в тупик на конце улица входит изломом (он станет перекрёстком); без него — выходит из тупика плавно. */
    const push = (start: Anchor, end: Anchor | null, kink: boolean) => {
      if (!end) return;
      // Плавно из тупика в чужой тупик — крюк: такое строить не будем.
      if (!kink && end.kind === 'node' && net.isDeadEnd(net.node(end.node))) return;
      // Ближе к центру — раньше; улица, замыкающая квартал, — в первую очередь.
      const mid = scale(add(start.pos, end.pos), 0.5);
      cands.push({ start, end, kink, score: dist(mid, center) - (end.kind === 'free' ? 0 : 40) + rng.range(0, 50) });
    };
    // Перекрёстки и стыки улиц: у узлов домов нет — оттуда улица уходит в свободную сторону: продолжает
    // улицу насквозь или идёт поперёк неё (луч кольцевого города наружу, продолжение сетки, ответвление).
    const wobble = town.style === 'organic' ? 0.25 : 0.04;
    for (const n of net.nodesNear(center, reach)) {
      if (n.level !== 0 || stationNodes.has(n.id) || !this.ownedBy(town, n.pos)) continue;
      const es = net.ends(n);
      if (es.length < 2 || es.some((e) => Math.abs(e.port) > 0.5 || !this.streetLike(e.corridor))) continue;
      if (n.kind === 'seam' && es.length !== 2) continue;
      const angles = es.map((e) => angleOf(e.away));
      const dirs: number[] = [];
      for (const a of angles) {
        for (const d of [a + Math.PI, a + Math.PI / 2, a - Math.PI / 2]) {
          if (angles.every((o) => Math.abs(angleDiff(o, d)) > 1) && dirs.every((o) => Math.abs(angleDiff(o, d)) > 0.3)) dirs.push(d);
        }
      }
      const skip = new Set(n.corridors);
      for (const d of dirs) {
        const a = d + rng.range(-wobble, wobble);
        push({ kind: 'node', node: n.id, pos: n.pos }, cast(n.pos, { x: Math.cos(a), y: Math.sin(a) }, rng.range(0.8, 1) * step, skip), true);
      }
    }
    // Тупики городских улиц.
    const bend = town.style === 'organic' ? 0.3 : 0.06;
    const ends = net
      .nodesNear(center, reach)
      .filter(
        (n) =>
          net.isDeadEnd(n) &&
          n.level === 0 &&
          n.corridors.length === 1 &&
          !stationNodes.has(n.id) &&
          this.streetLike(net.corridor(n.corridors[0])) &&
          this.ownedBy(town, n.pos),
      );
    for (const n of ends) {
      const start: Anchor = { kind: 'node', node: n.id, pos: n.pos };
      const out = scale(net.ends(n)[0].away, -1);
      const skip = new Set(n.corridors);
      // Перемычка вбок — к соседней улице: замыкает квартал (тупик становится перекрёстком).
      for (const side of [1, -1]) push(start, cast(n.pos, { x: -out.y * side, y: out.x * side }, step, skip, true), true);
      // Перемычка к соседнему тупику, смотрящему туда же, — концы параллельных переулков.
      for (const m of ends) {
        const d = dist(m.pos, n.pos);
        if (m.id <= n.id || d < 60 || d > step * 1.6 || m.corridors[0] === n.corridors[0] || !fits(m.pos)) continue;
        const chord = scale(sub(m.pos, n.pos), 1 / d);
        if (dot(out, scale(net.ends(m)[0].away, -1)) < 0.5 || Math.abs(dot(chord, out)) > 0.5) continue;
        if (clear(n.pos, chord, 12, d - 12, 25, d - 25, new Set([...n.corridors, ...m.corridors]))) push(start, { kind: 'node', node: m.id, pos: m.pos }, true);
      }
      // Продолжение — только у тупика, вдоль которого уже стоят дома: без «отростков» в чистом поле.
      if (this.housesNear(town, n.pos, 80) < G.builtUp) continue;
      const a = angleOf(out) + rng.range(-bend, bend);
      push(start, cast(n.pos, { x: Math.cos(a), y: Math.sin(a) }, rng.range(0.7, 1) * step, skip), false);
    }
    // Переулки поперёк улиц — в просветах между домами.
    const streets = net.corridorsNear(center, reach).filter((s) => this.streetLike(s) && s.length > 100 && s.lut.closest(center).d <= reach);
    for (let k = 0; k < 24 && streets.length; k++) {
      const s = rng.pick(streets);
      const side = rng.chance(0.5) ? 1 : -1;
      const span = s.length - 80;
      const off = rng.range(0, span);
      for (let i = 0; i < span; i += 8) {
        const at = 40 + ((off + i) % span);
        const p = s.lut.pointAt(at);
        const t = s.lut.tangentAt(at);
        const dir = { x: -t.y * side, y: t.x * side };
        // У самой улицы стоит дом — просвета нет.
        if (this.index.at(add(p, scale(dir, 16)), half) || !fits(p)) continue;
        const end = cast(p, dir, rng.range(0.8, 1) * step, new Set([s.id]));
        if (!end) continue;
        push({ kind: 'corridor', corridor: s.id, s: at, pos: p }, end, true);
        break;
      }
    }
    cands.sort((x, y) => x.score - y.score);
    for (const c of cands.slice(0, 8)) {
      const plan = this.roadBuilder.road(c.start, c.end, { cls: 'street', lanes: twoWay(1, 1), kink: c.kink }, { free: true });
      if (!plan.ok || plan.demolish.length || !plan.net) continue;
      // Без пересечений с другими дорогами: новых узлов — только концы новой улицы.
      const fresh = [...plan.net.nodes.keys()].filter((id) => !net.nodes.has(id)).length;
      if (fresh > (c.start.kind === 'corridor' ? 1 : 0) + (c.end.kind === 'node' ? 0 : 1)) continue;
      const added = plan.changed.map((id) => plan.net!.corridor(id)).filter((x) => !net.corridors.has(x.id));
      // История Ctrl+Z не сбрасывается: отмена уберёт и эту улицу, и дома вдоль неё.
      this.roadBuilder.apply(plan);
      // Новая улица — та, что соединяет оба конца (а не куски разрезанной ею).
      const joins = (x: Corridor, p: Vec) => dist(x.curve.p0, p) < 3 || dist(x.curve.p3, p) < 3;
      return added.find((x) => joins(x, c.start.pos) && joins(x, c.end.pos)) ?? added.sort((x, y) => y.length - x.length)[0] ?? null;
    }
    return null;
  }

  // ---------- Станции ----------

  /**
   * Вокзал на прямом участке пути: главный путь — первая платформа, рядом (со стороны курсора)
   * обгонный путь со второй платформой и плавными S-образными съездами, за ним здание вокзала.
   */
  private railStationPlan(p: Vec, snapRadius: number, angle: number, tracks: number): StationPlan {
    const R = RAIL_STATION;
    const fail = (reason: string, fp: Footprint | null = null, cost = R.cost * (tracks - 1)): StationPlan => ({
      ok: false,
      reason,
      cost,
      fp,
    });
    const hit = this.net.findSegmentNear(
      p,
      Math.max(70, snapRadius * 2),
      (s) => isRail(s.spec) && s.platform === undefined && this.net.isFlat(s) && this.net.node(s.a).level === 0,
    );
    // Чем дальше крайний путь, тем длиннее съезды — чтобы стрелки оставались пологими.
    const switchLen = R.switchLen + 45 * (tracks - 2);
    const half = R.platform / 2 + switchLen;
    const margin = MIN_SEGMENT_LEN + 20;
    // Путь, на который ставим станцию: существующий или новый прямой участок в чистом поле.
    let seg: { id: number; lut: CurveLUT; length: number };
    let sc: number;
    let main: RoadRequest | undefined;
    let mainCost = 0;
    // Что мешает главному пути в чистом поле — скажем после того, как посчитаем силуэт станции (он красным).
    let mainProblem: string | undefined;
    if (hit) {
      seg = hit.seg;
      if (seg.length < 2 * (half + margin)) return fail('Нужен длинный прямой участок пути');
      sc = Math.max(half + margin, Math.min(seg.length - half - margin, hit.s));
    } else {
      const dir = { x: Math.cos(angle), y: Math.sin(angle) };
      const total = 2 * (half + margin);
      const a = sub(p, scale(dir, total / 2));
      const b = add(p, scale(dir, total / 2));
      main = { start: { kind: 'free', pos: a, level: 0 }, end: { kind: 'free', pos: b, level: 0 }, spec: RAIL_SPEC, mode: 'straight' };
      const mp = this.builder.plan(main);
      if (!mp.ok) mainProblem = mp.reason ?? 'Нельзя построить путь';
      else if (mp.crossings.length || mp.demolish.length) mainProblem = 'Мешает дорога или здание';
      mainCost = mp.cost;
      const lut = new CurveLUT(straightCubic(a, b));
      seg = { id: -1, lut, length: lut.length };
      sc = total / 2;
    }
    const t = seg.lut.tangentAt(sc);
    const center = seg.lut.pointAt(sc);
    const cuts: [number, number, number, number] = [sc - half, sc - R.platform / 2, sc + R.platform / 2, sc + half];
    const curved = cuts.some((s) => dot(seg.lut.tangentAt(s), t) < Math.cos(0.06));
    // Дополнительные пути и здание — со стороны курсора (в чистом поле — слева от направления, R поворачивает).
    const n = hit && cross(t, sub(p, center)) < 0 ? { x: t.y, y: -t.x } : { x: -t.y, y: t.x };
    const j0 = seg.lut.pointAt(cuts[0]);
    const j1 = seg.lut.pointAt(cuts[3]);
    const h = switchLen * 0.4;
    const extra: [Cubic, Cubic, Cubic][] = [];
    for (let k = 1; k < tracks; k++) {
      const a = add(seg.lut.pointAt(cuts[1]), scale(n, R.spacing * k));
      const b = add(seg.lut.pointAt(cuts[2]), scale(n, R.spacing * k));
      extra.push([
        { p0: j0, p1: add(j0, scale(t, h)), p2: sub(a, scale(t, h)), p3: a },
        straightCubic(a, b),
        { p0: b, p1: add(b, scale(t, h)), p2: sub(j1, scale(t, h)), p3: j1 },
      ]);
    }
    const fp: Footprint = {
      center: add(center, scale(n, R.spacing * (tracks - 1) + RAIL_HALF + 4 + R.size.h / 2)),
      w: R.size.w,
      h: R.size.h,
      angle: angleOf(t),
    };
    let length = 0;
    const samples: Vec[] = [];
    for (const c of extra.flat()) {
      const lut = new CurveLUT(c);
      length += lut.length;
      for (let s = 8; s < lut.length; s += 8) samples.push(lut.pointAt(s));
    }
    // Каждая дополнительная платформа — ещё одна стоимость станции.
    const cost = Math.round(length * specCost(RAIL_SPEC)) + R.cost * (tracks - 1) + mainCost;
    // Нельзя — силуэт (здание, пути с платформами и главный путь) всё равно показываем, красным.
    const rail = { segId: seg.id, cuts, tracks: extra, main };
    const blocked = (reason: string): StationPlan => ({ ...fail(reason, fp, cost), rail });
    if (curved) return blocked('Ж/д станция — только на прямом участке пути');
    if (mainProblem) return blocked(mainProblem);
    if (!this.inBounds(fp.center, 30) || samples.some((q) => !this.inBounds(q, 20))) return blocked('За краем карты');
    if (this.isWater(fp.center, footprintRadius(fp) * 0.6) || samples.some((q) => this.isWater(q, RAIL_HALF))) return blocked('Мешает вода');
    if (this.index.overlaps(fp, 3) || samples.some((q) => this.blocked(q, RAIL_HALF + 2))) return blocked('Мешает здание');
    // Другие дороги и пути не должны задевать второй путь и здание.
    const u = { x: Math.cos(fp.angle), y: Math.sin(fp.angle) };
    const v = { x: -u.y, y: u.x };
    const probes = [...samples];
    for (let i = -2; i <= 2; i++) for (let k = -1; k <= 1; k++) probes.push(add(fp.center, add(scale(u, (i * fp.w) / 4), scale(v, (k * fp.h) / 2))));
    for (const q of probes) {
      for (const s of this.net.segmentsNear(q, 40)) {
        if (s.id === seg.id) continue;
        if (s.lut.closest(q).d < halfWidth(s.spec) + RAIL_HALF + 2) return blocked(isRail(s.spec) ? 'Мешает другой путь' : 'Мешает дорога');
      }
      for (const c of this.roads.net.corridorsNear(q, 60)) {
        const hit = c.lut.closest(q);
        if (hit.d < halfAtS(c, hit.s) + RAIL_HALF + 2) return blocked('Мешает дорога');
      }
    }
    if (cost > this.budget) return blocked('Не хватает денег');
    return { ok: true, cost, fp, rail };
  }

  /** angle — поворот ж/д станции в чистом поле, tracks — сколько у неё путей с платформами (2–4). */
  stationPlan(p: Vec, snapRadius: number, kind: StationKind = 'road', angle = 0, tracks = 2): StationPlan {
    if (kind === 'rail') return this.railStationPlan(p, snapRadius, angle, Math.max(2, Math.min(4, tracks)));
    if (kind === 'stop') return this.stopPlan(p, snapRadius);
    // Нельзя — силуэт станции всё равно показываем, красным.
    const fail = (reason: string, fp: Footprint): StationPlan => ({ ok: false, reason, cost: COST.station, fp });
    // Курсор у предприятия — пристраиваем станцию к нему с этой стороны.
    const ind = this.industries.find((i) => pointInFootprint(p, i.fp, 80));
    if (ind) return this.industryStationPlan(ind, p);
    const hit = this.streetNear(p, Math.max(40, snapRadius));
    // У перекрёстка (или у самого конца полотна) выезд примыкает прямо к узлу — станция «примагничивается».
    const edge = MIN_SEGMENT_LEN + 8;
    const endId = hit && (hit.s < edge ? hit.seg.a : hit.seg.length - hit.s < edge ? hit.seg.b : null);
    if (hit && endId !== null) {
      const end = this.roads.net.node(endId);
      if (this.stationJoinable(end)) return this.junctionStationPlan(end, p);
      const fp = this.drivewayFootprint(hit.seg.lut.pointAt(hit.s), normalTowards(hit.seg, hit.s, p), halfAtS(hit.seg, hit.s));
      return fail('Слишком близко к перекрёстку', fp);
    }
    // Рядом с дорогой магнит небольшой (иначе в городе всё липло бы к перекрёсткам), в стороне от дорог — побольше.
    const magnet = hit ? Math.max(30, Math.min(50, snapRadius * 2)) : 80;
    const junction = this.roads.net
      .nodesNear(p, magnet)
      .filter((n) => this.stationJoinable(n))
      .sort((x, y) => dist(x.pos, p) - dist(y.pos, p))[0];
    if (junction) return this.junctionStationPlan(junction, p);
    if (!hit) {
      // Рядом только магистраль: вдоль быстрых дорог станций нет — силуэт всё равно у неё, с понятной причиной.
      const fast = this.roadNear(p, Math.max(40, snapRadius), (c) => isTrunk(c.cls));
      if (fast) {
        const fp = this.drivewayFootprint(fast.seg.lut.pointAt(fast.s), normalTowards(fast.seg, fast.s, p), halfAtS(fast.seg, fast.s));
        return fail('К магистрали станцию не пристроить', fp);
      }
      return fail('Поставьте рядом с дорогой', this.looseFootprint(p, STATION.size));
    }
    const seg = hit.seg;
    const from: Anchor = { kind: 'corridor', corridor: seg.id, s: hit.s, pos: seg.lut.pointAt(hit.s) };
    return this.drivewayStationPlan(from, normalTowards(seg, hit.s, p), halfAtS(seg, hit.s));
  }

  /**
   * Автобусная остановка: навес у края улицы со стороны курсора, улица в этом месте режется стыком —
   * это узел остановки: автобусы встают у неё прямо в полосе. Не у перекрёстка и не рядом с другой остановкой.
   */
  private stopPlan(p: Vec, snapRadius: number): StationPlan {
    const fail = (reason: string, fp: Footprint | null = null): StationPlan => ({ ok: false, reason, cost: STOP.cost, fp });
    const hit = this.streetNear(p, Math.max(30, snapRadius));
    if (!hit) return fail('Поставьте у городской улицы', this.looseFootprint(p, STOP.size));
    const c = hit.seg;
    const net = this.roads.net;
    // Конец улицы, где перекрёсток или тупик, — далеко; стык (продолжение улицы) не мешает.
    const near = (end: 'a' | 'b') => {
      const n = net.node(end === 'a' ? c.a : c.b);
      return n.kind === 'junction' || net.isDeadEnd(n);
    };
    const s = hit.s;
    const t = c.lut.tangentAt(s);
    const point = c.lut.pointAt(s);
    const side = normalTowards(c, s, p);
    const fp: Footprint = {
      center: add(point, scale(side, halfAtS(c, s) + 2 + STOP.size.h / 2)),
      w: STOP.size.w,
      h: STOP.size.h,
      angle: Math.atan2(t.y, t.x),
    };
    if ((s < STOP.gap && near('a')) || (c.length - s < STOP.gap && near('b'))) return fail('Слишком близко к перекрёстку', fp);
    if (s < 10 || c.length - s < 10) return fail('Слишком близко к узлу', fp);
    // Другие остановки и станции рядом на этой же улице.
    for (const st of this.stations.values()) {
      if (st.kind !== 'stop' && dist(st.fp.center, fp.center) > STOP.gap) continue;
      if (dist(st.fp.center, fp.center) < (st.kind === 'stop' ? STOP.gap * 2 : STOP.gap)) return fail('Рядом уже есть остановка', fp);
    }
    if (this.isWater(fp.center, 4)) return fail('Мешает вода', fp);
    const under = this.structuresUnder(fp, 1);
    if (under.blocker) return fail(under.blocker, fp);
    const id = c.id;
    const plan = this.roadBuilder.plan((n) => {
      splitCorridor(n, n.corridor(id), s, 'seam');
    });
    const cost = STOP.cost + this.demolishTotal(under.houses);
    if (!plan.ok) return { ...fail(plan.reason ?? 'Нельзя поставить', fp), cost };
    if (cost > this.budget) return { ...fail('Не хватает денег', fp), cost };
    return { ok: true, cost, fp, driveway: plan, nodePos: point, demolish: under.houses };
  }

  /** К узлу можно примкнуть выезд станции: перекрёсток или тупик обычных дорог на земле (не выезд другой станции). */
  private stationJoinable(n: LaneNode): boolean {
    const net = this.roads.net;
    if (n.level !== 0 || (n.roundabout ?? null) !== null || !n.corridors.length) return false;
    if (n.kind !== 'junction' && !net.isDeadEnd(n)) return false;
    if ([...this.stations.values()].some((st) => st.nodeId === n.id)) return false;
    return n.corridors.every((sid) => {
      const s = net.corridor(sid);
      return !s.ring && !isTrunk(s.cls);
    });
  }

  /**
   * Станция у перекрёстка: выезд прямо из узла в свободный промежуток со стороны курсора —
   * лучше напротив одной из дорог или под прямым углом к ней, но не ближе STATION_JOIN_GAP к соседним.
   */
  private junctionStationPlan(node: LaneNode, p: Vec): StationPlan {
    const ends = this.roads.net.ends(node);
    const arms = ends.map((e) => angleOf(e.away));
    const clearance = Math.max(...ends.map((e) => corridorHalf(e.corridor))) + 6;
    const gapTo = (a: number) => Math.min(...arms.map((b) => Math.abs(angleDiff(a, b))));
    const toCursor = sub(p, node.pos);
    const aim = Math.hypot(toCursor.x, toCursor.y) > 6 ? angleOf(toCursor) : null;
    // Варианты по убыванию предпочтения: напротив дороги, под прямым углом, середина промежутка.
    const sorted = [...arms].sort((x, y) => x - y);
    const options = [
      ...arms.map((b) => ({ a: b + Math.PI, penalty: 0 })),
      ...arms.flatMap((b) => [b + Math.PI / 2, b - Math.PI / 2].map((a) => ({ a, penalty: 0.05 }))),
      ...sorted.map((b, i) => ({ a: (b + (i + 1 < sorted.length ? sorted[i + 1] : sorted[0] + Math.PI * 2)) / 2, penalty: 0.2 })),
    ];
    const picked: { a: number; score: number }[] = [];
    for (const o of options) {
      if (gapTo(o.a) < STATION_JOIN_GAP) continue;
      // Только со стороны курсора.
      if (aim !== null && Math.abs(angleDiff(o.a, aim)) > Math.PI / 2) continue;
      if (picked.some((x) => Math.abs(angleDiff(x.a, o.a)) < 0.05)) continue;
      picked.push({ a: o.a, score: (aim === null ? -gapTo(o.a) : Math.abs(angleDiff(o.a, aim))) + o.penalty });
    }
    picked.sort((x, y) => x.score - y.score);
    const from: Anchor = { kind: 'node', node: node.id, pos: node.pos };
    let first: StationPlan | null = null;
    // Если лучшее направление занято, пробуем соседние с той же стороны.
    for (const c of picked.slice(0, 4)) {
      const plan = this.drivewayStationPlan(from, { x: Math.cos(c.a), y: Math.sin(c.a) }, clearance);
      if (plan.ok) return plan;
      first ??= plan;
    }
    if (first) return first;
    // Места нет — силуэт к курсору (курсор над узлом — в самый широкий промежуток).
    const a = aim ?? options.reduce((x, y) => (gapTo(y.a) > gapTo(x.a) ? y : x), { a: 0 }).a;
    const fp = this.drivewayFootprint(node.pos, { x: Math.cos(a), y: Math.sin(a) }, clearance);
    return { ok: false, reason: 'У перекрёстка нет места для выезда', cost: COST.station, fp };
  }

  /** Площадка автостанции в конце выезда от from по dir (clearance — отступ от оси дороги): длинной стороной к выезду. */
  private drivewayFootprint(from: Vec, dir: Vec, clearance: number): Footprint {
    const center = add(from, scale(dir, clearance + STATION.driveway + STATION.size.h / 2 + 4));
    // Посты погрузки смотрят на выезд.
    return { center, w: STATION.size.w, h: STATION.size.h, angle: Math.atan2(dir.x, -dir.y) };
  }

  /** Силуэт станции, которую не к чему пристроить: под курсором, вдоль ближайшей дороги (если она недалеко). */
  private looseFootprint(p: Vec, size: { w: number; h: number }): Footprint {
    let angle = 0;
    let best = 150;
    for (const c of this.roads.net.corridorsNear(p, best)) {
      const hit = c.lut.closest(p);
      if (hit.d >= best) continue;
      best = hit.d;
      angle = angleOf(c.lut.tangentAt(hit.s));
    }
    return { center: p, w: size.w, h: size.h, angle };
  }

  /**
   * Автостанция в конце выезда: выезд идёт от from по dir (clearance — отступ от оси дороги),
   * станция стоит к нему длинной стороной. Дома под станцией сносятся за доплату.
   */
  private drivewayStationPlan(from: Anchor, dir: Vec, clearance: number): StationPlan {
    const nodePos = add(from.pos, scale(dir, clearance + STATION.driveway));
    const fp = this.drivewayFootprint(from.pos, dir, clearance);
    const plan = this.roadBuilder.road(from, { kind: 'free', pos: nodePos }, DRIVEWAY);
    const fail = (reason: string, cost = plan.cost + COST.station): StationPlan => ({ ok: false, reason, cost, fp, driveway: plan, from });
    if (!this.inBounds(fp.center, 30)) return fail('За краем карты');
    if (this.isWater(fp.center, footprintRadius(fp)) || this.isWater(nodePos, 8)) return fail('Мешает вода');
    const under = this.structuresUnder(fp, 3);
    if (under.blocker) return fail(under.blocker);
    const road = this.roadUnder(fp, 3);
    if (road) return fail(road);
    // Дома под выездом сносит строитель — их цена уже в цене выезда.
    const demolish = under.houses.filter((id) => !plan.demolish.includes(id));
    const cost = plan.cost + COST.station + this.demolishTotal(demolish);
    if (!plan.ok) return fail(plan.reason ?? 'Нельзя построить', cost);
    if (cost > this.budget) return fail('Не хватает денег', cost);
    return { ok: true, cost, fp, driveway: plan, from, nodePos, demolish };
  }

  placeStation(
    p: Vec,
    snapRadius: number,
    kind: StationKind = 'road',
    serves: StationServes = ALL_SERVICES,
    angle = 0,
    tracks = 2,
  ): Station | null {
    const plan = this.stationPlan(p, snapRadius, kind, angle, tracks);
    if (!plan.ok || !plan.fp) return null;
    const id = this.nextEntityId++;
    let nodeId = -1;
    let platforms: number[] = [];
    if (plan.rail) {
      // Главный путь в чистом поле оплачивает строитель — доплачиваем остальное.
      const before = this.money;
      platforms = this.buildRailStation(id, plan.rail);
      if (platforms.length < 2) return null;
      this.spend(plan.cost - (before - this.money));
    } else {
      if (!plan.driveway || !plan.nodePos || !this.roadBuilder.apply(plan.driveway)) return null;
      // Узел станции — тупик выезда (у остановки — стык посреди улицы).
      const node = this.roads.net.nodesNear(plan.nodePos, 2)[0];
      if (!node) return null;
      nodeId = node.id;
      this.spend(kind === 'stop' ? STOP.cost : COST.station);
      // Дома на месте станции (под выездом их уже снёс строитель).
      if (plan.demolish?.length) {
        const cost = this.demolishTotal(plan.demolish);
        this.demolish(plan.demolish);
        this.spend(cost);
      }
    }
    const ind = plan.industryId !== undefined ? this.industries.find((i) => i.id === plan.industryId) : undefined;
    const st: Station = {
      type: 'station',
      id,
      kind,
      name: '',
      fp: plan.fp,
      nodeId,
      platforms,
      // Остановка — только для пассажиров.
      serves: kind === 'stop' ? { pax: true, cargo: false } : { ...serves },
      industryId: ind?.id ?? null,
      cargo: {},
      passengers: new Map(),
      occupied: [],
      bays: plan.rail ? platforms.length : kind === 'stop' ? STOP.bays : STATION.bays,
      townIds: [],
      industryIds: [],
      accepts: new Set(),
      catchPop: 0,
      paxAcc: 0,
    };
    this.computeCatchment(st);
    st.name = this.stationName(st, ind);
    this.stations.set(id, st);
    this.index.add(st);
    return st;
  }

  /** Имя по предприятию, к которому пристроена станция, или по ближайшему городу. */
  private stationName(st: Station, ind: Industry | undefined): string {
    const at = st.fp.center;
    const nearest = this.towns.reduce<Town | null>((best, t) => (!best || dist(t.center, at) < dist(best.center, at) ? t : best), null);
    const inTown = !!nearest && dist(nearest.center, at) < nearest.radius + 400;
    // Остановки нумеруются по городу: «Медведково, ост. 3».
    if (st.kind === 'stop') {
      const base = `${inTown ? `${nearest!.name}, ` : ''}ост. `;
      const used = new Set([...this.stations.values()].filter((s) => s.name.startsWith(base)).map((s) => s.name));
      let n = 1;
      while (used.has(`${base}${n}`)) n++;
      return `${base}${n}`;
    }
    // Вокзал вне города называется по предприятию в охвате.
    const served = !inTown && st.kind === 'rail' ? this.stationIndustries(st)[0] : undefined;
    const named = ind ?? served;
    const prefix = named ? named.name : inTown ? nearest!.name : st.kind === 'rail' ? 'Разъезд' : 'Станция';
    const count = [...this.stations.values()].filter((s) => s.name.startsWith(prefix)).length + 1;
    return (inTown || named) && count === 1 ? prefix : `${prefix}-${count}`;
  }

  /**
   * Режет главный путь в четырёх точках, кладёт обгонный путь и помечает обе платформы.
   * Возвращает id платформ: главная, обгонная.
   */
  private buildRailStation(id: number, g: RailStationGeom): number[] {
    const net = this.net;
    let cur = g.segId;
    if (g.main) {
      // В чистом поле сначала кладём главный путь — с тупиками по краям для подключения.
      const built = this.builder.build(g.main);
      if (!built) return [];
      cur = net.node(built.endNode).segments[0];
    }
    const nodes: number[] = [];
    let platform1 = -1;
    // Режем с дальнего конца: начальная часть сохраняет отсчёт длины от начала пути.
    for (let k = 3; k >= 0; k--) {
      const s = net.segment(cur);
      const res = net.splitSegmentDetailed(cur, s.lut.tAt(g.cuts[k]));
      nodes.unshift(res.node.id);
      if (k === 1) platform1 = res.second.id;
      cur = res.first.id;
    }
    const [j0, a1, b1, j1] = nodes;
    net.node(a1).buildingId = id;
    net.node(b1).buildingId = id;
    net.segment(platform1).platform = id;
    const platforms = [platform1];
    // Дополнительные пути: съезд от стрелки, платформа, съезд к стрелке.
    for (const [down, platform, up] of g.tracks) {
      const a = net.addNode(down.p3, 0, id);
      const b = net.addNode(platform.p3, 0, id);
      net.addSegment(j0, a.id, down, RAIL_SPEC);
      const p = net.addSegment(a.id, b.id, platform, RAIL_SPEC);
      net.addSegment(b.id, j1, up, RAIL_SPEC);
      p.platform = id;
      platforms.push(p.id);
    }
    this.networkChanged();
    return platforms;
  }

  removeStation(st: Station): boolean {
    if (this.stationLines(st.id).length) {
      this.notify('Станцию используют маршруты — сначала удалите их');
      return false;
    }
    this.index.remove(st);
    this.stations.delete(st.id);
    if (st.kind === 'rail') {
      this.removeRailStation(st);
      this.refund(RAIL_STATION.cost * Math.max(1, st.platforms.length - 1));
      this.networkChanged();
      return true;
    }
    // Остановка стоит прямо на улице — улица остаётся.
    if (st.kind === 'stop') {
      this.refund(STOP.cost);
      return true;
    }
    // Выезд станции сносится вместе с ней.
    const node = this.roads.net.nodes.get(st.nodeId);
    if (node?.corridors.length) {
      const plan = this.roadBuilder.bulldoze([...node.corridors]);
      if (plan.net) this.roadBuilder.apply({ ...plan, ok: true });
    }
    // Добавленные посты погрузки тоже возвращают часть цены.
    this.refund(COST.station + Math.max(0, st.bays - STATION.bays) * STATION.bayCost);
    this.networkChanged();
    return true;
  }

  /**
   * Сколько постов погрузки можно сделать на автостанции: с каждым постом площадка
   * становится длиннее (в обе стороны вдоль дороги), и ей не должны мешать дома, дороги и вода.
   */
  stationBaysPlan(id: number, bays: number): BaysPlan {
    const st = this.stations.get(id);
    if (!st) return { ok: false, reason: 'Станции нет', cost: 0, fp: null };
    if (st.kind === 'rail') return { ok: false, reason: 'У ж/д станции столько постов, сколько платформ', cost: 0, fp: st.fp };
    if (st.kind === 'stop') return { ok: false, reason: `У остановки ${STOP.bays} места для автобусов`, cost: 0, fp: st.fp };
    const n = Math.round(bays);
    const extra = n - st.bays;
    const fp: Footprint = { ...st.fp, w: st.fp.w + extra * STATION.bayWidth };
    const cost = extra * STATION.bayCost;
    const fail = (reason: string): BaysPlan => ({ ok: false, reason, cost, fp });
    if (n < STATION.minBays) return fail(`Постов не может быть меньше ${STATION.minBays}`);
    if (n > STATION.maxBays) return fail(`Больше ${STATION.maxBays} постов нельзя`);
    if (extra <= 0) return { ok: true, cost, fp };
    if (!this.inBounds(fp.center, footprintRadius(fp))) return fail('За краем карты');
    // Площадка растёт в обе стороны: проверяем новые края.
    const u = { x: Math.cos(fp.angle), y: Math.sin(fp.angle) };
    const grown: Vec[] = [];
    for (let x = st.fp.w / 2; x <= fp.w / 2 + 0.01; x += 6) for (const k of [-1, 1]) grown.push(add(fp.center, scale(u, k * x)));
    if (grown.some((q) => this.isWater(q, fp.h / 2))) return fail('Мешает вода');
    const own = st.industryId !== null ? this.industries.find((i) => i.id === st.industryId) : undefined;
    for (const s of this.index.near(fp.center, footprintRadius(fp) + 120)) {
      if (s === st || s === own || !footprintsOverlap(fp, s.fp, 1)) continue;
      return fail(s.type === 'building' ? 'Мешает здание' : s.type === 'industry' ? 'Мешает предприятие' : 'Мешает станция');
    }
    const road = this.roadUnder(fp, 2, st.nodeId);
    if (road) return fail(road);
    if (cost > this.budget) return fail('Не хватает денег');
    return { ok: true, cost, fp };
  }

  /** Добавляет или убирает посты погрузки (одним шагом для Ctrl+Z). Возвращает причину, если не получилось. */
  setStationBays(id: number, bays: number): string | null {
    const plan = this.stationBaysPlan(id, bays);
    const st = this.stations.get(id);
    if (!plan.ok || !plan.fp || !st) return plan.reason ?? 'Нельзя';
    this.checkpoint('посты станции');
    if (plan.cost > 0) this.spend(plan.cost);
    else if (plan.cost < 0) this.refund(-plan.cost);
    this.index.remove(st);
    st.fp = plan.fp;
    st.bays = Math.round(bays);
    this.index.add(st);
    this.commit();
    return null;
  }

  /** Главный путь остаётся, дополнительные пути со съездами разбираются. */
  private removeRailStation(st: Station): void {
    const net = this.net;
    const segs = st.platforms.map((id) => net.segments.get(id));
    for (const seg of segs) {
      if (!seg) continue;
      seg.platform = undefined;
      for (const nid of [seg.a, seg.b]) {
        const n = net.nodes.get(nid);
        if (n?.buildingId === st.id) n.buildingId = null;
      }
    }
    const remove = new Set<number>();
    for (const loop of segs.slice(1)) {
      if (!loop) continue;
      remove.add(loop.id);
      for (const nid of [loop.a, loop.b]) for (const sid of net.nodes.get(nid)?.segments ?? []) if (net.isRailSeg(sid)) remove.add(sid);
    }
    for (const sid of remove) {
      const seg = net.segments.get(sid);
      if (seg) this.refund(this.builder.segmentCost(seg));
      net.removeSegment(sid);
    }
  }

  /** Радиус охвата: у вокзала больше, чем у автостанции. */
  catchmentRadius(st: Pick<Station, 'kind'>): number {
    return st.kind === 'rail' ? RAIL_STATION.catchment : st.kind === 'stop' ? STOP.catchment : STATION.catchment;
  }

  computeCatchment(st: Station): void {
    const R = this.catchmentRadius(st);
    st.industryIds = this.industries
      .filter((i) => dist(i.fp.center, st.fp.center) < R + footprintRadius(i.fp) * 0.6)
      .map((i) => i.id);
    const towns = new Set<number>();
    let pop = 0;
    for (const town of this.towns) {
      if (dist(town.center, st.fp.center) > (town.extent ?? town.radius) + R + 50) continue;
      for (const b of town.buildings) {
        if (dist(b.fp.center, st.fp.center) > R) continue;
        towns.add(town.id);
        pop += b.kind === 'res' ? b.floors * 14 : b.floors * 6;
      }
    }
    st.townIds = [...towns];
    // Пассажирская станция собирает жителей, грузовая принимает грузы.
    st.catchPop = st.serves.pax ? pop : 0;
    st.accepts = new Set();
    if (!st.serves.cargo) return;
    for (const i of this.industries) if (st.industryIds.includes(i.id)) for (const c of i.info.accepts) st.accepts.add(c);
    for (const t of this.towns) if (towns.has(t.id)) for (const c of t.demands) st.accepts.add(c);
  }

  /** Меняет, с чем работает станция: хотя бы что-то одно должно остаться. */
  setStationServes(id: number, serves: StationServes): void {
    const st = this.stations.get(id);
    if (!st || (!serves.pax && !serves.cargo)) return;
    st.serves = { ...serves };
    if (!serves.pax) st.passengers.clear();
    if (!serves.cargo) st.cargo = {};
    this.computeCatchment(st);
  }

  /**
   * Подсказки «что с чем соединять»: ближайшие потребители продукции и поставщики сырья.
   * direction 'out' — куда везти отсюда, 'in' — откуда везти сюда.
   */
  partners(target: Industry | Town, perCargo = 2): Partner[] {
    const result: Partner[] = [];
    const from = 'fp' in target ? target.fp.center : target.center;
    const add = (cargo: CargoType, direction: 'in' | 'out', candidates: (Industry | Town)[]) => {
      candidates
        .map((c) => ({ c, d: dist(from, 'fp' in c ? c.fp.center : c.center) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, perCargo)
        .forEach(({ c, d }) =>
          result.push({
            cargo,
            direction,
            pos: 'fp' in c ? c.fp.center : c.center,
            name: 'fp' in c ? c.info.name : c.name,
            ref: 'fp' in c ? { type: 'industry', id: c.id } : { type: 'town', id: c.id },
            distance: d,
          }),
        );
    };
    if ('fp' in target) {
      const product = target.info.produces;
      add(product, 'out', [
        ...this.industries.filter((i) => i.info.accepts.includes(product)),
        ...this.towns.filter((t) => t.demands.includes(product)),
      ]);
      for (const c of target.info.accepts) add(c, 'in', this.industries.filter((i) => i.info.produces === c));
    } else {
      for (const c of target.demands) add(c, 'in', this.industries.filter((i) => i.info.produces === c));
    }
    return result;
  }

  // ---------- Прочее ----------

  structureAt(p: Vec): Structure | null {
    return this.index.at(p, 2);
  }

  private routeCache = new Map<string, Vec[] | null>();
  private routeCacheVersion = -1;

  /**
   * Путь машины между станциями по полосам (с учётом стороны движения) — для отрисовки линий.
   * null — дороги между станциями нет.
   */
  routePolyline(fromId: number, toId: number): Vec[] | null {
    const version = this.net.version * 100003 + this.roads.net.version;
    if (this.routeCacheVersion !== version) {
      this.routeCache.clear();
      this.routeCacheVersion = version;
    }
    const key = `${fromId}>${toId}`;
    if (this.routeCache.has(key)) return this.routeCache.get(key)!;
    const from = this.stations.get(fromId);
    const to = this.stations.get(toId);
    if (from?.kind === 'rail' || to?.kind === 'rail') {
      // Ж/д линия — по осям путей между платформами.
      const rail = from && to && from.kind === to.kind ? this.rail.previewRoute(sidingsFirst(from).slice(0, Math.max(1, from.platforms.length - 1)), to.platforms, throughOf(to)) : null;
      this.routeCache.set(key, rail);
      return rail;
    }
    const route = from && to ? this.roads.route(from.nodeId, to.nodeId) : null;
    const pts = route ? this.roads.routePolyline(route) : null;
    this.routeCache.set(key, pts);
    return pts;
  }

  /** Предприятие под курсором: само здание, его значок, рецепт или подпись (зависят от зума). */
  industryAt(p: Vec, zoom: number): Industry | null {
    for (const ind of this.industries) {
      if (pointInFootprint(p, ind.fp, 4 / zoom)) return ind;
      // Значок-маркер издалека и рецепт с подписью под зданием.
      if (dist(p, ind.fp.center) < 14 / zoom) return ind;
      const below = p.y - ind.fp.center.y;
      if (Math.abs(p.x - ind.fp.center.x) < 70 / zoom && below > 0 && below < footprintRadius(ind.fp) + 44 / zoom) return ind;
    }
    return null;
  }

  /**
   * Станция под курсором для создания линии: сама станция, её подпись,
   * а также значок или подпись предприятия, к которому она относится.
   */
  stationNear(p: Vec, zoom: number): Station | null {
    const direct = this.structureAt(p);
    if (direct?.type === 'station') return direct;
    for (const st of this.stations.values()) {
      const labelY = st.fp.center.y + st.fp.h / 2 + 11 / zoom;
      const nearLabel = Math.abs(p.x - st.fp.center.x) < 60 / zoom && Math.abs(p.y - labelY) < 10 / zoom;
      if (nearLabel || pointInFootprint(p, st.fp, 18 / zoom)) return st;
    }
    const ind = this.industryAt(p, zoom);
    if (!ind) return null;
    // Станция при предприятии, а если её нет — ближайшая, в охват которой оно входит.
    const own = [...this.stations.values()].filter((s) => s.industryId === ind.id);
    const covering = own.length ? own : [...this.stations.values()].filter((s) => s.industryIds.includes(ind.id));
    return covering.sort((a, b) => dist(a.fp.center, p) - dist(b.fp.center, p))[0] ?? null;
  }

  townOf(b: TownBuilding): Town | undefined {
    return this.towns.find((t) => t.id === b.townId);
  }

  townAt(p: Vec): Town | null {
    for (const t of this.towns) if (dist(t.center, p) < t.radius) return t;
    return null;
  }

  vehicleAt(p: Vec): { sim: Vehicle; fleet?: FleetVehicle } | null {
    let best: Vehicle | null = null;
    let bestD = 10;
    for (const v of this.traffic.vehicles.values()) {
      const d = dist(add(v.pos, scale(v.dir, -v.length / 2)), p);
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    }
    if (!best) return null;
    return { sim: best, fleet: this.fleetOf(best) };
  }

  /** Поезд под курсором: по любому вагону. */
  trainAt(p: Vec): Train | null {
    for (const train of this.rail.trains.values()) {
      for (const car of this.rail.cars(train)) {
        if (dist(car.pos, p) < train.carLength / 2 + 2) return train;
      }
    }
    return null;
  }

  fleetSim(v: FleetVehicle): Vehicle | undefined {
    return v.simId !== null ? this.traffic.vehicles.get(v.simId) : undefined;
  }

  /** Где машина на заезде к своему посту автостанции; не заезжает — null. */
  bayEntryPose(v: FleetVehicle): (Pose & { done: boolean }) | null {
    const m = MODELS[v.model];
    const line = v.enter && this.lines.get(v.lineId);
    const st = line && this.stations.get(line.stops[v.stop]);
    if (!v.enter || !st || m.mode !== 'road') return null;
    // Ворота постов — со стороны выезда (у грузового двора предприятия площадка повёрнута наоборот).
    const gate = this.roads.net.nodes.get(st.nodeId);
    const to = bayPose(st.fp, st.bays, Math.min(v.bay ?? 0, st.bays - 1), m.spec.length, gate ? bayFront(st.fp, gate.pos) : 1);
    return entryPose(v.enter, to, m.spec.length);
  }

  /** Машина компании на виду: на дороге — из движения, на заезде — по пути к посту. */
  fleetLook(v: FleetVehicle): VehicleLook | undefined {
    const sim = this.fleetSim(v);
    if (sim) return sim;
    const m = MODELS[v.model];
    const pose = this.bayEntryPose(v);
    if (!pose || m.mode !== 'road') return undefined;
    const color = this.lines.get(v.lineId)?.color ?? m.spec.color;
    return { ...m.spec, color, load: v.cargo ? CARGO[v.cargo].color : undefined, pos: pose.pos, dir: pose.dir };
  }

  /** Машины, что сейчас заезжают на посты автостанций. */
  enteringLooks(): VehicleLook[] {
    const out: VehicleLook[] = [];
    for (const v of this.fleet.values()) {
      const look = v.enter && this.fleetLook(v);
      if (look) out.push(look);
    }
    return out;
  }

  /** Посты автостанции по порядку: цвет линии машины, что там стоит (или заезжает), или null — пусто. */
  stationBays(st: Station): (string | null)[] {
    const out: (string | null)[] = Array.from({ length: st.bays }, () => null);
    const rest: string[] = [];
    for (const id of st.occupied) {
      const v = this.fleet.get(id);
      const color = (v && this.lines.get(v.lineId)?.color) ?? '#e07b39';
      if (v?.bay !== undefined && v.bay < st.bays && !out[v.bay]) out[v.bay] = color;
      else rest.push(color);
    }
    // Без своего поста (старое сохранение, постов убавили) — на первый свободный.
    for (const color of rest) {
      const i = out.indexOf(null);
      if (i >= 0) out[i] = color;
    }
    return out;
  }

  isFleet(sim: Vehicle): boolean {
    return this.owners.get(sim.id)?.type === 'fleet';
  }

  notify(text: string, color?: string): void {
    this.notices.push({ text, color, age: 0 });
  }

  inFootprint(p: Vec, fp: Footprint): boolean {
    return pointInFootprint(p, fp);
  }
}

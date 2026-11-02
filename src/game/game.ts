import {
  CAR_COLORS,
  COST,
  ECONOMY,
  MIN_SEGMENT_LEN,
  MONTH_LENGTH,
  RAIL_STATION,
  SIM_DT,
  START_YEAR,
  STATION,
  TOWN_TRAFFIC,
} from '../config';
import { Cubic, CurveLUT, straightCubic } from '../core/bezier';
import { Rng } from '../core/rng';
import { add, angleDiff, angleOf, cross, dist, dot, scale, sub, Vec } from '../core/vec';
import { Anchor, anchorAt } from '../lanes/edit';
import { Corridor, LaneNet, LaneNetSave, LaneNode, twoWay } from '../lanes/model';
import type { LaneTraffic } from '../lanes/traffic';
import { RailSim, Train } from '../sim/rail';
import type { Vehicle } from '../sim/vehicle';
import { CARGO, CargoType, FREIGHT, INDUSTRY_TYPES, IndustryKind } from '../world/cargo';
import { Industry, Station, StationServes, Structure, Town, TOWN_NEED, TownBuilding } from '../world/entities';
import { Network, NetworkSave } from '../world/network';
import { halfWidth, isRail, isTrunk, RAIL_HALF, RAIL_SPEC, specCost } from '../world/roadTypes';
import { Footprint, footprintCorners, footprintRadius, FootprintIndex, footprintsOverlap, pointInFootprint } from '../world/spatial';
import { DEFAULT_SETTINGS, WorldSettings } from '../world/settings';
import { Terrain } from '../world/terrain';
import {
  anchorFor,
  corridorHalf,
  fillStreet,
  generateWorld,
  halfAtS,
  nearHighway,
  normalTowards,
  placeable,
  recountPopulation,
  WorldContext,
} from '../world/worldgen';
import { corridorCost, RoadBuilder, RoadPlan } from './roadbuild';
import { Roads } from './roads';
import { BuildContext, Builder, RoadRequest } from './build';
import { pieceRequest, TemplateOptions, TemplatePlan } from './interchange';
import {
  DEFAULT_RULE,
  FleetVehicle,
  Line,
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
  fleet: FleetVehicle[];
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
      fleet: [...this.fleet.values()],
      roundabouts: [...this.roundaboutCenters],
      history: this.history,
      rail: this.rail.serialize(),
    };
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
    for (const t of this.towns) for (const b of t.buildings) this.index.add(b);
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
    // Машины в пути не сохраняются: транспорт линий возвращается на свои станции.
    const restored = new Set<number>();
    const trains = save.rail ? this.rail.restore(save.rail) : new Set<number>();
    for (const v of save.fleet) {
      if (!this.lines.has(v.lineId)) continue;
      this.fleet.set(v.id, v);
    }
    this.reattachFleet(restored, trains);
    for (const [id, c] of save.roundabouts) this.roundaboutCenters.set(id, c);
    // В старых сохранениях могли остаться следы снесённых колец.
    this.pruneRoundabouts();
    this.net.rebuild();
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
    return { roads: this.roads.net, terrain: this.terrain, index: this.index, rng: this.rng, nextId: () => this.nextEntityId++ };
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

  obstaclesAt(p: Vec, radius: number): { id: number; demolishable: boolean }[] {
    return this.index
      .near(p, radius + 60)
      .filter((s) => pointInFootprint(p, s.fp, radius))
      .map((s) => ({ id: s.id, demolishable: s.type === 'building' && s.kind !== 'landmark' }));
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
    const corridors: number[] = [];
    for (const c of this.roads.net.corridorsInBox(x0, y0, x1, y1)) {
      const pts = c.lut.points;
      if (pts.filter(inside).length * 2 < pts.length) continue;
      corridors.push(c.id);
      refund += corridorCost(this.roads.net, c, (q, m) => this.isWater(q, m)) * COST.refundRatio;
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
    if (c.corridors.length) this.roadBuilder.apply({ ...this.roadBuilder.bulldoze(c.corridors), ok: true });
    this.commit();
    return true;
  }

  /** Улица, у которой можно поставить дом: не магистраль, не кольцо, на земле. */
  private streetNear(p: Vec, r: number): { seg: Corridor; s: number } | null {
    let best: { seg: Corridor; s: number; d: number } | null = null;
    for (const c of this.roads.net.corridorsNear(p, r)) {
      if (c.ring || isTrunk(c.cls) || this.roads.net.node(c.a).level !== 0 || this.roads.net.node(c.b).level !== 0) continue;
      const hit = c.lut.closest(p);
      if (hit.d < r && (!best || hit.d < best.d)) best = { seg: c, s: hit.s, d: hit.d };
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
    const alive = new Set<number>();
    const roads = this.roads.net;
    for (const n of roads.nodes.values()) {
      if (n.roundabout === null || n.roundabout === undefined) continue;
      if (n.corridors.some((id) => roads.corridors.get(id)?.ring)) alive.add(n.roundabout);
      else n.roundabout = null;
    }
    for (const id of [...this.roundaboutCenters.keys()]) if (!alive.has(id)) this.roundaboutCenters.delete(id);
  }

  /** Сеть дорог или путей изменилась: графы движения заново, машины и поезда — на новые пути. */
  networkChanged(): void {
    this.pruneRoundabouts();
    this.roads.changed();
    this.net.rebuild();
    const splits = [...this.net.pendingSplits];
    this.net.pendingSplits = [];
    this.rail.validate(splits);
  }

  // ---------- Шаблоны развязок ----------

  diamondPlan(_p: Vec, _radius: number): TemplatePlan {
    return { ok: false, reason: 'Шаблоны развязок переезжают на полосы — скоро вернутся', pieces: [], cost: 0, preview: [], withTrunk: false };
  }

  /** Развязка по шаблону: на магистрали под курсором или в чистом поле вместе с магистралью. */
  templatePlan(_p: Vec, _radius: number, _opts: TemplateOptions): TemplatePlan {
    return { ok: false, reason: 'Шаблоны развязок переезжают на полосы — скоро вернутся', pieces: [], cost: 0, preview: [], withTrunk: false };
  }

  /**
   * Строит развязку по кускам. Если какой-то кусок не встал — всё, что успели построить,
   * откатывается (как Ctrl+Z), чтобы не осталось полуразвязки.
   */
  buildTemplate(plan: TemplatePlan, label: string): string | null {
    if (!plan.ok) return plan.reason ?? 'Нельзя построить';
    this.checkpoint(label);
    for (const piece of plan.pieces) {
      const req = pieceRequest(this.builder, piece);
      const check = this.builder.plan(req);
      if (!check.ok || !this.builder.build(req)) {
        this.commit();
        this.undo();
        return check.reason ?? 'Не удалось построить развязку';
      }
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

  /** Меняет главную дорогу, запреты поворотов или режим светофора на перекрёстке. */
  setJunction(nodeId: number, patch: Partial<Pick<LaneNode, 'mainPair' | 'bans' | 'greens' | 'adaptive'>>): void {
    const n = this.roads.net.nodes.get(nodeId);
    if (!n) return;
    Object.assign(n, patch);
    this.roads.net.version++;
    this.networkChanged();
  }

  /** Метки полос перекрёстка для настройки связей на карте. Связи полос на новой модели — позже. */
  laneEnds(_nodeId: number): LaneEnd[] {
    return [];
  }

  /** Соединяет полосу въезда с полосой выезда или разъединяет их (на новой модели — позже). */
  toggleLaneConnection(_nodeId: number, _inSeg: number, _i: number, _outSeg: number, _j: number): string | null {
    return 'Связи полос скоро вернутся';
  }

  /** Возвращает всем полосам перекрёстка автоматические связи. */
  resetLanes(_nodeId: number): void {}

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
    return {
      node: n,
      approaches,
      turns,
      pairs: pairs.map((p) => ({ segs: p, name: `${label(p[0]).name}–${label(p[1]).name}` })),
      mainNow,
      phases: [],
      label,
      customLanes: 0,
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
          if (m.year === this.year) this.notify(`Новая модель: ${m.name} — ${m.capacity} мест. Старый транспорт можно заменить в карточке линии`, '#4a8fe7');
        }
      }
    }
  }

  // ---------- Транспортная компания ----------

  stationLines(stationId: number): Line[] {
    return [...this.lines.values()].filter((l) => l.stops.includes(stationId));
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
    const v = line.vehicles.map((id) => this.fleet.get(id)).find((x) => x);
    if (v) return MODELS[v.model].carries === 'passengers' ? 'bus' : 'truck';
    const sts = line.stops.map((id) => this.stations.get(id)).filter((s): s is Station => !!s);
    if (sts.every((s) => !s.serves.pax)) return 'truck';
    if (sts.every((s) => !s.serves.cargo)) return 'bus';
    // Одна станция маршрута производит груз, который принимает другая, — грузовая линия.
    const freight = sts.some((s) => this.stationIndustries(s).some((ind) => sts.some((o) => o !== s && o.accepts.has(ind.info.produces))));
    return freight ? 'truck' : 'bus';
  }

  /** Почему из этих станций нельзя собрать линию; null — можно. */
  lineProblem(stops: number[]): string | null {
    const kinds = new Set(stops.map((id) => this.stations.get(id)?.kind).filter((k) => k));
    if (kinds.size > 1) return 'В одной линии — либо автостанции, либо ж/д станции';
    return null;
  }

  createLine(stops: number[]): Line | null {
    const clean = stops.filter((id, i) => this.stations.has(id) && id !== stops[i - 1]);
    if (clean.length > 1 && clean[0] === clean[clean.length - 1]) clean.pop();
    if (clean.length < 2 || this.lineProblem(clean)) return null;
    this.forgetUndo();
    const n = this.lines.size ? Math.max(...this.lines.keys()) + 1 : 1;
    // Цвет — первый, которого ещё нет у других линий.
    const used = new Set([...this.lines.values()].map((l) => l.color));
    const color = LINE_COLORS.find((c) => !used.has(c)) ?? LINE_COLORS[(n - 1) % LINE_COLORS.length];
    const line: Line = {
      id: n,
      name: this.defaultLineName(clean),
      color,
      mode: this.stations.get(clean[0])!.kind,
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
    if (!line) return 'Нет линии';
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
    if (this.stations.get(clean[0])!.kind !== this.lineMode(line)) return 'Поезда и машины не смешиваются в одной линии';
    this.forgetUndo();
    const before = line.stops;
    line.stops = clean;
    line.rules = cleanRules;
    line.problem = null;
    for (const vid of line.vehicles) {
      const v = this.fleet.get(vid);
      if (!v) continue;
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
  }

  addLineStop(id: number, stationId: number): string | null {
    const line = this.lines.get(id);
    if (!line) return 'Нет линии';
    return this.setLineRoute(id, [...line.stops, stationId], [...(line.rules ?? line.stops.map(() => null)), null]);
  }

  removeLineStop(id: number, index: number): string | null {
    const line = this.lines.get(id);
    if (!line) return 'Нет линии';
    const rules = line.rules ?? line.stops.map(() => null);
    return this.setLineRoute(
      id,
      line.stops.filter((_, i) => i !== index),
      rules.filter((_, i) => i !== index),
    );
  }

  moveLineStop(id: number, index: number, delta: number): string | null {
    const line = this.lines.get(id);
    if (!line) return 'Нет линии';
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
  }

  buyVehicle(lineId: number, model: ModelId): FleetVehicle | null {
    const line = this.lines.get(lineId);
    const m = MODELS[model];
    if (!line || m.price > this.budget || m.mode !== this.lineMode(line) || m.year > this.year) return null;
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

  private leaveBay(v: FleetVehicle): void {
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

  /** Загрузка при отправлении — для подсказки «машин больше, чем груза». */
  private recordDeparture(line: Line, v: FleetVehicle): void {
    line.loadSumMonth = (line.loadSumMonth ?? 0) + vehicleLoad(v) / vehicleCapacity(v);
    line.departuresMonth = (line.departuresMonth ?? 0) + 1;
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
    st.occupied.push(v.id);
    v.inBay = true;
    v.state = 'loading';
    this.handleStop(v, st, line);
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
    if (!line.vehicles.length) return out;
    line.stops.forEach((sid, i) => {
      const st = this.stations.get(sid);
      if (!st) return;
      let waiting = 0;
      const others = new Set(line.stops.filter((x) => x !== sid));
      for (const [dest, n] of st.passengers) if (others.has(dest)) waiting += n;
      for (const c of this.loadable(line, i)) waiting += Math.floor(st.cargo[c] ?? 0);
      if (waiting >= 150) out.push(`${st.name}: ждут отправки ${waiting} — не хватает транспорта, купите ещё`);
    });
    const load = line.loadLast;
    if (load !== undefined && load !== null && load < 0.35 && line.vehicles.length >= 2) {
      out.push(`Рейсы уходят загруженными на ${Math.round(load * 100)}% — транспорта больше, чем груза. Продайте лишний или поставьте «Полная загрузка» на станции погрузки`);
    }
    const profit = line.revenueLast - line.costLast;
    if (profit < 0 && line.costLast > 0 && !out.length) {
      out.push('Линия в минусе: возите дальше (платят за расстояние), загружайте рейсы полностью или уберите лишний транспорт');
    }
    return out;
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

  private growTown(town: Town): void {
    town.lastSupplied = { ...town.supplied };
    town.supplied = {};
    const satisfaction = this.townSatisfaction(town);
    town.growthAcc += town.population * (0.003 + 0.025 * satisfaction);
    const ctx = this.worldContext();
    // Город растёт вдоль любых своих улиц, включая построенные игроком.
    // Кроме магистралей, съездов и дорог развязок — к ним город не пристраивается.
    const streets = this.roads.net.corridorsNear(town.center, town.radius + 60).filter((s) => this.streetLike(s));
    let guard = 0;
    while (town.growthAcc >= 20 && streets.length && guard++ < 8) {
      if (fillStreet(ctx, town, this.rng.pick(streets), 1, 1) > 0) town.growthAcc -= 20;
    }
    // Мест вдоль улиц не хватает — город сам прокладывает новую улицу и застраивает её (если игрок не запретил).
    if (town.growthAcc >= 40 && town.autoStreets !== false) {
      const seg = this.growStreet(town);
      if (seg) {
        const added = fillStreet(ctx, town, seg, 0.8, Math.floor(town.growthAcc / 20));
        town.growthAcc = Math.max(0, town.growthAcc - added * 20);
      }
    }
    const before = town.population;
    recountPopulation(town);
    if (town.population > before && satisfaction >= 1) this.notify(`${town.name} растёт: ${town.population} жителей`);
  }

  /**
   * Город прокладывает новую улицу: продлевает тупик наружу или отводит переулок от улицы
   * на окраине. Без сноса, без мостов и без пересечений с чужими дорогами; бесплатно для игрока.
   * Конец новой улицы цепляется к соседней дороге, если она рядом, — так появляются кварталы.
   */
  /** Городская улица: на земле, не кольцо и не часть магистрали или развязки. */
  private streetLike(c: Corridor): boolean {
    const net = this.roads.net;
    return !c.ring && net.node(c.a).level === 0 && net.node(c.b).level === 0 && !nearHighway(net, c);
  }

  private growStreet(town: Town): Corridor | null {
    const net = this.roads.net;
    const rng = this.rng;
    const candidates: { start: Anchor; dir: Vec }[] = [];
    // Тупики городских улиц — продолжаем их наружу (дорога сама выйдет по касательной).
    for (const n of net.nodesNear(town.center, town.radius + 150)) {
      if (!net.isDeadEnd(n) || n.level !== 0 || n.corridors.length !== 1) continue;
      const e = net.ends(n)[0];
      if (!this.streetLike(e.corridor)) continue;
      candidates.push({ start: { kind: 'node', node: n.id, pos: n.pos }, dir: scale(e.away, -1) });
    }
    // Переулки от улиц у края города — перпендикулярно, от центра.
    const edge = net
      .corridorsNear(town.center, town.radius + 60)
      .filter((s) => this.streetLike(s) && s.length > 140 && dist(s.lut.pointAt(s.length / 2), town.center) > town.radius * 0.5);
    for (let i = 0; i < 6 && edge.length; i++) {
      const s = rng.pick(edge);
      const at = rng.range(60, s.length - 60);
      const p = s.lut.pointAt(at);
      const t = s.lut.tangentAt(at);
      let n = { x: -t.y, y: t.x };
      if (dot(n, sub(p, town.center)) < 0) n = scale(n, -1);
      candidates.push({ start: { kind: 'corridor', corridor: s.id, s: at, pos: p }, dir: n });
    }
    // Перебираем в случайном порядке; у «старого города» улицы чуть изгибаются.
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = rng.int(0, i + 1);
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    const bend = town.style === 'organic' ? 0.35 : 0.08;
    for (const c of candidates.slice(0, 10)) {
      const a = Math.atan2(c.dir.y, c.dir.x) + rng.range(-bend, bend);
      const len = rng.range(110, 170);
      const target = add(c.start.pos, { x: Math.cos(a) * len, y: Math.sin(a) * len });
      if (!this.inBounds(target, 80)) continue;
      // Рядом другая улица — подключаемся к ней, получится квартал.
      const end = anchorAt(net, target, 28);
      if (end.kind === 'corridor' && !this.streetLike(net.corridor(end.corridor))) continue;
      if (end.kind === 'node' && net.node(end.node).corridors.some((id) => !this.streetLike(net.corridor(id)))) continue;
      const plan = this.roadBuilder.road(c.start, end, { cls: 'street', lanes: twoWay(1, 1) }, { free: true });
      if (!plan.ok || plan.demolish.length || !plan.net) continue;
      // Без пересечений с другими дорогами: новых узлов — только концы новой улицы.
      const fresh = [...plan.net.nodes.keys()].filter((id) => !net.nodes.has(id)).length;
      if (fresh > (c.start.kind === 'corridor' ? 1 : 0) + (end.kind === 'node' ? 0 : 1)) continue;
      const added = plan.changed.map((id) => plan.net!.corridor(id)).filter((x) => !net.corridors.has(x.id));
      // История Ctrl+Z не сбрасывается: отмена уберёт и эту улицу, и дома вдоль неё.
      this.roadBuilder.apply(plan);
      town.radius = Math.max(town.radius, dist(target, town.center) + 40);
      return added.sort((x, y) => y.length - x.length)[0] ?? null;
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
      (s) => isRail(s.spec) && s.platform === undefined && !s.ring && this.net.isFlat(s) && this.net.node(s.a).level === 0,
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
      if (!mp.ok) return fail(mp.reason ?? 'Нельзя построить путь');
      if (mp.crossings.length || mp.demolish.length) return fail('Мешает дорога или здание');
      mainCost = mp.cost;
      const lut = new CurveLUT(straightCubic(a, b));
      seg = { id: -1, lut, length: lut.length };
      sc = total / 2;
    }
    const t = seg.lut.tangentAt(sc);
    const center = seg.lut.pointAt(sc);
    const cuts: [number, number, number, number] = [sc - half, sc - R.platform / 2, sc + R.platform / 2, sc + half];
    for (const s of cuts) {
      if (dot(seg.lut.tangentAt(s), t) < Math.cos(0.06)) return fail('Ж/д станция — только на прямом участке пути');
    }
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
    if (!this.inBounds(fp.center, 30) || samples.some((q) => !this.inBounds(q, 20))) return fail('За краем карты', fp, cost);
    if (this.isWater(fp.center, footprintRadius(fp) * 0.6) || samples.some((q) => this.isWater(q, RAIL_HALF))) return fail('Мешает вода', fp, cost);
    if (this.index.overlaps(fp, 3) || samples.some((q) => this.blocked(q, RAIL_HALF + 2))) return fail('Мешает здание', fp, cost);
    // Другие дороги и пути не должны задевать второй путь и здание.
    const u = { x: Math.cos(fp.angle), y: Math.sin(fp.angle) };
    const v = { x: -u.y, y: u.x };
    const probes = [...samples];
    for (let i = -2; i <= 2; i++) for (let k = -1; k <= 1; k++) probes.push(add(fp.center, add(scale(u, (i * fp.w) / 4), scale(v, (k * fp.h) / 2))));
    for (const q of probes) {
      for (const s of this.net.segmentsNear(q, 40)) {
        if (s.id === seg.id) continue;
        if (s.lut.closest(q).d < halfWidth(s.spec) + RAIL_HALF + 2) return fail(isRail(s.spec) ? 'Мешает другой путь' : 'Мешает дорога', fp, cost);
      }
      for (const c of this.roads.net.corridorsNear(q, 60)) {
        const hit = c.lut.closest(q);
        if (hit.d < halfAtS(c, hit.s) + RAIL_HALF + 2) return fail('Мешает дорога', fp, cost);
      }
    }
    if (cost > this.budget) return fail('Не хватает денег', fp, cost);
    return { ok: true, cost, fp, rail: { segId: seg.id, cuts, tracks: extra, main } };
  }

  /** angle — поворот ж/д станции в чистом поле, tracks — сколько у неё путей с платформами (2–4). */
  stationPlan(p: Vec, snapRadius: number, kind: StationKind = 'road', angle = 0, tracks = 2): StationPlan {
    if (kind === 'rail') return this.railStationPlan(p, snapRadius, angle, Math.max(2, Math.min(4, tracks)));
    const fail = (reason: string): StationPlan => ({ ok: false, reason, cost: COST.station, fp: null });
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
      return fail('Слишком близко к перекрёстку');
    }
    // Рядом с дорогой магнит небольшой (иначе в городе всё липло бы к перекрёсткам), в стороне от дорог — побольше.
    const magnet = hit ? Math.max(30, Math.min(50, snapRadius * 2)) : 80;
    const junction = this.roads.net
      .nodesNear(p, magnet)
      .filter((n) => this.stationJoinable(n))
      .sort((x, y) => dist(x.pos, p) - dist(y.pos, p))[0];
    if (junction) return this.junctionStationPlan(junction, p);
    if (!hit) return fail('Поставьте рядом с дорогой');
    const seg = hit.seg;
    const from: Anchor = { kind: 'corridor', corridor: seg.id, s: hit.s, pos: seg.lut.pointAt(hit.s) };
    return this.drivewayStationPlan(from, normalTowards(seg, hit.s, p), halfAtS(seg, hit.s));
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
    return first ?? { ok: false, reason: 'У перекрёстка нет места для выезда', cost: COST.station, fp: null };
  }

  /**
   * Автостанция в конце выезда: выезд идёт от from по dir (clearance — отступ от оси дороги),
   * станция стоит к нему длинной стороной. Дома под станцией сносятся за доплату.
   */
  private drivewayStationPlan(from: Anchor, dir: Vec, clearance: number): StationPlan {
    const reach = clearance + STATION.driveway;
    const nodePos = add(from.pos, scale(dir, reach));
    const center = add(from.pos, scale(dir, reach + STATION.size.h / 2 + 4));
    // Посты погрузки смотрят на выезд.
    const fp: Footprint = { center, w: STATION.size.w, h: STATION.size.h, angle: Math.atan2(dir.x, -dir.y) };
    const plan = this.roadBuilder.road(from, { kind: 'free', pos: nodePos }, DRIVEWAY);
    const fail = (reason: string, cost = plan.cost + COST.station): StationPlan => ({ ok: false, reason, cost, fp, driveway: plan, from });
    if (!this.inBounds(center, 30)) return fail('За краем карты');
    if (this.isWater(center, footprintRadius(fp)) || this.isWater(nodePos, 8)) return fail('Мешает вода');
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
      // Узел станции — тупик выезда.
      const node = this.roads.net.nodesNear(plan.nodePos, 2)[0];
      if (!node) return null;
      nodeId = node.id;
      this.spend(COST.station);
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
      serves: { ...serves },
      industryId: ind?.id ?? null,
      cargo: {},
      passengers: new Map(),
      occupied: [],
      bays: plan.rail ? platforms.length : STATION.bays,
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
      this.notify('Станцию используют линии — сначала удалите их');
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
    return st.kind === 'rail' ? RAIL_STATION.catchment : STATION.catchment;
  }

  computeCatchment(st: Station): void {
    const R = this.catchmentRadius(st);
    st.industryIds = this.industries
      .filter((i) => dist(i.fp.center, st.fp.center) < R + footprintRadius(i.fp) * 0.6)
      .map((i) => i.id);
    const towns = new Set<number>();
    let pop = 0;
    for (const town of this.towns) {
      if (dist(town.center, st.fp.center) > town.radius + R + 50) continue;
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
